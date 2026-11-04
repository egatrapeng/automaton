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

function readPrivate(filename: string): string {
  if (!fs.lstatSync(filename).isFile()) throw new Error("Expected a regular private file");
  const stat = fs.statSync(filename);
  if (stat.mode & 0o077) throw new Error("Guardian configuration/keys must be mode 0600");
  return fs.readFileSync(filename, "utf8");
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    directory: { type: "string" }, owner: { type: "string" }, file: { type: "string" }, id: { type: "string" }, hash: { type: "string" }, recipient: { type: "string" }, after: { type: "string" },
  } });
  const command = positionals[0];
  if (!command || command === "help") {
    console.log("Trusted signer host only. Commands: init --directory ABS --owner ADDRESS; status; serve; approve-goal --file PLAN.json; revoke-goal --id ID; inspect --id ID; approve-withdrawal --id ID --hash EXACT_HASH --recipient OWNER; events [--after SEQUENCE]. All commands require --directory ABS. Never install the funded guardian under an agent-controlled account/host."); return;
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
  const store = new GuardianStore(config.databaseFile);
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
    const server = createGuardianServer(new WalletGuardian(config, store, account), token);
    server.listen(config.port, "127.0.0.1", () => console.log("Guardian listening on loopback; use a trusted HTTPS reverse proxy. No public key export or generic signing API."));
    const stop = () => { server.close(() => { store.close(); process.exit(0); }); };
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    return;
  } else throw new Error("Unknown guardian command");
  store.close();
}

main().catch(() => { console.error("Guardian command failed. Check private configuration, exact approvals and policy; no credentials are printed."); process.exitCode = 1; });
