import { OptionalProps } from '@mikro-orm/core';

export class WalletLedgerEntryRecord {
  [OptionalProps]?: 'createdAt';
  id!: string;
  walletId!: string;
  transactionId!: string;
  walletVersion!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}
