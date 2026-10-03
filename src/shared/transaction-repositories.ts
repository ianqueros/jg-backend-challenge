import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxRepository } from '../domains/inbox/repositories/inbox.repository.js';
import { WagerTransactionRepository } from '../domains/wagering/repositories/wager-transaction.repository.js';
import { OutboxRepository } from '../domains/outbox/repositories/outbox.repository.js';
import { TransactionRecordStore } from '../core/database/transaction-record-store.js';
import { WalletRepository } from '../domains/wallet/repositories/wallet.repository.js';

/**
 * Binds record repositories to the caller's active transaction.
 * Repositories do not commit or decide financial policy.
 */
export class TransactionRepositories {
  readonly walletRepository: WalletRepository;
  readonly wagerTransactionRepository: WagerTransactionRepository;
  readonly inboxRepository: InboxRepository;
  readonly outboxRepository: OutboxRepository;

  constructor(entityManager: EntityManager) {
    const transactionRecordStore = new TransactionRecordStore(entityManager);
    this.walletRepository = new WalletRepository(transactionRecordStore);
    this.wagerTransactionRepository = new WagerTransactionRepository(
      transactionRecordStore,
    );
    this.inboxRepository = new InboxRepository(transactionRecordStore);
    this.outboxRepository = new OutboxRepository(transactionRecordStore);
  }
}
