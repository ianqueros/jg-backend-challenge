import { GuardedUpdateConflictError } from '../../../core/database/database.errors.js';
import { WalletRecord } from '../records/wallet.record.js';
import { WalletLedgerEntryRecord } from '../records/wallet-ledger-entry.record.js';
import type { TransactionRecordStore } from '../../../core/database/transaction-record-store.js';

export interface WalletInsert {
  id: string;
  playerId: string;
  currency: string;
  balance?: string;
}
export interface WalletUpdate {
  id: string;
  currency: string;
  expectedBalance: string;
  expectedVersion: string;
  balance: string;
}
export type LedgerInsert = Omit<WalletLedgerEntryRecord, 'createdAt'>;

export interface ReconciliationSnapshot {
  walletId: string;
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  difference: string;
  consistent: boolean;
  checkedEntries: string;
}

/**
 * Persists wallet and ledger records in the caller's active transaction.
 * Guards candidate balances; does not commit or calculate financial effects.
 */
export class WalletRepository {
  constructor(
    private readonly transactionRecordStore: TransactionRecordStore,
  ) {} /** Reads the wallet state used by financial updates and balance queries. */
  async findById(id: string): Promise<WalletRecord | undefined> {
    return (await this.transactionRecordStore.find(WalletRecord, { id }))[0];
  }

  /** Compares the stored balance with the signed ledger total in one database snapshot. */
  async findReconciliationSnapshot(
    walletId: string,
  ): Promise<ReconciliationSnapshot | undefined> {
    // One statement gives the wallet and its ledger the same MVCC snapshot.
    return (
      await this.transactionRecordStore.rows<ReconciliationSnapshot>(
        `SELECT w.id AS "walletId", w.currency, w.balance::text AS "storedBalance",
        ledger.calculated_balance::text AS "calculatedBalance",
        (w.balance - ledger.calculated_balance)::text AS difference,
        w.balance = ledger.calculated_balance AS consistent,
        ledger.checked_entries::text AS "checkedEntries"
       FROM wallets w
       CROSS JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount
           ELSE -amount END), 0.00::numeric) AS calculated_balance,
           COUNT(*) AS checked_entries
         FROM wallet_ledger_entries WHERE wallet_id = w.id
       ) ledger
       WHERE w.id = ?`,
        [walletId],
      )
    )[0];
  }

  /** Finds the wallet for a player's currency to enforce one wallet per pair. */
  async findByPlayerCurrency(
    playerId: string,
    currency: string,
  ): Promise<WalletRecord | undefined> {
    return (
      await this.transactionRecordStore.find(WalletRecord, { playerId, currency })
    )[0];
  }

  /** Reads ledger entries in version order within a fixed pagination ceiling. */
  async findLedgerEntriesKeyset(
    walletId: string,
    afterVersion: string,
    ceilingVersion: string,
    limit: number,
  ): Promise<WalletLedgerEntryRecord[]> {
    return this.transactionRecordStore.find(
      WalletLedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterVersion, $lte: ceilingVersion } },
      { orderBy: { walletVersion: 'ASC' }, limit },
    );
  }

  /** Creates the wallet's initial state and returns the database-assigned metadata. */
  async insert(input: WalletInsert): Promise<WalletRecord> {
    return this.transactionRecordStore.insert(WalletRecord, {
      ...input,
      balance: input.balance ?? '0.00',
    });
  }

  /** Advances the wallet version only when the prior state and money bounds still match. */
  async updateGuarded(input: WalletUpdate): Promise<WalletRecord> {
    const [row] = await this.transactionRecordStore.records(
      WalletRecord,
      `
    UPDATE wallets SET balance = ?::numeric, version = version + 1,
      updated_at = clock_timestamp()
    WHERE id = ? AND currency = ? AND balance = ?::numeric AND version = ?::bigint
      AND ?::numeric >= 0 AND ?::numeric <= 999999999999999999.99
      AND ?::numeric = trunc(?::numeric, 2) AND version < 9223372036854775807
      AND balance <> ?::numeric
    RETURNING *`,
      [
        input.balance,
        input.id,
        input.currency,
        input.expectedBalance,
        input.expectedVersion,
        input.balance,
        input.balance,
        input.balance,
        input.balance,
        input.balance,
      ],
    );

    if (row === undefined) throw new GuardedUpdateConflictError();
    return row;
  }

  /** Appends the balance movement for one wallet version; existing entries stay unchanged. */
  async appendLedger(input: LedgerInsert): Promise<WalletLedgerEntryRecord> {
    return this.transactionRecordStore.insert(WalletLedgerEntryRecord, input);
  }
}
