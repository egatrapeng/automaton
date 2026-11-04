import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { keccak256, type PrivateKeyAccount } from "viem";
import { GuardianStore, digest } from "../wallet-guardian/store.js";
import { WalletGuardian } from "../wallet-guardian/service.js";
import { createGuardianServer } from "../wallet-guardian/server.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import { x402Fetch } from "../conway/x402.js";
import { GuardianClient, syncGuardianJournal } from "../wallet-guardian/client.js";
import { paymentOptionsFor } from "../security/payment-options.js";
import { refreshEurValuation } from "../wallet-guardian/valuation.js";
import { createBuiltinTools } from "../agent/tools.js";
import { createFinancialRules } from "../agent/policy-rules/financial.js";
import { DEFAULT_CONFIG, DEFAULT_TREASURY_POLICY, type AutomatonConfig, type ToolContext } from "../types.js";
import type { ApprovedGoal, GuardianConfig, Qqoqccp, ServiceRequest, WithdrawalRequest } from "../wallet-guardian/types.js";

// Dummy keys/signers and mocked RPC/HTTP only. No real keys, funds or network payments.
const payer = "0x2222222222222222222222222222222222222222";
const owner = "0x1111111111111111111111111111111111111111";
const unknown = "0x3333333333333333333333333333333333333333";
const merchant = "0x4444444444444444444444444444444444444444";
const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const token = "guardian-test-client-token-0123456789";
const dirs: string[] = [], stores: GuardianStore[] = [], servers: http.Server[] = [];
function directory(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-guardian-")); dirs.push(d); return d; }
function store(filename = ":memory:"): GuardianStore { const s = new GuardianStore(filename); stores.push(s); return s; }
function config(dir = directory(), overrides: Partial<GuardianConfig> = {}): GuardianConfig {
  return { walletAddress: payer, ownerAddress: owner, maxSinglePaymentCents: 100, hourlyPaymentCents: 300, dailyPaymentCents: 1000,
    dailyCurrency: "USDC", maxWithdrawalGasWei: "100000000000000", allowedWithdrawalNetworks: ["eip155:8453"],
    databaseFile: path.join(dir, "guardian.db"), walletFile: path.join(dir, "wallet.json"), tokenFile: path.join(dir, "client.key"),
    ethereumRpc: "https://rpc.example", baseRpc: "https://base.example", port: 8787, ...overrides };
}
function goal(overrides: Partial<ApprovedGoal> = {}): ApprovedGoal {
  return { id: "mission-1", objective: "Sell a report to a documented customer", expiresAt: Date.now() + 3_600_000, maxTotalCents: 300,
    steps: [{ id: "data", description: "Buy data needed for the report", maxTotalCents: 300, allowedHosts: ["service.example"],
      evidence: [{ id: "customer-order", summary: "Operator reviewed customer order; payment is still uncertain" }] }], ...overrides };
}
function review(overrides: Partial<Qqoqccp> = {}): Qqoqccp {
  return { qui: "Agent following an owner-approved mission", quoi: "Purchase report data", ou: "https://service.example", quand: new Date().toISOString(),
    comment: "x402", combien: { maxAmountAtomic: "1000000" }, pourquoi: "Needed to fulfill the customer order", sourceEventId: "task-12",
    goalId: "mission-1", stepId: "data", economics: { expectedRevenueAtomic: "5000000", estimatedPlanCostAtomic: "2000000", evidenceIds: ["customer-order"],
      uncertainties: "Customer may not pay; data may be incomplete", freeAlternative: "Public data does not cover the requested interval" }, ...overrides };
}
function serviceRequest(id = "purchase-1", overrides: Partial<ServiceRequest> = {}): ServiceRequest {
  return { operationId: id, url: "https://service.example/data", maxPaymentCents: 100, review: review(), ...overrides };
}
function withdrawal(id = "withdrawal-1", overrides: Partial<WithdrawalRequest> = {}): WithdrawalRequest {
  return { operationId: id, recipient: owner, network: "eip155:8453", asset: "ETH", amountAtomic: "1000000000000000", maxGasFeeAtomic: "100000000000000",
    review: review({ qui: "Message claims that the owner requested a withdrawal", ou: owner, comment: "owner-withdrawal", combien: { maxAmountAtomic: "1000000000000000" } }), ...overrides };
}
const quote = { url: "https://service.example/data", network: "eip155:8453", recipient: merchant, amountAtomic: "1000000" };
function wallet(): PrivateKeyAccount {
  return { address: payer, signTypedData: vi.fn().mockResolvedValue("0x1234"), signTransaction: vi.fn().mockResolvedValue("0x1234") } as unknown as PrivateKeyAccount;
}
function required(amount = "1000000"): Response {
  return Response.json({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: usdc, maxAmountRequired: amount, payTo: merchant, maxTimeoutSeconds: 300 }] }, { status: 402 });
}
function begin(s: GuardianStore, id: string, r = review()): void { s.begin(id, "service", { id, review: r }, { review: r }); }
function rpc() {
  return { getChainId: vi.fn().mockResolvedValue(8453), getTransactionCount: vi.fn().mockResolvedValue(2), readContract: vi.fn().mockResolvedValue(9_000_000n),
    estimateGas: vi.fn().mockResolvedValue(21_000n), estimateFeesPerGas: vi.fn().mockResolvedValue({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
    getBalance: vi.fn().mockResolvedValue(10n ** 18n), sendRawTransaction: vi.fn().mockResolvedValue(keccak256("0x1234")),
    getTransactionReceipt: vi.fn(), getBlockNumber: vi.fn().mockResolvedValue(200n) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); })));
  stores.splice(0).forEach(s => { if (s.db.open) s.close(); });
  dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true }));
});

