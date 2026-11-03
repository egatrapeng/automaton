import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeRepositoryUrl, getRuntimeSource, childRuntimeInstallCommand } from "../self-mod/runtime-source.js";
import { installNpmPackage } from "../self-mod/tools-manager.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("immutable runtime source", () => {
  it("preserves fork identity while stripping credentials and converting SSH to HTTPS", () => {
    expect(normalizeRepositoryUrl("https://user:fake-token@github.com/user/fork.git")).toBe("https://github.com/user/fork.git");
    expect(normalizeRepositoryUrl("git@github.com:user/fork.git")).toBe("https://github.com/user/fork.git");
    expect(normalizeRepositoryUrl("ssh://git@github.com/user/fork.git")).toBe("https://github.com/user/fork.git");
  });

  it.each(["file:///tmp/repo", "https://github.com/a/b?token=x", "https://github.com:8443/a/b", "https://github.com/a/b;touch-x"])('rejects unsafe source %s', url => {
    expect(() => normalizeRepositoryUrl(url)).toThrow();
  });

  it("reads the full local commit and selected fork without asking a remote", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-source-")); temporary.push(dir);
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init"]); git(["config", "user.email", "test@example.invalid"]); git(["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(dir, "README"), "test"); git(["add", "README"]); git(["commit", "-m", "local-only"]);
    git(["remote", "add", "origin", "git@github.com:operator/selected-fork.git"]);
    expect(getRuntimeSource(dir)).toEqual({ repositoryUrl: "https://github.com/operator/selected-fork.git", commit: git(["rev-parse", "HEAD"]) });
    fs.writeFileSync(path.join(dir, "README"), "reviewed source has not been committed yet");
    expect(() => getRuntimeSource(dir)).toThrow(/uncommitted tracked changes/);
    expect(fs.readFileSync(path.join(dir, "README"), "utf8")).toBe("reviewed source has not been committed yet");
    git(["add", "README"]);
    expect(() => getRuntimeSource(dir)).toThrow(/Review and commit/);
    git(["commit", "-m", "reviewed upgrade"]);
    expect(getRuntimeSource(dir).commit).toBe(git(["rev-parse", "HEAD"]));
  });

  it("replicates the fork at an immutable revision with frozen dependencies", () => {
    const commit = "a".repeat(40);
    const command = childRuntimeInstallCommand({ repositoryUrl: "https://github.com/operator/selected-fork.git", commit });
    expect(command).toContain("https://github.com/operator/selected-fork.git");
    expect(command).toContain(`git checkout --detach '${commit}'`);
    expect(command).toContain("pnpm install --frozen-lockfile");
    expect(command).toContain("node@22.23.4 pnpm@10.28.1");
    expect(command).not.toContain("Conway-Research");
    expect(command).not.toContain("git reset");
    expect(() => childRuntimeInstallCommand({ repositoryUrl: "https://github.com/operator/repo.git", commit: "main" })).toThrow();
  });
});

