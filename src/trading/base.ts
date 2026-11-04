import { createPublicClient, http, parseAbi, serializeTransaction, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import type { WalletSnapshot, TradingPolicy } from "./types.js";

// Base deployment addresses, cross-checked against Coinbase AgentKit's Base constants.
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;
export const BASE_WETH = "0x4200000000000000000000000000000000000006" as Address;
export const BASE_ROUTER = "0x2626664c2603336e57b271c5c0b26f421741e481" as Address;
export const BASE_QUOTER = "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a" as Address;
export const BASE_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd" as Address;
export const GAS_ORACLE = "0x420000000000000000000000000000000000000f" as Address;
export const POOL_FEE = 500;
export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)", "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function refundETH() payable",
]);
export const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
export const FACTORY_ABI = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
export const POOL_ABI = parseAbi(["function liquidity() view returns (uint128)", "function token0() view returns (address)", "function token1() view returns (address)"]);
const GAS_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)", "function getOperatorFee(uint256) view returns (uint256)"]);

export interface TradeReceipt {
  transactionHash: Hex; status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice: bigint;
  blockNumber: bigint; logs: Array<{ address: Address; data: Hex; topics: readonly Hex[] }>;
  l1Fee?: bigint; operatorFee?: bigint;
}
export interface TradeRpc {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBalance(args: { address: Address; blockTag?: "pending" | "latest" }): Promise<bigint>;
  getBytecode(args: { address: Address }): Promise<Hex | undefined>;
  getTransactionCount(args: { address: Address; blockTag: "pending" | "latest" }): Promise<number>;
  readContract(args: any): Promise<any>;
  simulateContract(args: any): Promise<{ result: any }>;
  estimateGas(args: any): Promise<bigint>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
  waitForTransactionReceipt(args: { hash: Hex; confirmations: number; timeout: number }): Promise<TradeReceipt>;
  getTransactionReceipt(args: { hash: Hex }): Promise<TradeReceipt>;
}
export function tradingRpc(url: string): TradeRpc {
  return createPublicClient({ chain: base, transport: http(url, { timeout: 15000, retryCount: 0 }) }) as unknown as TradeRpc;
}

export async function readWallet(rpc: TradeRpc, address: Address, price: number, p: TradingPolicy): Promise<WalletSnapshot> {
  if (await rpc.getChainId() !== 8453) throw new Error("Trading requires Base mainnet (8453)");
  if (!Number.isFinite(price) || price <= 0) throw new Error("No verified market valuation");
  const [native, weth, usdc, block] = await Promise.all([
    rpc.getBalance({ address, blockTag: "pending" }),
    rpc.readContract({ address: BASE_WETH, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
    rpc.readContract({ address: BASE_USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }), rpc.getBlockNumber(),
  ]);
  if ([native, weth, usdc].some(n => typeof n !== "bigint" || n < 0n)) throw new Error("Invalid balance reading; not zero");
  const reserve = BigInt(p.nativeReserveWei), availableEth = (native > reserve ? native - reserve : 0n) + weth;
  const equityQuote = Number(usdc) / 1e6 + Number(native + weth) / 1e18 * price;
  if (!Number.isFinite(equityQuote) || equityQuote > 1e12) throw new Error("Portfolio valuation outside V1 precision range");
  return { nativeWei: String(native), wethAtomic: String(weth), usdcAtomic: String(usdc), priceQuote: price, equityQuote,
    spendableQuote: Number(usdc) / 1e6 + Number(availableEth) / 1e18 * price, nativeReserveWei: String(reserve), at: Date.now(), block: String(block) };
}

export async function rollupFee(rpc: TradeRpc, tx: { to: Address; data: Hex; value: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; nonce: number }): Promise<bigint> {
  const bytes = serializeTransaction({ ...tx, type: "eip1559", chainId: 8453 });
  const [l1, operator] = await Promise.all([
    rpc.readContract({ address: GAS_ORACLE, abi: GAS_ABI, functionName: "getL1Fee", args: [bytes] }),
    rpc.readContract({ address: GAS_ORACLE, abi: GAS_ABI, functionName: "getOperatorFee", args: [tx.gas] }),
  ]);
  if ([l1, operator].some(n => typeof n !== "bigint" || n < 0n)) throw new Error("Cannot estimate Base rollup fees");
  return 2n * (l1 + operator); // conservative estimate, not an on-chain maximum guarantee.
}

/** Verify the fixed deployment without loading or invoking a signer. */
export async function checkTradingDeployment(rpc: TradeRpc): Promise<{ pool: Address; liquidity: string }> {
    if (await rpc.getChainId() !== 8453) throw new Error("Wrong chain for trading");
    for (const address of [BASE_USDC, BASE_WETH, BASE_ROUTER, BASE_QUOTER, BASE_FACTORY]) {
      const code = await rpc.getBytecode({ address }); if (!code || code === "0x") throw new Error(`Missing Base contract ${address}`);
    }
    const pool = await rpc.readContract({ address: BASE_FACTORY, abi: FACTORY_ABI, functionName: "getPool", args: [BASE_WETH, BASE_USDC, POOL_FEE] }) as Address;
    if (!/^0x[0-9a-f]{40}$/i.test(pool) || /^0x0{40}$/i.test(pool)) throw new Error("Uniswap V3 ETH/USDC 0.05% pool unavailable");
    const [a, b, liquidity] = await Promise.all(["token0", "token1", "liquidity"].map(functionName => rpc.readContract({ address: pool, abi: POOL_ABI, functionName })));
    if (![a, b].some(t => String(t).toLowerCase() === BASE_WETH) || ![a, b].some(t => String(t).toLowerCase() === BASE_USDC) || typeof liquidity !== "bigint" || liquidity <= 0n) throw new Error("Pool identity or active liquidity invalid");
    return { pool, liquidity: String(liquidity) };
}
