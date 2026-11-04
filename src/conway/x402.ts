/**
 * x402 Payment Protocol
 *
 * Enables the automaton to make USDC micropayments via HTTP 402.
 * Adapted from conway-mcp/src/x402/index.ts
 */

import {
  createPublicClient,
  http,
  isAddress,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { ResilientHttpClient } from "./http-client.js";
import type { ChainType } from "../identity/chain.js";
import { randomUUID } from "node:crypto";
import { PaymentLedger, centsToAtomic, type PaymentBudget, type PaymentState } from "./payment-ledger.js";

const x402HttpClient = new ResilientHttpClient();

// USDC contract addresses
const USDC_ADDRESSES: Record<string, Address> = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base mainnet
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
};

const CHAINS: Record<string, any> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
};
type NetworkId = keyof typeof USDC_ADDRESSES;

const BALANCE_OF_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface PaymentRequirement {
  scheme: string;
  network: NetworkId;
  maxAmountRequired: string;
  payToAddress: Address;
  requiredDeadlineSeconds: number;
  usdcAddress: Address;
}

interface PaymentRequiredResponse {
  x402Version: number;
  accepts: PaymentRequirement[];
}

interface ParsedPaymentRequirement {
  x402Version: number;
  requirement: PaymentRequirement;
}

export interface X402PaymentResult {
  success: boolean;
  response?: any;
  error?: string;
  status?: number;
  /** An HTTP acceptance is not proof of on-chain settlement. */
  payment?: {
    operationId: string;
    amountAtomic: string;
    amountCents: number;
    recipient: string;
    network: string;
    state: PaymentState;
    validUntil: number;
  };
}

export interface PaymentSecurityOptions {
  /** Independent policy check after actual quote validation/reservation, BEFORE any signature. */
  beforeSign?: (quote: PaymentAuthorizationQuote) => void | Promise<void>;
  ledger?: PaymentLedger;
  ledgerPath?: string;
  operationId?: string;
  budget?: Partial<PaymentBudget>;
  expectedNetwork?: string;
  allowedRecipients?: string[];
  maxAuthorizationSeconds?: number;
  /** Public-only for agent-chosen URLs; configured for operator-selected backends. */
  networkPolicy?: "public" | "configured";
}

export interface PaymentAuthorizationQuote {
  operationId: string;
  url: string;
  network: string;
  recipient: string;
  amountAtomic: string;
  validUntil: number;
}

export interface UsdcBalanceResult {
  balance: number;
  /** Exact EVM balance for reserve enforcement; never reconstruct money from a float. */
  balanceAtomic?: string;
  network: string;
  ok: boolean;
  error?: string;
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value)) return null;
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeNetwork(raw: unknown): NetworkId | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "base") return "eip155:8453";
  if (normalized === "base-sepolia") return "eip155:84532";
  if (normalized === "eip155:8453" || normalized === "eip155:84532") {
    return normalized;
  }
  return null;
}

function normalizePaymentRequirement(raw: unknown): PaymentRequirement | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const network = normalizeNetwork(value.network);
  if (!network) return null;

  const scheme = typeof value.scheme === "string" ? value.scheme : null;
  const maxAmountRequired = typeof value.maxAmountRequired === "string"
    ? value.maxAmountRequired
    : typeof value.maxAmountRequired === "number" &&
        Number.isFinite(value.maxAmountRequired)
      ? String(value.maxAmountRequired)
      : null;
  const payToAddress = typeof value.payToAddress === "string"
    ? value.payToAddress
    : typeof value.payTo === "string"
      ? value.payTo
      : null;
  const usdcAddress = typeof value.usdcAddress === "string"
    ? value.usdcAddress
    : typeof value.asset === "string"
      ? value.asset
      : USDC_ADDRESSES[network];
  const rawDeadline = value.requiredDeadlineSeconds ?? value.maxTimeoutSeconds;
  const requiredDeadlineSeconds = rawDeadline === undefined ? 300 : parsePositiveInt(rawDeadline);

  if (!scheme || !maxAmountRequired || !payToAddress || !usdcAddress || !requiredDeadlineSeconds) {
    return null;
  }

  return {
    scheme,
    network,
    maxAmountRequired,
    payToAddress: payToAddress as Address,
    requiredDeadlineSeconds,
    usdcAddress: usdcAddress as Address,
  };
}

