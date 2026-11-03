/**
 * Upstream Awareness
 *
 * Helpers for the automaton to know its own git origin,
 * detect new upstream commits, and review diffs.
 * All git commands use execFileSync with argument arrays to prevent injection.
 */

import { execFileSync } from "child_process";
import { createHash } from "node:crypto";
import { RUNTIME_REPO_ROOT, normalizeRepositoryUrl, shellQuote } from "./runtime-source.js";

const REPO_ROOT = RUNTIME_REPO_ROOT;

interface ReviewSnapshot {
  base: string;
  origin: string;
  target: string;
  reviewedAt: number;
  commits: Map<string, string>;
  recoveryDiff?: string;
}
let reviewSnapshot: ReviewSnapshot | undefined;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Run a git command using execFileSync with argument array (no shell interpolation).
 */
function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Return origin URL (credentials stripped), current branch, and HEAD info.
 */
export function getRepoInfo(): {
  originUrl: string;
  branch: string;
  headHash: string;
  headMessage: string;
} {
  const rawUrl = git(["config", "--get", "remote.origin.url"]);
  // Strip embedded credentials (https://user:token@host/... -> https://host/...)
  const originUrl = normalizeRepositoryUrl(rawUrl);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const headLine = git(["log", "-1", "--format=%h %s"]);
  const [headHash, ...rest] = headLine.split(" ");
  return { originUrl, branch, headHash, headMessage: rest.join(" ") };
}

/**
 * Fetch origin and report how many commits we're behind.
 */
export function checkUpstream(): {
  behind: number;
  commits: { hash: string; message: string }[];
} {
  git(["fetch", "origin", "main", "--quiet"]);
  const log = git(["log", "HEAD..origin/main", "--oneline"]);
  if (!log) return { behind: 0, commits: [] };
  const commits = log.split("\n").map((line) => {
    const [hash, ...rest] = line.split(" ");
    return { hash, message: rest.join(" ") };
  });
  return { behind: commits.length, commits };
}

/**
 * Return per-commit diffs for every commit ahead of HEAD on origin/main.
 */
export function getUpstreamDiffs(): {
  hash: string;
  message: string;
  author: string;
  diff: string;
}[] {
  const log = git(["log", "HEAD..origin/main", "--format=%H %an|||%s"]);
  if (!log) {
    reviewSnapshot = undefined;
    return [];
  }

  const snapshot: ReviewSnapshot = {
    base: git(["rev-parse", "HEAD"]),
    origin: normalizeRepositoryUrl(git(["remote", "get-url", "origin"])),
    target: git(["rev-parse", "origin/main"]),
    reviewedAt: Date.now(),
    commits: new Map(),
  };

  const diffs = log.split("\n").map((line) => {
    const [hashAndAuthor, message] = line.split("|||");
    const parts = hashAndAuthor.split(" ");
    const hash = parts[0];
    const author = parts.slice(1).join(" ");
    let diff: string;
    try {
      diff = git(["diff", `${hash}~1..${hash}`]);
    } catch {
      // First commit in the range may not have a parent
      diff = git(["show", hash, "--format="]);
    }
    snapshot.commits.set(hash, digest(diff));
    return { hash, message, author, diff };
  });
  reviewSnapshot = snapshot;
  return diffs;
}

/** Preview the entire change from current source to a known upstream revision,
 * including the removal of local-only commits. No network mutation is hidden
 * here: call checkUpstream() first when a fresh remote view is desired. */
export function reviewRecoveryChanges(): { target: string; base: string; diff: string } {
  const base = git(["rev-parse", "HEAD"]);
  const target = git(["rev-parse", "origin/main"]);
  const diff = git(["diff", base, target]);
  reviewSnapshot = {
    base, target,
    origin: normalizeRepositoryUrl(git(["remote", "get-url", "origin"])),
    reviewedAt: Date.now(), commits: new Map(), recoveryDiff: digest(diff),
  };
  return { target, base, diff };
}

/**
 * Bind an autonomous update to the exact source and diff just inspected. This
 * is an integrity/review guard, not a claim of human approval or code safety.
 * The caller must execute command through its normal execution boundary.
 */
