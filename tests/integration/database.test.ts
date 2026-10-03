import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { createDatabaseOptions } from '../../src/core/database/database.config.js';
import { translateDatabaseError } from '../../src/core/database/database.errors.js';
import { WalletRecord } from '../../src/domains/wallet/records/wallet.record.js';
import { WalletLedgerEntryRecord } from '../../src/domains/wallet/records/wallet-ledger-entry.record.js';
import { ApplicationError, type ErrorCategory } from '../../src/shared/errors.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

const environment = z
  .object({
    ADMIN_DATABASE_URL: z
      .url()
      .default('postgresql://postgres:postgres_local@127.0.0.1:55432/postgres'),
  })
  .parse(process.env);
const databaseName = 'jungle_it_' + crypto.randomUUID().replaceAll('-', '');
let admin: MikroORM | undefined;
let application: MikroORM | undefined;
let databaseCreated = false;

function applicationDatabase(): MikroORM {
  if (!application) throw new Error('Application database fixture has not initialized');
  return application;
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
  await application.migrator.down({ to: 0 });
  await application.migrator.up();
}, 60000);

afterAll(async () => {
  await application?.close(true);
  if (admin && databaseCreated) {
    await admin.em
      .getConnection()
      .execute('drop database ' + databaseName + ' with (force)');
  }
  await admin?.close(true);
});

interface ExpectedFailure {
  readonly sqlState: string;
  readonly category: ErrorCategory;
  readonly code: string;
  readonly constraint?: string;
}

