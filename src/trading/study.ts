import { createHash } from "node:crypto";
import type { Candle, TradingPolicy, StudyResult } from "./types.js";

const CANDIDATES = [{ fast: 5, slow: 20 }, { fast: 10, slow: 40 }, { fast: 20, slow: 60 }];
function wantsEth(data: Candle[], i: number, fast: number, slow: number): boolean {
  if (i < slow - 1) return false;
  const avg = (n: number) => data.slice(i - n + 1, i + 1).reduce((sum, b) => sum + b.close, 0) / n;
  return avg(fast) > avg(slow);
}

/** Signals use previous closed bars; simulated orders fill at the NEXT open, never that close. */
export function backtest(data: Candle[], start: number, end: number, fast: number, slow: number, capital: number, p: TradingPolicy) {
  if (!Number.isFinite(capital) || capital <= 0) throw new Error("Positive virtual capital required");
  const friction = (p.studyFeeBps + p.studySlippageBps) / 10000;
  let cash = capital, eth = 0, peak = capital, drawdown = 0, trades = 0, fees = 0;
  const curve: Array<{ time: number; equity: number }> = [];
  for (let i = start; i < end; i++) {
    const bar = data[i], buy = wantsEth(data, i - 1, fast, slow);
    if (buy && eth === 0 && cash > 2 * p.studyGasQuote) {
      const spend = cash * p.allocationBps / 10000;
      if (spend > p.studyGasQuote) {
        eth = (spend - p.studyGasQuote) / (bar.open * (1 + friction));
        cash -= spend; fees += p.studyGasQuote + eth * bar.open * friction; trades++;
      }
    } else if (!buy && eth > 0) {
      const gross = eth * bar.open;
      const cost = gross * friction + p.studyGasQuote;
      cash += Math.max(0, gross - cost); fees += Math.min(gross, cost); eth = 0; trades++;
    }
    const equity = cash + eth * bar.close;
    peak = Math.max(peak, equity); drawdown = Math.max(drawdown, (peak - equity) / peak);
    curve.push({ time: bar.time, equity });
  }
  if (eth) { const gross = eth * data[end - 1].close, cost = gross * friction + p.studyGasQuote; cash += Math.max(0, gross - cost); fees += Math.min(gross, cost); }
  drawdown = Math.max(drawdown, (peak - cash) / peak);
  const bought = Math.max(0, capital - p.studyGasQuote) / (data[start].open * (1 + friction));
  const benchmark = Math.max(0, bought * data[end - 1].close * (1 - friction) - p.studyGasQuote);
  return { netReturnPct: (cash / capital - 1) * 100, benchmarkReturnPct: (benchmark / capital - 1) * 100,
    maxDrawdownPct: drawdown * 100, trades, feesQuote: fees, finalQuote: cash, curve };
}

export function selectStrategy(data: Candle[], capital: number, p: TradingPolicy): StudyResult {
  if (data.length < 180) throw new Error("Insufficient history for train/holdout study");
  const split = Math.floor(data.length * 0.6);
  // Select only on training data. Holdout is NEVER used to pick a different candidate.
  const trainingStart = Math.max(...CANDIDATES.map(c => c.slow));
  const scores = CANDIDATES.map(c => ({ ...c, train: backtest(data, trainingStart, split, c.fast, c.slow, capital, p) }));
  scores.sort((a, b) => (b.train.netReturnPct - b.train.maxDrawdownPct) - (a.train.netReturnPct - a.train.maxDrawdownPct));
  const chosen = scores[0], test = backtest(data, split, data.length, chosen.fast, chosen.slow, capital, p);
  const eligible = test.netReturnPct > 0 && test.netReturnPct >= test.benchmarkReturnPct && test.trades >= p.minOutOfSampleTrades;
  return { strategy: `sma-${chosen.fast}-${chosen.slow}`, fast: chosen.fast, slow: chosen.slow, trainingEnd: data[split].time,
    outOfSample: { netReturnPct: test.netReturnPct, benchmarkReturnPct: test.benchmarkReturnPct, maxDrawdownPct: test.maxDrawdownPct, trades: test.trades, feesQuote: test.feesQuote },
    target: wantsEth(data, data.length - 1, chosen.fast, chosen.slow) ? "ETH" : "USDC", eligible,
    reason: eligible ? "Positive holdout estimate after costs, at least benchmark and sufficient simulated fills" : "No demonstrated holdout advantage after modeled costs; keep the current position",
    dataStart: data[0].time, dataEnd: data.at(-1)!.time,
    dataHash: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
    warning: "Historical rolling study, not a probability of future profit. Costs/slippage are estimates. If Coinbase consolidates USDC books, USD history is valued at current independently checked USDC/USD (not historical FX). Repeated reselection can overfit; prospective paper/live results remain separate.",
  };
}
