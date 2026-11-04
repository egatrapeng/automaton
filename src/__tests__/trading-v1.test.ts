import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, type Address, type Hex, type PrivateKeyAccount } from "viem";
import { GuardianStore } from "../wallet-guardian/store.js";
import { WalletGuardian } from "../wallet-guardian/service.js";
import { createGuardianServer } from "../wallet-guardian/server.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import { DEFAULT_TRADING_POLICY, validateTradingPolicy, type Candle, type StudyResult, type TradingPolicy } from "../trading/types.js";
import { TradingEngine } from "../trading/engine.js";
import { BASE_USDC, BASE_WETH, BASE_ROUTER, BASE_QUOTER, BASE_FACTORY, GAS_ORACLE, ERC20_ABI, ROUTER_ABI, type TradeRpc, type TradeReceipt } from "../trading/base.js";
import { TradingStore, assertNoTradingReservation } from "../trading/store.js";
import { normalizeCandles, fetchTokenResearch } from "../trading/market.js";
import { backtest, selectStrategy } from "../trading/study.js";
import { renderTradingView } from "../trading/view.js";
import { agentkitRead } from "../trading/agentkit.js";
import { tradingDoctor } from "../trading/doctor.js";
import type { GuardianConfig } from "../wallet-guardian/types.js";

