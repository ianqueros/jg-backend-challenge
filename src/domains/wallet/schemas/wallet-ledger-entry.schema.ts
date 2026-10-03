import { BigIntType, EntitySchema, ReferenceKind } from '@mikro-orm/core';
import { WalletLedgerEntryRecord } from '../records/wallet-ledger-entry.record.js';
import { WagerTransactionRecord } from '../../wagering/records/wager-transaction.record.js';

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRecord>({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  uniques: [
    {
      name: 'uq_wallet_ledger_entries_tx_wallet',
      properties: ['transactionId', 'walletId'],
    },
    {
      name: 'uq_wallet_ledger_entries_wallet_version',
      properties: ['walletId', 'walletVersion'],
    },
  ],
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: {
      kind: ReferenceKind.MANY_TO_ONE,
      entity: () => WagerTransactionRecord,
      fieldName: 'transaction_id',
      mapToPk: true,
      foreignKeyName: 'wallet_ledger_entries_transaction_id_fkey',
      deleteRule: 'no action',
      updateRule: 'no action',
    },
    walletVersion: { type: new BigIntType('string'), fieldName: 'wallet_version' },
    direction: { type: 'string', length: 10 },
    amount: { type: 'string', columnType: 'numeric(20,2)' },
    currency: { type: 'string', length: 3 },
    balanceBefore: {
      type: 'string',
      columnType: 'numeric(20,2)',
      fieldName: 'balance_before',
    },
    balanceAfter: {
      type: 'string',
      columnType: 'numeric(20,2)',
      fieldName: 'balance_after',
    },
    createdAt: { type: 'Date', fieldName: 'created_at', defaultRaw: 'clock_timestamp()' },
  },
});
