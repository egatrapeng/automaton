import { encodeFunctionData, isAddress, type Address } from "viem";
import type { GuardianConfig } from "../wallet-guardian/types.js";
import { BASE_QUOTER, BASE_ROUTER, BASE_USDC, BASE_WETH, ERC20_ABI, POOL_FEE, QUOTER_ABI,
  checkTradingDeployment, readWallet, rollupFee, tradingRpc, type TradeRpc } from "./base.js";
import { fetchCandles } from "./market.js";
import { DEFAULT_TRADING_POLICY, validateTradingPolicy, type Candle } from "./types.js";

/** Public RPC/market reads only. No private key, database, approval or broadcast. */
export async function tradingDoctor(config: GuardianConfig, rpc: TradeRpc = tradingRpc(config.baseRpc),
  market: () => Promise<Candle[]> = fetchCandles): Promise<unknown> {
  if (!isAddress(config.walletAddress, { strict: false })) throw new Error("Invalid configured funding address");
  const address = config.walletAddress as Address;
  const policy = config.trading ?? DEFAULT_TRADING_POLICY; validateTradingPolicy(policy);
  const candles = await market(), price = candles.at(-1)!.close;
  const deployment = await checkTradingDeployment(rpc);
  const wallet = await readWallet(rpc, address, price, policy);
  const amount = BigInt(policy.minimumOrderCents) * 10000n;
  const quote = await rpc.simulateContract({ account: config.walletAddress, address: BASE_QUOTER, abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle", args: [{ tokenIn: BASE_USDC, tokenOut: BASE_WETH, amountIn: amount, fee: POOL_FEE, sqrtPriceLimitX96: 0n }] });
  const out = quote.result?.[0], reference = Number(amount) / 1e6 / price * 1e18;
  if (typeof out !== "bigint" || out <= 0n || Math.abs(Number(out) - reference) / reference * 10000 > policy.maxQuoteDeviationBps) throw new Error("Doctor: executable quote and independent market disagree");
  const rollup = await rollupFee(rpc, { to: BASE_USDC, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [BASE_ROUTER, amount] }),
    value: 0n, gas: 100000n, maxFeePerGas: 1000000n, maxPriorityFeePerGas: 100000n, nonce: 0 });
  return { ok: true, signing: false, chainId: 8453, walletAddress: config.walletAddress, wallet, deployment,
    candles: candles.length, lastClosedBar: candles.at(-1), quoteOutAtomic: String(out), quoteDeviationPct: 100 * Math.abs(Number(out) - reference) / reference,
    estimatedRollupFeeWei: String(rollup), message: "Public reads passed. No signature, approval, database update or funds moved. This is not a profitability or future availability guarantee." };
}