const WALLET = "0x2222222222222222222222222222222222222222" as Address;
const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const POOL = "0x3333333333333333333333333333333333333333" as Address;
const books: GuardianStore[] = [], directories: string[] = [], servers: http.Server[] = [];
const now = () => Date.now();
function candles(n = 240): Candle[] {
  const end = Math.floor(now() / 300000) * 300;
  return Array.from({ length: n }, (_, i) => ({ time: end - (n - i) * 300, open: 1000, close: 1000, low: 999, high: 1001, volume: 10 }));
}
function study(target: "ETH" | "USDC" = "ETH", eligible = true): StudyResult {
  const bars = candles();
  return { strategy: "sma-5-20", fast: 5, slow: 20, trainingEnd: bars[144].time,
    outOfSample: { netReturnPct: 2, benchmarkReturnPct: 1, maxDrawdownPct: 1, trades: 3, feesQuote: 1 }, target, eligible, reason: "Test fixture only",
    dataStart: bars[0].time, dataEnd: bars.at(-1)!.time, dataHash: "fake-data-hash", warning: "Simulated data; not a profitability claim" };
}
function config(patch: Partial<TradingPolicy> = {}): GuardianConfig {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "trading-v1-")); directories.push(directory);
  return { walletAddress: WALLET, ownerAddress: OWNER, maxSinglePaymentCents: 500, hourlyPaymentCents: 1000, dailyPaymentCents: 2500,
    dailyCurrency: "EUR", maxWithdrawalGasWei: "100000000000000", allowedWithdrawalNetworks: ["eip155:8453"], databaseFile: path.join(directory, "guardian.db"),
    walletFile: path.join(directory, "nonexistent-wallet.json"), tokenFile: path.join(directory, "nonexistent.key"), port: 8787,
    baseRpc: "https://base.example", ethereumRpc: "https://ethereum.example", trading: { ...DEFAULT_TRADING_POLICY, ...patch } };
}
function book(filename = ":memory:") { const store = new GuardianStore(filename); books.push(store); return store; }
function transfer(address: Address, from: Address, to: Address, value: bigint) {
  return { address, topics: encodeEventTopics({ abi: ERC20_ABI, eventName: "Transfer", args: { from, to } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [value]) };
}
function setup(patch: Partial<TradingPolicy> = {}, target: "ETH" | "USDC" = "ETH", filename?: string) {
  const c = config(patch), s = book(filename), sent: any[] = [], signed: any[] = [], receipts = new Map<Hex, TradeReceipt>();
  const state = { native: 10n ** 18n, usdc: 100_000_000n, weth: 0n, nonce: 0, block: 1000n, timeout: false, revert: false, deviation: false };
  const quote = (tokenIn: string, amount: bigint) => tokenIn.toLowerCase() === BASE_USDC ? amount * 10n ** 12n / 1000n * 9995n / 10000n : amount * 1000n / 10n ** 12n * 9995n / 10000n;
  const rpc: TradeRpc = {
    getChainId: vi.fn(async () => 8453), getBlockNumber: vi.fn(async () => state.block), getBytecode: vi.fn(async () => "0x1234" as Hex),
    getBalance: vi.fn(async () => state.native), getTransactionCount: vi.fn(async () => state.nonce),
    readContract: vi.fn(async args => {
      if (args.functionName === "balanceOf") return args.address === BASE_USDC ? state.usdc : state.weth;
      if (args.functionName === "getPool") return POOL;
      if (args.functionName === "token0") return BASE_USDC;
      if (args.functionName === "token1") return BASE_WETH;
      if (args.functionName === "liquidity") return 10n ** 18n;
      if (["getL1Fee", "getOperatorFee"].includes(args.functionName)) return 10n;
      throw new Error("Unexpected contract read");
    }),
    simulateContract: vi.fn(async args => ({ result: [state.deviation ? 1n : quote(args.args[0].tokenIn, args.args[0].amountIn), 0n, 0, 100000n] })),
    estimateGas: vi.fn(async () => 100000n), estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n })),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }) => { sent.push(signed.at(-1)); return keccak256(serializedTransaction); }),
    waitForTransactionReceipt: vi.fn(async ({ hash }) => {
      if (state.timeout) throw new Error("Lost RPC response");
      const tx = signed.at(-1); const logs: TradeReceipt["logs"] = [];
      if (!state.revert && tx.to === BASE_ROUTER) {
        const outer = decodeFunctionData({ abi: ROUTER_ABI, data: tx.data });
        const inner = decodeFunctionData({ abi: ROUTER_ABI, data: (outer.args![1] as Hex[])[0] });
        const p = inner.args![0] as any, output = quote(p.tokenIn, p.amountIn);
        if (tx.value > 0n) state.native -= tx.value;
        else if (p.tokenIn.toLowerCase() === BASE_USDC) { state.usdc -= p.amountIn; logs.push(transfer(BASE_USDC, WALLET, BASE_ROUTER, p.amountIn)); }
        else { state.weth -= p.amountIn; logs.push(transfer(BASE_WETH, WALLET, BASE_ROUTER, p.amountIn)); }
        if (p.tokenOut.toLowerCase() === BASE_WETH) { state.weth += output; logs.push(transfer(BASE_WETH, BASE_ROUTER, WALLET, output)); }
        else { state.usdc += output; logs.push(transfer(BASE_USDC, BASE_ROUTER, WALLET, output)); }
      }
      state.native -= 1_000_010n; state.nonce++;
      const receipt: TradeReceipt = { transactionHash: hash, status: state.revert ? "reverted" : "success", gasUsed: 10000n, effectiveGasPrice: 100n,
        blockNumber: 900n, l1Fee: 10n, operatorFee: 0n, logs };
      receipts.set(hash, receipt); return receipt;
    }),
    getTransactionReceipt: vi.fn(async ({ hash }) => { if (!receipts.has(hash)) throw new Error("Receipt unavailable"); return receipts.get(hash)!; }),
  };
  const account = { address: WALLET, signTransaction: vi.fn(async tx => { signed.push(tx); return ("0x" + signed.length.toString(16).padStart(8, "0")) as Hex; }) } as unknown as PrivateKeyAccount;
  const selector = vi.fn(() => study(target));
  const engine = new TradingEngine(c, s, account, rpc, async () => candles(), now, selector);
  return { c, s, state, rpc, account, engine, selector, sent, signed, receipts };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); })));
  books.splice(0).forEach(b => { if (b.db.open) b.close(); }); directories.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true }));
});

