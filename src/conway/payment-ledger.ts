/** Durable pre-signature reservations. This is accounting, not a key isolation boundary. */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getAutomatonDir } from "../identity/wallet.js";

export interface PaymentBudget {
  maxSingleCents: number;
  maxHourlyCents: number;
  maxDailyCents: number;
  minimumReserveCents?: number;
  /** Optional independently obtained wallet balance, in USDC atomic units. */
  balanceAtomic?: bigint;
  maxDestinationDailyCents?: number;
}

export type PaymentState = "reserved" | "authorized" | "accepted" | "uncertain" | "failed";

export interface PaymentReservation {
  id: string;
  wallet: string;
  network: string;
  recipient: string;
  destination: string;
  amountAtomic: bigint;
  validUntil: number;
}

export function centsToAtomic(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Payment limits must be non-negative safe integer cents");
  return BigInt(value) * 10_000n;
}

export class PaymentLedger {
  private readonly db: Database.Database;

  constructor(filename = path.join(getAutomatonDir(), "payment-ledger.db")) {
    if (filename !== ":memory:") {
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      if (fs.existsSync(filename)) {
        if (!fs.lstatSync(filename).isFile()) throw new Error("Payment ledger must be a regular file");
      } else {
        try { fs.closeSync(fs.openSync(filename, "wx", 0o600)); }
        catch (error: any) { if (error.code !== "EEXIST") throw error; }
        if (!fs.lstatSync(filename).isFile()) throw new Error("Payment ledger must be a regular file");
      }
      fs.chmodSync(filename, 0o600);
    }
    this.db = new Database(filename);
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS payment_authorizations (
      id TEXT PRIMARY KEY, wallet TEXT NOT NULL, network TEXT NOT NULL,
      recipient TEXT NOT NULL, destination TEXT NOT NULL, amount_atomic TEXT NOT NULL,
      state TEXT NOT NULL, created_at INTEGER NOT NULL, valid_until INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS payment_authorizations_wallet ON payment_authorizations(wallet, network, created_at);`);
  }

  reserve(reservation: PaymentReservation, budget: PaymentBudget, now = Date.now()): void {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(reservation.id)) throw new Error("Invalid payment operation identifier");
    if (!Number.isSafeInteger(reservation.validUntil) || reservation.validUntil <= now) throw new Error("Payment authorization must expire in the future");
    const maxSingle = centsToAtomic(budget.maxSingleCents);
    const maxHourly = centsToAtomic(budget.maxHourlyCents);
    const maxDaily = centsToAtomic(budget.maxDailyCents);
    const minReserve = centsToAtomic(budget.minimumReserveCents ?? 0);
    const destinationCap = budget.maxDestinationDailyCents === undefined ? null : centsToAtomic(budget.maxDestinationDailyCents);
    if (reservation.amountAtomic <= 0n || reservation.amountAtomic > maxSingle) throw new Error("Payment exceeds single-operation budget");
    if (minReserve > 0n && budget.balanceAtomic === undefined) throw new Error("Wallet balance required to enforce minimum reserve");

    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM payment_authorizations WHERE id = ?").get(reservation.id)) {
        throw new Error("Payment operation already reserved; reconcile its previous outcome before retrying");
      }
      const rows = this.db.prepare(`SELECT amount_atomic, created_at, valid_until, state, destination
        FROM payment_authorizations WHERE wallet = ? AND network = ? AND state != 'failed'
        AND (created_at > ? OR (state IN ('reserved','authorized','accepted','uncertain') AND valid_until > ?))`)
        .all(reservation.wallet.toLowerCase(), reservation.network, now - 86_400_000, now) as Array<{
          amount_atomic: string; created_at: number; valid_until: number; state: PaymentState; destination: string;
        }>;
      let hourly = 0n, daily = 0n, outstanding = 0n, destinationDaily = 0n;
      for (const row of rows) {
        const amount = BigInt(row.amount_atomic);
        const active = ["reserved", "authorized", "accepted", "uncertain"].includes(row.state) && row.valid_until > now;
        if (row.created_at > now - 3_600_000 || active) hourly += amount;
        if (row.created_at > now - 86_400_000 || active) {
          daily += amount;
          if (row.destination === reservation.destination) destinationDaily += amount;
        }
        if (active) outstanding += amount;
      }
      if (hourly + reservation.amountAtomic > maxHourly) throw new Error("Payment exceeds hourly budget");
      if (daily + reservation.amountAtomic > maxDaily) throw new Error("Payment exceeds daily budget");
      if (destinationCap !== null && destinationDaily + reservation.amountAtomic > destinationCap) throw new Error("Payment exceeds destination daily budget");
      if (budget.balanceAtomic !== undefined && budget.balanceAtomic - outstanding - reservation.amountAtomic < minReserve) {
        throw new Error("Payment would breach wallet minimum reserve");
      }
      this.db.prepare(`INSERT INTO payment_authorizations
        (id,wallet,network,recipient,destination,amount_atomic,state,created_at,valid_until)
        VALUES (?,?,?,?,?,?,'reserved',?,?)`).run(reservation.id, reservation.wallet.toLowerCase(), reservation.network,
          reservation.recipient.toLowerCase(), reservation.destination, reservation.amountAtomic.toString(), now, reservation.validUntil);
    }).immediate();
  }

  setState(id: string, state: PaymentState): void {
    const previous = this.db.prepare("SELECT state FROM payment_authorizations WHERE id = ?").get(id) as {state: PaymentState} | undefined;
    if (!previous) throw new Error("Unknown payment reservation");
    if (state === "failed" && previous.state !== "reserved") throw new Error("Signed payment reservations cannot be released without on-chain reconciliation");
    const transitions: Record<PaymentState, PaymentState[]> = {
      reserved: ["reserved", "authorized", "failed"],
      authorized: ["authorized", "accepted", "uncertain"],
      accepted: ["accepted", "uncertain"],
      uncertain: ["uncertain"],
      failed: ["failed"],
    };
    if (!transitions[previous.state].includes(state)) throw new Error("Invalid payment authorization state transition");
    this.db.prepare("UPDATE payment_authorizations SET state = ? WHERE id = ?").run(state, id);
  }

  get(id: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM payment_authorizations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  close(): void { this.db.close(); }
}