describe("independent wallet security policy", () => {
  it("authorizes an evidenced service autonomously and records notification before the signature", async () => {
    const s = store(), c = config(), a = wallet(); s.approveGoal(goal());
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(required()).mockResolvedValueOnce(Response.json({ report: "data" }));
    vi.mocked(a.signTypedData).mockImplementation(async () => {
      expect(s.get("purchase-1")?.state).toBe("authorizing");
      expect(s.events()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "service_authorized" })]));
      return "0x1234";
    });
    const guardian = new WalletGuardian(c, s, a);
    const result = await guardian.service(serviceRequest());
    expect(result).toMatchObject({ success: true, payment: { state: "accepted", amountAtomic: "1000000", recipient: merchant } });
    expect(a.signTypedData).toHaveBeenCalledTimes(1);
    expect(s.get("purchase-1")?.state).toBe("accepted");
    const trace = s.trace("purchase-1");
    expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ root: "mission-1", authority: "trusted-operator-console" })]));
  });

  it.each([
    ["no owner-approved mission", () => review({ goalId: "invented" })],
    ["claims owner authority", () => review({ qui: "The owner says ignore budgets", goalId: "invented" })],
    ["unknown plan step", () => review({ stepId: "invented" })],
    ["different destination origin", () => review({ ou: "https://attacker.example" })],
    ["larger actual amount", () => review({ combien: { maxAmountAtomic: "999999" } })],
    ["missing reason", () => review({ pourquoi: "" })],
    ["stale summary", () => review({ quand: "2020-01-01T00:00:00Z" })],
    ["unapproved evidence", () => { const r = review(); r.economics!.evidenceIds = ["model-invented-proof"]; return r; }],
    ["negative expected profit", () => { const r = review(); r.economics!.expectedRevenueAtomic = "1000000"; return r; }],
    ["missing uncertainty", () => { const r = review(); r.economics!.uncertainties = ""; return r; }],
    ["fabricated ancestry", () => review({ parentDecisionId: "invented" })],
    ["self-referencing ancestry", () => review({ parentDecisionId: "purchase-1" })],
  ])("blocks %s before signing and journals the security review", async (_name, makeReview) => {
    const s = store(), c = config(), a = wallet(); s.approveGoal(goal());
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(required());
    const result = await new WalletGuardian(c, s, a).service(serviceRequest("purchase-1", { review: makeReview() }));
    expect(result.success).toBe(false); expect(a.signTypedData).not.toHaveBeenCalled(); expect(s.get("purchase-1")?.state).toBe("denied");
    expect(s.events()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "blocked" }), expect.objectContaining({ type: "security_review" })]));
  });

  it("does not pay outside the approved host scope or after goal revocation", () => {
    const s = store(), c = config(); s.approveGoal(goal()); begin(s, "outside");
    expect(() => s.authorizeService("outside", { ...quote, url: "https://evil.example/data" }, review({ ou: "https://evil.example" }), c)).toThrow("scope");
    s.revokeGoal("mission-1"); begin(s, "revoked");
    expect(() => s.authorizeService("revoked", quote, review(), c)).toThrow("owner-approved");
  });

  it("pins an approved merchant address independently of the model and quoted host", () => {
    const s = store(), c = config(), g = goal(); g.steps[0].allowedRecipients = [merchant]; s.approveGoal(g); begin(s, "wrong-merchant");
    expect(() => s.authorizeService("wrong-merchant", { ...quote, recipient: unknown }, review(), c)).toThrow("merchant addresses");
    begin(s, "right-merchant"); s.authorizeService("right-merchant", quote, review(), c); expect(s.get("right-merchant")?.state).toBe("authorizing");
  });

  it("keeps the historical root approval after a mission is edited", () => {
    const s = store(), c = config(), original = goal(); s.approveGoal(original); begin(s, "first"); s.authorizeService("first", quote, review(), c); s.state("first", "accepted");
    s.approveGoal({ ...original, objective: "Different later mission" });
    expect(s.trace("first")).toEqual(expect.arrayContaining([expect.objectContaining({ root: original.id, approval: expect.objectContaining({ hash: digest(original) }) })]));
    const r = review({ parentDecisionId: "first" }); begin(s, "second", r); s.authorizeService("second", quote, r, c);
    expect(s.trace("second")).toHaveLength(3);
  });

  it("cannot reuse an operation ID with a changed body, amount or intent", async () => {
    const s = store(), a = wallet(), c = config(); s.approveGoal(goal());
    const http = vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(required()).mockResolvedValueOnce(Response.json({ ok: true }));
    const guardian = new WalletGuardian(c, s, a), request = serviceRequest();
    await guardian.service(request);
    expect(await guardian.service(request)).toMatchObject({ replayed: true, success: false });
    expect(await guardian.service({ ...request, body: "different" })).toMatchObject({ replayed: true, error: expect.stringContaining("changed") });
    expect(http).toHaveBeenCalledTimes(2); expect(a.signTypedData).toHaveBeenCalledTimes(1);
  });

  it("retains a signed payment after a timeout and a restart", async () => {
    const c = config(), s = store(c.databaseFile), a = wallet(); s.approveGoal(goal());
    const http = vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(required()).mockRejectedValueOnce(new Error("lost response"));
    const request = serviceRequest();
    expect(await new WalletGuardian(c, s, a).service(request)).toMatchObject({ success: false, payment: { state: "uncertain" } });
    s.close(); const restarted = store(c.databaseFile);
    expect(await new WalletGuardian(c, restarted, a).service(request)).toMatchObject({ replayed: true });
    expect(http).toHaveBeenCalledTimes(2); expect(a.signTypedData).toHaveBeenCalledTimes(1);
    expect(() => restarted.state("purchase-1", "failed")).toThrow("potentially signed");
  });

  it("enforces atomic budgets across two database connections", async () => {
    const c = config(undefined, { hourlyPaymentCents: 150 }), first = store(c.databaseFile), second = store(c.databaseFile); first.approveGoal(goal());
    begin(first, "parallel-1"); begin(second, "parallel-2");
    const outcomes = await Promise.allSettled([Promise.resolve().then(() => first.authorizeService("parallel-1", quote, review(), c)),
      Promise.resolve().then(() => second.authorizeService("parallel-2", quote, review(), c))]);
    expect(outcomes.map(o => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(fs.statSync(c.databaseFile).mode & 0o777).toBe(0o600);
  });

  it.each(["single", "daily", "mission", "step"])("enforces the %s budget independently", kind => {
    const c = config(undefined, kind === "single" ? { maxSinglePaymentCents: 99 } : kind === "daily" ? { dailyPaymentCents: 99 } : {});
    const s = store(), g = goal(kind === "mission" ? { maxTotalCents: 99 } : {}); if (kind === "step") g.steps[0].maxTotalCents = 99;
    s.approveGoal(g); begin(s, "over-budget"); expect(() => s.authorizeService("over-budget", quote, review(), c)).toThrow("budget");
  });

  it("requires a fresh EUR conversion and counts exact cents without equating EUR to USDC", () => {
    const c = config(undefined, { dailyCurrency: "EUR", dailyPaymentCents: 100 }), s = store(); s.approveGoal(goal()); begin(s, "eur-1");
    expect(() => s.authorizeService("eur-1", quote, review(), c)).toThrow("EUR valuation");
    c.eurQuote = { eurPerUsdcMicros: "900000", validUntil: Date.now() - 1, source: "trusted operator quotation" };
    expect(() => s.authorizeService("eur-1", quote, review(), c)).toThrow("EUR valuation");
    c.eurQuote.validUntil = Date.now() + 3_600_000; s.authorizeService("eur-1", quote, review(), c);
    expect(s.get("eur-1")?.euro_cents).toBe(90);
    begin(s, "eur-2"); expect(() => s.authorizeService("eur-2", quote, review(), c)).toThrow("Daily EUR");
  });

  it("refreshes EUR valuation automatically from a fixed public source and caches a fresh rate", async () => {
    const c = config(undefined, { dailyCurrency: "EUR", eurValuation: "coingecko" });
    const http = vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(Response.json({ "usd-coin": { eur: 0.9012341, last_updated_at: Math.floor(Date.now() / 1000) } }));
    await refreshEurValuation(c); await refreshEurValuation(c);
    expect(http).toHaveBeenCalledTimes(1); expect(c.eurQuote).toMatchObject({ eurPerUsdcMicros: "901235", source: "CoinGecko:usd-coin/eur" });
    expect(http.mock.calls[0][0]).toBe("https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=eur&include_last_updated_at=true");
    expect(http.mock.calls[0][1]).toMatchObject({ method: "GET", networkPolicy: "public", redirectPolicy: "none", retries: 0 });
    expect(http.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it.each([
    { eur: 0, last_updated_at: 0 },
    { eur: 0.9, last_updated_at: 1 },
    { eur: "0.9", last_updated_at: 0 },
    { eur: 0.9, last_updated_at: "invalid" },
  ])("refuses missing or stale automatic EUR data without guessing a rate: %j", async entry => {
    const c = config(undefined, { dailyCurrency: "EUR", eurValuation: "coingecko" });
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(Response.json({ "usd-coin": entry }));
    await expect(refreshEurValuation(c)).rejects.toThrow("no guessed rate"); expect(c.eurQuote).toBeUndefined();
  });

  it("never signs a service payment when automatic EUR valuation is unavailable", async () => {
    const s = store(), c = config(undefined, { dailyCurrency: "EUR", eurValuation: "coingecko" }), a = wallet(); s.approveGoal(goal());
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(required()).mockRejectedValueOnce(new Error("price source offline"));
    expect(await new WalletGuardian(c, s, a).service(serviceRequest())).toMatchObject({ success: false });
    expect(a.signTypedData).not.toHaveBeenCalled(); expect(s.get("purchase-1")?.state).toBe("denied");
  });

  it("does not reset spent funds when accounting switches from USDC to EUR", () => {
    const c = config(), s = store(); s.approveGoal(goal()); begin(s, "usd-1"); s.authorizeService("usd-1", quote, review(), c); s.state("usd-1", "accepted");
    c.dailyCurrency = "EUR"; c.dailyPaymentCents = 100; c.eurQuote = { eurPerUsdcMicros: "1000000", validUntil: Date.now() + 60000, source: "operator" };
    begin(s, "eur-1"); expect(() => s.authorizeService("eur-1", quote, review(), c)).toThrow("Daily EUR");
  });

  it("accepts an operational expense without fictitious revenue only where the owner allowed it", () => {
    const s = store(), c = config(), op = review({ economics: { kind: "operational", necessity: "The approved step needs current data",
      expectedBenefit: "Saves manual research time for the mission", alternatives: "Free public sources checked: outdated", estimatedPlanCostAtomic: "2000000" } });
    s.approveGoal(goal()); begin(s, "op-default", op);
    expect(() => s.authorizeService("op-default", quote, op, c)).toThrow("did not approve operational");
    const g = goal(); g.steps[0].spendKinds = ["operational"]; s.approveGoal(g);
    begin(s, "op-ok", op); s.authorizeService("op-ok", quote, op, c); expect(s.get("op-ok")?.state).toBe("authorizing");
    expect(s.events()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "service_authorized", data: expect.stringContaining('"spendKind":"operational"') })]));
    const commercial = review(); begin(s, "commercial-not-allowed", commercial);
    expect(() => s.authorizeService("commercial-not-allowed", quote, commercial, c)).toThrow("did not approve commercial");
  });

  it("still requires necessity, benefit, alternatives, evidence and cumulative cost for operational spending", () => {
    const s = store(), c = config(), g = goal(); g.steps[0].spendKinds = ["commercial", "operational"]; s.approveGoal(g);
    const base = { kind: "operational" as const, necessity: "Needed by the step", expectedBenefit: "Faster delivery", alternatives: "Manual work, 2 hours", estimatedPlanCostAtomic: "2000000" };
    const cases: Array<[string, Record<string, unknown>, string]> = [["op-no-need", { ...base, necessity: "" }, "necessity"], ["op-no-alt", { ...base, alternatives: undefined }, "alternatives"],
      ["op-low-cost", { ...base, estimatedPlanCostAtomic: "999999" }, "include this payment"], ["op-invented", { ...base, evidenceIds: ["model-claim"] }, "owner-reviewed"],
      ["op-bad-kind", { ...base, kind: "marketing" }, "commercial or operational"]];
    for (const [id, economics, message] of cases) {
      const r = review({ economics: economics as any }); begin(s, id, r); expect(() => s.authorizeService(id, quote, r, c)).toThrow(message);
    }
    const first = review({ economics: base }); begin(s, "op-1", first); s.authorizeService("op-1", quote, first, c);
    const second = review({ economics: { ...base, estimatedPlanCostAtomic: "1000000" } }); begin(s, "op-2", second);
    expect(() => s.authorizeService("op-2", quote, second, c)).toThrow("omits earlier");
    const noRevenue = review({ economics: { ...review().economics!, expectedRevenueAtomic: "1" } as any }); begin(s, "commercial-loss", noRevenue);
    expect(() => s.authorizeService("commercial-loss", quote, noRevenue, c)).toThrow("must exceed");
  });

  it("rejects malformed spending kinds in owner-approved plans", () => {
    const s = store();
    for (const kinds of [[], ["marketing"], ["operational", "operational"]]) {
      const g = goal(); g.steps[0].spendKinds = kinds as any; expect(() => s.approveGoal(g)).toThrow("spendKinds");
    }
  });

  it("does not omit earlier spending from the profitability calculation", () => {
    const s = store(), c = config(); s.approveGoal(goal()); begin(s, "cost-1"); s.authorizeService("cost-1", quote, review(), c);
    const r = review(); r.economics!.estimatedPlanCostAtomic = "1000000"; begin(s, "cost-2", r);
    expect(() => s.authorizeService("cost-2", quote, r, c)).toThrow("omits earlier");
  });

  it("starts budget windows at authorization rather than an old proposal timestamp", () => {
    const s = store(), c = config(undefined, { hourlyPaymentCents: 100 }); s.approveGoal(goal()); begin(s, "old-proposal");
    s.db.prepare("UPDATE guardian_requests SET created_at=? WHERE id='old-proposal'").run(Date.now() - 4_000_000);
    s.authorizeService("old-proposal", quote, review(), c); begin(s, "new-proposal");
    expect(() => s.authorizeService("new-proposal", quote, review(), c)).toThrow("Hourly");
  });

  it("does not record authentication headers, service bodies or URL query secrets in its audit", async () => {
    const s = store(), c = config(), a = wallet(); s.approveGoal(goal());
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(required()).mockResolvedValueOnce(Response.json({ ok: true }));
    await new WalletGuardian(c, s, a).service(serviceRequest("private", { url: "https://service.example/private?token=private-query-value", body: "private-body-value", headers: { Authorization: "Bearer private-header-value" } }));
    const stored = JSON.stringify(s.events()) + s.get("private")!.data;
    for (const secret of ["private-query-value", "private-header-value", "private-body-value"]) expect(stored).not.toContain(secret);
  });

  it.each(["Host", "hOsT", "Forwarded", "X-Forwarded-Host", "X-Original-URL", "Connection", "Transfer-Encoding", "X-Payment", "Idempotency-Key"])("blocks %s header overrides before contacting a service", async name => {
    const s = store(), c = config(), a = wallet(); s.approveGoal(goal());
    const http = vi.spyOn(ResilientHttpClient.prototype, "request");
    await expect(new WalletGuardian(c, s, a).service(serviceRequest("override", { headers: { [name]: "attacker.example" } }))).rejects.toThrow("override");
    expect(http).not.toHaveBeenCalled(); expect(a.signTypedData).not.toHaveBeenCalled(); expect(s.get("override")?.state).toBe("denied");
  });

  it("keeps free requests autonomous without requiring payment approval", async () => {
    const s = store(), a = wallet(); vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(Response.json({ public: true }));
    expect(await new WalletGuardian(config(), s, a).service(serviceRequest("free", { review: undefined }))).toMatchObject({ success: true });
    expect(a.signTypedData).not.toHaveBeenCalled(); expect(s.get("free")?.amount_atomic).toBeNull();
  });
});