describe("market data and unbiased study", () => {
  it("sorts closed bars and excludes a still-open bar", () => {
    const data = candles(), raw = data.map(b => [b.time, b.low, b.high, b.open, b.close, b.volume]).reverse();
    raw.push([Math.floor(now() / 300000) * 300, 999, 1001, 1000, 1000, 1]);
    expect(normalizeCandles(raw)).toEqual(data);
  });
  it.each(["gap", "duplicate", "negative", "string", "stale", "short"])("rejects %s data instead of inventing prices", kind => {
    const raw: any[] = candles().map(b => [b.time, b.low, b.high, b.open, b.close, b.volume]);
    if (kind === "gap") raw.splice(20, 1);
    if (kind === "duplicate") raw.push(raw[0]);
    if (kind === "negative") raw[0][1] = -1;
    if (kind === "string") raw[0][4] = "1000";
    if (kind === "stale") raw.forEach(r => r[0] -= 3600);
    if (kind === "short") raw.splice(0, 100);
    expect(() => normalizeCandles(raw)).toThrow();
  });
  it("fills a previous-close signal at the next open, with modeled entry/exit costs", () => {
    const rows = candles(3); rows[1] = { ...rows[1], open: 100, close: 200, low: 100, high: 200 }; rows[0] = { ...rows[0], open: 100, close: 100 };
    const result = backtest(rows, 2, 3, 1, 2, 100, DEFAULT_TRADING_POLICY);
    expect(result.finalQuote).toBeLessThan(100); expect(result.finalQuote).toBeGreaterThan(99); expect(result.feesQuote).toBeGreaterThan(0);
  });
  it("does not choose a different parameter candidate after seeing changed holdout prices", () => {
    const rows = candles(); rows.forEach((b, i) => { b.close = b.open = 1000 + 100 * Math.sin(i / 10); b.high = b.close + 1; b.low = b.close - 1; });
    const changed = rows.map((b, i) => i >= Math.floor(rows.length * .6) ? { ...b, open: b.open * (1 + i / 20), close: b.close * (1 + i / 20) } : b);
    const before = selectStrategy(rows, 100, DEFAULT_TRADING_POLICY), after = selectStrategy(changed, 100, DEFAULT_TRADING_POLICY);
    expect(after.strategy).toBe(before.strategy); expect(after.dataHash).not.toBe(before.dataHash);
  });
  it("reports research flags and concentration as reported facts, never a scam certificate", async () => {
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(Response.json([{ pairAddress: POOL, liquidity: { usd: 10000 }, volume: { h24: 1000 } }]))
      .mockResolvedValueOnce(Response.json({ result: { [BASE_WETH]: { is_honeypot: "0", buy_tax: "0.01", sell_tax: "0.02", holders: [{ address: OWNER, percent: "0.3" }] } } }));
    const result = await fetchTokenResearch(BASE_WETH) as any;
    expect(result.security).toMatchObject({ reportedHoneypot: false, buyTaxPct: 1, sellTaxPct: 2, topListedHolderConcentrationPct: 30 });
    expect(result.risks.scamVerdict).toBe("not established");
  });
  it("keeps risks unknown if the security provider fails", async () => {
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(Response.json([])).mockRejectedValueOnce(new Error("offline"));
    expect((await fetchTokenResearch(BASE_WETH) as any).security.available).toBe(false);
  });
});

