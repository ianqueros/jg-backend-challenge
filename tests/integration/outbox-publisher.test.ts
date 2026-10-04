import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { createDatabaseOptions } from '../../src/core/database/database.config.js';
import { DatabaseTransactionRunner } from '../../src/core/database/database-transaction.runner.js';
import { TransactionRepositories } from '../../src/shared/transaction-repositories.js';
import { OutboxPublisher } from '../../src/domains/messaging/outbox-publisher.js';
import { type OutboxPublisherSettings } from '../../src/core/config/outbox-publisher.settings.js';
import { EventObserver } from '../helpers/event-observer.js';

const environment = z
  .object({
    ADMIN_DATABASE_URL: z
      .url()
      .default('postgresql://postgres:postgres_local@127.0.0.1:55432/postgres'),
    SQS_ENDPOINT: z.url().default('http://127.0.0.1:4567'),
  })
  .parse(process.env);

const databaseName = 'jungle_outbox_' + randomUUID().replaceAll('-', '');
const queueName = 'jungle-outbox-test-' + randomUUID() + '.fifo';

let admin: MikroORM | undefined;
let application: MikroORM | undefined;
let databaseCreated = false;
let sqs: SQSClient;
let queueUrl: string;

function createPublisher(
  runner: DatabaseTransactionRunner,
  client: SQSClient = sqs,
  overrides: Partial<OutboxPublisherSettings> = {},
): OutboxPublisher {
  const settings: OutboxPublisherSettings = {
    EVENT_QUEUE: queueName,
    OUTBOX_PUBLISHER_ENABLED: false,
    OUTBOX_POLL_MS: 50,
    OUTBOX_BATCH_SIZE: 10,
    OUTBOX_LEASE_MS: 30000,
    OUTBOX_BROKER_TIMEOUT_MS: 5000,
    OUTBOX_RETRY_BASE_MS: 100,
    OUTBOX_RETRY_MAX_MS: 1000,
    OPERATION_TIMEOUT_MS: 5000,
    ...overrides,
  };
  return new OutboxPublisher(runner, client, settings);
}

function makeBalanceChangedPayload(
  walletId: string,
  transactionId: string,
  eventId: string,
  correlationId: string,
  options: {
    direction?: 'CREDIT' | 'DEBIT';
    amount?: string;
    before?: string;
    after?: string;
    walletVersion?: string;
  } = {},
) {
  return {
    eventId,
    eventType: 'WalletBalanceChanged',
    version: 2,
    aggregateId: walletId,
    correlationId,
    occurredAt: new Date().toISOString(),
    data: {
      walletId,
      transactionId,
      direction: options.direction ?? 'DEBIT',
      money: { amount: options.amount ?? '25.00', currency: 'BRL' as const },
      balanceBefore: { amount: options.before ?? '100.00', currency: 'BRL' as const },
      balanceAfter: { amount: options.after ?? '75.00', currency: 'BRL' as const },
      walletVersion: options.walletVersion ?? '2',
    },
  };
}

function makeTransactionProcessedPayload(
  walletId: string,
  transactionId: string,
  eventId: string,
  correlationId: string,
  externalTransactionId: string,
) {
  return {
    eventId,
    eventType: 'WagerTransactionProcessed',
    version: 1,
    aggregateId: walletId,
    correlationId,
    occurredAt: new Date().toISOString(),
    data: {
      transactionId,
      walletId,
      providerId: 'provider-test',
      externalTransactionId,
      kind: 'BET' as const,
      money: { amount: '25.00', currency: 'BRL' as const },
      roundId: 'round-1',
      gameId: 'game-1',
      processedAt: new Date().toISOString(),
    },
  };
}

beforeAll(async () => {
  sqs = new SQSClient({
    endpoint: environment.SQS_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  const queueResponse = await sqs.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: '30',
      },
    }),
  );
  assert(queueResponse.QueueUrl, 'Event queue creation failed.');
  queueUrl = queueResponse.QueueUrl;

  admin = await MikroORM.init(
    createDatabaseOptions(environment.ADMIN_DATABASE_URL, {
      DB_STATEMENT_TIMEOUT_MS: 10000,
      OPERATION_TIMEOUT_MS: 20000,
    }),
  );

  await admin.em
    .getConnection()
    .execute('create database ' + databaseName + ' owner jungle_main');
  databaseCreated = true;

  const appDbUrl = new URL(environment.ADMIN_DATABASE_URL);
  appDbUrl.username = 'jungle_main';
  appDbUrl.password = 'main_local';
  appDbUrl.pathname = '/' + databaseName;

  application = await MikroORM.init(
    createDatabaseOptions(appDbUrl.toString(), {
      DB_STATEMENT_TIMEOUT_MS: 10000,
      OPERATION_TIMEOUT_MS: 20000,
    }),
  );
  await application.migrator.up();
}, 60000);