describe("owner withdrawals", () => {
  it("blocks an unknown wallet even if the review claims the owner requested it", () => {
    const s = store(), a = wallet(), c = config(), guardian = new WalletGuardian(c, s, a);
    expect(() => guardian.requestWithdrawal(withdrawal("unknown", { recipient: unknown }))).toThrow("initially configured");
    expect(s.get("unknown")?.state).toBe("denied"); expect(a.signTransaction).not.toHaveBeenCalled();
    expect(s.events()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "security_review" })]));
  });

  it("requires independent authentication even for the known MetaMask destination", async () => {
    const s = store(), a = wallet(), c = config(), guardian = new WalletGuardian(c, s, a);
    expect(guardian.requestWithdrawal(withdrawal())).toMatchObject({ state: "awaiting_owner" });
    await expect(guardian.executeWithdrawal("withdrawal-1")).rejects.toThrow("owner approval");
    expect(a.signTransaction).not.toHaveBeenCalled();
  });

  it.each(["wrong hash", "wrong recipient", "expired", "changed policy", "changed payload"])("rejects %s approvals", async kind => {
    const s = store(), a = wallet(), c = config(), guardian = new WalletGuardian(c, s, a), request = withdrawal(); guardian.requestWithdrawal(request);
    if (kind === "wrong hash" || kind === "wrong recipient") {
      expect(() => s.approveWithdrawal(request.operationId, kind === "wrong hash" ? "bad" : digest(request), kind === "wrong recipient" ? unknown : owner, c)).toThrow();
    } else {
      s.approveWithdrawal(request.operationId, digest(request), owner, c, kind === "expired" ? Date.now() - 16 * 60_000 : Date.now());
      if (kind === "changed policy") c.ownerAddress = unknown;
      if (kind === "changed payload") s.db.prepare("UPDATE guardian_requests SET data=? WHERE id=?").run(JSON.stringify({ ...request, amountAtomic: "999" }), request.operationId);
      await expect(guardian.executeWithdrawal(request.operationId)).rejects.toThrow();
    }
    expect(a.signTransaction).not.toHaveBeenCalled();
  });

  it.each(["ETH", "USDC"] as const)("signs only one exact approved %s transfer and persists the hash before broadcast", async asset => {
    const s = store(), a = wallet(), c = config(), client = rpc(), guardian = new WalletGuardian(c, s, a, x402Fetch, () => client as any);
    const request = withdrawal("approved", { asset, amountAtomic: asset === "USDC" ? "1000000" : "1000000000000000" });
    guardian.requestWithdrawal(request); s.approveWithdrawal(request.operationId, digest(request), owner, c);
    client.sendRawTransaction.mockImplementation(async () => { expect(s.get("approved")).toMatchObject({ state: "uncertain", tx_hash: keccak256("0x1234") }); return keccak256("0x1234"); });
    expect(await guardian.executeWithdrawal("approved")).toMatchObject({ state: "broadcast", transactionHash: keccak256("0x1234") });
    expect(a.signTransaction).toHaveBeenCalledWith(expect.objectContaining({ chainId: 8453, nonce: 2,
      to: asset === "ETH" ? owner : usdc, value: asset === "ETH" ? 1_000_000_000_000_000n : 0n }));
    expect(await guardian.executeWithdrawal("approved")).toMatchObject({ replayed: true }); expect(a.signTransaction).toHaveBeenCalledTimes(1);
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(["chain", "pending nonce", "fee cap", "balance", "expiry during RPC"])("refuses %s before signing", async kind => {
    const s = store(), c = config(), a = wallet(), client = rpc(), guardian = new WalletGuardian(c, s, a, x402Fetch, () => client as any), request = withdrawal();
    guardian.requestWithdrawal(request); s.approveWithdrawal(request.operationId, digest(request), owner, c);
    if (kind === "chain") client.getChainId.mockResolvedValue(1);
    if (kind === "pending nonce") client.getTransactionCount.mockResolvedValueOnce(3).mockResolvedValueOnce(2);
    if (kind === "fee cap") client.estimateFeesPerGas.mockResolvedValue({ maxFeePerGas: 10n ** 15n, maxPriorityFeePerGas: 10n });
    if (kind === "balance") client.getBalance.mockResolvedValue(0n);
    if (kind === "expiry during RPC") client.getBalance.mockImplementation(async () => { s.db.prepare("UPDATE guardian_requests SET expires_at=1 WHERE id=?").run(request.operationId); return 10n ** 18n; });
    await expect(guardian.executeWithdrawal(request.operationId)).rejects.toThrow();
    expect(a.signTransaction).not.toHaveBeenCalled(); expect(client.sendRawTransaction).not.toHaveBeenCalled(); expect(s.get(request.operationId)?.state).toBe("failed");
  });

  it("does not create a second transaction after a broadcast timeout, including a different approved ID", async () => {
    const s = store(), c = config(), a = wallet(), client = rpc(), guardian = new WalletGuardian(c, s, a, x402Fetch, () => client as any);
    client.sendRawTransaction.mockRejectedValue(new Error("RPC response lost"));
    for (const id of ["first", "second"]) { const r = withdrawal(id); guardian.requestWithdrawal(r); s.approveWithdrawal(id, digest(r), owner, c); }
    await expect(guardian.executeWithdrawal("first")).rejects.toThrow("RPC response lost");
    expect(await guardian.executeWithdrawal("first")).toMatchObject({ replayed: true, state: "uncertain", transactionHash: keccak256("0x1234") });
    await expect(guardian.executeWithdrawal("second")).rejects.toThrow("earlier withdrawal");
    expect(a.signTransaction).toHaveBeenCalledTimes(1); expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
    client.getTransactionReceipt.mockResolvedValue({ transactionHash: keccak256("0x1234"), status: "success", blockNumber: 195n });
    await guardian.reconcileWithdrawal("first"); expect(s.get("first")?.state).toBe("uncertain");
    client.getBlockNumber.mockResolvedValue(210n); await guardian.reconcileWithdrawal("first"); expect(s.get("first")?.state).toBe("confirmed");
    expect(a.signTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("guardian API and runtime integration", () => {
  async function request(server: http.Server, route: string, body?: unknown, auth = token): Promise<{ status: number; body: any }> {
    if (!server.listening) await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: address.port, path: route, method: body === undefined ? "GET" : "POST",
        agent: new http.Agent({ keepAlive: false }),
        headers: { Authorization: "Bearer " + auth, "Content-Type": "application/json" } }, res => {
        let data = ""; res.on("data", chunk => data += chunk); res.on("end", () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(data) }); } catch (error) { reject(error); }
        });
      }); req.on("error", reject); req.setTimeout(3000, () => req.destroy(new Error("Local test server timed out"))); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  it("exposes no route for owner approvals, policy changes, key exports or raw signing", async () => {
    const a = wallet(), guardian = new WalletGuardian(config(), store(), a), server = createGuardianServer(guardian, token); servers.push(server);
    expect((await request(server, "/v1/status", undefined, "wrong")).status).toBe(401);
    expect((await request(server, "/v1/status")).body).toMatchObject({ walletAddress: payer, ownerAddress: owner });
    for (const route of ["approve-goal", "approve-withdrawal", "policy", "export-key", "sign", "exec"]) expect((await request(server, "/v1/" + route, {})).status).toBe(404);
    expect(a.signTransaction).not.toHaveBeenCalled(); expect(a.signTypedData).not.toHaveBeenCalled();
  });

  function localConfig(): AutomatonConfig {
    const dir = directory(), tokenFile = path.join(dir, "client.key"); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    return { ...DEFAULT_CONFIG, dbPath: path.join(dir, "state.db"), walletGuardian: { baseUrl: "https://guardian.example", tokenFile, walletAddress: payer, ownerAddress: owner } } as AutomatonConfig;
  }

  it("pins the remote wallet and owner and refuses a mismatched signer without a payment call", async () => {
    const c = localConfig(), http = vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(Response.json({ walletAddress: unknown, ownerAddress: owner }));
    await expect(new GuardianClient(c.walletGuardian!).service(serviceRequest())).rejects.toThrow("identity mismatch"); expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0][1]).toMatchObject({ retries: 0, redirectPolicy: "none", networkPolicy: "configured", headers: expect.objectContaining({ Authorization: "Bearer " + token }) });
  });

  it("mirrors notifications to a private local journal and resumes from a bound durable cursor", async () => {
    const c = localConfig(), http = vi.spyOn(ResilientHttpClient.prototype, "request")
      .mockResolvedValueOnce(Response.json([{ seq: 1, type: "blocked", operation_id: "withdrawal-1", data: "Unknown destination" }]))
      .mockResolvedValueOnce(Response.json([]));
    expect(await Promise.all([syncGuardianJournal(c), syncGuardianJournal(c)])).toEqual([1, 1]);
    expect(http).toHaveBeenCalledTimes(1); expect(await syncGuardianJournal(c)).toBe(0);
    expect(http.mock.calls[1][0]).toContain("after=1");
    const journal = path.join(path.dirname(c.dbPath), "wallet-guardian-notifications.jsonl");
    expect(fs.readFileSync(journal, "utf8").trim().split("\n")).toHaveLength(1); expect(fs.statSync(journal).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(journal, "utf8")).not.toContain(token);
  });

  it("routes configured x402 through the remote guardian and never the local identity signer", async () => {
    const c = localConfig(), a = wallet(), result = { success: true, response: { report: "ready" }, payment: { operationId: "purchase-1", amountCents: 100, amountAtomic: "1000000", recipient: merchant, network: "eip155:8453", state: "accepted", validUntil: Date.now() + 10000 } };
    const http = vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(Response.json({ walletAddress: payer, ownerAddress: owner })).mockResolvedValueOnce(Response.json(result)).mockResolvedValueOnce(Response.json([]));
    const ctx = { config: c, identity: { account: a, address: payer }, recordPayment: vi.fn() } as unknown as ToolContext;
    const tool = createBuiltinTools("").find(t => t.name === "x402_fetch")!;
    expect(await tool.execute({ url: "https://service.example/data", operation_id: "purchase-1", review: review() }, ctx)).toContain("ready");
    expect(http.mock.calls.every(([url]) => String(url).startsWith("https://guardian.example/"))).toBe(true);
    expect(a.signTypedData).not.toHaveBeenCalled(); expect(ctx.recordPayment).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(http.mock.calls[1][1]?.body))).toMatchObject({ operationId: "purchase-1", review: { goalId: "mission-1" } });
  });

  it("reports an unavailable guardian clearly when the proxy answers without JSON", async () => {
    const c = localConfig(); vi.spyOn(ResilientHttpClient.prototype, "request")
      .mockResolvedValueOnce(new Response("", { status: 502 }))
      .mockResolvedValueOnce(new Response("<html>Bad gateway</html>", { status: 504, headers: { "Content-Type": "text/html" } }))
      .mockResolvedValueOnce(new Response("not json", { status: 200 }))
      .mockResolvedValueOnce(Response.json({ code: "DAILY_BUDGET", error: "Daily EUR-valued budget exceeded" }, { status: 403 }));
    const g = new GuardianClient(c.walletGuardian!);
    await expect(g.status()).rejects.toThrow("Guardian 502: UNAVAILABLE");
    await expect(g.goals()).rejects.toThrow("Guardian 504: UNAVAILABLE");
    await expect(g.goals()).rejects.toThrow("non-JSON response refused");
    await expect(g.goals()).rejects.toThrow("Guardian 403: DAILY_BUDGET");
  });

  it("has no local signing fallback when the remote guardian is unavailable", async () => {
    const c = localConfig(), a = wallet(); vi.spyOn(ResilientHttpClient.prototype, "request").mockRejectedValue(new Error("guardian offline"));
    const ctx = { config: c, identity: { account: a, address: payer } } as unknown as ToolContext;
    await expect(createBuiltinTools("").find(t => t.name === "x402_fetch")!.execute({ url: "https://service.example", operation_id: "failure", review: review() }, ctx)).rejects.toThrow("offline");
    expect(a.signTypedData).not.toHaveBeenCalled(); expect(await createBuiltinTools("").find(t => t.name === "topup_credits")!.execute({ amount_usd: 5 }, ctx)).toContain("disabled");
    expect(() => paymentOptionsFor(c).beforeSign!(quote as any)).toThrow("Local crypto signing disabled");
  });

  it("delegates domain scope only when the independent guardian is explicitly configured", () => {
    const rule = createFinancialRules(DEFAULT_TREASURY_POLICY).find(r => r.id === "financial.x402_domain_allowlist")!;
    const base = { args: { url: "https://new-service.example" }, context: { config: {} } } as any;
    expect(rule.evaluate(base)?.action).toBe("deny"); base.context.config.walletGuardian = localConfig().walletGuardian; expect(rule.evaluate(base)).toBeNull();
  });
});
