# Social messages and task provenance

Messages received from the social relay are external task data. The relay's
`from` field, a sender signature, and even a sender address matching the configured
creator do not grant creator or internal-agent authority. Creator administration
requires a separately authenticated operator channel; the relay is not that channel.

The runtime now verifies a sender signature when the relay supplies it. Verification
uses the existing `Conway:send:<recipient>:<content-hash>:<signed-at>` format, supports
EVM and Solana, and preserves the case of Solana addresses. Modified content,
substituted senders, malformed signatures, mismatched recipients, invalid timestamps
and timestamps more than one minute in the future are rejected. The protocol does
not sign relay message IDs, nonces or reply metadata, so those fields do not confer
authority or determine signed-message replay identity.

With the runtime database, an atomic receipt of the signed payload is retained in
`heartbeat_dedup` without expiry. Changing a relay ID or nonce cannot replay that
payload. Without a database, the client has only a bounded in-memory receipt cache;
cross-restart replay protection is unavailable. Persistent receipts grow with the
number of distinct messages and must be retained together with the inbox for replay
protection. Database errors fail the poll rather than silently accepting replays.

## Compatibility decisions

Two proposed restrictions would prevent normal communication and were not applied:

- Requiring signatures from every relay response would discard all messages from
  legacy relays that omit them. Such messages remain readable, strictly as external
  data. Their sender claims cannot be independently authenticated. A malicious relay
  can fabricate unsigned content or remove a signature, but cannot thereby acquire
  creator/agent authority. If a signature is provided and fails verification, the
  message is rejected rather than downgraded.
- Rejecting every message older than five minutes would discard the inbox of an
  agent that was offline. Queued messages remain readable; signed payload receipts,
  recipient validation, future-time checks and external authority are used instead.
  An old message is not evidence of a fresh authorization.

## Policy and delegation

Inbox input is recorded as `external`, and that policy source remains external for
follow-up turns in the same run, including generated system feedback. Retained
external turns are recognized on the next run. Filtering prompts is an additional
heuristic, not an authorization mechanism.

Goal provenance is stored by the runtime in the existing KV table, outside the goal
description supplied by the model. A goal marked external cannot be upgraded by a
subsequent trusted-looking call. Workers inherit goal provenance. External tasks
can delegate to local workers and still use ordinary development, package install
and paid API operations within operator-approved budgets. They cannot use the
existing external-restricted replication/destructive tools, nor turn orchestrator
assignment into a remote-child creation or direct child-funding transfer. A
separate trusted goal can still use the normal remote delegation path.

These controls are not a complete prompt-injection defense. A model can still
choose harmful actions among capabilities the operator grants, and application
provenance checks do not isolate a host-admin shell or secret-bearing filesystem.
OS isolation, financial limits and separation of secrets remain necessary.