export function prepareReviewedUpdate(commit?: string, options: { recovery?: boolean } = {}): {
  command: string;
  buildCommand: string;
  target: string;
  previousCommit: string;
  backupRef: string;
  backupDirectory?: string;
} {
  const snapshot = reviewSnapshot;
  if (!snapshot || Date.now() - snapshot.reviewedAt > 30 * 60_000) {
    throw new Error("Review upstream changes before applying an update (review expires after 30 minutes)");
  }
  if (Boolean(snapshot.recoveryDiff) !== Boolean(options.recovery)) {
    throw new Error(options.recovery ? "Review the full recovery diff before restoring upstream" : "Review upstream updates before applying them");
  }
  if (git(["rev-parse", "HEAD"]) !== snapshot.base ||
      normalizeRepositoryUrl(git(["remote", "get-url", "origin"])) !== snapshot.origin) {
    throw new Error("Repository changed since review; review again");
  }
  if (!options.recovery && git(["status", "--porcelain"])) {
    throw new Error("Commit or preserve local changes before updating; no reset will be performed");
  }
  let target = snapshot.target;
  if (options.recovery) {
    if (commit !== snapshot.target) throw new Error("Recovery requires the full reviewed target commit");
    if (digest(git(["diff", snapshot.base, snapshot.target])) !== snapshot.recoveryDiff) {
      throw new Error("Recovery diff changed; review again");
    }
  } else if (commit !== undefined) {
    if (!/^[a-f0-9]{7,40}$/.test(commit)) throw new Error("Invalid commit hash");
    const matches = [...snapshot.commits.keys()].filter(hash => hash.startsWith(commit));
    if (matches.length !== 1) throw new Error("Commit was not reviewed or its abbreviation is ambiguous");
    target = matches[0];
  }
  for (const [hash, expectedDigest] of snapshot.commits) {
    if (commit && hash !== target) continue;
    let diff: string;
    try { diff = git(["diff", `${hash}~1..${hash}`]); }
    catch { diff = git(["show", hash, "--format="]); }
    if (digest(diff) !== expectedDigest) throw new Error("Reviewed diff changed; review again");
  }
  const backupRef = `refs/automaton/rollback/${Date.now()}-${snapshot.base.slice(0, 12)}`;
  // Recovery preserves the complete working tree, including ignored files and
  // installed dependencies, outside the checkout before changing any file.
  const backupDirectory = options.recovery
    ? `${REPO_ROOT.replace(/\/$/, "")}.recovery-${Date.now()}-${snapshot.base.slice(0, 12)}`
    : undefined;
  const cwd = `cd ${shellQuote(REPO_ROOT)}`;
  const checks = [
    cwd,
    `test "$(git rev-parse HEAD)" = ${shellQuote(snapshot.base)}`,
    `git update-ref ${shellQuote(backupRef)} ${shellQuote(snapshot.base)}`,
  ];
  if (backupDirectory) {
    checks.push(
      `umask 077`,
      `mkdir ${shellQuote(backupDirectory)}`,
      `tar --exclude=./.git -cpf ${shellQuote(`${backupDirectory}/checkout.tar`)} -C ${shellQuote(REPO_ROOT)} .`,
      `tar -tf ${shellQuote(`${backupDirectory}/checkout.tar`)} >/dev/null`,
      `git reset --hard ${shellQuote(target)}`,
    );
  } else {
    checks.push("test -z \"$(git status --porcelain)\"", commit
      ? `git cherry-pick ${shellQuote(target)}`
      : `git merge --ff-only ${shellQuote(target)}`);
  }
  // A stale or repeated call must obtain a fresh review. Git refs retain the
  // previous revision for explicit rollback; never reset user work silently.
  reviewSnapshot = undefined;
  return {
    command: checks.join(" && "),
    buildCommand: `${cwd} && pnpm install --frozen-lockfile && pnpm run build && node dist/index.js --help`,
    target,
    previousCommit: snapshot.base,
    backupRef,
    backupDirectory,
  };
}
