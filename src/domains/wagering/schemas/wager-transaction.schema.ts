import { EntitySchema, ReferenceKind } from '@mikro-orm/core';
import { WagerTransactionRecord } from '../records/wager-transaction.record.js';

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  uniques: [
    {
      name: 'uq_wager_transactions_provider_key',
      properties: ['providerId', 'idempotencyKey'],
    },
    {
      name: 'uq_wager_transactions_provider_external',
      properties: ['providerId', 'externalTransactionId'],
    },
  ],
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', length: 128, fieldName: 'provider_id' },
    externalTransactionId: {
      type: 'string',
      length: 128,
      fieldName: 'external_transaction_id',
    },
    idempotencyKey: { type: 'string', length: 256, fieldName: 'idempotency_key' },
    payloadHash: {
      type: 'string',
      columnType: 'char(64)',
      length: 64,
      fieldName: 'payload_hash',
    },
    hashVersion: { type: 'string', length: 16, fieldName: 'hash_version', default: 'v1' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', length: 128, fieldName: 'round_id', nullable: true },
    gameId: { type: 'string', length: 128, fieldName: 'game_id', nullable: true },
    kind: { type: 'string', length: 32 },
    amount: { type: 'string', columnType: 'numeric(20,2)' },
    currency: { type: 'string', length: 3 },
    referenceExternalTransactionId: {
      type: 'string',
      length: 128,
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: {
      kind: ReferenceKind.MANY_TO_ONE,
      entity: () => WagerTransactionRecord,
      mapToPk: true,
      fieldName: 'reference_transaction_id',
      nullable: true,
      foreignKeyName: 'wager_transactions_reference_transaction_id_fkey',
      deleteRule: 'no action',
      updateRule: 'no action',
    },
    status: { type: 'string', length: 32 },
    failureCode: {
      type: 'string',
      length: 64,
      fieldName: 'failure_code',
      nullable: true,
    },
    result: { type: 'json', nullable: true },
    processedAt: { type: 'Date', fieldName: 'processed_at', nullable: true },
    closedAt: { type: 'Date', fieldName: 'closed_at', nullable: true },
    referenceExpiresAt: {
      type: 'Date',
      fieldName: 'reference_expires_at',
      nullable: true,
    },
    referenceAttempts: { type: 'integer', fieldName: 'reference_attempts', default: 0 },
    referenceNextAttemptAt: {
      type: 'Date',
      fieldName: 'reference_next_attempt_at',
      nullable: true,
    },
    referenceClaimToken: {
      type: 'uuid',
      fieldName: 'reference_claim_token',
      nullable: true,
    },
    referenceClaimExpiresAt: {
      type: 'Date',
      fieldName: 'reference_claim_expires_at',
      nullable: true,
    },
    referenceCorrelationId: {
      type: 'string',
      length: 256,
      fieldName: 'reference_correlation_id',
      nullable: true,
    },
    referenceCausationId: {
      type: 'string',
      length: 256,
      fieldName: 'reference_causation_id',
      nullable: true,
    },
    createdAt: { type: 'Date', fieldName: 'created_at', defaultRaw: 'clock_timestamp()' },
    updatedAt: { type: 'Date', fieldName: 'updated_at', defaultRaw: 'clock_timestamp()' },
  },
});
