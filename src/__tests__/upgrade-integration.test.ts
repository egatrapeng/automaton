import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConwayClient } from "../conway/client.js";
import { runAgentLoop } from "../agent/loop.js";
import { createBuiltinTools, executeTool } from "../agent/tools.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { registerSecret } from "../security/redaction.js";
import { writeToolFile } from "../security/files.js";
import { createTestDb, createTestConfig, createTestIdentity, MockConwayClient, MockInferenceClient, toolCallResponse } from "./mocks.js";

vi.mock("../conway/x402.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../conway/x402.js")>(),
  getUsdcBalance: vi.fn(async () => 20),
}));

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-upgrade-")); roots.push(root); return root; }

describe("operational upgrade", () => {
  it("does not overwrite runtime protection code through an ordinary symlink alias", () => {
    const root = temporary();
    const guarded = path.join(root, "agent", "policy-engine.ts");
    fs.mkdirSync(path.dirname(guarded));
    fs.writeFileSync(guarded, "FAKE_GUARD_CONTENT");
    const alias = path.join(root, "ordinary.txt");
    fs.symlinkSync(guarded, alias);
    expect(() => writeToolFile(alias, "CHANGED", [root])).toThrow(/Blocked/);
    expect(fs.readFileSync(guarded, "utf8")).toBe("FAKE_GUARD_CONTENT");
  });
  it("executes a real host task, persists the result, keeps fake credentials out of subsequent context and exits on sleep", async () => {
    const root = temporary();
    const secret = "FAKE_INTEGRATION_CREDENTIAL_00000001";
    registerSecret(secret);
    const config = createTestConfig({ execution: { mode: "host", workingDirectory: root }, dbPath: path.join(root, "state.db"), sandboxId: "" });
    const identity = { ...createTestIdentity(), sandboxId: "" };
    const host = createConwayClient({ apiUrl: "https://unused.invalid", apiKey: "FAKE", sandboxId: "", execution: config.execution });
    const conway = new MockConwayClient();
    conway.exec = host.exec; conway.readFile = host.readFile; conway.writeFile = host.writeFile;
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "exec", arguments: { command: `printf '${secret}'; printf READY > artifact.txt` } }]),
      toolCallResponse([{ name: "sleep", arguments: { duration_seconds: 1, reason: "task finished" } }]),
    ]);
    const db = createTestDb();
    try {
      await runAgentLoop({ identity, config, conway, inference, db });
      expect(fs.readFileSync(path.join(root, "artifact.txt"), "utf8")).toBe("READY");
      expect(db.getAgentState()).toBe("sleeping");
      const turns = db.getRecentTurns(10);
      expect(turns.some((turn) => turn.toolCalls.some((call) => call.name === "exec" && call.result.includes("[REDACTED]")))).toBe(true);
      expect(JSON.stringify(turns)).not.toContain(secret);
      expect(JSON.stringify(inference.calls)).not.toContain(secret);
    } finally { db.close(); }
  });

  it("signs only the selected topup, reports real spend and refuses duplicate purchase intent", async () => {
    const root = temporary();
    const config = createTestConfig({ dbPath: path.join(root, "state.db"), conwayApiUrl: "https://payment.example" });
    const identity = createTestIdentity();
    const sign = vi.fn(async () => "0xFAKE_NOT_A_VALID_SIGNATURE");
    identity.account = { ...identity.account, address: identity.address as `0x${string}`, signTypedData: sign };
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "5000000", payTo: "0x1111111111111111111111111111111111111111", maxTimeoutSeconds: 120 }] }, { status: 402 }))
      .mockResolvedValueOnce(Response.json({ credits_cents: 500 }));
    const recordSpend = vi.fn();
    const tracker = { recordSpend, getHourlySpend: () => 0, getDailySpend: () => 0 } as any;
    const db = createTestDb();
    try {
      const context = { identity, config, db, conway: new MockConwayClient(), inference: new MockInferenceClient() };
      const policy = new PolicyEngine(db.raw, createDefaultRules());
      const tools = createBuiltinTools(identity.sandboxId);
      const turn = { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: tracker };
      const result = await executeTool("topup_credits", { amount_usd: 5, operation_id: "integration-purchase-1" }, tools, context, policy, turn);
      expect(result.error).toBeUndefined();
      expect(result.result).toContain("accepted");
      expect(sign).toHaveBeenCalledOnce();
      expect((sign.mock.calls[0] as any)[0].message.value).toBe(5_000_000n);
      expect(recordSpend).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 500, category: "x402" }));
      const duplicate = await executeTool("topup_credits", { amount_usd: 5, operation_id: "integration-purchase-1" }, tools, context, policy, turn);
      expect(duplicate.result).toMatch(/already|reconcile/i);
      expect(sign).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { db.close(); }
  });
});
