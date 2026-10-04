import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { createDatabaseOptions } from '../../src/core/database/database.config.js';
import { testTargets } from '../../scripts/test-environment.js';

const LOCAL_PROVIDER_ID = 'provider-a';
const financialLogSchema = z.object({
  message: z.object({ event: z.literal('financial_result'), transactionId: z.uuid() }),
});

const moneySchema = z
  .object({
    amount: z.string().regex(/^-?\d+\.\d{2}$/),
    currency: z.enum(['BRL', 'USD', 'EUR']),
  })
  .strict();

const financialResultSchema = z
  .object({
    transactionId: z.uuid(),
    status: z.enum(['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED']),
    balance: moneySchema.optional(),
    walletVersion: z.string().regex(/^\d+$/).optional(),
    failureCode: z.string().optional(),
    idempotentReplay: z.boolean(),
  })
  .strict();

const walletResponseSchema = z
  .object({
    id: z.uuid(),
    playerId: z.uuid(),
    balance: moneySchema,
    version: z.string().regex(/^\d+$/),
  })
  .loose();

const reconciliationResponseSchema = z
  .object({
    walletId: z.uuid(),
    storedBalance: moneySchema,
    calculatedBalance: moneySchema,
    difference: moneySchema,
    consistent: z.boolean(),
    checkedEntries: z.number().int().nonnegative(),
  })
  .strict();

interface WalletRow {
  readonly id: string;
  readonly balance: string;
  readonly currency: string;
  readonly version: string;
}

interface LedgerRow {
  readonly id: string;
  readonly direction: string;
  readonly amount: string;
  readonly wallet_version: string;
}

interface TransactionRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly amount: string;
  readonly failure_code: string | null;
}

let orm: MikroORM | undefined;

test.beforeAll(async () => {
  const databaseUrl =
    process.env.DATABASE_URL ??
    'postgresql://jungle_main:main_local@127.0.0.1:55432/jungle_test';
  orm = await MikroORM.init(
    createDatabaseOptions(databaseUrl, {
      DB_STATEMENT_TIMEOUT_MS: 10000,
      OPERATION_TIMEOUT_MS: 20000,
    }),
  );
});

test.afterAll(async () => {
  await orm?.close(true);
});

async function queryDatabaseRows<T extends object>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (orm === undefined) {
    throw new Error('Database is not initialized for IA inspection');
  }
  const result: unknown = await orm.em.getConnection().execute(sql, params);
  return z.array(z.record(z.string(), z.unknown())).parse(result) as unknown as T[];
}

const nginxLogEntrySchema = z
  .object({
    method: z.string(),
    upstream_addr: z.string(),
  })
  .loose();

