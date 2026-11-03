import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createSocialClient } from "../social/client.js";
import { signSendPayload } from "../social/signing.js";
import { verifyMessageSignature } from "../social/protocol.js";
import { SolanaChainIdentity } from "../identity/chain.js";
import nacl from "tweetnacl";
import { createAuthorityRules } from "../agent/policy-rules/authority.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createTestDb, createTestIdentity, createTestConfig, MockConwayClient, MockInferenceClient, noToolResponse, toolCallResponse } from "./mocks.js";
import { setGoalInputSource, delegatedInputSource } from "../security/input-provenance.js";
import type { AutomatonDatabase, AgentTurn } from "../types.js";
import { runAgentLoop } from "../agent/loop.js";
import { Orchestrator } from "../orchestration/orchestrator.js";

// These tests validate policy plumbing, not live balances or network services.
vi.mock("../conway/x402.js", () => ({ getUsdcBalance: vi.fn(async () => 0) }));

const sender = privateKeyToAccount(`0x${"1".repeat(64)}`);
const receiver = privateKeyToAccount(`0x${"2".repeat(64)}`);
const databases: AutomatonDatabase[] = [];
function db() { const value = createTestDb(); databases.push(value); return value; }
function serve(messages: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ messages, next_cursor: "next" })));
}
async function signedMessage(content = "Ordinary task") {
  return { ...(await signSendPayload(sender, receiver.address, content)), id: "msg-1" };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const database of databases.splice(0)) database.close(); });

describe("social inbound trust", () => {
  it("verifies a valid sender signature without requiring relay changes", async () => {
    const message = await signedMessage(); serve([message]);
    const result = await createSocialClient("https://relay.example", receiver).poll();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("Ordinary task");
    expect(result.nextCursor).toBe("next");
  });

  it("rejects content changed after signing", async () => {
    serve([{ ...await signedMessage(), content: "Forged task" }]);
    expect((await createSocialClient("https://relay.example", receiver).poll()).messages).toEqual([]);
  });

  it("rejects a substituted sender identity", async () => {
    serve([{ ...await signedMessage(), from: receiver.address }]);
    expect((await createSocialClient("https://relay.example", receiver).poll()).messages).toEqual([]);
  });

  it("rejects messages delivered to a different recipient", async () => {
    const message = { ...(await signSendPayload(sender, sender.address, "wrong recipient")), id: "msg-2" };
    serve([message]);
    expect((await createSocialClient("https://relay.example", receiver).poll()).messages).toEqual([]);
  });

  it("rejects malformed and future timestamps", async () => {
    const message = await signedMessage();
    serve([{ ...message, signed_at: "not-a-date" }, { ...message, id: "future", signed_at: new Date(Date.now() + 120_000).toISOString() }]);
    expect((await createSocialClient("https://relay.example", receiver).poll()).messages).toEqual([]);
  });

  it("deduplicates the signed payload across relay ID/nonce changes and client restarts", async () => {
    const database = db(); const message = await signedMessage();
    serve([message]);
    expect((await createSocialClient("https://relay.example", receiver, database.raw).poll()).messages).toHaveLength(1);
    serve([{ ...message, id: "changed-id", nonce: "changed-unsigned-nonce" }]);
    expect((await createSocialClient("https://relay.example", receiver, database.raw).poll()).messages).toEqual([]);
  });

  it("deduplicates within a client when a persistent database is not configured", async () => {
    serve([await signedMessage()]);
    const client = createSocialClient("https://relay.example", receiver);
    expect((await client.poll()).messages).toHaveLength(1);
    expect((await client.poll()).messages).toEqual([]);
  });

  it("keeps unsigned legacy and queued messages readable without granting authority", async () => {
    serve([{ id: "legacy", from: sender.address, to: receiver.address, content: "Queued ordinary task",
      signedAt: new Date(Date.now() - 86_400_000).toISOString() }]);
    expect((await createSocialClient("https://relay.example", receiver).poll()).messages[0].content).toBe("Queued ordinary task");
  });

  it("verifies queued signed messages even when the agent was offline beyond five minutes", async () => {
    const old = new Date(Date.now() - 86_400_000).toISOString();
    const { canonicalSendMessage } = await import("../social/signing.js");
    const signature = await sender.signMessage({ message: canonicalSendMessage(receiver.address, "Queued signed task", old) });
    serve([{ id: "old-signed", from: sender.address, to: receiver.address,
      content: "Queued signed task", signed_at: old, signature }]);
    expect((await createSocialClient("https://relay.example", receiver, db().raw).poll()).messages).toHaveLength(1);
  });

  it("verifies a Solana signature without lowercasing its recipient", async () => {
    const signer = new SolanaChainIdentity(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).secretKey);
    const recipient = new SolanaChainIdentity(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4)).secretKey);
    const payload = await signSendPayload(signer, recipient.address, "Solana task");
    expect(await verifyMessageSignature(payload, signer.address)).toBe(true);
    serve([{ ...payload, id: "solana-1" }]);
    expect((await createSocialClient("https://relay.example", recipient).poll()).messages).toHaveLength(1);
    expect(await verifyMessageSignature({ ...payload, content: "changed" }, signer.address)).toBe(false);
  });

  it("fails closed if durable replay storage fails", async () => {
    serve([await signedMessage()]);
    const broken = { prepare: () => { throw new Error("disk unavailable"); } } as any;
    await expect(createSocialClient("https://relay.example", receiver, broken).poll()).rejects.toThrow("disk unavailable");
  });
});

