import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DatabaseTransactionRunner } from '../../core/database/database-transaction.runner.js';
import { TransactionRepositories } from '../../shared/transaction-repositories.js';
import type { MoneyProps } from '../../shared/money.js';
import { validateInput } from '../../shared/validation.js';
import { ReconciliationTelemetry } from './reconciliation.telemetry.js';
import { walletErrors } from './wallet.errors.js';

export interface ReconciliationResult {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

/** Reconciles stored wallet balances against cumulative ledger history and publishes telemetry. */
export class ReconciliationUseCase {
  constructor(
    private readonly databaseTransactionRunner: DatabaseTransactionRunner,
    private readonly reconciliationTelemetry: ReconciliationTelemetry,
  ) {}

  /** Compares stored wallet balance against the cumulative sum of ledger entries. */
  async reconcile(
    walletId: string,
    correlationId?: string,
  ): Promise<ReconciliationResult> {
    const id = validateInput(uuidSchema, walletId, walletErrors.invalidWalletId);

    const result = await this.databaseTransactionRunner.run(async (entityManager) => {
      const snapshot = await new TransactionRepositories(
        entityManager,
      ).walletRepository.findReconciliationSnapshot(id);
      if (snapshot === undefined) throw walletErrors.notFound(id);

      const checkedEntries = BigInt(snapshot.checkedEntries);
      if (checkedEntries < 0n || checkedEntries > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError('The ledger entry count exceeds the safe integer range.');
      }

      return {
        walletId: snapshot.walletId,
        storedBalance: { amount: snapshot.storedBalance, currency: snapshot.currency },
        calculatedBalance: {
          amount: snapshot.calculatedBalance,
          currency: snapshot.currency,
        },
        difference: { amount: snapshot.difference, currency: snapshot.currency },
        consistent: snapshot.consistent,
        checkedEntries: Number(checkedEntries),
      };
    });

    // A transaction can retry. Record only the committed read result.
    this.reconciliationTelemetry.record(result, correlationId ?? randomUUID());
    return result;
  }
}
