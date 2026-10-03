import { walletErrors } from '../wallet.errors.js';
import { Money, type MoneyProps } from '../../../shared/money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: string;
  readonly createdAt?: Date | undefined;
}

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: string;
  readonly createdAt: Date;
}

/**
 * Immutable audit record representing a single balance transition on a wallet.
 * Enforces the accounting invariant: balanceBefore +/- money === balanceAfter.
 */
export class WalletLedgerEntry {
  private readonly _createdAt: Date;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: string,
    createdAt: Date,
  ) {
    this._createdAt = new Date(createdAt.getTime());
  }

  /** Creates and validates a new ledger entry, enforcing the balance arithmetic invariant. */
  public static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      props.createdAt ? new Date(props.createdAt.getTime()) : new Date(),
    );

    if (!entry.isBalanced()) {
      throw walletErrors.ledgerUnbalanced();
    }

    return entry;
  }

  /** Reconstructs an existing ledger entry from persisted database state. */
  public static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.rehydrate(state.money),
      Money.rehydrate(state.balanceBefore),
      Money.rehydrate(state.balanceAfter),
      state.walletVersion,
      state.createdAt,
    );
  }

  /** Immutable timestamp when the ledger record was created. */
  public get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  /** Verifies that balanceBefore and money equal balanceAfter for the ledger direction. */
  public isBalanced(): boolean {
    if (this.direction === LedgerDirection.Credit) {
      return this.balanceBefore.add(this.money).equals(this.balanceAfter);
    }
    return this.balanceBefore.subtract(this.money).equals(this.balanceAfter);
  }
}
