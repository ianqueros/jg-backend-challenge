import { afterAll, beforeAll, describe, expect, test, spyOn } from 'bun:test';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { createDatabaseOptions } from '../../src/core/database/database.config.js';
import {
  DatabaseTransactionRunner,
  type TransactionAttemptContext,
} from '../../src/core/database/database-transaction.runner.js';
import type { DatabaseSettings } from '../../src/core/database/database.settings.js';
import type { Knex } from 'knex';
import { ReconciliationTelemetry } from '../../src/domains/wallet/reconciliation.telemetry.js';
import { ReconciliationUseCase } from '../../src/domains/wallet/reconciliation.use-case.js';
import { WalletUseCase } from '../../src/domains/wallet/wallet.use-case.js';
import {
  FinancialUseCase,
  type FinancialContext,
} from '../../src/domains/wagering/financial.use-case.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

type QueryExecution = (connection: object, query: unknown) => Promise<unknown>;
type QueryHook = (
  connection: object,
  query: unknown,
  execute: QueryExecution,
) => Promise<unknown>;

class ObservedRunner extends DatabaseTransactionRunner {
  constructor(
    database: MikroORM,
    settings: Partial<DatabaseSettings>,
    private readonly hook: QueryHook,
  ) {
    super(database, settings);
  }

  override run<T>(
    callback: (em: EntityManager, context: TransactionAttemptContext) => Promise<T>,
  ): Promise<T> {
    return super.run(async (em, context) => {
      const transaction = em.getTransactionContext<Knex.Transaction>();
      if (transaction === undefined) throw new Error('Missing test transaction.');
      // Knex exposes the per-transaction client without a public query type.
      const client = transaction.client as unknown as { query: QueryExecution };
      const originalQuery = client.query;
      const execute = originalQuery.bind(client);
      client.query = (connection, query) => this.hook(connection, query, execute);
      try {
        return await callback(em, context);
      } finally {
        client.query = originalQuery;
      }
    });
  }
}

function statement(query: unknown): string {
  if (typeof query === 'string') return query;
  if (
    typeof query === 'object' &&
    query !== null &&
    'sql' in query &&
    typeof query.sql === 'string'
  )
    return query.sql;
  throw new TypeError('Expected an executable Knex statement.');
}

const environment = z
  .object({
    ADMIN_DATABASE_URL: z
      .url()
      .default('postgresql://postgres:postgres_local@127.0.0.1:55432/postgres'),
  })
  .parse(process.env);

const databaseName = 'jungle_rec_' + crypto.randomUUID().replaceAll('-', '');
let admin: MikroORM | undefined;
let fixtureAdmin: MikroORM | undefined;
let application: MikroORM | undefined;
let runner: DatabaseTransactionRunner;
let reconciliationUseCase: ReconciliationUseCase;
let telemetry: ReconciliationTelemetry;
let walletUseCase: WalletUseCase;
let financialUseCase: FinancialUseCase;
let databaseCreated = false;

function appDb(): MikroORM {
  if (application === undefined) {
    throw new Error('Application database not initialized');
  }
  return application;
}

function adminDb(): MikroORM {
  if (fixtureAdmin === undefined) {
    throw new Error('Fixture admin database not initialized');
  }
  return fixtureAdmin;
}

function databaseUrl(user: string, password: string): string {
  const url = new URL(environment.ADMIN_DATABASE_URL);
  url.username = user;
  url.password = password;
  url.pathname = '/' + databaseName;
  return url.toString();
}

