import { describe, expect, it } from 'bun:test';
import { expectApplicationError } from '../helpers/expect-application-error.js';
import { Money, SUPPORTED_CURRENCIES } from '../../src/shared/money.js';

describe('Money', () => {
  it('creates money from valid MoneyProps', () => {
    const money = Money.from({ amount: '100.50', currency: 'BRL' });
    expect(money.toString()).toBe('100.50');
    expect(money.currency).toBe('BRL');
    expect(money.toJSON()).toEqual({ amount: '100.50', currency: 'BRL' });
  });

  it('rejects invalid decimal formats on input', () => {
    const invalidAmounts = [
      '10',
      '10.5',
      '10.500',
      '-10.00',
      '+10.00',
      '01.00',
      '1e2',
      'NaN',
      '',
      ' 10.00',
      '10.00 ',
    ];

    for (const amount of invalidAmounts) {
      let thrown: unknown;
      try {
        Money.from({ amount, currency: 'BRL' });
      } catch (error) {
        thrown = error;
      }
      expectApplicationError(thrown, {
        category: 'ValidationError',
        code: 'INVALID_MONEY_AMOUNT',
      });
    }
  });

  it('rejects amounts exceeding NUMERIC(20,2) limit on input', () => {
    const maxValid = '999999999999999999.99'; // 18 integer digits
    const overflow = '1000000000000000000.00'; // 19 integer digits

    expect(Money.from({ amount: maxValid, currency: 'BRL' }).toString()).toBe(maxValid);
    let overflowError: unknown;
    try {
      Money.from({ amount: overflow, currency: 'BRL' });
    } catch (error) {
      overflowError = error;
    }
    expectApplicationError(overflowError, {
      category: 'ValidationError',
      code: 'INVALID_MONEY_AMOUNT',
    });
  });

  it('validates supported currencies and rejects unsupported currencies', () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      const money = Money.from({ amount: '50.00', currency });
      expect(money.currency).toBe(currency);
    }

    for (const badCurrency of ['JPY', 'GBP']) {
      let currencyError: unknown;
      try {
        Money.from({ amount: '50.00', currency: badCurrency });
      } catch (error) {
        currencyError = error;
      }
      expectApplicationError(currencyError, {
        category: 'ValidationError',
        code: 'UNSUPPORTED_CURRENCY',
      });
    }
  });

  it('adds and subtracts money of same currency', () => {
    const a = Money.from({ amount: '10.25', currency: 'BRL' });
    const b = Money.from({ amount: '5.50', currency: 'BRL' });

    expect(a.add(b).toString()).toBe('15.75');
    expect(a.subtract(b).toString()).toBe('4.75');
  });

  it('throws CURRENCY_MISMATCH when adding or subtracting different currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    for (const action of [
      () => brl.add(usd),
      () => brl.subtract(usd),
      () => brl.isLessThan(usd),
    ]) {
      let diffCurrencyError: unknown;
      try {
        action();
      } catch (error) {
        diffCurrencyError = error;
      }
      expectApplicationError(diffCurrencyError, {
        category: 'BusinessRuleError',
        code: 'CURRENCY_MISMATCH',
      });
    }
  });

  it('checks zero, positive, negative and equality correctly', () => {
    const zero = Money.zero('BRL');
    const positive = Money.from({ amount: '10.00', currency: 'BRL' });
    const negative = Money.signed('-10.00', 'BRL');

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);

    expect(positive.isPositive()).toBe(true);
    expect(positive.isZero()).toBe(false);
    expect(positive.isNegative()).toBe(false);

    expect(negative.isNegative()).toBe(true);
    expect(negative.isPositive()).toBe(false);
    expect(negative.isZero()).toBe(false);

    expect(positive.equals(Money.from({ amount: '10.00', currency: 'BRL' }))).toBe(true);
    expect(positive.equals(Money.from({ amount: '10.00', currency: 'USD' }))).toBe(false);
    expect(positive.equals(zero)).toBe(false);
  });

  it('rehydrates signed and unsigned amounts', () => {
    const positive = Money.rehydrate({ amount: '25.00', currency: 'EUR' });
    const negative = Money.rehydrate({ amount: '-25.00', currency: 'EUR' });

    expect(positive.toString()).toBe('25.00');
    expect(negative.toString()).toBe('-25.00');
    expect(negative.isNegative()).toBe(true);
  });

  it('supports unconstrained intermediate summation for reconciliation without artificial clamping', () => {
    const huge = Money.from({ amount: '900000000000000000.00', currency: 'BRL' });
    const sum = huge.add(huge); // 1800000000000000000.00 - exceeds 18 digits in calculation
    expect(sum.toString()).toBe('1800000000000000000.00');
    expect(sum.negate().toString()).toBe('-1800000000000000000.00');
  });
});
