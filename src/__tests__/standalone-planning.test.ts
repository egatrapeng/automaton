import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestConfig, createTestIdentity, createTestDb } from "./mocks.js";
import { createBuiltinTools } from "../agent/tools.js";
import { standaloneTools } from "../security/standalone.js";
import { createDatabase, getActiveGoals, getTasksByGoal } from "../state/database.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { generateTodoMd } from "../orchestration/attention.js";
import type { ToolContext } from "../types.js";

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); directories.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })); });
function context(db = createTestDb()): ToolContext {
  return { db, config: createTestConfig({ runtimeMode: "standalone", sandboxId: "", conwayApiKey: "", execution: { mode: "host" } }),
    identity: createTestIdentity(), inputSource: "creator", conway: {}, inference: {} } as ToolContext;
}
const tools = standaloneTools(createBuiltinTools(""));
const call = (name: string, args: Record<string, unknown>, ctx: ToolContext) => tools.find(t => t.name === name)!.execute(args, ctx);
async function goal(ctx: ToolContext): Promise<string> {
  await call("create_goal", { title: "Validate a monitoring service", description: "Compare three niches and test one useful offer with evidence" }, ctx);
  return getActiveGoals(ctx.db.raw)[0].id;
}
const tasks = () => [{ title: "Research", description: "Record three sourced customer problems and demand evidence" },
  { title: "Prototype", description: "Build and verify the smallest useful deliverable", dependencies: ["Research"] }];

describe("local planning without Conway", () => {
  it("exposes local planning but not paid sandbox provisioning or child funding", () => {
    const names = tools.map(t => t.name);
    for (const name of ["create_goal", "plan_goal", "get_plan", "complete_task"]) expect(names).toContain(name);
    for (const name of ["create_sandbox", "spawn_child", "fund_child", "topup_credits"]) expect(names).not.toContain(name);
    expect(tools.find(t => t.name === "create_goal")!.description).toContain("No Conway planner or background workers");
  });

  it("creates, plans, resumes and completes dependent tasks without inference or network calls", async () => {
    const ctx = context(); const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
    try {
      const id = await goal(ctx);
      const proposed = await call("plan_goal", { goal_id: id, tasks: tasks() }, ctx);
      expect(proposed).toContain("Guardian authorization remains separate");
      const rows = getTasksByGoal(ctx.db.raw, id), research = rows.find(t => t.title === "Research")!, prototype = rows.find(t => t.title === "Prototype")!;
      expect(await call("complete_task", { task_id: research.id, output: "" }, ctx)).toContain("non-empty");
      expect(JSON.parse(await call("get_plan", { goal_id: id }, ctx)).nextTask.description).toContain("customer problems");
      expect(await call("complete_task", { task_id: prototype.id, output: "Not done" }, ctx)).toContain("prerequisite");
      expect(await call("create_goal", { title: "A second project", description: "Wait" }, ctx)).toContain("Continue local goal");
      await call("complete_task", { task_id: research.id, output: "Three sourced observations; no revenue claimed", artifacts: "research.md" }, ctx);
      expect(JSON.parse(await call("get_plan", { goal_id: id }, ctx)).nextTask.id).toBe(prototype.id);
      expect(generateTodoMd(ctx.db.raw)).toContain("[x] Research");
      await call("complete_task", { task_id: prototype.id, output: "Prototype built and tested", artifacts: "prototype.ts" }, ctx);
      expect(getActiveGoals(ctx.db.raw)).toHaveLength(0);
      expect(network).not.toHaveBeenCalled();
      expect(ctx.db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='guardian_goals'").get()).toEqual({ n: 0 });
    } finally { ctx.db.close(); }
  });

  it("retains the next actionable task across a real SQLite reopen", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-plan-")); directories.push(root); const filename = path.join(root, "state.db");
    const first = context(createDatabase(filename)); const id = await goal(first);
    await call("plan_goal", { goal_id: id, tasks: tasks() }, first); first.db.close();
    const resumed = context(createDatabase(filename));
    try { expect(JSON.parse(await call("get_plan", { goal_id: id }, resumed)).nextTask.title).toBe("Research"); }
    finally { resumed.db.close(); }
  });

  it.each([
    [], Array.from({ length: 17 }, (_, i) => ({ title: String(i), description: "Task" })),
    [{ title: "A", description: "Task", dependencies: ["invented"] }],
    [{ title: "A", description: "Task" }, { title: "A", description: "Duplicate" }],
    [{ title: "A", description: "Task", estimatedCostCents: -1 }],
  ].map(tasks => ({ tasks })))("rejects an invalid plan atomically: %j", async ({ tasks: invalid }) => {
    const ctx = context();
    try { const id = await goal(ctx); await expect(call("plan_goal", { goal_id: id, tasks: invalid }, ctx)).rejects.toThrow(); expect(getTasksByGoal(ctx.db.raw, id)).toHaveLength(0); }
    finally { ctx.db.close(); }
  });

  it("does not overwrite a persisted plan or operate on an unknown goal", async () => {
    const ctx = context();
    try {
      await expect(call("plan_goal", { goal_id: "unknown", tasks: tasks() }, ctx)).rejects.toThrow("active local goal");
      const id = await goal(ctx); await call("plan_goal", { goal_id: id, tasks: tasks() }, ctx);
      await expect(call("plan_goal", { goal_id: id, tasks: tasks() }, ctx)).rejects.toThrow("already planned");
      expect(getTasksByGoal(ctx.db.raw, id)).toHaveLength(2);
    } finally { ctx.db.close(); }
  });

  it("describes the actual standalone capabilities and separate budgets", () => {
    const ctx = context();
    try {
      const prompt = buildSystemPrompt({ identity: ctx.identity, config: ctx.config, db: ctx.db, financial: { creditsCents: 0, usdcBalance: 0, lastChecked: new Date().toISOString() }, state: "running", tools, isFirstRun: false });
      expect(prompt).toContain("Crypto funds, inference budget and hosting costs are distinct");
      expect(prompt).toContain("create_goal then plan_goal");
      expect(prompt).not.toContain("You are an Automaton -- a sovereign AI agent running inside a Conway sandbox");
      expect(prompt).not.toContain("Pay for compute or die");
    } finally { ctx.db.close(); }
  });
});