beforeAll(async () => {
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

  application = await MikroORM.init(
    createDatabaseOptions(databaseUrl('jungle_main', 'main_local'), {
      DB_STATEMENT_TIMEOUT_MS: 10000,
      OPERATION_TIMEOUT_MS: 20000,
    }),
  );
  await application.migrator.up();
  const fixtureUrl = new URL(environment.ADMIN_DATABASE_URL);
  fixtureUrl.pathname = '/' + databaseName;
  fixtureAdmin = await MikroORM.init(
    createDatabaseOptions(fixtureUrl.toString(), {
      DB_STATEMENT_TIMEOUT_MS: 10000,
      OPERATION_TIMEOUT_MS: 20000,
    }),
  );

  runner = new DatabaseTransactionRunner(application, {
    OPERATION_TIMEOUT_MS: 20000,
    DB_STATEMENT_TIMEOUT_MS: 10000,
  });

  telemetry = new ReconciliationTelemetry();
  reconciliationUseCase = new ReconciliationUseCase(runner, telemetry);
  walletUseCase = new WalletUseCase(runner);
  financialUseCase = new FinancialUseCase(runner);
}, 60000);

afterAll(async () => {
  await fixtureAdmin?.close(true);
  await application?.close(true);
  if (admin !== undefined && databaseCreated) {
    await admin.em
      .getConnection()
      .execute('drop database ' + databaseName + ' with (force)');
  }
  await admin?.close(true);
});

describe('Consistent snapshots and monetary boundaries', () => {
  test('reconciles empty ledger wallet with zero opening balance', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await walletUseCase.createWallet({
      playerId,
      initialBalance: { amount: '0.00', currency: 'USD' },
    });

    const result = await reconciliationUseCase.reconcile(wallet.id);

    expect(result.walletId).toBe(wallet.id);
    expect(result.storedBalance).toEqual({ amount: '0.00', currency: 'USD' });
    expect(result.calculatedBalance).toEqual({ amount: '0.00', currency: 'USD' });
    expect(result.difference).toEqual({ amount: '0.00', currency: 'USD' });
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(0);
  });

  test('reconciles wallet with positive opening balance (single entry)', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await walletUseCase.createWallet({
      playerId,
      initialBalance: { amount: '250.50', currency: 'BRL' },
    });

    const result = await reconciliationUseCase.reconcile(wallet.id);

    expect(result.walletId).toBe(wallet.id);
    expect(result.storedBalance).toEqual({ amount: '250.50', currency: 'BRL' });
    expect(result.calculatedBalance).toEqual({ amount: '250.50', currency: 'BRL' });
    expect(result.difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(1);
  });

  test('reconciles signed sum across sequential CREDIT and DEBIT entries', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await walletUseCase.createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'EUR' },
    });

    const context: FinancialContext = {
      providerId: 'provider-a',
      correlationId: 'corr-' + crypto.randomUUID(),
    };

    // BET: -40.00 EUR (DEBIT) -> balance 60.00
    await financialUseCase.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'ext_bet1_' + crypto.randomUUID(),
        playerId,
        walletId: wallet.id,
        roundId: 'round_01',
        gameId: 'game_01',
        kind: 'BET',
        money: { amount: '40.00', currency: 'EUR' },
      },
      'idemp_bet1_' + crypto.randomUUID(),
      context,
    );

    // WIN: +60.00 EUR (CREDIT) -> balance 120.00
    await financialUseCase.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'ext_win1_' + crypto.randomUUID(),
        playerId,
        walletId: wallet.id,
        roundId: 'round_01',
        gameId: 'game_01',
        kind: 'WIN',
        money: { amount: '60.00', currency: 'EUR' },
      },
      'idemp_win1_' + crypto.randomUUID(),
      context,
    );

    // BET: -35.00 EUR (DEBIT) -> balance 85.00
    await financialUseCase.execute(
      {
        providerId: 'provider-a',
        externalTransactionId: 'ext_bet2_' + crypto.randomUUID(),
        playerId,
        walletId: wallet.id,
        roundId: 'round_02',
        gameId: 'game_01',
        kind: 'BET',
        money: { amount: '35.00', currency: 'EUR' },
      },
      'idemp_bet2_' + crypto.randomUUID(),
      context,
    );

    // 1 opening + 3 wagering = 4 checked entries
    const result = await reconciliationUseCase.reconcile(wallet.id);

    expect(result.walletId).toBe(wallet.id);
    expect(result.storedBalance).toEqual({ amount: '85.00', currency: 'EUR' });
    expect(result.calculatedBalance).toEqual({ amount: '85.00', currency: 'EUR' });
    expect(result.difference).toEqual({ amount: '0.00', currency: 'EUR' });
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(4);
  });

  test('reconciles boundary amounts at 0.01 and maximum NUMERIC(20,2)', async () => {
    // 1. Minimum positive monetary amount
    const walletMin = await walletUseCase.createWallet({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: '0.01', currency: 'USD' },
    });
    const resultMin = await reconciliationUseCase.reconcile(walletMin.id);
    expect(resultMin.storedBalance.amount).toBe('0.01');
    expect(resultMin.calculatedBalance.amount).toBe('0.01');
    expect(resultMin.difference.amount).toBe('0.00');
    expect(resultMin.consistent).toBe(true);
    expect(resultMin.checkedEntries).toBe(1);

    // 2. Maximum NUMERIC(20,2) amount allowed by schema (18 integer digits, 2 decimal places)
    const maxNumeric = '999999999999999999.99';
    const walletMax = await walletUseCase.createWallet({
      playerId: crypto.randomUUID(),
      initialBalance: { amount: maxNumeric, currency: 'USD' },
    });
    const resultMax = await reconciliationUseCase.reconcile(walletMax.id);
    expect(resultMax.storedBalance.amount).toBe(maxNumeric);
    expect(resultMax.calculatedBalance.amount).toBe(maxNumeric);
    expect(resultMax.difference.amount).toBe('0.00');
    expect(resultMax.consistent).toBe(true);
    expect(resultMax.checkedEntries).toBe(1);
  });
});

