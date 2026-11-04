import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestConfig, createTestIdentity, createTestDb } from "./mocks.js";
import { validateStandalone } from "../security/standalone.js";
import { createConwayClient } from "../conway/client.js";
import { createInferenceClient } from "../conway/inference.js";
import { runAgentLoop } from "../agent/loop.js";
import { buildTickContext } from "../heartbeat/tick-context.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { SpendTracker } from "../agent/spend-tracker.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function configuration() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-claude-")); dirs.push(root);
  return createTestConfig({ runtimeMode: "standalone", sandboxId: "", conwayApiKey: "",
    anthropicApiKey: "sk-ant-FAKE_TEST_CREDENTIAL_000000", inferenceModel: "claude-sonnet-4-6",
    maxTokensPerTurn: 2048, execution: { mode: "host", workingDirectory: root }, dbPath: path.join(root, "state.db") });
}

describe("Claude without Conway", () => {
  it("requires explicit host mode, Claude model and local Anthropic credential", () => {
    const config = configuration(); expect(() => validateStandalone(config)).not.toThrow();
    expect(() => validateStandalone({ ...config, anthropicApiKey: "" })).toThrow(/key/);
    expect(() => validateStandalone({ ...config, inferenceModel: "gpt-5.2" })).toThrow(/Claude/);
    expect(() => validateStandalone({ ...config, execution: { mode: "remote" } })).toThrow(/host/);
  });

  it("refuses Conway operations before making any network request", async () => {
    const config = configuration();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    const client = createConwayClient({ apiUrl: "https://api.conway.tech", apiKey: "", sandboxId: "", execution: config.execution, standalone: true });
    await expect(client.getCreditsBalance()).rejects.toThrow(/requires a Conway account/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("builds a local heartbeat context without balances or RPC calls", async () => {
    const config = configuration(); const db = createTestDb();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    const credits = vi.fn(async () => { throw new Error("Unexpected Conway call"); });
    try {
      const ctx = await buildTickContext(db.raw, { getCreditsBalance: credits } as any, {} as any, createTestIdentity().address, "evm", true);
      expect(ctx.creditBalance).toBe(0); expect(ctx.survivalTier).toBe("normal");
      expect(credits).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("uses only Anthropic, preserves native tool results, executes locally and sleeps with no Conway funds", async () => {
    const config = configuration(); const db = createTestDb();
    const identity = { ...createTestIdentity(), sandboxId: "", apiKey: "" };
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ id: "test-1", model: config.inferenceModel,
        content: [{ type: "tool_use", id: "task-1", name: "exec", input: { command: "printf READY > claude-artifact.txt" } }],
        usage: { input_tokens: 20, output_tokens: 20 }, stop_reason: "tool_use" }))
      .mockResolvedValueOnce(Response.json({ id: "test-2", model: config.inferenceModel,
        content: [{ type: "tool_use", id: "task-2", name: "sleep", input: { duration_seconds: 1, reason: "done" } }],
        usage: { input_tokens: 20, output_tokens: 20 }, stop_reason: "tool_use" }));
    const conway = createConwayClient({ apiUrl: "https://api.conway.tech", apiKey: "", sandboxId: "", execution: config.execution, standalone: true });
    const inference = createInferenceClient({ apiUrl: config.conwayApiUrl, apiKey: "", defaultModel: config.inferenceModel,
      maxTokens: 2048, anthropicApiKey: config.anthropicApiKey });
    try {
      await runAgentLoop({ config, identity, db, conway, inference, policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw) });
      expect(fs.readFileSync(path.join(config.execution!.workingDirectory!, "claude-artifact.txt"), "utf8")).toBe("READY");
      expect(db.getAgentState()).toBe("sleeping"); expect(fetch).toHaveBeenCalledTimes(2);
      for (const [url, options] of fetch.mock.calls) {
        expect(url).toBe("https://api.anthropic.com/v1/messages");
        const body = JSON.parse(options!.body as string);
        expect(body.model).toBe(config.inferenceModel);
        expect(body.tools.some((t: any) => t.name === "topup_credits" || t.name === "create_sandbox")).toBe(false);
      }
      const second = JSON.parse(fetch.mock.calls[1][1]!.body as string);
      const blocks = second.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []);
      const call = blocks.find((b: any) => b.type === "tool_use" && b.name === "exec");
      expect(call).toBeDefined();
      expect(blocks.some((b: any) => b.type === "tool_result" && b.tool_use_id === call.id)).toBe(true);
    } finally { db.close(); }
  });

  it("does not make even a free-looking request when the daily inference budget is zero", async () => {
    const config = configuration(); config.treasuryPolicy = { ...DEFAULT_TREASURY_POLICY, maxInferenceDailyCents: 0 };
    const db = createTestDb(); const identity = { ...createTestIdentity(), sandboxId: "", apiKey: "" };
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected billable call"));
    const conway = createConwayClient({ apiUrl: config.conwayApiUrl, apiKey: "", sandboxId: "", execution: config.execution, standalone: true });
    const inference = createInferenceClient({ apiUrl: config.conwayApiUrl, apiKey: "", defaultModel: config.inferenceModel, maxTokens: 2048, anthropicApiKey: config.anthropicApiKey });
    try {
      await runAgentLoop({ config, identity, db, conway, inference });
      expect(fetch).not.toHaveBeenCalled();
      expect(db.getAgentState()).toBe("sleeping");
      expect(db.getTurnCount()).toBe(0);
      expect(db.getKV("sleep_reason")).toContain("next request estimate");
      const retry = new Date(db.getKV("sleep_until")!);
      expect(retry.getTime()).toBeGreaterThan(Date.now());
      expect(retry.getUTCHours()).toBe(0);
      expect(retry.getUTCMinutes()).toBe(0);
    }
    finally { db.close(); }
  });
});
