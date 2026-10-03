import { OptionalProps } from '@mikro-orm/core';

export class WalletRecord {
  [OptionalProps]?: 'balance' | 'version' | 'createdAt' | 'updatedAt';
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: string;
  createdAt!: Date;
  updatedAt!: Date;
}
