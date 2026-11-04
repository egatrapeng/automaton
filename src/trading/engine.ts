import { decodeEventLog, encodeFunctionData, keccak256, type Address, type Hex, type PrivateKeyAccount } from "viem";
import type { GuardianConfig } from "../wallet-guardian/types.js";
import { GuardianStore } from "../wallet-guardian/store.js";
import { redactText } from "../security/redaction.js";
import { BASE_QUOTER, BASE_ROUTER, BASE_USDC, BASE_WETH, ERC20_ABI, POOL_FEE,
  QUOTER_ABI, ROUTER_ABI, checkTradingDeployment, readWallet, rollupFee, tradingRpc, type TradeReceipt, type TradeRpc } from "./base.js";
import { fetchCandles } from "./market.js";
import { selectStrategy } from "./study.js";
import { TradingStore } from "./store.js";
import { validateTradingPolicy, type Candle, type TradingPolicy, type WalletSnapshot } from "./types.js";

type Tx = { to: Address; data: Hex; value: bigint };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v));

/** Owns study, quotes and fixed swap templates on the trusted signer host. Agent text never selects calldata. */
export class TradingEngine {
  readonly state: TradingStore;
  private inFlight = false;
  constructor(readonly config: GuardianConfig, readonly guardian: GuardianStore, private readonly account: PrivateKeyAccount,
    private readonly rpc: TradeRpc = tradingRpc(config.baseRpc), private readonly market: () => Promise<Candle[]> = fetchCandles,
    private readonly now: () => number = Date.now,
    private readonly study: typeof selectStrategy = selectStrategy) { this.state = new TradingStore(guardian.db); }

