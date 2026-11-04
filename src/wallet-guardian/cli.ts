#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isAddress } from "viem";
import { GuardianStore, validatePolicy } from "./store.js";
import { WalletGuardian } from "./service.js";
import { createGuardianServer } from "./server.js";
import type { ApprovedGoal, GuardianConfig } from "./types.js";
import { registerSecrets } from "../security/redaction.js";
import { DEFAULT_TRADING_POLICY, validateTradingPolicy } from "../trading/types.js";
import { tradingDoctor } from "../trading/doctor.js";

function readPrivate(filename: string): string {
  if (!fs.lstatSync(filename).isFile()) throw new Error("Expected a regular private file");
  const stat = fs.statSync(filename);
  if (stat.mode & 0o077) throw new Error("Guardian configuration/keys must be mode 0600");
  return fs.readFileSync(filename, "utf8");
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    directory: { type: "string" }, owner: { type: "string" }, file: { type: "string" }, id: { type: "string" }, hash: { type: "string" }, recipient: { type: "string" }, after: { type: "string" }, mode: { type: "string" },
  } });
  const command = positionals[0];
  if (!command || command === "help") {
    console.log("Trusted signer host only. Commands: init --directory ABS --owner ADDRESS; init-observer; status; serve; trading-configure --mode paper|live|off [--file POLICY.json]; trading-report; trading-doctor (public reads only); approve-goal --file PLAN.json; revoke-goal --id ID; inspect --id ID; approve-withdrawal --id ID --hash EXACT_HASH --recipient OWNER; events [--after SEQUENCE]. All commands require --directory ABS. Never install the funded guardian under an agent-controlled account/host."); return;
  }
  if (!values.directory || !path.isAbsolute(values.directory)) throw new Error("Explicit absolute guardian directory required");
  const directory = values.directory;
  const filename = path.join(directory, "guardian-policy.json");
  if (command === "init") {
    if (!values.owner || !isAddress(values.owner, { strict: false }) || /^0x0{40}$/i.test(values.owner)) throw new Error("Explicit owner MetaMask address required");
    if (fs.existsSync(directory)) throw new Error("Choose a new private directory; existing files are never overwritten");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
    const privateKey = generatePrivateKey(); const wallet = privateKeyToAccount(privateKey);
    const config: GuardianConfig = {
      walletAddress: wallet.address, ownerAddress: values.owner, walletFile: path.join(directory, "wallet.json"),
      tokenFile: path.join(directory, "agent-client.key"), databaseFile: path.join(directory, "guardian.db"), port: 8787,
      ethereumRpc: "https://ethereum-rpc.publicnode.com", baseRpc: "https://mainnet.base.org",
      maxSinglePaymentCents: 100, hourlyPaymentCents: 1000, dailyPaymentCents: 1000, dailyCurrency: "EUR", eurValuation: "coingecko", minimumUsdcReserveCents: 0,
      // Operator must review the fixed read-only price source and approve a
      // bounded mission. Missing/stale market data never gets a guessed rate.
      maxWithdrawalGasWei: "100000000000000", allowedWithdrawalNetworks: ["eip155:8453"],
    };
    fs.writeFileSync(config.walletFile, JSON.stringify({ privateKey }), { flag: "wx", mode: 0o600 });
    fs.writeFileSync(config.tokenFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    fs.writeFileSync(filename, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ walletAddress: wallet.address, ownerAddress: values.owner, policyFile: filename,
      message: "New guardian wallet. No funds moved, server not started. Review EUR price source (CoinGecko), approve a mission and install outside agent's authority before funding. Client token file is private; never paste it in chat." }, null, 2)); return;
  }
  const config = JSON.parse(readPrivate(filename)) as GuardianConfig;
  validatePolicy(config);
  if (command === "trading-doctor") { console.log(JSON.stringify(await tradingDoctor(config), null, 2)); return; }
  const store = new GuardianStore(config.databaseFile);
  if (command === "trading-configure") {
    if (!["paper", "live", "off"].includes(values.mode ?? "")) throw new Error("Explicit trading mode required");
    const proposed = values.file ? JSON.parse(fs.readFileSync(values.file, "utf8")) : {};
    if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) throw new Error("Trading policy object required");
    const policy = { ...DEFAULT_TRADING_POLICY, ...config.trading, ...proposed, mode: values.mode };
    if (values.mode !== "off") validateTradingPolicy(policy);
    const updated = { ...config, trading: values.mode === "off" ? undefined : policy };
    const stamp = Date.now() + "-" + randomBytes(4).toString("hex");
    fs.writeFileSync(filename + ".before-trading-" + stamp, readPrivate(filename), { flag: "wx", mode: 0o600 });
    const temporary = filename + ".new-" + stamp;
    fs.writeFileSync(temporary, JSON.stringify(updated, null, 2), { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, filename);
    store.event("trading", "owner_trading_policy", { mode: values.mode, policy: values.mode === "off" ? null : policy,
      authority: "trusted-owner-console", capital: "supported wallet less gas reserve and unexpired service reservations" });
    console.log("Trading policy saved with private backup. Restart only guardian to apply. Live mode can trade the entire supported pocket without per-order approvals; market losses are not capped unless configured. No order sent by this command.");
    store.close(); return;
  }
  if (command === "trading-report") {
    const row = store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='trading_state'").get();
    const data = row ? store.db.prepare("SELECT data FROM trading_state WHERE key='report'").get() as { data: string } | undefined : undefined;
    const report = data ? JSON.parse(data.data) : {};
    const active = row ? store.db.prepare("SELECT id,state,created_at FROM trading_cycles WHERE state IN ('executing','uncertain') LIMIT 1").get() : null;
    console.log(JSON.stringify({ ...report, configuredMode: config.trading?.mode ?? "disabled", activeCycle: active ?? null,
      mode: config.trading?.mode ?? "disabled", state: !config.trading ? "disabled" : report.mode && report.mode !== config.trading.mode ? "policy_changed" : report.state ?? "not_observed" })); store.close(); return;
  }
  if (command === "init-observer") {
    if (config.observerTokenFile) throw new Error("Observer token already configured; rotate it by replacing its private file");
    const observerFile = path.join(directory, "observer-client.key");
    fs.writeFileSync(observerFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    const updated = { ...config, observerTokenFile: observerFile };
    fs.writeFileSync(filename + ".new", JSON.stringify(updated, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(filename + ".new", filename);
    console.log("Read-only observer token created (GET status/goals/events only). Restart the guardian. The token is never printed.");
    store.close(); return;
  }
  if (command === "approve-goal") {
    if (!values.file) throw new Error("Review a plan JSON and pass --file");
    store.approveGoal(JSON.parse(fs.readFileSync(values.file, "utf8")) as ApprovedGoal);
    console.log("Owner mission approved by trusted console. Review is bound to its stored plan hash and limits.");
  } else if (command === "revoke-goal") {
    if (!values.id) throw new Error("Exact approved goal id required");
    store.revokeGoal(values.id);
    console.log("Goal revoked for new authorizations. Already authorized payments remain subject to settlement.");
  } else if (command === "approve-withdrawal") {
    if (!values.id || !values.hash || !values.recipient) throw new Error("Exact pending id, request hash and owner destination required");
    store.approveWithdrawal(values.id, values.hash, values.recipient, config);
    console.log("Exact withdrawal approved for 15 minutes, single use. No broadcast performed by this command.");
  } else if (command === "status") console.log(JSON.stringify({ walletAddress: config.walletAddress, ownerAddress: config.ownerAddress, goals: store.goals() }, null, 2));
  else if (command === "events") console.log(JSON.stringify(store.events(Number(values.after ?? 0)), null, 2));
  else if (command === "inspect") {
    if (!values.id) throw new Error("Exact operation id required");
    const row = store.get(values.id);
    if (!row) throw new Error("Unknown operation");
    console.log(JSON.stringify({ operationId: row.id, requestHash: row.hash, state: row.state, transactionHash: row.tx_hash,
      request: JSON.parse(row.data), trace: store.trace(values.id) }, null, 2));
  }
  else if (command === "serve") {
    const wallet = JSON.parse(readPrivate(config.walletFile)); registerSecrets(wallet.privateKey);
    const account = privateKeyToAccount(wallet.privateKey);
    const token = readPrivate(config.tokenFile).trim(); registerSecrets(token);
    const observerToken = config.observerTokenFile ? readPrivate(config.observerTokenFile).trim() : undefined;
    if (observerToken) registerSecrets(observerToken);
    const tradingGuardian = new WalletGuardian(config, store, account);
    const server = createGuardianServer(tradingGuardian, token, observerToken);
    // Keep the independent strategy engine alive even while the inference agent sleeps.
    let tradingTimer: NodeJS.Timeout | undefined;
    if (config.trading) {
      validateTradingPolicy(config.trading);
      const tick = () => { void tradingGuardian.trading.tick().catch(() => console.error("Trading tick failed; inspect the private audit")); };
      server.once("listening", tick); tradingTimer = setInterval(tick, 30000); tradingTimer.unref();
    }
    server.listen(config.port, "127.0.0.1", () => console.log("Guardian listening on loopback; use a trusted HTTPS reverse proxy. No public key export or generic signing API."));
    let stopping = false;
    const stop = () => {
      if (stopping) return; stopping = true;
      if (tradingTimer) clearInterval(tradingTimer);
      server.close(() => { void tradingGuardian.trading.drain().finally(() => { store.close(); process.exit(0); }); });
    };
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    return;
  } else throw new Error("Unknown guardian command");
  store.close();
}

main().catch(() => { console.error("Guardian command failed. Check private configuration, exact approvals and policy; no credentials are printed."); process.exitCode = 1; });
