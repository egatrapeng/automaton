import type { AutomatonTool } from "../types.js";
import { getGoalById, getTasksByGoal, withTransaction } from "../state/database.js";
import { decomposeGoal } from "./task-graph.js";

/** Plan persistence only: no provider, remote worker, new inference or spending authority. */
export function standalonePlanTool(): AutomatonTool {
  return {
    name: "plan_goal", category: "orchestration", riskLevel: "caution",
    description: "Standalone: persist up to 16 concrete tasks for an existing local goal. Execute ready tasks yourself with normal tools, then complete_task. No background worker will run them. This plan never approves guardian spending.",
    parameters: { type: "object", properties: {
      goal_id: { type: "string" }, strategy: { type: "string" },
      tasks: { type: "array", maxItems: 16, items: { type: "object", properties: {
        title: { type: "string" }, description: { type: "string" },
        dependencies: { type: "array", items: { type: "string" }, description: "Exact titles of earlier tasks in this plan" },
        estimatedCostCents: { type: "integer", minimum: 0, description: "Planning estimate in USD cents, never permission to spend" },
      }, required: ["title", "description"] } },
    }, required: ["goal_id", "tasks"] },
    execute: async (args, ctx) => {
      if (ctx.config.runtimeMode !== "standalone") throw new Error("plan_goal is for standalone execution only");
      const goal = getGoalById(ctx.db.raw, String(args.goal_id));
      if (!goal || goal.status !== "active") throw new Error("An active local goal is required");
      const tasks = args.tasks as Array<{ title: string; description: string; dependencies?: string[]; estimatedCostCents?: number }>;
      if (!Array.isArray(tasks) || !tasks.length || tasks.length > 16) throw new Error("Provide 1 to 16 tasks");
      const seen = new Set<string>();
      for (const task of tasks) {
        if (typeof task.title !== "string" || !task.title.trim() || task.title.length > 120 || typeof task.description !== "string" || !task.description.trim() || task.description.length > 1500) throw new Error("Bounded non-empty task title and description required");
        task.title = task.title.trim();
        if (seen.has(task.title)) throw new Error("Task titles must be unique");
        if (task.dependencies !== undefined && (!Array.isArray(task.dependencies) || task.dependencies.length > 16 || task.dependencies.some(d => typeof d !== "string" || !seen.has(d)))) throw new Error("Dependencies must name earlier tasks in this plan");
        if (task.estimatedCostCents !== undefined && (!Number.isSafeInteger(task.estimatedCostCents) || task.estimatedCostCents < 0)) throw new Error("Invalid cost estimate");
        seen.add(task.title);
      }
      const strategy = typeof args.strategy === "string" ? args.strategy.trim() : goal.strategy ?? "Execute locally and verify artifacts";
      if (strategy.length > 2000) throw new Error("Strategy too long");
      if (!Number.isSafeInteger(tasks.reduce((n, t) => n + (t.estimatedCostCents ?? 0), 0))) throw new Error("Total estimate exceeds safe integer range");
      withTransaction(ctx.db.raw, () => {
        if (getTasksByGoal(ctx.db.raw, goal.id).length) throw new Error("Goal already planned; inspect get_plan and continue or cancel it explicitly");
        decomposeGoal(ctx.db.raw, goal.id, tasks.map((t, i) => ({ goalId: goal.id, parentId: null,
          title: t.title, description: t.description, status: "pending", assignedTo: null, agentRole: null,
          priority: Math.max(0, 100 - i), dependencies: t.dependencies ?? [], result: null })));
        const rows = getTasksByGoal(ctx.db.raw, goal.id);
        for (const task of tasks) ctx.db.raw.prepare("UPDATE task_graph SET estimated_cost_cents=? WHERE goal_id=? AND title=?")
          .run(task.estimatedCostCents ?? 0, goal.id, task.title);
        ctx.db.setKV(`orchestrator.plan.${goal.id}`, JSON.stringify({ strategy, analysis: "Agent-proposed local plan; outcomes and income remain unverified until evidenced",
          estimatedTotalCostCents: tasks.reduce((n, t) => n + (t.estimatedCostCents ?? 0), 0), risks: [], tasks: rows.map(t => ({ id: t.id, title: t.title, dependencies: t.dependencies, agentRole: "self", estimatedCostCents: tasks.find(p => p.title === t.title)?.estimatedCostCents ?? 0 })) }));
      });
      return JSON.stringify({ goalId: goal.id, tasks: getTasksByGoal(ctx.db.raw, goal.id), next: "Execute a pending task whose dependencies are completed. Verify its artifact, then call complete_task. No worker will run it for you. Guardian authorization remains separate." });
    },
  };
}
