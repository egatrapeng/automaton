import { ResilientHttpClient } from "../conway/http-client.js";
import { GuardianDenied, type GuardianPolicy } from "./types.js";

const PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=eur&include_last_updated_at=true";
const SOURCE = "CoinGecko:usd-coin/eur";
const MAX_AGE_MS = 10 * 60_000;
const http = new ResilientHttpClient();

/** Read-only market data. The operator chooses this fixed source; agent input cannot replace it. */
export async function refreshEurValuation(policy: GuardianPolicy, now = Date.now()): Promise<void> {
  if (policy.dailyCurrency !== "EUR" || policy.eurValuation !== "coingecko") return;
  if (policy.eurQuote?.source === SOURCE && policy.eurQuote.validUntil > now + 30_000) return;
  try {
    const response = await http.request(PRICE_URL, { method: "GET", retries: 0, timeout: 10_000,
      redirectPolicy: "none", networkPolicy: "public", maxResponseBytes: 32 * 1024 });
    if (!response.ok) throw new Error("EUR source unavailable");
    const entry = (await response.json())?.["usd-coin"];
    const price = entry?.eur, updated = entry?.last_updated_at * 1000;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 1_000_000 ||
      typeof entry?.last_updated_at !== "number" || !Number.isSafeInteger(updated) || updated > now + 30_000 || updated <= now - MAX_AGE_MS) throw new Error("Invalid or stale EUR price");
    // Round the rate upwards, never silently treat EUR as USD or USDC.
    policy.eurQuote = { eurPerUsdcMicros: String(Math.ceil(price * 1_000_000)), validUntil: Math.min(now, updated) + MAX_AGE_MS, source: SOURCE };
  } catch {
    // Keep an earlier verified quote only until its original expiry; never extend it on error.
    if (policy.eurQuote?.source === SOURCE && policy.eurQuote.validUntil > Date.now()) return;
    throw new GuardianDenied("FX_UNAVAILABLE", "Fresh EUR valuation unavailable from the operator-selected source; no guessed rate or budget increase");
  }
}
