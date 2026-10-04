import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';

const money = z
  .object({
    amount: z.string().regex(/^\d+\.\d{2}$/),
    currency: z.enum(['BRL', 'USD', 'EUR']),
  })
  .strict();
const identity = {
  transactionId: z.uuid(),
  walletId: z.uuid(),
  providerId: z.string().min(1),
  externalTransactionId: z.string().min(1),
  kind: z.enum(['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money,
};
const envelope = {
  eventId: z.uuid(),
  aggregateId: z.uuid(),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  occurredAt: z.iso.datetime(),
};
const balanceData = {
  walletId: z.uuid(),
  transactionId: z.uuid(),
  direction: z.enum(['CREDIT', 'DEBIT']),
  money,
  balanceBefore: money,
  balanceAfter: money,
};
const balanceEvent = z
  .object({
    ...envelope,
    eventType: z.literal('WalletBalanceChanged'),
    version: z.literal(2),
    data: z
      .object({ ...balanceData, walletVersion: z.string().regex(/^[1-9]\d*$/) })
      .strict(),
  })
  .strict();
const legacyBalanceEvent = z
  .object({
    ...envelope,
    eventType: z.literal('WalletBalanceChanged'),
    version: z.literal(1),
    data: z
      .object({
        ...balanceData,
        walletVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  })
  .strict();

export const eventEnvelopeSchema = z
  .union([
    z
      .object({
        ...envelope,
        eventType: z.literal('WagerTransactionProcessed'),
        version: z.literal(1),
        data: z
          .object({
            ...identity,
            roundId: z.string().optional(),
            gameId: z.string().optional(),
            processedAt: z.iso.datetime(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...envelope,
        eventType: z.literal('WagerTransactionRejected'),
        version: z.literal(1),
        data: z
          .object({
            ...identity,
            roundId: z.string().optional(),
            gameId: z.string().optional(),
            failureCode: z.string().min(1),
            rejectedAt: z.iso.datetime(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...envelope,
        eventType: z.literal('WagerTransactionPendingReference'),
        version: z.literal(1),
        data: z
          .object({ ...identity, referenceExternalTransactionId: z.string().optional() })
          .strict(),
      })
      .strict(),
    balanceEvent,
    legacyBalanceEvent,
  ])
  .superRefine((event, context) => {
    if (event.aggregateId !== event.data.walletId) {
      context.addIssue({
        code: 'custom',
        message: 'Event aggregate must equal walletId.',
      });
    }
  });
export type ObservedEvent = z.infer<typeof eventEnvelopeSchema>;

// The harness owns reception for one run. Neither outbox rows nor send results prove delivery.
export class EventObserver {
  private readonly seen = new Map<string, ObservedEvent>();
  private duplicateCount = 0;

  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  get events(): ObservedEvent[] {
    return [...this.seen.values()];
  }
  get duplicates(): number {
    return this.duplicateCount;
  }

  async receiveUntil(
    predicate: (events: ObservedEvent[]) => boolean,
    timeoutMs = 20000,
  ): Promise<ObservedEvent[]> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.events)) {
      const remaining = deadline - Date.now();
      assert(remaining > 0, 'Event reception deadline exceeded.');
      const response = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          WaitTimeSeconds: 1,
          MaxNumberOfMessages: 10,
          MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
        }),
        { abortSignal: AbortSignal.timeout(Math.min(remaining, 5000)) },
      );
      for (const message of response.Messages ?? []) await this.observe(message);
    }
    return this.events;
  }

  private async observe(message: Message): Promise<void> {
    assert(
      message.Body !== undefined && message.ReceiptHandle !== undefined,
      'Incomplete event delivery.',
    );
    const payload: unknown = JSON.parse(message.Body);
    const event = eventEnvelopeSchema.parse(payload);
    if (message.Attributes?.MessageGroupId !== undefined) {
      assert.equal(
        message.Attributes.MessageGroupId,
        event.aggregateId,
        'Invalid event FIFO group.',
      );
    }
    if (message.Attributes?.MessageDeduplicationId !== undefined) {
      assert.equal(
        message.Attributes.MessageDeduplicationId,
        event.eventId,
        'Invalid event deduplication ID.',
      );
    }
    const prior = this.seen.get(event.eventId);
    assert(
      prior === undefined || isDeepStrictEqual(prior, event),
      'An eventId was reused with different content.',
    );
    if (prior === undefined) this.seen.set(event.eventId, event);
    else this.duplicateCount += 1;
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
  }
}
