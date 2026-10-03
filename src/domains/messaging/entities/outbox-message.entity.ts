import { messagingErrors } from '../messaging.errors.js';
import type { IntegrationEvent } from './integration-event.entity.js';

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date | undefined;
  readonly publishedAt?: Date | undefined;
}

/** Represents a durable transactional outbox record tracking publication and retry state. */
export class OutboxMessage {
  private readonly _occurredAt: Date;
  private _attempts: number;
  private _nextAttemptAt?: Date | undefined;
  private _publishedAt?: Date | undefined;

  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    occurredAt: Date,
    attempts: number,
    nextAttemptAt?: Date,
    publishedAt?: Date,
  ) {
    this._occurredAt = new Date(occurredAt.getTime());
    this._attempts = attempts;
    this._nextAttemptAt = nextAttemptAt ? new Date(nextAttemptAt.getTime()) : undefined;
    this._publishedAt = publishedAt ? new Date(publishedAt.getTime()) : undefined;
  }

  public static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = Object.freeze(event.toJSON() as unknown as Record<string, unknown>);

    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      payload,
      event.occurredAt,
      0,
    );
  }

  public static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      Object.freeze({ ...state.payload }),
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  public get occurredAt(): Date {
    return new Date(this._occurredAt.getTime());
  }

  public get attempts(): number {
    return this._attempts;
  }

  public get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt ? new Date(this._nextAttemptAt.getTime()) : undefined;
  }

  public get publishedAt(): Date | undefined {
    return this._publishedAt ? new Date(this._publishedAt.getTime()) : undefined;
  }

  public isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Records successful broker publication timestamp. */
  public markPublished(at: Date): void {
    if (this._publishedAt !== undefined) {
      throw messagingErrors.outboxAlreadyPublished();
    }
    this._publishedAt = new Date(at.getTime());
    this._nextAttemptAt = undefined;
  }

  /** Computes capped backoff and increments retry state; SQL anchors the delay to its clock. */
  public scheduleRetry(
    now: Date,
    policy: { baseMs: number; maxMs: number },
  ): { delayMs: number; attempts: number } {
    if (this._publishedAt !== undefined) {
      throw messagingErrors.publishedRetry();
    }
    const delayMs = Math.min(
      policy.maxMs,
      policy.baseMs * 2 ** Math.min(this._attempts, 30),
    );
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
    return { delayMs, attempts: this._attempts };
  }
}
