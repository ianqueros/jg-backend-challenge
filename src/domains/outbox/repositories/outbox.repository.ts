import { OutboxMessageRecord } from '../records/outbox-message.record.js';
import {
  validateClaim,
  validateDelay,
  type ClaimOptions,
  type TransactionRecordStore,
} from '../../../core/database/transaction-record-store.js';

export interface OutboxInsert {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt?: Date;
}

/**
 * Persists event records and guards publisher claims in the caller's active transaction.
 * Does not commit, publish to the broker, or calculate retry policy.
 */
export class OutboxRepository {
  constructor(
    private readonly transactionRecordStore: TransactionRecordStore,
  ) {} /** Adds an event in the same transaction as its financial state change. */
  async enqueue(input: OutboxInsert): Promise<OutboxMessageRecord> {
    return this.transactionRecordStore.insert(OutboxMessageRecord, input);
  }

  /** Reads an event's payload and delivery state by its stable identifier. */
  async findById(id: string): Promise<OutboxMessageRecord | undefined> {
    return (await this.transactionRecordStore.find(OutboxMessageRecord, { id }))[0];
  }

  /** Database-wide age of the oldest unpublished event, including leased and deferred work. */
  async pendingAgeSeconds(): Promise<number> {
    const [row] = await this.transactionRecordStore.rows<{ ageSeconds: number }>(
      `SELECT GREATEST(0, COALESCE(
      EXTRACT(EPOCH FROM (clock_timestamp() - MIN(occurred_at))), 0
    ))::double precision AS "ageSeconds"
    FROM outbox_messages WHERE published_at IS NULL`,
    );
    if (row === undefined) throw new Error('Outbox age query returned no row.');
    return row.ageSeconds;
  }

  /** Leases due events without waiting for rows claimed by other publishers. */
  async claimDueEvents(options: ClaimOptions): Promise<OutboxMessageRecord[]> {
    validateClaim(options);

    return this.transactionRecordStore.records(
      OutboxMessageRecord,
      `
    WITH candidates AS (
      SELECT id FROM outbox_messages WHERE published_at IS NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
        AND (claim_token IS NULL OR claim_expires_at <= clock_timestamp())
      ORDER BY created_at, id LIMIT ? FOR UPDATE SKIP LOCKED
    ) UPDATE outbox_messages o SET claim_token = gen_random_uuid(),
        claim_expires_at = clock_timestamp() + (? * interval '1 millisecond'),
        updated_at = clock_timestamp()
      FROM candidates c WHERE o.id = c.id RETURNING o.*`,
      [options.limit, options.leaseMs],
    );
  }

  /** Records delivery under a live claim; returns false if that claim no longer matches. */
  async markPublishedIfOwned(
    id: string,
    token: string,
    publishedAt: Date,
  ): Promise<boolean> {
    const rows = await this.transactionRecordStore.rows<{ id: string }>(
      `
    UPDATE outbox_messages SET published_at = ?, updated_at = clock_timestamp(),
      claim_token = NULL, claim_expires_at = NULL, next_attempt_at = NULL
    WHERE id = ? AND published_at IS NULL AND claim_token = ?::uuid
      AND claim_expires_at > clock_timestamp() RETURNING id`,
      [publishedAt, id, token],
    );

    return rows.length === 1;
  }

  /** Persists retry state; returns false if the live claim or expected attempt no longer matches. */
  async scheduleRetryIfOwned(
    id: string,
    token: string,
    delayMs: number,
    attempts: number,
  ): Promise<boolean> {
    validateDelay(delayMs);

    const rows = await this.transactionRecordStore.rows<{ id: string }>(
      `
    UPDATE outbox_messages SET next_attempt_at = clock_timestamp() + (? * interval '1 millisecond'),
      attempts = ?, updated_at = clock_timestamp(), claim_token = NULL, claim_expires_at = NULL
    WHERE id = ? AND published_at IS NULL AND claim_token = ?::uuid
      AND attempts = ? AND claim_expires_at > clock_timestamp() RETURNING id`,
      [delayMs, attempts, id, token, attempts - 1],
    );

    return rows.length === 1;
  }

  /** Releases a live claim without recording failure; returns false if the claim no longer matches. */
  async releaseIfOwned(id: string, token: string): Promise<boolean> {
    const rows = await this.transactionRecordStore.rows<{ id: string }>(
      `
    UPDATE outbox_messages SET updated_at = clock_timestamp(),
      claim_token = NULL, claim_expires_at = NULL
    WHERE id = ? AND published_at IS NULL AND claim_token = ?::uuid
      AND claim_expires_at > clock_timestamp() RETURNING id`,
      [id, token],
    );

    return rows.length === 1;
  }
}