describe('Injected divergence via administrative fixture and read-only invariants', () => {
  async function footprint(walletId: string) {
    return appDb()
      .em.getConnection()
      .execute<Record<string, unknown>[]>(
        `SELECT
        (SELECT row_to_json(w) FROM wallets w WHERE w.id = ?) AS wallet,
        (SELECT json_agg(t ORDER BY t.id) FROM wager_transactions t
          WHERE t.wallet_id = ?) AS transactions,
        (SELECT json_agg(l ORDER BY l.id) FROM wallet_ledger_entries l
          WHERE l.wallet_id = ?) AS ledger,
        (SELECT json_agg(o ORDER BY o.id) FROM outbox_messages o
          WHERE o.aggregate_id = ?) AS outbox`,
        [walletId, walletId, walletId, walletId],
      );
  }

  test('detects positive and negative divergence, logs event without leaking financial payload, and preserves database read-only invariants', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await walletUseCase.createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const localTelemetry = new ReconciliationTelemetry();
    const localUseCase = new ReconciliationUseCase(runner, localTelemetry);

    const warnSpy = spyOn(Logger.prototype, 'warn');

    try {
      // 1. INJECT POSITIVE DIVERGENCE: storedBalance > calculatedBalance (+20.00)
      // Use transaction-local replica role on disposable database connection to bypass triggers
      await adminDb().em.getConnection().execute(`
        BEGIN;
        SET LOCAL session_replication_role = 'replica';
        UPDATE wallets SET balance = '120.00' WHERE id = '${wallet.id}';
        COMMIT;
      `);

      const beforePositive = await footprint(wallet.id);

      const correlationId = 'test-corr-pos-div-' + crypto.randomUUID();
      const posResult = await localUseCase.reconcile(wallet.id, correlationId);

      // Verify explicit divergence response
      expect(posResult.walletId).toBe(wallet.id);
      expect(posResult.consistent).toBe(false);
      expect(posResult.storedBalance).toEqual({ amount: '120.00', currency: 'BRL' });
      expect(posResult.calculatedBalance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(posResult.difference).toEqual({ amount: '20.00', currency: 'BRL' });
      expect(posResult.checkedEntries).toBe(1);

      // Verify Logger divergence event
      const divergenceWarning = warnSpy.mock.calls.find((call) => {
        const payload: unknown = call[0];
        return (
          typeof payload === 'object' &&
          payload !== null &&
          'event' in payload &&
          payload.event === 'wallet_reconciliation_divergence'
        );
      });
      expect(divergenceWarning).toBeDefined();
      const logPayload: unknown = divergenceWarning?.[0];
      expect(typeof logPayload === 'object' && logPayload !== null).toBe(true);
      if (typeof logPayload === 'object' && logPayload !== null) {
        expect('event' in logPayload && logPayload.event).toBe(
          'wallet_reconciliation_divergence',
        );
        expect('walletId' in logPayload && logPayload.walletId).toBe(wallet.id);
        expect('correlationId' in logPayload && logPayload.correlationId).toBe(
          correlationId,
        );
        expect('checkedEntries' in logPayload && logPayload.checkedEntries).toBe(1);

        // Strict check: divergence log must NOT leak financial payload/amounts
        expect('storedBalance' in logPayload).toBe(false);
        expect('calculatedBalance' in logPayload).toBe(false);
        expect('difference' in logPayload).toBe(false);
        expect('amount' in logPayload).toBe(false);
      }
      expect(localTelemetry.render()).toContain('wallet_reconciliation_total 1\n');
      expect(localTelemetry.render()).toContain(
        'wallet_reconciliation_divergence_total 1\n',
      );
      expect(await footprint(wallet.id)).toEqual(beforePositive);

      // 2. INJECT NEGATIVE DIVERGENCE: storedBalance < calculatedBalance (-15.00)
      await adminDb().em.getConnection().execute(`
        BEGIN;
        SET LOCAL session_replication_role = 'replica';
        UPDATE wallets SET balance = '85.00' WHERE id = '${wallet.id}';
        COMMIT;
      `);

      const beforeNegative = await footprint(wallet.id);
      const negResult = await localUseCase.reconcile(wallet.id);

      expect(negResult.walletId).toBe(wallet.id);
      expect(negResult.consistent).toBe(false);
      expect(negResult.storedBalance).toEqual({ amount: '85.00', currency: 'BRL' });
      expect(negResult.calculatedBalance).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(negResult.difference).toEqual({ amount: '-15.00', currency: 'BRL' });
      expect(negResult.checkedEntries).toBe(1);
      expect(localTelemetry.render()).toContain('wallet_reconciliation_total 2\n');
      expect(localTelemetry.render()).toContain(
        'wallet_reconciliation_divergence_total 2\n',
      );
      expect(await footprint(wallet.id)).toEqual(beforeNegative);
    } finally {
      // 3. RESTORE FIXTURE AND ENSURE TRIGGERS ACTIVE
      await adminDb().em.getConnection().execute(`
        BEGIN;
        SET LOCAL session_replication_role = 'replica';
        UPDATE wallets SET balance = '100.00' WHERE id = '${wallet.id}';
        COMMIT;
      `);
      warnSpy.mockRestore();
    }
  });
});

