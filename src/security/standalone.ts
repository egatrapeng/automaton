import type { AutomatonConfig, AutomatonTool, ModelEntry } from "../types.js";

export function isStandalone(config: AutomatonConfig): boolean {
  return config.runtimeMode === "standalone";
}

export function validateStandalone(config: AutomatonConfig): void {
  if (!isStandalone(config)) return;
  if (config.execution?.mode !== "host" || config.sandboxId) throw new Error("Standalone mode requires explicit host execution and no Conway sandboxId");
  if (!config.anthropicApiKey?.trim()) throw new Error("Standalone mode requires an Anthropic API key in local configuration");
  if (!/^claude-[a-zA-Z0-9._-]+$/.test(config.inferenceModel)) throw new Error("Standalone mode requires an explicit Claude model ID; no Conway fallback is allowed");
}

export function standaloneModel(config: AutomatonConfig): ModelEntry {
  const now = new Date().toISOString();
  return {
    modelId: config.inferenceModel, provider: "anthropic", displayName: config.inferenceModel,
    // Conservative planning estimates, not a representation of the provider invoice.
    costPer1kInput: 100, costPer1kOutput: 500, maxTokens: config.maxTokensPerTurn,
    contextWindow: 200_000, supportsTools: true, supportsVision: false,
    tierMinimum: "normal", parameterStyle: "max_tokens", enabled: true,
    lastSeen: null, createdAt: now, updatedAt: now,
  };
}

const UNAVAILABLE = new Set([
  "check_credits", "topup_credits", "create_sandbox", "delete_sandbox", "list_sandboxes",
  "transfer_credits", "spawn_child", "fund_child", "start_child", "check_child_status",
  "send_message", "message_child", "search_domains", "register_domain", "manage_dns",
  "list_models", "switch_model", "distress_signal", "enter_low_compute",
]);

export function standaloneTools(tools: AutomatonTool[]): AutomatonTool[] {
  const descriptions: Record<string, string> = {
    create_goal: "Create a local work goal, then call plan_goal. Execute its tasks yourself with normal tools. No Conway planner or background workers are started; this grants no financial authority.",
    get_plan: "Read a persisted local goal, task states, dependencies and the next actionable task. Resume execution yourself; no background worker runs these tasks.",
    list_goals: "Read local goals and task completion counts. Orchestrator metadata is not active in standalone mode.",
    complete_task: "After executing and verifying a local task, record its result and artifact references. Prerequisites must be complete. This is a work record, not proof of revenue or permission to spend.",
  };
  return tools.filter(tool => !UNAVAILABLE.has(tool.name)).map(tool => descriptions[tool.name] ? { ...tool, description: descriptions[tool.name] } : tool);
}

const LOCAL_HEARTBEATS = new Set(["heartbeat_ping", "check_for_updates", "soul_reflection", "health_check", "knowledge_store_prune", "wallet_guardian_notifications"]);
export function standaloneHeartbeat(task: string): boolean { return LOCAL_HEARTBEATS.has(task); }
