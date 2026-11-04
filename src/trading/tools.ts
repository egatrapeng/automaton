import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AutomatonConfig, AutomatonDatabase, AutomatonTool, ToolContext } from "../types.js";
import { guardianFor } from "../wallet-guardian/client.js";
import { fetchTokenResearch } from "./market.js";
import { agentkitRead } from "./agentkit.js";

/** Sanitized data only; a dashboard may read this file without receiving a wallet capability. */
export async function syncTradingReport(config: AutomatonConfig, db?: AutomatonDatabase): Promise<unknown> {
  if (!config.walletGuardian) return { mode: "unconfigured", state: "guardian_required" };
  const report = { ...await guardianFor(config).trading(), ...(db ? { inference: inferenceBudget({ config, db }) } : {}) };
  const filename = config.dbPath.startsWith("~") ? path.join(process.env.HOME || "/root", config.dbPath.slice(1)) : path.resolve(config.dbPath);
  const destination = path.join(path.dirname(filename), "trading-report.json"), temporary = destination + "." + randomUUID();
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(report, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return report;
}
function inferenceBudget(ctx: Pick<ToolContext, "config" | "db">) {
  const dailyLimitCents = ctx.config.treasuryPolicy?.maxInferenceDailyCents ?? null;
  let recordedCents: number | null = null;
  try {
    const row = ctx.db.raw.prepare("SELECT SUM(amount_cents) AS total FROM spend_tracking WHERE category='inference' AND window_day=?").get(new Date().toISOString().slice(0, 10)) as { total: number | null };
    recordedCents = row.total ?? 0;
  } catch { /* Unknown is never zero. Existing budget tracker remains authoritative. */ }
  return { dailyLimitCents, recordedCents, remainingEstimateCents: dailyLimitCents !== null && recordedCents !== null ? Math.max(0, dailyLimitCents - recordedCents) : null,
    note: "Provider invoice separate. Wallet capital does not replenish the Anthropic API budget." };
}
export function tradingTools(): AutomatonTool[] {
  return [
    { name: "trading_status", category: "financial", riskLevel: "safe", description: "Read the independent trading report, real/paper positions, study, fees, capital and order states. A missing quote is unavailable, never zero. No inference or order is started.",
      parameters: { type: "object", properties: {} }, execute: async (_args, ctx) => JSON.stringify(await syncTradingReport(ctx.config, ctx.db)) },
    { name: "trading_tick", category: "financial", riskLevel: "dangerous", description: "Ask the independent engine to run its due study/simulation/live cycle. It selects the strategy from its own data and obeys the owner-configured cadence and mode; the model cannot set a recipient, calldata, quote, capital increase or enable live mode. May trade in live mode. Repeated calls do not bypass cadence.",
      parameters: { type: "object", properties: {} }, execute: async (_args, ctx) => JSON.stringify(await guardianFor(ctx.config).tradingTick()) },
    { name: "trading_token_research", category: "financial", riskLevel: "safe", description: "Bankr-style read-only Base token research: market pairs, liquidity, volumes and explicitly unknown holder/admin/sellability risks. This does not certify a token or allow V1 trading outside ETH/USDC.",
      parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"] }, execute: async (args) => JSON.stringify(await fetchTokenResearch(String(args.token))) },
    { name: "agentkit_read", category: "financial", riskLevel: "safe", description: "Optional Coinbase AgentKit observer: Pyth prices/feed IDs or DeFiLlama token prices/protocols only. No CDP credentials, wallet creation, transfer or signer. The integration must be installed separately.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["fetch_price_feed", "fetch_price", "get_token_prices", "find_protocol", "get_protocol"] }, args: { type: "object" } }, required: ["action", "args"] },
      execute: async args => agentkitRead(String(args.action), args.args) },
  ];
}
