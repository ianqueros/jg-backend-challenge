import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { EventObserver, type ObservedEvent } from '../helpers/event-observer.js';

const client = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4567',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  maxAttempts: 1,
});
let queueUrl: string;
beforeAll(async () => {
  const response = await client.send(
    new CreateQueueCommand({
      QueueName: `observer-${randomUUID()}.fifo`,
      Attributes: { FifoQueue: 'true', VisibilityTimeout: '1' },
    }),
  );
  assert(response.QueueUrl);
  queueUrl = response.QueueUrl;
});
afterAll(async () => {
  await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  client.destroy();
});

function processed(): Extract<ObservedEvent, { eventType: 'WagerTransactionProcessed' }> {
  const walletId = randomUUID();
  const now = new Date().toISOString();
  return {
    eventId: randomUUID(),
    eventType: 'WagerTransactionProcessed',
    version: 1,
    aggregateId: walletId,
    correlationId: randomUUID(),
    occurredAt: now,
    data: {
      transactionId: randomUUID(),
      walletId,
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
      processedAt: now,
    },
  };
}
async function publish(event: ObservedEvent): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(event),
      MessageGroupId: event.aggregateId,
      MessageDeduplicationId: event.eventId,
    }),
  );
}

test('observer validates the four event envelopes from the real broker', async () => {
  const event = processed();
  const balance: ObservedEvent = {
    ...event,
    eventId: randomUUID(),
    eventType: 'WalletBalanceChanged',
    version: 2,
    data: {
      walletId: event.aggregateId,
      transactionId: event.data.transactionId,
      direction: 'DEBIT',
      money: { amount: '1.00', currency: 'BRL' },
      balanceBefore: { amount: '2.00', currency: 'BRL' },
      balanceAfter: { amount: '1.00', currency: 'BRL' },
      walletVersion: '2',
    },
  };
  const rejected: ObservedEvent = {
    ...event,
    eventId: randomUUID(),
    eventType: 'WagerTransactionRejected',
    data: {
      transactionId: event.data.transactionId,
      walletId: event.aggregateId,
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
      failureCode: 'INSUFFICIENT_FUNDS',
      rejectedAt: event.occurredAt,
    },
  };
  const pending: ObservedEvent = {
    ...event,
    eventId: randomUUID(),
    eventType: 'WagerTransactionPendingReference',
    data: {
      transactionId: event.data.transactionId,
      walletId: event.aggregateId,
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      kind: 'REFUND',
      money: { amount: '1.00', currency: 'BRL' },
      referenceExternalTransactionId: randomUUID(),
    },
  };
  for (const item of [event, balance, rejected, pending]) await publish(item);
  const observer = new EventObserver(client, queueUrl);
  expect(await observer.receiveUntil((events) => events.length === 4)).toEqual([
    event,
    balance,
    rejected,
    pending,
  ]);
});

test('observer keeps event identity across a lost acknowledgment and real redelivery', async () => {
  const event = processed();
  await publish(event);
  let failDelete = true;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName === 'DeleteMessageCommand' && failDelete) {
        failDelete = false;
        throw new Error('Lost observer acknowledgment');
      }
      return next(args);
    },
    { step: 'initialize', name: 'loseObserverAck' },
  );
  const observer = new EventObserver(client, queueUrl);
  try {
    await assert.rejects(
      observer.receiveUntil((events) => events.length === 1),
      /Lost observer acknowledgment/,
    );
    expect(observer.events).toEqual([event]);
    await observer.receiveUntil(() => observer.duplicates === 1);
    expect(observer.events).toEqual([event]);
    expect(observer.duplicates).toBe(1);
  } finally {
    client.middlewareStack.remove('loseObserverAck');
  }
});

test('invalid FIFO identity is not acknowledged as an accepted event', async () => {
  const event = processed();
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(event),
      MessageGroupId: randomUUID(),
      MessageDeduplicationId: event.eventId,
    }),
  );
  const observer = new EventObserver(client, queueUrl);
  await assert.rejects(
    observer.receiveUntil((events) => events.length === 1),
    /Invalid event FIFO group/,
  );
  expect(observer.events).toEqual([]);
  const response = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      WaitTimeSeconds: 2,
    }),
  );
  expect(
    response.Messages?.map((message) => JSON.parse(message.Body ?? '') as unknown),
  ).toEqual([event]);
});