function getUpstreamPostAddresses(sinceIso: string): string[] {
  const output = execFileSync(
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
      'logs',
      '--no-color',
      '--no-log-prefix',
      '--since',
      sinceIso,
      'nginx',
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  const addresses = new Set<string>();
  for (const rawLine of output.trim().split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    try {
      const entry = nginxLogEntrySchema.parse(JSON.parse(line));
      if (
        entry.method === 'POST' &&
        entry.upstream_addr.length > 0 &&
        entry.upstream_addr !== '-'
      ) {
        for (const addr of entry.upstream_addr.split(',')) {
          const trimmed = addr.trim();
          if (trimmed.length > 0) {
            addresses.add(trimmed);
          }
        }
      }
    } catch {
      // Ignore unparseable non-JSON lines
    }
  }
  return [...addresses];
}

test.describe('Concurrency & Gateway Upstream Proof (Item 27)', () => {
  test('50 same-operation simultaneous duplicate submissions produce exactly one financial effect and ledger agreement (C01)', async ({
    request,
  }) => {
    // 1. Initial wallet setup: 100.00 BRL
    const createRes = await request.post('/wallets', {
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': 'c01-wallet-' + crypto.randomUUID(),
      },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      },
    });
    expect(createRes.status()).toBe(201);
    const wallet = walletResponseSchema.parse(await createRes.json());

    // 2. Prepare 50 identical submissions with the SAME idempotency key and externalTransactionId
    const sharedIdempotencyKey = 'idemp-50-' + crypto.randomUUID();
    const sharedExternalId = 'ext-50-' + crypto.randomUUID();
    const roundId = 'round-50-' + crypto.randomUUID();
    const sharedPayload = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId: sharedExternalId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId,
      gameId: 'game-roulette',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    const campaignStartTime = new Date().toISOString();

    // 3. Fire 50 simultaneous duplicate submissions through the Nginx gateway
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        request.post('/wagering/transactions', {
          headers: {
            'content-type': 'application/json',
            'idempotency-key': sharedIdempotencyKey,
            'x-correlation-id': `c01-simul-${String(i)}-` + crypto.randomUUID(),
          },
          data: sharedPayload,
        }),
      ),
    );

    // 4. Assert all 50 responses succeeded with 200 OK
    for (const res of responses) {
      expect(res.status()).toBe(200);
    }

    const results = await Promise.all(
      responses.map(async (r) => financialResultSchema.parse(await r.json())),
    );

    // 5. Invariant assertions:
    // - Every response reports PROCESSED
    // - Every response reports balance 75.00 BRL
    // - Every response reports walletVersion '2'
    // - Every response returns the same transactionId
    // - Exactly ONE response is the primary execution (idempotentReplay: false)
    // - Exactly 49 responses are replays (idempotentReplay: true)
    const primaryExecutions = results.filter((r) => !r.idempotentReplay);
    const replays = results.filter((r) => r.idempotentReplay);

    expect(primaryExecutions.length).toBe(1);
    expect(replays.length).toBe(49);

    const firstResult = results.at(0);
    assert.ok(firstResult, 'At least one transaction result must exist');
    const firstTxId = firstResult.transactionId;
    for (const result of results) {
      expect(result.status).toBe('PROCESSED');
      expect(result.balance).toEqual({ amount: '75.00', currency: 'BRL' });
      expect(result.walletVersion).toBe('2');
      expect(result.transactionId).toBe(firstTxId);
    }

    // 6. Ledger agreement through HTTP queries
    const walletCheckRes = await request.get(`/wallets/${wallet.id}`);
    expect(walletCheckRes.status()).toBe(200);
    const walletCheck = walletResponseSchema.parse(await walletCheckRes.json());
    expect(walletCheck.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(walletCheck.version).toBe('2');

    const reconcileRes = await request.post(`/wallets/${wallet.id}/reconciliation`, {
      headers: { 'x-correlation-id': 'c01-rec-' + crypto.randomUUID() },
    });
    expect(reconcileRes.status()).toBe(200);
    const reconcile = reconciliationResponseSchema.parse(await reconcileRes.json());
    expect(reconcile.consistent).toBe(true);
    expect(reconcile.storedBalance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(reconcile.calculatedBalance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(reconcile.difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(reconcile.checkedEntries).toBe(2); // 1 opening + 1 bet

    // 7. Separate IA SQL assertions: inspect database records
    const dbWallets = await queryDatabaseRows<WalletRow>(
      'SELECT id, balance, currency, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    const dbWallet = dbWallets.at(0);
    assert.ok(dbWallet, 'Wallet must exist in DB');
    expect(dbWallet.balance).toBe('75.00');
    expect(dbWallet.version).toBe('2');

    const dbLedgerRows = await queryDatabaseRows<LedgerRow>(
      'SELECT id, direction, amount, wallet_version FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY wallet_version ASC',
      [wallet.id],
    );
    expect(dbLedgerRows.length).toBe(2);
    const row0 = dbLedgerRows.at(0);
    const row1 = dbLedgerRows.at(1);
    assert.ok(row0 && row1, 'Both ledger rows must exist');
    expect(row0.direction).toBe('CREDIT');
    expect(row0.amount).toBe('100.00');
    expect(row1.direction).toBe('DEBIT');
    expect(row1.amount).toBe('25.00');

    const dbBetTxRows = await queryDatabaseRows<TransactionRow>(
      'SELECT id, kind, status, amount FROM wager_transactions WHERE wallet_id = ? AND kind = ?',
      [wallet.id, 'BET'],
    );
    expect(dbBetTxRows.length).toBe(1);
    const dbBetTx = dbBetTxRows.at(0);
    assert.ok(dbBetTx, 'BET transaction must exist in DB');
    expect(dbBetTx.status).toBe('PROCESSED');
    expect(dbBetTx.amount).toBe('25.00');

    // 8. Prove multi-instance participation using gateway upstream evidence
    const upstreamPostAddrs = getUpstreamPostAddresses(campaignStartTime);
    expect(upstreamPostAddrs.length).toBeGreaterThanOrEqual(3);
    for (const service of ['app-1', 'app-2', 'app-3']) {
      const logs = execFileSync(
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
          'logs',
          '--no-color',
          '--no-log-prefix',
          '--since',
          campaignStartTime,
          service,
        ],
        { encoding: 'utf8' },
      );
      const handledOperation = logs.split('\n').some((line) => {
        try {
          const parsed = financialLogSchema.safeParse(JSON.parse(line) as unknown);
          return parsed.success && parsed.data.message.transactionId === firstTxId;
        } catch {
          return false;
        }
      });
      expect(
        handledOperation,
        `${service} must handle this exact duplicate operation`,
      ).toBe(true);
    }
  });

  test('two BETs of 80.00 competing for 100.00 result in exactly one debit and non-negative balance (C02)', async ({
    request,
  }) => {
    // 1. Initial wallet: 100.00 USD
    const createRes = await request.post('/wallets', {
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': 'c02-wallet-' + crypto.randomUUID(),
      },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'USD' },
      },
    });
    expect(createRes.status()).toBe(201);
    const wallet = walletResponseSchema.parse(await createRes.json());

    // 2. Prepare two distinct competing BETs of 80.00 USD
    const keyA = 'idemp-comp-a-' + crypto.randomUUID();
    const extA = 'ext-comp-a-' + crypto.randomUUID();
    const payloadA = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId: extA,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-comp-1',
      gameId: 'game-cards',
      kind: 'BET',
      money: { amount: '80.00', currency: 'USD' },
    };

    const keyB = 'idemp-comp-b-' + crypto.randomUUID();
    const extB = 'ext-comp-b-' + crypto.randomUUID();
    const payloadB = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId: extB,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-comp-2',
      gameId: 'game-cards',
      kind: 'BET',
      money: { amount: '80.00', currency: 'USD' },
    };

    // 3. Fire both competing BETs concurrently
    const [resA, resB] = await Promise.all([
      request.post('/wagering/transactions', {
        headers: {
          'content-type': 'application/json',
          'idempotency-key': keyA,
          'x-correlation-id': 'c02-comp-a-' + crypto.randomUUID(),
        },
        data: payloadA,
      }),
      request.post('/wagering/transactions', {
        headers: {
          'content-type': 'application/json',
          'idempotency-key': keyB,
          'x-correlation-id': 'c02-comp-b-' + crypto.randomUUID(),
        },
        data: payloadB,
      }),
    ]);

    // One wins with 200 OK PROCESSED; one is rejected with 422 Unprocessable Entity
    const statuses = [resA.status(), resB.status()].sort();
    expect(statuses).toEqual([200, 422]);

    const winnerRes = resA.status() === 200 ? resA : resB;
    const loserRes = resA.status() === 422 ? resA : resB;
    const winnerKey = resA.status() === 200 ? keyA : keyB;
    const winnerPayload = resA.status() === 200 ? payloadA : payloadB;
    const loserKey = resA.status() === 422 ? keyA : keyB;
    const loserPayload = resA.status() === 422 ? payloadA : payloadB;

    const winnerResult = financialResultSchema.parse(await winnerRes.json());
    expect(winnerResult.status).toBe('PROCESSED');
    expect(winnerResult.balance).toEqual({ amount: '20.00', currency: 'USD' });
    expect(winnerResult.walletVersion).toBe('2');

    const loserResult = financialResultSchema.parse(await loserRes.json());
    expect(loserResult.status).toBe('REJECTED');
    expect(loserResult.failureCode).toBe('INSUFFICIENT_FUNDS');

    // 4. Invariant: balance must be strictly non-negative (exactly 20.00)
    const walletCheckRes = await request.get(`/wallets/${wallet.id}`);
    expect(walletCheckRes.status()).toBe(200);
    const walletCheck = walletResponseSchema.parse(await walletCheckRes.json());
    expect(walletCheck.balance).toEqual({ amount: '20.00', currency: 'USD' });
    expect(walletCheck.version).toBe('2');

    // 5. Separate IA SQL assertions:
    // - Wallet balance in DB is 20.00 USD, version 2
    // - Exactly 2 ledger entries: 1 OPENING (+100.00), 1 DEBIT (-80.00) from winner
    // - Exactly 2 wager_transactions: 1 PROCESSED, 1 REJECTED
    const compDbWallets = await queryDatabaseRows<WalletRow>(
      'SELECT balance, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    const compDbWallet = compDbWallets.at(0);
    assert.ok(compDbWallet, 'Wallet record must exist in DB');
    expect(compDbWallet.balance).toBe('20.00');
    expect(compDbWallet.version).toBe('2');

    const dbLedgerRows = await queryDatabaseRows<LedgerRow>(
      'SELECT id, direction, amount, wallet_version FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY wallet_version ASC',
      [wallet.id],
    );
    expect(dbLedgerRows.length).toBe(2);
    const l0 = dbLedgerRows.at(0);
    const l1 = dbLedgerRows.at(1);
    assert.ok(l0 && l1, 'Both ledger rows must exist in DB');
    expect(l0.direction).toBe('CREDIT');
    expect(l0.amount).toBe('100.00');
    expect(l1.direction).toBe('DEBIT');
    expect(l1.amount).toBe('80.00');

    const dbTransactions = await queryDatabaseRows<TransactionRow>(
      'SELECT kind, status, amount, failure_code FROM wager_transactions WHERE wallet_id = ? AND kind = ? ORDER BY created_at ASC',
      [wallet.id, 'BET'],
    );
    expect(dbTransactions.length).toBe(2);
    const processedTxs = dbTransactions.filter((t) => t.status === 'PROCESSED');
    const rejectedTxs = dbTransactions.filter((t) => t.status === 'REJECTED');
    expect(processedTxs.length).toBe(1);
    expect(rejectedTxs.length).toBe(1);
    const processedTx = processedTxs.at(0);
    const rejectedTx = rejectedTxs.at(0);
    assert.ok(
      processedTx && rejectedTx,
      'Both processed and rejected transactions must exist in DB',
    );
    expect(processedTx.amount).toBe('80.00');
    expect(rejectedTx.amount).toBe('80.00');
    expect(rejectedTx.failure_code).toBe('INSUFFICIENT_FUNDS');
    // 6. Reconciliation verification
    const reconcileRes = await request.post(`/wallets/${wallet.id}/reconciliation`, {
      headers: { 'x-correlation-id': 'c02-rec-' + crypto.randomUUID() },
    });
    expect(reconcileRes.status()).toBe(200);
    const reconcile = reconciliationResponseSchema.parse(await reconcileRes.json());
    expect(reconcile.consistent).toBe(true);
    expect(reconcile.storedBalance).toEqual({ amount: '20.00', currency: 'USD' });
    expect(reconcile.calculatedBalance).toEqual({ amount: '20.00', currency: 'USD' });
    expect(reconcile.difference).toEqual({ amount: '0.00', currency: 'USD' });
    expect(reconcile.checkedEntries).toBe(2);

    // 7. Replay invariants:
    // Replay winner: returns 200 with idempotentReplay: true
    const replayWinnerRes = await request.post('/wagering/transactions', {
      headers: { 'content-type': 'application/json', 'idempotency-key': winnerKey },
      data: winnerPayload,
    });
    expect(replayWinnerRes.status()).toBe(200);
    const replayWinnerResult = financialResultSchema.parse(await replayWinnerRes.json());
    expect(replayWinnerResult.idempotentReplay).toBe(true);
    expect(replayWinnerResult.status).toBe('PROCESSED');
    expect(replayWinnerResult.balance).toEqual({ amount: '20.00', currency: 'USD' });

    // Replay loser: returns 422 with idempotentReplay: true and preserves REJECTED state
    const replayLoserRes = await request.post('/wagering/transactions', {
      headers: { 'content-type': 'application/json', 'idempotency-key': loserKey },
      data: loserPayload,
    });
    expect(replayLoserRes.status()).toBe(422);
    const replayLoserResult = financialResultSchema.parse(await replayLoserRes.json());
    expect(replayLoserResult.idempotentReplay).toBe(true);
    expect(replayLoserResult.status).toBe('REJECTED');
    expect(replayLoserResult.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('repeated race conditions across multiple wallets consistently maintain non-negative invariant and single effect', async ({
    request,
  }) => {
    // Run the competition race across 4 independent wallets to prove repeatability
    for (let race = 0; race < 4; race++) {
      const createRes = await request.post('/wallets', {
        headers: { 'content-type': 'application/json' },
        data: {
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'EUR' },
        },
      });
      expect(createRes.status()).toBe(201);
      const wallet = walletResponseSchema.parse(await createRes.json());

      const payload1 = {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: 'ext-race-1-' + crypto.randomUUID(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `race-${String(race)}-1`,
        gameId: 'game-race',
        kind: 'BET',
        money: { amount: '80.00', currency: 'EUR' },
      };

      const payload2 = {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: 'ext-race-2-' + crypto.randomUUID(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `race-${String(race)}-2`,
        gameId: 'game-race',
        kind: 'BET',
        money: { amount: '80.00', currency: 'EUR' },
      };

      const [res1, res2] = await Promise.all([
        request.post('/wagering/transactions', {
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'key-race-1-' + crypto.randomUUID(),
          },
          data: payload1,
        }),
        request.post('/wagering/transactions', {
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'key-race-2-' + crypto.randomUUID(),
          },
          data: payload2,
        }),
      ]);

      const statuses = [res1.status(), res2.status()].sort();
      expect(statuses).toEqual([200, 422]);

      const raceDbWallets = await queryDatabaseRows<WalletRow>(
        'SELECT balance, version FROM wallets WHERE id = ?',
        [wallet.id],
      );
      const raceDbWallet = raceDbWallets.at(0);
      assert.ok(raceDbWallet, 'Wallet must exist in DB');
      expect(raceDbWallet.balance).toBe('20.00');
      expect(raceDbWallet.version).toBe('2');

      const raceLedgerCounts = await queryDatabaseRows<{ count: string }>(
        'SELECT count(*) as count FROM wallet_ledger_entries WHERE wallet_id = ?',
        [wallet.id],
      );
      const countRow = raceLedgerCounts.at(0);
      assert.ok(countRow, 'Ledger count must be returned');
      expect(countRow.count).toBe('2');
    }
  });
});