afterAll(async () => {
  await application?.close(true);
  if (admin !== undefined && databaseCreated) {
    await admin.em
      .getConnection()
      .execute('drop database ' + databaseName + ' with (force)');
  }
  await admin?.close(true);

  await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  sqs.destroy();
});

describe('OutboxPublisher Integration', () => {
  beforeEach(async () => {
    assert.ok(application, 'Application database is not initialized');
    await application.em
      .getConnection()
      .execute('TRUNCATE TABLE outbox_messages CASCADE');
  });

  test('publishes claimed outbox event and marks published only after broker confirmation', async () => {
    assert.ok(application, 'Application database is not initialized');
    const runner = new DatabaseTransactionRunner(application, {
      DB_TRANSACTION_MAX_ATTEMPTS: 3,
      DB_RETRY_BASE_DELAY_MS: 20,
      DB_RETRY_MAX_DELAY_MS: 100,
      OPERATION_TIMEOUT_MS: 5000,
    });

    const walletId = randomUUID();
    const transactionId = randomUUID();
    const eventId = randomUUID();
    const correlationId = 'corr-' + randomUUID();

    const payload = makeBalanceChangedPayload(
      walletId,
      transactionId,
      eventId,
      correlationId,
    );

    // 1. Enqueue outbox message in the isolated database
    await runner.run(async (em) => {
      const db = new TransactionRepositories(em);
      await db.outboxRepository.enqueue({
        id: eventId,
        aggregateId: walletId,
        eventType: 'WalletBalanceChanged',
        payload,
      });
    });

    // Verify row is initial state: published_at IS NULL, claim_token IS NULL
    const initialRow = await runner.run(async (em) => {
      return new TransactionRepositories(em).outboxRepository.findById(eventId);
    });
    expect(initialRow).toBeDefined();
    expect(initialRow?.publishedAt).toBeNull();
    expect(initialRow?.claimToken).toBeNull();

    // 2. Publish once using OutboxPublisher
    const publisher = createPublisher(runner);
    const publishedCount = await publisher.publishOnce();
    expect(publishedCount).toBe(1);

    // 3. Verify in database: row is marked published with timestamp, claim cleared
    const publishedRow = await runner.run(async (em) => {
      return new TransactionRepositories(em).outboxRepository.findById(eventId);
    });
    expect(publishedRow?.publishedAt).not.toBeNull();
    expect(publishedRow?.claimToken).toBeNull();
    expect(publishedRow?.claimExpiresAt).toBeNull();

    // 4. Verify message arrived at SQS via EventObserver
    const observer = new EventObserver(sqs, queueUrl);
    const observed = await observer.receiveUntil(
      (events) => events.some((e) => e.eventId === eventId),
      15000,
    );

    const targetEvent = observed.find((e) => e.eventId === eventId);
    expect(targetEvent).toBeDefined();
    expect(targetEvent?.eventType).toBe('WalletBalanceChanged');
    expect(targetEvent?.aggregateId).toBe(walletId);
    expect(targetEvent?.correlationId).toBe(correlationId);
  });

  test('keeps row unpublished and schedules backoff retry when broker send fails', async () => {
    assert.ok(application, 'Application database is not initialized');
    const runner = new DatabaseTransactionRunner(application, {
      DB_TRANSACTION_MAX_ATTEMPTS: 3,
      DB_RETRY_BASE_DELAY_MS: 20,
      DB_RETRY_MAX_DELAY_MS: 100,
      OPERATION_TIMEOUT_MS: 5000,
    });
    const walletId = randomUUID();
    const transactionId = randomUUID();
    const eventId = randomUUID();
    const correlationId = 'corr-fail-' + randomUUID();

    const payload = makeBalanceChangedPayload(
      walletId,
      transactionId,
      eventId,
      correlationId,
    );

    await runner.run(async (em) => {
      await new TransactionRepositories(em).outboxRepository.enqueue({
        id: eventId,
        aggregateId: walletId,
        eventType: 'WalletBalanceChanged',
        payload,
      });
    });

    // Create a publisher with a faulty SQS client that throws on SendMessageCommand
    const faultySqs = {
      send: (command: unknown) => {
        if (
          command !== null &&
          typeof command === 'object' &&
          'input' in command &&
          command.input !== null &&
          typeof command.input === 'object' &&
          'QueueName' in command.input
        ) {
          return Promise.resolve({ QueueUrl: queueUrl });
        }
        return Promise.reject(new Error('Simulated broker outage during SendMessage'));
      },
      destroy: () => {},
    } as unknown as SQSClient;

    const publisher = createPublisher(runner, faultySqs);
    const publishedCount = await publisher.publishOnce();
    expect(publishedCount).toBe(0);

    // Verify row was NOT published, attempts incremented, next_attempt_at set into future
    const rowAfterFailure = await runner.run(async (em) => {
      return new TransactionRepositories(em).outboxRepository.findById(eventId);
    });
    expect(rowAfterFailure?.publishedAt).toBeNull();
    expect(rowAfterFailure?.claimToken).toBeNull();
    expect(rowAfterFailure?.attempts).toBe(1);
    expect(rowAfterFailure?.nextAttemptAt).not.toBeNull();
    assert(rowAfterFailure?.nextAttemptAt);
    expect(rowAfterFailure.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  test('multiple publisher instances process concurrent claims without colliding or duplicating', async () => {
    assert.ok(application, 'Application database is not initialized');
    const runner = new DatabaseTransactionRunner(application, {
      DB_TRANSACTION_MAX_ATTEMPTS: 3,
      DB_RETRY_BASE_DELAY_MS: 20,
      DB_RETRY_MAX_DELAY_MS: 100,
      OPERATION_TIMEOUT_MS: 5000,
    });
    const walletId = randomUUID();
    const eventIds: string[] = [];

    // Enqueue 8 messages for the same wallet
    for (let i = 0; i < 8; i++) {
      const eventId = randomUUID();
      eventIds.push(eventId);
      const payload = makeBalanceChangedPayload(
        walletId,
        randomUUID(),
        eventId,
        'corr-concurrent-' + String(i),
        { walletVersion: (i + 2).toString() },
      );
      await runner.run(async (em) => {
        await new TransactionRepositories(em).outboxRepository.enqueue({
          id: eventId,
          aggregateId: walletId,
          eventType: 'WalletBalanceChanged',
          payload,
        });
      });
    }

    // Two independent publishers competing for the queue
    const publisherA = createPublisher(runner, sqs, { OUTBOX_BATCH_SIZE: 4 });
    const publisherB = createPublisher(runner, sqs, { OUTBOX_BATCH_SIZE: 4 });

    // Run publishOnce concurrently
    await Promise.all([publisherA.publishOnce(), publisherB.publishOnce()]);

    const placeholders = eventIds.map(() => '?').join(',');
    const allPublished = await runner.run(async (em) => {
      const records = await em
        .getConnection()
        .execute<{ published_at: Date | null; claim_token: string | null }[]>(
          `SELECT * FROM outbox_messages WHERE id IN (${placeholders})`,
          eventIds,
        );
      return records;
    });

    expect(allPublished.length).toBe(8);
    for (const record of allPublished) {
      expect(record.published_at).not.toBeNull();
      expect(record.claim_token).toBeNull();
    }

    // Verify EventObserver receives all 8 events with exact envelopes and 0 duplicates
    const observer = new EventObserver(sqs, queueUrl);
    const observed = await observer.receiveUntil((events) => {
      const ids = new Set(events.map((e) => e.eventId));
      return eventIds.every((id) => ids.has(id));
    }, 20000);

    const observedTargetIds = observed.filter((e) => eventIds.includes(e.eventId));
    expect(observedTargetIds.length).toBe(8);
    expect(observer.duplicates).toBe(0);
  });

  test('recovers expired ownership claim and fences stale publisher token', async () => {
    assert.ok(application, 'Application database is not initialized');
    const runner = new DatabaseTransactionRunner(application, {
      DB_TRANSACTION_MAX_ATTEMPTS: 3,
      DB_RETRY_BASE_DELAY_MS: 20,
      DB_RETRY_MAX_DELAY_MS: 100,
      OPERATION_TIMEOUT_MS: 5000,
    });
    const walletId = randomUUID();
    const transactionId = randomUUID();
    const eventId = randomUUID();
    const correlationId = 'corr-lease-' + randomUUID();

    const payload = makeBalanceChangedPayload(
      walletId,
      transactionId,
      eventId,
      correlationId,
    );

    await runner.run(async (em) => {
      await new TransactionRepositories(em).outboxRepository.enqueue({
        id: eventId,
        aggregateId: walletId,
        eventType: 'WalletBalanceChanged',
        payload,
      });
    });

    // 1. Publisher 1 acquires claim with a very short lease (100ms)
    let publisher1Token: string | undefined;
    await runner.run(async (em) => {
      const claims = await new TransactionRepositories(
        em,
      ).outboxRepository.claimDueEvents({
        limit: 1,
        leaseMs: 100,
      });
      const target = claims.find((c) => c.id === eventId);
      assert.ok(target?.claimToken, 'Publisher 1 must receive a claim token');
      publisher1Token = target.claimToken;
    });
    assert.ok(publisher1Token, 'Publisher 1 token must exist');

    // 2. Publisher 1 stalls / loses connection; wait for lease to expire (>100ms)
    await delay(150);

    // 3. Publisher 2 (fresh OutboxPublisher) claims and publishes the expired row
    const publisher2 = createPublisher(runner, sqs, { OUTBOX_LEASE_MS: 30000 });
    const count2 = await publisher2.publishOnce();
    expect(count2).toBe(1);

    // 4. Verify in DB: row is marked published
    const rowAfterPub2 = await runner.run(async (em) => {
      return new TransactionRepositories(em).outboxRepository.findById(eventId);
    });
    expect(rowAfterPub2?.publishedAt).not.toBeNull();

    // 5. Publisher 1 wakes up and attempts markPublished with stale token -> returns false (fenced)
    const staleResult = await runner.run(async (em) => {
      assert(publisher1Token);
      return new TransactionRepositories(em).outboxRepository.markPublishedIfOwned(
        eventId,
        publisher1Token,
        new Date(),
      );
    });
    expect(staleResult).toBe(false);

    // 6. Verify EventObserver observes exactly one delivery of this event
    const observer = new EventObserver(sqs, queueUrl);
    const observed = await observer.receiveUntil(
      (events) => events.some((e) => e.eventId === eventId),
      15000,
    );
    const target = observed.filter((e) => e.eventId === eventId);
    expect(target.length).toBe(1);
  });

  test('validates multiple domain event types and FIFO attributes through EventObserver', async () => {
    assert.ok(application, 'Application database is not initialized');
    const runner = new DatabaseTransactionRunner(application, {
      DB_TRANSACTION_MAX_ATTEMPTS: 3,
      DB_RETRY_BASE_DELAY_MS: 20,
      DB_RETRY_MAX_DELAY_MS: 100,
      OPERATION_TIMEOUT_MS: 5000,
    });
    const walletId = randomUUID();
    const betTxId = randomUUID();
    const eventBalanceId = randomUUID();
    const eventTxId = randomUUID();

    const balancePayload = makeBalanceChangedPayload(
      walletId,
      betTxId,
      eventBalanceId,
      'corr-multi-1',
    );
    const txPayload = makeTransactionProcessedPayload(
      walletId,
      betTxId,
      eventTxId,
      'corr-multi-1',
      'ext-' + randomUUID(),
    );

    await runner.run(async (em) => {
      const db = new TransactionRepositories(em);
      await db.outboxRepository.enqueue({
        id: eventBalanceId,
        aggregateId: walletId,
        eventType: 'WalletBalanceChanged',
        payload: balancePayload,
      });
      await db.outboxRepository.enqueue({
        id: eventTxId,
        aggregateId: walletId,
        eventType: 'WagerTransactionProcessed',
        payload: txPayload,
      });
    });

    const publisher = createPublisher(runner);
    const count = await publisher.publishOnce();
    expect(count).toBe(2);

    const observer = new EventObserver(sqs, queueUrl);
    const observed = await observer.receiveUntil(
      (events) =>
        events.some((e) => e.eventId === eventBalanceId) &&
        events.some((e) => e.eventId === eventTxId),
      15000,
    );

    const balanceEvent = observed.find((e) => e.eventId === eventBalanceId);
    const txEvent = observed.find((e) => e.eventId === eventTxId);

    assert.ok(balanceEvent && balanceEvent.eventType === 'WalletBalanceChanged');
    expect(balanceEvent.data.walletId).toBe(walletId);
    expect(balanceEvent.data.transactionId).toBe(betTxId);

    assert.ok(txEvent && txEvent.eventType === 'WagerTransactionProcessed');
    expect(txEvent.data.walletId).toBe(walletId);
    expect(txEvent.data.transactionId).toBe(betTxId);
  });
});