function normalizePaymentRequired(raw: unknown): PaymentRequiredResponse | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.accepts)) return null;

  const accepts = value.accepts
    .map(normalizePaymentRequirement)
    .filter((v): v is PaymentRequirement => v !== null);
  if (!accepts.length) return null;

  const x402Version = value.x402Version === undefined ? 1 : parsePositiveInt(value.x402Version);
  if (x402Version !== 1 && x402Version !== 2) return null;
  return { x402Version, accepts };
}

/** Integer values in x402 are atomic units in both protocol versions; never guess by digit length. */
function parseMaxAmountRequired(maxAmountRequired: string, _x402Version: number): bigint {
  const amount = maxAmountRequired.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(amount) || amount.length > 80) {
    throw new Error("Invalid USDC amount: expected positive atomic integer or decimal with at most 6 places");
  }
  const [whole, fraction] = amount.split(".");
  const atomic = fraction === undefined ? BigInt(whole) : BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (atomic <= 0n || atomic >= 2n ** 256n) throw new Error("USDC amount must be positive and fit uint256");
  return atomic;
}

function validateRequirement(requirement: PaymentRequirement, security: PaymentSecurityOptions): void {
  if (requirement.scheme !== "exact") throw new Error("Unsupported x402 payment scheme");
  if (!CHAINS[requirement.network]) throw new Error("Unsupported payment network");
  if (security.expectedNetwork && requirement.network !== security.expectedNetwork) throw new Error("Unexpected payment network");
  if (!isAddress(requirement.payToAddress, { strict: false }) || /^0x0{40}$/i.test(requirement.payToAddress)) {
    throw new Error("Invalid payment recipient");
  }
  if (!isAddress(requirement.usdcAddress, { strict: false }) ||
      requirement.usdcAddress.toLowerCase() !== USDC_ADDRESSES[requirement.network].toLowerCase()) {
    throw new Error("Payment asset must be the configured network's canonical USDC contract");
  }
  if (security.allowedRecipients && !security.allowedRecipients.some(r => r.toLowerCase() === requirement.payToAddress.toLowerCase())) {
    throw new Error("Payment recipient is not approved");
  }
  const maxSeconds = security.maxAuthorizationSeconds ?? 300;
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 3600 || requirement.requiredDeadlineSeconds > maxSeconds) {
    throw new Error("Payment authorization lifetime exceeds configured maximum");
  }
}

function selectRequirement(parsed: PaymentRequiredResponse, security: PaymentSecurityOptions = {}, cap?: bigint): PaymentRequirement {
  const supported = parsed.accepts.find(requirement => {
    try {
      validateRequirement(requirement, security);
      const amount = parseMaxAmountRequired(requirement.maxAmountRequired, parsed.x402Version);
      return cap === undefined || amount <= cap;
    } catch { return false; }
  });
  // Preserve a concrete error from validation when the server offers no acceptable option.
  return supported ?? parsed.accepts[0];
}

/** Solana USDC mint address (mainnet). */
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Get the USDC balance for the automaton's wallet on a given network.
 * Supports both EVM (Base) and Solana networks.
 */
export async function getUsdcBalance(
  address: string,
  network: string = "eip155:8453",
  chainType?: ChainType,
): Promise<number> {
  if (chainType === "solana" || network === "solana:mainnet") {
    return getSolanaUsdcBalance(address);
  }
  const result = await getUsdcBalanceDetailed(address as Address, network);
  return result.balance;
}

/**
 * Get the USDC balance on Solana using @solana/web3.js.
 */
async function getSolanaUsdcBalance(address: string): Promise<number> {
  try {
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");
    const ownerPubkey = new PublicKey(address);
    const mintPubkey = new PublicKey(SOLANA_USDC_MINT);

    // Find associated token account for USDC
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      ownerPubkey,
      { mint: mintPubkey },
    );

    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    // Sum all USDC token accounts (usually just one)
    let totalBalance = 0;
    for (const account of tokenAccounts.value) {
      const parsed = account.account.data.parsed;
      if (parsed?.info?.tokenAmount?.uiAmount != null) {
        totalBalance += parsed.info.tokenAmount.uiAmount;
      }
    }

    return totalBalance;
  } catch (err: any) {
    throw new Error(`Solana USDC balance check failed: ${err?.message || String(err)}`);
  }
}

