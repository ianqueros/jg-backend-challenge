import { describe, expect, it } from 'bun:test';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../src/domains/wallet/entities/wallet-ledger-entry.entity.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';
import { Money } from '../../src/shared/money.js';

describe('WalletLedgerEntry', () => {
  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
  const transactionId = '0192f298-345e-7e38-af88-e43f851a819d';

  it('creates a balanced CREDIT entry', () => {
    const entry = WalletLedgerEntry.create({
      id: '0192f29a-0000-7000-8000-000000000001',
      walletId,
      transactionId,
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '150.00', currency: 'BRL' }),
      walletVersion: '1',
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.money.toString()).toBe('50.00');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('150.00');
    expect(entry.walletVersion).toBe('1');
  });

  it('creates a balanced DEBIT entry', () => {
    const entry = WalletLedgerEntry.create({
      id: '0192f29a-0000-7000-8000-000000000002',
      walletId,
      transactionId,
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '70.00', currency: 'BRL' }),
      walletVersion: '2',
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletVersion).toBe('2');
  });

  it('throws LEDGER_ARITHMETIC_INVALID when arithmetic is invalid', () => {
    let thrown: unknown;
    try {
      WalletLedgerEntry.create({
        id: '0192f29a-0000-7000-8000-000000000003',
        walletId,
        transactionId,
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '60.00', currency: 'BRL' }),
        walletVersion: '1',
      });
    } catch (error) {
      thrown = error;
    }
    expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'LEDGER_ARITHMETIC_INVALID',
    });
  });

  it('protects createdAt Date from external mutation', () => {
    const createdAt = new Date('2026-08-01T12:00:00.000Z');
    const entry = WalletLedgerEntry.create({
      id: '0192f29a-0000-7000-8000-000000000004',
      walletId,
      transactionId,
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      balanceBefore: Money.zero('BRL'),
      balanceAfter: Money.from({ amount: '10.00', currency: 'BRL' }),
      walletVersion: '1',
      createdAt,
    });

    const readDate = entry.createdAt;
    readDate.setFullYear(2020);
    expect(entry.createdAt.getFullYear()).toBe(2026);
  });

  it('rehydrates ledger entry from snapshot without re-validating transitions', () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: '0192f29a-0000-7000-8000-000000000005',
      walletId,
      transactionId,
      direction: LedgerDirection.Credit,
      money: { amount: '20.00', currency: 'USD' },
      balanceBefore: { amount: '10.00', currency: 'USD' },
      balanceAfter: { amount: '30.00', currency: 'USD' },
      walletVersion: '5',
      createdAt: new Date('2026-08-01T12:00:00.000Z'),
    });

    expect(entry.id).toBe('0192f29a-0000-7000-8000-000000000005');
    expect(entry.isBalanced()).toBe(true);
    expect(entry.money.currency).toBe('USD');
    expect(entry.walletVersion).toBe('5');
  });
});
