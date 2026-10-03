import { randomUUID } from 'node:crypto';
import { messagingErrors } from '../messaging.errors.js';
import type { MoneyProps } from '../../../shared/money.js';
import {
  type FailureCode,
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../../wagering/entities/wager-transaction.entity.js';
import type {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../wallet/entities/wallet-ledger-entry.entity.js';
import type { Wallet } from '../../wallet/entities/wallet.entity.js';

export interface EventContext {
  readonly eventId?: string | undefined;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt?: Date | undefined;
}

export interface IntegrationEventProps<T> {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt: Date;
  readonly data: T;
}

export interface SerializedIntegrationEvent<T> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: T;
}

/** Iteratively clones and freezes payload objects to ensure immutability without recursive stack overhead. */
function deepCloneAndFreezePayload<T>(data: T): Readonly<T> {
  const cloned = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  const queue: unknown[] = [cloned];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      Object.freeze(current);
      const record = current as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const val = record[key];
        if (val && typeof val === 'object' && !Object.isFrozen(val)) {
          queue.push(val);
        }
      }
    }
  }

  return cloned as unknown as Readonly<T>;
}

/** Immutable base domain event contract for outbox and message bus delivery. */
export abstract class IntegrationEvent<T> {
  public abstract readonly eventType: string;
  public abstract readonly version: number;

  public readonly eventId: string;
  public readonly aggregateId: string;
  public readonly correlationId: string;
  public readonly causationId?: string | undefined;
  private readonly _occurredAt: Date;
  public readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this._occurredAt = new Date(props.occurredAt.getTime());
    this.data = deepCloneAndFreezePayload(props.data);
  }

  public get occurredAt(): Date {
    return new Date(this._occurredAt.getTime());
  }

  public toJSON(): SerializedIntegrationEvent<T> {
    const base: SerializedIntegrationEvent<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this._occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
    if (this.causationId !== undefined) {
      return { ...base, causationId: this.causationId };
    }
    return base;
  }
}

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: string;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  public readonly eventType = 'WalletBalanceChanged';
  public readonly version = 2;

  public static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    if (wallet.id !== entry.walletId) {
      throw messagingErrors.walletLedgerMismatch();
    }

    const occurredAt = ctx.occurredAt ? new Date(ctx.occurredAt.getTime()) : new Date();
    const eventId = ctx.eventId ?? randomUUID();

    return new WalletBalanceChanged({
      eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}

export interface WagerTransactionProcessedData {
  readonly transactionId: string;
  readonly walletId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly roundId?: string | undefined;
  readonly gameId?: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  public readonly eventType = 'WagerTransactionProcessed';
  public readonly version = 1;

  public static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (tx.status !== WagerTransactionStatus.Processed || !tx.processedAt) {
      throw messagingErrors.processedEventState();
    }

    const occurredAt = ctx.occurredAt ? new Date(ctx.occurredAt.getTime()) : new Date();
    const eventId = ctx.eventId ?? randomUUID();

    return new WagerTransactionProcessed({
      eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData {
  readonly transactionId: string;
  readonly walletId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly roundId?: string | undefined;
  readonly gameId?: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly failureCode?: FailureCode | undefined;
  readonly rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  public readonly eventType = 'WagerTransactionRejected';
  public readonly version = 1;

  public static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (
      tx.status !== WagerTransactionStatus.Rejected ||
      !tx.failureCode ||
      !tx.closedAt
    ) {
      throw messagingErrors.rejectedEventState();
    }

    const occurredAt = ctx.occurredAt ? new Date(ctx.occurredAt.getTime()) : new Date();
    const eventId = ctx.eventId ?? randomUUID();

    return new WagerTransactionRejected({
      eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: tx.failureCode,
        rejectedAt: tx.closedAt.toISOString(),
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData {
  readonly transactionId: string;
  readonly walletId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly referenceExternalTransactionId?: string | undefined;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  public readonly eventType = 'WagerTransactionPendingReference';
  public readonly version = 1;

  public static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    if (tx.status !== WagerTransactionStatus.PendingReference) {
      throw messagingErrors.pendingEventState();
    }

    const occurredAt = ctx.occurredAt ? new Date(ctx.occurredAt.getTime()) : new Date();
    const eventId = ctx.eventId ?? randomUUID();

    return new WagerTransactionPendingReference({
      eventId,
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        kind: tx.kind,
        money: tx.money.toJSON(),
      },
    });
  }
}
