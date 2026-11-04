import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { redactText, registerSecret } from "../security/redaction.js";
import { GuardianDenied } from "./types.js";
import { identifier } from "./store.js";
import type { WalletGuardian } from "./service.js";

/** Bind only to loopback; an operator-managed HTTPS reverse proxy fronts this on the trusted host. */
export function createGuardianServer(guardian: WalletGuardian, bearerToken: string): http.Server {
  if (bearerToken.length < 32) throw new Error("Strong guardian bearer token required");
  registerSecret(bearerToken);
  const expected = createHash("sha256").update("Bearer " + bearerToken).digest();
  let active = 0, windowStart = Date.now(), requests = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
    const reply = (code: number, value: unknown) => { res.statusCode = code; res.end(JSON.stringify(value)); };
    const supplied = createHash("sha256").update(req.headers.authorization ?? "").digest();
    if (!timingSafeEqual(expected, supplied)) { reply(401, { error: "Unauthorized" }); return; }
    if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); requests = 0; }
    if (++requests > 120 || active > 0) { reply(429, { error: "Guardian busy; inspect operation status before retrying" }); return; }
    active++;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/v1/status") {
        reply(200, { walletAddress: guardian.config.walletAddress, ownerAddress: guardian.config.ownerAddress,
          dailyCurrency: guardian.config.dailyCurrency, dailyPaymentCents: guardian.config.dailyPaymentCents,
          maxSinglePaymentCents: guardian.config.maxSinglePaymentCents, serviceNetwork: "eip155:8453",
          message: "Policy wallet; profitability is not guaranteed; no generic signing endpoint" }); return;
      }
      if (req.method === "GET" && url.pathname === "/v1/goals") { reply(200, guardian.store.goals()); return; }
      if (req.method === "GET" && url.pathname === "/v1/events") { reply(200, guardian.store.events(Number(url.searchParams.get("after") ?? 0))); return; }
      if (req.method === "GET" && /^\/v1\/intents\/[^/]+$/.test(url.pathname)) {
        const id = identifier(decodeURIComponent(url.pathname.split("/").at(-1)!));
        try { await guardian.reconcileWithdrawal(id); } catch { /* Pending/unknown receipts do not trigger retries or release an approval. */ }
        const row = guardian.store.get(id);
        reply(row ? 200 : 404, row ? { operationId: row.id, kind: row.kind, state: row.state, requestHash: row.hash, transactionHash: row.tx_hash, trace: guardian.store.trace(id) } : { error: "Unknown operation" }); return;
      }
      // No endpoint for approving goals/withdrawals, changing policy, exporting
      // keys, signing arbitrary data, executing commands or supplying calldata.
      if (req.method !== "POST" || !["/v1/pay", "/v1/withdrawals", "/v1/withdrawals/execute"].includes(url.pathname)) { reply(404, { error: "Unsupported operation" }); return; }
      if (!req.headers["content-type"]?.startsWith("application/json")) { reply(415, { error: "JSON required" }); return; }
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 128 * 1024 || chunks.length > 4096) throw new Error("Request exceeds size limit");
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Object request required");
      if (url.pathname === "/v1/pay") reply(200, await guardian.service(body));
      else if (url.pathname === "/v1/withdrawals") reply(200, guardian.requestWithdrawal(body));
      else reply(200, await guardian.executeWithdrawal(body.operationId));
    } catch (error) {
      reply(error instanceof GuardianDenied ? 403 : 400, { error: redactText(error instanceof Error ? error.message : "Guardian failure"), code: error instanceof GuardianDenied ? error.code : "GUARDIAN_ERROR" });
    } finally { active--; }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  return server;
}
