import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import assert from 'node:assert';
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
  type Message,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { createDatabaseOptions } from '../../src/core/database/database.config.js';
import { DatabaseTransactionRunner } from '../../src/core/database/database-transaction.runner.js';
import {
  FinancialUseCase,
  type FinancialResult,
} from '../../src/domains/wagering/financial.use-case.js';
import { WalletUseCase } from '../../src/domains/wallet/wallet.use-case.js';
import { CommandConsumer } from '../../src/domains/messaging/command-consumer.js';
import type { CommandConsumerSettings } from '../../src/core/config/command-consumer.settings.js';
import { createQueueClient } from '../../src/core/sqs.transport.js';
import { ApplicationError } from '../../src/shared/errors.js';

type ExecuteCommandFn = (...fnArgs: unknown[]) => Promise<FinancialResult>;

interface EnvelopeOverrides {
  messageId?: string;
  amount?: string;
  currency?: string;
  kind?: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  idempotencyKey?: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  providerId?: string;
  roundId?: string;
  gameId?: string;
}

interface TestQueues {
  sourceUrl: string;
  dlqUrl: string;
  sourceQueueName: string;
  dlqQueueName: string;
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

const databaseName = 'jungle_cc_' + randomUUID().replaceAll('-', '');
let admin: MikroORM | undefined;
let application: MikroORM | undefined;
let databaseCreated = false;

let sqs: SQSClient;
let runner: DatabaseTransactionRunner;
let financialUseCase: FinancialUseCase;
let walletUseCase: WalletUseCase;

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

async function createTestQueues(
  sqsClient: SQSClient,
  options: { visibilitySec?: number; maxReceiveCount?: number } = {},
): Promise<TestQueues> {
  const dlqQueueName = 'jungle-cc-dlq-' + randomUUID() + '.fifo';
  const sourceQueueName = 'jungle-cc-src-' + randomUUID() + '.fifo';

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
          maxReceiveCount: options.maxReceiveCount ?? 5,
        }),
        VisibilityTimeout: (options.visibilitySec ?? 5).toString(),
      },
    }),
  );

  return { sourceUrl, dlqUrl, sourceQueueName, dlqQueueName };
}

async function cleanupTestQueues(
  sqsClient: SQSClient,
  queues: TestQueues,
): Promise<void> {
  try {
    await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queues.sourceUrl }));
  } finally {
    await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queues.dlqUrl }));
  }
}

function makeSettings(
  queues: TestQueues,
  overrides: Partial<CommandConsumerSettings> = {},
): CommandConsumerSettings {
  return {
    COMMAND_CONSUMER_ENABLED: false,
    COMMAND_CONSUMER_NAME: 'wager-commands',
    COMMAND_SOURCE_QUEUE: queues.sourceQueueName,
    COMMAND_DLQ_QUEUE: queues.dlqQueueName,
    COMMAND_LONG_POLL_SEC: 1,
    COMMAND_VISIBILITY_SEC: 5,
    COMMAND_RENEW_MS: 1000,
    COMMAND_RETRY_BASE_SEC: 1,
    COMMAND_RETRY_MAX_SEC: 2,
    COMMAND_MAX_RECEIVE_COUNT: 5,
    COMMAND_BROKER_TIMEOUT_MS: 2000,
    ...overrides,
  };
}

function buildEnvelope(
  walletId: string,
  playerId: string,
  overrides: EnvelopeOverrides = {},
) {
  const messageId = overrides.messageId ?? randomUUID();
  const baseData = {
    providerId: 'provider-test',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET' as const,
    money: {
      amount: overrides.amount ?? '25.00',
      currency: overrides.currency ?? 'USD',
    },
  };
  const customFields = { ...overrides };
  delete customFields.amount;
  delete customFields.currency;
  delete customFields.messageId;
  const data = Object.assign(baseData, customFields);
  return {
    messageId,
    type: 'WagerTransactionRequested' as const,
    occurredAt: new Date().toISOString(),
    data,
  };
}

