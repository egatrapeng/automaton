import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrivateKeyAccount } from "viem";
import { ResilientHttpClient } from "../conway/http-client.js";
import { x402Fetch } from "../conway/x402.js";
import * as payments from "../conway/x402.js";
import { topupCredits } from "../conway/topup.js";
import { PaymentLedger, type PaymentReservation } from "../conway/payment-ledger.js";

const address = "0x2222222222222222222222222222222222222222";
const recipient = "0x1111111111111111111111111111111111111111";
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
function account() { return { address, signTypedData: vi.fn().mockResolvedValue("0xfake") } as unknown as PrivateKeyAccount; }
function requirement(overrides: Record<string, unknown> = {}) {
  return Response.json({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", maxAmountRequired: "1000000", payTo: recipient, asset: usdc, maxTimeoutSeconds: 300, ...overrides }] }, { status: 402 });
}
function reservation(id: string, atomic = 1_000_000n): PaymentReservation {
  return { id, wallet: address, network: "eip155:8453", recipient, destination: "https://service.example", amountAtomic: atomic, validUntil: Date.now() + 300_000 };
}
const ledgers: PaymentLedger[] = [];
const dirs: string[] = [];
function ledger() { const value = new PaymentLedger(":memory:"); ledgers.push(value); return value; }
afterEach(() => { vi.restoreAllMocks(); ledgers.splice(0).forEach(l => l.close()); dirs.splice(0).forEach(d => fs.rmSync(d, {recursive: true, force: true})); });

describe("payment authorization security", () => {
  it("rejects a $500 server requirement for a selected $5 recharge before signing", async () => {
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValue(requirement({maxAmountRequired: "500000000"}));
    const wallet = account();
    const result = await topupCredits("https://api.conway.tech", wallet, 5, undefined, {ledger: ledger()});
    expect(result.success).toBe(false);
    expect(wallet.signTypedData).not.toHaveBeenCalled();
  });

  it("preserves autonomous recharge with exact amount and durable accounting", async () => {
    const http = vi.spyOn(ResilientHttpClient.prototype, "request")
      .mockResolvedValueOnce(requirement({maxAmountRequired: "5000000"}))
      .mockResolvedValueOnce(Response.json({credits_cents: 500}));
    const wallet = account(), book = ledger();
    const result = await topupCredits("https://api.conway.tech", wallet, 5, undefined, {ledger: book, operationId: "topup-1"});
    expect(result.success).toBe(true);
    expect(wallet.signTypedData).toHaveBeenCalledWith(expect.objectContaining({message: expect.objectContaining({value: 5_000_000n})}));
    expect(result.payment).toMatchObject({amountAtomic: "5000000", amountCents: 500, state: "accepted"});
    expect(book.get("topup-1")).toMatchObject({state: "accepted", amount_atomic: "5000000"});
    expect(http.mock.calls[1][1]).toMatchObject({retries: 0, redirect: "error", idempotencyKey: "topup-1"});
  });

  it.each([
    {scheme: "upto"}, {asset: recipient}, {payTo: "0x0000000000000000000000000000000000000000"},
    {payTo: "invalid"}, {maxTimeoutSeconds: 301}, {maxTimeoutSeconds: -1}, {maxTimeoutSeconds: 0},
    {maxAmountRequired: "0"}, {maxAmountRequired: "-1"}, {maxAmountRequired: "1e6"}, {maxAmountRequired: "0.0000001"},
  ])("rejects invalid payment requirements %j", async (bad) => {
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValue(requirement(bad));
    const wallet = account();
    const result = await x402Fetch("https://service.example", wallet, "GET", undefined, undefined, 100, "evm", {ledger: ledger()});
    expect(result.success).toBe(false);
    expect(wallet.signTypedData).not.toHaveBeenCalled();
  });

  it("pins recharge network and optional recipient without breaking generic requests", async () => {
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValue(requirement({network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"}));
    const wallet = account();
    const result = await topupCredits("https://api.conway.tech", wallet, 5, undefined, {ledger: ledger()});
    expect(result.success).toBe(false); expect(wallet.signTypedData).not.toHaveBeenCalled();
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValue(requirement());
    const pinned = await x402Fetch("https://service.example", wallet, "GET", undefined, undefined, 100, "evm", {ledger: ledger(), allowedRecipients: []});
    expect(pinned.success).toBe(false); expect(wallet.signTypedData).not.toHaveBeenCalled();
  });

  it("uses atomic integers for v1 amounts instead of guessing from string length", async () => {
    const req = Response.json({x402Version: 1, accepts: [{scheme: "exact", network: "eip155:8453", maxAmountRequired: "10000", payTo: recipient}]}, {status: 402});
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(req).mockResolvedValueOnce(Response.json({ok: true}));
    const wallet = account();
    const result = await x402Fetch("https://service.example", wallet, "GET", undefined, undefined, 1, "evm", {ledger: ledger()});
    expect(result.success).toBe(true);
    expect(wallet.signTypedData).toHaveBeenCalledWith(expect.objectContaining({message: expect.objectContaining({value: 10_000n})}));
  });

  it("selects an acceptable offer rather than rejecting a service with multiple payment options", async () => {
    const req = Response.json({x402Version: 2, accepts: [
      {scheme: "exact", network: "eip155:8453", maxAmountRequired: "500000000", payTo: recipient},
      {scheme: "exact", network: "eip155:8453", maxAmountRequired: "5000000", payTo: recipient},
    ]}, {status: 402});
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(req).mockResolvedValueOnce(Response.json({credits_cents: 500}));
    const wallet = account();
    const result = await topupCredits("https://api.conway.tech", wallet, 5, undefined, {ledger: ledger()});
    expect(result.success).toBe(true);
    expect(wallet.signTypedData).toHaveBeenCalledWith(expect.objectContaining({message: expect.objectContaining({value: 5_000_000n})}));
  });

  it("retains uncertain authorizations after network failure and refuses a duplicate operation", async () => {
    const http = vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(requirement()).mockRejectedValueOnce(new Error("connection lost"));
    const wallet = account(), book = ledger();
    const options = {ledger: book, operationId: "uncertain-1"};
    const result = await x402Fetch("https://service.example", wallet, "POST", "{}", undefined, 100, "evm", options);
    expect(result.payment?.state).toBe("uncertain");
    expect(book.get("uncertain-1")?.state).toBe("uncertain");
    expect(http).toHaveBeenCalledTimes(2);
    http.mockResolvedValueOnce(requirement());
    const duplicate = await x402Fetch("https://service.example", wallet, "POST", "{}", undefined, 100, "evm", options);
    expect(duplicate.success).toBe(false); expect(duplicate.error).toContain("already reserved");
    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
    expect(() => book.setState("uncertain-1", "failed")).toThrow("cannot be released");
    expect(() => book.setState("uncertain-1", "reserved")).toThrow("state transition");
  });

  it("retains budget when the signer might have signed before throwing", async () => {
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(requirement());
    const wallet = account(); vi.mocked(wallet.signTypedData).mockRejectedValue(new Error("signer lost connection"));
    const book = ledger();
    const result = await x402Fetch("https://service.example", wallet, "GET", undefined, undefined, 100, "evm", {ledger: book, operationId: "signer-1"});
    expect(result.payment?.state).toBe("uncertain"); expect(book.get("signer-1")?.state).toBe("uncertain");
  });

  it("enforces an optional USDC reserve using a fresh exact wallet balance", async () => {
    const balance = vi.spyOn(payments, "getUsdcBalanceDetailed").mockResolvedValue({balance: 6, balanceAtomic: "6000000", network: "eip155:8453", ok: true});
    vi.spyOn(ResilientHttpClient.prototype, "request").mockResolvedValueOnce(requirement({maxAmountRequired: "5000000"}));
    const wallet = account();
    const result = await topupCredits("https://api.conway.tech", wallet, 5, undefined, {ledger: ledger(), budget: {minimumReserveCents: 200}});
    expect(balance).toHaveBeenCalledWith(address, "eip155:8453");
    expect(result.success).toBe(false); expect(result.error).toContain("minimum reserve");
    expect(wallet.signTypedData).not.toHaveBeenCalled();
  });

  it("does not purchase when a requested reserve cannot be verified", async () => {
    vi.spyOn(payments, "getUsdcBalanceDetailed").mockResolvedValue({balance: 0, network: "eip155:8453", ok: false});
    const wallet = account();
    const result = await topupCredits("https://api.conway.tech", wallet, 5, undefined, {ledger: ledger(), budget: {minimumReserveCents: 200}});
    expect(result.success).toBe(false); expect(result.error).toContain("balance unavailable");
    expect(wallet.signTypedData).not.toHaveBeenCalled();
  });

  it("reserves concurrent requests before awaiting an asynchronous signer", async () => {
    vi.spyOn(ResilientHttpClient.prototype, "request").mockImplementation(async (_url, options) => options?.headers && (options.headers as Record<string,string>)["X-Payment"] ? Response.json({ok: true}) : requirement());
    let release!: (signature: `0x${string}`) => void;
    const wallet = account();
    vi.mocked(wallet.signTypedData).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const book = ledger(), budget = {maxHourlyCents: 100, maxDailyCents: 100};
    const first = x402Fetch("https://service.example", wallet, "GET", undefined, undefined, 100, "evm", {ledger: book, budget});
    await vi.waitFor(() => expect(wallet.signTypedData).toHaveBeenCalledTimes(1));
    const second = await x402Fetch("https://service.example", wallet, "GET", undefined, undefined, 100, "evm", {ledger: book, budget});
    expect(second.success).toBe(false); expect(second.error).toContain("hourly budget");
    release("0xfake"); expect((await first).success).toBe(true);
    expect(wallet.signTypedData).toHaveBeenCalledTimes(1);
  });
});

describe("durable atomic budget reservations", () => {
  it("enforces cumulative caps across connections and restarts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-payments-")); dirs.push(dir);
    const filename = path.join(dir, "ledger.db"), limits = {maxSingleCents: 100, maxHourlyCents: 100, maxDailyCents: 200};
    const a = new PaymentLedger(filename), b = new PaymentLedger(filename); ledgers.push(a,b);
    a.reserve(reservation("first", 600_000n), limits); a.setState("first", "authorized");
    expect(() => b.reserve(reservation("second", 600_000n), limits)).toThrow("hourly");
    const reopened = new PaymentLedger(filename); ledgers.push(reopened);
    expect(reopened.get("first")?.state).toBe("authorized");
    expect(() => reopened.reserve(reservation("third", 600_000n), limits)).toThrow("hourly");
    if (process.platform !== "win32") expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  });

  it("enforces reserve and destination limits before issuing any authorization", () => {
    const book = ledger();
    const limits = {maxSingleCents: 1000, maxHourlyCents: 2000, maxDailyCents: 3000, minimumReserveCents: 500, balanceAtomic: 6_000_000n};
    expect(() => book.reserve(reservation("reserve", 2_000_000n), limits)).toThrow("minimum reserve");
    expect(book.get("reserve")).toBeUndefined();
    expect(() => book.reserve(reservation("balance-required"), {...limits, balanceAtomic: undefined})).toThrow("balance required");
    book.reserve(reservation("allowed"), {...limits, minimumReserveCents: 0, maxDestinationDailyCents: 100});
    expect(() => book.reserve(reservation("blocked"), {...limits, minimumReserveCents: 0, maxDestinationDailyCents: 100})).toThrow("destination");
  });

  it("does not drop an active authorization at a calendar window boundary", () => {
    const book = ledger(), now = Date.now();
    const item = reservation("old"); item.validUntil = now + 1000;
    const limits = {maxSingleCents: 100, maxHourlyCents: 100, maxDailyCents: 100};
    book.reserve(item, limits, now - 86_400_001); book.setState("old", "authorized"); book.setState("old", "uncertain");
    expect(() => book.reserve(reservation("new"), limits, now)).toThrow("hourly");
  });
});
