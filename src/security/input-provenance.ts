import type { Database } from "better-sqlite3";
import type { InputSource } from "../types.js";

/** Provenance is runtime-owned metadata, never a claim supplied by the model. */
export function setGoalInputSource(db: Database, goalId: string, source: InputSource | undefined): void {
  const normalized = source ?? "external";
  // A subsequent trusted-looking call must not upgrade an existing external goal.
  if (getGoalInputSource(db, goalId) === "external") return;
  db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))")
    .run(`security.goal_source.${goalId}`, normalized);
}

export function getGoalInputSource(db: Database, goalId: string): InputSource | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?")
    .get(`security.goal_source.${goalId}`) as { value: string } | undefined;
  if (!row) return undefined;
  const source = row.value;
  return ["creator", "agent", "system", "wakeup"].includes(source)
    ? source as InputSource : "external";
}

/** Unknown delegated tasks receive external policy authority, not agent authority. */
export function delegatedInputSource(db: Database, goalId: string, fallback?: InputSource): InputSource {
  return getGoalInputSource(db, goalId) ?? fallback ?? "external";
}
