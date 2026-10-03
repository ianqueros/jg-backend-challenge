import { describe, expect, it } from 'bun:test';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../src/domains/messaging/entities/integration-event.entity.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domains/wagering/entities/wager-transaction.entity.js';
import { Wallet } from '../../src/domains/wallet/entities/wallet.entity.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';
import { Money } from '../../src/shared/money.js';

describe('Integration Events', () => {
  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
  const correlationId = 'corr-12345';
  const causationId = 'cause-67890';

  it('preserves historical walletVersion from ledger entry rather than subsequent wallet version', () => {
    const { wallet } = Wallet.open({
      id: walletId,
      playerId,
      currency: 'BRL',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      openingTransactionId: '0192f298-0000-7000-8000-000000000001',
      openingLedgerEntryId: '0192f298-0000-7000-8000-000000000002',
    });

    // Debit 1 -> produces ledger entry at walletVersion 2, updates wallet to version 2
    const firstEntry = wallet.debit({
      transactionId: '0192f298-0000-7000-8000-000000000003',
      ledgerEntryId: '0192f298-0000-7000-8000-000000000004',
      money: Money.from({ amount: '40.00', currency: 'BRL' }),
    });

    // Debit 2 -> produces ledger entry at walletVersion 3, updates wallet to version 3
    wallet.debit({
      transactionId: '0192f298-0000-7000-8000-000000000005',
      ledgerEntryId: '0192f298-0000-7000-8000-000000000006',
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    expect(wallet.version).toBe('3');
    // Event generated from firstEntry must preserve historical walletVersion 2
    const event = WalletBalanceChanged.from(wallet, firstEntry, {
      correlationId,
      causationId,
    });

    expect(event.version).toBe(2);
    expect(event.data.walletVersion).toBe('2');
    expect(event.data.balanceBefore).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(event.data.balanceAfter).toEqual({ amount: '60.00', currency: 'BRL' });
    expect(event.toJSON().causationId).toBe(causationId);
  });

  it('rejects WalletBalanceChanged when walletId does not match ledger entry', () => {
    const { openingLedger } = Wallet.open({
      id: walletId,
      playerId,
      currency: 'BRL',
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
      openingTransactionId: '0192f298-0000-7000-8000-000000000001',
      openingLedgerEntryId: '0192f298-0000-7000-8000-000000000002',
    });

    if (!openingLedger) {
      throw new Error('openingLedger must be defined');
    }

    const otherWallet = Wallet.open({
      id: '0192f291-9999-7d3f-8071-5f8685deef99',
      playerId,
      currency: 'BRL',
    }).wallet;

    let mismatchError: unknown;
    try {
      WalletBalanceChanged.from(otherWallet, openingLedger, { correlationId });
    } catch (error) {
      mismatchError = error;
    }
    expectApplicationError(mismatchError, {
      category: 'ServerError',
      code: 'EVENT_WALLET_LEDGER_MISMATCH',
    });
  });

  it('enforces status preconditions on WagerTransactionProcessed', () => {
    const tx = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000010',
      providerId: 'provider-a',
      externalTransactionId: 'ext-10',
      idempotencyKey: 'key-10',
      payloadHash: 'hash-10',
      walletId,
      playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '20.00', currency: 'BRL' }),
    });

    let processedStateError: unknown;
    try {
      WagerTransactionProcessed.from(tx, { correlationId });
    } catch (error) {
      processedStateError = error;
    }
    expectApplicationError(processedStateError, {
      category: 'ServerError',
      code: 'EVENT_PROCESSED_STATE_REQUIRED',
    });

    tx.markProcessed(undefined, new Date('2026-07-29T12:00:00.000Z'));
    const event = WagerTransactionProcessed.from(tx, { correlationId });
    expect(event.data.processedAt).toBe('2026-07-29T12:00:00.000Z');
  });

  it('enforces status preconditions on WagerTransactionRejected', () => {
    const tx = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000011',
      providerId: 'provider-a',
      externalTransactionId: 'ext-11',
      idempotencyKey: 'key-11',
      payloadHash: 'hash-11',
      walletId,
      playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    let rejectedStateError: unknown;
    try {
      WagerTransactionRejected.from(tx, { correlationId });
    } catch (error) {
      rejectedStateError = error;
    }
    expectApplicationError(rejectedStateError, {
      category: 'ServerError',
      code: 'EVENT_REJECTED_STATE_REQUIRED',
    });

    tx.reject(FailureCode.InsufficientFunds, new Date('2026-07-29T12:05:00.000Z'));
    const event = WagerTransactionRejected.from(tx, { correlationId });
    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(event.data.rejectedAt).toBe('2026-07-29T12:05:00.000Z');
  });

  it('enforces status preconditions on WagerTransactionPendingReference', () => {
    const tx = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000012',
      providerId: 'provider-a',
      externalTransactionId: 'ext-12',
      idempotencyKey: 'key-12',
      payloadHash: 'hash-12',
      walletId,
      playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'ext-bet-missing',
    });

    let pendingStateError: unknown;
    try {
      WagerTransactionPendingReference.from(tx, { correlationId });
    } catch (error) {
      pendingStateError = error;
    }
    expectApplicationError(pendingStateError, {
      category: 'ServerError',
      code: 'EVENT_PENDING_REFERENCE_STATE_REQUIRED',
    });

    tx.markPendingReference();
    const event = WagerTransactionPendingReference.from(tx, { correlationId });
    expect(event.data.referenceExternalTransactionId).toBe('ext-bet-missing');
  });

  it('protects deeply nested payload data and occurredAt from mutation', () => {
    const tx = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000013',
      providerId: 'provider-a',
      externalTransactionId: 'ext-13',
      idempotencyKey: 'key-13',
      payloadHash: 'hash-13',
      walletId,
      playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    tx.markProcessed(undefined, new Date());

    const event = WagerTransactionProcessed.from(tx, { correlationId });

    // Nested mutation via Reflect.set must fail on frozen object
    const moneyTarget = (event.data as unknown as Record<string, unknown>)['money'];
    const setResult = Reflect.set(moneyTarget as object, 'amount', '999.00');
    expect(setResult).toBe(false);
    expect(event.data.money.amount).toBe('10.00');
    expect(event.toJSON().data.money.amount).toBe('10.00');

    // Date getter mutation does not mutate event internal occurredAt
    const readDate = event.occurredAt;
    readDate.setFullYear(2010);
    expect(event.occurredAt.getFullYear()).not.toBe(2010);
  });
});
