import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AutomatonConfig } from "../types.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import { isAddress } from "viem";
import { redactValue, registerSecret } from "../security/redaction.js";
import type { ServiceRequest, WithdrawalRequest } from "./types.js";
import type { X402PaymentResult } from "../conway/x402.js";

export function validateGuardianConnection(config: NonNullable<AutomatonConfig["walletGuardian"]>): void {
  const url = new URL(config.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Guardian requires an explicit HTTPS origin without credentials or path");
  if (!path.isAbsolute(config.tokenFile)) throw new Error("Guardian client token requires an absolute private file path");
  if (![config.ownerAddress, config.walletAddress].every(a => isAddress(a, { strict: false }) && !/^0x0{40}$/i.test(a))) throw new Error("Expected guardian funding and owner wallet addresses must be pinned");
}

/** This token authorizes proposals inside remote policy; it cannot approve goals or export keys. */
export class GuardianClient {
  private readonly http = new ResilientHttpClient();
  private readonly token: string;
  constructor(private readonly connection: NonNullable<AutomatonConfig["walletGuardian"]>) {
    validateGuardianConnection(connection);
    const stat = fs.lstatSync(connection.tokenFile);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error("Guardian client token must be a regular mode-0600 file");
    this.token = fs.readFileSync(connection.tokenFile, "utf8").trim();
    if (this.token.length < 32) throw new Error("Guardian client token too short");
    registerSecret(this.token);
  }
  private async request(route: string, body?: unknown): Promise<any> {
    const res = await this.http.request(this.connection.baseUrl.replace(/\/$/, "") + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout: body === undefined ? 10_000 : 90_000, retries: 0, redirectPolicy: "none", networkPolicy: "configured",
    });
    // A proxy error page (502/504) or an empty body must not surface as a JSON parse error.
    const raw = await res.text();
    let data: any;
    try { data = raw ? JSON.parse(raw) : undefined; } catch { data = undefined; }
    if (!res.ok) throw new Error(data && typeof data === "object"
      ? `Guardian ${res.status}: ${String(data.code ?? "")}: ${String(data.error ?? "request refused")}`
      : `Guardian ${res.status}: UNAVAILABLE: guardian unreachable or returned a non-JSON response; no local signing fallback, work without payment may continue`);
    if (data === undefined) throw new Error(`Guardian ${res.status}: non-JSON response refused`);
    return data;
  }
  async status(): Promise<any> {
    const status = await this.request("/v1/status");
    if (String(status.walletAddress).toLowerCase() !== this.connection.walletAddress.toLowerCase() ||
        String(status.ownerAddress).toLowerCase() !== this.connection.ownerAddress.toLowerCase()) throw new Error("Guardian wallet/owner identity mismatch; refusing requests");
    return status;
  }
  async service(request: ServiceRequest): Promise<X402PaymentResult & { replayed?: boolean }> { await this.status(); return this.request("/v1/pay", request); }
  async withdrawal(request: WithdrawalRequest): Promise<any> { await this.status(); return this.request("/v1/withdrawals", request); }
  async executeWithdrawal(operationId: string): Promise<any> { await this.status(); return this.request("/v1/withdrawals/execute", { operationId }); }
  async intent(id: string): Promise<any> { return this.request("/v1/intents/" + encodeURIComponent(id)); }
  async goals(): Promise<any> { return this.request("/v1/goals"); }
  async events(after: number): Promise<any> { return this.request("/v1/events?after=" + after); }
}

export function guardianFor(config: AutomatonConfig): GuardianClient {
  if (!config.walletGuardian) throw new Error("Remote guardian not configured; no local signing fallback");
  return new GuardianClient(config.walletGuardian);
}

/** Durable local notifications. No private keys, bearer values, headers or hidden reasoning. */
const journalSyncs = new Map<string, Promise<number>>();
export function syncGuardianJournal(config: AutomatonConfig): Promise<number> {
  const key = path.resolve(config.dbPath);
  const active = journalSyncs.get(key);
  if (active) return active;
  const pending = writeGuardianJournal(config).finally(() => { journalSyncs.delete(key); });
  journalSyncs.set(key, pending);
  return pending;
}
async function writeGuardianJournal(config: AutomatonConfig): Promise<number> {
  if (!config.walletGuardian) return 0;
  const dbPath = config.dbPath.startsWith("~") ? path.join(process.env.HOME || "/root", config.dbPath.slice(1)) : path.resolve(config.dbPath);
  const directory = path.dirname(dbPath);
  const cursorFile = path.join(directory, "wallet-guardian-cursor.json");
  const journal = path.join(directory, "wallet-guardian-notifications.jsonl");
  const guardianId = config.walletGuardian.baseUrl + ":" + config.walletGuardian.walletAddress.toLowerCase();
  let cursor = 0;
  if (fs.existsSync(cursorFile)) {
    if (!fs.lstatSync(cursorFile).isFile()) throw new Error("Guardian notification cursor must be a regular file");
    const saved = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
    cursor = saved.guardianId === guardianId ? saved.sequence : 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid guardian cursor");
  }
  const events = await guardianFor(config).events(cursor);
  if (!Array.isArray(events) || events.length > 100 || events.some((e, i) => !Number.isSafeInteger(e.seq) || e.seq <= (i ? events[i - 1].seq : cursor))) throw new Error("Invalid guardian notification stream");
  if (!events.length) return 0;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Keep the full authoritative audit on the guardian, bounded rotating copies on the VPS.
  if (fs.existsSync(journal)) {
    if (!fs.lstatSync(journal).isFile()) throw new Error("Guardian journal must be a regular file");
    if (fs.statSync(journal).size > 10 * 1024 * 1024) {
      for (let i = 3; i >= 1; i--) if (fs.existsSync(journal + "." + i)) fs.renameSync(journal + "." + i, journal + "." + (i + 1));
      fs.renameSync(journal, journal + ".1");
    }
  }
  const fd = fs.openSync(journal, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    for (const event of events) fs.writeSync(fd, JSON.stringify(redactValue({ ...event, guardianId })) + "\n");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const directoryFd = fs.openSync(directory, "r");
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  // Crash before cursor update may duplicate notifications, never lose an event.
  const temporary = cursorFile + ".tmp-" + randomUUID();
  try {
    const cursorFd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(cursorFd, JSON.stringify({ guardianId, sequence: events.at(-1).seq })); fs.fsyncSync(cursorFd); }
    finally { fs.closeSync(cursorFd); }
    fs.renameSync(temporary, cursorFile);
    const directoryFd = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return events.length;
}
