import { wageringErrors } from '../wagering.errors.js';
import { INTERNAL_PROVIDER_ID } from '../../../shared/internal-provider.js';
import { Money, type MoneyProps } from '../../../shared/money.js';
import { LedgerDirection } from '../../wallet/entities/wallet-ledger-entry.entity.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  InsufficientRefundBalance = 'INSUFFICIENT_REFUND_BALANCE',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceInvalidState = 'REFERENCE_INVALID_STATE',
  ReferenceTypeMismatch = 'REFERENCE_TYPE_MISMATCH',
  ReferenceCurrencyMismatch = 'REFERENCE_CURRENCY_MISMATCH',
  ReferencePlayerMismatch = 'REFERENCE_PLAYER_MISMATCH',
  ReferenceWalletMismatch = 'REFERENCE_WALLET_MISMATCH',
  ReferenceRoundMismatch = 'REFERENCE_ROUND_MISMATCH',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  InvalidPayload = 'INVALID_PAYLOAD',
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  WalletCurrencyMismatch = 'WALLET_CURRENCY_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  BalanceOverflow = 'BALANCE_OVERFLOW',
  WalletVersionExhausted = 'WALLET_VERSION_EXHAUSTED',
  ReferenceExpired = 'REFERENCE_EXPIRED',
}

export interface CreateOpeningTransactionProps {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly createdAt?: Date | undefined;
}

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string | undefined;
  readonly createdAt?: Date | undefined;
}

export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId?: string | undefined;
  readonly gameId?: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string | undefined;
  readonly failureCode?: FailureCode | undefined;
  readonly createdAt: Date;
  readonly processedAt?: Date | undefined;
  readonly closedAt?: Date | undefined;
}

/**
 * Asserts valid amount constraints for the given wager transaction kind.
 */
function assertKindAndAmount(kind: WagerTransactionKind, money: Money): void {
  if (kind === WagerTransactionKind.Loss) {
    // LOSS records a result without a financial effect, including non-zero amounts.
    if (money.isNegative()) {
      throw wageringErrors.negativeLoss();
    }
    return;
  }

  if (kind !== WagerTransactionKind.Opening && !money.isPositive()) {
    throw wageringErrors.positiveAmountRequired();
  }
}

/**
 * Asserts that refund and rollback transactions specify a reference transaction identifier.
 */
function assertReferenceRequirement(
  kind: WagerTransactionKind,
  referenceExternalTransactionId?: string,
): void {
  const requiresRef =
    kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  if (requiresRef && !referenceExternalTransactionId) {
    throw wageringErrors.externalReferenceRequired();
  }
}

/**
 * Working entity representing a wager transaction lifecycle and its ledger effect.
 */
