import { WagerTransactionRecord } from '../records/wager-transaction.record.js';
import {
  validateClaim,
  validateDelay,
  type ClaimOptions,
  type TransactionRecordStore,
} from '../../../core/database/transaction-record-store.js';

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PendReferenceOptions {
  ttlMs: number;
  correlationId: string;
  causationId?: string | undefined;
}

export interface WagerTransactionInsert {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  hashVersion?: string;
  walletId: string;
  playerId: string;
  roundId?: string | null;
  gameId?: string | null;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string | null;
}
export interface WagerTransactionReservation {
  inserted: boolean;
  byId?: WagerTransactionRecord | undefined;
  byKey?: WagerTransactionRecord | undefined;
  byExternal?: WagerTransactionRecord | undefined;
}
export interface WagerTransactionFinalization {
  id: string;
  expectedStatus: 'PENDING' | 'PENDING_REFERENCE';
  status: 'PROCESSED' | 'REJECTED' | 'FAILED';
  result: Record<string, unknown>;
  failureCode?: string;
  referenceTransactionId?: string;
  token?: string;
  at?: Date | undefined;
}

/**
 * Persists wager records and guards identity, status, and reference-lease conditions.
 * Uses the caller's active transaction; does not commit or decide replay.
 */
export class WagerTransactionRepository {
  constructor(
    private readonly transactionRecordStore: TransactionRecordStore,
  ) {} /** Finds an operation by its internal identifier. */
  async findById(id: string): Promise<WagerTransactionRecord | undefined> {
    return (await this.transactionRecordStore.find(WagerTransactionRecord, { id }))[0];
  }

  /** Finds the operation reserved by a provider's idempotency key. */
  async findByKey(
    providerId: string,
    key: string,
  ): Promise<WagerTransactionRecord | undefined> {
    return (
      await this.transactionRecordStore.find(WagerTransactionRecord, {
        providerId,
        idempotencyKey: key,
      })
    )[0];
  }