describe("whole-wallet strategy engine", () => {
  it("runs paper trading without invoking any signer or broadcast", async () => {
    const f = setup(); const report = await f.engine.tick();
    expect(report).toMatchObject({ mode: "paper", state: "paper", paper: { virtual: true, trades: 1 } });
    expect(f.account.signTransaction).not.toHaveBeenCalled(); expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(await f.engine.tick()).toEqual(report);
  });
  it("remains disabled when no owner policy exists, even if old reports say live", async () => {
    const f = setup(); f.c.trading = undefined; f.engine.state.set("report", { mode: "live", state: "executed" });
    expect(await f.engine.tick()).toMatchObject({ mode: "disabled", state: "disabled" }); expect(f.rpc.getBalance).not.toHaveBeenCalled();
  });
  it("reports the actual configured live mode immediately while an old paper report is cached", () => {
    const f = setup({ mode: "live" }); f.engine.state.set("report", { mode: "paper", state: "paper" });
    expect(f.engine.report()).toMatchObject({ mode: "live", state: "policy_changed", observationMode: "paper" });
    expect(f.account.signTransaction).not.toHaveBeenCalled();
  });
  it("does not trade if its independent study finds no advantage", async () => {
    const f = setup({ mode: "live" }); f.selector.mockReturnValue(study("ETH", false));
    expect(await f.engine.tick()).toMatchObject({ state: "hold" }); expect(f.account.signTransaction).not.toHaveBeenCalled();
  });
  it("uses the supported wallet rather than an invented fixed capital, leaving gas untouched", async () => {
    const f = setup({ mode: "paper" }); f.state.usdc = 0n;
    const report = await f.engine.tick(); expect(report.wallet.equityQuote).toBe(1000); expect(report.wallet.availableForTradingQuote).toBeCloseTo(999.7);
    f.state.native = BigInt(DEFAULT_TRADING_POLICY.nativeReserveWei); f.engine.state.set("report", {});
    expect(await f.engine.tick()).toMatchObject({ state: "capital_low" });
    expect(f.account.signTransaction).not.toHaveBeenCalled();
  });
  it("executes only exact USDC approval and a fixed Uniswap swap to the same wallet", async () => {
    const f = setup({ mode: "live" }); const report = await f.engine.tick();
    expect(report.state).toBe("executed"); expect(f.signed).toHaveLength(2);
    const approval = decodeFunctionData({ abi: ERC20_ABI, data: f.signed[0].data });
    expect(approval.functionName).toBe("approve");
    expect(String(approval.args![0]).toLowerCase()).toBe(BASE_ROUTER); expect(approval.args![1]).toBe(100_000_000n);
    expect(f.signed[0].to).toBe(BASE_USDC); expect(f.signed[0].chainId).toBe(8453);
    const outer = decodeFunctionData({ abi: ROUTER_ABI, data: f.signed[1].data });
    const inner = decodeFunctionData({ abi: ROUTER_ABI, data: (outer.args![1] as Hex[])[0] });
    const params = inner.args![0] as any;
    expect(params.tokenIn.toLowerCase()).toBe(BASE_USDC); expect(params.tokenOut.toLowerCase()).toBe(BASE_WETH);
    expect(params.recipient.toLowerCase()).toBe(WALLET.toLowerCase()); expect(params.amountIn).toBe(100_000_000n); expect(params.fee).toBe(500);
    expect((inner.args![0] as any).amountOutMinimum).toBeGreaterThan(0n);
    expect(report.transactions.every((t: any) => t.state === "confirmed")).toBe(true);
    expect(report.performance.estimatedNetPnlQuote).toBeLessThan(0); // Entry friction, not fabricated income.
  });
  it("sells native ETH without a token approval and preserves the gas reserve", async () => {
    const f = setup({ mode: "live" }, "USDC"); f.state.usdc = 0n;
    const report = await f.engine.tick(); expect(report.state).toBe("executed"); expect(f.signed).toHaveLength(1);
    expect(f.signed[0].value).toBe(10n ** 18n - BigInt(DEFAULT_TRADING_POLICY.nativeReserveWei));
    const calls = decodeFunctionData({ abi: ROUTER_ABI, data: f.signed[0].data }).args![1] as Hex[];
    expect(calls).toHaveLength(2); expect(decodeFunctionData({ abi: ROUTER_ABI, data: calls[1] }).functionName).toBe("refundETH");
    expect(f.state.native).toBeGreaterThan(0n); expect(f.state.usdc).toBeGreaterThan(0n);
  });
  it("sells WETH using an exact allowance before spending native ETH", async () => {
    const f = setup({ mode: "live" }, "USDC"); f.state.weth = 10n ** 17n; f.state.usdc = 0n;
    const report = await f.engine.tick(); expect(report.state).toBe("executed"); expect(f.signed[0].to).toBe(BASE_WETH); expect(f.signed[1].value).toBe(0n);
  });
  it("reserves outstanding x402 service authorizations instead of trading their USDC", async () => {
    const f = setup({ mode: "live" }); f.s.begin("service-reservation", "service", {}, {});
    f.s.db.prepare("UPDATE guardian_requests SET state='accepted',amount_atomic='95000000',expires_at=? WHERE id='service-reservation'").run(Date.now() + 300000);
    const report = await f.engine.tick(); expect(report.state).toBe("executed");
    expect(decodeFunctionData({ abi: ERC20_ABI, data: f.signed[0].data }).args![1]).toBe(5_000_000n);
  });
  it("blocks service and withdrawal signatures while a trading lease is active", () => {
    const f = setup(); expect(f.engine.state.acquire("lease-1", {})).toBe(true); expect(() => assertNoTradingReservation(f.s.db)).toThrow("in progress");
    f.engine.state.finish("lease-1", "completed"); expect(() => assertNoTradingReservation(f.s.db)).not.toThrow();
  });
  it("atomically refuses a trading lease while a withdrawal is already claimed", () => {
    const f = setup(); f.s.begin("withdrawal-in-flight", "withdrawal", {}, {});
    f.s.db.prepare("UPDATE guardian_requests SET state='authorizing' WHERE id='withdrawal-in-flight'").run();
    expect(f.engine.state.acquire("cannot-race-withdrawal", {})).toBe(false);
    expect(f.engine.state.active()).toBeUndefined();
  });
  it("enforces the wallet lease inside both spending transactions", () => {
    const f = setup(); f.engine.state.acquire("trade-holds-wallet", {});
    expect(() => f.s.claimWithdrawal("anything", f.c)).toThrow("in progress");
    expect(() => f.s.authorizeService("anything", {} as any, undefined, f.c)).toThrow("in progress");
  });
  it("counts a reverted or approval-only signed cycle against the daily fee-churn limit", () => {
    const f = setup(); f.engine.state.acquire("attempt", {});
    const id = f.engine.state.reserveTx("attempt", "approve", {}); f.engine.state.txState(id, "reverted");
    expect(f.engine.state.countOrders()).toBe(1);
  });
  it("continues marking a virtual holding when the next study has no eligible trade", async () => {
    const f = setup(); await f.engine.tick();
    const old = f.engine.state.get<any>("paper"); f.engine.state.set("paper", { ...old, lastBar: old.lastBar - 300 });
    f.engine.state.set("report", {}); f.selector.mockReturnValue(study("USDC", false));
    const report = await f.engine.tick();
    expect(report.paper.lastBar).toBe(old.lastBar); expect(report.paper.trades).toBe(1);
    expect(report.paper.eth).toBe(old.eth); expect(f.account.signTransaction).not.toHaveBeenCalled();
  });
  it("migrates old expired service reservations without reusing still-valid ones", () => {
    const s = book(); s.begin("old", "service", {}, {});
    s.db.prepare("UPDATE guardian_requests SET state='accepted',amount_atomic='1000000',created_at=? WHERE id='old'").run(Date.now() - 3600000);
    const trading = new TradingStore(s.db); expect(trading.reservedUsdc()).toBe(0n);
  });
  it.each(["chain", "contract", "liquidity", "fees", "nonce", "balance", "quote"])("refuses %s problems without an unsafe swap", async kind => {
    const f = setup({ mode: "live" });
    if (kind === "chain") vi.mocked(f.rpc.getChainId).mockResolvedValue(1);
    if (kind === "contract") vi.mocked(f.rpc.getBytecode).mockResolvedValue("0x");
    if (kind === "liquidity") { const original = vi.mocked(f.rpc.readContract).getMockImplementation()!; vi.mocked(f.rpc.readContract).mockImplementation(async a => a.functionName === "liquidity" ? 0n : original(a)); }
    if (kind === "fees") vi.mocked(f.rpc.estimateFeesPerGas).mockResolvedValue({ maxFeePerGas: 10n ** 15n, maxPriorityFeePerGas: 1n });
    if (kind === "nonce") vi.mocked(f.rpc.getTransactionCount).mockImplementation(async a => a.blockTag === "pending" ? 1 : 0);
    if (kind === "balance") f.state.native = 0n;
    if (kind === "quote") f.state.deviation = true;
    const report = await f.engine.tick(); expect(report.state).toBe("unavailable");
    expect(f.signed.every(tx => tx.to !== BASE_ROUTER)).toBe(true);
  });
  it("does not sign a second transaction on timeout, restart, repeated trigger or candle replay", async () => {
    const f = setup({ mode: "live" }); f.state.timeout = true;
    expect(await f.engine.tick()).toMatchObject({ state: "unavailable" });
    const row = f.engine.state.txs()[0]; expect(row.state).toBe("uncertain"); expect(row.hash).toBeTruthy();
    f.engine.state.set("report", {});
    const restarted = new TradingEngine(f.c, f.s, f.account, f.rpc, async () => candles(), now, () => study());
    expect(await restarted.tick()).toMatchObject({ state: "paused" }); expect(f.signed).toHaveLength(1);
    expect(await restarted.tick()).toMatchObject({ state: "paused" }); expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it("persists the signed hash before the RPC is allowed to see signed bytes", async () => {
    const f = setup({ mode: "live" }); vi.mocked(f.rpc.sendRawTransaction).mockImplementation(async ({ serializedTransaction }) => {
      expect(f.engine.state.txs()[0]).toMatchObject({ state: "signed", hash: keccak256(serializedTransaction) }); throw new Error("offline");
    });
    await f.engine.tick(); expect(f.signed).toHaveLength(1);
  });
  it("prevents concurrent instances from trading the same wallet", async () => {
    const f = setup({ mode: "live" }); const second = new TradingEngine(f.c, f.s, f.account, f.rpc, async () => candles(), now, () => study());
    const reports = await Promise.all([f.engine.tick(), second.tick()]);
    expect(f.signed).toHaveLength(2); expect(reports.filter(r => r.state === "executed")).toHaveLength(1);
  });
  it("does not reset an uncertain operation to failed before its receipt is known", async () => {
    const f = setup({ mode: "live" }); f.state.timeout = true; await f.engine.tick();
    expect(f.engine.state.active()?.state).toBe("uncertain"); f.engine.state.set("report", {});
    await f.engine.tick(); expect(f.engine.state.active()?.state).toBe("uncertain");
  });
  it("handles a reverted native transaction without pretending its value left the wallet", async () => {
    const f = setup({ mode: "live" }, "USDC"); f.state.usdc = 0n; f.state.revert = true;
    expect(await f.engine.tick()).toMatchObject({ state: "unavailable" });
    expect(f.engine.state.get<any>("wallet").nativeWei).toBe(String(f.state.native));
    expect(f.engine.state.get<any>("book").estimatedNetPnlQuote).toBeGreaterThan(-1);
  });
});

describe("report, policy and integrations", () => {
  it("diagnoses public market, quote, fees and wallet even when the key file does not exist", async () => {
    const f = setup(); const result = await tradingDoctor(f.c, f.rpc, async () => candles());
    expect(result).toMatchObject({ ok: true, signing: false, chainId: 8453, walletAddress: WALLET });
    expect(fs.existsSync(f.c.walletFile)).toBe(false); expect(f.account.signTransaction).not.toHaveBeenCalled(); expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("fails the public doctor on an unrelated on-chain price instead of activating trading", async () => {
    const f = setup(); f.state.deviation = true;
    await expect(tradingDoctor(f.c, f.rpc, async () => candles())).rejects.toThrow("disagree");
  });
  it.each([{ maxSlippageBps: 10001 }, { allocationBps: 10001 }, { nativeReserveWei: "1" }, { intervalSeconds: 0 }, { maxDailyLossBps: 0 }, { mode: "unsafe" }])("rejects invalid owner limits %j", patch => {
    expect(() => validateTradingPolicy({ ...DEFAULT_TRADING_POLICY, ...patch } as TradingPolicy)).toThrow();
  });
  it("labels unavailable data and escapes report text instead of exposing HTML or zero balances", () => {
    const html = renderTradingView({ state: "unavailable", reason: '<script>alert("secret")</script>', mode: "paper" });
    expect(html).not.toContain('<script>alert'); expect(html).toContain("&lt;script&gt;"); expect(html).toContain("indisponible");
    expect(html).not.toContain("Bearer");
  });
  it("does not allow generic AgentKit transfers or signing through the data adapter", async () => {
    await expect(agentkitRead("sendTransaction", {})).rejects.toThrow("read-only");
    await expect(agentkitRead("signTypedData", {})).rejects.toThrow("read-only");
  });
  it("excludes outside deposits from estimated performance instead of declaring them trading profits", () => {
    const f = setup(); const w = { nativeWei: "0", wethAtomic: "0", usdcAtomic: "10000000", priceQuote: 1000, equityQuote: 10, spendableQuote: 10, nativeReserveWei: "1", at: 1, block: "1" };
    f.engine.state.observe(w); const report = f.engine.state.observe({ ...w, usdcAtomic: "110000000", equityQuote: 110 });
    expect(report.estimatedNetPnlQuote).toBe(0); expect(report.observedNetFlowsQuote).toBe(100);
  });
  it("lets an observer read trading reports but never trigger an order", async () => {
    const f = setup(), guardian = new WalletGuardian(f.c, f.s, f.account), tick = vi.spyOn(guardian.trading, "tick");
    const bearer = "agent-test-token-01234567890123456789", observer = "observer-test-token-01234567890123456789";
    const server = createGuardianServer(guardian, bearer, observer); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    async function request(route: string, method = "GET") { return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: route, method, agent: new http.Agent({ keepAlive: false }), headers: { Authorization: "Bearer " + observer, "Content-Type": "application/json" } }, res => {
        let body = ""; res.on("data", c => body += c); res.on("end", () => resolve({ status: res.statusCode!, body }));
      }); req.on("error", reject); req.end(method === "POST" ? "{}" : undefined);
    }); }
    expect((await request("/v1/trading")).status).toBe(200);
    expect((await request("/v1/trading/view")).status).toBe(200);
    expect((await request("/v1/trading/tick", "POST")).status).toBe(403); expect(tick).not.toHaveBeenCalled();
  });
});
