import { EntitySchema } from '@mikro-orm/core';
import { OutboxMessageRecord } from '../records/outbox-message.record.js';

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', length: 128, fieldName: 'aggregate_id' },
    eventType: { type: 'string', length: 128, fieldName: 'event_type' },
    payload: { type: 'json' },
    occurredAt: {
      type: 'Date',
      fieldName: 'occurred_at',
      defaultRaw: 'clock_timestamp()',
    },
    attempts: { type: 'integer', default: 0 },
    nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at', nullable: true },
    publishedAt: { type: 'Date', fieldName: 'published_at', nullable: true },
    claimToken: { type: 'uuid', fieldName: 'claim_token', nullable: true },
    claimExpiresAt: { type: 'Date', fieldName: 'claim_expires_at', nullable: true },
    createdAt: { type: 'Date', fieldName: 'created_at', defaultRaw: 'clock_timestamp()' },
    updatedAt: { type: 'Date', fieldName: 'updated_at', defaultRaw: 'clock_timestamp()' },
  },
});
