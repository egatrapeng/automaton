/**
 * Social Client Factory
 *
 * Creates a SocialClient for the automaton runtime.
 * Self-contained: uses viem for signing and fetch for HTTP.
 *
 * Phase 3.2: Hardened with HTTPS enforcement, shared signing,
 * request timeouts, replay protection, and rate limiting.
 */

import type { PrivateKeyAccount } from "viem";
import { createHash } from "node:crypto";
import type { SocialClientInterface, InboxMessage } from "../types.js";
import type { ChainIdentity } from "../identity/chain.js";
import { ResilientHttpClient } from "../conway/http-client.js";
import { signSendPayload, signPollPayload, MESSAGE_LIMITS } from "./signing.js";
import { validateRelayUrl, validateMessage } from "./validation.js";
import { verifyMessageSignature } from "./protocol.js";
import { canonicalSendMessage } from "./signing.js";
import { detectChainType, normalizeAddress } from "../identity/chain.js";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("social");

// Request timeout for all fetch calls (30 seconds)
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Create a SocialClient wired to the agent's wallet.
 *
 * @throws if relayUrl is not HTTPS
 */
export function createSocialClient(
  relayUrl: string,
  account: PrivateKeyAccount | ChainIdentity,
  db?: import("better-sqlite3").Database,
): SocialClientInterface {
  // Phase 3.2: Validate relay URL as HTTPS
  validateRelayUrl(relayUrl);

  const baseUrl = relayUrl.replace(/\/$/, "");
  const httpClient = new ResilientHttpClient();

  // Rate limiting state: track outbound message timestamps
  const outboundTimestamps: number[] = [];

  function checkRateLimit(): void {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    // Prune old timestamps
    while (outboundTimestamps.length > 0 && outboundTimestamps[0]! < oneHourAgo) {
      outboundTimestamps.shift();
    }
    if (outboundTimestamps.length >= MESSAGE_LIMITS.maxOutboundPerHour) {
      throw new Error(
        `Rate limit exceeded: ${MESSAGE_LIMITS.maxOutboundPerHour} messages per hour`,
      );
    }
  }

  const seen = new Map<string, true>();

  function checkReplay(key: string): boolean {
    if (seen.has(key)) return true;
    if (db) {
      // A receipt belongs to the signed payload, not to the relay's mutable ID
      // or unsigned nonce. Atomic insertion also covers concurrent clients.
      // Durable receipts deliberately do not expire: queued messages may be old.
      const inserted = db.prepare(
        "INSERT OR IGNORE INTO heartbeat_dedup (dedup_key, task_name, expires_at) VALUES (?, ?, ?)",
      ).run(`social:receipt:${key}`, "social_replay", "9999-12-31 23:59:59");
      if (inserted.changes === 0) return true;
    }
    // Without a database, bound memory use. Cross-restart replay prevention
    // requires the optional persistent database used by the runtime.
    seen.set(key, true);
    if (seen.size > 10_000) seen.delete(seen.keys().next().value!);
    return false;
  }

  return {
    send: async (
      to: string,
      content: string,
      replyTo?: string,
    ): Promise<{ id: string }> => {
      // Phase 3.2: Rate limit check
      checkRateLimit();

      // Track outbound attempt for rate limiting BEFORE the network call.
      // Counting attempts (not just successes) prevents hammering the relay
      // with unlimited retries when the server returns errors.
      outboundTimestamps.push(Date.now());

      // Phase 3.2: Validate message before sending
      const validation = validateMessage({ from: account.address, to, content });
      if (!validation.valid) {
        throw new Error(`Message validation failed: ${validation.errors.join("; ")}`);
      }

      // Phase 3.2: Use shared signing module
      const payload = await signSendPayload(account, to, content, replyTo);

      const res = await httpClient.request(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        timeout: REQUEST_TIMEOUT_MS,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(
          `Send failed (${res.status}): ${(err as any).error || res.statusText}`,
        );
      }

      const data = (await res.json()) as { id: string };
      return { id: data.id };
    },

    poll: async (
      cursor?: string,
      limit?: number,
    ): Promise<{ messages: InboxMessage[]; nextCursor?: string }> => {
      // Phase 3.2: Use shared signing module
      const pollAuth = await signPollPayload(account);

      const res = await httpClient.request(`${baseUrl}/v1/messages/poll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Wallet-Address": pollAuth.address,
          "X-Signature": pollAuth.signature,
          "X-Timestamp": pollAuth.timestamp,
        },
        body: JSON.stringify({ cursor, limit: Math.min(Math.max(Math.floor(limit ?? 100), 1), 100) }),
        timeout: REQUEST_TIMEOUT_MS,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(
          `Poll failed (${res.status}): ${(err as any).error || res.statusText}`,
        );
      }

      const data = (await res.json()) as { messages?: unknown; next_cursor?: unknown };
      if (!Array.isArray(data.messages)) throw new Error("Invalid relay message batch");
      if (data.messages.length > 100) throw new Error("Relay message batch exceeds requested limit");
      const messages: InboxMessage[] = [];
      const ownChain = detectChainType(account.address);
      if (!ownChain) throw new Error("Invalid local social identity");
      for (const candidate of data.messages) {
        if (!candidate || typeof candidate !== "object") continue;
        const m = candidate as Record<string, unknown>;
        const signedAt = m.signed_at ?? m.signedAt;
        if (typeof m.id !== "string" || m.id.length === 0 || m.id.length > 256 ||
            typeof m.from !== "string" || typeof m.to !== "string" ||
            typeof m.content !== "string" || typeof signedAt !== "string") continue;
        const recipientChain = detectChainType(m.to);
        if (recipientChain !== ownChain ||
            normalizeAddress(m.to, ownChain) !== normalizeAddress(account.address, ownChain)) {
          logger.warn("Dropped social message for a different recipient");
          continue;
        }
        // Validate shape and size independently of age. An offline agent must
        // still be able to read its queued messages, without granting authority.
        const validation = validateMessage({ from: m.from, to: m.to, content: m.content });
        const timestamp = Date.parse(signedAt);
        if (!validation.valid || !Number.isFinite(timestamp) || timestamp > Date.now() + 60_000) {
          logger.warn("Dropped malformed social message");
          continue;
        }
        let receipt: string;
        if (m.signature !== undefined) {
          if (typeof m.signature !== "string" || !await verifyMessageSignature({
            to: m.to, content: m.content, signed_at: signedAt, signature: m.signature,
          }, m.from)) {
            logger.warn("Dropped social message with an invalid sender signature");
            continue;
          }
          const senderChain = detectChainType(m.from)!;
          receipt = JSON.stringify(["signed", normalizeAddress(m.from, senderChain),
            canonicalSendMessage(m.to, m.content, signedAt)]);
        } else {
          // Legacy relays omit signatures. Keep messages usable as EXTERNAL
          // data; no sender claim, even creatorAddress, grants permissions.
          receipt = JSON.stringify(["legacy", m.id, m.from, m.to, m.content, signedAt]);
        }
        if (checkReplay(createHash("sha256").update(receipt).digest("hex"))) continue;
        messages.push({
          id: m.id, from: m.from, to: m.to, content: m.content, signedAt,
          createdAt: typeof m.createdAt === "string" ? m.createdAt : signedAt,
          replyTo: typeof m.replyTo === "string" ? m.replyTo : undefined,
        });
      }

      return {
        messages,
        nextCursor: typeof data.next_cursor === "string" ? data.next_cursor : undefined,
      };
    },

    unreadCount: async (): Promise<number> => {
      // Phase 3.2: Use shared signing module
      const pollAuth = await signPollPayload(account);

      const res = await httpClient.request(`${baseUrl}/v1/messages/count`, {
        method: "GET",
        headers: {
          "X-Wallet-Address": pollAuth.address,
          "X-Signature": pollAuth.signature,
          "X-Timestamp": pollAuth.timestamp,
        },
        timeout: REQUEST_TIMEOUT_MS,
      });

      // Phase 3.2: THROW on error instead of returning 0 (S-P1-7)
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(
          `Unread count failed (${res.status}): ${(err as any).error || res.statusText}`,
        );
      }

      const data = (await res.json()) as { unread: number };
      return data.unread;
    },
  };
}
