import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConwayClient } from "../conway/client.js";
import { executeOnHost, resolveExecution, toolEnvironment } from "../security/execution.js";
import { FileAccessError, readToolFile, writeToolFile } from "../security/files.js";
import { createBuiltinTools, executeTool } from "../agent/tools.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import type { ExecutionConfig, ToolContext } from "../types.js";

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const nodeCommand = (code: string) => `exec ${shellQuote(process.execPath)} -e ${shellQuote(code)}`;

describe("explicit host administration", () => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-execution-test-")); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
  const clientOptions = { apiUrl: "https://unreachable.invalid", apiKey: "FAKE_ONLY", sandboxId: "" };

  it("refuses an implicit local target and invalid remote/host combinations", () => {
    expect(() => createConwayClient(clientOptions)).toThrow(/No execution target/);
    expect(() => createConwayClient({ ...clientOptions, sandboxId: " undefined " })).toThrow(/No execution target/);
    expect(() => resolveExecution("", { mode: "remote" })).toThrow(/refusing local fallback/);
    expect(() => resolveExecution("remote-sandbox", { mode: "host" })).toThrow(/ambiguous/);
    expect(resolveExecution("remote-sandbox")).toEqual({ mode: "remote" });
  });

  it("preserves explicitly selected host commands, including administrator-readable files", async () => {
    const marker = path.join(directory, "wallet.json");
    fs.writeFileSync(marker, "FAKE_HOST_MARKER_ONLY", { mode: 0o600 });
    const client = createConwayClient({ ...clientOptions, execution: { mode: "host", workingDirectory: directory } });
    // Host mode intentionally retains operator-selected administration powers.
    // It must never be described as isolating secrets from a general shell.
    const result = await client.exec(`head -c 100 ${shellQuote(marker)}`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("FAKE_HOST_MARKER_ONLY");
  });

  it("never executes a remote command locally after an authentication failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "denied" }, { status: 403 })));
    const marker = path.join(directory, "must-not-exist");
    const client = createConwayClient({ ...clientOptions, sandboxId: "remote-sandbox", execution: { mode: "remote" } });
    await expect(client.exec(`touch ${shellQuote(marker)}`)).rejects.toThrow(/NOT be executed locally/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("filters inherited credentials but preserves an explicitly allowed variable", async () => {
    vi.stubEnv("AUTOMATON_TEST_SECRET", "FAKE_FILTERED_VALUE");
    vi.stubEnv("AUTOMATON_TEST_ALLOWED", "FAKE_ALLOWED_VALUE");
    const env = toolEnvironment(["AUTOMATON_TEST_ALLOWED"]);
    expect(env.AUTOMATON_TEST_SECRET).toBeUndefined();
    expect(env.AUTOMATON_TEST_ALLOWED).toBe("FAKE_ALLOWED_VALUE");
    const result = await executeOnHost(nodeCommand(`process.stdout.write(JSON.stringify({secret:process.env.AUTOMATON_TEST_SECRET,allowed:process.env.AUTOMATON_TEST_ALLOWED}))`), {
      mode: "host", workingDirectory: directory, environmentAllowlist: ["AUTOMATON_TEST_ALLOWED"],
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ allowed: "FAKE_ALLOWED_VALUE" });
  });

  it("refuses loader and startup environment injection", () => {
    for (const name of ["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV"]) {
      expect(() => toolEnvironment([name])).toThrow(/Unsafe/);
    }
    expect(() => toolEnvironment(["INVALID-NAME"])).toThrow(/Invalid/);
  });

  it("collects stdout and stderr without blocking the event loop", async () => {
    const events: string[] = [];
    const tick = new Promise<void>((resolve) => setTimeout(() => { events.push("tick"); resolve(); }, 10));
    const execution = executeOnHost(nodeCommand(`setTimeout(()=>{process.stdout.write('stdout-marker');process.stderr.write('stderr-marker')},50)`), {
      mode: "host", workingDirectory: directory,
    }).then(result => { events.push("complete"); return result; });
    const [, result] = await Promise.all([tick, execution]);
    expect(events).toEqual(["tick", "complete"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("stdout-marker");
    // Runtime warnings (e.g. Node's native proxy notice) may precede stderr.
    expect(result.stderr).toContain("stderr-marker");
  });

  it("applies the configured maximum timeout and kills the launched process", async () => {
    const result = await executeOnHost(nodeCommand(`process.stdout.write(String(process.pid));setInterval(()=>{},1000)`), {
      mode: "host", workingDirectory: directory, maxTimeoutMs: 250,
    }, 10_000);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("timeout");
    const pid = Number(result.stdout);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("bounds output and terminates a process that continues producing data", async () => {
    const result = await executeOnHost(nodeCommand(`process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000)`), {
      mode: "host", workingDirectory: directory, maxOutputBytes: 64, maxTimeoutMs: 2_000,
    });
    expect(result.stdout).toBe("x".repeat(64));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("output limit");
  });

  it("does not expand a UTF-8 fragment past the configured byte limit", async () => {
    const result = await executeOnHost(nodeCommand(`process.stdout.write('😀'.repeat(4096));setInterval(()=>{},1000)`), {
      mode: "host", workingDirectory: directory, maxOutputBytes: 65, maxTimeoutMs: 2_000,
    });
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(65);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("output limit");
  });

  it("validates command limits and working directory configuration", async () => {
    expect(() => resolveExecution("", { mode: "host", maxOutputBytes: 0 })).toThrow(/Invalid/);
    expect(() => resolveExecution("", { mode: "host", maxTimeoutMs: Infinity })).toThrow(/Invalid/);
    expect(() => resolveExecution("", { mode: "host", workingDirectory: "relative" })).toThrow(/absolute/);
    await expect(executeOnHost("true", { mode: "host" }, 0)).rejects.toThrow(/Invalid command timeout/);
  });
});

describe("file API boundary (independent of explicit administration shell)", () => {
  let directory: string;
  let allowed: string;
  let outside: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-files-test-"));
    allowed = path.join(directory, "workspace");
    outside = path.join(directory, "outside");
    fs.mkdirSync(allowed); fs.mkdirSync(outside);
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

  it("allows legitimate files and symlinks within the configured root", () => {
    const file = path.join(allowed, "notes.txt"), link = path.join(allowed, "alias.txt");
    writeToolFile(file, "first", [allowed]);
    fs.symlinkSync(file, link);
    expect(readToolFile(link, [allowed])).toBe("first");
    writeToolFile(link, "updated", [allowed]);
    expect(fs.readFileSync(file, "utf8")).toBe("updated");
  });

  it("denies a sensitive target reached through an ordinary symlink without a shell fallback", async () => {
    const wallet = path.join(allowed, "wallet.json"), link = path.join(allowed, "public.txt");
    fs.writeFileSync(wallet, "FAKE_WALLET_CONTENT_ONLY", { mode: 0o600 });
    fs.symlinkSync(wallet, link);
    const execution: ExecutionConfig = { mode: "host", workingDirectory: allowed, readRoots: [allowed] };
    const client = createConwayClient({ apiUrl: "https://unreachable.invalid", apiKey: "FAKE_ONLY", sandboxId: "", execution });
    const execSpy = vi.spyOn(client, "exec");
    const context = { conway: client, identity: { sandboxId: "" }, config: { execution }, db: {} } as unknown as ToolContext;
    const policy = new PolicyEngine(null as any, createDefaultRules());
    const result = await executeTool("read_file", { path: link }, createBuiltinTools(""), context, policy, {
      inputSource: "agent", turnToolCallCount: 0, sessionSpend: {} as any,
    });
    expect(result.result).toContain("Blocked:");
    expect(result.result).not.toContain("FAKE_WALLET_CONTENT_ONLY");
    expect(execSpy).not.toHaveBeenCalled();
    expect(() => writeToolFile(link, "replacement", [allowed])).toThrow(FileAccessError);
    expect(fs.readFileSync(wallet, "utf8")).toBe("FAKE_WALLET_CONTENT_ONLY");
  });

  it("denies outside files and symlink escapes before truncating existing targets", () => {
    const file = path.join(outside, "notes.txt"), link = path.join(allowed, "escape.txt");
    fs.writeFileSync(file, "PRESERVE_EXISTING_CONTENT"); fs.symlinkSync(file, link);
    for (const target of [file, link]) {
      expect(() => readToolFile(target, [allowed])).toThrow(FileAccessError);
      expect(() => writeToolFile(target, "replacement", [allowed])).toThrow(FileAccessError);
    }
    expect(fs.readFileSync(file, "utf8")).toBe("PRESERVE_EXISTING_CONTENT");
    const nonexistent = path.join(outside, "new-directory", "new.txt");
    expect(() => writeToolFile(nonexistent, "replacement", [allowed])).toThrow(FileAccessError);
    expect(fs.existsSync(path.dirname(nonexistent))).toBe(false);
  });

  it("does not create outside directories through a symlink before refusing a write", () => {
    const link = path.join(allowed, "outside-link");
    fs.symlinkSync(outside, link);
    expect(() => writeToolFile(path.join(link, "must-not-create", "notes.txt"), "replacement", [allowed])).toThrow(FileAccessError);
    expect(fs.existsSync(path.join(outside, "must-not-create"))).toBe(false);
  });

  it("rejects sensitive directories, SSH key names and excessive file output", () => {
    for (const name of ["id_ed25519", ".env.production", "payment-ledger.db", path.join(".ssh", "key-without-extension")]) {
      const file = path.join(allowed, name);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "FAKE_ONLY");
      expect(() => readToolFile(file, [allowed])).toThrow(FileAccessError);
    }
    const file = path.join(allowed, "large.txt"); fs.writeFileSync(file, "x".repeat(65));
    expect(() => readToolFile(file, [allowed], 64)).toThrow(/read limit/);
  });
});
