import { spawn } from "node:child_process";
import path from "node:path";
import type { ExecutionConfig, ExecResult } from "../types.js";

const BASE_ENVIRONMENT = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_USE_ENV_PROXY",
];

export function toolEnvironment(additional: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of new Set([...BASE_ENVIRONMENT, ...additional])) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid tool environment variable name");
    // Dynamic loader/startup code can silently execute before the requested tool.
    if (/^(?:LD_|DYLD_|BASH_ENV$|ENV$|NODE_OPTIONS$)/.test(name)) {
      throw new Error(`Unsafe tool environment variable: ${name}`);
    }
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

export function resolveExecution(sandboxId: string, config?: ExecutionConfig): ExecutionConfig {
  if (!config) {
    if (sandboxId) return { mode: "remote" };
    throw new Error('No execution target configured. Set execution.mode to "host" for VPS administration, or "remote" with a sandboxId. Host mode runs with this process\'s privileges and is not isolated.');
  }
  if (config.mode !== "host" && config.mode !== "remote") throw new Error("Invalid execution mode");
  if (config.mode === "remote" && !sandboxId) throw new Error("Remote execution requires a sandboxId; refusing local fallback");
  if (config.mode === "host" && sandboxId) throw new Error("Host execution with a sandboxId is ambiguous; remove sandboxId or select remote mode");
  for (const name of ["maxTimeoutMs", "maxOutputBytes"] as const) {
    const value = config[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`Invalid execution.${name}`);
  }
  if (config.workingDirectory && !path.isAbsolute(config.workingDirectory)) throw new Error("Execution workingDirectory must be absolute");
  toolEnvironment(config.environmentAllowlist);
  return config;
}

/** Async host administration, with bounded output/time. NOT a sandbox. */
export async function executeOnHost(command: string, config: ExecutionConfig, timeout?: number): Promise<ExecResult> {
  const limit = config.maxOutputBytes ?? 1024 * 1024;
  const maximum = config.maxTimeoutMs ?? 300_000;
  const requested = timeout ?? 30_000;
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("Invalid command timeout");
  return new Promise((resolve) => {
    let stdout = "", stderr = "", bytes = 0, reason = "";
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: config.workingDirectory ?? process.env.HOME ?? "/root",
      env: toolEnvironment(config.environmentAllowlist),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const kill = (message: string) => {
      if (reason) return;
      reason = message;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* already exited */ }
    };
    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const remaining = Math.max(0, limit - bytes);
      let text = chunk.subarray(0, remaining).toString("utf8");
      // A cut UTF-8 sequence can expand into a replacement character.
      while (Buffer.byteLength(text, "utf8") > remaining) text = text.slice(0, -1);
      if (stream === "stdout") stdout += text; else stderr += text;
      bytes += chunk.length;
      if (bytes > limit) kill("Command output limit exceeded");
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    const timer = setTimeout(() => kill("Command timeout exceeded"), Math.min(maximum, requested));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: 1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: [stderr, reason].filter(Boolean).join("\n"), exitCode: reason ? 1 : code ?? 1 });
    });
  });
}
