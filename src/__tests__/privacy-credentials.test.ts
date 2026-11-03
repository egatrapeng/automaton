import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import * as wallet from "../identity/wallet.js";
import { loadApiKeyFromConfig, provision } from "../identity/provision.js";
import { redactText } from "../security/redaction.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("legitimate credential registration", () => {
  it("registers an existing test wallet key without changing its signing functionality", async () => {
    const privateKey = `0x${"12".repeat(32)}`;
    const exists = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const read = vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ chainType: "evm", privateKey }));
    const result = await wallet.getWallet();
    expect(result.chainType).toBe("evm");
    expect(await result.account.signMessage({ message: "audit test only" })).toMatch(/^0x[0-9a-f]+$/);
    expect(redactText(`echo ${privateKey}`)).toBe("echo [REDACTED]");
    expect(exists).toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(String(read.mock.calls[0][0])).toMatch(/\.automaton\/wallet\.json$/);
  });

  it("registers a test API key from its existing configuration and returns its real value to authentication", () => {
    const key = "fake-config-provider-private-credential";
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const read = vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ apiKey: key }));
    expect(loadApiKeyFromConfig()).toBe(key);
    expect(redactText(`echo ${key}`)).toBe("echo [REDACTED]");
    expect(read).toHaveBeenCalledTimes(1);
    expect(String(read.mock.calls[0][0])).toMatch(/\.automaton\/config\.json$/);
  });

  it("registers newly provisioned tokens/keys while preserving functional saved credentials", async () => {
    const address = "0x2222222222222222222222222222222222222222";
    const accessToken = "fake-provision-access-credential";
    const apiKey = "fake-new-provision-private-credential";
    vi.spyOn(wallet, "getWallet").mockResolvedValue({
      account: { address, signMessage: async () => "0xFAKE_NOT_VALID" } as any,
      chainIdentity: { address, chainType: "evm" } as any, chainType: "evm", isNew: false,
    });
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const replies = [
      Response.json({ nonce: "auditnonce123456" }),
      Response.json({ access_token: accessToken }),
      Response.json({ key: apiKey, key_prefix: "fake-prefix" }),
    ];
    const fetch = vi.fn(async () => replies.shift()!);
    vi.stubGlobal("fetch", fetch);
    const result = await provision("https://fake-provision.invalid");
    expect(result.apiKey).toBe(apiKey);
    expect(redactText(`${accessToken} ${apiKey}`)).toBe("[REDACTED] [REDACTED]");
    expect(String(write.mock.calls[0][1])).toContain(apiKey);
    const request = fetch.mock.calls[2] as unknown as [string, RequestInit];
    expect(new Headers(request[1].headers).get("authorization")).toBe(`Bearer ${accessToken}`);
  });
});
