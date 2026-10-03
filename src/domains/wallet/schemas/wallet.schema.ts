import { BigIntType, EntitySchema } from '@mikro-orm/core';
import { WalletRecord } from '../records/wallet.record.js';

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  uniques: [
    { name: 'uq_wallets_player_currency', properties: ['playerId', 'currency'] },
    { name: 'uq_wallets_id_currency', properties: ['id', 'currency'] },
  ],
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', length: 3 },
    balance: { type: 'string', columnType: 'numeric(20,2)', defaultRaw: '0.00' },
    version: { type: new BigIntType('string'), defaultRaw: '1' },
    createdAt: { type: 'Date', fieldName: 'created_at', defaultRaw: 'clock_timestamp()' },
    updatedAt: { type: 'Date', fieldName: 'updated_at', defaultRaw: 'clock_timestamp()' },
  },
});