describe('Aggregate sum beyond NUMERIC(20,2) and safe-integer boundaries', () => {
  test('computes exact unconstrained sum and difference beyond NUMERIC(20,2) and beyond safe integer cents without truncation', async () => {
    const walletId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const tx1 = crypto.randomUUID();
    const tx2 = crypto.randomUUID();
    const tx3 = crypto.randomUUID();
    const entry1 = crypto.randomUUID();
    const entry2 = crypto.randomUUID();
    const entry3 = crypto.randomUUID();

    // Two credits of 999999999999999999.99 minus one debit of 25.00
    // Sum = 1999999999999999974.98 (19 digits before decimal - exceeds NUMERIC(20,2) 18 digits!)
    // Cents = 199999999999999997498 (exceeds Number.MAX_SAFE_INTEGER 9007199254740991)
    // To satisfy table check constraint chk_wallet_ledger_entries_arithmetic:
    // CREDIT requires balance_after = balance_before + amount (0.00 + amount = amount)
    // DEBIT requires balance_after = balance_before - amount (25.00 - 25.00 = 0.00)
    await adminDb().em.getConnection().execute(`
      BEGIN;
      SET LOCAL session_replication_role = 'replica';
      INSERT INTO wallets (id, player_id, currency, balance, version)
        VALUES ('${walletId}', '${playerId}', 'USD', 0.00, 1);

      INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, currency, kind, amount, status, round_id, game_id, result, processed_at)
        VALUES ('${tx1}', 'admin', 'ext_h1_${walletId}', 'idemp_h1_${walletId}', '0000000000000000000000000000000000000000000000000000000000000001', '${walletId}', '${playerId}', 'USD', 'WIN', 999999999999999999.99, 'PROCESSED', 'admin-round', 'admin-game', '{}', clock_timestamp());
      INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
        VALUES ('${entry1}', '${walletId}', '${tx1}', 1, 'CREDIT', 999999999999999999.99, 'USD', 0.00, 999999999999999999.99);

      INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, currency, kind, amount, status, round_id, game_id, result, processed_at)
        VALUES ('${tx2}', 'admin', 'ext_h2_${walletId}', 'idemp_h2_${walletId}', '0000000000000000000000000000000000000000000000000000000000000002', '${walletId}', '${playerId}', 'USD', 'WIN', 999999999999999999.99, 'PROCESSED', 'admin-round', 'admin-game', '{}', clock_timestamp());
      INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
        VALUES ('${entry2}', '${walletId}', '${tx2}', 2, 'CREDIT', 999999999999999999.99, 'USD', 0.00, 999999999999999999.99);

      INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, currency, kind, amount, status, round_id, game_id, result, processed_at)
        VALUES ('${tx3}', 'admin', 'ext_h3_${walletId}', 'idemp_h3_${walletId}', '0000000000000000000000000000000000000000000000000000000000000003', '${walletId}', '${playerId}', 'USD', 'BET', 25.00, 'PROCESSED', 'admin-round', 'admin-game', '{}', clock_timestamp());
      INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
        VALUES ('${entry3}', '${walletId}', '${tx3}', 3, 'DEBIT', 25.00, 'USD', 25.00, 0.00);
      COMMIT;
    `);

    const result = await reconciliationUseCase.reconcile(walletId);

    // Stored balance in wallet is 0.00
    expect(result.storedBalance.amount).toBe('0.00');
    // Calculated balance is unconstrained numeric sum
    expect(result.calculatedBalance.amount).toBe('1999999999999999974.98');
    // Difference is stored - calculated = 0.00 - 1999999999999999974.98
    expect(result.difference.amount).toBe('-1999999999999999974.98');
    expect(result.consistent).toBe(false);
    expect(result.checkedEntries).toBe(3);
  });
});

