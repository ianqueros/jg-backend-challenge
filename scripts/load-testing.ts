import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { quantileSorted } from 'simple-statistics';
import { z } from 'zod';
import { createDatabaseOptions } from '../src/core/database/database.config.js';
import { EventObserver, type ObservedEvent } from '../tests/helpers/event-observer.js';
import { installTestEnvironment } from './test-environment.js';

// Use a separate project so dependency failures cannot interrupt a shared stack.
installTestEnvironment();

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { 'metrics-json': { type: 'string' } },
});
const measuredAt = new Date().toISOString();

const directory = await mkdtemp(join(tmpdir(), 'jungle-load-'));
const project = `jungle-load-${randomUUID().slice(0, 8)}`;
const override = join(directory, 'compose.yaml');
const reservedPorts = new Set<number>();
const replicas = ['app-1', 'app-2', 'app-3'];
const conflictKinds = [
  'guarded_update',
  'serialization',
  'deadlock',
  'lock_timeout',
] as const;

const money = z.object({
  amount: z.string().regex(/^\d+\.\d{2}$/),
  currency: z.literal('BRL'),
});

const walletSchema = z.object({
  id: z.uuid(),
  playerId: z.uuid(),
  balance: money,
  version: z.string(),
});

const resultSchema = z.object({
  transactionId: z.uuid(),
  status: z.enum(['PROCESSED', 'REJECTED', 'FAILED', 'PENDING_REFERENCE']),
  balance: money.optional(),
  walletVersion: z.string().optional(),
  failureCode: z.string().optional(),
  idempotentReplay: z.boolean(),
});

const reconciliationSchema = z.object({
  consistent: z.boolean(),
  storedBalance: money,
  calculatedBalance: money,
  difference: money,
  checkedEntries: z.number().int(),
});

type Wallet = z.infer<typeof walletSchema>;
type Result = z.infer<typeof resultSchema>;

interface BetPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
}

interface Operation {
  key: string;
  payload: BetPayload;
  result?: Result;
  error?: string;
  startedDuringOutage?: boolean;
}

type ConflictCounts = Record<(typeof conflictKinds)[number], number>;
type AttemptKind = 'initial' | 'retry' | 'replay';

const outboxLagSchema = z.object({
  events: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  meanSeconds: z.number().nonnegative(),
  maxSeconds: z.number().nonnegative(),
});

interface Scenario {
  name: string;
  logical: number;
  started: number;
  deadline: number;
  operations: Operation[];
  attempts: number;
  initialAttempts: number;
  retries: number;
  replays: number;
  attemptTimeouts: number;
  attemptErrors: number;
  httpStarted: number | null;
  httpFinished: number | null;
  latencies: number[];
  httpResults: {
    key: string;
    status: number;
    data: unknown;
    brokerUnavailable: boolean;
  }[];
  reconciliation: string;
  passed: boolean;
  elapsed: number;
  evidence: Record<string, unknown>;
  conflicts: ConflictCounts | null;
  outboxLag: z.infer<typeof outboxLagSchema> | null;
  firstWave?: ReturnType<typeof waveMetrics>;
  recovery?: ReturnType<typeof waveMetrics>;
}

type RequestStats = Pick<
  Scenario,
  | 'attempts'
  | 'attemptErrors'
  | 'httpStarted'
  | 'httpFinished'
  | 'latencies'
  | 'httpResults'
>;

const scenarios: Scenario[] = [];
let orm: MikroORM | undefined;
let sqs: SQSClient | undefined;
let observer: EventObserver | undefined;
const state = { brokerStopped: false, failed: false };

// Metrics and BET requests share the limit, including during broker recovery.
class ConcurrencyLimiter {
  private active = 0;
  peak = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });

    this.active++;
    this.peak = Math.max(this.peak, this.active);
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const httpLimiter = new ConcurrencyLimiter(10);

async function freePort(): Promise<number> {
  for (;;) {
    const server = createServer();

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    assert(address !== null && typeof address === 'object');

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    if (reservedPorts.has(address.port)) continue;

    reservedPorts.add(address.port);
    return address.port;
  }
}

const ports = {
  postgres: await freePort(),
  localstack: await freePort(),
  nginx: await freePort(),
};
const gateway = `http://127.0.0.1:${String(ports.nginx)}`;