/**
 * Get the USDC balance and read status details for diagnostics.
 */
export async function getUsdcBalanceDetailed(
  address: Address,
  network: string = "eip155:8453",
): Promise<UsdcBalanceResult> {
  const chain = CHAINS[network];
  const usdcAddress = USDC_ADDRESSES[network];
  if (!chain || !usdcAddress) {
    return {
      balance: 0,
      network,
      ok: false,
      error: `Unsupported USDC network: ${network}`,
    };
  }

  try {
    const rpcUrl = process.env.AUTOMATON_RPC_URL || undefined;
    const client = createPublicClient({
      chain,
      transport: http(rpcUrl, { timeout: 10_000 }),
    });

    const balance = await client.readContract({
      address: usdcAddress,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [address],
    });

    // USDC has 6 decimals
    return {
      balance: Number(balance) / 1_000_000,
      balanceAtomic: balance.toString(),
      network,
      ok: true,
    };
  } catch (err: any) {
    return {
      balance: 0,
      network,
      ok: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Check if a URL requires x402 payment.
 */
export async function checkX402(
  url: string,
): Promise<PaymentRequirement | null> {
  try {
    const resp = await x402HttpClient.request(url, { method: "HEAD", networkPolicy: "public", redirectPolicy: "none", retries: 0 });
    if (resp.status !== 402) {
      return null;
    }
    const parsed = await parsePaymentRequired(resp);
    return parsed?.requirement ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch a URL with automatic x402 payment.
 * If the endpoint returns 402, sign and pay, then retry.
 */
export async function x402Fetch(
  url: string,
  account: PrivateKeyAccount,
  method: string = "GET",
  body?: string,
  headers?: Record<string, string>,
  maxPaymentCents: number = 100,
  chainType?: ChainType,
  security: PaymentSecurityOptions = {},
): Promise<X402PaymentResult> {
  if (chainType === "solana") return { success: false, error: "x402 payment requires an EVM wallet. Solana automatons should use Conway credits API instead." };
  let ledger: PaymentLedger | undefined;
  let paymentInfo: X402PaymentResult["payment"];
  let reservationCreated = false;
  let signingStarted = false;
  try {
    const cap = centsToAtomic(maxPaymentCents);
    const operationId = security.operationId ?? randomUUID();
    if (security.operationId) {
      ledger = security.ledger ?? new PaymentLedger(security.ledgerPath);
      if (ledger.get(operationId)) throw new Error("Payment operation already reserved; reconcile its previous outcome before retrying");
    }
    // Never retry an arbitrary POST/PUT probe, or forward authentication/payment across redirects.
    const initialResp = await x402HttpClient.request(url, {
      method, headers: { ...headers, "Content-Type": "application/json" }, body,
      retries: 0, redirect: "error", redirectPolicy: "none", networkPolicy: security.networkPolicy ?? "public", idempotencyKey: operationId,
    });
    if (initialResp.status !== 402) {
      return { success: initialResp.ok, response: await readResponse(initialResp), status: initialResp.status };
    }
    const parsed = await parsePaymentRequired(initialResp, security, cap);
    if (!parsed) return { success: false, error: "Could not parse payment requirements", status: 402 };
    validateRequirement(parsed.requirement, security);
    const amountAtomic = parseMaxAmountRequired(parsed.requirement.maxAmountRequired, parsed.x402Version);
    if (amountAtomic > cap) return { success: false, error: "Payment exceeds max allowed amount", status: 402 };
    const amountCents = Number((amountAtomic + 9_999n) / 10_000n);
    const budget: PaymentBudget = {
      maxSingleCents: maxPaymentCents,
      maxHourlyCents: 10_000,
      maxDailyCents: 25_000,
      ...security.budget,
    };
    // The independent explicit call cap can never be broadened by budget configuration.
    budget.maxSingleCents = Math.min(budget.maxSingleCents, maxPaymentCents);
    const validUntil = (Math.floor(Date.now() / 1000) + parsed.requirement.requiredDeadlineSeconds) * 1000;
    ledger ??= security.ledger ?? new PaymentLedger(security.ledgerPath);
    ledger.reserve({ id: operationId, wallet: account.address, network: parsed.requirement.network,
      recipient: parsed.requirement.payToAddress, destination: new URL(url).origin, amountAtomic, validUntil }, budget);
    reservationCreated = true;
    paymentInfo = { operationId, amountAtomic: amountAtomic.toString(), amountCents,
      recipient: parsed.requirement.payToAddress, network: parsed.requirement.network, state: "reserved", validUntil };
    await security.beforeSign?.({ operationId, url, network: parsed.requirement.network,
      recipient: parsed.requirement.payToAddress, amountAtomic: amountAtomic.toString(), validUntil });
    // Persist uncertainty before invoking a signer: a crash after signature creation must not release budget.
    ledger.setState(operationId, "authorized");
    signingStarted = true;
    paymentInfo.state = "authorized";
    const payment = await signPayment(account, parsed.requirement, parsed.x402Version, Math.floor(validUntil / 1000));
    const paymentHeader = Buffer.from(JSON.stringify(payment)).toString("base64");
    const paidResp = await x402HttpClient.request(url, {
      method, headers: { ...headers, "Content-Type": "application/json", "X-Payment": paymentHeader }, body,
      retries: 0, redirect: "error", redirectPolicy: "none", networkPolicy: security.networkPolicy ?? "public", idempotencyKey: operationId,
    });
    paymentInfo.state = paidResp.ok ? "accepted" : "uncertain";
    ledger.setState(operationId, paymentInfo.state);
    return { success: paidResp.ok, response: await readResponse(paidResp), status: paidResp.status, payment: paymentInfo };
  } catch (err: any) {
    if (reservationCreated && ledger && paymentInfo) {
      paymentInfo.state = signingStarted ? "uncertain" : "failed";
      try { ledger.setState(paymentInfo.operationId, paymentInfo.state); } catch { /* reservation remains conservative */ }
    }
    return { success: false, error: err.message || String(err), payment: paymentInfo };
  } finally {
    if (ledger && ledger !== security.ledger) ledger.close();
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function parsePaymentRequired(
  resp: Response,
  security: PaymentSecurityOptions = {},
  cap?: bigint,
): Promise<ParsedPaymentRequirement | null> {
  const header = resp.headers.get("X-Payment-Required");
  if (header) {
    const rawHeader = safeJsonParse(header);
    const normalizedRaw = normalizePaymentRequired(rawHeader);
    if (normalizedRaw) {
      return {
        x402Version: normalizedRaw.x402Version,
        requirement: selectRequirement(normalizedRaw, security, cap),
      };
    }

    try {
      const decoded = Buffer.from(header, "base64").toString("utf-8");
      const parsedDecoded = normalizePaymentRequired(safeJsonParse(decoded));
      if (parsedDecoded) {
        return {
          x402Version: parsedDecoded.x402Version,
          requirement: selectRequirement(parsedDecoded, security, cap),
        };
      }
    } catch {
      // Ignore header decode errors and continue with body parsing.
    }
  }

  try {
    const body = await resp.json();
    const parsedBody = normalizePaymentRequired(body);
    if (!parsedBody) return null;
    return {
      x402Version: parsedBody.x402Version,
      requirement: selectRequirement(parsedBody, security, cap),
    };
  } catch {
    return null;
  }
}

async function signPayment(
  account: PrivateKeyAccount,
  requirement: PaymentRequirement,
  x402Version: number,
  validBefore: number,
): Promise<any> {
  const chain = CHAINS[requirement.network];
  if (!chain) {
    throw new Error(`Unsupported network: ${requirement.network}`);
  }

  const nonce = `0x${Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("hex")}`;

  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  const amount = parseMaxAmountRequired(
    requirement.maxAmountRequired,
    x402Version,
  );

  // EIP-712 typed data for TransferWithAuthorization
  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: chain.id,
    verifyingContract: requirement.usdcAddress,
  } as const;

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;

  const message = {
    from: account.address,
    to: requirement.payToAddress,
    value: amount,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce as `0x${string}`,
  };

  const signature = await account.signTypedData({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message,
  });

  return {
    x402Version,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: requirement.payToAddress,
        value: amount.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
}
