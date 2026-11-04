// Exercise the published SDK with fake HTTP; no account, live API or transaction.
import assert from "node:assert/strict";
import test from "node:test";
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  return Response.json({ coins: { "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { price: 1, timestamp: 123 } } });
};
const { createObserver } = await import("./observer.mjs");
const { actions, wallet } = await createObserver();
test("published AgentKit exposes exactly five data actions and no signer", async () => {
  assert.equal(actions.length, 5);
  for (const name of ["sign", "nativeTransfer", "sendTransaction", "signTransaction", "signMessage", "signTypedData"]) await assert.rejects(wallet[name](), /Read-only/);
  assert(!actions.some(a => /transfer|swap|send|sign/i.test(a.name)));
});
test("an actual SDK data action reaches only the fake public GET adapter", async () => {
  const action = actions.find(a => a.name.endsWith("get_token_prices"));
  const args = action.schema.parse({ tokens: ["base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"] });
  const result = await action.invoke(args);
  assert.match(result, /833589/);
  assert(calls.some(c => c.url.startsWith("https://coins.llama.fi/")));
  assert(calls.every(c => c.url.startsWith("https://coins.llama.fi/") && c.options.redirect === "error"));
  assert.throws(() => action.schema.parse({ tokens: [], recipient: "someone" }));
});
test("analytics are discarded and unknown hosts and write methods never reach HTTP", async () => {
  const count = calls.length;
  assert.equal((await fetch("https://cca-lite.coinbase.com/amp", { method: "POST" })).status, 204);
  await assert.rejects(fetch("http://169.254.169.254/"), /only public/);
  await assert.rejects(fetch("https://coins.llama.fi/", { method: "POST" }), /only public/);
  await assert.rejects(fetch("https://coins.llama.fi:8443/"), /only public/);
  assert.equal(calls.length, count);
});
