import { LockMode } from '@mikro-orm/core';
import { InboxMessageRecord } from '../records/inbox-message.record.js';
import type { TransactionRecordStore } from '../../../core/database/transaction-record-store.js';

export interface InboxReservation {
  inserted: boolean;
  matches: boolean;
  message: InboxMessageRecord;
}

/**
 * Persists consumer message identities in the caller's active transaction.
 * Locks reservations for redelivery decisions; does not commit or process commands.
 */
export class InboxRepository {
  constructor(
    private readonly transactionRecordStore: TransactionRecordStore,
  ) {} /** Reserves and locks a message identity, reporting whether its payload matches. */
  async reserveIdentity(
    consumerName: string,
    messageId: string,
    payloadHash: string,
  ): Promise<InboxReservation> {
    const inserted = await this.transactionRecordStore.rows<{ message_id: string }>(
      `
    INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING RETURNING message_id`,
      [consumerName, messageId, payloadHash],
    );

    // A fresh statement sees a competing insert after the unique-key wait ends.
    const [message] = await this.transactionRecordStore.find(
      InboxMessageRecord,
      { consumerName, messageId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (message === undefined) throw new Error('Inbox reservation returned no row.');

    return {
      inserted: inserted.length === 1,
      matches: message.payloadHash === payloadHash,
      message,
    };
  }

  /** Marks a matching message processed in the transaction that applies its operation. */
  async markProcessed(
    consumerName: string,
    messageId: string,
    payloadHash: string,
    processedAt: Date,
  ): Promise<boolean> {
    const rows = await this.transactionRecordStore.rows<{ message_id: string }>(
      `
    UPDATE inbox_messages SET processed_at = ?
    WHERE consumer_name = ? AND message_id = ? AND payload_hash = ? AND processed_at IS NULL
    RETURNING message_id`,
      [processedAt, consumerName, messageId, payloadHash],
    );

    return rows.length === 1;
  }
}
