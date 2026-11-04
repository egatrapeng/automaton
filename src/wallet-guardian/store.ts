import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { isAddress } from "viem";
import { redactValue } from "../security/redaction.js";
import { GuardianDenied, type ApprovedGoal, type GuardianPolicy, type Qqoqccp, type WithdrawalRequest } from "./types.js";

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function atomic(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9]\d{0,77}$/.test(value)) throw new GuardianDenied("INVALID_AMOUNT", "Expected positive integer atomic units");
  const amount = BigInt(value);
  if (amount >= 2n ** 256n) throw new GuardianDenied("INVALID_AMOUNT", "Amount exceeds uint256");
  return amount;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new GuardianDenied("INVALID_ID", "Invalid operation or evidence identifier");
  return value;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new GuardianDenied("INCOMPLETE_QQOQCCP", `Missing or oversized ${name}`);
  return value;
}
function cents(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new GuardianDenied("INVALID_BUDGET", "Expected non-negative integer cents");
  return value;
}
export function validatePolicy(policy: GuardianPolicy): void {
  for (const address of [policy.ownerAddress, policy.walletAddress]) {
    if (!isAddress(address, { strict: false }) || /^0x0{40}$/i.test(address)) throw new Error("Invalid guardian/owner address");
  }
  for (const n of [policy.maxSinglePaymentCents, policy.hourlyPaymentCents, policy.dailyPaymentCents]) cents(n);
  if (policy.minimumUsdcReserveCents !== undefined) cents(policy.minimumUsdcReserveCents);
  if (!["EUR", "USDC"].includes(policy.dailyCurrency)) throw new Error("Explicit EUR or USDC accounting currency required");
  if (policy.eurValuation !== undefined && !["coingecko", "manual"].includes(policy.eurValuation)) throw new Error("Unsupported operator-selected EUR source");
  atomic(policy.maxWithdrawalGasWei);
  if (!Array.isArray(policy.allowedWithdrawalNetworks) || policy.allowedWithdrawalNetworks.some(n => !["eip155:1", "eip155:8453"].includes(n))) throw new Error("Unsupported withdrawal network");
}

interface Row {
  id: string; kind: string; hash: string; state: string; created_at: number;
  goal_id: string | null; step_id: string | null; amount_atomic: string | null;
  euro_cents: number; data: string; tx_hash: string | null; expires_at: number | null;
}

