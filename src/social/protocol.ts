/**
 * Unified Signed Message Protocol
 *
 * Defines the signed message interface and utilities for message creation
 * and verification using ECDSA secp256k1.
 *
 * Phase 3.2: Social & Registry Hardening
 */

import crypto from "crypto";
import { ulid } from "ulid";
import {
  verifyMessage,
} from "viem";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { detectChainType } from "../identity/chain.js";
import { canonicalSendMessage } from "./signing.js";

/**
 * A fully signed social message.
 */
export interface SignedMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

/**
 * Create a unique message ID using ULID.
 */
export function createMessageId(): string {
  return ulid();
}

/**
 * Create a cryptographically random nonce for replay protection.
 */
export function createNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Verify the relay's canonical EVM or Solana send signature locally.
 *
 * Reconstructs the canonical string used during signing and verifies
 * the signature against the expected sender address.
 */
export async function verifyMessageSignature(
  message: { to: string; content: string; signed_at: string; signature: string },
  expectedFrom: string,
): Promise<boolean> {
  try {
    const chain = detectChainType(expectedFrom);
    const canonical = canonicalSendMessage(message.to, message.content, message.signed_at);

    if (chain === "solana") {
      const signature = bs58.decode(message.signature);
      const publicKey = bs58.decode(expectedFrom);
      return signature.length === nacl.sign.signatureLength &&
        nacl.sign.detached.verify(new TextEncoder().encode(canonical), signature, publicKey);
    }
    if (chain !== "evm") return false;

    const valid = await verifyMessage({
      address: expectedFrom as `0x${string}`,
      message: canonical,
      signature: message.signature as `0x${string}`,
    });

    return valid;
  } catch {
    return false;
  }
}
