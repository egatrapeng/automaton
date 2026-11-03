/** Immutable identity of the code to reproduce in child sandboxes. */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RUNTIME_REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface RuntimeSource {
  repositoryUrl: string;
  commit: string;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Keep the selected fork, but never copy embedded Git credentials to children. */
export function normalizeRepositoryUrl(remote: string): string {
  const scp = remote.match(/^(?:[^@/:]+@)?([^/:]+):([^\s]+)$/);
  let candidate = remote;
  if (scp && !remote.includes("://")) {
    candidate = `https://${scp[1]}/${scp[2]}`;
  }
  let parsed = new URL(candidate);
  if (parsed.protocol === "ssh:") {
    if (parsed.port) throw new Error("Custom SSH ports cannot be reproduced over HTTPS");
    parsed = new URL(`https://${parsed.hostname}${parsed.pathname}`);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.port ||
      parsed.search || parsed.hash || !/^\/[A-Za-z0-9._/-]+$/.test(parsed.pathname) ||
      parsed.pathname.includes("..")) {
    throw new Error("Runtime source must be an HTTPS repository URL without query, port or traversal");
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

export function getRuntimeSource(repoRoot = RUNTIME_REPO_ROOT): RuntimeSource {
  const git = (args: string[]) => execFileSync("git", args, {
    cwd: repoRoot, encoding: "utf-8", timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (git(["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("Runtime has uncommitted tracked changes. Review and commit the intended runtime, or preserve/revert your changes explicitly, before replication. No sandbox was provisioned; nothing was pushed or reset.");
  }
  const repositoryUrl = normalizeRepositoryUrl(git(["remote", "get-url", "origin"]));
  const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Runtime source has no full Git commit");
  return { repositoryUrl, commit };
}

/**
 * The ref is resolved locally, before provisioning. Children never follow a
 * moving default branch and never silently switch from a fork to upstream.
 * Registry tools are pinned too. Existing child checkouts are not overwritten.
 */
export function childRuntimeInstallCommand(source: RuntimeSource): string {
  const repositoryUrl = normalizeRepositoryUrl(source.repositoryUrl);
  if (!/^[a-f0-9]{40}$/.test(source.commit)) throw new Error("Child runtime requires a full Git commit");
  const repo = shellQuote(repositoryUrl);
  const commit = shellQuote(source.commit);
  return [
    "set -eu",
    "npm install --prefix /opt/automaton-tools --no-audit --no-fund node@22.23.4 pnpm@10.28.1",
    "export PATH=/opt/automaton-tools/node_modules/.bin:$PATH",
    `if test ! -e /root/automaton; then git clone --no-checkout -- ${repo} /root/automaton; else test -d /root/automaton/.git && test "$(git -C /root/automaton remote get-url origin)" = ${repo} && test "$(git -C /root/automaton rev-parse HEAD)" = ${commit} && test -z "$(git -C /root/automaton status --porcelain)"; fi`,
    "cd /root/automaton",
    // Detached local-only commits may require a direct fetch from the origin.
    `git cat-file -e ${commit}^{commit} 2>/dev/null || git fetch origin ${commit}`,
    `git checkout --detach ${commit}`,
    `test "$(git rev-parse HEAD)" = ${commit}`,
    "pnpm install --frozen-lockfile",
    "pnpm run build",
    "node dist/index.js --help",
  ].join(" && ");
}
