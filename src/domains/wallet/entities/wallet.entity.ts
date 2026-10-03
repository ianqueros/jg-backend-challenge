import { moneyErrors } from '../../../shared/money.errors.js';
import { walletErrors } from '../wallet.errors.js';
import { Money, type MoneyProps } from '../../../shared/money.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.entity.js';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: MoneyProps;
  readonly version: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly initialBalance?: Money | undefined;
  readonly openingTransactionId?: string | undefined;
  readonly openingLedgerEntryId?: string | undefined;
  readonly at?: Date | undefined;
}

export interface DebitWalletProps {
  readonly transactionId: string;
  readonly money: Money;
  readonly ledgerEntryId: string;
  readonly at?: Date | undefined;
}

export interface CreditWalletProps {
  readonly transactionId: string;
  readonly money: Money;
  readonly ledgerEntryId: string;
  readonly at?: Date | undefined;
}

export interface OpenWalletResult {
  readonly wallet: Wallet;
  readonly openingLedger?: WalletLedgerEntry | undefined;
}

const MAX_INTEGER_DIGITS = 18;

/** Asserts money integer digits do not exceed PostgreSQL decimal precision. */
function assertPersistableBalance(money: Money): void {
  const amountStr = money.toString();
  const dotIndex = amountStr.indexOf('.');
  const integerPart = dotIndex === -1 ? amountStr : amountStr.slice(0, dotIndex);
  const cleanInteger = integerPart.startsWith('-') ? integerPart.slice(1) : integerPart;
  if (cleanInteger.length > MAX_INTEGER_DIGITS) {
    throw walletErrors.balanceOverflow();
  }
}

/**
 * Manages player wallet balance state and enforces financial invariants.
 * Prevents negative balances, maintains version sequencing, and generates balanced ledger entries.
 */
export class Wallet {
  private _balance: Money;
  private _version: string;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    balance: Money,
    version: string,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this._balance = balance;
    this._version = version;
    this._createdAt = new Date(createdAt.getTime());
    this._updatedAt = new Date(updatedAt.getTime());
  }

  /** Initializes a new wallet aggregate at version one with an opening credit entry when funded. */
  public static open(props: OpenWalletProps): OpenWalletResult {
    const timestamp = props.at ? new Date(props.at.getTime()) : new Date();
    const initial = props.initialBalance ?? Money.zero(props.currency);

    if (initial.currency !== props.currency) {
      throw moneyErrors.currencyMismatch();
    }
    if (initial.isNegative()) {
      throw walletErrors.negativeOpeningBalance();
    }
    assertPersistableBalance(initial);

    // Opening establishes version one; it is not a later balance change.
    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.currency,
      initial,
      '1',
      timestamp,
      timestamp,
    );

    if (initial.isZero()) {
      return { wallet };
    }

    if (!props.openingTransactionId || !props.openingLedgerEntryId) {
      throw walletErrors.openingReferencesRequired();
    }

    const openingLedger = WalletLedgerEntry.create({
      id: props.openingLedgerEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initial,
      balanceBefore: Money.zero(props.currency),
      balanceAfter: initial,
      walletVersion: '1',
      createdAt: timestamp,
    });

    return { wallet, openingLedger };
  }

  /** Reconstructs a wallet entity from persisted database state. */
  public static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.rehydrate(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  /** Current wallet balance. */
  public get balance(): Money {
    return this._balance;
  }

  /** Monotonic version string used for optimistic concurrency control. */
  public get version(): string {
    return this._version;
  }

  /** Immutable creation timestamp. */
  public get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  /** Timestamp when balance was last modified. */
  public get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  /** Deducts money from wallet balance and returns a corresponding debit ledger entry. */
  public debit(props: DebitWalletProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!props.money.isPositive()) {
      throw walletErrors.debitAmountInvalid();
    }

    if (this._balance.isLessThan(props.money)) {
      throw walletErrors.insufficientBalance();
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(props.money);
    assertPersistableBalance(balanceAfter);

    const nextVersion = this.nextVersion();
    const timestamp = props.at ? new Date(props.at.getTime()) : new Date();

    this._balance = balanceAfter;
    this._version = nextVersion;
    this._updatedAt = timestamp;

    return WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Debit,
      money: props.money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version,
      createdAt: timestamp,
    });
  }

  /** Adds money to wallet balance and returns a corresponding credit ledger entry. */
  public credit(props: CreditWalletProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!props.money.isPositive()) {
      throw walletErrors.creditAmountInvalid();
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(props.money);
    assertPersistableBalance(balanceAfter);

    const nextVersion = this.nextVersion();
    const timestamp = props.at ? new Date(props.at.getTime()) : new Date();

    this._balance = balanceAfter;
    this._version = nextVersion;
    this._updatedAt = timestamp;

    return WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction: LedgerDirection.Credit,
      money: props.money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version,
      createdAt: timestamp,
    });
  }

  /** Increments the monotonic wallet version string and checks for integer overflow. */
  private nextVersion(): string {
    const version = BigInt(this._version) + 1n;
    if (version > 9223372036854775807n) throw walletErrors.versionExhausted();
    return version.toString();
  }

  /** Asserts that operation money currency matches wallet currency. */
  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw moneyErrors.currencyMismatch();
    }
  }
}