await writeFile(
  override,
  `services:
  postgres:
    ports: !override ["127.0.0.1:${String(ports.postgres)}:5432"]
  localstack:
    ports: !override ["127.0.0.1:${String(ports.localstack)}:4566"]
  nginx:
    ports: !override ["127.0.0.1:${String(ports.nginx)}:80"]
${['migrate', 'bootstrap-queues', ...replicas].map((service) => `  ${service}:\n    image: ${project}:latest\n${replicas.includes(service) ? '    ports: !override []\n' : ''}`).join('')}`,
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

async function command(args: string[], timeoutMs = 120000): Promise<string> {
  assert(timeoutMs > 0, 'Scenario deadline exceeded before command.');

  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    assert.equal(code, 0, `${args.join(' ')} failed: ${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

function remaining(scenario: Scenario): number {
  const time = scenario.deadline - performance.now();
  assert(time > 0, `${scenario.name} deadline exceeded.`);
  return Math.max(1, Math.floor(time));
}

async function api(
  scenario: Scenario,
  path: string,
  body?: unknown,
  key?: string,
  limiter = httpLimiter,
) {
  await limiter.acquire();

  try {
    const timeoutMs = Math.min(remaining(scenario), 5000);
    const response = await fetch(gateway + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': key ?? `${project}-${scenario.name}`,
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    let data: unknown = text;

    try {
      data = JSON.parse(text) as unknown;
    } catch {
      /* A gateway error or metrics exposition can be plain text. */
    }

    return { status: response.status, data };
  } finally {
    limiter.release();
  }
}

async function pool<T>(items: T[], action: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const errors: unknown[] = [];

  await Promise.all(
    Array.from({ length: Math.min(10, items.length) }, async () => {
      for (;;) {
        const item = items[cursor++];
        if (item === undefined) return;

        try {
          await action(item);
        } catch (error) {
          errors.push(error);
        }
      }
    }),
  );

  if (errors.length > 0) throw new AggregateError(errors, 'Load request slots failed.');
}

async function wallets(scenario: Scenario, count: number): Promise<Wallet[]> {
  const created: Wallet[] = [];

  await pool(
    Array.from({ length: count }, () => randomUUID()),
    async (playerId) => {
      const response = await api(scenario, '/wallets', {
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });

      assert.equal(response.status, 201);
      const wallet = walletSchema.parse(response.data);
      assert.deepEqual(wallet.balance, { amount: '100.00', currency: 'BRL' });
      assert.equal(wallet.version, '1');

      created.push(wallet);
    },
  );

  scenario.evidence.wallets = created;
  return created;
}

function betPayload(wallet: Wallet, amount: string): BetPayload {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `${project}-round`,
    gameId: 'load-game',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

function operations(
  scenario: Scenario,
  owned: Wallet[],
  rounds: number,
  amount: string,
): void {
  // Interleave wallets so the request slots do not drain one wallet at a time.
  for (let round = 0; round < rounds; round++) {
    for (const wallet of owned)
      scenario.operations.push({
        key: randomUUID(),
        payload: betPayload(wallet, amount),
      });
  }
}

function historical(result: Result) {
  return resultSchema.omit({ idempotentReplay: true }).parse(result);
}

function isValidOutcome(status: number, result: Result): boolean {
  if (result.balance === undefined || result.walletVersion === undefined) return false;
  return status === 200 ? result.status === 'PROCESSED' : result.status === 'REJECTED';
}

function recordResult(
  operation: Operation,
  response: { status: number; data: unknown },
): boolean {
  if (response.status !== 200 && response.status !== 422) return false;

  const parsed = resultSchema.safeParse(response.data);
  if (!parsed.success || !isValidOutcome(response.status, parsed.data)) return false;

  // Duplicate delivery must preserve the first terminal result, not the current balance.
  if (operation.result)
    assert.deepEqual(historical(parsed.data), historical(operation.result));

  operation.result = parsed.data;
  return true;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function trackAttempt(scenario: Scenario, operation: Operation, kind: AttemptKind): void {
  scenario.attempts++;

  if (kind === 'retry') scenario.retries++;
  else if (kind === 'replay') scenario.replays++;
  else {
    scenario.initialAttempts++;
    operation.startedDuringOutage = state.brokerStopped;
  }
}

function handleResponse(
  operation: Operation,
  response: { status: number; data: unknown },
): boolean {
  try {
    return recordResult(operation, response);
  } catch (error) {
    operation.error = error instanceof Error ? error.message : 'Operation record error';
    return true;
  }
}

async function submit(
  scenario: Scenario,
  operation: Operation,
  kind: AttemptKind = 'initial',
): Promise<void> {
  while (performance.now() < scenario.deadline) {
    if (await attempt(scenario, operation, kind, httpLimiter)) return;

    // An uncertain response must not create a new financial operation.
    kind = 'retry';
    await delay(Math.min(100, Math.max(0, scenario.deadline - performance.now())));
  }
}

async function attempt(
  scenario: Scenario,
  operation: Operation,
  kind: AttemptKind,
  limiter: ConcurrencyLimiter,
): Promise<boolean> {
  trackAttempt(scenario, operation, kind);
  const brokerUnavailableAtStart = state.brokerStopped;
  const start = performance.now();
  scenario.httpStarted ??= start;
  let response;

  try {
    response = await api(
      scenario,
      '/wagering/transactions',
      operation.payload,
      operation.key,
      limiter,
    );
    scenario.latencies.push(performance.now() - start);
    scenario.httpResults.push({
      key: operation.key,
      status: response.status,
      data: response.data,
      brokerUnavailable: brokerUnavailableAtStart,
    });
  } catch (error) {
    if (isTimeoutError(error)) scenario.attemptTimeouts++;
    scenario.attemptErrors++;
  } finally {
    scenario.httpFinished = performance.now();
  }

  if (response === undefined) return false;

  const complete = handleResponse(operation, response);
  if (!complete || operation.error !== undefined) scenario.attemptErrors++;
  return complete;
}

function expectOutcomes(scenario: Scenario, processed: number, rejected = 0): void {
  assert.equal(scenario.operations.length, scenario.logical);
  assert.equal(
    scenario.operations.filter((op) => op.result?.status === 'PROCESSED' && !op.error)
      .length,
    processed,
  );
  assert.equal(
    scenario.operations.filter((op) => op.result?.status === 'REJECTED' && !op.error)
      .length,
    rejected,
  );
  assert(
    scenario.operations.every((op) => op.error === undefined),
    'Invalid transport or replay result.',
  );

  for (const operation of scenario.operations.filter(
    (op) => op.result?.status === 'REJECTED',
  )) {
    assert.equal(operation.result?.failureCode, 'INSUFFICIENT_FUNDS');
  }
}

async function reconcile(
  scenario: Scenario,
  owned: Wallet[],
  balance: string,
  entries = 11,
): Promise<void> {
  await pool(owned, async (wallet) => {
    const current = await api(scenario, `/wallets/${wallet.id}`);
    assert.equal(current.status, 200);
    const snapshot = walletSchema.parse(current.data);
    assert.deepEqual(snapshot.balance, { amount: balance, currency: 'BRL' });
    assert.equal(snapshot.version, String(entries));

    // Each wallet version must have a matching ledger entry.
    const response = await api(scenario, `/wallets/${wallet.id}/reconciliation`, {});
    assert.equal(response.status, 200);
    assert.deepEqual(reconciliationSchema.parse(response.data), {
      consistent: true,
      storedBalance: { amount: balance, currency: 'BRL' },
      calculatedBalance: { amount: balance, currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      checkedEntries: entries,
    });
  });

  scenario.reconciliation = 'consistent';
}

async function rows(query: string, params: unknown[] = []): Promise<unknown> {
  assert(orm);
  return orm.em.getConnection().execute(query, params);
}

// Counters are process-local. Sum changes from every replica, not gateway scrapes.
async function conflictSnapshot(scenario: Scenario): Promise<ConflictCounts> {
  const counts: ConflictCounts = {
    guarded_update: 0,
    serialization: 0,
    deadlock: 0,
    lock_timeout: 0,
  };

  const scrapes = await Promise.all(
    replicas.map((replica) =>
      command(
        [
          ...compose,
          'exec',
          '-T',
          replica,
          'curl',
          '--fail',
          '--silent',
          '--show-error',
          '--max-time',
          '5',
          'http://127.0.0.1:3000/metrics',
        ],
        remaining(scenario),
      ),
    ),
  );

  for (const scrape of scrapes) {
    for (const kind of conflictKinds) {
      const match = new RegExp(
        `^financial_conflict_total\\{outcome="${kind}"\\} (\\d+)$`,
        'm',
      ).exec(scrape);
      assert(match, `Missing conflict counter: ${kind}`);
      const count = Number(match[1]);
      assert(Number.isSafeInteger(count), 'Conflict counter exceeds the integer limit.');
      counts[kind] += count;
    }
  }

  return counts;
}

// Wait for publication so averages cannot hide the events that are still pending.
async function publicationLag(scenario: Scenario): Promise<void> {
  const transactionIds = scenario.operations.flatMap((operation) =>
    operation.result ? [operation.result.transactionId] : [],
  );
  const expected = scenario.operations.reduce(
    (count, operation) => count + (operation.result?.status === 'PROCESSED' ? 2 : 1),
    0,
  );

  for (;;) {
    remaining(scenario);
    const result = z.array(outboxLagSchema).parse(
      await rows(
        `SELECT count(*)::int AS events,
        count(*) FILTER (WHERE published_at IS NULL)::int AS pending,
        COALESCE(avg(EXTRACT(EPOCH FROM (published_at - occurred_at))), 0)::float8 AS "meanSeconds",
        COALESCE(max(EXTRACT(EPOCH FROM (published_at - occurred_at))), 0)::float8 AS "maxSeconds"
      FROM outbox_messages WHERE payload->'data'->>'transactionId' IN (?)`,
        [transactionIds],
      ),
    )[0];
    assert(result);
    scenario.outboxLag = result;
    assert.equal(
      result.events,
      expected,
      'Unexpected number of terminal operation events.',
    );
    if (result.pending === 0) return;

    await delay(Math.min(100, remaining(scenario)));
  }
}

async function upstreamProof(scenario: Scenario): Promise<void> {
  const ids = (await command([...compose, 'ps', '-q', ...replicas], remaining(scenario)))
    .trim()
    .split('\n');
  assert.equal(ids.length, 3);
  const containers = z
    .array(
      z.object({
        Name: z.string(),
        NetworkSettings: z.object({
          Networks: z.record(z.string(), z.object({ IPAddress: z.string() })),
        }),
      }),
    )
    .parse(
      JSON.parse(
        await command(['docker', 'inspect', ...ids], remaining(scenario)),
      ) as unknown,
    );

  const logs = await command(
    [...compose, 'logs', '--no-log-prefix', 'nginx'],
    remaining(scenario),
  );
  const addresses = new Set<string>();
  const logSchema = z
    .object({
      method: z.string(),
      correlation_id: z.string(),
      upstream_addr: z.string(),
    })
    .loose();
  const keys = new Set(scenario.operations.map((op) => op.key));

  // Correlation IDs exclude health probes and requests from other scenarios.
  for (const line of logs.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const entry = logSchema.parse(JSON.parse(line) as unknown);
      if (entry.method !== 'POST' || !keys.has(entry.correlation_id)) continue;
      for (const address of entry.upstream_addr.split(',')) addresses.add(address.trim());
    } catch {
      /* Skip non-JSON or unrelated log line */
    }
  }

  const reached = containers.map((container) => {
    const ips = Object.values(container.NetworkSettings.Networks).map(
      (network) => `${network.IPAddress}:3000`,
    );
    return {
      container: container.Name,
      addresses: ips,
      hit: ips.filter((ip) => addresses.has(ip)),
    };
  });
  scenario.evidence.upstreams = { reached, observed: [...addresses] };
  assert(
    reached.every((container) => container.hit.length > 0),
    'Harness bets did not reach all three replicas.',
  );
}

// Scenario 1: independent wallets must progress on all three replicas.
async function independent(scenario: Scenario): Promise<void> {
  const owned = await wallets(scenario, 20);
  operations(scenario, owned, 10, '1.00');

  await pool(scenario.operations, (op) => submit(scenario, op));
  expectOutcomes(scenario, 200);

  await reconcile(scenario, owned, '90.00');
  await upstreamProof(scenario);
}

// Scenario 2: contention must reject excess bets without duplicate debits.
async function contention(scenario: Scenario): Promise<void> {
  const owned = await wallets(scenario, 1);
  operations(scenario, owned, 20, '10.00');

  // Each set of ten slots competes with two deliveries of five identities.
  const attempts: Operation[] = [];
  for (let i = 0; i < scenario.operations.length; i += 5) {
    const chunk = scenario.operations.slice(i, i + 5);
    attempts.push(...chunk, ...chunk);
  }

  await pool(attempts, (op) => submit(scenario, op));
  expectOutcomes(scenario, 10, 10);
  await reconcile(scenario, owned, '0.00');

  // Read durable results before replay so HTTP responses are checked against storage.
  const stored = z
    .array(
      z.object({
        id: z.uuid(),
        idempotency_key: z.string(),
        status: z.string(),
        result: resultSchema.omit({ idempotentReplay: true }),
      }),
    )
    .parse(
      await rows(
        'SELECT id, idempotency_key, status, result FROM wager_transactions WHERE wallet_id = ? AND kind = ?',
        [owned[0]?.id, 'BET'],
      ),
    );

  assert.equal(stored.length, 20);
  for (const operation of scenario.operations) {
    const transaction = stored.find((row) => row.idempotency_key === operation.key);
    assert(transaction && operation.result);
    assert.equal(transaction.id, operation.result.transactionId);
    assert.equal(transaction.status, operation.result.status);
    assert.deepEqual(transaction.result, historical(operation.result));
  }

  scenario.evidence.storedResults = stored;

  // Replay both winners and rejections; neither may change the final balance.
  await pool(scenario.operations, async (op) => {
    await submit(scenario, op, 'replay');
    assert.equal(op.result?.idempotentReplay, true);
  });

  expectOutcomes(scenario, 10, 10);
  await reconcile(scenario, owned, '0.00');
}

// Keep the burst separate from recovery so retries cannot hide the first-wave errors.
async function walletBurst(scenario: Scenario): Promise<void> {
  const owned = await wallets(scenario, 1);
  operations(scenario, owned, 100, '1.00');
  const limiter = new ConcurrencyLimiter(100);

  await Promise.all(
    scenario.operations.map((op) => attempt(scenario, op, 'initial', limiter)),
  );
  scenario.firstWave = waveMetrics(
    scenario,
    scenario.operations,
    scenario.attemptTimeouts,
  );
  scenario.evidence.peakConcurrency = limiter.peak;
  assert.equal(limiter.peak, 100);
  assert.equal(scenario.initialAttempts, 100);

  const unresolved = scenario.operations.filter((op) => !op.result && !op.error);
  const responseCount = scenario.httpResults.length;
  const recoveryStarted = performance.now();

  await pool(unresolved, (op) => submit(scenario, op, 'retry'));
  const attempts = scenario.attempts - scenario.firstWave.attempts;
  scenario.recovery = waveMetrics(
    {
      attempts,
      attemptErrors: scenario.attemptErrors - scenario.firstWave.attemptErrors,
      httpStarted: attempts > 0 ? recoveryStarted : null,
      httpFinished: attempts > 0 ? scenario.httpFinished : null,
      latencies: scenario.latencies.slice(scenario.firstWave.latencySamples),
      httpResults: scenario.httpResults.slice(responseCount),
    },
    unresolved,
    scenario.attemptTimeouts - scenario.firstWave.attemptTimeouts,
  );

  expectOutcomes(scenario, 100);
  await reconcile(scenario, owned, '0.00', 101);
}

async function receive(
  scenario: Scenario,
  predicate: Parameters<EventObserver['receiveUntil']>[0],
): Promise<void> {
  assert(observer);

  // Broker startup can fail temporarily; invalid event evidence must fail the scenario.
  while (performance.now() < scenario.deadline) {
    try {
      await observer.receiveUntil(predicate, remaining(scenario));
      return;
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      await delay(Math.min(200, remaining(scenario)));
    }
  }
  remaining(scenario);
}

async function outboxAge(scenario: Scenario, phase: string): Promise<void> {
  const response = await api(scenario, '/metrics');
  assert.equal(response.status, 200);
  assert.equal(typeof response.data, 'string');

  const match = /^outbox_pending_age_seconds ([\d.e+-]+)$/m.exec(String(response.data));
  assert(match);

  scenario.evidence[`outboxAge_${phase}`] = {
    seconds: Number(match[1]),
    time: new Date().toISOString(),
  };
}

async function restoreBroker(timeoutMs = 120000): Promise<void> {
  await command([...compose, 'start', 'localstack'], timeoutMs);
  const deadline = performance.now() + Math.min(timeoutMs, 30000);

  while (performance.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(ports.localstack)}/_localstack/health`,
        {
          signal: AbortSignal.timeout(1000),
        },
      );
      if (response.ok) break;
    } catch {
      /* Wait for LocalStack to accept requests */
    }
    await delay(200);
  }

  state.brokerStopped = false;
}

