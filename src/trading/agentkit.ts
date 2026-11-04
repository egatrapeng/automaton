import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ACTIONS = new Set(["fetch_price_feed", "fetch_price", "get_token_prices", "find_protocol", "get_protocol"]);
export async function agentkitRead(action: string, args: unknown, root = process.cwd()): Promise<string> {
  if (!ACTIONS.has(action)) throw new Error("AgentKit action is not a read-only market-data action");
  const directory = path.join(root, "integrations/coinbase-agentkit"), script = path.join(directory, "observer.mjs");
  if (!fs.existsSync(path.join(directory, "node_modules/@coinbase/agentkit/package.json"))) throw new Error("Optional AgentKit observer is not installed; run npm ci --ignore-scripts in integrations/coinbase-agentkit. Core trading uses its native read adapters and does not need CDP credentials.");
  const environment: Record<string, string> = { NODE_OPTIONS: "--max-old-space-size=256" };
  // Preserve proxy/CA trust; do not pass inference, wallet, API or client credentials into the SDK process.
  for (const name of ["PATH", "HOME", "LANG", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"]) if (process.env[name]) environment[name] = process.env[name]!;
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [script], { cwd: directory, env: environment, timeout: 45000, maxBuffer: 128 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error("AgentKit observer failed or data source unavailable; no signing fallback")); return; }
      resolve(stdout.trim());
    });
    child.stdin!.end(JSON.stringify({ action, args }));
  });
}
