import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { createDatabaseOptions } from '../src/core/database/database.config.js';
import { EventObserver } from '../tests/helpers/event-observer.js';
import { installTestEnvironment, testTargets } from './test-environment.js';

// Guard every target before connecting, writing fixtures, or controlling processes.
installTestEnvironment();
const gateway = testTargets.API_URL;
const orm = await MikroORM.init(
  createDatabaseOptions(testTargets.DATABASE_URL, {
    DB_STATEMENT_TIMEOUT_MS: 10000,
    OPERATION_TIMEOUT_MS: 20000,
  }),
);
const sql = orm.em.getConnection();
const sqs = new SQSClient({
  endpoint: testTargets.SQS_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  maxAttempts: 1,
});
const services = ['app-1', 'app-2', 'app-3'];
const walletSchema = z.object({ id: z.uuid(), playerId: z.uuid() });
const resultSchema = z.object({
  transactionId: z.uuid(),
  status: z.string(),
  idempotentReplay: z.boolean(),
  balance: z.object({ amount: z.string() }),
});
const reconciliationSchema = z.object({
  consistent: z.boolean(),
  difference: z.object({ amount: z.string() }),
  storedBalance: z.object({ amount: z.string() }),
  calculatedBalance: z.object({ amount: z.string() }),
  checkedEntries: z.number(),
});
const fixture = `recovery_sleep_${randomUUID().replaceAll('-', '')}`;
const fixtures = new Map<string, string>();
const pausedServices = new Set<string>();
let failure: { error: unknown } | undefined;
function captureCleanupFailure(error: unknown): void {
  if (failure === undefined) failure = { error };
  else console.error('Recovery cleanup failed:', error);
}
function compose(...args: string[]): string {
  return execFileSync(
    'docker',
    [
      'compose',
      '--env-file',
      'docker/test.env',
      '-p',
      testTargets.COMPOSE_PROJECT_NAME,
      '-f',
      'compose.services.yaml',
      '-f',
      'compose.apps.yaml',
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout: 120000,
    },
  );
}
async function api(path: string, body?: unknown, key?: string) {
  const response = await fetch(gateway + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key, 'x-correlation-id': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  const data: unknown = await response.json();
  return { status: response.status, data };
}
async function until(check: () => Promise<boolean>, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    assert(Date.now() < deadline, 'Recovery observation deadline exceeded.');
    await delay(20);
  }
}
async function ready(): Promise<void> {
  await until(async () => {
    const statuses = await Promise.all(
      [3101, 3102, 3103].map(async (port) => {
        try {
          return (
            await fetch(`http://127.0.0.1:${String(port)}/health/ready`, {
              signal: AbortSignal.timeout(3000),
            })
          ).status;
        } catch {
          return 0;
        }
      }),
    );
    return statuses.every((status) => status === 200);
  });
  await until(async () => {
    try {
      return (await api('/health/ready')).status === 200;
    } catch {
      return false;
    }
  });
}
function evidence(scenario: string, details: Record<string, unknown>) {
  console.log(JSON.stringify({ scenario, ...details }));
}
try {
  await ready();
  const created = await api('/wallets', {
    playerId: randomUUID(),
    initialBalance: { amount: '100.00', currency: 'USD' },
  });
  assert.equal(created.status, 201);
  const wallet = walletSchema.parse(created.data);
  function bet(amount: string) {
    return {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'recovery-round',
      gameId: 'recovery-game',
      kind: 'BET',
      money: { amount, currency: 'USD' },
    };
  }
  const baseline = await api('/wagering/transactions', bet('10.00'), randomUUID());
  assert.equal(baseline.status, 200);
  assert.equal(resultSchema.parse(baseline.data).balance.amount, '90.00');
  const queue = await sqs.send(
    new GetQueueUrlCommand({ QueueName: process.env.EVENT_QUEUE ?? 'wager-events.fifo' }),
  );
  assert(queue.QueueUrl);
  const queueUrl = queue.QueueUrl;
  const observer = new EventObserver(sqs, queueUrl);
  await observer.receiveUntil(
    (events) => events.filter((event) => event.aggregateId === wallet.id).length === 4,
    120000,
  );

  const outagePayload = bet('10.00');
  const outageKey = randomUUID();
  compose('stop', 'postgres');
  const unavailable = await api('/wagering/transactions', outagePayload, outageKey);
  assert.equal(unavailable.status, 503);
  assert.equal((await api('/health/live')).status, 200);
  assert.equal((await api('/health/ready')).status, 503);
  compose('start', 'postgres');
  await ready();
  const recovered = await api('/wagering/transactions', outagePayload, outageKey);
  assert.equal(recovered.status, 200);
  const durable = resultSchema.parse(recovered.data);
  assert.equal(durable.balance.amount, '80.00');
  assert.deepEqual(
    resultSchema.parse(
      (await api('/wagering/transactions', outagePayload, outageKey)).data,
    ),
    { ...durable, idempotentReplay: true },
  );
  evidence('postgres_outage', {
    failureStatus: 503,
    originalIdentityReplay: true,
    balance: '80.00',
  });

  compose('stop', 'localstack');
  const brokerPayload = bet('5.00');
  const brokerResult = await api('/wagering/transactions', brokerPayload, randomUUID());
  assert.equal(brokerResult.status, 200);
  const brokerTransaction = resultSchema.parse(brokerResult.data);
  assert.equal(brokerTransaction.balance.amount, '75.00');
  const brokerRowsSchema = z.array(z.object({ id: z.uuid(), published: z.boolean() }));
  const unpublished = brokerRowsSchema.parse(
    await sql.execute(
      "SELECT id, published_at IS NOT NULL AS published FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?",
      [brokerTransaction.transactionId],
    ),
  );
  assert.equal(unpublished.length, 2);
  assert(unpublished.every((row) => !row.published));
  compose('start', 'localstack');
  await ready();
  await observer.receiveUntil(
    (events) =>
      unpublished.every((row) => events.some((event) => event.eventId === row.id)),
    120000,
  );
  await until(async () => {
    const rows = brokerRowsSchema.parse(
      await sql.execute(
        "SELECT id, published_at IS NOT NULL AS published FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?",
        [brokerTransaction.transactionId],
      ),
    );
    return rows.every((row) => row.published);
  });
  evidence('broker_outage', {
    committedBalance: '75.00',
    receivedOriginalEventIds: unpublished.map((row) => row.id),
  });

  // An owned-wallet SQL fault gives a visible in-flight boundary without production hooks.
  await sql.execute(
    `CREATE FUNCTION ${fixture}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.8); RETURN NEW; END $$`,
  );
  fixtures.set(fixture, 'wallets');
  await sql.execute(
    `CREATE TRIGGER ${fixture} BEFORE UPDATE ON wallets FOR EACH ROW WHEN (NEW.id = '${wallet.id}') EXECUTE FUNCTION ${fixture}()`,
  );
  const instanceByAddress = new Map<string, { service: string; port: number }>();
  function refreshInstances(): void {
    instanceByAddress.clear();
    for (const [index, service] of services.entries()) {
      const id = compose('ps', '-q', service).trim();
      const address = execFileSync(
        'docker',
        ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', id],
        { encoding: 'utf8' },
      ).trim();
      instanceByAddress.set(address, { service, port: 3101 + index });
    }
  }
  refreshInstances();
  async function sleepingInstance(
    queryFragment = 'UPDATE wallets SET',
    timeoutMs = 10000,
  ) {
    let found: { service: string; port: number } | undefined;
    await until(async () => {
      const rows = z
        .array(z.object({ address: z.string() }))
        .parse(
          (await sql.execute(
            "SELECT host(client_addr) AS address FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query ILIKE ?",
            [`%${queryFragment}%`],
          )) as unknown,
        );
      for (const row of rows) {
        const instance = instanceByAddress.get(row.address);
        assert(
          instance,
          `Sleeping backend ${row.address} must belong to a Compose application.`,
        );
        found = instance;
      }
      return found !== undefined;
    }, timeoutMs);
    assert(found);
    return found;
  }
  const crashPayload = bet('7.00');
  const crashKey = randomUUID();
  const crashRequest = api('/wagering/transactions', crashPayload, crashKey).catch(
    () => undefined,
  );
  await sleepingInstance();
  compose('kill', '-s', 'SIGKILL', ...services);
  await crashRequest;
  await until(
    () =>
      Promise.resolve(
        compose('ps', '--status', 'running', '-q', ...services).trim() === '',
      ),
    10000,
  );
  const state = z
    .array(z.object({ balance: z.string() }))
    .parse(
      await sql.execute('SELECT balance::text FROM wallets WHERE id = ?', [wallet.id]),
    );
  assert.equal(state[0]?.balance, '75.00');
  compose('up', '-d', '--no-deps', ...services);
  await ready();
  const crashReplay = await api('/wagering/transactions', crashPayload, crashKey);
  assert.equal(crashReplay.status, 200);
  const crashSettled = resultSchema.parse(crashReplay.data);
  assert.equal(crashSettled.balance.amount, '68.00');
  assert.deepEqual(
    resultSchema.parse(
      (await api('/wagering/transactions', crashPayload, crashKey)).data,
    ),
    { ...crashSettled, idempotentReplay: true },
  );
  evidence('sigkill_before_commit', {
    instances: 3,
    balanceBeforeReplay: '75.00',
    balanceAfterReplay: '68.00',
    effects: 1,
  });

  refreshInstances();
  const gracefulPayload = bet('3.00');
  const gracefulKey = randomUUID();
  const gracefulRequest = api('/wagering/transactions', gracefulPayload, gracefulKey);
  const owner = await sleepingInstance();
  compose('kill', '-s', 'SIGTERM', owner.service);
  const diagnostic = `http://127.0.0.1:${String(owner.port)}`;
  await until(async () => {
    try {
      return (
        (await fetch(diagnostic + '/health/ready', { signal: AbortSignal.timeout(1000) }))
          .status === 503
      );
    } catch {
      return false;
    }
  }, 5000);
  assert.equal((await fetch(diagnostic + '/health/live?probe=1')).status, 200);
  const drained = await gracefulRequest;
  assert.equal(drained.status, 200);
  const committed = resultSchema.parse(drained.data);
  assert.equal(committed.balance.amount, '65.00');
  await until(
    () =>
      Promise.resolve(
        compose('ps', '--status', 'running', '-q', owner.service).trim() === '',
      ),
    10000,
  );
  compose('up', '-d', '--no-deps', owner.service);
  await ready();
  assert.deepEqual(
    resultSchema.parse(
      (await api('/wagering/transactions', gracefulPayload, gracefulKey)).data,
    ),
    { ...committed, idempotentReplay: true },
  );
  evidence('sigterm_drain', {
    instance: owner.service,
    readinessStatus: 503,
    livenessWithQueryStatus: 200,
    admittedResult: 'PROCESSED',
    balance: '65.00',
  });
  await sql.execute(`DROP TRIGGER ${fixture} ON wallets`);
  await sql.execute(`DROP FUNCTION ${fixture}()`);
  fixtures.delete(fixture);

  const duplicateClient = new SQSClient({
    endpoint: testTargets.SQS_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  });
  let firstReceipt = true;
  duplicateClient.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName === 'DeleteMessageCommand' && firstReceipt) {
        firstReceipt = false;
        const command = args.input as DeleteMessageCommand['input'];
        await sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: command.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        );
        throw new Error('Observer acknowledgment lost');
      }
      return next(args);
    },
    { step: 'initialize', name: 'loseAcknowledgment' },
  );
  try {
    const duplicateObserver = new EventObserver(duplicateClient, queueUrl);
    await assert.rejects(
      duplicateObserver.receiveUntil(() => false, 30000),
      /Observer acknowledgment lost/,
    );
    await duplicateObserver.receiveUntil(() => duplicateObserver.duplicates > 0, 30000);
    evidence('event_redelivery', {
      duplicateDeliveries: duplicateObserver.duplicates,
      consistentEventIdentity: true,
    });
  } finally {
    duplicateClient.destroy();
  }

  // Freeze the consumer while PostgreSQL finishes COMMIT; it cannot send an ack.
  const ackWallet = walletSchema.parse(
    (
      await api('/wallets', {
        playerId: randomUUID(),
        initialBalance: { amount: '100.00', currency: 'USD' },
      })
    ).data,
  );
  await observer.receiveUntil(
    (events) => events.filter((event) => event.aggregateId === ackWallet.id).length === 2,
    60000,
  );
  const ackMessageId = randomUUID();
  const ackKey = randomUUID();
  const ackPayload = {
    ...bet('5.00'),
    playerId: ackWallet.playerId,
    walletId: ackWallet.id,
  };
  const ackFixture = `${fixture}_ack`;
  await sql.execute(
    `CREATE FUNCTION ${ackFixture}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.8); RETURN NEW; END $$`,
  );
  fixtures.set(ackFixture, 'inbox_messages');
  await sql.execute(
    `CREATE CONSTRAINT TRIGGER ${ackFixture} AFTER INSERT ON inbox_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.message_id = '${ackMessageId}') EXECUTE FUNCTION ${ackFixture}()`,
  );
  const source = await sqs.send(
    new GetQueueUrlCommand({
      QueueName: process.env.COMMAND_SOURCE_QUEUE ?? 'wager-transactions.fifo',
    }),
  );
  assert(source.QueueUrl);
  refreshInstances();
  const ackStarted = new Date().toISOString();
  const [dispatch, ownership] = await Promise.allSettled([
    sqs.send(
      new SendMessageCommand({
        QueueUrl: source.QueueUrl,
        MessageGroupId: ackWallet.id,
        MessageDeduplicationId: ackMessageId,
        MessageBody: JSON.stringify({
          messageId: ackMessageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: { ...ackPayload, idempotencyKey: ackKey },
        }),
      }),
    ),
    // Queue dispatch can span the configured twenty-second long poll.
    sleepingInstance('COMMIT', 60000).then((owner) => {
      compose('pause', owner.service);
      pausedServices.add(owner.service);
      return owner;
    }),
  ]);
  if (dispatch.status === 'rejected') throw dispatch.reason;
  if (ownership.status === 'rejected') throw ownership.reason;
  const ackOwner = ownership.value;
  await until(async () => {
    const rows = z
      .array(z.object({ processed: z.boolean() }))
      .parse(
        await sql.execute(
          'SELECT processed_at IS NOT NULL AS processed FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
          [process.env.COMMAND_CONSUMER_NAME ?? 'wager-commands', ackMessageId],
        ),
      );
    return rows[0]?.processed === true;
  }, 5000);
  compose('kill', '-s', 'SIGKILL', ackOwner.service);
  pausedServices.delete(ackOwner.service);
  await until(
    () =>
      Promise.resolve(
        compose('ps', '--status', 'running', '-q', ackOwner.service).trim() === '',
      ),
    10000,
  );
  compose('up', '-d', '--no-deps', ackOwner.service);
  await ready();
  const replayLogSchema = z.object({
    message: z.object({
      event: z.literal('financial_result'),
      correlationId: z.uuid(),
      status: z.literal('PROCESSED'),
      replay: z.literal(true),
    }),
  });
  await until(async () => {
    await delay(500);
    const logs = compose(
      'logs',
      '--no-color',
      '--no-log-prefix',
      '--since',
      ackStarted,
      ...services,
    );
    return logs.split('\n').some((line) => {
      try {
        const parsed = replayLogSchema.safeParse(JSON.parse(line) as unknown);
        return parsed.success && parsed.data.message.correlationId === ackMessageId;
      } catch {
        return false;
      }
    });
  }, 90000);
  const ackReplay = resultSchema.parse(
    (await api('/wagering/transactions', ackPayload, ackKey)).data,
  );
  assert.equal(ackReplay.idempotentReplay, true);
  assert.equal(ackReplay.balance.amount, '95.00');
  const ackReconciliation = reconciliationSchema.parse(
    (await api(`/wallets/${ackWallet.id}/reconciliation`, {})).data,
  );
  assert.equal(ackReconciliation.consistent, true);
  assert.equal(ackReconciliation.calculatedBalance.amount, '95.00');
  assert.equal(ackReconciliation.checkedEntries, 2);
  evidence('sigkill_after_command_commit_before_ack', {
    instance: ackOwner.service,
    workerReplayObserved: true,
    storedBalance: '95.00',
    ledgerBalance: '95.00',
    entries: 2,
    effects: 1,
  });
  await sql.execute(`DROP TRIGGER ${ackFixture} ON inbox_messages`);
  await sql.execute(`DROP FUNCTION ${ackFixture}()`);
  fixtures.delete(ackFixture);

  // A publication update starts only after the real broker confirms the send.
  const publicationWallet = walletSchema.parse(
    (
      await api('/wallets', {
        playerId: randomUUID(),
        initialBalance: { amount: '100.00', currency: 'USD' },
      })
    ).data,
  );
  await observer.receiveUntil(
    (events) =>
      events.filter((event) => event.aggregateId === publicationWallet.id).length === 2,
    60000,
  );
  const publicationFixture = `${fixture}_publish`;
  await sql.execute(
    `CREATE FUNCTION ${publicationFixture}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.8); RETURN NEW; END $$`,
  );
  fixtures.set(publicationFixture, 'outbox_messages');
  await sql.execute(
    `CREATE TRIGGER ${publicationFixture} BEFORE UPDATE ON outbox_messages FOR EACH ROW WHEN (NEW.aggregate_id = '${publicationWallet.id}' AND OLD.published_at IS NULL AND NEW.published_at IS NOT NULL) EXECUTE FUNCTION ${publicationFixture}()`,
  );
  refreshInstances();
  const publicationKey = randomUUID();
  const publicationPayload = {
    ...bet('2.00'),
    playerId: publicationWallet.playerId,
    walletId: publicationWallet.id,
  };
  const publicationResult = resultSchema.parse(
    (await api('/wagering/transactions', publicationPayload, publicationKey)).data,
  );
  assert.equal(publicationResult.balance.amount, '98.00');
  await sleepingInstance('UPDATE outbox_messages SET published_at');
  compose('kill', '-s', 'SIGKILL', ...services);
  await until(
    () =>
      Promise.resolve(
        compose('ps', '--status', 'running', '-q', ...services).trim() === '',
      ),
    10000,
  );
  async function publicationRows() {
    return brokerRowsSchema.parse(
      await sql.execute(
        "SELECT id, published_at IS NOT NULL AS published FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?",
        [publicationResult.transactionId],
      ),
    );
  }
  const interruptedPublication = await publicationRows();
  assert.equal(interruptedPublication.length, 2);
  assert(interruptedPublication.every((row) => !row.published));
  await observer.receiveUntil(
    (events) =>
      interruptedPublication.every((row) =>
        events.some((event) => event.eventId === row.id),
      ),
    60000,
  );
  await sql.execute(`DROP TRIGGER ${publicationFixture} ON outbox_messages`);
  await sql.execute(`DROP FUNCTION ${publicationFixture}()`);
  fixtures.delete(publicationFixture);
  compose('up', '-d', '--no-deps', ...services);
  await ready();
  await until(
    async () => (await publicationRows()).every((row) => row.published),
    120000,
  );
  assert.deepEqual(
    (await publicationRows()).map((row) => row.id).sort(),
    interruptedPublication.map((row) => row.id).sort(),
  );
  const publicationReplay = resultSchema.parse(
    (await api('/wagering/transactions', publicationPayload, publicationKey)).data,
  );
  assert.equal(publicationReplay.idempotentReplay, true);
  assert.equal(publicationReplay.balance.amount, '98.00');
  const publicationReconciliation = reconciliationSchema.parse(
    (await api(`/wallets/${publicationWallet.id}/reconciliation`, {})).data,
  );
  assert.equal(publicationReconciliation.consistent, true);
  assert.equal(publicationReconciliation.calculatedBalance.amount, '98.00');
  assert.equal(publicationReconciliation.checkedEntries, 2);
  evidence('sigkill_after_event_send_before_mark', {
    instances: 3,
    receivedOriginalEventIds: interruptedPublication.map((row) => row.id),
    recoveredPublication: true,
    storedBalance: '98.00',
    ledgerBalance: '98.00',
    entries: 2,
    effects: 1,
  });

  const reconciled = await api(`/wallets/${wallet.id}/reconciliation`, {});
  assert.equal(reconciled.status, 200);
  const snapshot = reconciliationSchema.parse(reconciled.data);
  assert.equal(snapshot.consistent, true);
  assert.equal(snapshot.difference.amount, '0.00');
  assert.equal(snapshot.storedBalance.amount, '65.00');
  assert.equal(snapshot.calculatedBalance.amount, '65.00');
  assert.equal(snapshot.checkedEntries, 6);
  const ledger = z
    .array(
      z.object({ amount: z.string(), direction: z.string(), wallet_version: z.string() }),
    )
    .parse(
      await sql.execute(
        'SELECT amount::text, direction, wallet_version::text FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY wallet_version',
        [wallet.id],
      ),
    );
  assert.deepEqual(ledger, [
    { amount: '100.00', direction: 'CREDIT', wallet_version: '1' },
    ...['10.00', '10.00', '5.00', '7.00', '3.00'].map((amount, index) => ({
      amount,
      direction: 'DEBIT',
      wallet_version: String(index + 2),
    })),
  ]);
  evidence('recovery_reconciliation', {
    storedBalance: '65.00',
    ledgerBalance: '65.00',
    entries: 6,
    consistent: true,
  });
} catch (error) {
  failure = { error };
} finally {
  try {
    for (const service of pausedServices) compose('unpause', service);
    compose('up', '-d', '--no-deps', 'postgres', 'localstack', ...services, 'nginx');
    await ready();
    for (const [name, table] of fixtures) {
      await sql.execute(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
      await sql.execute(`DROP FUNCTION IF EXISTS ${name}()`);
    }
  } catch (error) {
    captureCleanupFailure(error);
  } finally {
    sqs.destroy();
    try {
      await orm.close(true);
    } catch (error) {
      captureCleanupFailure(error);
    }
  }
}
if (failure !== undefined) throw failure.error;