export class WagerTransaction {
  private readonly _createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string | undefined;
  private _failureCode?: FailureCode | undefined;
  private _processedAt?: Date | undefined;
  private _closedAt?: Date | undefined;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    createdAt: Date,
    status: WagerTransactionStatus,
    referenceTransactionId?: string,
    failureCode?: FailureCode,
    processedAt?: Date,
    closedAt?: Date,
  ) {
    this._createdAt = new Date(createdAt.getTime());
    this._status = status;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = failureCode;
    this._processedAt = processedAt ? new Date(processedAt.getTime()) : undefined;
    this._closedAt = closedAt ? new Date(closedAt.getTime()) : undefined;
  }

  /**
   * Creates an internal opening transaction to initialize a wallet balance.
   */
  public static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (props.money.isNegative()) {
      throw wageringErrors.negativeOpening();
    }

    const timestamp = props.createdAt ? new Date(props.createdAt.getTime()) : new Date();

    return new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER_ID,
      props.walletId,
      `${INTERNAL_PROVIDER_ID}:${props.walletId}`,
      `opening:${props.id}`,
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      timestamp,
      WagerTransactionStatus.Pending,
    );
  }

  /**
   * Creates a new wager transaction in pending status after validating kind and reference rules.
   */
  public static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw wageringErrors.internalOpening();
    }
    assertKindAndAmount(props.kind, props.money);
    assertReferenceRequirement(props.kind, props.referenceExternalTransactionId);

    const timestamp = props.createdAt ? new Date(props.createdAt.getTime()) : new Date();

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      timestamp,
      WagerTransactionStatus.Pending,
    );
  }

  /**
   * Rehydrates an existing wager transaction from persistent storage.
   */
  public static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.rehydrate(state.money),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.closedAt,
    );
  }

  public get status(): WagerTransactionStatus {
    return this._status;
  }

  public get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  public get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  public get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  public get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  public get closedAt(): Date | undefined {
    return this._closedAt ? new Date(this._closedAt.getTime()) : undefined;
  }

  /**
   * Indicates whether the transaction has reached a final immutable status.
   */
  public isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /**
   * Indicates whether the transaction modifies the player wallet balance.
   */
  public affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /**
   * Indicates whether the transaction requires an existing reference transaction.
   */
  public requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  /**
   * Verifies that a payload hash matches the transaction hash.
   */
  public matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Transitions the transaction to processed status and links the resolved reference transaction.
   */
  public markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal();
    const requiresResolvedRef =
      this.requiresReference() || this.referenceExternalTransactionId !== undefined;

    if (requiresResolvedRef && !referenceTransactionId) {
      throw wageringErrors.resolvedReferenceRequired();
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at.getTime());
  }

  /**
   * Transitions the transaction to pending reference status while waiting for reference settlement.
   */
  public markPendingReference(): void {
    this.assertNotTerminal();
    if (this._status !== WagerTransactionStatus.Pending) {
      throw wageringErrors.pendingRequired();
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  /**
   * Transitions the transaction to rejected status with the specified failure code.
   */
  public reject(code: FailureCode, at?: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._closedAt = at ? new Date(at.getTime()) : new Date();
  }

  /**
   * Transitions the transaction to failed status with the specified failure code.
   */
  public fail(code: FailureCode, at?: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._closedAt = at ? new Date(at.getTime()) : new Date();
  }

  /**
   * Determines the ledger direction for balance mutation, inverting direction for rollbacks.
   */
  public ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === WagerTransactionKind.Bet) {
      return LedgerDirection.Debit;
    }
    if (
      this.kind === WagerTransactionKind.Win ||
      this.kind === WagerTransactionKind.Opening
    ) {
      return LedgerDirection.Credit;
    }
    if (this.kind === WagerTransactionKind.Refund) {
      return LedgerDirection.Credit;
    }
    if (this.kind === WagerTransactionKind.Rollback) {
      if (!reference) {
        throw wageringErrors.rollbackReferenceRequired();
      }
      const allowed =
        reference.kind === WagerTransactionKind.Bet ||
        reference.kind === WagerTransactionKind.Win ||
        reference.kind === WagerTransactionKind.Refund;
      if (!allowed) {
        throw wageringErrors.rollbackKindInvalid();
      }
      return this.deriveRollbackDirection(reference);
    }
    throw wageringErrors.noLedger();
  }

  /**
   * Validates context, status, kind, and amount consistency against the referenced transaction.
   */
  public validateReference(reference: WagerTransaction): void {
    this.validateReferenceContext(reference);
    this.validateReferenceStatus(reference);
    this.validateReferenceKind(reference);
    this.validateReferenceAmount(reference);
  }

  /**
   * Validates that provider, player, wallet, currency, and round match the referenced transaction.
   */
  private validateReferenceContext(ref: WagerTransaction): void {
    if (this.referenceExternalTransactionId !== ref.externalTransactionId) {
      throw wageringErrors.referenceExternalIdMismatch();
    }
    if (this.providerId !== ref.providerId) {
      throw wageringErrors.referenceProviderMismatch();
    }
    if (this.playerId !== ref.playerId) {
      throw wageringErrors.referencePlayerMismatch();
    }
    if (this.walletId !== ref.walletId) {
      throw wageringErrors.referenceWalletMismatch();
    }
    if (this.money.currency !== ref.money.currency) {
      throw wageringErrors.referenceCurrencyMismatch();
    }
    if (this.roundId !== ref.roundId) {
      throw wageringErrors.referenceRoundMismatch();
    }
  }

  /**
   * Validates that the referenced transaction is already in processed status.
   */
  private validateReferenceStatus(ref: WagerTransaction): void {
    if (ref.status !== WagerTransactionStatus.Processed) {
      throw wageringErrors.referenceNotProcessed();
    }
  }

  /**
   * Validates that the referenced transaction kind is valid for the current transaction kind.
   */
  private validateReferenceKind(ref: WagerTransaction): void {
    if (this.kind === WagerTransactionKind.Refund) {
      if (ref.kind !== WagerTransactionKind.Bet) {
        throw wageringErrors.betReferenceRequired();
      }
      return;
    }
    if (this.kind === WagerTransactionKind.Rollback) {
      const allowed =
        ref.kind === WagerTransactionKind.Bet ||
        ref.kind === WagerTransactionKind.Win ||
        ref.kind === WagerTransactionKind.Refund;
      if (!allowed) {
        throw wageringErrors.rollbackKindInvalid();
      }
      return;
    }
    if (this.kind === WagerTransactionKind.Win && ref.kind !== WagerTransactionKind.Bet) {
      throw wageringErrors.betReferenceRequired();
    }
  }

  /**
   * Validates that reversal operations match the exact amount of the referenced transaction.
   */
  private validateReferenceAmount(ref: WagerTransaction): void {
    // Only reversals require the full reference amount; a WIN can differ.
    if (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    ) {
      if (!this.money.equals(ref.money)) {
        throw wageringErrors.referenceAmountMismatch();
      }
    }
  }

  /**
   * Derives the opposite ledger direction to reverse the effect of the referenced transaction.
   */
  private deriveRollbackDirection(reference: WagerTransaction): LedgerDirection {
    // Invert the reference direction: BET(Debit) -> Credit; WIN/REFUND(Credit) -> Debit.
    if (reference.kind === WagerTransactionKind.Bet) {
      return LedgerDirection.Credit;
    }
    return LedgerDirection.Debit;
  }

  /**
   * Guards against state transitions when the transaction is already in a terminal status.
   */
  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw wageringErrors.terminalTransition();
    }
  }
}
