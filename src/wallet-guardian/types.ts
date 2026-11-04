/** Public decision summaries and verifiable provenance, never private chain-of-thought. */
export interface Qqoqccp {
  qui: string;
  quoi: string;
  ou: string;
  quand: string;
  comment: string;
  combien: { maxAmountAtomic: string };
  pourquoi: string;
  sourceEventId: string;
  parentDecisionId?: string;
  goalId?: string;
  stepId?: string;
  economics?: {
    expectedRevenueAtomic: string;
    estimatedPlanCostAtomic: string;
    evidenceIds: string[];
    uncertainties: string;
    freeAlternative: string;
  };
}

export interface ApprovedGoal {
  id: string;
  objective: string;
  expiresAt: number;
  maxTotalCents: number;
  steps: Array<{
    id: string;
    description: string;
    maxTotalCents: number;
    allowedHosts: string[] | "public";
    allowedRecipients?: string[];
    evidence: Array<{ id: string; summary: string }>;
  }>;
}

export interface GuardianPolicy {
  walletAddress: string;
  ownerAddress: string;
  maxSinglePaymentCents: number;
  hourlyPaymentCents: number;
  dailyPaymentCents: number;
  minimumUsdcReserveCents?: number;
  /** EUR uses an expiring valuation from the operator's fixed source. Never equate EUR and USDC. */
  dailyCurrency: "EUR" | "USDC";
  /** Fixed trusted source chosen by the operator, never by an agent request. */
  eurValuation?: "coingecko" | "manual";
  eurQuote?: { eurPerUsdcMicros: string; validUntil: number; source: string };
  maxWithdrawalGasWei: string;
  allowedWithdrawalNetworks: Array<"eip155:1" | "eip155:8453">;
}

export interface ServiceRequest {
  operationId: string;
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  maxPaymentCents: number;
  minimumUsdcReserveCents?: number;
  review?: Qqoqccp;
  allowedRecipients?: string[];
}

export interface WithdrawalRequest {
  operationId: string;
  recipient: string;
  network: "eip155:1" | "eip155:8453";
  asset: "ETH" | "USDC";
  amountAtomic: string;
  maxGasFeeAtomic: string;
  review: Qqoqccp;
}

export interface GuardianConfig extends GuardianPolicy {
  walletFile: string;
  tokenFile: string;
  databaseFile: string;
  port: number;
  ethereumRpc: string;
  baseRpc: string;
}

export class GuardianDenied extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
