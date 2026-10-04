import { z } from 'zod';
import { DatabaseTransactionRunner } from '../../core/database/database-transaction.runner.js';
import { TransactionRepositories } from '../../shared/transaction-repositories.js';
import type { WagerTransactionRecord } from './records/wager-transaction.record.js';
import type { MoneyProps } from '../../shared/money.js';
import { validateInput } from '../../shared/validation.js';
import { opaqueIdentifierSchema } from '../../shared/identifiers.js';
import { wageringErrors } from './wagering.errors.js';

export interface WagerTransactionQueryResult {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId?: string | undefined;
  readonly gameId?: string | undefined;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly status: string;
  readonly referenceExternalTransactionId?: string | undefined;
  readonly referenceTransactionId?: string | undefined;
  readonly failureCode?: string | undefined;
  readonly result?: Record<string, unknown> | undefined;
  readonly processedAt?: string | undefined;
  readonly closedAt?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Queries wager transactions by internal or external identifiers.
 */
export class WageringQueryUseCase {
  constructor(private readonly databaseTransactionRunner: DatabaseTransactionRunner) {}

  /**
   * Finds a wager transaction by internal transaction identifier.
   */
  async getTransactionById(transactionId: string): Promise<WagerTransactionQueryResult> {
    const id = validateInput(
      z.uuid(),
      transactionId,
      wageringErrors.invalidTransactionId,
    );

    return this.databaseTransactionRunner.run(async (entityManager) => {
      const transaction = await new TransactionRepositories(
        entityManager,
      ).wagerTransactionRepository.findById(id);
      if (transaction === undefined) throw wageringErrors.notFound();
      return this.toResult(transaction);
    });
  }

  /**
   * Finds a wager transaction by provider identifier and external transaction identifier.
   */
  async getTransactionByExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionQueryResult> {
    const identity = validateInput(
      z.object({
        providerId: opaqueIdentifierSchema,
        externalTransactionId: opaqueIdentifierSchema,
      }),
      { providerId, externalTransactionId },
      wageringErrors.invalidInput,
    );

    return this.databaseTransactionRunner.run(async (entityManager) => {
      const transaction = await new TransactionRepositories(
        entityManager,
      ).wagerTransactionRepository.findByExternal(
        identity.providerId,
        identity.externalTransactionId,
      );
      if (transaction === undefined) throw wageringErrors.notFound();
      return this.toResult(transaction);
    });
  }

  /**
   * Maps a database wager transaction record to the public query result contract.
   */
  private toResult(row: WagerTransactionRecord): WagerTransactionQueryResult {
    return {
      id: row.id,
      providerId: row.providerId,
      externalTransactionId: row.externalTransactionId,
      playerId: row.playerId,
      walletId: row.walletId,
      ...(row.roundId == null ? {} : { roundId: row.roundId }),
      ...(row.gameId == null ? {} : { gameId: row.gameId }),
      kind: row.kind,
      money: { amount: row.amount, currency: row.currency },
      status: row.status,
      ...(row.referenceExternalTransactionId == null
        ? {}
        : {
            referenceExternalTransactionId: row.referenceExternalTransactionId,
          }),
      ...(row.referenceTransactionId == null
        ? {}
        : {
            referenceTransactionId: row.referenceTransactionId,
          }),
      ...(row.failureCode == null ? {} : { failureCode: row.failureCode }),
      ...(row.result == null ? {} : { result: row.result }),
      ...(row.processedAt == null ? {} : { processedAt: row.processedAt.toISOString() }),
      ...(row.closedAt == null ? {} : { closedAt: row.closedAt.toISOString() }),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
