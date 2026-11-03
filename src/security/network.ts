/**
 * Outbound URL policy. Configured backends may deliberately be private (Ollama,
 * for example); URLs supplied by remote content must use publicOnly.
 *
 * DNS is checked before every request/redirect. fetch still uses the configured
 * system/proxy transport: this is NOT connection-address pinning. Deployments
 * must also deny private destinations at their egress boundary to defeat DNS
 * rebinding, especially when a proxy performs its own DNS resolution.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AddressLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function ipv6Words(address: string): number[] | null {
  let raw = address;
  if (raw.includes(".")) {
    const split = raw.lastIndexOf(":");
    const octets = raw.slice(split + 1).split(".").map(Number);
    if (octets.length !== 4) return null;
    raw = `${raw.slice(0, split)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = raw.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const parts = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return parts.length === 8 ? parts.map((word) => parseInt(word, 16)) : null;
}

/** True for local names and any IP address that is not globally routable. */
export function isInternalAddress(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === "localhost" || /\.(localhost|local|internal|home)$/.test(host)) return true;
  const family = isIP(host);
  if (family === 4) {
    const [a, b, c] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    const words = ipv6Words(host);
    if (!words) return true;
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      return isInternalAddress(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    }
    // Only global-unicast 2000::/3, excluding documentation and transition ranges.
    return (words[0] & 0xe000) !== 0x2000 || words[0] === 0x2002 ||
      (words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0db8)) ||
      (words[0] === 0x3fff && (words[1] & 0xf000) === 0);
  }
  return false; // DNS names are checked asynchronously by assertPublicUrl.
}

export function assertSecureUrl(value: string, allowHttpOnLoopback = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid URL"); }
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  const host = normalizeHost(url.hostname);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && allowHttpOnLoopback &&
    ["localhost", "127.0.0.1", "::1"].includes(host)) return url;
  throw new Error("HTTPS required; loopback HTTP must be explicitly enabled");
}

export async function assertPublicUrl(
  value: string,
  lookup: AddressLookup = (host) => dnsLookup(host, { all: true, verbatim: true }),
): Promise<URL> {
  const url = assertSecureUrl(value);
  const host = normalizeHost(url.hostname);
  if (isInternalAddress(host)) throw new NetworkPolicyError("Private or reserved network destination blocked");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
  if (!addresses.length || addresses.some(({ address }) => !isIP(address) || isInternalAddress(address))) {
    throw new NetworkPolicyError("Private or reserved DNS destination blocked");
  }
  return url;
}

export interface NetworkFetchPolicy {
  publicOnly?: boolean;
  allowHttpOnLoopback?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  /** none is appropriate for signed payment requests. */
  redirectPolicy?: "none" | "same-origin" | "public";
  lookup?: AddressLookup;
}

export class NetworkPolicyError extends Error {}

function headerNames(headers: Headers): string[] {
  const names: string[] = [];
  headers.forEach((_value, name) => names.push(name));
  return names;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Reads under a byte limit, including chunked/decompressed response bodies. */
async function boundedResponse(response: Response, limit: number, signal: AbortSignal): Promise<Response> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new NetworkPolicyError("Response exceeds byte limit");
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      // Zero-byte/tiny chunks must not create unbounded CPU or array overhead.
      if (chunks.length >= 65_536) throw new NetworkPolicyError("Response exceeds chunk limit");
      if (size > limit) throw new NetworkPolicyError("Response exceeds byte limit");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const bounded = new Response(bytes, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
  Object.defineProperty(bounded, "url", { value: response.url });
  return bounded;
}

/** HTTPS, manual redirects, cancellation and bounded bodies, preserving proxy use. */
export async function fetchWithPolicy(
  value: string,
  init: RequestInit = {},
  policy: NetworkFetchPolicy = {},
): Promise<Response> {
  const timeout = policy.timeoutMs ?? 30_000;
  const limit = policy.maxResponseBytes ?? 8 * 1024 * 1024;
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new NetworkPolicyError("Invalid request limits");
  }
  let current = assertSecureUrl(value, policy.allowHttpOnLoopback);
  const headers = new Headers(init.headers);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (init.signal?.aborted) forwardAbort();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeout);
  const hasCredentialHeaders = headerNames(headers).some((name) =>
    /authorization|cookie|payment|signature|api[-_]?key|token/i.test(name));
  const redirects = policy.redirectPolicy ?? (policy.publicOnly ? "public" : "same-origin");
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  try {
    for (let step = 0; step <= (policy.maxRedirects ?? 5); step++) {
      if (policy.publicOnly) await abortable(assertPublicUrl(current.href, policy.lookup), controller.signal);
      const response = await abortable(fetch(current.href, {
        ...init, method, body, headers, redirect: "manual", signal: controller.signal,
      }), controller.signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return await boundedResponse(response, limit, controller.signal);
      }
      const location = response.headers.get("location");
      void response.body?.cancel().catch(() => {});
      if (!location) throw new NetworkPolicyError("Redirect missing Location");
      if (redirects === "none" || hasCredentialHeaders && /payment|signature/i.test(headerNames(headers).join(" "))) {
        throw new NetworkPolicyError("Signed request redirects are not allowed");
      }
      const next = assertSecureUrl(new URL(location, current).href, policy.allowHttpOnLoopback);
      if (current.origin !== next.origin) {
        if (redirects !== "public" || hasCredentialHeaders || !["GET", "HEAD"].includes(method)) {
          throw new NetworkPolicyError("Cross-origin redirect blocked");
        }
        // Public redirects never inherit caller-supplied custom headers.
        for (const name of headerNames(headers)) {
          if (!["accept", "accept-language", "user-agent"].includes(name)) headers.delete(name);
        }
      }
      if (response.status === 303 || [301, 302].includes(response.status) && method === "POST") {
        method = "GET"; body = undefined;
        headers.delete("content-type"); headers.delete("content-length");
      }
      current = next;
    }
    throw new NetworkPolicyError("Too many redirects");
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", forwardAbort);
  }
}
