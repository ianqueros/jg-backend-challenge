import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '../../src/domains/messaging/entities/inbox-message.entity.js';
import { WagerTransactionProcessed } from '../../src/domains/messaging/entities/integration-event.entity.js';
import { OutboxMessage } from '../../src/domains/messaging/entities/outbox-message.entity.js';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domains/wagering/entities/wager-transaction.entity.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';
import { Money } from '../../src/shared/money.js';

describe('InboxMessage and OutboxMessage', () => {
  it('receives and marks inbox message as processed', () => {
    const message = InboxMessage.receive({
      messageId: 'msg-001',
      consumerName: 'wager-worker',
      payloadHash: 'hash-abc',
    });

    expect(message.messageId).toBe('msg-001');
    expect(message.consumerName).toBe('wager-worker');
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();

    const processDate = new Date('2026-07-29T10:00:00.000Z');
    message.markProcessed(processDate);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt?.toISOString()).toBe('2026-07-29T10:00:00.000Z');

    let secondProcessError: unknown;
    try {
      message.markProcessed(new Date());
    } catch (error) {
      secondProcessError = error;
    }
    expectApplicationError(secondProcessError, {
      category: 'BusinessRuleError',
      code: 'INBOX_ALREADY_PROCESSED',
    });
  });

  it('rehydrates inbox message preserving processed status', () => {
    const rehydrated = InboxMessage.rehydrate({
      messageId: 'msg-002',
      consumerName: 'wager-worker',
      payloadHash: 'hash-xyz',
      receivedAt: new Date('2026-07-29T09:00:00.000Z'),
      processedAt: new Date('2026-07-29T09:05:00.000Z'),
    });

    expect(rehydrated.isProcessed()).toBe(true);
    expect(rehydrated.processedAt?.toISOString()).toBe('2026-07-29T09:05:00.000Z');
  });

  it('enqueues integration event into outbox with pending status', () => {
    const tx = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000099',
      providerId: 'provider-a',
      externalTransactionId: 'ext-99',
      idempotencyKey: 'key-99',
      payloadHash: 'hash-99',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
    });
    tx.markProcessed(undefined, new Date());
    const event = WagerTransactionProcessed.from(tx, { correlationId: 'c-1' });

    const outbox = OutboxMessage.enqueue(event);
    expect(outbox.id).toBe(event.eventId);
    expect(outbox.aggregateId).toBe(tx.walletId);
    expect(outbox.eventType).toBe('WagerTransactionProcessed');
    expect(outbox.isPending()).toBe(true);
    expect(outbox.attempts).toBe(0);
  });

  it('increments retry state with capped exponential backoff', () => {
    const tx = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000100',
      providerId: 'provider-a',
      externalTransactionId: 'ext-100',
      idempotencyKey: 'key-100',
      payloadHash: 'hash-100',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
    });
    tx.markProcessed(undefined, new Date());
    const event = WagerTransactionProcessed.from(tx, { correlationId: 'c-1' });
    const outbox = OutboxMessage.enqueue(event);

    const now = new Date('2026-07-29T10:00:00.000Z');
    const policy = { baseMs: 1000, maxMs: 1500 };
    expect(outbox.scheduleRetry(now, policy)).toEqual({ delayMs: 1000, attempts: 1 });
    const futureRetry = new Date(now.getTime() + 1000);
    expect(outbox.nextAttemptAt?.getTime()).toBe(futureRetry.getTime());
    expect(outbox.scheduleRetry(futureRetry, policy)).toEqual({
      delayMs: 1500,
      attempts: 2,
    });
    expect(outbox.nextAttemptAt?.getTime()).toBe(futureRetry.getTime() + 1500);
  });

  it('marks published and prevents subsequent publication or retry schedule', () => {
    const tx = WagerTransaction.create({
      id: '0192f298-0000-7000-8000-000000000101',
      providerId: 'provider-a',
      externalTransactionId: 'ext-101',
      idempotencyKey: 'key-101',
      payloadHash: 'hash-101',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
    });
    tx.markProcessed(undefined, new Date());
    const event = WagerTransactionProcessed.from(tx, { correlationId: 'c-1' });
    const outbox = OutboxMessage.enqueue(event);
    const policy = { baseMs: 1000, maxMs: 1000 };
    outbox.scheduleRetry(new Date('2026-07-29T10:00:00.000Z'), policy);

    outbox.markPublished(new Date());
    expect(outbox.isPending()).toBe(false);
    expect(outbox.publishedAt).toBeDefined();
    expect(outbox.nextAttemptAt).toBeUndefined();

    let republishError: unknown;
    try {
      outbox.markPublished(new Date());
    } catch (error) {
      republishError = error;
    }
    expectApplicationError(republishError, {
      category: 'BusinessRuleError',
      code: 'OUTBOX_ALREADY_PUBLISHED',
    });

    let retryError: unknown;
    try {
      outbox.scheduleRetry(new Date(), policy);
    } catch (error) {
      retryError = error;
    }
    expectApplicationError(retryError, {
      category: 'BusinessRuleError',
      code: 'OUTBOX_PUBLISHED_RETRY_PROHIBITED',
    });
  });
});
