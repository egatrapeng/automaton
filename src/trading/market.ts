import { ResilientHttpClient } from "../conway/http-client.js";
import type { Candle } from "./types.js";

export const CANDLE_SECONDS = 300;
const http = new ResilientHttpClient();
let useUsdFallback = false;

/** Public Coinbase Exchange ETH/USDC candles, not an account or custody integration. */
export async function fetchCandles(now = Date.now()): Promise<Candle[]> {
  const end = Math.floor(now / 1000 / CANDLE_SECONDS) * CANDLE_SECONDS;
  const suffix = `?granularity=${CANDLE_SECONDS}&start=${new Date((end - 300 * CANDLE_SECONDS) * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`;
  let response = await http.request(`https://api.exchange.coinbase.com/products/${useUsdFallback ? "ETH-USD" : "ETH-USDC"}/candles${suffix}`, { method: "GET", retries: 0, timeout: 15000,
    networkPolicy: "public", redirectPolicy: "none", maxResponseBytes: 256 * 1024 });
  if (!useUsdFallback && [400, 404].includes(response.status)) {
    useUsdFallback = true;
    response = await http.request(`https://api.exchange.coinbase.com/products/ETH-USD/candles${suffix}`, { method: "GET", retries: 0, timeout: 15000,
      networkPolicy: "public", redirectPolicy: "none", maxResponseBytes: 256 * 1024 });
  }
  if (!response.ok) throw new Error(`Coinbase market data unavailable (${response.status}); not a zero price`);
  const raw = await response.json();
  if (!useUsdFallback && Array.isArray(raw) && raw.length < 180) { useUsdFallback = true; return fetchCandles(now); }
  if (useUsdFallback) {
    // Coinbase may consolidate USDC books into USD. Do not silently equate the currencies.
    const key = "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const fx = await http.request(`https://coins.llama.fi/prices/current/${key}`, { method: "GET", retries: 0, timeout: 15000,
      networkPolicy: "public", redirectPolicy: "none", maxResponseBytes: 32768 });
    if (!fx.ok) throw new Error("USDC/USD conversion source unavailable");
    const value = (await fx.json())?.coins?.[key];
    if (!value || typeof value.price !== "number" || value.price < 0.98 || value.price > 1.02 || typeof value.timestamp !== "number" || Math.abs(now - value.timestamp * 1000) > 15 * 60000) throw new Error("Unknown/stale/depegged USDC/USD valuation");
    if (!Array.isArray(raw)) throw new Error("Invalid Coinbase candles");
    // Historical USD candles are valued at current USDC/USD; this assumption is disclosed in the study.
    return normalizeCandles(raw.map(row => Array.isArray(row) ? row.map((v, i) => i >= 1 && i <= 4 && typeof v === "number" ? v / value.price : v) : row), now);
  }
  return normalizeCandles(raw, now);
}

export function normalizeCandles(raw: unknown, now = Date.now()): Candle[] {
  if (!Array.isArray(raw) || raw.length > 400) throw new Error("Invalid candle response");
  const seen = new Map<number, Candle>();
  for (const row of raw) {
    if (!Array.isArray(row) || row.length !== 6 || row.some(n => typeof n !== "number" || !Number.isFinite(n))) throw new Error("Invalid candle numbers");
    const [time, low, high, open, close, volume] = row;
    if (!Number.isSafeInteger(time) || time % CANDLE_SECONDS || time < 1 || low <= 0 || high < low || open < low || open > high || close < low || close > high || volume < 0) throw new Error("Invalid OHLCV candle");
    if ((time + CANDLE_SECONDS) * 1000 > now) continue; // Never use an unfinished candle.
    if (seen.has(time)) throw new Error("Duplicate candle timestamp");
    seen.set(time, { time, low, high, open, close, volume });
  }
  const candles = [...seen.values()].sort((a, b) => a.time - b.time);
  if (candles.length < 180) throw new Error("Insufficient market history; at least 180 closed candles required");
  for (let i = 1; i < candles.length; i++) if (candles[i].time - candles[i - 1].time !== CANDLE_SECONDS) throw new Error("Gapped market data; do not invent missing prices");
  if (now - (candles.at(-1)!.time + CANDLE_SECONDS) * 1000 > 15 * 60000) throw new Error("Stale market data");
  return candles;
}

/** Research only. A DexScreener response is neither an executable quote nor a scam certificate. */
export async function fetchTokenResearch(address: string): Promise<unknown> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) throw new Error("Expected non-zero Base token address");
  const response = await http.request(`https://api.dexscreener.com/token-pairs/v1/base/${address}`, {
    method: "GET", retries: 0, timeout: 15000, networkPolicy: "public", redirectPolicy: "none", maxResponseBytes: 512 * 1024,
  });
  if (!response.ok) throw new Error(`Token research unavailable (${response.status})`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Invalid token research");
  let security: unknown = { available: false, source: "GoPlus", reason: "Source unavailable; no safe verdict" };
  try {
    const scan = await http.request(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address}`, { method: "GET", retries: 0,
      timeout: 10000, networkPolicy: "public", redirectPolicy: "none", maxResponseBytes: 256 * 1024 });
    const record = scan.ok ? (await scan.json())?.result?.[address.toLowerCase()] : undefined;
    if (record && typeof record === "object") {
      const flag = (key: string) => record[key] === "1" ? true : record[key] === "0" ? false : null;
      const percent = (v: unknown) => { const n = (typeof v === "string" && v.trim() !== "") || typeof v === "number" ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 && n <= 1 ? n * 100 : null; };
      const seen = new Set<string>();
      const holders = (Array.isArray(record.holders) ? record.holders : []).slice(0, 30).filter((h: any) => {
        const a = String(h.address).toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a) || seen.has(a)) return false; seen.add(a); return true;
      }).map((h: any) => ({ address: h.address, percent: percent(h.percent), isContract: h.is_contract === 1 || h.is_contract === "1" }));
      const top = holders.slice(0, 10);
      security = { available: true, source: "GoPlus reported scan, not independently certified", observedAt: Date.now(),
        reportedHoneypot: flag("is_honeypot"), mintable: flag("is_mintable"), blacklist: flag("is_blacklisted"), proxy: flag("is_proxy"),
        ownerAddress: /^0x[0-9a-f]{40}$/i.test(record.owner_address ?? "") ? record.owner_address : null,
        buyTaxPct: percent(record.buy_tax), sellTaxPct: percent(record.sell_tax), holders,
        topListedHolderConcentrationPct: top.length && top.every((h: any) => h.percent !== null) ? Math.min(100, top.reduce((n: number, h: any) => n + h.percent, 0)) : null,
        caveat: "Listed holder addresses can be pools, vaults or burn addresses; not beneficial ownership. No actual sale was tested. Unknown fields remain unknown." };
    }
  } catch { /* Preserve explicit unknowns when the research provider is unavailable. */ }
  return { chain: "base", token: address, fetchedAt: Date.now(), pairs: rows.slice(0, 20).map((p: any) => ({
    pairAddress: p.pairAddress, dexId: p.dexId, baseToken: p.baseToken, quoteToken: p.quoteToken,
    priceUsd: p.priceUsd, liquidity: p.liquidity, volume: p.volume, txns: p.txns, pairCreatedAt: p.pairCreatedAt,
  })), security, risks: { sellability: "unknown unless an actual order is simulated", adminPowers: "reported flags require contract analysis", scamVerdict: "not established" } };
}