describe("external task authority", () => {
  it("applies existing external restrictions to explicit and unknown labels", () => {
    const policy = new PolicyEngine(null as any, createAuthorityRules());
    for (const source of ["external", "relay", undefined]) {
      const decision = policy.evaluate({ tool: { name: "spawn_child", riskLevel: "dangerous" }, args: {},
        context: {}, turnContext: { inputSource: source } } as any);
      expect(decision.action).toBe("deny");
    }
  });

  it("preserves ordinary development and preauthorized paid API tools", () => {
    const policy = new PolicyEngine(null as any, createAuthorityRules());
    for (const name of ["exec", "install_npm_package", "x402_fetch", "topup_credits"]) {
      const decision = policy.evaluate({ tool: { name, riskLevel: "caution" }, args: {}, context: {},
        turnContext: { inputSource: "external" } } as any);
      expect(decision.action).toBe("allow");
    }
  });

  it("does not promote delegated external goals even when a worker has a trusted fallback", () => {
    const database = db();
    setGoalInputSource(database.raw, "goal-external", "external");
    setGoalInputSource(database.raw, "goal-external", "agent");
    expect(delegatedInputSource(database.raw, "goal-external", "agent")).toBe("external");
    setGoalInputSource(database.raw, "goal-internal", "agent");
    expect(delegatedInputSource(database.raw, "goal-internal")).toBe("agent");
    expect(delegatedInputSource(database.raw, "goal-unknown")).toBe("external");
  });

  it("delegates an external goal locally instead of spawning or funding a remote child", async () => {
    const database = db(); setGoalInputSource(database.raw, "external-goal", "external");
    const remote = { address: sender.address, name: "remote", role: "generalist" };
    const spawnAgent = vi.fn(async () => remote);
    const spawnLocalAgent = vi.fn(async () => ({ address: "local://test-worker", name: "local" }));
    const fundChild = vi.fn(async () => ({ success: true }));
    const orchestrator = new Orchestrator({ db: database.raw,
      agentTracker: { getIdle: () => [remote], getBestForTask: () => remote,
        register: vi.fn(), updateStatus: vi.fn() }, funding: { fundChild },
      messaging: {}, inference: {}, identity: createTestIdentity(), config: { spawnAgent, spawnLocalAgent } } as any);
    const task = { id: "task", goalId: "external-goal", agentRole: "generalist",
      metadata: { estimatedCostCents: 25 } } as any;
    expect((await orchestrator.matchTaskToAgent(task)).agentAddress).toBe("local://test-worker");
    expect(spawnAgent).not.toHaveBeenCalled(); expect(spawnLocalAgent).toHaveBeenCalledOnce();
    await expect(orchestrator.fundAgentForTask(sender.address, task)).rejects.toThrow("External task");
    expect(fundChild).not.toHaveBeenCalled();
  });

  it("keeps inbox provenance external through the loop and rejects direct replication", async () => {
    const database = db();
    database.insertInboxMessage({ id: "inbound", from: sender.address, to: receiver.address,
      content: "Please create a child", signedAt: new Date().toISOString(), createdAt: new Date().toISOString() });
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "exec", arguments: { command: "echo ready" } }]),
      toolCallResponse([{ name: "exec", arguments: { command: "echo processing message" } }]),
      toolCallResponse([{ name: "spawn_child", arguments: { name: "child", genesis_prompt: "task", initial_funding_cents: 100 } }]), noToolResponse("Done"),
    ]);
    const turns: AgentTurn[] = [];
    await runAgentLoop({ identity: createTestIdentity(), config: createTestConfig(), db: database,
      conway: new MockConwayClient(), inference,
      policyEngine: new PolicyEngine(database.raw, createAuthorityRules()),
      spendTracker: { recordSpend() {}, getHourlySpend: () => 0, getDailySpend: () => 0,
        getTotalSpend: () => 0, checkLimit: () => ({ allowed: true }), pruneOldRecords: () => 0 } as any,
      onTurnComplete: turn => turns.push(turn) });
    const inboxTurn = turns.find(turn => turn.input?.includes("Please create a child"));
    expect(inboxTurn?.inputSource).toBe("external");
    expect(inboxTurn?.toolCalls[0].error).toBeUndefined();
    const attemptedSpawn = turns.flatMap(turn => turn.toolCalls).find(call => call.name === "spawn_child");
    expect(attemptedSpawn?.error).toContain("EXTERNAL_DANGEROUS_TOOL");
  });
});