  report(): any {
    const report = this.state.get<any>("report");
    if (!this.config.trading) return { ...report, version: 1, mode: "disabled", state: "disabled", reason: "Trading not enabled by the owner", walletAddress: this.config.walletAddress, chainId: 8453, updatedAt: report?.updatedAt ?? null };
    if (report && report.mode !== this.config.trading.mode) return { ...report, mode: this.config.trading.mode, state: "policy_changed", observationMode: report.mode,
      reason: "Configured mode changed; cached market observation belongs to the previous mode", activeCycle: this.state.active() ?? null };
    return report ? { ...report, activeCycle: this.state.active() ?? null } : { version: 1, mode: this.config.trading.mode, state: "not_observed", walletAddress: this.config.walletAddress, chainId: 8453,
      scope: "ETH/WETH and canonical USDC on Base only", updatedAt: null };
  }
  async drain(timeoutMs = 120000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.inFlight && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
  }
  async tick(): Promise<any> {
    if (!this.config.trading) { await this.reconcile(); return this.report(); }
    if (this.inFlight) return { ...this.report(), busy: true };
    const policy = this.config.trading; validateTradingPolicy(policy);
    const previous = this.report(), now = this.now();
    if (previous.nextCheckAt > now && JSON.stringify(previous.policy) === JSON.stringify(policy)) return previous;
    this.inFlight = true;
    let cycle: string | undefined;
    try {
      await this.reconcile();
      if (this.state.active()) return this.save({ state: "paused", reason: "A signed or interrupted cycle must be reconciled before any new order" }, policy);
      const candles = await this.market(), price = candles.at(-1)!.close;
      const wallet = await readWallet(this.rpc, this.account.address, price, policy);
      const deployment = await this.checkDeployment();
      const book = this.state.observe(wallet);
      const reserved = this.state.reservedUsdc();
      const available = wallet.spendableQuote - Math.min(Number(reserved) / 1e6, Number(wallet.usdcAtomic) / 1e6);
      const fields = { wallet: { ...wallet, usdcReservedAtomic: String(reserved), availableForTradingQuote: Math.max(0, available) }, performance: book,
        market: { priceQuote: price, lastClosedBar: candles.at(-1), candles: candles.length, pool: deployment, poolFeeBps: POOL_FEE / 100, volumeUnit: "ETH per five-minute Coinbase candle; liquidity is active pool units, not USD TVL" },
        exposures: { ethQuote: Number(BigInt(wallet.nativeWei) + BigInt(wallet.wethAtomic)) / 1e18 * price, usdcQuote: Number(wallet.usdcAtomic) / 1e6 },
        accounting: "USDC-valued estimates. Net external flows valued at observation time; intra-interval flow timing and some rollup fees may be estimated. Not tax accounting.",
        spendingBudget: { serviceDailyCurrency: this.config.dailyCurrency, serviceDailyCents: this.config.dailyPaymentCents, tradingCapital: "entire supported wallet less gas reserve and unexpired service reservations" } };
      if (available < Math.max(policy.minimumOrderCents / 100, policy.studyGasQuote * 2)) return this.save({ ...fields, state: "capital_low",
        reason: "Not enough spendable capital; preserve the native gas reserve. The agent is not dead and inference is a separate budget." }, policy, 3600000);
      const study = this.study(candles, available, policy);
      this.guardian.event("trading", "trading_study", { mode: policy.mode, strategy: study.strategy, eligible: study.eligible, dataHash: study.dataHash, outOfSample: study.outOfSample });
      const day = new Date(now).toISOString().slice(0, 10);
      let daily = this.state.get<any>("daily");
      if (daily?.day !== day) { daily = { day, pnl: book.estimatedNetPnlQuote, equity: wallet.equityQuote }; this.state.set("daily", daily); }
      if (policy.maxDailyLossBps !== null && daily.equity > 0 && daily.pnl - book.estimatedNetPnlQuote >= daily.equity * policy.maxDailyLossBps / 10000) return this.save({ ...fields, study, state: "loss_breaker", reason: "Owner-configured estimated daily loss limit reached; no forced liquidation" }, policy);
      if (policy.mode === "paper") {
        this.paper(candles.at(-1)!.time, price, study.eligible ? study.target : undefined, Math.max(0, available), policy);
        return this.save({ ...fields, study, paper: this.state.get("paper"), state: "paper", reason: study.eligible ? "Prospective virtual orders only; no signature, approval or transfer" : study.reason + "; existing virtual holdings marked to market, no new order" }, policy);
      }
      if (!study.eligible) return this.save({ ...fields, study, state: "hold", reason: study.reason }, policy);
      if (this.state.withdrawalPending()) return this.save({ ...fields, study, state: "paused", reason: "Reconcile the pending owner withdrawal first" }, policy);
      if (this.state.countOrders(now) >= policy.maxOrdersPerDay) return this.save({ ...fields, study, state: "order_limit", reason: "Rolling 24-hour order count reached" }, policy);
      const order = this.chooseOrder(study.target, wallet, reserved, policy);
      if (!order) return this.save({ ...fields, study, state: "hold", reason: "Target allocation already held or only dust/reserved funds remain" }, policy);
      cycle = this.state.cycleId(candles.at(-1)!.time);
      if (!this.state.acquire(cycle, { study, target: study.target, dataHash: study.dataHash }, now)) return this.save({ ...fields, study, state: "hold", reason: "This candle was already processed or another cycle owns the wallet" }, policy);
      // Re-read under the wallet lease: service purchases cannot issue new signatures while it is held.
      const fresh = await readWallet(this.rpc, this.account.address, price, policy);
      const current = this.chooseOrder(study.target, fresh, this.state.reservedUsdc(), policy);
      if (!current) { this.state.finish(cycle, "completed"); return this.save({ ...fields, study, state: "hold", reason: "Balance changed before reservation" }, policy); }
      this.guardian.event(cycle, "trading_authorized", { source: "independent fixed strategy engine", study, order: json(current), recipient: this.account.address, router: BASE_ROUTER,
        notification: "Recorded before any signature", lossBudget: policy.maxDailyLossBps === null ? "No daily loss cap; entire trading pocket exposed to market losses" : policy.maxDailyLossBps });
      if (!current.native) {
        // Exact input allowance, never MaxUint256 and never a caller-selected spender.
        await this.send(cycle, "approve", { to: current.tokenIn, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [BASE_ROUTER, current.amount] }) }, price, policy);
      }
      const quoteAt = this.now();
      const quote = await this.quote(current.tokenIn, current.tokenOut, current.amount);
      const expected = current.tokenIn === BASE_USDC ? Number(current.amount) / 1e6 / price * 1e18 : Number(current.amount) / 1e18 * price * 1e6;
      if (Math.abs(Number(quote) - expected) / expected * 10000 > policy.maxQuoteDeviationBps) throw new Error("Uniswap quote deviates from independent market reference; price impact/market disagreement too large");
      const minimum = quote * BigInt(10000 - policy.maxSlippageBps) / 10000n;
      if (minimum <= 0n) throw new Error("Zero minimum output refused");
      const deadline = Math.floor(quoteAt / 1000) + 90;
      const swap = encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [{ tokenIn: current.tokenIn, tokenOut: current.tokenOut,
        fee: POOL_FEE, recipient: this.account.address, amountIn: current.amount, amountOutMinimum: minimum, sqrtPriceLimitX96: 0n }] });
      const calls = current.native ? [swap, encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" })] : [swap];
      const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [BigInt(deadline), calls] });
      await this.send(cycle, "swap", { to: BASE_ROUTER, data, value: current.native ? current.amount : 0n }, price, policy, quoteAt);
      this.state.finish(cycle, "completed");
      const after = await readWallet(this.rpc, this.account.address, price, policy); const performance = this.state.observe(after);
      return this.save({ ...fields, wallet: { ...after, usdcReservedAtomic: String(this.state.reservedUsdc()) }, performance, study,
        exposures: { ethQuote: Number(BigInt(after.nativeWei) + BigInt(after.wethAtomic)) / 1e18 * price, usdcQuote: Number(after.usdcAtomic) / 1e6 },
        state: "executed", operationId: cycle, reason: "Fixed swap confirmed on Base; proceeds returned to the same wallet" }, policy);
    } catch (error) {
      const active = this.state.active();
      if (cycle && active?.id === cycle) {
        const unresolved = this.state.txs(cycle).some(t => ["signed", "uncertain"].includes(t.state));
        this.state.finish(cycle, unresolved ? "uncertain" : "failed");
      }
      const reason = redactText(error instanceof Error ? error.message : "Trading unavailable");
      this.guardian.event("trading", "trading_paused", { reason, operationId: cycle, action: "Inspect and reconcile; never blindly repeat a transaction" });
      return this.save({ state: "unavailable", reason, operationId: cycle, dataAvailable: false }, policy);
    } finally { this.inFlight = false; }
  }

  async checkDeployment(): Promise<{ pool: Address; liquidity: string }> {
    return checkTradingDeployment(this.rpc);
  }

  async quote(tokenIn: Address, tokenOut: Address, amount: bigint): Promise<bigint> {
    const { result } = await this.rpc.simulateContract({ account: this.account.address, address: BASE_QUOTER, abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn: amount, fee: POOL_FEE, sqrtPriceLimitX96: 0n }] });
    if (!Array.isArray(result) || typeof result[0] !== "bigint" || result[0] <= 0n) throw new Error("No positive executable Uniswap quote");
    return result[0];
  }
  private chooseOrder(target: "ETH" | "USDC", w: WalletSnapshot, reserved: bigint, p: TradingPolicy) {
    const fraction = (n: bigint) => n * BigInt(p.allocationBps) / 10000n;
    const cash = BigInt(w.usdcAtomic) > reserved ? BigInt(w.usdcAtomic) - reserved : 0n;
    if (target === "ETH") {
      const amount = fraction(cash); if (Number(amount) / 1e6 < p.minimumOrderCents / 100) return null;
      return { tokenIn: BASE_USDC, tokenOut: BASE_WETH, amount, native: false };
    }
    const weth = fraction(BigInt(w.wethAtomic));
    if (Number(weth) / 1e18 * w.priceQuote >= p.minimumOrderCents / 100) return { tokenIn: BASE_WETH, tokenOut: BASE_USDC, amount: weth, native: false };
    const native = BigInt(w.nativeWei), reserve = BigInt(p.nativeReserveWei);
    const amount = fraction(native > reserve ? native - reserve : 0n);
    if (Number(amount) / 1e18 * w.priceQuote < p.minimumOrderCents / 100) return null;
    return { tokenIn: BASE_WETH, tokenOut: BASE_USDC, amount, native: true };
  }

  private async send(cycle: string, stage: string, tx: Tx, price: number, p: TradingPolicy, quoteAt?: number): Promise<void> {
    this.state.assertLease(cycle);
    const pending = await this.rpc.getTransactionCount({ address: this.account.address, blockTag: "pending" });
    if (pending !== await this.rpc.getTransactionCount({ address: this.account.address, blockTag: "latest" })) throw new Error("Pending wallet nonce; reconcile first");
    const gasEstimate = await this.rpc.estimateGas({ account: this.account.address, ...tx });
    const gas = gasEstimate + gasEstimate / 5n + 1n;
    const fees = await this.rpc.estimateFeesPerGas();
    if (fees.maxFeePerGas <= 0n || fees.maxPriorityFeePerGas < 0n || fees.maxPriorityFeePerGas > fees.maxFeePerGas) throw new Error("Invalid gas quote");
    const prepared = { ...tx, gas, ...fees, nonce: pending };
    const rollup = await rollupFee(this.rpc, prepared), estimatedFee = gas * fees.maxFeePerGas + rollup;
    if (estimatedFee > BigInt(p.maxGasFeeWei)) throw new Error("Estimated Base transaction fee exceeds trading policy");
    if (await this.rpc.getBalance({ address: this.account.address, blockTag: "pending" }) < tx.value + estimatedFee) throw new Error("Insufficient ETH for value and estimated Base fees");
    if (quoteAt !== undefined && this.now() - quoteAt > 30000) throw new Error("Swap quote expired before signature");
    this.state.assertLease(cycle);
    const id = this.state.reserveTx(cycle, stage, json({ ...prepared, priceQuote: price, estimatedRollupFee: String(rollup) }));
    let signing = false;
    try {
      if (!this.config.trading || this.config.trading.mode !== "live") throw new Error("Live trading disabled");
      if (await this.rpc.getTransactionCount({ address: this.account.address, blockTag: "pending" }) !== pending) throw new Error("Nonce changed during preparation");
      this.guardian.event(cycle, "trading_signature_authorized", { stage, to: tx.to, value: String(tx.value), recipient: this.account.address, estimatedFee: String(estimatedFee) });
      signing = true;
      const signed = await this.account.signTransaction({ ...prepared, type: "eip1559", chainId: 8453 });
      const hash = keccak256(signed);
      this.state.txState(id, "signed", hash); // durable BEFORE broadcast; no resubmission path exists.
      if (!same(await this.rpc.sendRawTransaction({ serializedTransaction: signed }), hash)) throw new Error("RPC returned a different transaction hash");
      const receipt = await this.rpc.waitForTransactionReceipt({ hash, confirmations: 12, timeout: 45000 });
      this.applyReceipt(id, receipt);
      if (receipt.status !== "success") throw new Error("Trading transaction reverted; approval/swap is not repeated");
    } catch (error) {
      const row = this.state.txs(cycle).find(t => t.id === id)!;
      if (!["confirmed", "reverted"].includes(row.state)) this.state.txState(id, signing ? "uncertain" : "failed");
      throw error;
    }
  }

  private applyReceipt(id: string, receipt: TradeReceipt): void {
    this.state.db.transaction(() => {
      const row = this.state.txs().find(t => t.id === id);
      if (!row || ["confirmed", "reverted"].includes(row.state)) return;
      if (!row.hash || !same(receipt.transactionHash, row.hash)) throw new Error("Receipt hash mismatch");
      const meta = JSON.parse(row.data), old = this.state.get<WalletSnapshot>("wallet");
      let usdc = 0n, weth = 0n;
      for (const log of receipt.logs) {
        if (![BASE_USDC, BASE_WETH].some(a => same(a, log.address))) continue;
        try {
          const e = decodeEventLog({ abi: ERC20_ABI, eventName: "Transfer", data: log.data, topics: log.topics as [Hex, ...Hex[]] });
          const delta = (same(e.args.to, this.account.address) ? e.args.value : 0n) - (same(e.args.from, this.account.address) ? e.args.value : 0n);
          if (same(log.address, BASE_USDC)) usdc += delta; else weth += delta;
        } catch { /* Only canonical Transfer events affect this ledger. */ }
      }
      const rollupFeeEstimated = receipt.l1Fee === undefined || receipt.operatorFee === undefined;
      const fee = receipt.gasUsed * receipt.effectiveGasPrice + (rollupFeeEstimated ? BigInt(meta.estimatedRollupFee) : receipt.l1Fee! + receipt.operatorFee!);
      const native = (receipt.status === "success" ? -BigInt(meta.value) : 0n) - fee;
      const impact = Number(usdc) / 1e6 + Number(weth + native) / 1e18 * meta.priceQuote;
      if (old) {
        this.state.recordExecutionPnl(impact, old.equityQuote);
        this.state.set("wallet", { ...old, nativeWei: String(BigInt(old.nativeWei) + native), wethAtomic: String(BigInt(old.wethAtomic) + weth),
          usdcAtomic: String(BigInt(old.usdcAtomic) + usdc), equityQuote: old.equityQuote + impact, block: String(receipt.blockNumber) });
      }
      this.state.txState(id, receipt.status === "success" ? "confirmed" : "reverted");
      this.guardian.event(row.cycle_id, "trading_receipt", { stage: row.stage, state: receipt.status, transactionHash: receipt.transactionHash,
        nativeFeeWei: String(fee), rollupFeeEstimated, executionImpactQuote: impact, usdcDelta: String(usdc), wethDelta: String(weth), confirmations: 12 });
    }).immediate();
  }
  private async reconcile(): Promise<void> {
    const active = this.state.active(); if (!active) return;
    let unresolved = false;
    for (const row of this.state.txs(active.id)) {
      if (!["signed", "uncertain"].includes(row.state)) continue;
      if (!row.hash) {
        // This implementation persists the hash before it can call sendRawTransaction.
        // A crashed local signer with no hash therefore cannot have broadcast via this path.
        if (this.now() - active.created_at > 15 * 60000) this.state.txState(row.id, "failed");
        else unresolved = true;
        continue;
      }
      try {
        const receipt = await this.rpc.getTransactionReceipt({ hash: row.hash as Hex }), head = await this.rpc.getBlockNumber();
        if (head < receipt.blockNumber + 11n) { unresolved = true; continue; }
        this.applyReceipt(row.id, receipt);
      } catch { unresolved = true; }
    }
    // Do not resume a half-finished strategy. Only observe already-signed receipts.
    if (!unresolved && (active.state === "uncertain" || this.now() - active.created_at > 15 * 60000)) this.state.finish(active.id, "failed");
  }
  private paper(bar: number, price: number, target: "ETH" | "USDC" | undefined, capital: number, p: TradingPolicy): void {
    const friction = (p.studyFeeBps + p.studySlippageBps) / 10000;
    const state = this.state.get<any>("paper") ?? { initialQuote: capital, cashQuote: capital, eth: 0, feesQuote: 0, trades: 0, startedAt: this.now(),
      benchmarkEth: Math.max(0, capital - p.studyGasQuote) / (price * (1 + friction)), benchmarkCosts: "Modeled entry costs; both portfolios marked to market without hypothetical exit costs", lastBar: 0 };
    if (state.lastBar >= bar) return;
    if (target === "ETH" && state.eth === 0 && state.cashQuote * p.allocationBps / 10000 > p.studyGasQuote * 2) {
      const spend = state.cashQuote * p.allocationBps / 10000;
      state.eth = (spend - p.studyGasQuote) / (price * (1 + friction)); state.cashQuote -= spend;
      state.feesQuote += p.studyGasQuote + state.eth * price * friction; state.trades++;
    } else if (target === "USDC" && state.eth > 0) {
      const gross = state.eth * price, cost = gross * friction + p.studyGasQuote;
      state.cashQuote += Math.max(0, gross - cost); state.eth = 0; state.feesQuote += Math.min(cost, gross); state.trades++;
    }
    state.lastBar = bar; state.equityQuote = state.cashQuote + state.eth * price;
    state.netPnlQuote = state.equityQuote - state.initialQuote; state.benchmarkPnlQuote = state.benchmarkEth * price - state.initialQuote;
    state.peakQuote = Math.max(state.peakQuote ?? state.initialQuote, state.equityQuote);
    state.maxDrawdownPct = Math.max(state.maxDrawdownPct ?? 0, 100 * (state.peakQuote - state.equityQuote) / state.peakQuote);
    state.virtual = true; this.state.set("paper", state);
  }
  private save(fields: Record<string, unknown>, p: TradingPolicy, delay?: number): any {
    const report = { version: 1, mode: p.mode, walletAddress: this.config.walletAddress, chainId: 8453,
      scope: "ETH/WETH and canonical USDC on Base only", updatedAt: this.now(), nextCheckAt: this.now() + (delay ?? p.intervalSeconds * 1000),
      policy: p, fees: "Modeled in studies; receipt-backed where available, otherwise rollup fees explicitly estimated", ...fields,
      activeCycle: this.state.active() ?? null,
      transactions: this.state.txs().map(t => ({ id: t.id, stage: t.stage, state: t.state, hash: t.hash, explorer: t.hash ? `https://basescan.org/tx/${t.hash}` : null })) };
    this.state.report(report, this.now()); return report;
  }
}
