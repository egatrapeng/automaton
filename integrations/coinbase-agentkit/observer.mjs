import fs from "node:fs";
import { pathToFileURL } from "node:url";

// The SDK runs only in this short-lived subprocess. No credentials or signer are supplied.
// Its generic SDK fetch path is restricted BEFORE importing the SDK, including telemetry.
const rawFetch = globalThis.fetch;
const allowed = new Set(["hermes.pyth.network", "api.llama.fi", "coins.llama.fi"]);
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(typeof url === "string" || url instanceof URL ? url : url.url);
  const method = options.method ?? (typeof url === "object" && "method" in url ? url.method : "GET");
  if (target.origin === "https://cca-lite.coinbase.com" && target.pathname === "/amp" && method.toUpperCase() === "POST") return new Response(null, { status: 204 }); // Drop SDK analytics locally; never transmit them.
  if (target.protocol !== "https:" || !allowed.has(target.hostname) || method.toUpperCase() !== "GET" || target.username || target.password || target.port) throw new Error("AgentKit observer permits only public price/protocol GET requests");
  const response = await rawFetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
  const reader = response.body?.getReader(); let size = 0; const chunks = [];
  if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("AgentKit response too large"); } chunks.push(value); }
  return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
};

export const TOPICS = new Set(["fetch_price_feed", "fetch_price", "get_token_prices", "find_protocol", "get_protocol"]);
export async function createObserver() {
  const { AgentKit, pythActionProvider, defillamaActionProvider } = await import("@coinbase/agentkit");
  const deny = async () => { throw new Error("Read-only AgentKit: signing and transfers are unavailable"); };
  // Structural WalletProvider: no superclass constructor, wallet telemetry, EOA, CDP account or default action provider.
  const wallet = { getAddress: () => "0x0000000000000000000000000000000000000000", getName: () => "read-only-market-data",
    getNetwork: () => ({ protocolFamily: "evm", chainId: "8453", networkId: "base-mainnet" }),
    getBalance: deny, nativeTransfer: deny, sendTransaction: deny, sign: deny, signMessage: deny, signTypedData: deny, signTransaction: deny };
  const kit = await AgentKit.from({ walletProvider: wallet, actionProviders: [pythActionProvider(), defillamaActionProvider()] });
  return { actions: kit.getActions(), wallet };
}

async function main() {
  const { actions, wallet } = await createObserver();
  if (process.argv.includes("--self-test")) {
    for (const forbidden of ["nativeTransfer", "sendTransaction", "sign", "signMessage", "signTransaction", "signTypedData"]) {
      let refused = false; try { await wallet[forbidden](); } catch { refused = true; } if (!refused) throw new Error("Unexpected signing capability");
    }
    if (!actions.length || actions.some(a => ![...TOPICS].some(t => a.name.endsWith(t)))) throw new Error("Unexpected AgentKit action exposed");
    console.log(JSON.stringify({ ok: true, actions: actions.map(a => a.name), signing: false, networkRequests: "none in self-test" })); return;
  }
  const input = fs.readFileSync(0, "utf8"); if (Buffer.byteLength(input) > 32768) throw new Error("Input too large");
  const request = JSON.parse(input);
  if (!TOPICS.has(request.action)) throw new Error("Only approved read-only AgentKit topics are available");
  const action = actions.find(a => a.name.endsWith(request.action));
  if (!action) throw new Error("Installed SDK does not expose the requested data action");
  const args = action.schema.parse(request.args);
  const result = await action.invoke(args);
  console.log(JSON.stringify({ source: "Coinbase AgentKit 0.10.4", action: request.action, result: typeof result === "string" ? result.slice(0, 60000) : result }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
