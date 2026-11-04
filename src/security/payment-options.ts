import path from "node:path";
import type { AutomatonConfig } from "../types.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import { resolvePath } from "../config.js";
import type { PaymentSecurityOptions } from "../conway/x402.js";

/** Translate operator configuration without confusing Conway credit reserves with USDC. */
export function paymentOptionsFor(config: AutomatonConfig, balanceAtomic?: bigint): PaymentSecurityOptions {
  const policy = config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY;
  return {
    beforeSign: config.walletGuardian ? () => { throw new Error("Local crypto signing disabled in guardian mode; use the independent guardian with QQOQCCP authorization"); } : undefined,
    ledgerPath: path.join(path.dirname(resolvePath(config.dbPath)), "payment-ledger.db"),
    allowedRecipients: policy.x402AllowedRecipients,
    budget: {
      maxHourlyCents: policy.maxX402HourlyCents ?? 10_000,
      maxDailyCents: policy.maxX402DailyCents ?? 25_000,
      maxDestinationDailyCents: policy.maxX402DestinationDailyCents,
      minimumReserveCents: policy.minimumUsdcReserveCents ?? 0,
      balanceAtomic,
    },
  };
}
