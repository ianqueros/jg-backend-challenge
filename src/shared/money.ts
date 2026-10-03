import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { moneyErrors } from './money.errors.js';

export const SUPPORTED_CURRENCIES = ['BRL', 'USD', 'EUR'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

const STRICT_AMOUNT_REGEX = /^(0|[1-9][0-9]*)\.[0-9]{2}$/;
const SIGNED_DECIMAL_REGEX = /^-?(0|[1-9][0-9]*)\.[0-9]{2}$/;
const MAX_INTEGER_DIGITS = 18;

// Local Decimal constructor with 100-digit precision avoids polluting ambient Decimal state
// while guaranteeing safe headroom for unconstrained historical reconciliation summations.
const ExactDecimal = Decimal.clone({ precision: 100, rounding: Decimal.ROUND_HALF_UP });

// Zod messages remain in the internal cause; the catalog defines public messages.
export const moneyPropsSchema = z
  .object({
    amount: z
      .string()
      .regex(STRICT_AMOUNT_REGEX, {
        message:
          'Amount must be a non-negative decimal string with exactly two decimal places',
      })
      .refine(
        (val) => {
          const dotIndex = val.indexOf('.');
          const integerPart = dotIndex === -1 ? val : val.slice(0, dotIndex);
          return integerPart.length <= MAX_INTEGER_DIGITS;
        },
        {
          message: 'Amount exceeds NUMERIC(20,2) limit',
        },
      ),
    currency: z.enum(SUPPORTED_CURRENCIES),
  })
  .strict();

/** Immutable monetary value with currency matching and exact two-decimal precision. */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Checks if a currency code belongs to the supported currency set. */
  public static isSupportedCurrency(currency: string): currency is SupportedCurrency {
    return SUPPORTED_CURRENCIES.includes(currency as SupportedCurrency);
  }

  /** Creates a non-negative Money instance from validated amount and currency properties. */
  public static from(props: MoneyProps): Money {
    const parseResult = moneyPropsSchema.safeParse(props);
    if (!parseResult.success) {
      const firstIssue = parseResult.error.issues[0];
      const isCurrencyIssue = firstIssue?.path[0] === 'currency';
      if (isCurrencyIssue) {
        throw moneyErrors.unsupportedCurrency(parseResult.error);
      }
      throw moneyErrors.invalidAmount(parseResult.error);
    }

    return new Money(
      new ExactDecimal(parseResult.data.amount),
      parseResult.data.currency,
    );
  }

  /** Creates a zero-balance Money instance for a supported currency. */
  public static zero(currency: string): Money {
    if (!Money.isSupportedCurrency(currency)) {
      throw moneyErrors.unsupportedCurrency();
    }
    return new Money(new ExactDecimal('0.00'), currency);
  }

  /** Creates a signed Money instance for ledger adjustments and balances. */
  public static signed(amount: string, currency: string): Money {
    if (!Money.isSupportedCurrency(currency)) {
      throw moneyErrors.unsupportedCurrency();
    }

    if (!SIGNED_DECIMAL_REGEX.test(amount)) {
      throw moneyErrors.invalidAmount();
    }

    return new Money(new ExactDecimal(amount), currency);
  }

  /** Reconstructs a Money instance from stored state. */
  public static rehydrate(props: MoneyProps): Money {
    return Money.signed(props.amount, props.currency);
  }

  /** Adds another monetary value of the identical currency. */
  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  /** Subtracts another monetary value of the identical currency. */
  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  /** Inverts the sign of this monetary value. */
  public negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  /** Checks if the value is zero. */
  public isZero(): boolean {
    return this.value.isZero();
  }

  /** Checks if the value is strictly positive. */
  public isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  /** Checks if the value is strictly negative. */
  public isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  /** Compares if this monetary value is strictly less than another of identical currency. */
  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Checks numerical and currency equality with another Money instance. */
  public equals(other: Money): boolean {
    if (this.currency !== other.currency) {
      return false;
    }
    return this.value.equals(other.value);
  }

  /** Serializes to standard amount string and currency properties. */
  public toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  /** Formats the value as a fixed-point decimal string with two decimal places. */
  public toString(): string {
    return this.value.toFixed(2);
  }

  /** Enforces identical currency between operands, rejecting cross-currency arithmetic. */
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw moneyErrors.currencyMismatch();
    }
  }
}
