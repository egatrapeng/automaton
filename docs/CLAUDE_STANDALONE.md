# Claude API on a dedicated VPS, without Conway

Use this mode when there is no Conway account. A real Anthropic API key and API
billing are required; a Claude subscription alone does not supply API credit.

From the already configured checkout:

```sh
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run build
python3 scripts/configure-claude.py
node dist/index.js --run
```

Enter the key only in the interactive terminal prompt, never in chat, the command
line or Git. The script keeps the identity, wallet and genesis prompt, writes a
private configuration backup, and replaces the configuration atomically with mode
0600. It makes no network/API request. It asks for a model ID and daily estimated
budget; the default is `claude-sonnet-4-6` and USD 1.00/day. Verify that the chosen
model is available to your Anthropic account. Set a provider-side spending limit
as well. The runtime uses conservative planning price estimates ($10/M input,
$50/M output), not a live pricing feed or provider invoice. Local limits do not
constitute an enforceable cap against a host administrator or concurrent external
API clients.

`runtimeMode: "standalone"` explicitly requires host execution, an Anthropic key
and a Claude model ID. It does not synthesize Conway credits, register with
Conway, poll Conway balances, buy credits or send requests to its control plane.
The selected Claude model is pinned for inference instead of falling back to
GPT/Conway on low credits. Configuration/credential/model errors are reported;
the program does not manufacture credentials or bypass account restrictions.

Local shell/files, git, skills, persistent memory, inference budget tracking,
sleep/wakeup and local maintenance heartbeats remain available. This first
standalone profile runs a single local agent; the Conway colony/orchestration
bootstrap and goal-delegation tools are not used. Remote provisioning, credit
transfers, Conway messaging/domains and Conway model discovery require a real
Conway account and are not offered in this profile. Operator-enabled on-chain
tools and external web requests retain their own existing policies.

Heartbeat credit zero is recorded as zero, never as an invented positive balance;
the operational tier is normal because inference is billed by Anthropic. The
prompt explicitly distinguishes this from Conway survival funding. Maintenance
tasks that need Conway are not scheduled. The API key remains a local secret,
subject to the same host-administrator trust limitations described in
`SECURITY_UPGRADE.md`; this mode does not add OS isolation.

Validation: 1,798 tests passed across 74 files, including five standalone tests.
The end-to-end test uses simulated Anthropic responses, executes a real harmless
host command, verifies native tool-result blocks, and asserts every HTTP request
targets Anthropic. Another verifies a zero daily budget prevents any inference
request. The migration script was exercised against a temporary home and fake
credential: identity/prompt/wallet preserved, backup and mode 0600 verified.
Typecheck and both builds passed. No live Anthropic key or billable inference
request was used during development. Actual account/model access and VPS runtime
remain to be validated by the operator.