describe('Snapshot regression and atomic isolation under concurrent commit', () => {
  test('single aggregate query prevents torn snapshot when concurrent transaction commits during query execution', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await walletUseCase.createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'USD' },
    });

    const { promise: readerReturnedFromDb, resolve: notifyReaderReturned } =
      Promise.withResolvers<undefined>();
    const { promise: writerCommitted, resolve: notifyWriterCommitted } =
      Promise.withResolvers<undefined>();
    let intercepted = false;
    const observedRunner = new ObservedRunner(
      appDb(),
      { OPERATION_TIMEOUT_MS: 20000, DB_STATEMENT_TIMEOUT_MS: 10000 },
      async (connection, query, execute) => {
        const result = await execute(connection, query);
        const sql = statement(query);
        if (!intercepted && /^\s*SELECT\b/i.test(sql) && sql.includes('wallets')) {
          intercepted = true;
          notifyReaderReturned(undefined);
          await writerCommitted;
        }
        return result;
      },
    );
    const observedUseCase = new ReconciliationUseCase(observedRunner, telemetry);

    const reconciliationPromise = observedUseCase.reconcile(wallet.id);
    try {
      // 1. Initiate reconciliation read

      // 2. Wait until the single SELECT query has been executed by Postgres
      await readerReturnedFromDb;

      // 3. While read query response is held in the client interceptor, commit a valid BET write concurrently
      const context: FinancialContext = {
        providerId: 'provider-a',
        correlationId: 'corr-concurrent-bet',
      };
      await financialUseCase.execute(
        {
          providerId: 'provider-a',
          externalTransactionId: 'ext_conc_' + crypto.randomUUID(),
          playerId,
          walletId: wallet.id,
          roundId: 'round_conc',
          gameId: 'game_conc',
          kind: 'BET',
          money: { amount: '25.00', currency: 'USD' },
        },
        'idemp_conc_' + crypto.randomUUID(),
        context,
      );

      // 4. Release the read interceptor
      notifyWriterCommitted(undefined);

      // 5. Observe the reconciliation result
      const result = await reconciliationPromise;

      // The single SELECT query evaluated both stored balance and calculated sum atomically in the same snapshot
      // It returns the consistent pre-commit snapshot (100.00 / 100.00, 1 entry, difference 0.00)
      expect(result.consistent).toBe(true);
      expect(result.storedBalance.amount).toBe('100.00');
      expect(result.calculatedBalance.amount).toBe('100.00');
      expect(result.difference.amount).toBe('0.00');
      expect(result.checkedEntries).toBe(1);

      // A subsequent reconciliation after the commit observes the new consistent snapshot (75.00, 2 entries)
      const freshResult = await reconciliationUseCase.reconcile(wallet.id);
      expect(freshResult.consistent).toBe(true);
      expect(freshResult.storedBalance.amount).toBe('75.00');
      expect(freshResult.calculatedBalance.amount).toBe('75.00');
      expect(freshResult.difference.amount).toBe('0.00');
      expect(freshResult.checkedEntries).toBe(2);
    } finally {
      notifyWriterCommitted(undefined);
      await reconciliationPromise;
    }
  });
});

