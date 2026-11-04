import { createPublicClient, encodeFunctionData, http, keccak256, type PrivateKeyAccount } from "viem";
import { getUsdcBalanceDetailed, x402Fetch, type X402PaymentResult } from "../conway/x402.js";
import { GuardianStore, atomic, digest, identifier } from "./store.js";
import { GuardianDenied, type GuardianConfig, type ServiceRequest, type WithdrawalRequest } from "./types.js";
import { refreshEurValuation } from "./valuation.js";
import { registerSecrets } from "../security/redaction.js";

const TRANSFER_ABI = [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }] as const;
const BALANCE_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;
const USDC = { "eip155:1": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" } as const;
type Rpc = ReturnType<typeof createPublicClient>;
function validateMerchantHeaders(headers: ServiceRequest["headers"]): void {
  if (headers === undefined) return;
  if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).length > 32) throw new GuardianDenied("INVALID_HEADERS", "Expected a bounded service header object");
  const forbidden = new Set(["host", "forwarded", "proxy-authorization", "proxy-connection", "connection", "upgrade", "content-length", "transfer-encoding", "te", "trailer", "x-original-url", "x-rewrite-url", "x-payment", "payment-signature", "idempotency-key"]);
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || typeof value !== "string" || value.length > 8192 || /[\r\n]/.test(value) || forbidden.has(name.toLowerCase()) || name.toLowerCase().startsWith("x-forwarded-")) throw new GuardianDenied("INVALID_HEADERS", "Service headers cannot override routing, transport, payment or idempotency authority");
  }
}

