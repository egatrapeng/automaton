import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase, inferenceInsertCost } from "../state/database.js";
import { GuardianClient } from "../wallet-guardian/client.js";
import { syncTradingReport } from "../trading/tools.js";
import type { AutomatonConfig, AutomatonDatabase } from "../types.js";

describe("trading report inference costs", () => {
  let directory: string, db: AutomatonDatabase, config: AutomatonConfig;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T23:59:59.999Z"));
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "trading-report-cost-"));
    const filename = path.join(directory, "state.db"), tokenFile = path.join(directory, "client.key");
    fs.writeFileSync(tokenFile, "test-only-guardian-token-000000000000000000", { mode: 0o600 });
    db = createDatabase(filename);
    config = { dbPath: filename, treasuryPolicy: { maxInferenceDailyCents: 300 }, walletGuardian: {
      baseUrl: "https://guardian.example", tokenFile, ownerAddress: "0x1111111111111111111111111111111111111111",
      walletAddress: "0x2222222222222222222222222222222222222222",
    } } as AutomatonConfig;
    // No network; the local agent augments the independent guardian's report.
    vi.spyOn(GuardianClient.prototype, "trading").mockResolvedValue({ mode: "live", state: "hold" });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  function cost(cents: number, timestamp: string) {
    const id = inferenceInsertCost(db.raw, { sessionId: "fixture", turnId: null, model: "claude-fixture", provider: "anthropic",
      inputTokens: 100, outputTokens: 20, costCents: cents, latencyMs: 1, tier: "normal", taskType: "agent_turn", cacheHit: false });
    db.raw.prepare("UPDATE inference_costs SET created_at=? WHERE id=?").run(timestamp, id);
  }
  it("reports the router's 293 cents even when spend_tracking is empty, and saves it privately", async () => {
    cost(293, "2026-11-04 12:00:00");
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM spend_tracking").get() as { n: number }).n).toBe(0);
    const report = await syncTradingReport(config, db) as any;
    expect(report.inference).toMatchObject({ dailyLimitCents: 300, recordedCents: 293, remainingEstimateCents: 7, dayUtc: "2026-11-04", source: "inference_costs" });
    const filename = path.join(directory, "trading-report.json");
    expect(JSON.parse(fs.readFileSync(filename, "utf8")).inference.recordedCents).toBe(293);
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(report)).not.toContain("test-only-guardian-token");
  });
  it("uses the complete UTC day, excluding yesterday and tomorrow", async () => {
    cost(200, "2026-11-03 23:59:59.999"); cost(100, "2026-11-04 00:00:00");
    cost(193, "2026-11-04 23:59:59.999"); cost(400, "2026-11-05 00:00:00");
    expect((await syncTradingReport(config, db) as any).inference.recordedCents).toBe(293);
    vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
    expect((await syncTradingReport(config, db) as any).inference).toMatchObject({ dayUtc: "2026-11-05", recordedCents: 400, remainingEstimateCents: 0 });
  });
  it("keeps a missing cost ledger unknown instead of reporting zero", async () => {
    db.raw.exec("DROP TABLE inference_costs");
    expect((await syncTradingReport(config, db) as any).inference).toMatchObject({ recordedCents: null, remainingEstimateCents: null });
  });
  it("reports zero only when the authoritative ledger has no cost that day", async () => {
    expect((await syncTradingReport(config, db) as any).inference).toMatchObject({ recordedCents: 0, remainingEstimateCents: 300 });
  });
});