describe('Infrastructure failures and telemetry isolation', () => {
  test('infrastructure errors reject and do not increment completed or divergent metrics', async () => {
    const isolatedTelemetry = new ReconciliationTelemetry();
    const failingRunner = new ObservedRunner(
      appDb(),
      {
        DB_LOCK_TIMEOUT_MS: 50,
        DB_STATEMENT_TIMEOUT_MS: 100,
        DB_POOL_ACQUIRE_TIMEOUT_MS: 100,
        DB_CONNECT_TIMEOUT_MS: 100,
        OPERATION_TIMEOUT_MS: 1000,
        DB_TRANSACTION_MAX_ATTEMPTS: 1,
      },
      (connection, query, execute) => {
        const sql = statement(query);
        if (/^\s*SELECT\b/i.test(sql) && sql.includes('wallets')) {
          return execute(connection, { sql: 'SELECT pg_sleep(0.2)', bindings: [] });
        }
        return execute(connection, query);
      },
    );
    const failingUseCase = new ReconciliationUseCase(failingRunner, isolatedTelemetry);

    let thrown: unknown;
    try {
      await failingUseCase.reconcile(crypto.randomUUID());
    } catch (error) {
      thrown = error;
    }

    expectApplicationError(thrown, {
      category: 'ExternalConnectionError',
      code: 'DATABASE_STATEMENT_TIMEOUT',
    });

    // Verify telemetry metrics were NOT incremented
    const metricsText = isolatedTelemetry.render();
    expect(metricsText).toContain('wallet_reconciliation_total 0');
    expect(metricsText).toContain('wallet_reconciliation_divergence_total 0');
  });

  test('returns 404 WALLET_NOT_FOUND when wallet does not exist', async () => {
    const missingWalletId = crypto.randomUUID();
    let thrown: unknown;
    try {
      await reconciliationUseCase.reconcile(missingWalletId);
    } catch (error) {
      thrown = error;
    }

    expectApplicationError(thrown, {
      category: 'NotFoundError',
      code: 'WALLET_NOT_FOUND',
    });
  });

  test('returns 400 WALLET_ID_INVALID for malformed wallet UUID', async () => {
    let thrown: unknown;
    try {
      await reconciliationUseCase.reconcile('malformed-uuid-123');
    } catch (error) {
      thrown = error;
    }

    expectApplicationError(thrown, {
      category: 'ValidationError',
      code: 'WALLET_ID_INVALID',
    });
  });
});