describe("verified registry installation", () => {
  const metadata = { version: "1.2.3", "dist.integrity": `sha512-${Buffer.alloc(64, 1).toString("base64")}` };
  const db = () => ({ installTool: vi.fn(), insertModification: vi.fn() });

  it.each(["--global", "../local", "https://example.com/p.tgz", "x;whoami", "git+https://example.com/repo"])('rejects executable or local package spec %s before execution', async spec => {
    const exec = vi.fn();
    expect((await installNpmPackage({ exec } as any, db() as any, spec)).success).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("resolves the version, verifies the packed artifact, retains native lifecycle support and records provenance", async () => {
    const exec = vi.fn().mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify(metadata) }).mockResolvedValueOnce({ exitCode: 0, stdout: "installed" });
    const state = db();
    expect((await installNpmPackage({ exec } as any, state as any, "@vendor/tool")).success).toBe(true);
    expect(exec.mock.calls[1][0]).toContain("'@vendor/tool@1.2.3'");
    expect(exec.mock.calls[1][0]).toContain("npm pack --ignore-scripts");
    expect(exec.mock.calls[1][0]).toContain("npm archive checksum mismatch");
    expect(state.installTool.mock.calls[0][0].config).toMatchObject({ resolvedPackage: "@vendor/tool@1.2.3", integrity: metadata["dist.integrity"], allowLifecycleScripts: true });
    expect(state.insertModification.mock.calls[0][0].description).toContain("executes third-party code");
  });

  it("supports explicitly suppressing lifecycle scripts", async () => {
    const exec = vi.fn().mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify(metadata) }).mockResolvedValueOnce({ exitCode: 0, stdout: "installed" });
    await installNpmPackage({ exec } as any, db() as any, "tool@1.2.3", { allowLifecycleScripts: false });
    expect(exec.mock.calls[1][0]).toContain("npm install -g --no-audit --no-fund --ignore-scripts");
  });

  it("refuses unverifiable metadata before installing and records nothing on install failure", async () => {
    const exec = vi.fn().mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ version: "1.2.3" }) });
    const state = db();
    expect((await installNpmPackage({ exec } as any, state as any, "tool")).success).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1); expect(state.installTool).not.toHaveBeenCalled();
    exec.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify(metadata) }).mockResolvedValueOnce({ exitCode: 1, stderr: "checksum mismatch" });
    expect((await installNpmPackage({ exec } as any, state as any, "tool")).success).toBe(false);
    expect(state.installTool).not.toHaveBeenCalled();
  });

  it.each([false, true])("checks the actual archive before executing the installer (tampered=%s)", async tampered => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-package-")); temporary.push(dir);
    const integrity = `sha512-${createHash("sha512").update("EXPECTED_ARCHIVE").digest("base64")}`;
    const manifest = JSON.stringify({ version: "1.2.3", "dist.integrity": integrity });
    const packed = JSON.stringify([{ filename: "tool-1.2.3.tgz", integrity }]);
    fs.writeFileSync(path.join(dir, "npm"), `#!/bin/sh\nset -eu\ncase "$1" in\nview) printf '%s' '${manifest}' ;;\npack) printf '%s' '${tampered ? "TAMPERED_ARCHIVE" : "EXPECTED_ARCHIVE"}' > "$4/tool-1.2.3.tgz"; printf '%s' '${packed}' ;;\ninstall) touch '${dir}/installed' ;;\n*) exit 1 ;;\nesac\n`, { mode: 0o700 });
    const conway = { exec: async (command: string) => {
      try { return { exitCode: 0, stdout: execFileSync("sh", ["-c", command], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] }) }; }
      catch (err: any) { return { exitCode: err.status ?? 1, stdout: err.stdout, stderr: err.stderr }; }
    } };
    const result = await installNpmPackage(conway as any, db() as any, "tool");
    expect(result.success).toBe(!tampered);
    expect(fs.existsSync(path.join(dir, "installed"))).toBe(!tampered);
  });
});

describe("installer repeatability", () => {
  it("reuses an existing checkout without pulling, changing local files or following upstream", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-installer-")); temporary.push(dir);
    const repo = path.join(dir, "repo"); const bin = path.join(dir, "bin");
    fs.mkdirSync(repo); fs.mkdirSync(bin);
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init"]); git(["config", "user.email", "test@example.invalid"]); git(["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(repo, "README"), "initial"); git(["add", "README"]); git(["commit", "-m", "initial"]);
    git(["remote", "add", "origin", "https://github.com/operator/selected-fork.git"]);
    fs.writeFileSync(path.join(repo, "README"), "operator changes");
    fs.writeFileSync(path.join(repo, "notes"), "untracked operator notes");
    const initialStatus = git(["status", "--porcelain"]); const initialHead = git(["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh\ncase "$1" in\n-e) exec '${process.execPath}' "$@" ;;\n*) printf '%s\\n' "$*" >> '${dir}/node-calls'; exit 0 ;;\nesac\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\nif test "$1" = --version; then echo 10.28.1; else printf '%s\\n' "$*" >> '${dir}/pnpm-calls'; fi\n`, { mode: 0o700 });
    execFileSync("sh", [path.resolve("scripts/automaton.sh")], {
      cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AUTOMATON_DIR: repo, AUTOMATON_COMMIT: initialHead, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(git(["rev-parse", "HEAD"])).toBe(initialHead); expect(git(["status", "--porcelain"])).toBe(initialStatus);
    expect(fs.readFileSync(path.join(repo, "README"), "utf8")).toBe("operator changes");
    expect(fs.readFileSync(path.join(repo, "notes"), "utf8")).toBe("untracked operator notes");
    expect(fs.readFileSync(path.join(dir, "pnpm-calls"), "utf8")).toContain("install --frozen-lockfile");
    expect(fs.readFileSync(path.join(dir, "node-calls"), "utf8")).toContain("dist/index.js --run");
  });
});
