import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { parseSkillMd } from "../skills/format.js";
import { getActiveSkillInstructions } from "../skills/loader.js";

const directories: string[] = [];
function temporary() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "trading-integration-")); directories.push(d); return d; }
const root = process.cwd();
afterEach(() => { vi.restoreAllMocks(); directories.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })); });

describe("deployment preserves production authority", () => {
  it("modifies only guardian image and stop timeout in the existing netns Compose", () => {
    const dir = temporary(), file = path.join(dir, "compose.yaml"), image = "local/wallet-guardian:trading-1234567";
    const original = `# Existing production topology\nservices:\n  netns:\n    image: alpine:3.21\n  guardian:\n    image: local/wallet-guardian:existing\n    network_mode: service:netns\n    volumes: [state:/var/lib/guardian-state]\n    mem_limit: 384m\n  caddy:\n    image: caddy:alpine\n    network_mode: service:netns\nvolumes:\n  state:\n    external: true\n    name: egatrap-wallet-guardian_state\n`;
    fs.writeFileSync(file, original);
    const run = (...args: string[]) => execFileSync(process.execPath, ["scripts/patch-guardian-compose.mjs", file, image, ...args], { cwd: root, encoding: "utf8" });
    run(); expect(fs.readFileSync(file, "utf8")).toBe(original);
    run("--apply");
    const expected = parse(original); expected.services.guardian.image = image; expected.services.guardian.stop_grace_period = "130s";
    expect(parse(fs.readFileSync(file, "utf8"))).toEqual(expected);
    const backup = fs.readdirSync(dir).find(n => n.includes("before-trading"))!;
    expect(fs.readFileSync(path.join(dir, backup), "utf8")).toBe(original);
    expect(fs.statSync(path.join(dir, backup)).mode & 0o777).toBe(0o600);
  });
  it("refuses to replace an unexpected Compose topology", () => {
    const file = path.join(temporary(), "compose.yaml"); fs.writeFileSync(file, "services: {guardian: {image: old, ports: ['8787:8787']}}");
    expect(() => execFileSync(process.execPath, ["scripts/patch-guardian-compose.mjs", file, "local/wallet-guardian:trading-1234567", "--apply"], { cwd: root, stdio: "pipe" })).toThrow();
    expect(fs.readFileSync(file, "utf8")).toContain("8787:8787");
  });
  it("enables local reports without altering budgets, credentials, prompt or destination", () => {
    const file = path.join(temporary(), "automaton.json");
    execFileSync("git", ["init", "--quiet", path.dirname(file)]);
    const original = { genesisPrompt: "keep mission", anthropicApiKey: "test-secret-do-not-print", inferenceBudget: { maxDailyCostCents: 300 }, walletGuardian: { walletAddress: "funded", ownerAddress: "owner" } };
    fs.writeFileSync(file, JSON.stringify(original));
    const out = execFileSync("python3", ["scripts/configure-runtime-trading.py", "--config", file, "--mode", "on"], { cwd: root, encoding: "utf8" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ...original, trading: { enabled: true } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600); expect(out).not.toContain(original.anthropicApiKey);
    fs.writeFileSync(path.join(path.dirname(file), "trading-report.json"), "{}");
    expect(execFileSync("git", ["-C", path.dirname(file), "check-ignore", "automaton.json", "trading-report.json"], { encoding: "utf8" })).toContain("trading-report.json");
  });
  it("installs four parseable local skills idempotently without overwriting other skills", () => {
    const dir = temporary(); fs.mkdirSync(path.join(dir, "user-skill")); fs.writeFileSync(path.join(dir, "user-skill", "SKILL.md"), "untouched");
    const run = () => execFileSync("python3", ["scripts/install-trading-skills.py", "--directory", dir], { cwd: root, encoding: "utf8" });
    run(); run();
    const skills = fs.readdirSync(dir).filter(n => n.startsWith("trading-")).map(n => {
      const file = path.join(dir, n, "SKILL.md"); return parseSkillMd(fs.readFileSync(file, "utf8"), file)!;
    });
    expect(skills).toHaveLength(4); expect(skills.every(s => s.autoActivate && s.enabled)).toBe(true);
    const active = getActiveSkillInstructions(skills); expect(active).toContain("trading_status"); expect(active).toContain("agentkit_read"); expect(active).not.toContain("[REMOVED:");
    expect(fs.readFileSync(path.join(dir, "user-skill", "SKILL.md"), "utf8")).toBe("untouched");
  });
});

describe("independent candle valuation", () => {
  async function source() {
    vi.resetModules();
    const { ResilientHttpClient } = await import("../conway/http-client.js");
    const spy = vi.spyOn(ResilientHttpClient.prototype, "request");
    const { fetchCandles } = await import("../trading/market.js");
    const now = Date.now(), end = Math.floor(now / 300000) * 300;
    const raw = Array.from({ length: 240 }, (_, i) => [end - (240 - i) * 300, 999, 1001, 1000, 1000, 10]);
    return { spy, fetchCandles, raw, now };
  }
  it("uses ETH/USDC data directly without inventing a USD exchange rate", async () => {
    const s = await source(); s.spy.mockResolvedValueOnce(Response.json(s.raw));
    expect((await s.fetchCandles(s.now))[0].close).toBe(1000); expect(s.spy).toHaveBeenCalledTimes(1);
  });
  it("uses a checked USDC/USD conversion when Coinbase redirects the product to a USD book", async () => {
    const s = await source(); s.spy.mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(Response.json(s.raw))
      .mockResolvedValueOnce(Response.json({ coins: { "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { price: .99, timestamp: Math.floor(s.now / 1000) } } }));
    expect((await s.fetchCandles(s.now))[0].close).toBeCloseTo(1000 / .99);
    expect(s.spy.mock.calls[1][0]).toContain("ETH-USD");
  });
  it.each(["stale", "depegged"])("rejects %s USDC conversion instead of assuming one dollar", async kind => {
    const s = await source(); s.spy.mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(Response.json(s.raw))
      .mockResolvedValueOnce(Response.json({ coins: { "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { price: kind === "depegged" ? .9 : 1, timestamp: Math.floor(s.now / 1000) - (kind === "stale" ? 3600 : 0) } } }));
    await expect(s.fetchCandles(s.now)).rejects.toThrow("USDC/USD");
  });
});
