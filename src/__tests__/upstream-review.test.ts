import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  base: "a".repeat(40), target: "b".repeat(40),
  current: "a".repeat(40), diff: "reviewed change", dirty: "", origin: "https://github.com/operator/fork.git",
}));
vi.mock("child_process", () => ({ execFileSync: vi.fn((_command: string, args: string[]) => {
  if (args[0] === "remote") return state.origin;
  if (args[0] === "rev-parse") return args[1] === "origin/main" ? state.target : state.current;
  if (args[0] === "status") return state.dirty;
  if (args[0] === "log") return `${state.target} Author|||Reviewed change`;
  if (args[0] === "diff") return state.diff;
  throw new Error(`Unexpected git operation ${args.join(" ")}`);
}) }));

beforeEach(() => {
  vi.resetModules();
  state.current = state.base; state.diff = "reviewed change"; state.dirty = "";
  state.origin = "https://github.com/operator/fork.git";
});

describe("source update review binding", () => {
  it("requires a review before any update", async () => {
    const { prepareReviewedUpdate } = await import("../self-mod/upstream.js");
    expect(() => prepareReviewedUpdate()).toThrow(/Review upstream/);
  });

  it("applies the exact reviewed revision, backs up the base, and consumes the receipt", async () => {
    const { getUpstreamDiffs, prepareReviewedUpdate } = await import("../self-mod/upstream.js");
    expect(getUpstreamDiffs()[0].hash).toBe(state.target);
    const result = prepareReviewedUpdate(state.target.slice(0, 12));
    expect(result.target).toBe(state.target); expect(result.previousCommit).toBe(state.base);
    expect(result.command).toContain("git update-ref");
    expect(result.command).toContain(`git cherry-pick '${state.target}'`);
    expect(result.command).not.toContain("git fetch");
    expect(result.command).not.toContain("git reset");
    expect(result.buildCommand).toContain("pnpm install --frozen-lockfile");
    expect(() => prepareReviewedUpdate()).toThrow(/Review upstream/);
  });

  it.each(["head", "origin", "diff", "dirty"])("refuses changed %s without resetting user work", async change => {
    const { getUpstreamDiffs, prepareReviewedUpdate } = await import("../self-mod/upstream.js");
    getUpstreamDiffs();
    if (change === "head") state.current = "c".repeat(40);
    if (change === "origin") state.origin = "https://github.com/other/repo.git";
    if (change === "diff") state.diff = "tampered change";
    if (change === "dirty") state.dirty = " M user-file";
    expect(() => prepareReviewedUpdate()).toThrow();
  });

  it("rejects a commit that was not reviewed", async () => {
    const { getUpstreamDiffs, prepareReviewedUpdate } = await import("../self-mod/upstream.js");
    getUpstreamDiffs();
    expect(() => prepareReviewedUpdate("c".repeat(40))).toThrow(/not reviewed/);
    expect(() => prepareReviewedUpdate("--exec=evil")).toThrow(/Invalid commit/);
  });

  it("expires review receipts", async () => {
    const { getUpstreamDiffs, prepareReviewedUpdate } = await import("../self-mod/upstream.js");
    const now = Date.now(); const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    getUpstreamDiffs(); spy.mockReturnValue(now + 31 * 60_000);
    expect(() => prepareReviewedUpdate()).toThrow(/expires/);
    spy.mockRestore();
  });
});

describe("recovery remains available without silent destruction", () => {
  it("requires a complete recovery preview and an exact target", async () => {
    const { getUpstreamDiffs, prepareReviewedUpdate, reviewRecoveryChanges } = await import("../self-mod/upstream.js");
    getUpstreamDiffs();
    expect(() => prepareReviewedUpdate(state.target, { recovery: true })).toThrow(/full recovery diff/);
    reviewRecoveryChanges();
    expect(() => prepareReviewedUpdate(state.target.slice(0, 12), { recovery: true })).toThrow(/full reviewed target/);
  });

  it("archives user files and ignored outputs outside checkout before resetting to the exact reviewed commit", async () => {
    const { prepareReviewedUpdate, reviewRecoveryChanges } = await import("../self-mod/upstream.js");
    state.dirty = " M modified-source\n?? user-notes";
    expect(reviewRecoveryChanges()).toMatchObject({ base: state.base, target: state.target, diff: state.diff });
    const result = prepareReviewedUpdate(state.target, { recovery: true });
    expect(result.backupDirectory).toBeTruthy();
    expect(result.command).toContain("umask 077");
    expect(result.command).toContain("tar --exclude=./.git -cpf");
    expect(result.command).not.toContain("--exclude=node_modules");
    expect(result.command.indexOf("tar -tf")).toBeLessThan(result.command.indexOf("git reset --hard"));
    expect(result.command).toContain(`git reset --hard '${state.target}'`);
    expect(result.command).not.toContain("git clean");
  });
});
