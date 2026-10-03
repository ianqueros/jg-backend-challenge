import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '../../src/domains/wallet/entities/wallet-ledger-entry.entity.js';
import { Wallet } from '../../src/domains/wallet/entities/wallet.entity.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';
import { Money } from '../../src/shared/money.js';

describe('Wallet', () => {
  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

  it('opens wallet with zero balance at version 1 without opening ledger', () => {
    const result = Wallet.open({
      id: walletId,
      playerId,
      currency: 'BRL',
    });

    expect(result.wallet.balance.toString()).toBe('0.00');
    expect(result.wallet.version).toBe('1');
    expect(result.openingLedger).toBeUndefined();
  });

  it('opens wallet with positive balance at version 1 with opening ledger', () => {
    const initial = Money.from({ amount: '500.00', currency: 'BRL' });
    const openingTxId = '0192f298-0000-7000-8000-000000000001';
    const openingLedgerId = '0192f298-0000-7000-8000-000000000002';

    const result = Wallet.open({
      id: walletId,
      playerId,
      currency: 'BRL',
      initialBalance: initial,
      openingTransactionId: openingTxId,
      openingLedgerEntryId: openingLedgerId,
    });

    expect(result.wallet.balance.toString()).toBe('500.00');
    // Opening creates version one, not a second balance-change version.
    expect(result.wallet.version).toBe('1');
    expect(result.openingLedger).toBeDefined();
    expect(result.openingLedger?.direction).toBe(LedgerDirection.Credit);
    expect(result.openingLedger?.money.toString()).toBe('500.00');
    expect(result.openingLedger?.balanceBefore.toString()).toBe('0.00');
    expect(result.openingLedger?.balanceAfter.toString()).toBe('500.00');
  });

  it('rejects opening wallet with currency mismatch or negative balance', () => {
    let mismatchError: unknown;
    try {
      Wallet.open({
        id: walletId,
        playerId,
        currency: 'BRL',
        initialBalance: Money.from({ amount: '100.00', currency: 'USD' }),
      });
    } catch (error) {
      mismatchError = error;
    }
    expectApplicationError(mismatchError, {
      category: 'BusinessRuleError',
      code: 'CURRENCY_MISMATCH',
    });

    let negativeBalanceError: unknown;
    try {
      Wallet.open({
        id: walletId,
        playerId,
        currency: 'BRL',
        initialBalance: Money.signed('-50.00', 'BRL'),
      });
    } catch (error) {
      negativeBalanceError = error;
    }
    expectApplicationError(negativeBalanceError, {
      category: 'BusinessRuleError',
      code: 'WALLET_OPENING_BALANCE_NEGATIVE',
    });
  });

  it('debits wallet, decrements balance, increments version, and produces DEBIT ledger', () => {
    const { wallet } = Wallet.open({
      id: walletId,
      playerId,
      currency: 'BRL',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      openingTransactionId: '0192f298-0000-7000-8000-000000000001',
      openingLedgerEntryId: '0192f298-0000-7000-8000-000000000002',
    });

    const ledger = wallet.debit({
      transactionId: '0192f298-0000-7000-8000-000000000003',
      ledgerEntryId: '0192f298-0000-7000-8000-000000000004',
      money: Money.from({ amount: '40.00', currency: 'BRL' }),
    });

    expect(wallet.balance.toString()).toBe('60.00');
    expect(wallet.version).toBe('2');
    expect(ledger.direction).toBe(LedgerDirection.Debit);
    expect(ledger.money.toString()).toBe('40.00');
    expect(ledger.balanceBefore.toString()).toBe('100.00');
    expect(ledger.balanceAfter.toString()).toBe('60.00');
  });

  it('rejects debit exceeding current balance without mutating balance or version', () => {
    const { wallet } = Wallet.open({
      id: walletId,
      playerId,
      currency: 'BRL',
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
      openingTransactionId: '0192f298-0000-7000-8000-000000000001',
      openingLedgerEntryId: '0192f298-0000-7000-8000-000000000002',
    });

    let insufficientError: unknown;
    try {
      wallet.debit({
        transactionId: '0192f298-0000-7000-8000-000000000003',
        ledgerEntryId: '0192f298-0000-7000-8000-000000000004',
        money: Money.from({ amount: '80.00', currency: 'BRL' }),
      });
    } catch (error) {
      insufficientError = error;
    }
    expectApplicationError(insufficientError, {
      category: 'BusinessRuleError',
      code: 'WALLET_INSUFFICIENT_BALANCE',
    });

    expect(wallet.balance.toString()).toBe('50.00');
    expect(wallet.version).toBe('1');
  });

  it('credits wallet, increments balance, increments version, and produces CREDIT ledger', () => {
    const { wallet } = Wallet.open({
      id: walletId,
      playerId,
      currency: 'BRL',
    });

    const ledger = wallet.credit({
      transactionId: '0192f298-0000-7000-8000-000000000003',
      ledgerEntryId: '0192f298-0000-7000-8000-000000000004',
      money: Money.from({ amount: '200.00', currency: 'BRL' }),
    });

    expect(wallet.balance.toString()).toBe('200.00');
    expect(wallet.version).toBe('2');
    expect(ledger.direction).toBe(LedgerDirection.Credit);
    expect(ledger.money.toString()).toBe('200.00');
    expect(ledger.balanceBefore.toString()).toBe('0.00');
    expect(ledger.balanceAfter.toString()).toBe('200.00');
  });

  it('rejects operations with mismatched currency or non-positive amount', () => {
    const { wallet } = Wallet.open({
      id: walletId,
      playerId,
      currency: 'BRL',
    });

    let creditMismatchError: unknown;
    try {
      wallet.credit({
        transactionId: '0192f298-0000-7000-8000-000000000003',
        ledgerEntryId: '0192f298-0000-7000-8000-000000000004',
        money: Money.from({ amount: '50.00', currency: 'USD' }),
      });
    } catch (error) {
      creditMismatchError = error;
    }
    expectApplicationError(creditMismatchError, {
      category: 'BusinessRuleError',
      code: 'CURRENCY_MISMATCH',
    });

    let zeroCreditError: unknown;
    try {
      wallet.credit({
        transactionId: '0192f298-0000-7000-8000-000000000003',
        ledgerEntryId: '0192f298-0000-7000-8000-000000000004',
        money: Money.zero('BRL'),
      });
    } catch (error) {
      zeroCreditError = error;
    }
    expectApplicationError(zeroCreditError, {
      category: 'BusinessRuleError',
      code: 'WALLET_CREDIT_AMOUNT_INVALID',
    });
  });

  it('protects date fields against external mutation', () => {
    const baseDate = new Date('2026-05-10T10:00:00.000Z');
    const { wallet } = Wallet.open({
      id: walletId,
      playerId,
      currency: 'BRL',
      at: baseDate,
    });

    const readCreated = wallet.createdAt;
    readCreated.setFullYear(2020);
    expect(wallet.createdAt.getFullYear()).toBe(2026);
  });

  it('rehydrates wallet from snapshot restoring exact balance and version without re-validating transitions', () => {
    const rehydrated = Wallet.rehydrate({
      id: walletId,
      playerId,
      currency: 'EUR',
      balance: { amount: '1250.75', currency: 'EUR' },
      version: '7',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T12:00:00.000Z'),
    });

    expect(rehydrated.id).toBe(walletId);
    expect(rehydrated.balance.toString()).toBe('1250.75');
    expect(rehydrated.version).toBe('7');
  });

  it('increments exact high BIGINT version string across debit transitions', () => {
    const wallet = Wallet.rehydrate({
      id: walletId,
      playerId,
      currency: 'BRL',
      balance: { amount: '100.00', currency: 'BRL' },
      version: '9223372036854775800',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T12:00:00.000Z'),
    });

    const ledger = wallet.debit({
      transactionId: '0192f298-0000-7000-8000-000000000003',
      ledgerEntryId: '0192f298-0000-7000-8000-000000000004',
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    expect(wallet.version).toBe('9223372036854775801');
    expect(ledger.walletVersion).toBe('9223372036854775801');
  });

  it('rejects debit and credit when wallet version reaches maximum BIGINT bound', () => {
    const wallet = Wallet.rehydrate({
      id: walletId,
      playerId,
      currency: 'BRL',
      balance: { amount: '100.00', currency: 'BRL' },
      version: '9223372036854775807',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T12:00:00.000Z'),
    });

    let thrown: unknown;
    try {
      wallet.debit({
        transactionId: '0192f298-0000-7000-8000-000000000003',
        ledgerEntryId: '0192f298-0000-7000-8000-000000000004',
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
      });
    } catch (error) {
      thrown = error;
    }

    expectApplicationError(thrown, {
      category: 'BusinessRuleError',
      code: 'WALLET_VERSION_EXHAUSTED',
    });
    expect(wallet.version).toBe('9223372036854775807');
  });
});
