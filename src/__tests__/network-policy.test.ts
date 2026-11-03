import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPublicUrl, assertSecureUrl, fetchWithPolicy, isInternalAddress,
} from "../security/network.js";
import { ResilientHttpClient } from "../conway/http-client.js";

const publicLookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("outbound network policy", () => {
  it.each([
    "127.0.0.1", "169.254.169.254", "10.20.30.40", "100.64.0.1", "192.168.1.1",
    "[::1]", "::", "[::ffff:127.0.0.1]", "::ffff:7f00:1", "[fe80::1]", "fd00::1",
    "2001:db8::1", "2001:2::1", "2001:20::1", "3fff::1", "224.0.0.1", "localhost.", "host.localhost", "host.internal",
  ])("blocks reserved destination %s", (host) => expect(isInternalAddress(host)).toBe(true));

  it.each(["93.184.216.34", "2606:4700:4700::1111", "::ffff:5db8:d822", "example.com"])(
    "recognizes public destination %s", (host) => expect(isInternalAddress(host)).toBe(false),
  );

  it("rejects private DNS results and mixed public/private answers before fetch", async () => {
    const spy = vi.fn(); vi.stubGlobal("fetch", spy);
    await expect(fetchWithPolicy("https://public.example/card", {}, {
      publicOnly: true, lookup: async () => [
        { address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 },
      ],
    })).rejects.toThrow("DNS destination blocked");
    expect(spy).not.toHaveBeenCalled();
  });

  it("resolves public hostnames and permits a public response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true })));
    const response = await fetchWithPolicy("https://public.example/card", {}, {
      publicOnly: true, lookup: publicLookup,
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(publicLookup).toHaveBeenCalledWith("public.example");
  });

  it("checks each redirect and blocks a private target before requesting it", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302, headers: { location: "https://[::1]/secret" },
    }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchWithPolicy("https://public.example/card", {}, {
      publicOnly: true, lookup: publicLookup,
    })).rejects.toThrow("network destination blocked");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].redirect).toBe("manual");
  });

  it("follows public redirects without forwarding caller custom headers", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://other.example/card" } }))
      .mockResolvedValueOnce(Response.json({ name: "public" }));
    vi.stubGlobal("fetch", fetch);
    await fetchWithPolicy("https://public.example/card", { headers: { "x-internal-context": "private" } }, {
      publicOnly: true, lookup: publicLookup,
    });
    expect(new Headers(fetch.mock.calls[1][1].headers).has("x-internal-context")).toBe(false);
  });

  it.each(["Authorization", "Cookie", "X-API-Key", "X-Payment"])(
    "never forwards %s to another origin", async (header) => {
      const fetch = vi.fn().mockResolvedValue(new Response(null, {
        status: 302, headers: { location: "https://other.example/card" },
      }));
      vi.stubGlobal("fetch", fetch);
      await expect(fetchWithPolicy("https://public.example/card", { headers: { [header]: "FAKE" } }, {
        publicOnly: true, lookup: publicLookup,
      })).rejects.toThrow(/redirect/);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects even same-origin redirects for paid requests", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 307, headers: { location: "/pay-again" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchWithPolicy("https://public.example/pay", { headers: { "X-Payment": "FAKE" } }, {
      redirectPolicy: "none",
    })).rejects.toThrow("Signed request redirects");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds chunked/decompressed bodies without relying on Content-Length", async () => {
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); controller.close();
    } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
    await expect(fetchWithPolicy("https://public.example", {}, { maxResponseBytes: 10 })).rejects.toThrow("byte limit");
  });

  it("aborts a body that stalls after response headers", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
    const pending = fetchWithPolicy("https://public.example", {}, { timeoutMs: 20 });
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    expect(cancel).toHaveBeenCalled();
  });

  it("bounds CPU and overhead from endless zero-byte chunks", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(0)); }, cancel,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
    await expect(fetchWithPolicy("https://public.example", {}, { maxResponseBytes: 100 })).rejects.toThrow("chunk limit");
    expect(cancel).toHaveBeenCalled();
  });

  it("keeps configured Ollama loopback available only with explicit HTTP permission", async () => {
    expect(() => assertSecureUrl("http://[::1]:11434")).toThrow("HTTPS required");
    expect(assertSecureUrl("http://[::1]:11434", true).hostname).toBe("[::1]");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ models: [] })));
    const client = new ResilientHttpClient({ allowHttpOnLoopback: true, maxRetries: 0 });
    expect(await (await client.request("http://localhost:11434/api/tags")).json()).toEqual({ models: [] });
  });

  it("rejects credentials embedded in URL", async () => {
    await expect(assertPublicUrl("https://user:password@public.example", publicLookup)).rejects.toThrow("URL credentials");
  });

  it("preserves Headers authentication and idempotency without mutating caller headers", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const headers = new Headers({ Authorization: "FAKE" });
    const client = new ResilientHttpClient({ maxRetries: 0 });
    await client.request("https://backend.example", { headers, idempotencyKey: "request-1" });
    const sent = new Headers(fetch.mock.calls[0][1].headers);
    expect(sent.get("authorization")).toBe("FAKE");
    expect(sent.get("idempotency-key")).toBe("request-1");
    expect(headers.has("idempotency-key")).toBe(false);
  });
});
