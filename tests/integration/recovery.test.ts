import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Knex } from 'knex';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { createDatabaseOptions } from '../../src/core/database/database.config.js';
import {
  DatabaseTransactionRunner,
  type TransactionAttemptContext,
} from '../../src/core/database/database-transaction.runner.js';
import {
  FinancialUseCase,
  type FinancialContext,
} from '../../src/domains/wagering/financial.use-case.js';
import { WalletUseCase } from '../../src/domains/wallet/wallet.use-case.js';
import { CommandConsumer } from '../../src/domains/messaging/command-consumer.js';
import { OutboxPublisher } from '../../src/domains/messaging/outbox-publisher.js';
import { getOutboxPublisherSettings } from '../../src/core/config/outbox-publisher.settings.js';
import { type CommandConsumerSettings } from '../../src/core/config/command-consumer.settings.js';
import { createQueueClient } from '../../src/core/sqs.transport.js';
import { EventObserver } from '../helpers/event-observer.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domains/wagering/entities/wager-transaction.entity.js';
import { WagerTransactionRecord } from '../../src/domains/wagering/records/wager-transaction.record.js';
import { WalletLedgerEntryRecord } from '../../src/domains/wallet/records/wallet-ledger-entry.record.js';
import { OutboxMessageRecord } from '../../src/domains/outbox/records/outbox-message.record.js';
import { ApplicationError } from '../../src/shared/errors.js';

interface TestQueues {
  readonly sourceUrl: string;
  readonly dlqUrl: string;
  readonly eventsUrl: string;
  readonly sourceQueueName: string;
  readonly dlqQueueName: string;
  readonly eventsQueueName: string;
}

const environment = z
  .object({
    ADMIN_DATABASE_URL: z
      .url()
      .default('postgresql://postgres:postgres_local@127.0.0.1:55432/postgres'),
    SQS_ENDPOINT: z.url().default('http://127.0.0.1:4567'),
    AWS_REGION: z.string().default('us-east-1'),
    AWS_ACCESS_KEY_ID: z.string().default('test'),
    AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  })
  .parse(process.env);

const databaseName = 'jungle_rec_' + randomUUID().replaceAll('-', '');
let admin: MikroORM | undefined;
let application: MikroORM | undefined;
let databaseCreated = false;

let sqs: SQSClient;
let runner: DatabaseTransactionRunner;
let financialUseCase: FinancialUseCase;
let walletUseCase: WalletUseCase;
let queues: TestQueues;

function databaseUrl(user: string, password: string): string {
  const url = new URL(environment.ADMIN_DATABASE_URL);
  url.username = user;
  url.password = password;
  url.pathname = '/' + databaseName;
  return url.toString();
}

function adminDb(): MikroORM {
  assert.ok(admin, 'Admin database is not initialized');
  return admin;
}

function appDb(): MikroORM {
  assert.ok(application, 'Application database is not initialized');
  return application;
}