  /** Finds a provider operation by its external identity, including pending references. */
  async findByExternal(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransactionRecord | undefined> {
    return (
      await this.transactionRecordStore.find(WagerTransactionRecord, {
        providerId,
        externalTransactionId: externalId,
      })
    )[0];
  }

  /** Finds the processed reversal that has consumed a reference's reversal right. */
  async findProcessedReversal(
    referenceId: string,
  ): Promise<WagerTransactionRecord | undefined> {
    return (
      await this.transactionRecordStore.find(WagerTransactionRecord, {
        referenceTransactionId: referenceId,
        status: 'PROCESSED',
        kind: { $in: ['REFUND', 'ROLLBACK'] },
      })
    )[0];
  }

  /** Reserves an operation identity and returns competing rows for replay decisions. */
  async reserveIdentity(
    input: WagerTransactionInsert,
  ): Promise<WagerTransactionReservation> {
    const rows = await this.transactionRecordStore.rows<{ id: string }>(
      `
    INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key,
      payload_hash, hash_version, wallet_id, player_id, round_id, game_id, kind, amount,
      currency, reference_external_transaction_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?, ?, 'PENDING')
    ON CONFLICT DO NOTHING RETURNING id`,
      [
        input.id,
        input.providerId,
        input.externalTransactionId,
        input.idempotencyKey,
        input.payloadHash,
        input.hashVersion ?? 'v1',
        input.walletId,
        input.playerId,
        input.roundId ?? null,
        input.gameId ?? null,
        input.kind,
        input.amount,
        input.currency,
        input.referenceExternalTransactionId ?? null,
      ],
    );

    // A separate READ COMMITTED statement sees the winner after UNIQUE waits.
    // Return each identity independently: the caller decides hash/replay precedence.
    const matches = await this.transactionRecordStore.find(WagerTransactionRecord, {
      $or: [
        { id: input.id },
        { providerId: input.providerId, idempotencyKey: input.idempotencyKey },
        {
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
        },
      ],
    });

    return {
      inserted: rows.length === 1,
      byId: matches.find((row) => row.id === input.id),
      byKey: matches.find(
        (row) =>
          row.providerId === input.providerId &&
          row.idempotencyKey === input.idempotencyKey,
      ),
      byExternal: matches.find(
        (row) =>
          row.providerId === input.providerId &&
          row.externalTransactionId === input.externalTransactionId,
      ),
    };
  }

  /** Returns false if the expected status or reference-lease conditions no longer match. */
  async finalizeIfCurrent(input: WagerTransactionFinalization): Promise<boolean> {
    const rows = await this.transactionRecordStore.rows<{ id: string }>(
      `
    UPDATE wager_transactions SET status = ?, result = ?::jsonb, failure_code = ?,
      reference_transaction_id = COALESCE(?::uuid, reference_transaction_id),
      processed_at = CASE WHEN ? = 'PROCESSED' THEN COALESCE(?::timestamptz, clock_timestamp()) ELSE NULL END,
      closed_at = CASE WHEN ? = 'PROCESSED' THEN NULL ELSE COALESCE(?::timestamptz, clock_timestamp()) END,
      reference_claim_token = NULL, reference_claim_expires_at = NULL,
      reference_next_attempt_at = NULL
    WHERE id = ? AND status = ? AND (
      (?::uuid IS NULL AND (reference_claim_token IS NULL OR reference_claim_expires_at <= clock_timestamp())) OR
      (reference_claim_token = ?::uuid AND reference_claim_expires_at > clock_timestamp()))
    RETURNING id`,
      [
        input.status,
        JSON.stringify(input.result),
        input.failureCode ?? null,
        input.referenceTransactionId ?? null,
        input.status,
        input.at ?? null,
        input.status,
        input.at ?? null,
        input.id,
        input.expectedStatus,
        input.token ?? null,
        input.token ?? null,
      ],
    );

    return rows.length === 1;
  }

  /** Defers an operation until its reference arrives, preserving its original expiry. */
  async pendReference(
    id: string,
    result: Record<string, unknown>,
    options: PendReferenceOptions,
  ): Promise<boolean> {
    const rows = await this.transactionRecordStore.rows<{ id: string }>(
      `
    UPDATE wager_transactions SET status = 'PENDING_REFERENCE',
      reference_expires_at = COALESCE(reference_expires_at, created_at + (? * interval '1 millisecond')),
      reference_next_attempt_at = COALESCE(reference_next_attempt_at, clock_timestamp()),
      reference_correlation_id = COALESCE(reference_correlation_id, ?),
      reference_causation_id = COALESCE(reference_causation_id, ?),
      result = ?::jsonb
    WHERE id = ? AND status = 'PENDING' RETURNING id`,
      [
        options.ttlMs,
        options.correlationId,
        options.causationId ?? null,
        JSON.stringify(result),
        id,
      ],
    );

    return rows.length === 1;
  }

  /** Locks a pending operation only for its current, unexpired reference claim. */
  async findOwnedPendingReference(
    id: string,
    token: string,
  ): Promise<(WagerTransactionRecord & { isExpired: boolean }) | undefined> {
    if (!uuidRegex.test(id) || !uuidRegex.test(token)) {
      return undefined;
    }

    const rows = await this.transactionRecordStore.rows<
      Record<string, unknown> & { isExpired: boolean }
    >(
      `
    SELECT w.*, (reference_expires_at <= clock_timestamp()) AS "isExpired"
    FROM wager_transactions w
    WHERE id = ?
      AND status = 'PENDING_REFERENCE'
      AND reference_claim_token = ?::uuid
      AND reference_claim_expires_at > clock_timestamp()
    FOR UPDATE`,
      [id, token],
    );

    const row = rows[0];
    if (row === undefined) return undefined;
    const record = this.transactionRecordStore.mapRecords(WagerTransactionRecord, [
      row,
    ])[0];
    if (record === undefined) throw new Error('Reference claim returned no record.');
    return Object.assign(record, { isExpired: row.isExpired });
  }

  /** Leases due reference work without waiting for rows claimed by other workers. */
  async claimReferences(options: ClaimOptions): Promise<WagerTransactionRecord[]> {
    validateClaim(options);

    return this.transactionRecordStore.records(
      WagerTransactionRecord,
      `
    WITH candidates AS (
      SELECT id FROM wager_transactions WHERE status = 'PENDING_REFERENCE'
        AND (reference_next_attempt_at IS NULL OR reference_next_attempt_at <= clock_timestamp())
        AND (reference_claim_token IS NULL OR reference_claim_expires_at <= clock_timestamp())
      ORDER BY reference_expires_at, created_at, id LIMIT ? FOR UPDATE SKIP LOCKED
    ) UPDATE wager_transactions w SET reference_claim_token = gen_random_uuid(),
        reference_claim_expires_at = clock_timestamp() + (? * interval '1 millisecond'),
        reference_attempts = reference_attempts + 1
      FROM candidates c WHERE w.id = c.id RETURNING w.*`,
      [options.limit, options.leaseMs],
    );
  }

  /** Caps reference waiting at expiry, but respects backoff after a failed expiry execution. */
  async rescheduleReference(
    id: string,
    token: string,
    delayMs: number,
    reason: 'waiting' | 'retry',
  ): Promise<boolean> {
    validateDelay(delayMs);
    if (!uuidRegex.test(id) || !uuidRegex.test(token)) {
      return false;
    }

    const rows = await this.transactionRecordStore.rows<{ id: string }>(
      `
    UPDATE wager_transactions SET reference_next_attempt_at =
      CASE WHEN ? = 'retry' AND reference_expires_at <= clock_timestamp()
        THEN clock_timestamp() + (? * interval '1 millisecond')
        ELSE LEAST(reference_expires_at, clock_timestamp() + (? * interval '1 millisecond')) END,
      reference_claim_token = NULL, reference_claim_expires_at = NULL
    WHERE id = ? AND status = 'PENDING_REFERENCE' AND reference_claim_token = ?::uuid
      AND reference_claim_expires_at > clock_timestamp() RETURNING id`,
      [reason, delayMs, delayMs, id, token],
    );

    return rows.length === 1;
  }
}
