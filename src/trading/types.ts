/** Trading capital is the guardian wallet, not the service-purchase budget. */
export interface TradingPolicy {
  mode: "paper" | "live";
  intervalSeconds: number;
  allocationBps: number;
  maxSlippageBps: number;
  maxQuoteDeviationBps: number;
  nativeReserveWei: string;
  maxGasFeeWei: string;
  minimumOrderCents: number;
  maxOrdersPerDay: number;
  /** Optional owner-selected loss circuit breaker; null explicitly means no daily loss limit. */
  maxDailyLossBps: number | null;
  studyFeeBps: number;
  studySlippageBps: number;
  studyGasQuote: number;
  minOutOfSampleTrades: number;
}

export const DEFAULT_TRADING_POLICY: TradingPolicy = {
  mode: "paper", intervalSeconds: 900, allocationBps: 10_000,
  maxSlippageBps: 100, maxQuoteDeviationBps: 300,
  nativeReserveWei: "300000000000000", maxGasFeeWei: "100000000000000",
  minimumOrderCents: 100, maxOrdersPerDay: 12, maxDailyLossBps: null,
  studyFeeBps: 5, studySlippageBps: 25, studyGasQuote: 0.02, minOutOfSampleTrades: 1,
};

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface StudyResult {
  strategy: string; fast: number; slow: number; trainingEnd: number;
  outOfSample: { netReturnPct: number; benchmarkReturnPct: number; maxDrawdownPct: number; trades: number; feesQuote: number };
  target: "ETH" | "USDC"; eligible: boolean; reason: string;
  dataStart: number; dataEnd: number; dataHash: string;
  warning: string;
}
export interface WalletSnapshot {
  nativeWei: string; wethAtomic: string; usdcAtomic: string;
  priceQuote: number; equityQuote: number; spendableQuote: number;
  nativeReserveWei: string; at: number; block: string;
}

export function validateTradingPolicy(p: TradingPolicy): void {
  if (!["paper", "live"].includes(p.mode)) throw new Error("Unknown trading mode");
  for (const [value, min, max] of [[p.intervalSeconds, 60, 86400], [p.allocationBps, 1, 10000],
    [p.maxSlippageBps, 1, 500], [p.maxQuoteDeviationBps, 1, 1000], [p.minimumOrderCents, 1, 1e9],
    [p.maxOrdersPerDay, 1, 100], [p.studyFeeBps, 0, 1000], [p.studySlippageBps, 0, 1000], [p.minOutOfSampleTrades, 1, 1000]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid trading policy limits");
  }
  if (p.maxDailyLossBps !== null && (!Number.isSafeInteger(p.maxDailyLossBps) || p.maxDailyLossBps <= 0 || p.maxDailyLossBps > 10000)) throw new Error("Invalid daily loss breaker");
  if (!Number.isFinite(p.studyGasQuote) || p.studyGasQuote < 0 || p.studyGasQuote > 100) throw new Error("Invalid study gas estimate");
  for (const n of [p.nativeReserveWei, p.maxGasFeeWei]) if (typeof n !== "string" || !/^[1-9]\d{0,25}$/.test(n)) throw new Error("Invalid trading gas reserve/cap");
  if (BigInt(p.nativeReserveWei) < 3n * BigInt(p.maxGasFeeWei)) throw new Error("Reserve must cover at least three capped total Base fee estimates; estimates are not on-chain fee guarantees");
}
