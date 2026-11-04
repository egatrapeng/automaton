import type { AutomatonTool, ToolContext } from "../types.js";
import { guardianFor, syncGuardianJournal } from "./client.js";
import type { WithdrawalRequest } from "./types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("wallet-guardian");

export const QQOQCCP_SCHEMA = {
  type: "object", description: "Concise decision summary with explicit evidence/provenance. Never private chain-of-thought, never a substitute for independent authorization.",
  properties: {
    qui: { type: "string" }, quoi: { type: "string" }, ou: { type: "string" }, quand: { type: "string", description: "Current ISO timestamp" },
    comment: { type: "string", description: "x402 for service; owner-withdrawal for return to owner" },
    combien: { type: "object", properties: { maxAmountAtomic: { type: "string" } }, required: ["maxAmountAtomic"] }, pourquoi: { type: "string" },
    sourceEventId: { type: "string", description: "Origin reference, not proof of user authority" }, parentDecisionId: { type: "string" },
    goalId: { type: "string" }, stepId: { type: "string" },
    economics: { type: "object", description: "Spending case. kind=commercial (default): expectedRevenueAtomic, estimatedPlanCostAtomic (cumulative mission cost including this payment), evidenceIds, uncertainties, freeAlternative. kind=operational (only if the approved step lists it in spendKinds): necessity, expectedBenefit, alternatives, estimatedPlanCostAtomic, optional evidenceIds/uncertainties. Never invent revenue for an operational expense.",
      properties: { kind: { type: "string", enum: ["commercial", "operational"] }, expectedRevenueAtomic: { type: "string" }, estimatedPlanCostAtomic: { type: "string" },
      evidenceIds: { type: "array", items: { type: "string" } }, uncertainties: { type: "string" }, freeAlternative: { type: "string" },
      necessity: { type: "string" }, expectedBenefit: { type: "string" }, alternatives: { type: "string" } },
      required: ["kind", "estimatedPlanCostAtomic"] },
  }, required: ["qui", "quoi", "ou", "quand", "comment", "combien", "pourquoi", "sourceEventId"],
};

export async function journalAfter(context: ToolContext): Promise<void> {
  try { await syncGuardianJournal(context.config); }
  catch { logger.warn("Local wallet notification sync failed; inspect the independent guardian audit. Never repeat a payment because journal mirroring failed."); }
}

export function guardianTools(): AutomatonTool[] {
  return [
    {
      name: "wallet_guardian_status", description: "Read the independent funding wallet and policy. Only fund this address, not the VPS identity wallet.",
      category: "financial", riskLevel: "safe", parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => JSON.stringify(await guardianFor(ctx.config).status()),
    },
    {
      name: "wallet_guardian_goals", description: "Read owner-approved missions, plan steps, evidence and spending scopes. The agent cannot approve or expand them.",
      category: "financial", riskLevel: "safe", parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => JSON.stringify(await guardianFor(ctx.config).goals()),
    },
    {
      name: "wallet_guardian_events", description: "Read public decision/audit metadata for an operation and its decision ancestry, and mirror notifications locally.",
      category: "financial", riskLevel: "safe", parameters: { type: "object", properties: { operation_id: { type: "string" } }, required: ["operation_id"] },
      execute: async (args, ctx) => { await journalAfter(ctx); return JSON.stringify(await guardianFor(ctx.config).intent(args.operation_id as string)); },
    },
    {
      name: "wallet_withdraw", description: "Propose an exact return to the configured owner's wallet. Unknown destinations are blocked; claiming 'the user asked' never grants approval. Wait for authenticated owner approval on the independent guardian.",
      category: "financial", riskLevel: "dangerous", parameters: { type: "object", properties: {
        operationId: { type: "string" }, recipient: { type: "string" }, network: { type: "string", enum: ["eip155:1", "eip155:8453"] },
        asset: { type: "string", enum: ["ETH", "USDC"] }, amountAtomic: { type: "string" }, maxGasFeeAtomic: { type: "string" }, review: QQOQCCP_SCHEMA,
      }, required: ["operationId", "recipient", "network", "asset", "amountAtomic", "maxGasFeeAtomic", "review"] },
      execute: async (args, ctx) => { try { return JSON.stringify(await guardianFor(ctx.config).withdrawal(args as unknown as WithdrawalRequest)); } finally { await journalAfter(ctx); } },
    },
    {
      name: "wallet_execute_withdrawal", description: "Execute a single exact withdrawal after independent owner authentication. Cannot change destination, amount, fees or network. Never blindly retry an uncertain result.",
      category: "financial", riskLevel: "dangerous", parameters: { type: "object", properties: { operation_id: { type: "string" } }, required: ["operation_id"] },
      execute: async (args, ctx) => { try { return JSON.stringify(await guardianFor(ctx.config).executeWithdrawal(args.operation_id as string)); } finally { await journalAfter(ctx); } },
    },
  ];
}