async function expectDatabaseFailure(
  action: Promise<unknown>,
  expected: ExpectedFailure,
): Promise<ApplicationError> {
  let captured: unknown;
  try {
    await action;
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeDefined();

  const translated = translateDatabaseError(captured);
  const error = expectApplicationError(translated, {
    category: expected.category,
    code: expected.code,
  });

  const metadata = error.metadata as
    { sqlState?: string; constraint?: string } | undefined;
  expect(metadata?.sqlState).toBe(expected.sqlState);

  if (expected.constraint !== undefined) {
    expect(metadata?.constraint).toBe(expected.constraint);
  }

  return error;
}

async function openWallet(
  amount: string,
  currency = 'BRL',
): Promise<{ walletId: string; transactionId: string; playerId: string }> {
  const walletId = crypto.randomUUID();
  const transactionId = crypto.randomUUID();
  const playerId = crypto.randomUUID();
  await applicationDatabase()
    .em.fork()
    .transactional(async (em) => {
      await em.execute(
        'insert into wallets (id, player_id, currency, balance, version) values (?, ?, ?, ?, ?)',
        [walletId, playerId, currency, amount, '1'],
      );
      await em.execute(
        "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, kind, amount, currency, status, processed_at, result) select ?, '__internal__', ?, ?, ?, id, player_id, 'OPENING', ?, currency, 'PROCESSED', now(), ?::jsonb from wallets where id = ?",
        [
          transactionId,
          walletId,
          walletId,
          'a'.repeat(64),
          amount,
          JSON.stringify({
            status: 'PROCESSED',
            balance: { amount, currency },
          }),
          walletId,
        ],
      );
      await em.execute(
        "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'CREDIT', ?, ?, '0.00', ?, 1)",
        [crypto.randomUUID(), walletId, transactionId, amount, currency, amount],
      );
    });
  return { walletId, transactionId, playerId };
}

describe('database schema and integrity protections', () => {
  test('MikroORM preserves the maximum decimal amount after reversible migrations', async () => {
    const amount = '999999999999999999.99';
    const { walletId } = await openWallet(amount);
    const persisted = await applicationDatabase()
      .em.fork()
      .findOneOrFail(WalletRecord, { id: walletId });
    expect(
      z.object({ balance: z.literal(amount), version: z.literal('1') }).parse(persisted),
    ).toEqual({ balance: amount, version: '1' });
    const entry = await applicationDatabase()
      .em.fork()
      .findOneOrFail(WalletLedgerEntryRecord, { walletId });
    expect(
      z
        .object({
          amount: z.literal(amount),
          balanceBefore: z.literal('0.00'),
          balanceAfter: z.literal(amount),
          walletVersion: z.literal('1'),
        })
        .parse(entry),
    ).toEqual({
      amount,
      balanceBefore: '0.00',
      balanceAfter: amount,
      walletVersion: '1',
    });
  });

  test('rejects negative balance and balance updates without ledger', async () => {
    const { walletId } = await openWallet('100.00');
    await expectDatabaseFailure(
      applicationDatabase()
        .em.getConnection()
        .execute("update wallets set balance = '-0.01', version = 2 where id = ?", [
          walletId,
        ]),
      {
        sqlState: '23514',
        constraint: 'chk_wallets_balance_non_negative',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
    await expectDatabaseFailure(
      applicationDatabase()
        .em.getConnection()
        .execute("update wallets set balance = '101.00', version = 2 where id = ?", [
          walletId,
        ]),
      {
        sqlState: '23514',
        constraint: 'wallet_ledger_correspondence',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
    const rows: unknown = await applicationDatabase()
      .em.getConnection()
      .execute('select balance::text as balance from wallets where id = ?', [walletId]);
    expect(z.array(z.object({ balance: z.literal('100.00') })).parse(rows)).toEqual([
      { balance: '100.00' },
    ]);
  });

  test('cannot mutate, delete or truncate historical ledger via triggers', async () => {
    const { walletId } = await openWallet('100.00');
    await expectDatabaseFailure(
      applicationDatabase()
        .em.getConnection()
        .execute("update wallet_ledger_entries set amount = '1.00' where wallet_id = ?", [
          walletId,
        ]),
      {
        sqlState: '23514',
        constraint: 'ledger_immutable',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
    await expectDatabaseFailure(
      applicationDatabase()
        .em.getConnection()
        .execute('delete from wallet_ledger_entries where wallet_id = ?', [walletId]),
      {
        sqlState: '23514',
        constraint: 'ledger_immutable',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
    await expectDatabaseFailure(
      applicationDatabase().em.getConnection().execute('truncate wallet_ledger_entries'),
      {
        sqlState: '23514',
        constraint: 'ledger_immutable',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
  });

  test('cannot delete wager transactions via trigger', async () => {
    const { walletId } = await openWallet('100.00');
    const txId = crypto.randomUUID();
    await applicationDatabase()
      .em.getConnection()
      .execute(
        "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status) select ?, 'provider', ?, ?, ?, id, player_id, 'round', 'game', 'BET', '10.00', currency, 'PENDING' from wallets where id = ?",
        [txId, txId, txId, 'a'.repeat(64), walletId],
      );
    await expectDatabaseFailure(
      applicationDatabase()
        .em.getConnection()
        .execute('delete from wager_transactions where id = ?', [txId]),
      {
        sqlState: '23514',
        constraint: 'transaction_delete_prohibited',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
  });

  test('processed transactions cannot be reopened or rewritten', async () => {
    const { transactionId } = await openWallet('100.00');
    await expectDatabaseFailure(
      applicationDatabase()
        .em.getConnection()
        .execute(
          "update wager_transactions set status = 'PENDING', processed_at = null where id = ?",
          [transactionId],
        ),
      {
        sqlState: '23514',
        constraint: 'transaction_terminal_immutable',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
    await expectDatabaseFailure(
      applicationDatabase()
        .em.getConnection()
        .execute("update wager_transactions set result = '{}'::jsonb where id = ?", [
          transactionId,
        ]),
      {
        sqlState: '23514',
        constraint: 'transaction_terminal_immutable',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
  });

  test('player and currency cannot own a duplicate wallet', async () => {
    const playerId = crypto.randomUUID();
    const sql = applicationDatabase().em.getConnection();
    await sql.execute(
      "insert into wallets (id, player_id, currency, balance, version) values (?, ?, 'EUR', '0.00', 1)",
      [crypto.randomUUID(), playerId],
    );
    await expectDatabaseFailure(
      sql.execute(
        "insert into wallets (id, player_id, currency, balance, version) values (?, ?, 'EUR', '0.00', 1)",
        [crypto.randomUUID(), playerId],
      ),
      {
        sqlState: '23505',
        constraint: 'uq_wallets_player_currency',
        category: 'ConflictError',
        code: 'WALLET_ALREADY_EXISTS',
      },
    );
  });

  test('identities are unique within each provider', async () => {
    const walletId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const providerId = crypto.randomUUID();
    const sql = applicationDatabase().em.getConnection();
    await sql.execute(
      "insert into wallets (id, player_id, currency, balance, version) values (?, ?, 'BRL', '0.00', 1)",
      [walletId, playerId],
    );
    const insert =
      "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status) values (?, ?, ?, ?, ?, ?, ?, 'round', 'game', 'BET', '1.00', 'BRL', 'PENDING')";
    const values = [providerId, 'operation', 'key', 'a'.repeat(64), walletId, playerId];
    await sql.execute(insert, [crypto.randomUUID(), ...values]);
    await expectDatabaseFailure(
      sql.execute(insert, [
        crypto.randomUUID(),
        providerId,
        'different-operation',
        'key',
        'a'.repeat(64),
        walletId,
        playerId,
      ]),
      {
        sqlState: '23505',
        constraint: 'uq_wager_transactions_provider_key',
        category: 'ConflictError',
        code: 'WAGER_IDEMPOTENCY_KEY_ALREADY_EXISTS',
      },
    );
    await expectDatabaseFailure(
      sql.execute(insert, [
        crypto.randomUUID(),
        providerId,
        'operation',
        'different-key',
        'a'.repeat(64),
        walletId,
        playerId,
      ]),
      {
        sqlState: '23505',
        constraint: 'uq_wager_transactions_provider_external',
        category: 'ConflictError',
        code: 'WAGER_EXTERNAL_ID_ALREADY_EXISTS',
      },
    );
    await sql.execute(insert, [
      crypto.randomUUID(),
      crypto.randomUUID(),
      'operation',
      'key',
      'a'.repeat(64),
      walletId,
      playerId,
    ]);
  });

  test('commit evaluates final transaction status and matches the financial delta', async () => {
    const { walletId } = await openWallet('100.00');
    const transactionId = crypto.randomUUID();
    await applicationDatabase()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status) select ?, 'provider', ?, ?, ?, id, player_id, 'round', 'game', 'BET', '10.00', currency, 'PENDING' from wallets where id = ?",
          [transactionId, transactionId, transactionId, 'b'.repeat(64), walletId],
        );
        await em.execute(
          "update wallets set balance = '90.00', version = 2 where id = ?",
          [walletId],
        );
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '100.00', '90.00', 2)",
          [crypto.randomUUID(), walletId, transactionId],
        );
        await em.execute(
          "update wager_transactions set status = 'PROCESSED', processed_at = now(), result = ?::jsonb where id = ?",
          [
            JSON.stringify({
              status: 'PROCESSED',
              balance: { amount: '90.00', currency: 'BRL' },
            }),
            transactionId,
          ],
        );
      });
    const rows: unknown = await applicationDatabase()
      .em.getConnection()
      .execute(
        'select balance::text as balance, version::text as version from wallets where id = ?',
        [walletId],
      );
    expect(
      z
        .array(z.object({ balance: z.literal('90.00'), version: z.literal('2') }))
        .parse(rows),
    ).toEqual([{ balance: '90.00', version: '2' }]);
  });

  test('zero opening cannot skip wallet versions', async () => {
    await expectDatabaseFailure(
      applicationDatabase()
        .em.getConnection()
        .execute(
          "insert into wallets (id, player_id, currency, balance, version) values (?, ?, 'BRL', '0.00', 100)",
          [crypto.randomUUID(), crypto.randomUUID()],
        ),
      {
        sqlState: '23514',
        constraint: 'wallet_initial_version',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
    const { walletId } = await openWallet('100.00');
    await expectDatabaseFailure(
      applicationDatabase()
        .em.getConnection()
        .execute('update wallets set version = 100 where id = ?', [walletId]),
      {
        sqlState: '23514',
        constraint: 'wallet_balance_version',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
  });

  test('ledger cannot credit an unchanged zero-balance wallet', async () => {
    const walletId = crypto.randomUUID();
    const transactionId = crypto.randomUUID();
    const creditWithoutBalance = applicationDatabase()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          "insert into wallets (id, player_id, currency, balance, version) values (?, ?, 'BRL', '0.00', 1)",
          [walletId, crypto.randomUUID()],
        );
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, kind, amount, currency, status, processed_at, result) select ?, '__internal__', ?, ?, ?, id, player_id, 'OPENING', '100.00', currency, 'PROCESSED', now(), '{}'::jsonb from wallets where id = ?",
          [transactionId, transactionId, transactionId, 'c'.repeat(64), walletId],
        );
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'CREDIT', '100.00', 'BRL', '0.00', '100.00', 1)",
          [crypto.randomUUID(), walletId, transactionId],
        );
      });
    await expectDatabaseFailure(creditWithoutBalance, {
      sqlState: '23514',
      constraint: 'ledger_wallet_balance',
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });
  });

  test('pending payloads are immutable and PostgreSQL NaN is not money', async () => {
    const { walletId } = await openWallet('100.00');
    const transactionId = crypto.randomUUID();
    const sql = applicationDatabase().em.getConnection();
    const insert =
      "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status) select ?, 'provider', ?, ?, ?, id, player_id, 'round', 'game', 'BET', ?, currency, 'PENDING' from wallets where id = ?";
    await sql.execute(insert, [
      transactionId,
      transactionId,
      transactionId,
      'd'.repeat(64),
      '1.00',
      walletId,
    ]);
    await expectDatabaseFailure(
      sql.execute('update wager_transactions set payload_hash = ? where id = ?', [
        'e'.repeat(64),
        transactionId,
      ]),
      {
        sqlState: '23514',
        constraint: 'transaction_payload_immutable',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
    const invalidId = crypto.randomUUID();
    await expectDatabaseFailure(
      sql.execute(insert, [
        invalidId,
        invalidId,
        invalidId,
        'd'.repeat(64),
        'NaN',
        walletId,
      ]),
      {
        sqlState: '23514',
        constraint: 'chk_wager_transactions_amount_finite',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
  });

  test('LOSS stores supplied money and reference without changing balance or ledger', async () => {
    const { walletId } = await openWallet('100.00');
    const sql = applicationDatabase().em.getConnection();
    const betTxId = crypto.randomUUID();
    const betExtId = 'bet-' + crypto.randomUUID();

    // 1. Seed matching processed reference BET
    await applicationDatabase()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, result) select ?, 'provider', ?, ?, ?, id, player_id, 'round', 'game', 'BET', '10.00', currency, 'PROCESSED', now(), '{}'::jsonb from wallets where id = ?",
          [betTxId, betExtId, betExtId, 'a'.repeat(64), walletId],
        );
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '100.00', '90.00', 2)",
          [crypto.randomUUID(), walletId, betTxId],
        );
        await em.execute(
          "update wallets set balance = '90.00', version = 2 where id = ?",
          [walletId],
        );
      });

    // A supplied reference must resolve before the operation can be processed.
    const unrefLossId = crypto.randomUUID();
    await expectDatabaseFailure(
      sql.execute(
        "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, reference_external_transaction_id, result) select ?, 'provider', ?, ?, ?, id, player_id, 'round', 'game', 'LOSS', '99.00', currency, 'PROCESSED', now(), 'absent-reference', '{}'::jsonb from wallets where id = ?",
        [unrefLossId, unrefLossId, unrefLossId, 'f'.repeat(64), walletId],
      ),
      {
        sqlState: '23514',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );

    // 3. Resolved matching reference succeeds without changing balance or ledger
    const transactionId = crypto.randomUUID();
    await sql.execute(
      "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, reference_external_transaction_id, reference_transaction_id, result) select ?, 'provider', ?, ?, ?, id, player_id, 'round', 'game', 'LOSS', '99.00', currency, 'PROCESSED', now(), ?, ?, '{}'::jsonb from wallets where id = ?",
      [
        transactionId,
        transactionId,
        transactionId,
        'e'.repeat(64),
        betExtId,
        betTxId,
        walletId,
      ],
    );

    const rows: unknown = await sql.execute(
      'select balance::text as balance, version::text as version, (select count(*)::text from wallet_ledger_entries where wallet_id = wallets.id) as entries from wallets where id = ?',
      [walletId],
    );
    expect(
      z
        .array(
          z.object({
            balance: z.literal('90.00'),
            version: z.literal('2'),
            entries: z.literal('2'),
          }),
        )
        .parse(rows),
    ).toEqual([{ balance: '90.00', version: '2', entries: '2' }]);
  });

  test('deferred commit failure rolls back all intermediate operations', async () => {
    const { walletId } = await openWallet('100.00');
    const transactionId = crypto.randomUUID();

    const unledgeredBalanceUpdate = applicationDatabase()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status) select ?, 'provider', ?, ?, ?, id, player_id, 'round', 'game', 'BET', '20.00', currency, 'PENDING' from wallets where id = ?",
          [transactionId, transactionId, transactionId, '1'.repeat(64), walletId],
        );
        await em.execute(
          "update wallets set balance = '80.00', version = 2 where id = ?",
          [walletId],
        );
      });

    await expectDatabaseFailure(unledgeredBalanceUpdate, {
      sqlState: '23514',
      constraint: 'wallet_ledger_correspondence',
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });

    const walletRows: unknown = await applicationDatabase()
      .em.getConnection()
      .execute(
        'select balance::text as balance, version::text as version from wallets where id = ?',
        [walletId],
      );
    expect(
      z
        .array(z.object({ balance: z.literal('100.00'), version: z.literal('1') }))
        .parse(walletRows),
    ).toEqual([{ balance: '100.00', version: '1' }]);

    const txRows: unknown = await applicationDatabase()
      .em.getConnection()
      .execute('select count(*)::text as count from wager_transactions where id = ?', [
        transactionId,
      ]);
    expect(z.array(z.object({ count: z.literal('0') })).parse(txRows)).toEqual([
      { count: '0' },
    ]);

    const unledgeredProcessedTx = applicationDatabase()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, result) select ?, 'provider', ?, ?, ?, id, player_id, 'round', 'game', 'BET', '20.00', currency, 'PROCESSED', now(), '{}'::jsonb from wallets where id = ?",
          [transactionId, transactionId, transactionId, '2'.repeat(64), walletId],
        );
      });

    await expectDatabaseFailure(unledgeredProcessedTx, {
      sqlState: '23514',
      constraint: 'transaction_ledger_count',
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });
  });

  test('valid multi-step transition reaches correct final state with deferred constraints', async () => {
    const { walletId } = await openWallet('100.00');
    const betTxId = crypto.randomUUID();
    const winTxId = crypto.randomUUID();
    const refundTxId = crypto.randomUUID();
    const betExternalId = 'ext-bet-' + crypto.randomUUID();
    const winExternalId = 'ext-win-' + crypto.randomUUID();
    const refundExternalId = 'ext-refund-' + crypto.randomUUID();

    await applicationDatabase()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, result) select ?, 'provider', ?, ?, ?, id, player_id, 'round-1', 'game-1', 'BET', '30.00', currency, 'PROCESSED', now(), '{}'::jsonb from wallets where id = ?",
          [betTxId, betExternalId, betExternalId, '3'.repeat(64), walletId],
        );
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'DEBIT', '30.00', 'BRL', '100.00', '70.00', 2)",
          [crypto.randomUUID(), walletId, betTxId],
        );
        await em.execute(
          "update wallets set balance = '70.00', version = 2 where id = ?",
          [walletId],
        );

        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, reference_external_transaction_id, reference_transaction_id, processed_at, result) select ?, 'provider', ?, ?, ?, id, player_id, 'round-1', 'game-1', 'WIN', '50.00', currency, 'PROCESSED', ?, ?, now(), '{}'::jsonb from wallets where id = ?",
          [
            winTxId,
            winExternalId,
            winExternalId,
            '4'.repeat(64),
            betExternalId,
            betTxId,
            walletId,
          ],
        );
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'CREDIT', '50.00', 'BRL', '70.00', '120.00', 3)",
          [crypto.randomUUID(), walletId, winTxId],
        );

        await em.execute(
          "update wallets set balance = '120.00', version = 3 where id = ?",
          [walletId],
        );
      });

    const walletRows1: unknown = await applicationDatabase()
      .em.getConnection()
      .execute(
        'select balance::text as balance, version::text as version from wallets where id = ?',
        [walletId],
      );
    expect(
      z
        .array(z.object({ balance: z.literal('120.00'), version: z.literal('3') }))
        .parse(walletRows1),
    ).toEqual([{ balance: '120.00', version: '3' }]);

    await applicationDatabase()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, reference_external_transaction_id, reference_transaction_id, processed_at, result) select ?, 'provider', ?, ?, ?, id, player_id, 'round-1', 'game-1', 'REFUND', '30.00', currency, 'PROCESSED', ?, ?, now(), '{}'::jsonb from wallets where id = ?",
          [
            refundTxId,
            refundExternalId,
            refundExternalId,
            '5'.repeat(64),
            betExternalId,
            betTxId,
            walletId,
          ],
        );
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'CREDIT', '30.00', 'BRL', '120.00', '150.00', 4)",
          [crypto.randomUUID(), walletId, refundTxId],
        );
        await em.execute(
          "update wallets set balance = '150.00', version = 4 where id = ?",
          [walletId],
        );
      });

    const walletRows2: unknown = await applicationDatabase()
      .em.getConnection()
      .execute(
        'select balance::text as balance, version::text as version from wallets where id = ?',
        [walletId],
      );
    expect(
      z
        .array(z.object({ balance: z.literal('150.00'), version: z.literal('4') }))
        .parse(walletRows2),
    ).toEqual([{ balance: '150.00', version: '4' }]);

    const ledgerRows: unknown = await applicationDatabase()
      .em.getConnection()
      .execute(
        'select wallet_version::text as version, direction, amount::text as amount, balance_before::text as before, balance_after::text as after from wallet_ledger_entries where wallet_id = ? order by wallet_version asc',
        [walletId],
      );
    expect(
      z
        .array(
          z.object({
            version: z.string(),
            direction: z.string(),
            amount: z.string(),
            before: z.string(),
            after: z.string(),
          }),
        )
        .parse(ledgerRows),
    ).toEqual([
      {
        version: '1',
        direction: 'CREDIT',
        amount: '100.00',
        before: '0.00',
        after: '100.00',
      },
      {
        version: '2',
        direction: 'DEBIT',
        amount: '30.00',
        before: '100.00',
        after: '70.00',
      },
      {
        version: '3',
        direction: 'CREDIT',
        amount: '50.00',
        before: '70.00',
        after: '120.00',
      },
      {
        version: '4',
        direction: 'CREDIT',
        amount: '30.00',
        before: '120.00',
        after: '150.00',
      },
    ]);
  });

  test('ledger rejects non-opening kind for version one', async () => {
    const walletId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const txId = crypto.randomUUID();
    const failure = applicationDatabase()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          'insert into wallets (id, player_id, currency, balance, version) values (?, ?, ?, ?, ?)',
          [walletId, playerId, 'BRL', '10.00', '1'],
        );
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, result) values (?, 'provider', ?, ?, ?, ?, ?, 'round-1', 'game-1', 'WIN', '10.00', 'BRL', 'PROCESSED', now(), '{}'::jsonb)",
          [txId, txId, txId, '6'.repeat(64), walletId, playerId],
        );
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'CREDIT', '10.00', 'BRL', '0.00', '10.00', 1)",
          [crypto.randomUUID(), walletId, txId],
        );
        // Evaluates ledger validity immediately before commit to isolate ledger chain diagnostics from wallet correspondence.
        await em.execute('set constraints trg_ledger_entries_validity immediate');
      });
    await expectDatabaseFailure(failure, {
      sqlState: '23514',
      constraint: 'ledger_opening_kind',
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });
  });

  test('ledger rejects opening with non-zero initial balance', async () => {
    const walletId = crypto.randomUUID();
    const playerId = crypto.randomUUID();
    const txId = crypto.randomUUID();
    const failure = applicationDatabase()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          'insert into wallets (id, player_id, currency, balance, version) values (?, ?, ?, ?, ?)',
          [walletId, playerId, 'BRL', '10.00', '1'],
        );
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, kind, amount, currency, status, processed_at, result) values (?, 'provider', ?, ?, ?, ?, ?, 'OPENING', '5.00', 'BRL', 'PROCESSED', now(), '{}'::jsonb)",
          [txId, txId, txId, '7'.repeat(64), walletId, playerId],
        );
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'CREDIT', '5.00', 'BRL', '5.00', '10.00', 1)",
          [crypto.randomUUID(), walletId, txId],
        );
        // Evaluates ledger validity immediately before commit to isolate ledger chain diagnostics from wallet correspondence.
        await em.execute('set constraints trg_ledger_entries_validity immediate');
      });
    await expectDatabaseFailure(failure, {
      sqlState: '23514',
      constraint: 'ledger_opening_balance',
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });
  });

  test('ledger rejects broken predecessor balance in version chain', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const txId = crypto.randomUUID();
    const failure = applicationDatabase()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, result) values (?, 'provider', ?, ?, ?, ?, ?, 'round-1', 'game-1', 'BET', '10.00', 'BRL', 'PROCESSED', now(), '{}'::jsonb)",
          [txId, txId, txId, '8'.repeat(64), walletId, playerId],
        );
        await em.execute(
          "update wallets set balance = '85.00', version = 2 where id = ?",
          [walletId],
        );
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '95.00', '85.00', 2)",
          [crypto.randomUUID(), walletId, txId],
        );
        // Evaluates ledger validity immediately before commit to isolate ledger chain diagnostics from wallet correspondence.
        await em.execute('set constraints trg_ledger_entries_validity immediate');
      });
    await expectDatabaseFailure(failure, {
      sqlState: '23514',
      constraint: 'ledger_predecessor_balance',
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });
  });

  test('ledger rejects missing predecessor in version chain', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const txId = crypto.randomUUID();
    const failure = applicationDatabase()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          "update wallets set balance = '90.00', version = 2 where id = ?",
          [walletId],
        );
        await em.execute(
          "update wallets set balance = '80.00', version = 3 where id = ?",
          [walletId],
        );
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, result) values (?, 'provider', ?, ?, ?, ?, ?, 'round-1', 'game-1', 'BET', '10.00', 'BRL', 'PROCESSED', now(), '{}'::jsonb)",
          [txId, txId, txId, '9'.repeat(64), walletId, playerId],
        );
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '90.00', '80.00', 3)",
          [crypto.randomUUID(), walletId, txId],
        );
        // Evaluates ledger validity immediately before commit to isolate ledger chain diagnostics from wallet correspondence.
        await em.execute('set constraints trg_ledger_entries_validity immediate');
      });
    await expectDatabaseFailure(failure, {
      sqlState: '23514',
      constraint: 'ledger_predecessor_exists',
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });
  });

  test('ledger rejects successor balance mismatch', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const tx2Id = crypto.randomUUID();
    const tx3Id = crypto.randomUUID();
    const failure = applicationDatabase()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          "update wallets set balance = '85.00', version = 2 where id = ?",
          [walletId],
        );
        await em.execute(
          "update wallets set balance = '80.00', version = 3 where id = ?",
          [walletId],
        );
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, result) values (?, 'provider', ?, ?, ?, ?, ?, 'round-1', 'game-1', 'BET', '15.00', 'BRL', 'PROCESSED', now(), '{}'::jsonb)",
          [tx2Id, tx2Id, tx2Id, '0'.repeat(64), walletId, playerId],
        );
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, result) values (?, 'provider', ?, ?, ?, ?, ?, 'round-1', 'game-1', 'BET', '10.00', 'BRL', 'PROCESSED', now(), '{}'::jsonb)",
          [tx3Id, tx3Id, tx3Id, '1'.repeat(64), walletId, playerId],
        );
        // Inserts version 2 ledger entry before version 3.
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'DEBIT', '15.00', 'BRL', '100.00', '85.00', 2)",
          [crypto.randomUUID(), walletId, tx2Id],
        );
        // Inserts version 3 ledger entry with balance_before mismatching version 2 balance_after.
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '90.00', '80.00', 3)",
          [crypto.randomUUID(), walletId, tx3Id],
        );
        // Evaluates ledger validity immediately before commit to isolate ledger chain diagnostics from wallet correspondence.
        await em.execute('set constraints trg_ledger_entries_validity immediate');
      });
    await expectDatabaseFailure(failure, {
      sqlState: '23514',
      constraint: 'ledger_successor_balance',
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });
  });

  test('terminal and reference transitions protect wager transactions', async () => {
    const { walletId } = await openWallet('100.00');
    const sql = applicationDatabase().em.getConnection();

    const rejectedTxId = crypto.randomUUID();
    await sql.execute(
      "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, closed_at, failure_code, result) select ?, 'provider', ?, ?, ?, id, player_id, 'round', 'game', 'BET', '10.00', currency, 'REJECTED', now(), 'INSUFFICIENT_FUNDS', '{}'::jsonb from wallets where id = ?",
      [rejectedTxId, rejectedTxId, rejectedTxId, '2'.repeat(64), walletId],
    );
    await expectDatabaseFailure(
      sql.execute("update wager_transactions set status = 'PROCESSED' where id = ?", [
        rejectedTxId,
      ]),
      {
        sqlState: '23514',
        constraint: 'transaction_terminal_immutable',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
    await expectDatabaseFailure(
      sql.execute(
        "update wager_transactions set failure_code = 'ANOTHER_ERROR' where id = ?",
        [rejectedTxId],
      ),
      {
        sqlState: '23514',
        constraint: 'transaction_terminal_immutable',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );

    const failedTxId = crypto.randomUUID();
    await sql.execute(
      "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, closed_at, failure_code, result) select ?, 'provider', ?, ?, ?, id, player_id, 'round', 'game', 'BET', '10.00', currency, 'FAILED', now(), 'INTERNAL_TIMEOUT', '{}'::jsonb from wallets where id = ?",
      [failedTxId, failedTxId, failedTxId, '3'.repeat(64), walletId],
    );
    await expectDatabaseFailure(
      sql.execute(
        'update wager_transactions set result = \'{"modified": true}\'::jsonb where id = ?',
        [failedTxId],
      ),
      {
        sqlState: '23514',
        constraint: 'transaction_terminal_immutable',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );

    const pendingRefTxId = crypto.randomUUID();
    await sql.execute(
      "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, reference_external_transaction_id) select ?, 'provider', ?, ?, ?, id, player_id, 'round', 'game', 'REFUND', '10.00', currency, 'PENDING_REFERENCE', 'some-ref' from wallets where id = ?",
      [pendingRefTxId, pendingRefTxId, pendingRefTxId, '4'.repeat(64), walletId],
    );
    await expectDatabaseFailure(
      sql.execute("update wager_transactions set status = 'PENDING' where id = ?", [
        pendingRefTxId,
      ]),
      {
        sqlState: '23514',
        constraint: 'transaction_pending_reference_transition',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );

    const betTxId = crypto.randomUUID();
    const refundTxId1 = crypto.randomUUID();
    const refundTxId2 = crypto.randomUUID();
    const betExtId = 'ext-' + crypto.randomUUID();
    const refundExtId1 = 'ext-ref1-' + crypto.randomUUID();
    const refundExtId2 = 'ext-ref2-' + crypto.randomUUID();

    await applicationDatabase()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, result) select ?, 'provider', ?, ?, ?, id, player_id, 'round-2', 'game-2', 'BET', '10.00', currency, 'PROCESSED', now(), '{}'::jsonb from wallets where id = ?",
          [betTxId, betExtId, betExtId, '5'.repeat(64), walletId],
        );
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'DEBIT', '10.00', 'BRL', '100.00', '90.00', 2)",
          [crypto.randomUUID(), walletId, betTxId],
        );
        await em.execute(
          "update wallets set balance = '90.00', version = 2 where id = ?",
          [walletId],
        );
        await em.execute(
          "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, reference_external_transaction_id, reference_transaction_id, processed_at, result) select ?, 'provider', ?, ?, ?, id, player_id, 'round-2', 'game-2', 'REFUND', '10.00', currency, 'PROCESSED', ?, ?, now(), '{}'::jsonb from wallets where id = ?",
          [
            refundTxId1,
            refundExtId1,
            refundExtId1,
            '6'.repeat(64),
            betExtId,
            betTxId,
            walletId,
          ],
        );
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'CREDIT', '10.00', 'BRL', '90.00', '100.00', 3)",
          [crypto.randomUUID(), walletId, refundTxId1],
        );
        await em.execute(
          "update wallets set balance = '100.00', version = 3 where id = ?",
          [walletId],
        );
      });

    await expectDatabaseFailure(
      sql.execute(
        "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, reference_external_transaction_id, reference_transaction_id, processed_at, result) select ?, 'provider', ?, ?, ?, id, player_id, 'round-2', 'game-2', 'REFUND', '10.00', currency, 'PROCESSED', ?, ?, now(), '{}'::jsonb from wallets where id = ?",
        [
          refundTxId2,
          refundExtId2,
          refundExtId2,
          '7'.repeat(64),
          betExtId,
          betTxId,
          walletId,
        ],
      ),
      {
        sqlState: '23505',
        constraint: 'uq_wager_transactions_processed_reference_id',
        category: 'ConflictError',
        code: 'WAGER_REFERENCE_ALREADY_REVERSED',
      },
    );
  });

  test('typed database error adapter distinguishes integrity 500 from known uniqueness 422', async () => {
    const { walletId } = await openWallet('100.00');
    const sql = applicationDatabase().em.getConnection();

    // Isolated test for uq_wallet_ledger_entries_wallet_version:
    // Uses an unledgered PENDING transaction so uq_wallet_ledger_entries_tx_wallet does not collide.
    const pendingTxId = crypto.randomUUID();
    await sql.execute(
      "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status) select ?, 'provider', ?, ?, ?, id, player_id, 'round', 'game', 'BET', '10.00', currency, 'PENDING' from wallets where id = ?",
      [pendingTxId, pendingTxId, pendingTxId, '8'.repeat(64), walletId],
    );

    await expectDatabaseFailure(
      sql.execute(
        "insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version) values (?, ?, ?, 'CREDIT', '50.00', 'BRL', '0.00', '50.00', 1)",
        [crypto.randomUUID(), walletId, pendingTxId],
      ),
      {
        sqlState: '23505',
        constraint: 'uq_wallet_ledger_entries_wallet_version',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );

    await expectDatabaseFailure(
      sql.execute(
        "insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status) values (?, 'provider', ?, ?, ?, ?, ?, 'round', 'game', 'BET', '10.00', 'BRL', 'PENDING')",
        [
          crypto.randomUUID(),
          crypto.randomUUID(),
          crypto.randomUUID(),
          '9'.repeat(64),
          crypto.randomUUID(),
          crypto.randomUUID(),
        ],
      ),
      {
        sqlState: '23514',
        constraint: 'transaction_wallet_context',
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      },
    );
  });
});
