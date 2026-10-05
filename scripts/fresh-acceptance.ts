import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { EventObserver } from '../tests/helpers/event-observer.js';
import { installTestEnvironment } from './test-environment.js';

installTestEnvironment();

const directory = await mkdtemp(join(tmpdir(), 'jungle-fresh-'));
const project = `jungle-fresh-${randomUUID().slice(0, 8)}`;
const override = join(directory, 'ports.yaml');
const reservedPorts = new Set<number>();
async function freePort(): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address !== null && typeof address === 'object');
    const port = address.port;
    await new Promise<void>((resolve, reject) => {
      server.close((cause) => {
        if (cause) reject(cause);
        else resolve();
      });
    });
    if (!reservedPorts.has(port)) {
      reservedPorts.add(port);
      return port;
    }
  }
}
const ports = {
  postgres: await freePort(),
  localstack: await freePort(),
  nginx: await freePort(),
};
await writeFile(
  override,
  `services:\n  postgres:\n    ports: !override ["127.0.0.1:${String(ports.postgres)}:5432"]\n  localstack:\n    ports: !override ["127.0.0.1:${String(ports.localstack)}:4566"]\n  nginx:\n    ports: !override ["127.0.0.1:${String(ports.nginx)}:80"]\n  app-1:\n    ports: !override []\n  app-2:\n    ports: !override []\n  app-3:\n    ports: !override []\n`,
);
const compose = [
  'docker',
  'compose',
  '--env-file',
  'docker/test.env',
  '-p',
  project,
  '-f',
  'compose.services.yaml',
  '-f',
  'compose.apps.yaml',
  '-f',
  override,
];
async function docker(...args: string[]): Promise<string> {
  const process = Bun.spawn([...compose, ...args], { stdout: 'pipe', stderr: 'inherit' });
  const output = await new Response(process.stdout).text();
  assert.equal(await process.exited, 0, `Compose ${String(args[0])} failed.`);
  return output;
}
const baseUrl = `http://127.0.0.1:${String(ports.nginx)}`;
async function api(path: string, body?: unknown, key?: string): Promise<unknown> {
  const response = await fetch(baseUrl + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(
      `${path} returned HTTP ${String(response.status)}: ${await response.text()}`,
    );
  }
  const result: unknown = await response.json();
  return result;
}
const money = z.object({ amount: z.string(), currency: z.literal('BRL') });
const walletSchema = z.object({
  id: z.uuid(),
  playerId: z.uuid(),
  balance: money,
  version: z.string(),
});
const resultSchema = z.object({
  transactionId: z.uuid(),
  status: z.literal('PROCESSED'),
  balance: money,
  walletVersion: z.string(),
  idempotentReplay: z.boolean(),
});
const reconciliationSchema = z.object({
  storedBalance: money,
  calculatedBalance: money,
  difference: money,
  consistent: z.boolean(),
  checkedEntries: z.number(),
});
const sqlSchema = z.object({
  balance: z.string(),
  version: z.string(),
  entries: z.number(),
  events: z.array(z.uuid()),
  published: z.number(),
});
async function publishedSnapshot(walletId: string, eventCount: number) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const result = sqlSchema.parse(
      JSON.parse(
        await docker(
          'exec',
          '-T',
          'postgres',
          'psql',
          '-U',
          'jungle_main',
          '-d',
          'jungle_test',
          '-Atc',
          `SELECT json_build_object('balance', w.balance::text, 'version', w.version::text, 'entries', (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = w.id), 'events', (SELECT json_agg(id::text ORDER BY id) FROM outbox_messages WHERE aggregate_id = w.id::text), 'published', (SELECT count(*) FROM outbox_messages WHERE aggregate_id = w.id::text AND published_at IS NOT NULL)) FROM wallets w WHERE w.id = '${walletId}'`,
        ),
      ) as unknown,
    );
    if (result.published === eventCount) return result;
    assert(Date.now() < deadline, 'Fresh publication deadline exceeded.');
    await delay(100);
  }
}
let client: SQSClient | undefined;
try {
  await docker('up', '-d', '--wait', '--wait-timeout', '180');
  const playerId = randomUUID();
  const wallet = walletSchema.parse(
    await api('/wallets', {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    }),
  );
  const key = randomUUID();
  const bet = {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId,
    walletId: wallet.id,
    roundId: 'fresh-round',
    gameId: 'fresh-game',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
  const initial = resultSchema.parse(await api('/wagering/transactions', bet, key));
  assert.equal(initial.balance.amount, '75.00');
  assert.equal(initial.idempotentReplay, false);
  client = new SQSClient({
    endpoint: `http://127.0.0.1:${String(ports.localstack)}`,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  });
  const queue = await client.send(
    new GetQueueUrlCommand({ QueueName: 'wager-events.fifo' }),
  );
  assert(queue.QueueUrl);
  const observer = new EventObserver(client, queue.QueueUrl);
  // Keep the confirmed events in SQS; the observer must receive them after restart.
  const sqlBefore = await publishedSnapshot(wallet.id, 4);
  const idsBeforeRestart = sqlBefore.events;
  assert.deepEqual(sqlBefore, {
    balance: '75.00',
    version: '2',
    entries: 2,
    events: idsBeforeRestart,
    published: 4,
  });
  console.log(
    JSON.stringify({
      scenario: 'fresh_setup',
      instances: 3,
      balance: '75.00',
      ledgerEntries: 2,
      publishedEventsRetainedInBroker: 4,
    }),
  );

  // Leave a real command in the broker while every consumer is stopped.
  const retainedWin = {
    ...bet,
    externalTransactionId: randomUUID(),
    kind: 'WIN',
    money: { amount: '2.00', currency: 'BRL' },
  };
  const retainedKey = randomUUID();
  await docker('stop', 'app-1', 'app-2', 'app-3');
  const commandQueue = await client.send(
    new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }),
  );
  assert(commandQueue.QueueUrl);
  await client.send(
    new SendMessageCommand({
      QueueUrl: commandQueue.QueueUrl,
      MessageGroupId: wallet.id,
      MessageDeduplicationId: retainedKey,
      MessageBody: JSON.stringify({
        messageId: retainedKey,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...retainedWin, idempotencyKey: retainedKey },
      }),
    }),
  );
  await docker('stop');
  await docker('up', '-d', '--wait', '--wait-timeout', '180');
  // Nginx DNS can still contain the previous addresses for up to five seconds.
  await delay(6000);
  const replay = resultSchema.parse(await api('/wagering/transactions', bet, key));
  assert.deepEqual(replay, { ...initial, idempotentReplay: true });
  await observer.receiveUntil(
    (events) => events.filter((event) => event.aggregateId === wallet.id).length === 6,
    60000,
  );
  const retainedReplay = resultSchema.parse(
    await api('/wagering/transactions', retainedWin, retainedKey),
  );
  assert.equal(retainedReplay.idempotentReplay, true);
  assert.equal(retainedReplay.balance.amount, '77.00');
  const afterRestart = await publishedSnapshot(wallet.id, 6);
  assert.deepEqual(afterRestart, {
    balance: '77.00',
    version: '3',
    entries: 3,
    events: observer.events.map((event) => event.eventId).sort(),
    published: 6,
  });
  const win = {
    ...bet,
    externalTransactionId: randomUUID(),
    kind: 'WIN',
    money: { amount: '2.00', currency: 'BRL' },
  };
  const won = resultSchema.parse(await api('/wagering/transactions', win, randomUUID()));
  assert.equal(won.balance.amount, '79.00');
  await observer.receiveUntil(
    (events) => events.filter((event) => event.aggregateId === wallet.id).length === 8,
    60000,
  );
  const balanceHistory = observer.events
    .filter((event) => event.eventType === 'WalletBalanceChanged' && event.version === 2)
    .map((event) => ({
      version: event.data.walletVersion,
      before: event.data.balanceBefore.amount,
      after: event.data.balanceAfter.amount,
    }))
    .sort((left, right) => (BigInt(left.version) < BigInt(right.version) ? -1 : 1));
  assert.deepEqual(balanceHistory, [
    { version: '1', before: '0.00', after: '100.00' },
    { version: '2', before: '100.00', after: '75.00' },
    { version: '3', before: '75.00', after: '77.00' },
    { version: '4', before: '77.00', after: '79.00' },
  ]);
  const reconciled = reconciliationSchema.parse(
    await api(`/wallets/${wallet.id}/reconciliation`, {}),
  );
  assert.deepEqual(reconciled, {
    storedBalance: { amount: '79.00', currency: 'BRL' },
    calculatedBalance: { amount: '79.00', currency: 'BRL' },
    difference: { amount: '0.00', currency: 'BRL' },
    consistent: true,
    checkedEntries: 4,
  });
  console.log(
    JSON.stringify({
      scenario: 'preserved_restart',
      originalTransactionId: initial.transactionId,
      historicalReplayBalance: '75.00',
      finalBalance: '79.00',
      ledgerEntries: 4,
      receivedEvents: 8,
      retainedBrokerCommand: 'processed once after full restart',
      retainedBrokerEvents: idsBeforeRestart.length,
      consistent: true,
    }),
  );
} finally {
  client?.destroy();
  // This project and its volumes were created by this run. Never remove the user's test stack.
  try {
    await docker('down', '--volumes', '--remove-orphans');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
