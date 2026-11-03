# Privacy boundaries

The runtime sends the selected inference provider the model context: the system
prompt, active skill instructions, conversation and tool results. The social
relay receives messages addressed through it. A remote Conway sandbox receives
commands and file contents used by its API. These are functional data flows,
not local-only computation. Provider retention policies are outside this code's
control.

`src/security/redaction.ts` provides a defense in depth for registered runtime
credentials and strongly labelled secret formats. It sanitizes structured logs
(including custom/pretty sinks and error stacks), Conway/OpenAI/Anthropic model
payloads, and the unified inference client's SDK payloads and returned results.
Real authentication headers remain intact so providers continue to work.
Ordinary build output, public addresses, transaction hashes and tool schemas are
preserved. The caller's original history and SDK authentication are not mutated.

Call `registerSecret(value)` or `registerSecrets(...values)` when credentials are
already legitimately loaded for runtime use. Do not scan the filesystem or dump
the environment to populate the registry. Values shorter than eight characters
are not globally replaced, since that would corrupt ordinary language; they are
still removed when identified by sensitive field names or credential labels.
Wallet keys and provisioning credentials are registered when the wallet or
provisioning operation legitimately loads or generates them. Their functional
credential files retain the real values; the redactor does not rewrite them.
Custom application secrets unknown to the runtime must be registered by their
trusted integration if they might enter output or model context.

New `turns` and `tool_calls` records redact input, reasoning, tool arguments,
results and errors at the database write boundary. Operational configuration,
identity and arbitrary KV state are not indiscriminately altered: replacing
authentication values there would break the service. Existing records are not
rewritten or automatically deleted by a migration.

Redact **before** truncating results or serializing them into persistent history.
Otherwise a prefix of a long secret could survive a full-value comparison.

## Limitations and compatibility

Redaction does not prevent an unrestricted process from reading or intentionally
encoding a secret. Unknown unlabelled values, transforms such as base64, and
secrets copied into files outside the covered boundaries cannot be reliably
detected by these patterns. It does not encrypt existing state, purge old logs,
or provide a sandbox. Keep wallet/signing material and unrelated credentials
outside a tool process's access wherever the deployment permits.

Do not hide entire tool outputs or remove inference just to prevent data flow:
those are core agent functions. This implementation retains them and removes
credential values at covered boundaries. A workflow requiring transmission of
an actual secret should use a trusted integration that injects it at the
destination (e.g. the HTTP authentication header), without putting it in the
model's prompt. Source code templates can use placeholders; real credential
provisioning should happen in a tool/service that does not echo values.

The machine's state, logs and backups still need an operator-defined retention
and secure deletion policy. No automatic purge of user history is performed:
deleting existing audit data would change user-visible behavior and require an
explicit retention decision.