export class WalletGuardian {
  constructor(
    readonly config: GuardianConfig,
    readonly store: GuardianStore,
    private readonly account: PrivateKeyAccount,
    private readonly pay: typeof x402Fetch = x402Fetch,
    private readonly rpc: (network: WithdrawalRequest["network"]) => Rpc = (network) => createPublicClient({
      transport: http(network === "eip155:1" ? config.ethereumRpc : config.baseRpc, { timeout: 15_000, retryCount: 0 }),
    }),
  ) {
    if (account.address.toLowerCase() !== config.walletAddress.toLowerCase()) throw new Error("Guardian key does not match configured funding wallet");
    registerSecrets(config.ethereumRpc, config.baseRpc);
  }
  private blocked(id: string, error: unknown): never {
    const code = error instanceof GuardianDenied ? error.code : "POLICY_OR_SERVICE_ERROR";
    const message = error instanceof Error ? error.message : "Operation failed";
    this.store.deny(id, code, message);
    throw new GuardianDenied(code, message);
  }
  async service(request: ServiceRequest): Promise<X402PaymentResult & { replayed?: boolean }> {
    const id = identifier(request.operationId);
    if (!Number.isSafeInteger(request.maxPaymentCents) || request.maxPaymentCents < 0) throw new GuardianDenied("INVALID_BUDGET", "Invalid request cap");
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new GuardianDenied("INVALID_SERVICE", "Public HTTPS service URL without credentials required");
    const method = request.method ?? "GET";
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)) throw new GuardianDenied("INVALID_METHOD", "Unsupported method");
    if (request.body !== undefined && (typeof request.body !== "string" || Buffer.byteLength(request.body) > 64 * 1024)) throw new GuardianDenied("INVALID_BODY", "Service payload too large");
    // Persist a hash of request data, never API headers or raw service bodies in notifications.
    const normalized = { ...request, method };
    if (!this.store.begin(id, "service", normalized, { operationId: id, origin: url.origin, method, review: request.review })) {
      const previous = this.store.get(id)!;
      return { success: false, error: previous.hash === digest(normalized) ? `Operation already known: ${previous.state}; reconcile before another purchase` : "Operation payload changed; blocked", replayed: true };
    }
    try {
      validateMerchantHeaders(request.headers);
      const reserve = Math.max(this.config.minimumUsdcReserveCents ?? 0, request.minimumUsdcReserveCents ?? 0);
      if (!Number.isSafeInteger(reserve) || reserve < 0) throw new GuardianDenied("INVALID_BUDGET", "Invalid USDC reserve");
      let balanceAtomic: bigint | undefined;
      if (reserve > 0) {
        const balance = await getUsdcBalanceDetailed(this.account.address, "eip155:8453");
        if (!balance.ok || balance.balanceAtomic === undefined) throw new GuardianDenied("RESERVE_NOT_VERIFIED", "Cannot enforce USDC reserve without verified balance");
        balanceAtomic = BigInt(balance.balanceAtomic);
      }
      const result = await this.pay(request.url, this.account, method, request.body, request.headers,
        Math.min(request.maxPaymentCents, this.config.maxSinglePaymentCents), "evm", {
          operationId: id, ledgerPath: this.config.databaseFile + ".authorizations.db", expectedNetwork: "eip155:8453", networkPolicy: "public",
          allowedRecipients: request.allowedRecipients,
          // GuardianStore is authoritative for EUR, mission and step budgets. The
          // existing atomic ledger remains an additional USDC reservation boundary.
          budget: { maxHourlyCents: this.config.hourlyPaymentCents, maxDailyCents: Number.MAX_SAFE_INTEGER, minimumReserveCents: reserve, balanceAtomic },
          beforeSign: async quote => {
            try { await refreshEurValuation(this.config); this.store.authorizeService(id, quote, request.review, this.config); }
            catch (error) { this.blocked(id, error); }
          },
        });
      const row = this.store.get(id)!;
      if (row.state === "denied") return result;
      if (!result.success && row.state === "proposed" && (result.status === 402 || result.payment)) {
        this.store.deny(id, "PAYMENT_REFUSED", result.error ?? "Payment quote refused");
        return result;
      }
      if (result.payment && ["authorized", "uncertain", "accepted"].includes(result.payment.state)) {
        this.store.state(id, result.payment.state === "accepted" ? "accepted" : "uncertain");
      } else if (result.success) this.store.state(id, "accepted"); // Free request, amount remains null.
      else this.store.state(id, row.state === "authorizing" ? "uncertain" : "failed");
      return result;
    } catch (error) {
      // Conservatively retain a request that might already have reached a signer.
      const row = this.store.get(id);
      if (row?.state === "authorizing") this.store.state(id, "uncertain");
      else if (row?.state === "proposed") {
        if (error instanceof GuardianDenied) this.store.deny(id, error.code, error.message);
        else this.store.state(id, "failed");
      }
      throw error;
    }
  }
  requestWithdrawal(request: WithdrawalRequest): Record<string, unknown> {
    const id = identifier(request.operationId);
    if (!this.store.begin(id, "withdrawal", request, request)) {
      const previous = this.store.get(id)!;
      if (previous.hash !== digest(request)) throw new GuardianDenied("OPERATION_CHANGED", "Withdrawal payload changed; approval cannot be reused");
      return { operationId: id, state: previous.state, requestHash: previous.hash, transactionHash: previous.tx_hash, replayed: true };
    }
    try { this.store.requestWithdrawal(request, this.config); }
    catch (error) { this.blocked(id, error); }
    return { operationId: id, state: "awaiting_owner", requestHash: digest(request), message: "Known destination; authenticate this exact request on the trusted guardian console" };
  }
  /** No raw signing/contract-call endpoint is exposed. Only this fixed transfer template. */
  async executeWithdrawal(operationId: string): Promise<Record<string, unknown>> {
    const id = identifier(operationId);
    const row = this.store.get(id);
    if (!row) throw new GuardianDenied("UNKNOWN_OPERATION", "Unknown withdrawal");
    if (["authorizing", "broadcast", "uncertain", "confirmed", "reverted"].includes(row.state)) return { operationId: id, state: row.state, transactionHash: row.tx_hash, replayed: true };
    let request: WithdrawalRequest;
    try { request = this.store.claimWithdrawal(id, this.config); }
    catch (error) { this.blocked(id, error); }
    let signatureStarted = false;
    try {
      const client = this.rpc(request!.network);
      const chainId = request!.network === "eip155:1" ? 1 : 8453;
      if (await client.getChainId() !== chainId) throw new Error("RPC chain mismatch");
      const account = this.account;
      const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
      if (nonce !== await client.getTransactionCount({ address: account.address, blockTag: "latest" })) throw new Error("A withdrawal is already pending; reconcile first");
      const amount = atomic(request!.amountAtomic);
      const to = request!.asset === "ETH" ? request!.recipient as `0x${string}` : USDC[request!.network];
      const value = request!.asset === "ETH" ? amount : 0n;
      const data = request!.asset === "USDC" ? encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [request!.recipient as `0x${string}`, amount] }) : undefined;
      if (request!.asset === "USDC") {
        const balance = await client.readContract({ address: to, abi: BALANCE_ABI, functionName: "balanceOf", args: [account.address] });
        if (balance < amount) throw new Error("Insufficient USDC");
      }
      const estimate = await client.estimateGas({ account: account.address, to, value, data });
      const gas = estimate + estimate / 5n + 1n;
      const fees = await client.estimateFeesPerGas();
      const fee = gas * fees.maxFeePerGas;
      if (fee > atomic(request!.maxGasFeeAtomic) || fee > atomic(this.config.maxWithdrawalGasWei)) throw new Error("Fees exceed exact owner-approved maximum");
      if (await client.getBalance({ address: account.address, blockTag: "pending" }) < value + fee) throw new Error("Insufficient ETH for transfer and fees");
      if ((this.store.get(id)?.expires_at ?? 0) <= Date.now()) throw new Error("Owner approval expired during transaction preparation");
      signatureStarted = true;
      const signed = await account.signTransaction({ type: "eip1559", chainId, nonce, to, value, data, gas,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      const hash = keccak256(signed);
      // Store hash BEFORE broadcast; a timeout/restart must not create another transaction.
      this.store.state(id, "uncertain", hash);
      const returnedHash = await client.sendRawTransaction({ serializedTransaction: signed });
      if (returnedHash !== hash) throw new Error("RPC transaction hash mismatch; reconcile before retry");
      this.store.state(id, "broadcast", hash);
      return { operationId: id, state: "broadcast", transactionHash: hash, message: "Broadcast is not confirmation; verify receipt" };
    } catch (error) {
      // The single-use owner approval is consumed. Never silently retry a
      // withdrawal after a signer/RPC error; a new approval requires review.
      if (signatureStarted) this.store.state(id, "uncertain");
      else {
        this.store.failBeforeWithdrawalSignature(id);
        this.store.deny(id, "WITHDRAWAL_PREPARATION_REFUSED", error instanceof Error ? error.message : "Withdrawal not signed");
      }
      throw new GuardianDenied("WITHDRAWAL_NOT_CONFIRMED", error instanceof Error ? error.message : "Withdrawal outcome unknown");
    }
  }
  /** Receipt lookup never signs, rebroadcasts or creates another transaction. */
  async reconcileWithdrawal(operationId: string): Promise<void> {
    const row = this.store.get(operationId);
    if (!row || row.kind !== "withdrawal" || !row.tx_hash || !["broadcast", "uncertain"].includes(row.state)) return;
    const request = JSON.parse(row.data) as WithdrawalRequest;
    const client = this.rpc(request.network);
    const expectedChain = request.network === "eip155:1" ? 1 : 8453;
    if (await client.getChainId() !== expectedChain) throw new Error("RPC chain mismatch");
    const receipt = await client.getTransactionReceipt({ hash: row.tx_hash as `0x${string}` });
    const height = await client.getBlockNumber();
    if (receipt.transactionHash.toLowerCase() !== row.tx_hash.toLowerCase() || height < receipt.blockNumber + 11n) return;
    this.store.db.transaction(() => {
      const state = receipt.status === "success" ? "confirmed" : "reverted";
      this.store.db.prepare("UPDATE guardian_requests SET state=? WHERE id=? AND tx_hash=? AND state IN ('broadcast','uncertain')").run(state, row.id, row.tx_hash);
      this.store.event(row.id, state, { txHash: row.tx_hash, confirmations: (height - receipt.blockNumber + 1n).toString() });
    }).immediate();
  }
}
