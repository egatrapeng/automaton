import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretRedactor, registerSecret, redactText } from "../security/redaction.js";
import { StructuredLogger, createLogger } from "../observability/logger.js";
import { createInferenceClient } from "../conway/inference.js";
import { UnifiedInferenceClient } from "../inference/inference-client.js";
import type { LogEntry } from "../types.js";
import { createDatabase } from "../state/database.js";

afterEach(() => {
  StructuredLogger.resetSink();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("privacy redaction boundaries", () => {
  it("redacts explicitly registered values without changing useful ordinary text", () => {
    const redactor = new SecretRedactor();
    redactor.register("fake-secret-credential-for-audit");
    expect(redactor.text("command result: fake-secret-credential-for-audit; status ok"))
      .toBe("command result: [REDACTED]; status ok");
    const publicText = "0x" + "a".repeat(64);
    expect(redactor.text(publicText)).toBe(publicText);
    expect(redactor.text("install nodejs and run npm test")).toBe("install nodejs and run npm test");
  });

  it("redacts the escaped form of multiline registered secrets", () => {
    const redactor = new SecretRedactor();
    const secret = "fake-secret\nwith-another-line";
    redactor.register(secret);
    expect(redactor.text(JSON.stringify({ content: secret }))).not.toContain("fake-secret");
  });

  it("redacts labelled credentials, provider keys, private PEM blocks and URL credentials", () => {
    const redactor = new SecretRedactor();
    const values = [
      '{"privateKey":"0x' + "b".repeat(64) + '"}',
      "Authorization: Bearer fake-auth-header-token",
      "https://user:fake-password@host.test/?api_key=fake-query-value",
      "password=fake-unquoted-password",
      "sk-proj-abcdefghijklmnopqrstuvwxyz1234",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE_PRIVATE_MATERIAL\n-----END OPENSSH PRIVATE KEY-----",
    ];
    for (const value of values) {
      const safe = redactor.text(value);
      expect(safe).toContain("[REDACTED]");
      expect(safe).not.toContain("fake-");
      expect(safe).not.toContain("FAKE_PRIVATE_MATERIAL");
    }
  });

  it("redacts nested sensitive fields without mutating the caller or destroying schemas", () => {
    const redactor = new SecretRedactor();
    const original = { result: { apiKey: "fake-nested-key", count: 4 }, schema: { properties: { apiKey: { type: "string" } } } };
    expect(redactor.value(original)).toEqual({
      result: { apiKey: "[REDACTED]", count: 4 },
      schema: { properties: { apiKey: { type: "string" } } },
    });
    expect(original.result.apiKey).toBe("fake-nested-key");
  });

  it("handles cycles without dropping the safe surrounding information", () => {
    const redactor = new SecretRedactor();
    const original: Record<string, unknown> = { status: "ok", password: "fake-value" };
    original.self = original;
    expect(redactor.value(original)).toEqual({ status: "ok", password: "[REDACTED]", self: "[Circular]" });
  });

  it("sanitizes custom sinks, nested contexts, messages and error stacks", () => {
    const secret = "fake-runtime-credential-that-must-not-leak";
    registerSecret(secret);
    const entries: LogEntry[] = [];
    StructuredLogger.setSink((entry) => entries.push(entry));
    createLogger("privacy-test").error(`request failed: ${secret}`, new Error(`echo ${secret}`), {
      args: { body: secret, secretKey: "other-unregistered-secret" },
      useful: "build completed",
    });
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("other-unregistered-secret");
    expect(serialized).toContain("build completed");
    expect(entries[0].error?.stack).toContain("[REDACTED]");
  });

  it("sanitizes logger fallback output even when the sink fails", () => {
    const secret = "fake-fallback-credential-that-must-not-leak";
    registerSecret(secret);
    StructuredLogger.setSink(() => { throw new Error("broken sink"); });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    createLogger("privacy-test").info(`result ${secret}`);
    expect(write).toHaveBeenCalled();
    expect(String(write.mock.calls[0][0])).not.toContain(secret);
    expect(String(write.mock.calls[0][0])).toContain("[REDACTED]");
  });

  it("keeps credentials in Conway authentication headers but removes them from the model payload", async () => {
    const key = "fake-conway-inference-private-credential";
    const fetchMock = vi.fn(async () => Response.json({
      choices: [{ message: { role: "assistant", content: "ordinary response" } }],
      usage: {},
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createInferenceClient({ apiUrl: "https://fake-inference.invalid", apiKey: key, defaultModel: "fake", maxTokens: 32 });
    const history = [{ role: "user" as const, content: `tool saw ${key}; build project` }];
    const result = await client.chat(history);
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(request[1].headers).get("authorization")).toBe(key);
    expect(request[1].body).not.toContain(key);
    expect(request[1].body).toContain("build project");
    expect(history[0].content).toContain(key);
    expect(result.message.content).toBe("ordinary response");
  });

  it("also sanitizes Anthropic system, tool result and tool definition payloads", async () => {
    const key = "fake-anthropic-private-credential";
    const fetchMock = vi.fn(async () => Response.json({ content: [{ type: "text", text: "ok" }], usage: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createInferenceClient({ apiUrl: "https://fake-inference.invalid", apiKey: "fake-conway", anthropicApiKey: key, defaultModel: "claude-fake", maxTokens: 32 });
    await client.chat([{ role: "system", content: `system ${key}` }, { role: "user", content: "compile" }]);
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(request[0]).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(request[1].headers).get("x-api-key")).toBe(key);
    expect(request[1].body).not.toContain(key);
    expect(request[1].body).toContain("compile");
  });

  it("redacts echoed credentials from provider errors", async () => {
    const key = "fake-error-echo-private-credential";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`invalid API key ${key}`, { status: 400 })));
    const client = createInferenceClient({ apiUrl: "https://fake-inference.invalid", apiKey: key, defaultModel: "fake", maxTokens: 32 });
    await expect(client.chat([{ role: "user", content: "hello" }])).rejects.toThrow("[REDACTED]");
    expect(redactText(`invalid API key ${key}`)).not.toContain(key);
  });

  it("sanitizes the unified SDK prompt and output without changing SDK authentication", async () => {
    const key = "fake-unified-sdk-private-credential";
    const create = vi.fn(async () => ({ choices: [{ message: { content: `echo ${key}` } }], usage: {} }));
    const sdk = { apiKey: key, chat: { completions: { create } } };
    const registry = {
      getModel: () => ({ client: sdk, provider: { id: "fake" }, model: { id: "fake-model", tier: "fast", costPerInputToken: 0, costPerOutputToken: 0 } }),
      enableProvider: vi.fn(),
    };
    const client = new UnifiedInferenceClient(registry as any);
    const result = await client.chatDirect({ providerId: "fake", modelId: "fake-model", messages: [{ role: "user", content: `secret ${key}; run build` }] });
    expect(JSON.stringify(create.mock.calls)).not.toContain(key);
    expect(JSON.stringify(create.mock.calls)).toContain("run build");
    expect(sdk.apiKey).toBe(key);
    expect(result.content).toBe("echo [REDACTED]");
  });

  it("redacts newly persisted turns/tool calls while keeping execution arguments intact", () => {
    const secret = "fake-database-runtime-credential";
    registerSecret(secret);
    const db = createDatabase(":memory:");
    const call = {
      id: "privacy-call", name: "exec", arguments: { command: `echo ${secret}`, password: "fake-labelled-db-password" },
      result: `result ${secret}`, error: `failed ${secret}`, durationMs: 1,
    };
    const turn = {
      id: "privacy-turn", timestamp: new Date().toISOString(), state: "running" as const,
      input: `input ${secret}`, thinking: `thinking ${secret}`, toolCalls: [call],
      tokenUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 }, costCents: 0,
    };
    try {
      db.insertTurn(turn);
      db.insertToolCall(turn.id, call);
      const raw = JSON.stringify({
        turns: db.raw.prepare("SELECT * FROM turns").all(),
        calls: db.raw.prepare("SELECT * FROM tool_calls").all(),
      });
      expect(raw).not.toContain(secret);
      expect(raw).not.toContain("fake-labelled-db-password");
      expect(raw).toContain("[REDACTED]");
      expect(db.getTurnById(turn.id)?.thinking).toBe("thinking [REDACTED]");
      expect(call.arguments.command).toContain(secret);
      expect(turn.input).toContain(secret);
      // Functional state is not indiscriminately redacted and made unusable.
      db.setKV("trusted-auth-config", secret);
      expect(db.getKV("trusted-auth-config")).toBe(secret);
    } finally { db.close(); }
  });

  it("does not rewrite or erase existing history when opening a database", () => {
    const secret = "fake-history-already-stored-before-upgrade";
    const db = createDatabase(":memory:");
    try {
      db.raw.prepare("INSERT INTO turns (id, timestamp, state, thinking, tool_calls, token_usage, cost_cents) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("old-record", new Date().toISOString(), "running", secret, "[]", "{}", 0);
      registerSecret(secret);
      // Existing history remains available to the owner. Outbound model/log
      // boundaries will redact it without destructive migration of audit data.
      expect(db.getTurnById("old-record")?.thinking).toBe(secret);
    } finally { db.close(); }
  });
});
