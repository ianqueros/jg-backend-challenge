import { describe, expect, it } from 'bun:test';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domains/wagering/entities/wager-transaction.entity.js';
import { LedgerDirection } from '../../src/domains/wallet/entities/wallet-ledger-entry.entity.js';
import type { ApplicationError, ErrorCategory } from '../../src/shared/errors.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';
import { Money } from '../../src/shared/money.js';

describe('WagerTransaction', () => {
  const providerId = 'provider-a';
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
  const roundId = 'round-100';
  const gameId = 'game-xyz';

  function assertApplicationError(
    action: () => unknown,
    expectedCategory: ErrorCategory,
    expectedCode: string,
  ): ApplicationError {
    let thrown: unknown;
    try {
      action();
    } catch (error) {
      thrown = error;
    }
    return expectApplicationError(thrown, {
      category: expectedCategory,
      code: expectedCode,
    });
  }
  function createValidBet(id = '0192f298-0000-7000-8000-000000000010'): WagerTransaction {
    return WagerTransaction.create({
      id,
      providerId,
      externalTransactionId: 'ext-bet-1',
      idempotencyKey: 'key-bet-1',
      payloadHash: 'hash-bet-1',
      walletId,
      playerId,
      roundId,
      gameId,
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
    });
  }

  it('creates transaction in PENDING status', () => {
    const tx = createValidBet();
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
  });

  it('rejects external creation of OPENING kind', () => {
    assertApplicationError(
      () => {
        WagerTransaction.create({
          id: '0192f298-0000-7000-8000-000000000011',
          providerId,
          externalTransactionId: 'ext-open-1',
          idempotencyKey: 'key-open-1',
          payloadHash: 'hash-open-1',
          walletId,
          playerId,
          roundId,
          gameId,
          kind: WagerTransactionKind.Opening,
          money: Money.from({ amount: '100.00', currency: 'BRL' }),
        });
      },
      'BusinessRuleError',
      'WAGER_OPENING_INTERNAL_ONLY',
    );
  });

  it('creates internal OPENING transaction via createOpening with missing round/game and __internal__ provider', () => {
    const tx = WagerTransaction.createOpening({
      id: '0192f298-0000-7000-8000-000000000012',
      walletId,
      playerId,
      money: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    expect(tx.kind).toBe(WagerTransactionKind.Opening);
    expect(tx.providerId).toBe('__internal__');
    expect(tx.externalTransactionId).toBe(walletId);
    expect(tx.roundId).toBeUndefined();
    expect(tx.gameId).toBeUndefined();
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
  });

  it('accepts non-negative LOSS amounts and optional references without affecting balance', () => {
    const lossZero = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000013',
      providerId,
      externalTransactionId: 'ext-loss-1',
      idempotencyKey: 'key-loss-1',
      payloadHash: 'hash-loss-1',
      walletId,
      playerId,
      roundId,
      gameId,
      kind: WagerTransactionKind.Loss,
      money: Money.zero('BRL'),
    });

    const lossPositiveWithRef = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000014',
      providerId,
      externalTransactionId: 'ext-loss-2',
      idempotencyKey: 'key-loss-2',
      payloadHash: 'hash-loss-2',
      walletId,
      playerId,
      roundId,
      gameId,
      kind: WagerTransactionKind.Loss,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'ext-bet-1',
    });

    expect(lossZero.affectsBalance()).toBe(false);
    expect(lossPositiveWithRef.affectsBalance()).toBe(false);

    assertApplicationError(
      () => {
        WagerTransaction.create({
          id: '0192f298-0000-7000-8000-000000000015',
          providerId,
          externalTransactionId: 'ext-loss-3',
          idempotencyKey: 'key-loss-3',
          payloadHash: 'hash-loss-3',
          walletId,
          playerId,
          roundId,
          gameId,
          kind: WagerTransactionKind.Loss,
          money: Money.signed('-5.00', 'BRL'),
        });
      },
      'BusinessRuleError',
      'WAGER_LOSS_AMOUNT_NEGATIVE',
    );
  });

  it('requires referenceExternalTransactionId for REFUND and ROLLBACK', () => {
    assertApplicationError(
      () => {
        WagerTransaction.create({
          id: '0192f298-0000-7000-8000-000000000016',
          providerId,
          externalTransactionId: 'ext-ref-1',
          idempotencyKey: 'key-ref-1',
          payloadHash: 'hash-ref-1',
          walletId,
          playerId,
          roundId,
          gameId,
          kind: WagerTransactionKind.Refund,
          money: Money.from({ amount: '50.00', currency: 'BRL' }),
        });
      },
      'BusinessRuleError',
      'WAGER_EXTERNAL_REFERENCE_REQUIRED',
    );

    assertApplicationError(
      () => {
        WagerTransaction.create({
          id: '0192f298-0000-7000-8000-000000000017',
          providerId,
          externalTransactionId: 'ext-roll-1',
          idempotencyKey: 'key-roll-1',
          payloadHash: 'hash-roll-1',
          walletId,
          playerId,
          roundId,
          gameId,
          kind: WagerTransactionKind.Rollback,
          money: Money.from({ amount: '50.00', currency: 'BRL' }),
        });
      },
      'BusinessRuleError',
      'WAGER_EXTERNAL_REFERENCE_REQUIRED',
    );
  });

  it('enforces terminal invariants: PROCESSED, REJECTED, and FAILED cannot transition further', () => {
    const tx = createValidBet();
    tx.markProcessed(undefined, new Date());
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);

    assertApplicationError(
      () => {
        tx.markProcessed(undefined, new Date());
      },
      'BusinessRuleError',
      'WAGER_TERMINAL_TRANSITION_PROHIBITED',
    );
    assertApplicationError(
      () => {
        tx.reject(FailureCode.InsufficientFunds);
      },
      'BusinessRuleError',
      'WAGER_TERMINAL_TRANSITION_PROHIBITED',
    );
    assertApplicationError(
      () => {
        tx.fail(FailureCode.InfrastructureFailure);
      },
      'BusinessRuleError',
      'WAGER_TERMINAL_TRANSITION_PROHIBITED',
    );
    assertApplicationError(
      () => {
        tx.markPendingReference();
      },
      'BusinessRuleError',
      'WAGER_TERMINAL_TRANSITION_PROHIBITED',
    );

    const pendingTx = createValidBet('0192f298-0000-7000-8000-000000000019');
    pendingTx.markPendingReference();
    expect(pendingTx.status).toBe(WagerTransactionStatus.PendingReference);
    assertApplicationError(
      () => {
        pendingTx.markPendingReference();
      },
      'BusinessRuleError',
      'WAGER_PENDING_STATE_REQUIRED',
    );
    const rejectedTx = createValidBet('0192f298-0000-7000-8000-000000000020');
    rejectedTx.reject(FailureCode.InsufficientFunds);
    expect(rejectedTx.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejectedTx.failureCode).toBe(FailureCode.InsufficientFunds);
    assertApplicationError(
      () => {
        rejectedTx.markProcessed(undefined, new Date());
      },
      'BusinessRuleError',
      'WAGER_TERMINAL_TRANSITION_PROHIBITED',
    );

    const failedTx = createValidBet('0192f298-0000-7000-8000-000000000021');
    failedTx.fail(FailureCode.InfrastructureFailure);
    expect(failedTx.status).toBe(WagerTransactionStatus.Failed);
    assertApplicationError(
      () => {
        failedTx.markProcessed(undefined, new Date());
      },
      'BusinessRuleError',
      'WAGER_TERMINAL_TRANSITION_PROHIBITED',
    );
  });

  it('derives ledger direction correctly including inverse directions for ROLLBACK', () => {
    const betTx = createValidBet('0192f298-0000-7000-8000-000000000030');
    expect(betTx.ledgerDirectionFor()).toBe(LedgerDirection.Debit);

    const winTx = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000031',
      providerId,
      externalTransactionId: 'ext-win-1',
      idempotencyKey: 'key-win-1',
      payloadHash: 'hash-win-1',
      walletId,
      playerId,
      roundId,
      gameId,
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '75.00', currency: 'BRL' }),
    });
    expect(winTx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);

    const refundTx = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000032',
      providerId,
      externalTransactionId: 'ext-ref-2',
      idempotencyKey: 'key-ref-2',
      payloadHash: 'hash-ref-2',
      walletId,
      playerId,
      roundId,
      gameId,
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'ext-bet-1',
    });
    expect(refundTx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);

    const rollbackTx = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000033',
      providerId,
      externalTransactionId: 'ext-roll-2',
      idempotencyKey: 'key-roll-2',
      payloadHash: 'hash-roll-2',
      walletId,
      playerId,
      roundId,
      gameId,
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'ext-bet-1',
    });

    // Invert BET (Debit) -> Credit
    expect(rollbackTx.ledgerDirectionFor(betTx)).toBe(LedgerDirection.Credit);
    // Invert WIN (Credit) -> Debit
    expect(rollbackTx.ledgerDirectionFor(winTx)).toBe(LedgerDirection.Debit);

    // ROLLBACK cannot reference another ROLLBACK or OPENING
    assertApplicationError(
      () => {
        rollbackTx.ledgerDirectionFor(rollbackTx);
      },
      'BusinessRuleError',
      'WAGER_ROLLBACK_REFERENCE_KIND_INVALID',
    );
  });

  it('validates reference constraints: provider, player, wallet, currency, round (not gameId)', () => {
    const betTx = createValidBet('0192f298-0000-7000-8000-000000000040');
    betTx.markProcessed(undefined, new Date());

    const refundTx = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000041',
      providerId,
      externalTransactionId: 'ext-ref-3',
      idempotencyKey: 'key-ref-3',
      payloadHash: 'hash-ref-3',
      walletId,
      playerId,
      roundId,
      gameId: 'completely-different-game', // Reference context does not require equal games.
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'ext-bet-1',
    });

    const refundWrongRefId = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000049',
      providerId,
      externalTransactionId: 'ext-ref-49',
      idempotencyKey: 'key-ref-49',
      payloadHash: 'hash-ref-49',
      walletId,
      playerId,
      roundId,
      gameId,
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'different-external-id',
    });
    assertApplicationError(
      () => {
        refundWrongRefId.validateReference(betTx);
      },
      'BusinessRuleError',
      'WAGER_REFERENCE_EXTERNAL_ID_MISMATCH',
    );
    assertApplicationError(
      () => {
        refundTx.markProcessed(undefined, new Date());
      },
      'BusinessRuleError',
      'WAGER_RESOLVED_REFERENCE_REQUIRED',
    );
    expect(refundTx.status).toBe(WagerTransactionStatus.Pending);
    refundTx.markProcessed(betTx.id, new Date());
    expect(refundTx.status).toBe(WagerTransactionStatus.Processed);
    expect(refundTx.referenceTransactionId).toBe(betTx.id);

    const refundRoundMismatch = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000042',
      providerId,
      externalTransactionId: 'ext-ref-4',
      idempotencyKey: 'key-ref-4',
      payloadHash: 'hash-ref-4',
      walletId,
      playerId,
      roundId: 'round-999',
      gameId,
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'ext-bet-1',
    });
    assertApplicationError(
      () => {
        refundRoundMismatch.validateReference(betTx);
      },
      'BusinessRuleError',
      'WAGER_REFERENCE_ROUND_MISMATCH',
    );
    const pendingBet = createValidBet('0192f298-0000-7000-8000-000000000043');
    assertApplicationError(
      () => {
        refundTx.validateReference(pendingBet);
      },
      'BusinessRuleError',
      'WAGER_REFERENCE_NOT_PROCESSED',
    );
    const refundWrongAmount = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000044',
      providerId,
      externalTransactionId: 'ext-ref-5',
      idempotencyKey: 'key-ref-5',
      payloadHash: 'hash-ref-5',
      walletId,
      playerId,
      roundId,
      gameId,
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'ext-bet-1',
    });
    assertApplicationError(
      () => {
        refundWrongAmount.validateReference(betTx);
      },
      'BusinessRuleError',
      'WAGER_REFERENCE_AMOUNT_MISMATCH',
    );
  });

  it('rehydrates wager transaction from snapshot restoring state exactly without re-validating transitions', () => {
    const rehydrated = WagerTransaction.rehydrate({
      id: '0192f298-0000-7000-8000-000000000050',
      providerId,
      externalTransactionId: 'ext-bet-99',
      idempotencyKey: 'key-bet-99',
      payloadHash: 'hash-bet-99',
      walletId,
      playerId,
      roundId,
      gameId,
      kind: WagerTransactionKind.Bet,
      money: { amount: '35.00', currency: 'BRL' },
      status: WagerTransactionStatus.Processed,
      createdAt: new Date('2026-03-01T12:00:00.000Z'),
      processedAt: new Date('2026-03-01T12:00:01.000Z'),
    });

    expect(rehydrated.id).toBe('0192f298-0000-7000-8000-000000000050');
    expect(rehydrated.status).toBe(WagerTransactionStatus.Processed);
    expect(rehydrated.isTerminal()).toBe(true);
    expect(rehydrated.processedAt?.toISOString()).toBe('2026-03-01T12:00:01.000Z');
  });
});