async function receiveOne(
  sqsClient: SQSClient,
  queueUrl: string,
  waitTime = 1,
): Promise<Message | undefined> {
  const response = await sqsClient.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: waitTime,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  );
  return response.Messages?.[0];
}

beforeAll(async () => {
  sqs = createQueueClient(environment);

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
  await application?.close(true);
  if (admin !== undefined && databaseCreated) {
    await adminDb()
      .em.getConnection()
      .execute('drop database ' + databaseName + ' with (force)');
  }
  await admin?.close(true);
  sqs.destroy();
});

describe('CommandConsumer Integration', () => {
  test('observes committed database state before broker message deletion', async () => {
    const queues = await createTestQueues(sqs, { visibilitySec: 5 });
    const consumerSqs = createQueueClient(environment);
    try {
      const wallet = await walletUseCase.createWallet({
        playerId: randomUUID(),
        initialBalance: { amount: '100.00', currency: 'USD' },
      });
      const envelope = buildEnvelope(wallet.id, wallet.playerId, { amount: '20.00' });
      const rawBody = JSON.stringify(envelope);

      let observedInboxCommitted = false;
      let observedTransactionCommitted = false;
      let deleteAttempted = false;

      const originalSend = consumerSqs.send.bind(consumerSqs);
      consumerSqs.send = (async (
        command: Parameters<SQSClient['send']>[0],
        options?: Parameters<SQSClient['send']>[1],
      ) => {
        if (command instanceof DeleteMessageCommand) {
          deleteAttempted = true;
          // Verify application database reflects commit before broker deletion begins.
          const inboxRows: Array<{ processed: boolean }> = await appDb()
            .em.getConnection()
            .execute(
              'select processed_at is not null as processed from inbox_messages where message_id = ?',
              [envelope.messageId],
            );
          const txRows: Array<{ status: string }> = await appDb()
            .em.getConnection()
            .execute('select status from wager_transactions where idempotency_key = ?', [
              envelope.data.idempotencyKey,
            ]);

          if (inboxRows[0]?.processed === true) observedInboxCommitted = true;
          if (txRows[0]?.status === 'PROCESSED') observedTransactionCommitted = true;
        }
        return originalSend(command, options);
      }) as SQSClient['send'];

      const consumer = new CommandConsumer(
        consumerSqs,
        financialUseCase,
        makeSettings(queues),
      );

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: rawBody,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );

      const received = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(received, 'Message must be received');
      await consumer.processMessage(received, queues.sourceUrl, queues.dlqUrl);

      expect(deleteAttempted).toBe(true);
      expect(observedInboxCommitted).toBe(true);
      expect(observedTransactionCommitted).toBe(true);

      const remaining = await receiveOne(sqs, queues.sourceUrl, 0);
      expect(remaining).toBeUndefined();
    } finally {
      consumerSqs.destroy();
      await cleanupTestQueues(sqs, queues);
    }
  });

  test('deduplicates logical message across distinct broker deduplication IDs', async () => {
    const queues = await createTestQueues(sqs);
    const consumerSqs = createQueueClient(environment);
    try {
      const wallet = await walletUseCase.createWallet({
        playerId: randomUUID(),
        initialBalance: { amount: '100.00', currency: 'USD' },
      });
      const envelope = buildEnvelope(wallet.id, wallet.playerId, { amount: '35.00' });
      const rawBody = JSON.stringify(envelope);

      const consumer = new CommandConsumer(
        consumerSqs,
        financialUseCase,
        makeSettings(queues),
      );

      // Send first delivery.
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: rawBody,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const msg1 = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(msg1, 'Message 1 must be received');
      await consumer.processMessage(msg1, queues.sourceUrl, queues.dlqUrl);

      // Send second delivery with identical envelope but different SQS deduplication identity.
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: rawBody,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const msg2 = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(msg2, 'Message 2 must be received');
      await consumer.processMessage(msg2, queues.sourceUrl, queues.dlqUrl);

      // Single financial effect: 100 - 35 = 65.
      const updatedWallet = await walletUseCase.getWallet(wallet.id);
      expect(updatedWallet.balance.amount).toBe('65.00');

      const inboxCount: Array<{ count: string }> = await appDb()
        .em.getConnection()
        .execute(
          'select count(*)::text as count from inbox_messages where message_id = ?',
          [envelope.messageId],
        );
      expect(inboxCount[0]?.count).toBe('1');
    } finally {
      consumerSqs.destroy();
      await cleanupTestQueues(sqs, queues);
    }
  });

  test('preserves original transaction and routes conflicting envelope to DLQ', async () => {
    const queues = await createTestQueues(sqs);
    const consumerSqs = createQueueClient(environment);
    try {
      const wallet = await walletUseCase.createWallet({
        playerId: randomUUID(),
        initialBalance: { amount: '100.00', currency: 'USD' },
      });
      const messageId = randomUUID();
      const originalEnvelope = buildEnvelope(wallet.id, wallet.playerId, {
        messageId,
        amount: '30.00',
      });
      const conflictingEnvelope = buildEnvelope(wallet.id, wallet.playerId, {
        messageId,
        amount: '50.00',
      });

      const consumer = new CommandConsumer(
        consumerSqs,
        financialUseCase,
        makeSettings(queues),
      );

      // Process original envelope.
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: JSON.stringify(originalEnvelope),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const msg1 = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(msg1, 'Original message must be received');
      await consumer.processMessage(msg1, queues.sourceUrl, queues.dlqUrl);

      // Process conflicting envelope sharing messageId.
      const conflictingRaw = JSON.stringify(conflictingEnvelope);
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: conflictingRaw,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const msg2 = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(msg2, 'Conflicting message must be received');
      await consumer.processMessage(msg2, queues.sourceUrl, queues.dlqUrl);

      // Original financial state preserved: 100 - 30 = 70.
      const currentWallet = await walletUseCase.getWallet(wallet.id);
      expect(currentWallet.balance.amount).toBe('70.00');

      // Conflicting raw payload delivered to DLQ.
      const dlqMessage = await receiveOne(sqs, queues.dlqUrl);
      assert.ok(dlqMessage, 'DLQ message must be received');
      expect(dlqMessage.Body).toBe(conflictingRaw);

      const sourceRemaining = await receiveOne(sqs, queues.sourceUrl, 0);
      expect(sourceRemaining).toBeUndefined();
    } finally {
      consumerSqs.destroy();
      await cleanupTestQueues(sqs, queues);
    }
  });

  test('replays operation with new logical envelope through distinct inbox entry', async () => {
    const queues = await createTestQueues(sqs);
    const consumerSqs = createQueueClient(environment);
    try {
      const wallet = await walletUseCase.createWallet({
        playerId: randomUUID(),
        initialBalance: { amount: '100.00', currency: 'USD' },
      });
      const idempotencyKey = randomUUID();
      const externalTransactionId = randomUUID();

      const sharedOpData = {
        providerId: 'provider-test',
        externalTransactionId,
        idempotencyKey,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET' as const,
        money: { amount: '40.00', currency: 'USD' },
      };

      const env1 = {
        messageId: randomUUID(),
        type: 'WagerTransactionRequested' as const,
        occurredAt: new Date().toISOString(),
        data: sharedOpData,
      };
      const env2 = {
        messageId: randomUUID(),
        type: 'WagerTransactionRequested' as const,
        occurredAt: new Date().toISOString(),
        data: sharedOpData,
      };

      const consumer = new CommandConsumer(
        consumerSqs,
        financialUseCase,
        makeSettings(queues),
      );

      // Process first envelope.
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: JSON.stringify(env1),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const msg1 = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(msg1, 'Message 1 must be received');
      await consumer.processMessage(msg1, queues.sourceUrl, queues.dlqUrl);

      // Process second envelope with same operation identity.
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: JSON.stringify(env2),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const msg2 = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(msg2, 'Message 2 must be received');
      await consumer.processMessage(msg2, queues.sourceUrl, queues.dlqUrl);

      // Single balance modification: 100 - 40 = 60.
      const currentWallet = await walletUseCase.getWallet(wallet.id);
      expect(currentWallet.balance.amount).toBe('60.00');

      // Distinct inbox records for each envelope messageId.
      const rows: Array<{ message_id: string; processed: boolean }> = await appDb()
        .em.getConnection()
        .execute(
          'select message_id, processed_at is not null as processed from inbox_messages where message_id in (?, ?) order by message_id',
          [env1.messageId, env2.messageId],
        );
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.processed)).toBe(true);

      const dlqCheck = await receiveOne(sqs, queues.dlqUrl, 0);
      expect(dlqCheck).toBeUndefined();
    } finally {
      consumerSqs.destroy();
      await cleanupTestQueues(sqs, queues);
    }
  });

  test('acknowledges durable business rejection and pending reference without DLQ routing', async () => {
    const queues = await createTestQueues(sqs);
    const consumerSqs = createQueueClient(environment);
    try {
      const wallet = await walletUseCase.createWallet({
        playerId: randomUUID(),
        initialBalance: { amount: '50.00', currency: 'USD' },
      });

      const consumer = new CommandConsumer(
        consumerSqs,
        financialUseCase,
        makeSettings(queues),
      );

      // 1. Rejection: insufficient funds.
      const rejectEnvelope = buildEnvelope(wallet.id, wallet.playerId, {
        amount: '500.00',
      });
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: JSON.stringify(rejectEnvelope),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const rejectMsg = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(rejectMsg, 'Reject message must be received');
      await consumer.processMessage(rejectMsg, queues.sourceUrl, queues.dlqUrl);

      const txRows: Array<{ status: string }> = await appDb()
        .em.getConnection()
        .execute('select status from wager_transactions where idempotency_key = ?', [
          rejectEnvelope.data.idempotencyKey,
        ]);
      expect(txRows[0]?.status).toBe('REJECTED');

      // 2. Pending reference: REFUND for missing external transaction.
      const pendingEnvelope = buildEnvelope(wallet.id, wallet.playerId, {
        kind: 'REFUND',
        amount: '10.00',
        referenceExternalTransactionId: randomUUID(),
      });
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: JSON.stringify(pendingEnvelope),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const pendingMsg = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(pendingMsg, 'Pending message must be received');
      await consumer.processMessage(pendingMsg, queues.sourceUrl, queues.dlqUrl);

      const pendingTxRows: Array<{ status: string }> = await appDb()
        .em.getConnection()
        .execute('select status from wager_transactions where idempotency_key = ?', [
          pendingEnvelope.data.idempotencyKey,
        ]);
      expect(pendingTxRows[0]?.status).toBe('PENDING_REFERENCE');

      // Both acknowledged and absent from DLQ.
      const sourceRemaining = await receiveOne(sqs, queues.sourceUrl, 0);
      expect(sourceRemaining).toBeUndefined();
      const dlqRemaining = await receiveOne(sqs, queues.dlqUrl, 0);
      expect(dlqRemaining).toBeUndefined();
    } finally {
      consumerSqs.destroy();
      await cleanupTestQueues(sqs, queues);
    }
  });

  test('routes malformed JSON, invalid type, and OPENING envelopes to DLQ and deletes from source', async () => {
    const queues = await createTestQueues(sqs);
    const consumerSqs = createQueueClient(environment);
    try {
      const consumer = new CommandConsumer(
        consumerSqs,
        financialUseCase,
        makeSettings(queues),
      );

      const invalidBodies = [
        '{ bad json syntax: true',
        JSON.stringify({
          messageId: randomUUID(),
          type: 'WrongType',
          occurredAt: new Date().toISOString(),
          data: {},
        }),
        JSON.stringify({
          messageId: randomUUID(),
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            kind: 'OPENING',
            walletId: randomUUID(),
            playerId: randomUUID(),
            money: { amount: '10.00', currency: 'USD' },
          },
        }),
      ];

      for (const body of invalidBodies) {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: queues.sourceUrl,
            MessageBody: body,
            MessageGroupId: 'validation-test',
            MessageDeduplicationId: randomUUID(),
          }),
        );
        const msg = await receiveOne(sqs, queues.sourceUrl);
        assert.ok(msg, 'Invalid message must be received');
        await consumer.processMessage(msg, queues.sourceUrl, queues.dlqUrl);

        const dlqMsg = await receiveOne(sqs, queues.dlqUrl);
        assert.ok(dlqMsg, 'DLQ message must be received');
        assert.ok(dlqMsg.ReceiptHandle, 'DLQ receipt handle must be present');
        expect(dlqMsg.Body).toBe(body);
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: queues.dlqUrl,
            ReceiptHandle: dlqMsg.ReceiptHandle,
          }),
        );
      }

      const sourceRemaining = await receiveOne(sqs, queues.sourceUrl, 0);
      expect(sourceRemaining).toBeUndefined();
    } finally {
      consumerSqs.destroy();
      await cleanupTestQueues(sqs, queues);
    }
  });

  test('retains source message when DLQ dispatch fails', async () => {
    const queues = await createTestQueues(sqs);
    const failingDlqClient = createQueueClient(environment);
    try {
      const badBody = '{ malformed json content';
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: badBody,
          MessageGroupId: 'dlq-failure-test',
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const msg = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(msg, 'Message must be received');
      assert.ok(msg.ReceiptHandle, 'ReceiptHandle must be present');

      const originalSend = failingDlqClient.send.bind(failingDlqClient);
      failingDlqClient.send = (async (
        command: Parameters<SQSClient['send']>[0],
        options?: Parameters<SQSClient['send']>[1],
      ) => {
        if (
          command instanceof SendMessageCommand &&
          command.input.QueueUrl === queues.dlqUrl
        ) {
          throw new Error('Simulated DLQ broker outage');
        }
        return originalSend(command, options);
      }) as SQSClient['send'];

      const consumer = new CommandConsumer(
        failingDlqClient,
        financialUseCase,
        makeSettings(queues),
      );
      await consumer.processMessage(msg, queues.sourceUrl, queues.dlqUrl);

      // Verify message was not deleted from source queue before retry.
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queues.sourceUrl,
          ReceiptHandle: msg.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
      const retriedMsg = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(retriedMsg, 'Retried message must be received');
      assert.ok(retriedMsg.ReceiptHandle, 'Retried receipt handle must be present');
      expect(retriedMsg.Body).toBe(badBody);

      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: queues.sourceUrl,
          ReceiptHandle: retriedMsg.ReceiptHandle,
        }),
      );
    } finally {
      failingDlqClient.destroy();
      await cleanupTestQueues(sqs, queues);
    }
  });

  test('redelivers and replays when message deletion fails after successful database commit', async () => {
    const queues = await createTestQueues(sqs);
    const failingDeleteClient = createQueueClient(environment);
    const consumerNormal = createQueueClient(environment);
    try {
      const wallet = await walletUseCase.createWallet({
        playerId: randomUUID(),
        initialBalance: { amount: '100.00', currency: 'USD' },
      });
      const envelope = buildEnvelope(wallet.id, wallet.playerId, { amount: '15.00' });
      const rawBody = JSON.stringify(envelope);

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: rawBody,
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const msg = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(msg, 'Message must be received');
      assert.ok(msg.ReceiptHandle, 'Receipt handle must be present');

      let deleteFailed = false;
      const originalSend = failingDeleteClient.send.bind(failingDeleteClient);
      failingDeleteClient.send = (async (
        command: Parameters<SQSClient['send']>[0],
        options?: Parameters<SQSClient['send']>[1],
      ) => {
        if (command instanceof DeleteMessageCommand && !deleteFailed) {
          deleteFailed = true;
          throw new Error('Simulated broker acknowledgement drop');
        }
        return originalSend(command, options);
      }) as SQSClient['send'];

      const consumer1 = new CommandConsumer(
        failingDeleteClient,
        financialUseCase,
        makeSettings(queues),
      );
      await consumer1.processMessage(msg, queues.sourceUrl, queues.dlqUrl);
      expect(deleteFailed).toBe(true);

      // Verify message is retained in source queue prior to redelivery.
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queues.sourceUrl,
          ReceiptHandle: msg.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
      const redelivered = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(redelivered, 'Redelivered message must be received');

      // Normal consumer replays and deletes cleanly.
      const consumer2 = new CommandConsumer(
        consumerNormal,
        financialUseCase,
        makeSettings(queues),
      );
      await consumer2.processMessage(redelivered, queues.sourceUrl, queues.dlqUrl);

      const currentWallet = await walletUseCase.getWallet(wallet.id);
      expect(currentWallet.balance.amount).toBe('85.00');

      const sourceRemaining = await receiveOne(sqs, queues.sourceUrl, 0);
      expect(sourceRemaining).toBeUndefined();
    } finally {
      failingDeleteClient.destroy();
      consumerNormal.destroy();
      await cleanupTestQueues(sqs, queues);
    }
  });

  test('retains source upon unknown post-commit error and succeeds on idempotent retry', async () => {
    const queues = await createTestQueues(sqs);
    const consumerSqs = createQueueClient(environment);
    try {
      const wallet = await walletUseCase.createWallet({
        playerId: randomUUID(),
        initialBalance: { amount: '100.00', currency: 'USD' },
      });
      const envelope = buildEnvelope(wallet.id, wallet.playerId, { amount: '22.00' });

      let throwPostCommit = true;
      const interceptedFinancial = new Proxy(financialUseCase, {
        get(target, prop, receiver): unknown {
          if (prop === 'executeCommand') {
            return async (...args: unknown[]) => {
              const targetMethod = Reflect.get(
                target,
                prop,
                receiver,
              ) as ExecuteCommandFn;
              const result: FinancialResult = await targetMethod.apply(target, args);
              if (throwPostCommit) {
                throwPostCommit = false;
                throw new Error('Transient network blip following commit');
              }
              return result;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const consumer = new CommandConsumer(
        consumerSqs,
        interceptedFinancial,
        makeSettings(queues),
      );

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: JSON.stringify(envelope),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const msg = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(msg, 'Message must be received');
      assert.ok(msg.ReceiptHandle, 'Receipt handle must be present');

      // First attempt fails after commit.
      await consumer.processMessage(msg, queues.sourceUrl, queues.dlqUrl);

      // Verify message retained on source queue.
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queues.sourceUrl,
          ReceiptHandle: msg.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
      const redelivered = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(redelivered, 'Redelivered message must be received');
      await consumer.processMessage(redelivered, queues.sourceUrl, queues.dlqUrl);

      // Balance deducted exactly once: 100 - 22 = 78.
      const currentWallet = await walletUseCase.getWallet(wallet.id);
      expect(currentWallet.balance.amount).toBe('78.00');

      const sourceRemaining = await receiveOne(sqs, queues.sourceUrl, 0);
      expect(sourceRemaining).toBeUndefined();
    } finally {
      consumerSqs.destroy();
      await cleanupTestQueues(sqs, queues);
    }
  });

  test('retains message during transient database failure and recovers once available', async () => {
    const queues = await createTestQueues(sqs);
    const consumerSqs = createQueueClient(environment);
    try {
      const wallet = await walletUseCase.createWallet({
        playerId: randomUUID(),
        initialBalance: { amount: '100.00', currency: 'USD' },
      });
      const envelope = buildEnvelope(wallet.id, wallet.playerId, { amount: '18.00' });

      let transientFail = true;
      const interceptedFinancial = new Proxy(financialUseCase, {
        get(target, prop, receiver): unknown {
          if (prop === 'executeCommand') {
            return async (...args: unknown[]) => {
              if (transientFail) {
                transientFail = false;
                throw new ApplicationError({
                  category: 'DatabaseOperationError',
                  code: 'DATABASE_QUERY_FAILED',
                  message: 'Temporary connection disconnect',
                  publicMessage: 'Database connection lost',
                });
              }
              const targetMethod = Reflect.get(
                target,
                prop,
                receiver,
              ) as ExecuteCommandFn;
              const result: FinancialResult = await targetMethod.apply(target, args);
              return result;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const consumer = new CommandConsumer(
        consumerSqs,
        interceptedFinancial,
        makeSettings(queues),
      );

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: JSON.stringify(envelope),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const msg = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(msg, 'Message must be received');
      assert.ok(msg.ReceiptHandle, 'Receipt handle must be present');

      await consumer.processMessage(msg, queues.sourceUrl, queues.dlqUrl);

      // Not sent to DLQ on transient failure.
      const dlqCheck = await receiveOne(sqs, queues.dlqUrl, 0);
      expect(dlqCheck).toBeUndefined();

      // Reset visibility to simulate retry after DB recovery.
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queues.sourceUrl,
          ReceiptHandle: msg.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      );
      const retryMsg = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(retryMsg, 'Retry message must be received');
      await consumer.processMessage(retryMsg, queues.sourceUrl, queues.dlqUrl);

      const currentWallet = await walletUseCase.getWallet(wallet.id);
      expect(currentWallet.balance.amount).toBe('82.00');
    } finally {
      consumerSqs.destroy();
      await cleanupTestQueues(sqs, queues);
    }
  });

  test('renews visibility with actual broker when execution time exceeds initial visibility', async () => {
    const queues = await createTestQueues(sqs, { visibilitySec: 3 });
    const consumerSqs = createQueueClient(environment);
    const contenderClient = createQueueClient(environment);
    let processing: Promise<void> | undefined;
    const { promise: executionGate, resolve: releaseExecution } =
      Promise.withResolvers<undefined>();
    try {
      const wallet = await walletUseCase.createWallet({
        playerId: randomUUID(),
        initialBalance: { amount: '100.00', currency: 'USD' },
      });
      const envelope = buildEnvelope(wallet.id, wallet.playerId, { amount: '12.00' });

      // Initial visibility is 3 seconds; lease renews every 600ms with 1s broker deadline.
      const renewalSettings = makeSettings(queues, {
        COMMAND_VISIBILITY_SEC: 3,
        COMMAND_RENEW_MS: 600,
        COMMAND_BROKER_TIMEOUT_MS: 1000,
      });

      const delayedFinancial = new Proxy(financialUseCase, {
        get(target, prop, receiver): unknown {
          if (prop === 'executeCommand') {
            return async (...args: unknown[]) => {
              // Hold execution until the independent receive probes an expired initial lease.
              await executionGate;
              const targetMethod = Reflect.get(
                target,
                prop,
                receiver,
              ) as ExecuteCommandFn;
              const result: FinancialResult = await targetMethod.apply(target, args);
              return result;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const consumer = new CommandConsumer(
        consumerSqs,
        delayedFinancial,
        renewalSettings,
      );

      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: JSON.stringify(envelope),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );
      const msg = await receiveOne(sqs, queues.sourceUrl);
      assert.ok(msg, 'Message must be received');

      processing = consumer.processMessage(msg, queues.sourceUrl, queues.dlqUrl);

      // At 3100ms (past initial visibility), independent contender attempts receive.
      await delay(3100);
      const contenderReceive = await contenderClient.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.sourceUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 0,
        }),
      );
      expect(contenderReceive.Messages ?? []).toEqual([]);
      releaseExecution(undefined);

      await processing;

      const sourceRemaining = await receiveOne(sqs, queues.sourceUrl, 0);
      expect(sourceRemaining).toBeUndefined();
    } finally {
      releaseExecution(undefined);
      if (processing !== undefined) await processing;
      consumerSqs.destroy();
      contenderClient.destroy();
      await cleanupTestQueues(sqs, queues);
    }
  }, 15000);

  test('broker redrive policy moves message to DLQ after exceeding maxReceiveCount', async () => {
    const queues = await createTestQueues(sqs, { visibilitySec: 1, maxReceiveCount: 2 });
    try {
      const body = JSON.stringify({ test: 'redrive-trigger', id: randomUUID() });
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: body,
          MessageGroupId: 'group-redrive',
          MessageDeduplicationId: randomUUID(),
        }),
      );

      // Attempt 1
      const receive1 = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.sourceUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
        }),
      );
      expect(receive1.Messages?.length).toBe(1);
      // Wait for visibility (1 sec) to expire.
      await delay(1200);

      // Attempt 2 (reaches maxReceiveCount 2)
      const receive2 = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.sourceUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
        }),
      );
      expect(receive2.Messages?.length).toBe(1);
      await delay(1200);

      // SQS broker redrives message to DLQ upon receive attempt 3.
      const receive3 = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.sourceUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
        }),
      );
      expect(receive3.Messages ?? []).toEqual([]);

      const dlqReceived = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queues.dlqUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
        }),
      );
      expect(dlqReceived.Messages?.length).toBe(1);
      const firstDlqMessage = dlqReceived.Messages?.[0];
      assert.ok(firstDlqMessage, 'DLQ message must be present');
      expect(firstDlqMessage.Body).toBe(body);
    } finally {
      await cleanupTestQueues(sqs, queues);
    }
  });

  test('graceful stop aborts idle polling and drains admitted message', async () => {
    const queues = await createTestQueues(sqs, { visibilitySec: 5 });
    const consumerSqs = createQueueClient(environment);
    let consumer: CommandConsumer | undefined;
    try {
      const wallet = await walletUseCase.createWallet({
        playerId: randomUUID(),
        initialBalance: { amount: '100.00', currency: 'USD' },
      });
      const envelope = buildEnvelope(wallet.id, wallet.playerId, { amount: '14.00' });

      const { promise: startedPromise, resolve: resolveStarted } =
        Promise.withResolvers<undefined>();
      const { promise: finishedPromise, resolve: resolveFinished } =
        Promise.withResolvers<undefined>();

      const delayedFinancial = new Proxy(financialUseCase, {
        get(target, prop, receiver): unknown {
          if (prop === 'executeCommand') {
            return async (...args: unknown[]) => {
              resolveStarted(undefined);
              await delay(300);
              const targetMethod = Reflect.get(
                target,
                prop,
                receiver,
              ) as ExecuteCommandFn;
              const res: FinancialResult = await targetMethod.apply(target, args);
              resolveFinished(undefined);
              return res;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      consumer = new CommandConsumer(
        consumerSqs,
        delayedFinancial,
        makeSettings(queues, {
          COMMAND_CONSUMER_ENABLED: true,
          COMMAND_LONG_POLL_SEC: 2,
        }),
      );

      // Start background loop.
      consumer.start();

      // Send command into queue for worker to admit.
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.sourceUrl,
          MessageBody: JSON.stringify(envelope),
          MessageGroupId: wallet.id,
          MessageDeduplicationId: randomUUID(),
        }),
      );

      // Await worker admittance deterministically via Promise.withResolvers.
      await startedPromise;

      // Stop consumer while message is in flight.
      await consumer.stop();

      // Admitted financial work completed and was not abandoned.
      await finishedPromise;

      const currentWallet = await walletUseCase.getWallet(wallet.id);
      expect(currentWallet.balance.amount).toBe('86.00');

      // Message acknowledged and removed from queue.
      const sourceRemaining = await receiveOne(sqs, queues.sourceUrl, 0);
      expect(sourceRemaining).toBeUndefined();
    } finally {
      await consumer?.stop();
      consumerSqs.destroy();
      await cleanupTestQueues(sqs, queues);
    }
  });
});