// Scenario 3: committed BETs and their events must survive a broker outage.
async function brokerOutage(scenario: Scenario): Promise<void> {
  const owned = await wallets(scenario, 10);
  const walletIds = new Set(owned.map((wallet) => wallet.id));

  // Drain opening events before the outage to separate them from BET delivery.
  await receive(
    scenario,
    (events) => events.filter((event) => walletIds.has(event.aggregateId)).length === 20,
  );
  await outboxAge(scenario, 'before');

  operations(scenario, owned, 10, '1.00');

  // Mark the outage before stopping the broker so finally can restore a failed stop.
  state.brokerStopped = true;
  await command([...compose, 'stop', '-t', '1', 'localstack'], remaining(scenario));
  const stoppedAt = performance.now();

  // Check committed work before restart; later success cannot prove outage progress.
  const restart = (async () => {
    await delay(10000);
    try {
      const committed = z
        .array(z.object({ count: z.number() }))
        .parse(
          await rows(
            "SELECT count(*)::int AS count FROM wager_transactions WHERE wallet_id IN (?) AND kind = 'BET' AND status = 'PROCESSED'",
            [[...walletIds]],
          ),
        );
      const committedCount = committed[0]?.count ?? 0;
      scenario.evidence.committedDuringOutage = committedCount;
      assert.equal(
        committedCount,
        100,
        'All 100 BET operations must commit during the broker outage',
      );

      await outboxAge(scenario, 'outage');
      scenario.evidence.brokerStoppedMs = performance.now() - stoppedAt;
    } finally {
      await restoreBroker(remaining(scenario));
    }
  })();

  // Wait for both HTTP work and broker restoration before checking their evidence.
  await Promise.allSettled([
    pool(scenario.operations, (op) => submit(scenario, op)),
    restart,
  ]).then((results) => {
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  assert.equal(
    scenario.operations.filter((op) => op.startedDuringOutage).length,
    100,
    'All 100 initial BET identities must be submitted while broker is unavailable',
  );
  assert(
    scenario.httpResults.some(
      (response) => response.status === 200 && response.brokerUnavailable,
    ),
    'No successful HTTP bet while the broker was stopped.',
  );

  // Recover unknown HTTP outcomes with their original payloads and identities.
  await pool(
    scenario.operations.filter((op) => !op.result && !op.error),
    (op) => submit(scenario, op),
  );
  expectOutcomes(scenario, 100);

  // Outbox rows identify expected events, but only broker receipt proves delivery.
  const expected = z
    .array(z.object({ id: z.uuid(), event_type: z.string(), transaction_id: z.uuid() }))
    .parse(
      await rows(
        "SELECT id, event_type, payload->'data'->>'transactionId' AS transaction_id FROM outbox_messages WHERE aggregate_id IN (?) AND payload->'data'->>'kind' IS DISTINCT FROM 'OPENING'",
        [[...walletIds]],
      ),
    );
  const transactionIds = new Set(
    scenario.operations.map((op) => op.result?.transactionId),
  );
  const betEvents = expected.filter((event) => transactionIds.has(event.transaction_id));
  assert.equal(betEvents.length, 200);

  await receive(scenario, (events) =>
    betEvents.every((expectedEvent) =>
      events.some((event) => event.eventId === expectedEvent.id),
    ),
  );

  // The observer deduplicates by eventId; event arrival order is not an invariant.
  assert(observer);
  for (const operation of scenario.operations) {
    const matched: ObservedEvent[] = observer.events.filter(
      (event: ObservedEvent) =>
        'transactionId' in event.data &&
        event.data.transactionId === operation.result?.transactionId,
    );
    assert.deepEqual(matched.map((event) => event.eventType).sort(), [
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    assert(matched.every((event) => event.aggregateId === operation.payload.walletId));
  }

  scenario.evidence.betEventIds = betEvents.map((event) => event.id);
  scenario.evidence.duplicateDeliveries = observer.duplicates;

  await reconcile(scenario, owned, '90.00');
  await outboxAge(scenario, 'recovered');
}

async function run(
  name: string,
  logical: number,
  budgetMs: number,
  action: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  const started = performance.now();
  const scenario: Scenario = {
    name,
    logical,
    started,
    deadline: started + budgetMs,
    operations: [],
    attempts: 0,
    initialAttempts: 0,
    retries: 0,
    replays: 0,
    attemptTimeouts: 0,
    attemptErrors: 0,
    httpStarted: null,
    httpFinished: null,
    latencies: [],
    httpResults: [],
    reconciliation: 'not checked',
    passed: false,
    elapsed: 0,
    evidence: {},
    conflicts: null,
    outboxLag: null,
  };
  scenarios.push(scenario);

  // Include setup and final checks in the deadline, not only BET submission.
  try {
    const before = await conflictSnapshot(scenario);
    scenario.evidence.conflictsBefore = before;

    await action(scenario);

    await publicationLag(scenario);
    const after = await conflictSnapshot(scenario);
    scenario.evidence.conflictsAfter = after;
    scenario.conflicts = { ...after };
    for (const kind of conflictKinds) {
      assert(after[kind] >= before[kind], 'A replica counter reset during the scenario.');
      scenario.conflicts[kind] -= before[kind];
    }

    remaining(scenario);
    scenario.passed = true;
  } catch (error) {
    scenario.evidence.error =
      error instanceof Error ? error.message : 'Scenario execution failed';
    state.failed = true;
  } finally {
    scenario.elapsed = performance.now() - started;
  }
}

function formatReplicaEvidence(evidence: Record<string, unknown>): string {
  const upstreams = evidence.upstreams as
    { reached: { container: string; hit: string[] }[] } | undefined;
  if (!upstreams) return '-';

  const summary = upstreams.reached
    .map((r) => `${r.container.replace(/^.*?(app-\d+).*$/, '$1')} (${r.hit.join(',')})`)
    .join(', ');
  return `3/3 replicas: ${summary}`;
}

function formatOutageEvidence(evidence: Record<string, unknown>): string {
  const b =
    (evidence.outboxAge_before as { seconds: number } | undefined)?.seconds.toFixed(2) ??
    '?';
  const o =
    (evidence.outboxAge_outage as { seconds: number } | undefined)?.seconds.toFixed(2) ??
    '?';
  const r =
    (evidence.outboxAge_recovered as { seconds: number } | undefined)?.seconds.toFixed(
      2,
    ) ?? '?';

  const committed =
    typeof evidence.committedDuringOutage === 'number'
      ? evidence.committedDuringOutage
      : 0;

  return `${String(committed)} outage commits | 200 BET events | outbox age: ${b}s -> ${o}s -> ${r}s`;
}

function formatEvidence(scenario: Scenario): string {
  if (typeof scenario.evidence.error === 'string') {
    return `FAIL: ${scenario.evidence.error.slice(0, 45)}`;
  }

  if (scenario.name === 'independent wallets')
    return formatReplicaEvidence(scenario.evidence);
  if (scenario.name === 'duplicate contention') {
    return '20/20 replayed match DB (10 PROCESSED, 10 REJECTED; bal 0.00, v11)';
  }
  if (scenario.name === 'broker outage') return formatOutageEvidence(scenario.evidence);
  if (scenario.name === 'single-wallet burst')
    return '100 PROCESSED; bal 0.00, v101, 101 ledger entries';
  return '-';
}

function logicalOutcomes(scenario: Scenario) {
  let processed = 0;
  let rejected = 0;
  let errors = 0;

  for (const operation of scenario.operations) {
    if (operation.error !== undefined) errors++;
    else if (operation.result?.status === 'PROCESSED') processed++;
    else if (operation.result?.status === 'REJECTED') rejected++;
  }

  return {
    processed,
    rejected,
    errors,
    timedOut: scenario.logical - processed - rejected - errors,
  };
}

function requestMetrics(scenario: RequestStats, terminalOperations: number) {
  const latencies = [...scenario.latencies].sort((left, right) => left - right);
  const httpSeconds =
    scenario.httpStarted === null || scenario.httpFinished === null
      ? 0
      : (scenario.httpFinished - scenario.httpStarted) / 1000;
  const statuses: Record<string, number> = {};

  for (const response of scenario.httpResults) {
    const status = String(response.status);
    statuses[status] = (statuses[status] ?? 0) + 1;
  }

  // Timeouts count as errors but have no completed-attempt latency sample.
  const percentile = (probability: number) =>
    latencies.length === 0 ? null : quantileSorted(latencies, probability);

  return {
    httpStatuses: statuses,
    httpSeconds,
    logicalOperationsPerSecond: httpSeconds > 0 ? terminalOperations / httpSeconds : null,
    requestsPerSecond: httpSeconds > 0 ? scenario.attempts / httpSeconds : null,
    httpErrorPercent:
      scenario.attempts > 0 ? (scenario.attemptErrors / scenario.attempts) * 100 : null,
    latencySamples: latencies.length,
    latenciesMs: latencies,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

function waveMetrics(
  stats: RequestStats,
  operations: Operation[],
  attemptTimeouts: number,
) {
  const processed = operations.filter(
    (op) => op.result?.status === 'PROCESSED' && !op.error,
  ).length;
  const rejected = operations.filter(
    (op) => op.result?.status === 'REJECTED' && !op.error,
  ).length;

  return {
    attempts: stats.attempts,
    attemptErrors: stats.attemptErrors,
    attemptTimeouts,
    processed,
    rejected,
    unresolved: operations.length - processed - rejected,
    ...requestMetrics(stats, processed + rejected),
  };
}

function scenarioMetrics(scenario: Scenario) {
  const outcomes = logicalOutcomes(scenario);

  return {
    scenario: scenario.name,
    logicalOperations: scenario.logical,
    attempts: scenario.attempts,
    initialAttempts: scenario.initialAttempts,
    retries: scenario.retries,
    replays: scenario.replays,
    outcomes,
    attemptErrors: scenario.attemptErrors,
    attemptTimeouts: scenario.attemptTimeouts,
    elapsedSeconds: scenario.elapsed / 1000,
    logicalErrorPercent: ((outcomes.errors + outcomes.timedOut) / scenario.logical) * 100,
    ...requestMetrics(scenario, outcomes.processed + outcomes.rejected),
    conflicts: scenario.conflicts,
    outboxLag: scenario.outboxLag,
    firstWave: scenario.firstWave ?? null,
    recovery: scenario.recovery ?? null,
    reconciliation: scenario.reconciliation,
    evidence: scenario.evidence,
    result: scenario.passed ? 'PASS' : 'FAIL',
  };
}

function formatMetric(value: number | null): string {
  return value?.toFixed(2) ?? '-';
}

function report() {
  const metrics = scenarios.map(scenarioMetrics);

  console.table(
    metrics.map((metric, index) => {
      const scenario = scenarios[index];
      assert(scenario);
      const conflicts = metric.conflicts;

      return {
        scenario: metric.scenario,
        logical: metric.logicalOperations,
        'attempts (init/retry/replay)': `${String(metric.attempts)} (${String(metric.initialAttempts)}/${String(metric.retries)}/${String(metric.replays)})`,
        outcomes: `P:${String(metric.outcomes.processed)} R:${String(metric.outcomes.rejected)} ERROR:${String(metric.outcomes.errors)} TIMEOUT:${String(metric.outcomes.timedOut)} attempt-timeouts:${String(metric.attemptTimeouts)}`,
        'elapsed / HTTP s': `${formatMetric(metric.elapsedSeconds)} / ${formatMetric(metric.httpSeconds)}`,
        'throughput op/req/s': `${formatMetric(metric.logicalOperationsPerSecond)} / ${formatMetric(metric.requestsPerSecond)}`,
        'p50/p95/p99 ms': [metric.p50Ms, metric.p95Ms, metric.p99Ms]
          .map(formatMetric)
          .join(' / '),
        'errors HTTP/logical %': `${formatMetric(metric.httpErrorPercent)} / ${formatMetric(metric.logicalErrorPercent)}`,
        'conflicts guard/serial/deadlock/lock': conflicts
          ? conflictKinds.map((kind) => conflicts[kind]).join('/')
          : '-',
        'outbox mean/max s': metric.outboxLag
          ? `${formatMetric(metric.outboxLag.meanSeconds)} / ${formatMetric(metric.outboxLag.maxSeconds)}`
          : '-',
        reconciliation: metric.reconciliation,
        'proof / evidence': formatEvidence(scenario),
        result: metric.result,
      };
    }),
  );

  for (const metric of metrics) {
    if (!metric.firstWave) continue;

    console.log(`${metric.scenario}: phases (recovery concurrency: 10)`);
    console.table([
      formatWave('first wave (100)', metric.firstWave),
      formatWave('recovery', metric.recovery),
    ]);
  }

  return metrics;
}

function formatWave(phase: string, stats: ReturnType<typeof waveMetrics> | null) {
  if (!stats) return { phase, evidence: 'not captured' };

  return {
    phase,
    attempts: stats.attempts,
    processed: stats.processed,
    unresolved: stats.unresolved,
    'HTTP s': formatMetric(stats.httpSeconds),
    'throughput op/req/s': `${formatMetric(stats.logicalOperationsPerSecond)} / ${formatMetric(stats.requestsPerSecond)}`,
    'p50/p95/p99 ms': [stats.p50Ms, stats.p95Ms, stats.p99Ms]
      .map(formatMetric)
      .join(' / '),
    'HTTP error %': formatMetric(stats.httpErrorPercent),
    timeouts: stats.attemptTimeouts,
  };
}

// Save each source independently so one capture failure cannot discard other evidence.
async function preserveEvidence(): Promise<void> {
  try {
    try {
      await writeFile(
        join(directory, 'results.json'),
        JSON.stringify(
          {
            project,
            ports,
            scenarios,
            unresolved: scenarios.flatMap((scenario) =>
              scenario.operations.filter((op) => !op.result || op.error),
            ),
            observedEventIds: observer?.events.map((event) => event.eventId) ?? [],
            observedEvents: observer?.events ?? [],
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.error('Failed to write results.json evidence:', error);
    }

    try {
      await writeFile(
        join(directory, 'compose.log'),
        await command([...compose, 'logs', '--no-color']),
      );
    } catch (error) {
      console.error('Failed to write compose.log evidence:', error);
    }

    try {
      await writeFile(
        join(directory, 'database.sql'),
        await command([
          ...compose,
          'exec',
          '-T',
          'postgres',
          'pg_dump',
          '-U',
          'jungle_main',
          'jungle_test',
        ]),
      );
    } catch (error) {
      console.error('Failed to write database.sql evidence:', error);
    }

    console.error(`Load evidence preserved: ${directory}`);
  } catch (error) {
    console.error('Evidence preservation failed:', error);
  }
}

// Start owned resources before the scenario clocks. This observer is the only event reader.
try {
  await command(
    [...compose, 'up', '-d', '--build', '--wait', '--wait-timeout', '180'],
    300000,
  );

  orm = await MikroORM.init(
    createDatabaseOptions(
      `postgresql://jungle_main:main_local@127.0.0.1:${String(ports.postgres)}/jungle_test`,
    ),
  );

  sqs = new SQSClient({
    endpoint: `http://127.0.0.1:${String(ports.localstack)}`,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  });
  const queue = await sqs.send(
    new GetQueueUrlCommand({ QueueName: 'wager-events.fifo' }),
    {
      abortSignal: AbortSignal.timeout(5000),
    },
  );
  assert(queue.QueueUrl);
  observer = new EventObserver(sqs, queue.QueueUrl);

  // Run scenarios in sequence so each has new wallets and an independent deadline.
  await run('independent wallets', 200, 60000, independent);
  await run('duplicate contention', 20, 60000, contention);
  await run('broker outage', 100, 90000, brokerOutage);
  await run('single-wallet burst', 100, 60000, walletBurst);
} catch (error) {
  state.failed = true;
  console.error(error);
} finally {
  // Restore the broker even if a scenario fails before its scheduled restart.
  if (state.brokerStopped) {
    try {
      await restoreBroker();
    } catch (error) {
      state.failed = true;
      console.error('Broker restore failed:', error);
    }
  }

  // Preserve failure evidence before closing clients or removing owned resources.
  const metrics = report();
  if (values['metrics-json']) {
    try {
      await writeFile(
        values['metrics-json'],
        JSON.stringify({ measuredAt, project, scenarios: metrics }, null, 2),
      );
      console.log(`Load metrics: ${values['metrics-json']}`);
    } catch (error) {
      state.failed = true;
      console.error('Metrics export failed:', error);
    }
  }
  if (state.failed) {
    try {
      await preserveEvidence();
    } catch (error) {
      console.error('Evidence preservation failed:', error);
    }
  }

  try {
    sqs?.destroy();
  } catch (error) {
    console.error('SQS destroy failed:', error);
  }

  try {
    await orm?.close(true);
  } catch (error) {
    console.error('ORM close failed:', error);
  }

  // Remove only this run's project, volumes, and image.
  try {
    await command([...compose, 'down', '--volumes', '--remove-orphans']);
    try {
      await command(['docker', 'image', 'rm', '-f', `${project}:latest`]);
    } catch {
      /* Best-effort image cleanup */
    }
  } catch (error) {
    state.failed = true;
    console.error('Load cleanup failed:', error);
    try {
      await preserveEvidence();
    } catch (err) {
      console.error('Secondary evidence preservation failed:', err);
    }
  }

  // Keep failed-run files for inspection; successful runs leave no temporary files.
  if (!state.failed) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      console.error('Temporary directory removal failed:', error);
    }
  }
}

if (state.failed) process.exitCode = 1;