/** Must be stored on the signer's trusted host, outside the agent's authority. */
export class GuardianStore {
  readonly db: Database.Database;
  constructor(filename: string) {
    if (filename !== ":memory:") {
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(filename)) {
        try { fs.closeSync(fs.openSync(filename, "wx", 0o600)); }
        catch (error: any) { if (error.code !== "EEXIST") throw error; }
      }
      if (!fs.lstatSync(filename).isFile()) throw new Error("Guardian DB must be a regular file");
      fs.chmodSync(filename, 0o600);
    }
    this.db = new Database(filename);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("max_page_count = 32768"); // Bound local audit storage; a full audit DB fails closed.
    this.db.exec(`CREATE TABLE IF NOT EXISTS guardian_goals (id TEXT PRIMARY KEY, data TEXT NOT NULL, hash TEXT NOT NULL, approved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS guardian_requests (id TEXT PRIMARY KEY, kind TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
        goal_id TEXT, step_id TEXT, amount_atomic TEXT, euro_cents INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, tx_hash TEXT, expires_at INTEGER);
      CREATE INDEX IF NOT EXISTS guardian_budget ON guardian_requests(kind,state,created_at);
      CREATE TABLE IF NOT EXISTS guardian_goal_versions (hash TEXT PRIMARY KEY, id TEXT NOT NULL, data TEXT NOT NULL, approved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS guardian_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, operation_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);`);
  }
  close(): void { this.db.close(); }
  event(id: string, type: string, data: unknown): void {
    this.db.prepare("INSERT INTO guardian_events(created_at,operation_id,type,data) VALUES(?,?,?,?)")
      .run(Date.now(), id, type, JSON.stringify(redactValue(data)));
  }
  events(after = 0): unknown[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid notification cursor");
    return this.db.prepare("SELECT * FROM guardian_events WHERE seq > ? ORDER BY seq LIMIT 100").all(after);
  }
  get(id: string): Row | undefined { return this.db.prepare("SELECT * FROM guardian_requests WHERE id=?").get(identifier(id)) as Row | undefined; }
  goals(): unknown[] {
    return (this.db.prepare("SELECT data,hash,approved_at FROM guardian_goals LIMIT 100").all() as Array<{ data: string; hash: string; approved_at: number }>)
      .map(g => ({ goal: JSON.parse(g.data), approvedGoalHash: g.hash, approvedAt: g.approved_at, authority: "trusted-operator-console" }));
  }
  revokeGoal(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM guardian_goals WHERE id=?").run(identifier(id));
      this.event(id, "owner_goal_revoked", { authority: "trusted-operator-console", action: "New authorizations blocked; previously authorized or issued payments cannot be revoked" });
    }).immediate();
  }
  trace(id: string): unknown[] {
    const trace: unknown[] = [], seen = new Set<string>();
    let current: string | undefined = identifier(id);
    while (current && trace.length < 32) {
      if (seen.has(current)) throw new Error("Decision provenance cycle"); seen.add(current);
      const row = this.get(current); if (!row) break;
      const data = JSON.parse(row.data);
      trace.push({ id: row.id, kind: row.kind, requestHash: row.hash, state: row.state, approvedGoalHash: data.approvedGoalHash, summary: data.review });
      if (row.kind === "withdrawal" && row.expires_at) {
        trace.push({ root: `owner-withdrawal:${row.id}`, authority: "trusted-operator-console", requestHash: row.hash, approvalExpiresAt: row.expires_at });
      }
      if (!data.review?.parentDecisionId && row.goal_id) {
        const goal = this.db.prepare("SELECT hash,approved_at FROM guardian_goal_versions WHERE hash=?").get(data.approvedGoalHash);
        trace.push({ root: row.goal_id, authority: "trusted-operator-console", approval: goal });
      }
      current = data.review?.parentDecisionId;
    }
    return trace;
  }
  begin(id: string, kind: "service" | "withdrawal", payload: unknown, publicData: unknown): boolean {
    identifier(id);
    return this.db.transaction(() => {
      const previous = this.get(id);
      const hash = digest(payload);
      if (previous) {
        if (previous.hash !== hash || previous.kind !== kind) {
          this.event(id, "security_incident", { reason: "OPERATION_CHANGED", remediation: "Reject changed payload; inspect source and previous decision; never change policy automatically" });
          return false;
        }
        return false;
      }
      this.db.prepare("INSERT INTO guardian_requests(id,kind,hash,state,created_at,data) VALUES(?,?,?,'proposed',?,?)")
        .run(id, kind, hash, Date.now(), JSON.stringify(redactValue(publicData)));
      this.event(id, "proposed", { kind, requestHash: hash });
      return true;
    }).immediate();
  }
  deny(id: string, code: string, reason: string): void {
    this.db.transaction(() => {
      const previous = this.get(id);
      // Never erase a previously issued or uncertain authorization on a denial.
      if (previous && ["proposed", "awaiting_owner", "approved"].includes(previous.state)) {
        this.db.prepare("UPDATE guardian_requests SET state='denied' WHERE id=?").run(id);
      }
      this.event(id, "blocked", { code, reason });
      this.event(id, "security_review", { code, action: "Transaction blocked; inspect provenance and permissions. No automatic rule weakening, key export, SSH change or blind retry." });
    }).immediate();
  }
  state(id: string, state: "accepted" | "broadcast" | "uncertain" | "failed", txHash?: string): void {
    this.db.transaction(() => {
      const row = this.get(id);
      if (!row) throw new Error("Unknown operation");
      if (["authorizing", "accepted", "uncertain", "broadcast"].includes(row.state) && state === "failed") throw new Error("Cannot release potentially signed funds");
      this.db.prepare("UPDATE guardian_requests SET state=?,tx_hash=COALESCE(?,tx_hash) WHERE id=?").run(state, txHash ?? null, id);
      this.event(id, state, { txHash });
    }).immediate();
  }
  /** Trusted console only. There is deliberately no HTTP endpoint for this. */
  approveGoal(goal: ApprovedGoal, now = Date.now()): void {
    identifier(goal.id); text(goal.objective, "goal objective"); cents(goal.maxTotalCents);
    if (!Number.isSafeInteger(goal.expiresAt) || goal.expiresAt <= now) throw new Error("Goal must expire in the future");
    if (!Array.isArray(goal.steps) || !goal.steps.length || goal.steps.length > 32) throw new Error("Goal requires bounded plan steps");
    const ids = new Set<string>();
    for (const step of goal.steps) {
      identifier(step.id); text(step.description, "step description"); cents(step.maxTotalCents);
      if (ids.has(step.id)) throw new Error("Duplicate step ID"); ids.add(step.id);
      if (step.allowedHosts !== "public" && (!Array.isArray(step.allowedHosts) || !step.allowedHosts.length || step.allowedHosts.some(h => typeof h !== "string" || !/^[a-z0-9.-]+$/i.test(h)))) throw new Error("Explicit public-domain scope required");
      if (step.allowedRecipients !== undefined && (!Array.isArray(step.allowedRecipients) || step.allowedRecipients.some(a => !isAddress(a, { strict: false }) || /^0x0{40}$/i.test(a)))) throw new Error("Invalid approved merchant addresses");
      if (!Array.isArray(step.evidence) || !step.evidence.length || step.evidence.length > 32) throw new Error("Plan must record its evidence/assumptions");
      for (const evidence of step.evidence) { identifier(evidence.id); text(evidence.summary, "evidence summary"); }
    }
    this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO guardian_goal_versions(hash,id,data,approved_at) VALUES(?,?,?,?)")
        .run(digest(goal), goal.id, JSON.stringify(goal), now);
      this.db.prepare("INSERT OR REPLACE INTO guardian_goals(id,data,hash,approved_at) VALUES(?,?,?,?)")
        .run(goal.id, JSON.stringify(goal), digest(goal), now);
      this.event(goal.id, "owner_goal_approved", { authority: "trusted-operator-console", goalHash: digest(goal), objective: goal.objective });
    }).immediate();
  }
  private review(review: Qqoqccp | undefined, amount: bigint, now: number): Qqoqccp {
    if (!review || typeof review !== "object") throw new GuardianDenied("INCOMPLETE_QQOQCCP", "QQOQCCP decision summary required before signing");
    for (const key of ["qui", "quoi", "ou", "quand", "comment", "pourquoi"] as const) text(review[key], key);
    identifier(review.sourceEventId);
    const date = Date.parse(review.quand);
    if (!Number.isFinite(date) || Math.abs(date - now) > 10 * 60_000) throw new GuardianDenied("STALE_REVIEW", "Decision summary must be recent");
    if (atomic(review.combien?.maxAmountAtomic) < amount) throw new GuardianDenied("REVIEW_AMOUNT_CHANGED", "Actual quote exceeds reviewed amount");
    return review;
  }
  authorizeService(id: string, quote: { url: string; network: string; recipient: string; amountAtomic: string }, review: Qqoqccp | undefined, policy: GuardianPolicy, now = Date.now()): void {
    validatePolicy(policy);
    this.db.transaction(() => {
      const row = this.get(id);
      if (!row || row.state !== "proposed" || row.kind !== "service") throw new GuardianDenied("DUPLICATE", "Operation is not awaiting review");
      const amount = atomic(quote.amountAtomic);
      const r = this.review(review, amount, now);
      if (quote.network !== "eip155:8453") throw new GuardianDenied("NETWORK_NOT_ALLOWED", "Autonomous services use canonical USDC on Base");
      const url = new URL(quote.url);
      if (r.ou !== url.origin || r.comment !== "x402") throw new GuardianDenied("REVIEW_TARGET_CHANGED", "Review must bind the actual origin and payment mechanism");
      const entry = this.db.prepare("SELECT * FROM guardian_goals WHERE id=?").get(identifier(r.goalId)) as { data: string; hash: string } | undefined;
      if (!entry) throw new GuardianDenied("GOAL_NOT_APPROVED", "A model's claim of user authority is not an owner-approved goal");
      const goal = JSON.parse(entry.data) as ApprovedGoal;
      if (goal.expiresAt <= now) throw new GuardianDenied("GOAL_EXPIRED", "Approved mission expired");
      const step = goal.steps.find(s => s.id === r.stepId);
      if (!step) throw new GuardianDenied("STEP_NOT_APPROVED", "Payment does not belong to an approved plan step");
      if (step.allowedHosts !== "public" && !step.allowedHosts.includes(url.hostname)) throw new GuardianDenied("SERVICE_NOT_APPROVED", "Service outside owner-authorized plan scope");
      if (step.allowedRecipients && !step.allowedRecipients.some(a => a.toLowerCase() === quote.recipient.toLowerCase())) throw new GuardianDenied("MERCHANT_NOT_APPROVED", "Actual quote recipient differs from the owner-approved merchant addresses");
      if (r.parentDecisionId) {
        const parent = this.get(identifier(r.parentDecisionId));
        if (!parent || parent.id === id || parent.goal_id !== goal.id || !["accepted", "broadcast"].includes(parent.state)) throw new GuardianDenied("INVALID_PROVENANCE", "Parent must be a completed decision in the same authorized mission");
      }
      const economics = r.economics;
      if (!economics) throw new GuardianDenied("ECONOMIC_CASE_MISSING", "Record benefit, cost, evidence, alternatives and uncertainty");
      const cost = atomic(economics.estimatedPlanCostAtomic), revenue = atomic(economics.expectedRevenueAtomic);
      if (cost < amount || revenue <= cost) throw new GuardianDenied("PLAN_NOT_JUSTIFIED", "Expected plan benefit must exceed stated plan cost, including this payment");
      text(economics.uncertainties, "economic uncertainty"); text(economics.freeAlternative, "free alternative");
      if (!Array.isArray(economics.evidenceIds) || !economics.evidenceIds.length || economics.evidenceIds.some(e => !step.evidence.some(x => x.id === e))) throw new GuardianDenied("UNAPPROVED_EVIDENCE", "Economic assumptions must cite owner-reviewed evidence; a profit claim is not proof");
      const prior = this.db.prepare("SELECT * FROM guardian_requests WHERE kind='service' AND state IN ('authorizing','accepted','uncertain')").all() as Row[];
      const sum = (rows: Row[]) => rows.reduce((n, p) => n + BigInt(p.amount_atomic ?? "0"), 0n);
      const max = (c: number) => BigInt(cents(c)) * 10_000n;
      if (cost < sum(prior.filter(p => p.goal_id === goal.id)) + amount) throw new GuardianDenied("PLAN_COST_UNDERSTATED", "Estimated total plan cost omits earlier authorized expenses");
      if (amount > max(policy.maxSinglePaymentCents)) throw new GuardianDenied("SINGLE_BUDGET", "Per-payment budget exceeded");
      if (sum(prior.filter(p => p.created_at > now - 3_600_000)) + amount > max(policy.hourlyPaymentCents)) throw new GuardianDenied("HOURLY_BUDGET", "Hourly service budget exceeded");
      if (sum(prior.filter(p => p.goal_id === goal.id)) + amount > max(goal.maxTotalCents)) throw new GuardianDenied("GOAL_BUDGET", "Mission budget exceeded");
      if (sum(prior.filter(p => p.goal_id === goal.id && p.step_id === step.id)) + amount > max(step.maxTotalCents)) throw new GuardianDenied("STEP_BUDGET", "Plan step budget exceeded");
      const today = prior.filter(p => p.created_at > now - 86_400_000);
      let euroCents = 0;
      if (policy.dailyCurrency === "EUR") {
        const fx = policy.eurQuote;
        if (!fx || !Number.isSafeInteger(fx.validUntil) || fx.validUntil <= now || fx.validUntil > now + 86_400_000 || !fx.source?.trim()) throw new GuardianDenied("FX_NOT_VERIFIED", "Fresh trusted EUR valuation required; EUR is not USDC");
        const rate = atomic(fx.eurPerUsdcMicros);
        const charge = (amount * rate + 9_999_999_999n) / 10_000_000_000n;
        if (charge > BigInt(Number.MAX_SAFE_INTEGER)) throw new GuardianDenied("INVALID_AMOUNT", "EUR valuation overflow");
        euroCents = Number(charge);
        const previousEur = today.reduce((n, p) => n + (p.euro_cents > 0 ? BigInt(p.euro_cents) : (BigInt(p.amount_atomic ?? "0") * rate + 9_999_999_999n) / 10_000_000_000n), 0n);
        if (previousEur + charge > BigInt(cents(policy.dailyPaymentCents))) throw new GuardianDenied("DAILY_BUDGET", "Daily EUR-valued budget exceeded");
      } else if (sum(today) + amount > max(policy.dailyPaymentCents)) throw new GuardianDenied("DAILY_BUDGET", "Daily USDC budget exceeded");
      const metadata = { ...JSON.parse(row.data), approvedGoalHash: entry.hash };
      // Budget windows start at authorization, not at the earlier HTTP probe.
      this.db.prepare("UPDATE guardian_requests SET state='authorizing',goal_id=?,step_id=?,amount_atomic=?,euro_cents=?,data=?,created_at=? WHERE id=?")
        .run(goal.id, step.id, amount.toString(), euroCents, JSON.stringify(metadata), now, id);
      this.event(id, "service_authorized", { quote: { ...quote, url: url.origin }, qqoqccp: r, parent: r.parentDecisionId ?? `owner-goal:${goal.id}`, approvedGoalHash: entry.hash,
        accounting: { currency: policy.dailyCurrency, euroCents: policy.dailyCurrency === "EUR" ? euroCents : undefined, eurQuote: policy.dailyCurrency === "EUR" ? policy.eurQuote : undefined },
        economicVerdict: "Positive under declared assumptions only; profitability is not guaranteed", notification: "Recorded before signing" });
    }).immediate();
  }
  requestWithdrawal(request: WithdrawalRequest, policy: GuardianPolicy, now = Date.now()): void {
    validatePolicy(policy);
    const amount = atomic(request.amountAtomic);
    this.review(request.review, amount, now);
    if (!isAddress(request.recipient, { strict: false }) || request.recipient.toLowerCase() !== policy.ownerAddress.toLowerCase()) throw new GuardianDenied("UNKNOWN_WITHDRAWAL_WALLET", "Withdrawal destination is not the initially configured owner wallet");
    if (!policy.allowedWithdrawalNetworks.includes(request.network) || !["ETH", "USDC"].includes(request.asset)) throw new GuardianDenied("WITHDRAWAL_ASSET", "Unsupported withdrawal network or asset");
    if (request.review.ou.toLowerCase() !== request.recipient.toLowerCase() || request.review.comment !== "owner-withdrawal") throw new GuardianDenied("REVIEW_TARGET_CHANGED", "Review must bind the withdrawal recipient and mechanism");
    if (atomic(request.maxGasFeeAtomic) > atomic(policy.maxWithdrawalGasWei)) throw new GuardianDenied("GAS_BUDGET", "Withdrawal fee cap exceeds independent policy");
    this.db.transaction(() => {
      this.db.prepare("UPDATE guardian_requests SET state='awaiting_owner',amount_atomic=? WHERE id=? AND state='proposed'").run(request.amountAtomic, request.operationId);
      this.event(request.operationId, "owner_authentication_required", { recipient: request.recipient, network: request.network, asset: request.asset, amountAtomic: request.amountAtomic,
        decision: "Known wallet, but a model's claim that the user asked is not authentication", requestHash: digest(request) });
    }).immediate();
  }
  /** Only the operator on the trusted signer host can grant this exact, expiring approval. */
  approveWithdrawal(id: string, expectedHash: string, recipient: string, policy: GuardianPolicy, now = Date.now()): void {
    this.db.transaction(() => {
      const row = this.get(id);
      if (!row || row.kind !== "withdrawal" || row.state !== "awaiting_owner" || row.hash !== expectedHash) throw new Error("Exact pending withdrawal hash required");
      const request = JSON.parse(row.data) as WithdrawalRequest;
      if (recipient.toLowerCase() !== policy.ownerAddress.toLowerCase() || request.recipient.toLowerCase() !== recipient.toLowerCase()) throw new Error("Owner destination mismatch");
      this.db.prepare("UPDATE guardian_requests SET state='approved',expires_at=? WHERE id=?").run(now + 15 * 60_000, id);
      this.event(id, "owner_withdrawal_approved", { authority: "trusted-operator-console", requestHash: expectedHash, recipient, validUntil: now + 15 * 60_000 });
    }).immediate();
  }
  claimWithdrawal(id: string, policy: GuardianPolicy, now = Date.now()): WithdrawalRequest {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (!row || row.kind !== "withdrawal" || row.state !== "approved" || !row.expires_at || row.expires_at <= now) throw new GuardianDenied("OWNER_APPROVAL_REQUIRED", "Exact unexpired owner approval required");
      const request = JSON.parse(row.data) as WithdrawalRequest;
      if (digest(request) !== row.hash || request.recipient.toLowerCase() !== policy.ownerAddress.toLowerCase()) throw new GuardianDenied("APPROVAL_CHANGED", "Approved payload or configured destination changed");
      if (!policy.allowedWithdrawalNetworks.includes(request.network) || atomic(request.maxGasFeeAtomic) > atomic(policy.maxWithdrawalGasWei)) throw new GuardianDenied("POLICY_CHANGED", "Independent policy no longer permits withdrawal");
      if (this.db.prepare("SELECT 1 FROM guardian_requests WHERE kind='withdrawal' AND id<>? AND state IN ('authorizing','uncertain') LIMIT 1").get(id)) throw new GuardianDenied("WITHDRAWAL_UNRESOLVED", "Resolve the earlier withdrawal before consuming another approval");
      this.db.prepare("UPDATE guardian_requests SET state='authorizing' WHERE id=?").run(id);
      this.event(id, "withdrawal_authorized", { requestHash: row.hash, recipient: request.recipient, notification: "Recorded before signing" });
      return request;
    }).immediate();
  }
  failBeforeWithdrawalSignature(id: string): void {
    this.db.transaction(() => {
      const row = this.get(id);
      if (!row || row.kind !== "withdrawal" || row.state !== "authorizing" || row.tx_hash) throw new Error("Cannot release an issued withdrawal");
      this.db.prepare("UPDATE guardian_requests SET state='failed' WHERE id=?").run(id);
      this.event(id, "withdrawal_not_signed", { action: "Approval consumed; a new exact owner approval is required" });
    }).immediate();
  }
}