async function createTestQueues(sqsClient: SQSClient): Promise<TestQueues> {
  const dlqQueueName = 'jungle-rec-dlq-' + randomUUID() + '.fifo';
  const sourceQueueName = 'jungle-rec-src-' + randomUUID() + '.fifo';
  const eventsQueueName = 'jungle-rec-evt-' + randomUUID() + '.fifo';

  const dlqCreated = await sqsClient.send(
    new CreateQueueCommand({
      QueueName: dlqQueueName,
      Attributes: { FifoQueue: 'true' },
    }),
  );
  assert.ok(dlqCreated.QueueUrl, 'DLQ creation failed');
  const dlqUrl = dlqCreated.QueueUrl;

  const dlqAttrs = await sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  assert.ok(dlqAttrs.Attributes?.QueueArn, 'DLQ ARN retrieval failed');
  const dlqArn = dlqAttrs.Attributes.QueueArn;

  const srcCreated = await sqsClient.send(
    new CreateQueueCommand({
      QueueName: sourceQueueName,
      Attributes: { FifoQueue: 'true' },
    }),
  );
  assert.ok(srcCreated.QueueUrl, 'Source queue creation failed');
  const sourceUrl = srcCreated.QueueUrl;

  await sqsClient.send(
    new SetQueueAttributesCommand({
      QueueUrl: sourceUrl,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: 5,
        }),
        VisibilityTimeout: '2',
      },
    }),
  );

  const evtCreated = await sqsClient.send(
    new CreateQueueCommand({
      QueueName: eventsQueueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );
  assert.ok(evtCreated.QueueUrl, 'Events queue creation failed');
  const eventsUrl = evtCreated.QueueUrl;

  return {
    sourceUrl,
    dlqUrl,
    eventsUrl,
    sourceQueueName,
    dlqQueueName,
    eventsQueueName,
  };
}

async function cleanupQueues(
  sqsClient: SQSClient,
  testQueues: TestQueues,
): Promise<void> {
  const deletions = [
    sqsClient
      .send(new DeleteQueueCommand({ QueueUrl: testQueues.sourceUrl }))
      .catch(() => undefined),
    sqsClient
      .send(new DeleteQueueCommand({ QueueUrl: testQueues.dlqUrl }))
      .catch(() => undefined),
    sqsClient
      .send(new DeleteQueueCommand({ QueueUrl: testQueues.eventsUrl }))
      .catch(() => undefined),
  ];
  await Promise.all(deletions);
}

function makeConsumerSettings(
  testQueues: TestQueues,
  overrides: Partial<CommandConsumerSettings> = {},
): CommandConsumerSettings {
  return {
    COMMAND_CONSUMER_ENABLED: false,
    COMMAND_CONSUMER_NAME: 'wager-recovery-commands',
    COMMAND_SOURCE_QUEUE: testQueues.sourceQueueName,
    COMMAND_DLQ_QUEUE: testQueues.dlqQueueName,
    COMMAND_LONG_POLL_SEC: 1,
    COMMAND_VISIBILITY_SEC: 2,
    COMMAND_RENEW_MS: 1000,
    COMMAND_RETRY_BASE_SEC: 1,
    COMMAND_RETRY_MAX_SEC: 2,
    COMMAND_MAX_RECEIVE_COUNT: 5,
    COMMAND_BROKER_TIMEOUT_MS: 2000,
    ...overrides,
  };
}

function makeContext(overrides: Partial<FinancialContext> = {}): FinancialContext {
  return {
    correlationId: randomUUID(),
    providerId: 'recovery-provider',
    ...overrides,
  };
}

async function seedWallet(
  initialAmount = '100.00',
  currency: 'USD' | 'BRL' | 'EUR' = 'USD',
): Promise<{ walletId: string; playerId: string }> {
  const playerId = randomUUID();
  const wallet = await walletUseCase.createWallet({
    playerId,
    initialBalance: { amount: initialAmount, currency },
  });
  return { walletId: wallet.id, playerId };
}

beforeAll(async () => {
  sqs = createQueueClient(environment);
  queues = await createTestQueues(sqs);

  admin = await MikroORM.init(
    createDatabaseOptions(environment.ADMIN_DATABASE_URL, {
      DB_STATEMENT_TIMEOUT_MS: 10000,
      OPERATION_TIMEOUT_MS: 20000,
    }),
  );
  await adminDb()
    .em.getConnection()
    .execute('create database ' + databaseName + ' owner jungle_main');
  databaseCreated = true;

  application = await MikroORM.init(
    createDatabaseOptions(databaseUrl('jungle_main', 'main_local'), {
      DB_STATEMENT_TIMEOUT_MS: 10000,
      OPERATION_TIMEOUT_MS: 20000,
    }),
  );
  // These tests close database connections to check recovery.
  const client = application.em.getConnection().getKnex().client as Knex.Client;
  spyOn(client.logger, 'warn').mockImplementation(() => {});
  await application.migrator.up();

  runner = new DatabaseTransactionRunner(application, {
    DB_TRANSACTION_MAX_ATTEMPTS: 3,
    DB_RETRY_BASE_DELAY_MS: 20,
    DB_RETRY_MAX_DELAY_MS: 100,
    OPERATION_TIMEOUT_MS: 5000,
  });
  financialUseCase = new FinancialUseCase(runner);
  walletUseCase = new WalletUseCase(runner);
}, 60000);

afterAll(async () => {
  await cleanupQueues(sqs, queues);
  sqs.destroy();
  await application?.close(true);
  if (admin !== undefined && databaseCreated) {
    await adminDb()
      .em.getConnection()
      .execute('drop database ' + databaseName + ' with (force)');
  }
  await admin?.close(true);
}, 60000);

describe('Item 28: Crash, Outage, Ambiguity and Lease Recovery', () => {
  beforeEach(async () => {
    await appDb().em.getConnection().execute('TRUNCATE outbox_messages');
  });
  test('1. Pre-commit failure: rolls back all state and allows clean re-submission with original key', async () => {
    const { walletId, playerId } = await seedWallet('100.00');
    const idempotencyKey = 'key-pre-commit-' + randomUUID();
    const externalTransactionId = 'ext-pre-commit-' + randomUUID();

    const payload = {
      providerId: 'recovery-provider',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-pre',
      gameId: 'game-pre',
      kind: WagerTransactionKind.Bet,
      money: { amount: '40.00', currency: 'USD' },
    };
    class BeforeCommitCrashRunner extends DatabaseTransactionRunner {
      override run<T>(
        callback: (em: EntityManager, context: TransactionAttemptContext) => Promise<T>,
      ): Promise<T> {
        return super.run(async (em, context) => {
          await callback(em, context);
          throw new Error('SIMULATED_PRE_COMMIT_CRASH');
        });
      }
    }
    const interrupted = new FinancialUseCase(new BeforeCommitCrashRunner(appDb()));
    await assert.rejects(
      interrupted.execute(payload, idempotencyKey, makeContext()),
      (cause: unknown) =>
        ApplicationError.is(cause) && cause.code === 'DATABASE_OPERATION_FAILED',
    );

    // Verify complete rollback: wallet unchanged, version remains string '1', no operation or ledger row
    const walletAfterCrash = await walletUseCase.getWallet(walletId);
    expect(walletAfterCrash.balance.amount).toBe('100.00');
    expect(walletAfterCrash.version).toBe('1');

    const txRecords = await appDb()
      .em.fork()
      .find(WagerTransactionRecord, { idempotencyKey });
    expect(txRecords).toHaveLength(0);

    const ledgerRecords = await appDb()
      .em.fork()
      .find(WalletLedgerEntryRecord, { walletId, direction: 'DEBIT' });
    expect(ledgerRecords).toHaveLength(0);

    // Replay / execute with original idempotencyKey and externalTransactionId via FinancialUseCase.execute
    const result = await financialUseCase.execute(payload, idempotencyKey, makeContext());

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.idempotentReplay).toBe(false);
    expect(result.balance?.amount).toBe('60.00');

    // State is committed exactly once with version incremented to '2'
    const finalWallet = await walletUseCase.getWallet(walletId);
    expect(finalWallet.balance.amount).toBe('60.00');
    expect(finalWallet.version).toBe('2');

    const finalTx = await appDb()
      .em.fork()
      .find(WagerTransactionRecord, { idempotencyKey });
    expect(finalTx).toHaveLength(1);
    expect(finalTx[0]?.amount).toBe('40.00');

    const finalLedger = await appDb()
      .em.fork()
      .find(WalletLedgerEntryRecord, { walletId, direction: 'DEBIT' });
    expect(finalLedger).toHaveLength(1);
  });

  test('2. Loss of successful COMMIT response: triggers DATABASE_COMMIT_OUTCOME_UNKNOWN and replay recovers committed one-effect', async () => {
    const { walletId, playerId } = await seedWallet('100.00');
    const idempotencyKey = 'key-commit-ambig-' + randomUUID();
    const externalTransactionId = 'ext-commit-ambig-' + randomUUID();

    const payload = {
      providerId: 'recovery-provider',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-commit-ambig',
      gameId: 'game-commit-ambig',
      kind: WagerTransactionKind.Bet,
      money: { amount: '35.00', currency: 'USD' },
    };

    // Runner with single attempt so unknown commit does not retry internally
    const ambiguousRunner = new DatabaseTransactionRunner(appDb(), {
      DB_TRANSACTION_MAX_ATTEMPTS: 1,
      OPERATION_TIMEOUT_MS: 5000,
    });
    const ambiguousFinancialUseCase = new FinancialUseCase(ambiguousRunner);

    // Intercept knex client query: execute real COMMIT on Postgres, then throw network transport loss
    const knex = appDb().em.getConnection().getKnex();
    type KnexClient = { query: (conn: object, obj: unknown) => Promise<unknown> };
    const client = knex.client as unknown as KnexClient;
    const originalQuery = client.query.bind(client);

    let commitIntercepted = false;
    client.query = async function (connection: object, obj: unknown) {
      const result = await originalQuery(connection, obj);
      const sqlText =
        typeof obj === 'string'
          ? obj
          : typeof obj === 'object' &&
              obj !== null &&
              'sql' in obj &&
              typeof obj.sql === 'string'
            ? obj.sql
            : '';
      if (sqlText.trim().toLowerCase().startsWith('commit') && !commitIntercepted) {
        commitIntercepted = true;
        // Postgres committed to disk; simulate loss of network response packet back to client
        throw new Error('SIMULATED_TRANSPORT_FAILURE_AFTER_COMMIT');
      }
      return result;
    };

    let caughtError: unknown;
    try {
      await ambiguousFinancialUseCase.execute(payload, idempotencyKey, makeContext());
    } catch (err) {
      caughtError = err;
    } finally {
      // Restore original knex client query
      client.query = originalQuery;
    }

    assert.ok(commitIntercepted, 'COMMIT must be intercepted');
    assert.ok(ApplicationError.is(caughtError), 'Must throw ApplicationError');
    expect(caughtError.code).toBe('DATABASE_COMMIT_OUTCOME_UNKNOWN');

    // In Postgres, the transaction committed: balance is 65.00
    const walletAfterCommit = await walletUseCase.getWallet(walletId);
    expect(walletAfterCommit.balance.amount).toBe('65.00');

    // Caller retries with the original idempotencyKey and payload
    const replayResult = await financialUseCase.execute(
      payload,
      idempotencyKey,
      makeContext(),
    );
    expect(replayResult.status).toBe(WagerTransactionStatus.Processed);
    expect(replayResult.idempotentReplay).toBe(true);

    // Verify strictly ONE financial effect: balance remains 65.00, exactly 1 debit entry
    const finalWallet = await walletUseCase.getWallet(walletId);
    expect(finalWallet.balance.amount).toBe('65.00');

    const ledgerEntries = await appDb()
      .em.fork()
      .find(WalletLedgerEntryRecord, { walletId, direction: 'DEBIT' });
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]?.amount).toBe('35.00');

    const txRecords = await appDb()
      .em.fork()
      .find(WagerTransactionRecord, { idempotencyKey });
    expect(txRecords).toHaveLength(1);
  });

  test('3. PostgreSQL connection termination recovery: backend kill handled safely and subsequent operations succeed', async () => {
    const { walletId, playerId } = await seedWallet('100.00');

    // Terminate the active backend connection during a transaction
    let terminationError: unknown;
    try {
      await runner.run(async (em) => {
        const [row] = await em.execute<{ pid: number }[]>(
          'SELECT pg_backend_pid() AS pid',
        );
        assert.ok(row?.pid, 'Backend PID required');

        // Terminate our own backend connection to simulate sudden network/database drop
        const adminConnection = adminDb().em.getConnection();
        await adminConnection.execute('SELECT pg_terminate_backend(?, 5000)', [row.pid]);

        // Next query will fail due to terminated connection
        await em.execute('SELECT 1');
      });
    } catch (error) {
      terminationError = error;
    }
    assert.ok(terminationError !== undefined, 'Termination error must be caught');

    // Small delay to allow the connection pool to clear terminated socket
    await delay(100);

    // Verify recovery: subsequent transaction executes cleanly and establishes consistent state
    const recoveryResult = await financialUseCase.execute(
      {
        providerId: 'recovery-provider',
        externalTransactionId: 'ext-conn-recovery-' + randomUUID(),
        playerId,
        walletId,
        roundId: 'round-conn-rec',
        gameId: 'game-conn-rec',
        kind: WagerTransactionKind.Bet,
        money: { amount: '20.00', currency: 'USD' },
      },
      'key-conn-recovery-' + randomUUID(),
      makeContext(),
    );

    expect(recoveryResult.status).toBe(WagerTransactionStatus.Processed);
    const recoveredWallet = await walletUseCase.getWallet(walletId);
    expect(recoveredWallet.balance.amount).toBe('80.00');
  });

  test('4. SQS acknowledgment failure and visibility recovery with real CommandConsumer: duplicate redelivery processed with single financial effect', async () => {
    const { walletId, playerId } = await seedWallet('100.00');
    const idempotencyKey = 'key-ack-recovery-' + randomUUID();
    const externalTransactionId = 'ext-ack-recovery-' + randomUUID();
    const messageId = randomUUID();

    const envelope = {
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'recovery-provider',
        externalTransactionId,
        idempotencyKey,
        playerId,
        walletId,
        roundId: 'round-ack',
        gameId: 'game-ack',
        kind: 'BET',
        money: { amount: '30.00', currency: 'USD' },
      },
    };

    // Send command to source queue
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.sourceUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: walletId,
        MessageDeduplicationId: messageId,
      }),
    );

    // Consumer 1 receives message, processes financial transaction, but fails/crashes on DeleteMessageCommand
    const receive1 = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.sourceUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    const msg1 = receive1.Messages?.[0];
    assert.ok(msg1?.ReceiptHandle, 'Message 1 must be received');

    let interceptedDelete = false;
    const consumerWithheld = new CommandConsumer(
      {
        send: async (command: unknown) => {
          if (command instanceof DeleteMessageCommand) {
            interceptedDelete = true;
            throw new Error('SIMULATED_ACK_FAILURE_OR_CRASH');
          }
          return sqs.send(command as never);
        },
      } as unknown as SQSClient,
      financialUseCase,
      makeConsumerSettings(queues),
    );

    try {
      await consumerWithheld.processMessage(msg1, queues.sourceUrl, queues.dlqUrl);
    } catch {
      // Expected failure when DeleteMessageCommand is intercepted
    }
    expect(interceptedDelete).toBe(true);

    // Database transaction is committed: balance was debited 100 - 30 = 70.00
    const walletAfterCommit = await walletUseCase.getWallet(walletId);
    expect(walletAfterCommit.balance.amount).toBe('70.00');

    // Inbox processing must be durable before acknowledgment.
    const inboxRows = await appDb()
      .em.getConnection()
      .execute<{ processed: boolean }[]>(
        'SELECT processed_at IS NOT NULL AS processed FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
        ['wager-recovery-commands', messageId],
      );
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]?.processed).toBe(true);

    // Wait for SQS visibility timeout to expire (visibility was set to 2 seconds)
    await delay(2500);

    // Consumer 2 receives the redelivered message (ApproximateReceiveCount >= 2)
    const receive2 = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.sourceUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    const msg2 = receive2.Messages?.[0];
    assert.ok(msg2?.ReceiptHandle, 'Redelivered message must be received');
    expect(
      Number(msg2.Attributes?.ApproximateReceiveCount ?? '1'),
    ).toBeGreaterThanOrEqual(2);

    // Consumer 2 processes the redelivered message with standard SQS client (will delete after detecting already processed)
    const consumerRecovered = new CommandConsumer(
      sqs,
      financialUseCase,
      makeConsumerSettings(queues),
    );
    await consumerRecovered.processMessage(msg2, queues.sourceUrl, queues.dlqUrl);

    // Assert strictly single financial effect: wallet balance remains 70.00
    const finalWallet = await walletUseCase.getWallet(walletId);
    expect(finalWallet.balance.amount).toBe('70.00');

    const debitEntries = await appDb()
      .em.fork()
      .find(WalletLedgerEntryRecord, { walletId, direction: 'DEBIT' });
    expect(debitEntries).toHaveLength(1);

    // Message is now deleted from source queue
    const emptyCheck = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.sourceUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );
    expect(emptyCheck.Messages ?? []).toHaveLength(0);
  });

  test('5. Outbox publication failure under broker outage: records remain durable and recover on restored broker', async () => {
    const { walletId, playerId } = await seedWallet('100.00');
    const idempotencyKey = 'key-outbox-outage-' + randomUUID();
    const externalTransactionId = 'ext-outbox-outage-' + randomUUID();

    // Submit transaction: commits atomically with outbox message
    const result = await financialUseCase.execute(
      {
        providerId: 'recovery-provider',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-outbox-outage',
        gameId: 'game-outbox-outage',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'USD' },
      },
      idempotencyKey,
      makeContext(),
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);

    // Find unpublished outbox message in Postgres
    const outboxRows = await appDb()
      .em.fork()
      .find(OutboxMessageRecord, { aggregateId: walletId, publishedAt: null });
    expect(outboxRows.length).toBeGreaterThanOrEqual(1);
    const targetOutbox = outboxRows[0];
    assert.ok(targetOutbox, 'Outbox row required');

    // Attempt publication with an invalid broker client (simulating broker outage)
    const failingSqs = {
      send: async (command: unknown, options?: unknown) => {
        if (command instanceof SendMessageCommand)
          throw new Error('SIMULATED_LOCALSTACK_OUTAGE');
        return sqs.send(command as never, options as never);
      },
    } as unknown as SQSClient;

    const publisherSettings = getOutboxPublisherSettings({
      EVENT_QUEUE: queues.eventsQueueName,
      OUTBOX_PUBLISHER_ENABLED: 'false',
      OUTBOX_POLL_MS: 100,
      OUTBOX_BATCH_SIZE: 5,
      OUTBOX_RETRY_BASE_MS: 200,
      OUTBOX_RETRY_MAX_MS: 1000,
      OPERATION_TIMEOUT_MS: 5000,
    });

    const failingPublisher = new OutboxPublisher(runner, failingSqs, publisherSettings);
    const publishedCount = await failingPublisher.publishOnce();
    expect(publishedCount).toBe(0);

    // Assert outbox row remains durable and unpublished in Postgres
    const postOutageRows = await appDb()
      .em.fork()
      .find(OutboxMessageRecord, { id: targetOutbox.id });
    expect(postOutageRows[0]?.publishedAt).toBeNull();

    // Clear next_attempt_at / retry backoff for immediate recovery
    await appDb()
      .em.getConnection()
      .execute(
        'UPDATE outbox_messages SET claim_token = NULL, claim_expires_at = NULL, next_attempt_at = NULL WHERE id = ?',
        [targetOutbox.id],
      );

    // Recover broker: use real SQS client with OutboxPublisher
    const healthyPublisher = new OutboxPublisher(runner, sqs, publisherSettings);
    const recoveredCount = await healthyPublisher.publishOnce();
    expect(recoveredCount).toBeGreaterThanOrEqual(1);

    // Outbox row is now marked published in Postgres
    const publishedRows = await appDb()
      .em.fork()
      .find(OutboxMessageRecord, { id: targetOutbox.id });
    expect(publishedRows[0]?.publishedAt).not.toBeNull();

    // EventObserver receives event and validates envelope and stable eventId
    const observer = new EventObserver(sqs, queues.eventsUrl);
    const observed = await observer.receiveUntil(
      (events) => events.some((e) => e.eventId === targetOutbox.id),
      5000,
    );
    expect(observed.some((e) => e.eventId === targetOutbox.id)).toBe(true);
  }, 15000);

  test('6. Ambiguous publication confirmation with stable eventId & duplicate delivery tolerance via real OutboxPublisher and SQS middleware', async () => {
    const { walletId, playerId } = await seedWallet('100.00');
    const idempotencyKey = 'key-ambig-pub-' + randomUUID();
    const externalTransactionId = 'ext-ambig-pub-' + randomUUID();

    await financialUseCase.execute(
      {
        providerId: 'recovery-provider',
        externalTransactionId,
        playerId,
        walletId,
        roundId: 'round-ambig-pub',
        gameId: 'game-ambig-pub',
        kind: WagerTransactionKind.Bet,
        money: { amount: '15.00', currency: 'USD' },
      },
      idempotencyKey,
      makeContext(),
    );

    const outboxRows = await appDb()
      .em.fork()
      .find(
        OutboxMessageRecord,
        { aggregateId: walletId, publishedAt: null },
        { orderBy: { createdAt: 'asc', id: 'asc' } },
      );
    const outboxMsg = outboxRows.find((m) => m.eventType === 'WagerTransactionProcessed');
    assert.ok(outboxMsg, 'Processed outbox message required');

    const publisherSettings = getOutboxPublisherSettings({
      EVENT_QUEUE: queues.eventsQueueName,
      OUTBOX_PUBLISHER_ENABLED: 'false',
      OUTBOX_POLL_MS: 100,
      OUTBOX_BATCH_SIZE: 1,
      OUTBOX_RETRY_BASE_MS: 200,
      OUTBOX_RETRY_MAX_MS: 1000,
      OPERATION_TIMEOUT_MS: 5000,
    });

    // Real SQS middleware: sends real SendMessage to SQS, then throws transport loss-of-response
    let sentToBrokerBeforeLoss = false;
    const ambiguousSqsClient = {
      send: async (command: unknown, options?: unknown) => {
        if (command instanceof SendMessageCommand) {
          // Await genuine SQS SendMessage: event is safely enqueued in broker!
          await sqs.send(command, options as never);
          sentToBrokerBeforeLoss = true;
          // Simulate lost response packet / network timeout after successful broker enqueue
          throw new Error('SIMULATED_NETWORK_LOSS_OF_BROKER_CONFIRMATION');
        }
        return (
          sqs as unknown as { send: (cmd: unknown, opts?: unknown) => Promise<unknown> }
        ).send(command, options);
      },
    } as unknown as SQSClient;

    const publisherAmbiguous = new OutboxPublisher(
      runner,
      ambiguousSqsClient,
      publisherSettings,
    );
    const pubResult = await publisherAmbiguous.publishOnce();
    expect(pubResult).toBe(0);
    expect(sentToBrokerBeforeLoss).toBe(true);

    // Crucial check: message was sent to SQS, but in Postgres published_at remains NULL!
    const unconfirmedRecord = await appDb()
      .em.fork()
      .findOne(OutboxMessageRecord, { id: outboxMsg.id });
    expect(unconfirmedRecord?.publishedAt).toBeNull();

    // Clear next_attempt_at / backoff so second publisher can immediately claim
    await appDb()
      .em.getConnection()
      .execute(
        'UPDATE outbox_messages SET claim_token = NULL, claim_expires_at = NULL, next_attempt_at = NULL WHERE id = ?',
        [outboxMsg.id],
      );

    // Second publisher re-publishes the same event with STABLE eventId
    const publisherHealthy = new OutboxPublisher(runner, sqs, publisherSettings);
    const publishedBySecond = await publisherHealthy.publishOnce();
    expect(publishedBySecond).toBe(1);

    // In Postgres, published_at is now set
    const confirmedRecord = await appDb()
      .em.fork()
      .findOne(OutboxMessageRecord, { id: outboxMsg.id });
    expect(confirmedRecord?.publishedAt).not.toBeNull();

    // Intercept delete on first delivery to trigger visibility redelivery, proving observer duplicate tolerance
    let simulateFailedDelete = true;
    const observerSqs = {
      send: async (command: unknown, options?: unknown) => {
        if (command instanceof DeleteMessageCommand && simulateFailedDelete) {
          simulateFailedDelete = false;
          await sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queues.eventsUrl,
              ReceiptHandle: command.input.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          );
          return {};
        }
        return (
          sqs as unknown as { send: (cmd: unknown, opts?: unknown) => Promise<unknown> }
        ).send(command, options);
      },
    } as unknown as SQSClient;

    // Observer receives events, validates strict envelope and stable eventId across duplicates
    const observer = new EventObserver(observerSqs, queues.eventsUrl);
    const observedEvents = await observer.receiveUntil(
      () => observer.duplicates > 0,
      10000,
    );
    expect(observedEvents.some((e) => e.eventId === outboxMsg.id)).toBe(true);
    expect(observer.duplicates).toBeGreaterThan(0);
  }, 30000);
});
