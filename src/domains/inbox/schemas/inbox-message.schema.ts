import { EntitySchema } from '@mikro-orm/core';
import { InboxMessageRecord } from '../records/inbox-message.record.js';

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: {
      type: 'string',
      length: 128,
      primary: true,
      fieldName: 'consumer_name',
    },
    messageId: { type: 'string', length: 256, primary: true, fieldName: 'message_id' },
    payloadHash: {
      type: 'string',
      columnType: 'char(64)',
      length: 64,
      fieldName: 'payload_hash',
    },
    receivedAt: {
      type: 'Date',
      fieldName: 'received_at',
      defaultRaw: 'clock_timestamp()',
    },
    processedAt: { type: 'Date', fieldName: 'processed_at', nullable: true },
  },
});
