import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { BASE_USDC, BASE_WETH } from "./base.js";
import type { WalletSnapshot } from "./types.js";

export class TradingStore {
  constructor(readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS trading_state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trading_cycles (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trading_transactions (id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL, stage TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, hash TEXT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trading_reports (at INTEGER PRIMARY KEY, data TEXT NOT NULL);`);
    // Legacy x402 authorizations also expire on-chain. Never reserve an old accepted
    // service forever just because its pre-trading schema left expires_at NULL.
    db.prepare(`UPDATE guardian_requests SET expires_at=COALESCE(
      (SELECT json_extract(e.data,'$.quote.validUntil') FROM guardian_events e WHERE e.operation_id=guardian_requests.id AND e.type='service_authorized' ORDER BY e.seq DESC LIMIT 1),
      created_at+300000) WHERE kind='service' AND expires_at IS NULL AND state IN ('authorizing','accepted','uncertain')`).run();
  }
  get<T>(key: string): T | undefined { const row = this.db.prepare("SELECT data FROM trading_state WHERE key=?").get(key) as { data: string } | undefined; return row ? JSON.parse(row.data) : undefined; }
  set(key: string, value: unknown): void { this.db.prepare("INSERT OR REPLACE INTO trading_state(key,data) VALUES(?,?)").run(key, JSON.stringify(value)); }
  report(report: unknown, now = Date.now()): void {
    this.db.transaction(() => {
      this.set("report", report);
      this.db.prepare("INSERT OR REPLACE INTO trading_reports(at,data) VALUES(?,?)").run(now, JSON.stringify(report));
      this.db.prepare("DELETE FROM trading_reports WHERE at<?").run(now - 7 * 86400000);
    }).immediate();
  }
  active(): { id: string; created_at: number; state: string } | undefined {
    return this.db.prepare("SELECT id,created_at,state FROM trading_cycles WHERE state IN ('executing','uncertain') LIMIT 1").get() as any;
  }
  acquire(id: string, summary: unknown, now = Date.now()): boolean {
    return this.db.transaction(() => {
      if (this.active() || this.withdrawalPending() || this.db.prepare("SELECT 1 FROM trading_cycles WHERE id=?").get(id)) return false;
      this.db.prepare("INSERT INTO trading_cycles(id,created_at,state,data) VALUES(?,?,'executing',?)").run(id, now, JSON.stringify(summary));
      return true;
    }).immediate();
  }
  finish(id: string, state: "completed" | "failed" | "uncertain"): void { this.db.prepare("UPDATE trading_cycles SET state=? WHERE id=?").run(state, id); }
  assertLease(id: string): void {
    const row = this.active();
    if (!row || row.id !== id || row.state !== "executing" || Date.now() - row.created_at > 15 * 60000) throw new Error("Trading cycle no longer owns an active signing lease");
  }
  reserveTx(cycle: string, stage: string, data: unknown): string {
    const id = `${cycle}:${stage}`;
    this.db.prepare("INSERT INTO trading_transactions(id,cycle_id,stage,state,created_at,data) VALUES(?,?,?,'preparing',?,?)").run(id, cycle, stage, Date.now(), JSON.stringify(data));
    return id;
  }
  txState(id: string, state: string, hash?: string): void {
    this.db.prepare("UPDATE trading_transactions SET state=?,hash=COALESCE(?,hash) WHERE id=?").run(state, hash ?? null, id);
  }
  txs(cycle?: string): Array<{ id: string; cycle_id: string; stage: string; state: string; hash: string | null; data: string }> {
    return (cycle ? this.db.prepare("SELECT * FROM trading_transactions WHERE cycle_id=? ORDER BY created_at").all(cycle) :
      this.db.prepare("SELECT * FROM trading_transactions ORDER BY created_at DESC LIMIT 40").all()) as any;
  }
  countOrders(now = Date.now()): number {
    // An approval followed by a failed swap also consumes fees. Count signed
    // cycles, including reverted transactions, rather than only successful swaps.
    return (this.db.prepare("SELECT COUNT(DISTINCT cycle_id) AS n FROM trading_transactions WHERE state IN ('signed','uncertain','confirmed','reverted') AND created_at>?").get(now - 86400000) as { n: number }).n;
  }
  reservedUsdc(now = Date.now()): bigint {
    const rows = this.db.prepare("SELECT amount_atomic FROM guardian_requests WHERE kind='service' AND state IN ('authorizing','accepted','uncertain') AND (expires_at IS NULL OR expires_at>?)").all(now) as Array<{ amount_atomic: string | null }>;
    return rows.reduce((n, r) => n + BigInt(r.amount_atomic ?? "0"), 0n);
  }
  withdrawalPending(): boolean {
    return !!this.db.prepare("SELECT 1 FROM guardian_requests WHERE kind='withdrawal' AND state IN ('authorizing','uncertain','broadcast') LIMIT 1").get();
  }
  /** Endpoint-valued net flows: estimates, not tax accounting or exact intra-interval timing. */
  observe(snapshot: WalletSnapshot): { estimatedNetPnlQuote: number; maxDrawdownPct: number; observedNetFlowsQuote: number; baselineAt: number } {
    const old = this.get<WalletSnapshot>("wallet"), book = this.get<any>("book") ?? { estimatedNetPnlQuote: 0, maxDrawdownPct: 0, observedNetFlowsQuote: 0, baselineAt: snapshot.at, peakUnit: 1, performanceUnit: 1 };
    if (old) {
      const change = snapshot.equityQuote - old.equityQuote;
      const flows = (Number(BigInt(snapshot.usdcAtomic) - BigInt(old.usdcAtomic)) / 1e6) +
        Number(BigInt(snapshot.nativeWei) + BigInt(snapshot.wethAtomic) - BigInt(old.nativeWei) - BigInt(old.wethAtomic)) / 1e18 * snapshot.priceQuote;
      const pnl = change - flows;
      book.estimatedNetPnlQuote += pnl; book.observedNetFlowsQuote += flows;
      if (old.equityQuote > 0) book.performanceUnit *= Math.max(0, 1 + pnl / old.equityQuote);
    }
    book.peakUnit = Math.max(book.peakUnit, book.performanceUnit);
    book.maxDrawdownPct = Math.max(book.maxDrawdownPct, 100 * (book.peakUnit - book.performanceUnit) / book.peakUnit);
    this.set("wallet", snapshot); this.set("book", book);
    return book;
  }
  recordExecutionPnl(pnl: number, baseline: number): void {
    const book = this.get<any>("book"); if (!book) return;
    book.estimatedNetPnlQuote += pnl;
    if (baseline > 0) book.performanceUnit *= Math.max(0, 1 + pnl / baseline);
    book.peakUnit = Math.max(book.peakUnit, book.performanceUnit);
    book.maxDrawdownPct = Math.max(book.maxDrawdownPct, 100 * (book.peakUnit - book.performanceUnit) / book.peakUnit);
    this.set("book", book);
  }
  cycleId(barTime: number): string { return "trade-v1-" + createHash("sha256").update(`8453:${BASE_WETH}:${BASE_USDC}:${barTime}`).digest("hex").slice(0, 24); }
}

export function assertNoTradingReservation(db: Database.Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trading_cycles'").get()) return;
  if (db.prepare("SELECT 1 FROM trading_cycles WHERE state IN ('executing','uncertain') LIMIT 1").get()) throw new Error("Trading transaction in progress or uncertain; reconcile before other wallet operations");
}
