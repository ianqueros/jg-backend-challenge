import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { createDatabaseOptions } from '../../src/core/database/database.config.js';
import { DatabaseTransactionRunner } from '../../src/core/database/database-transaction.runner.js';
import { GuardedUpdateConflictError } from '../../src/core/database/database.errors.js';
import { TransactionRepositories } from '../../src/shared/transaction-repositories.js';
import { WalletRecord } from '../../src/domains/wallet/records/wallet.record.js';
import { WalletLedgerEntryRecord } from '../../src/domains/wallet/records/wallet-ledger-entry.record.js';
import { WagerTransactionRecord } from '../../src/domains/wagering/records/wager-transaction.record.js';
import { InboxMessageRecord } from '../../src/domains/inbox/records/inbox-message.record.js';
import { OutboxMessageRecord } from '../../src/domains/outbox/records/outbox-message.record.js';
import { ApplicationError } from '../../src/shared/errors.js';

const environment = z
  .object({
    ADMIN_DATABASE_URL: z
      .url()
      .default('postgresql://postgres:postgres_local@127.0.0.1:55432/postgres'),
  })
  .parse(process.env);

const databaseName = 'jungle_fdb_' + crypto.randomUUID().replaceAll('-', '');
let admin: MikroORM | undefined;
let application: MikroORM | undefined;
let databaseCreated = false;

function appDb(): MikroORM {
  if (application === undefined) {
    throw new Error('Application database not initialized');
  }
  return application;
}

function databaseUrl(user: string, password: string): string {
  const url = new URL(environment.ADMIN_DATABASE_URL);
  url.username = user;
  url.password = password;
  url.pathname = '/' + databaseName;
  return url.toString();
}

async function expectFailure<T extends Error>(
  action: Promise<unknown>,
  expectedType: { new (...args: string[]): T },
): Promise<T> {
  let captured: unknown;
  try {
    await action;
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(expectedType);
  if (!(captured instanceof expectedType)) {
    throw new Error(`Expected error to be instance of ${expectedType.name}`);
  }
  return captured;
}

async function expectConstraintFailure(action: Promise<unknown>): Promise<unknown> {
  let captured: unknown;
  try {
    await action;
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeDefined();
  return captured;
}

interface SeedWalletOptions {
  walletId?: string;
  playerId?: string;
  currency?: string;
  balance?: string;
}

interface SeededWallet {
  walletId: string;
  playerId: string;
  transactionId: string;
  currency: string;
  balance: string;
}

async function seedWallet(
  em: EntityManager,
  options: SeedWalletOptions = {},
): Promise<SeededWallet> {
  const walletId = options.walletId ?? crypto.randomUUID();
  const playerId = options.playerId ?? crypto.randomUUID();
  const currency = options.currency ?? 'BRL';
  const balance = options.balance ?? '100.00';
  const transactionId = crypto.randomUUID();
  const db = new TransactionRepositories(em);

  await db.walletRepository.insert({ id: walletId, playerId, currency, balance });
  await db.wagerTransactionRepository.reserveIdentity({
    id: transactionId,
    providerId: '__internal__',
    externalTransactionId: walletId,
    idempotencyKey: walletId,
    payloadHash: '0'.repeat(64),
    walletId,
    playerId,
    kind: 'OPENING',
    amount: balance,
    currency,
  });
  await db.wagerTransactionRepository.finalizeIfCurrent({
    id: transactionId,
    expectedStatus: 'PENDING',
    status: 'PROCESSED',
    result: { balance: { amount: balance, currency } },
  });
  if (balance !== '0.00') {
    await db.walletRepository.appendLedger({
      id: crypto.randomUUID(),
      walletId,
      transactionId,
      walletVersion: '1',
      direction: 'CREDIT',
      amount: balance,
      currency,
      balanceBefore: '0.00',
      balanceAfter: balance,
    });
  }
  return { walletId, playerId, transactionId, currency, balance };
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
}, 60000);

afterAll(async () => {
  await application?.close(true);
  if (admin !== undefined && databaseCreated) {
    await admin.em
      .getConnection()
      .execute('drop database ' + databaseName + ' with (force)');
  }
  await admin?.close(true);
});

describe('FinancialDatabase: guarded wallet updates and ledger invariants', () => {
  test('successfully applies guarded balance change with ledger entry and finished operation', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const betTxId = crypto.randomUUID();
    const ledgerId = crypto.randomUUID();

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const updated = await db.walletRepository.updateGuarded({
          id: seeded.walletId,
          currency: seeded.currency,
          expectedBalance: '100.00',
          expectedVersion: '1',
          balance: '70.00',
        });
        expect(updated.balance).toBe('70.00');
        expect(updated.version).toBe('2');

        const reservation = await db.wagerTransactionRepository.reserveIdentity({
          id: betTxId,
          providerId: 'provider_main',
          externalTransactionId: 'bet_ext_01',
          idempotencyKey: 'bet_key_01',
          payloadHash: '1'.repeat(64),
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'round_01',
          gameId: 'game_01',
          kind: 'BET',
          amount: '30.00',
          currency: seeded.currency,
        });
        expect(reservation.inserted).toBe(true);

        const finished = await db.wagerTransactionRepository.finalizeIfCurrent({
          id: betTxId,
          expectedStatus: 'PENDING',
          status: 'PROCESSED',
          result: { debited: '30.00', balanceAfter: '70.00' },
        });
        expect(finished).toBe(true);

        const ledger = await db.walletRepository.appendLedger({
          id: ledgerId,
          walletId: seeded.walletId,
          transactionId: betTxId,
          walletVersion: '2',
          direction: 'DEBIT',
          amount: '30.00',
          currency: seeded.currency,
          balanceBefore: '100.00',
          balanceAfter: '70.00',
        });
        expect(ledger.balanceAfter).toBe('70.00');
        expect(ledger.walletVersion).toBe('2');
      });

    const verifyEm = appDb().em.fork();
    const storedWallet = await verifyEm.findOneOrFail(WalletRecord, {
      id: seeded.walletId,
    });
    expect(storedWallet.balance).toBe('70.00');
    expect(storedWallet.version).toBe('2');

    const storedLedger = await verifyEm.findOneOrFail(WalletLedgerEntryRecord, {
      id: ledgerId,
    });
    expect(storedLedger.amount).toBe('30.00');
    expect(storedLedger.balanceBefore).toBe('100.00');
    expect(storedLedger.balanceAfter).toBe('70.00');

    const storedTx = await verifyEm.findOneOrFail(WagerTransactionRecord, {
      id: betTxId,
    });
    expect(storedTx.status).toBe('PROCESSED');
    expect(storedTx.processedAt).toBeInstanceOf(Date);
  });

  test('guard miss throws GuardedUpdateConflictError for stale version, balance, currency, negative candidate and zero delta', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);

        await expectFailure(
          db.walletRepository.updateGuarded({
            id: seeded.walletId,
            currency: seeded.currency,
            expectedBalance: '100.00',
            expectedVersion: '99',
            balance: '50.00',
          }),
          GuardedUpdateConflictError,
        );

        await expectFailure(
          db.walletRepository.updateGuarded({
            id: seeded.walletId,
            currency: seeded.currency,
            expectedBalance: '99.99',
            expectedVersion: '1',
            balance: '50.00',
          }),
          GuardedUpdateConflictError,
        );

        await expectFailure(
          db.walletRepository.updateGuarded({
            id: seeded.walletId,
            currency: 'USD',
            expectedBalance: '100.00',
            expectedVersion: '1',
            balance: '50.00',
          }),
          GuardedUpdateConflictError,
        );

        await expectFailure(
          db.walletRepository.updateGuarded({
            id: seeded.walletId,
            currency: seeded.currency,
            expectedBalance: '100.00',
            expectedVersion: '1',
            balance: '-10.00',
          }),
          GuardedUpdateConflictError,
        );

        await expectFailure(
          db.walletRepository.updateGuarded({
            id: seeded.walletId,
            currency: seeded.currency,
            expectedBalance: '100.00',
            expectedVersion: '1',
            balance: '100.00',
          }),
          GuardedUpdateConflictError,
        );
      });

    const verifyEm = appDb().em.fork();
    const untouched = await verifyEm.findOneOrFail(WalletRecord, { id: seeded.walletId });
    expect(untouched.balance).toBe('100.00');
    expect(untouched.version).toBe('1');
  });

  test('preserves the maximum decimal exactly across a guarded one-cent decrement', async () => {
    const maxDecimal = '999999999999999999.99';
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: maxDecimal }));

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const readWallet = await db.walletRepository.findById(seeded.walletId);
        expect(readWallet).toBeDefined();
        if (readWallet === undefined) {
          throw new Error('Wallet not found');
        }
        expect(readWallet.balance).toBe(maxDecimal);
        expect(readWallet.version).toBe('1');

        const targetBalance = '999999999999999999.98';
        const updated = await db.walletRepository.updateGuarded({
          id: seeded.walletId,
          currency: seeded.currency,
          expectedBalance: maxDecimal,
          expectedVersion: '1',
          balance: targetBalance,
        });
        expect(updated.balance).toBe(targetBalance);
        expect(updated.version).toBe('2');

        const txId = crypto.randomUUID();
        await db.wagerTransactionRepository.reserveIdentity({
          id: txId,
          providerId: 'provider_max',
          externalTransactionId: 'max_ext_01',
          idempotencyKey: 'max_key_01',
          payloadHash: '2'.repeat(64),
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'r_max',
          gameId: 'g_max',
          kind: 'BET',
          amount: '0.01',
          currency: seeded.currency,
        });
        await db.wagerTransactionRepository.finalizeIfCurrent({
          id: txId,
          expectedStatus: 'PENDING',
          status: 'PROCESSED',
          result: { ok: true },
        });
        await db.walletRepository.appendLedger({
          id: crypto.randomUUID(),
          walletId: seeded.walletId,
          transactionId: txId,
          walletVersion: '2',
          direction: 'DEBIT',
          amount: '0.01',
          currency: seeded.currency,
          balanceBefore: maxDecimal,
          balanceAfter: targetBalance,
        });
      });

    const verifyEm = appDb().em.fork();
    const persisted = await verifyEm.findOneOrFail(WalletRecord, { id: seeded.walletId });
    expect(persisted.balance).toBe('999999999999999999.98');
    expect(persisted.version).toBe('2');
  });

  test('hydrates and increments wallet and ledger BIGINT versions above the safe integer range exactly', async () => {
    const walletId = crypto.randomUUID();
    const version = '9007199254740993';
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        await em.execute(
          'create temporary table wallets (like public.wallets) on commit drop',
        );
        await em.execute(
          'insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, ?, ?, clock_timestamp(), clock_timestamp())',
          [walletId, crypto.randomUUID(), 'BRL', '0.02', version],
        );

        const db = new TransactionRepositories(em);
        const wallet = await db.walletRepository.findById(walletId);
        expect(wallet?.version).toBe(version);
        const updated = await db.walletRepository.updateGuarded({
          id: walletId,
          currency: 'BRL',
          expectedBalance: '0.02',
          expectedVersion: version,
          balance: '0.01',
        });
        expect(updated.balance).toBe('0.01');
        expect(updated.version).toBe('9007199254740994');

        await em.execute(
          'create temporary table wallet_ledger_entries (like public.wallet_ledger_entries) on commit drop',
        );
        const ledgerId = crypto.randomUUID();
        await em.execute(
          "insert into wallet_ledger_entries (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after, created_at) values (?, ?, ?, ?, 'CREDIT', '0.01', 'BRL', '0.00', '0.01', clock_timestamp())",
          [ledgerId, walletId, crypto.randomUUID(), version],
        );
        const ledger = await em.findOneOrFail(WalletLedgerEntryRecord, { id: ledgerId });
        expect(ledger.walletVersion).toBe(version);
      });
  });

  test('detached wallet mutation cannot bypass the guard or overwrite a native update on flush', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const transactionId = crypto.randomUUID();
    const ledgerId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    const runner = new DatabaseTransactionRunner(appDb());

    await runner.run(async (em) => {
      const db = new TransactionRepositories(em);
      const decision = await db.walletRepository.findById(seeded.walletId);
      if (decision === undefined) throw new Error('Wallet not found');
      decision.balance = '0.01';

      await expectFailure(
        db.walletRepository.updateGuarded({
          id: seeded.walletId,
          currency: seeded.currency,
          expectedBalance: decision.balance,
          expectedVersion: '1',
          balance: '0.00',
        }),
        GuardedUpdateConflictError,
      );

      const updated = await db.walletRepository.updateGuarded({
        id: seeded.walletId,
        currency: seeded.currency,
        expectedBalance: '100.00',
        expectedVersion: '1',
        balance: '70.00',
      });
      expect(updated.balance).toBe('70.00');
      expect(updated.version).toBe('2');

      updated.balance = '0.01';
      await db.wagerTransactionRepository.reserveIdentity({
        id: transactionId,
        providerId: 'provider_detached',
        externalTransactionId: transactionId,
        idempotencyKey: transactionId,
        payloadHash: '7'.repeat(64),
        walletId: seeded.walletId,
        playerId: seeded.playerId,
        roundId: 'round_detached',
        gameId: 'game_detached',
        kind: 'BET',
        amount: '30.00',
        currency: seeded.currency,
      });
      await db.wagerTransactionRepository.finalizeIfCurrent({
        id: transactionId,
        expectedStatus: 'PENDING',
        status: 'PROCESSED',
        result: { balance: '70.00' },
      });
      const ledger = await db.walletRepository.appendLedger({
        id: ledgerId,
        walletId: seeded.walletId,
        transactionId,
        walletVersion: '2',
        direction: 'DEBIT',
        amount: '30.00',
        currency: seeded.currency,
        balanceBefore: '100.00',
        balanceAfter: '70.00',
      });
      ledger.amount = '99.99';

      const sameAttempt = await db.walletRepository.findById(seeded.walletId);
      expect(sameAttempt?.balance).toBe('70.00');
      expect(sameAttempt?.version).toBe('2');

      const event = await db.outboxRepository.enqueue({
        id: outboxId,
        aggregateId: seeded.walletId,
        eventType: 'WalletBalanceChanged',
        payload: { balance: '70.00' },
      });
      event.payload = { balance: '0.01' };
    });

    const verifyEm = appDb().em.fork();
    const persisted = await verifyEm.findOneOrFail(WalletRecord, { id: seeded.walletId });
    expect(persisted.balance).toBe('70.00');
    expect(persisted.version).toBe('2');
    const persistedLedger = await verifyEm.findOneOrFail(WalletLedgerEntryRecord, {
      id: ledgerId,
    });
    expect(persistedLedger.amount).toBe('30.00');
    expect(persistedLedger.balanceAfter).toBe('70.00');
    const persistedTransaction = await verifyEm.findOneOrFail(WagerTransactionRecord, {
      id: transactionId,
    });
    expect(persistedTransaction.status).toBe('PROCESSED');
    const persistedOutbox = await verifyEm.findOneOrFail(OutboxMessageRecord, {
      id: outboxId,
    });
    expect(persistedOutbox.payload).toEqual({ balance: '70.00' });
  });
});

describe('FinancialDatabase: operation identities, collisions, and terminal snapshots', () => {
  test('reserves operation and preserves duplicate identities without overwrite', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '50.00' }));
    const opId1 = crypto.randomUUID();
    const opId2 = crypto.randomUUID();
    const opId3 = crypto.randomUUID();
    const opId4 = crypto.randomUUID();

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);

        const res1 = await db.wagerTransactionRepository.reserveIdentity({
          id: opId1,
          providerId: 'prov_idemp',
          externalTransactionId: 'ext_fixed_1',
          idempotencyKey: 'key_fixed_1',
          payloadHash: 'a'.repeat(64),
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'rnd_1',
          gameId: 'game_1',
          kind: 'BET',
          amount: '10.00',
          currency: seeded.currency,
        });
        expect(res1.inserted).toBe(true);
        expect(res1.byId?.id).toBe(opId1);
        expect(res1.byKey?.id).toBe(opId1);
        expect(res1.byExternal?.id).toBe(opId1);

        const res2 = await db.wagerTransactionRepository.reserveIdentity({
          id: opId2,
          providerId: 'prov_idemp',
          externalTransactionId: 'ext_other_2',
          idempotencyKey: 'key_fixed_1',
          payloadHash: 'b'.repeat(64),
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'rnd_1',
          gameId: 'game_1',
          kind: 'BET',
          amount: '10.00',
          currency: seeded.currency,
        });
        expect(res2.inserted).toBe(false);
        expect(res2.byKey?.id).toBe(opId1);
        expect(res2.byKey?.payloadHash).toBe('a'.repeat(64));
        expect(res2.byExternal).toBeUndefined();

        const res3 = await db.wagerTransactionRepository.reserveIdentity({
          id: opId3,
          providerId: 'prov_idemp',
          externalTransactionId: 'ext_fixed_1',
          idempotencyKey: 'key_other_3',
          payloadHash: 'c'.repeat(64),
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'rnd_1',
          gameId: 'game_1',
          kind: 'BET',
          amount: '10.00',
          currency: seeded.currency,
        });
        expect(res3.inserted).toBe(false);
        expect(res3.byExternal?.id).toBe(opId1);
        expect(res3.byKey).toBeUndefined();

        const res4 = await db.wagerTransactionRepository.reserveIdentity({
          id: opId4,
          providerId: 'prov_different',
          externalTransactionId: 'ext_fixed_1',
          idempotencyKey: 'key_fixed_1',
          payloadHash: 'd'.repeat(64),
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'rnd_1',
          gameId: 'game_1',
          kind: 'BET',
          amount: '10.00',
          currency: seeded.currency,
        });
        expect(res4.inserted).toBe(true);
        expect(res4.byId?.id).toBe(opId4);
      });

    const verifyEm = appDb().em.fork();
    const stored1 = await verifyEm.findOneOrFail(WagerTransactionRecord, { id: opId1 });
    expect(stored1.payloadHash).toBe('a'.repeat(64));
  });

  test('concurrent reservation elects single winner without transaction poisoning', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '50.00' }));
    const providerId = 'prov_race';
    const externalId = 'ext_race_01';
    const idempotencyKey = 'key_race_01';

    const forkA = appDb().em.fork();
    const forkB = appDb().em.fork();

    const [resA, resB] = await Promise.all([
      forkA.transactional(async (em) => {
        const db = new TransactionRepositories(em);
        return db.wagerTransactionRepository.reserveIdentity({
          id: crypto.randomUUID(),
          providerId,
          externalTransactionId: externalId,
          idempotencyKey,
          payloadHash: 'f'.repeat(64),
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'r_race',
          gameId: 'g_race',
          kind: 'BET',
          amount: '5.00',
          currency: seeded.currency,
        });
      }),
      forkB.transactional(async (em) => {
        const db = new TransactionRepositories(em);
        return db.wagerTransactionRepository.reserveIdentity({
          id: crypto.randomUUID(),
          providerId,
          externalTransactionId: externalId,
          idempotencyKey,
          payloadHash: 'f'.repeat(64),
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'r_race',
          gameId: 'g_race',
          kind: 'BET',
          amount: '5.00',
          currency: seeded.currency,
        });
      }),
    ]);

    expect(resA.inserted !== resB.inserted).toBe(true);
    const winnerId = resA.inserted ? resA.byId?.id : resB.byId?.id;
    expect(winnerId).toBeDefined();
    expect(resA.byKey?.id).toBe(winnerId);
    expect(resB.byKey?.id).toBe(winnerId);
  });

  test('preserves stored terminal result snapshot and rejects mutations on terminal operations', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '50.00' }));
    const txId = crypto.randomUUID();
    const terminalResult = { winAmount: '0.00', multiplier: 0, reason: 'dealer_won' };

    // 1. Commit terminal operation
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        await db.wagerTransactionRepository.reserveIdentity({
          id: txId,
          providerId: 'prov_snap',
          externalTransactionId: 'ext_snap_01',
          idempotencyKey: 'key_snap_01',
          payloadHash: 'e'.repeat(64),
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'r_snap',
          gameId: 'g_snap',
          kind: 'LOSS',
          amount: '0.00',
          currency: seeded.currency,
        });

        const finished = await db.wagerTransactionRepository.finalizeIfCurrent({
          id: txId,
          expectedStatus: 'PENDING',
          status: 'PROCESSED',
          result: terminalResult,
        });
        expect(finished).toBe(true);
      });

    // 2. Reject re-finish or re-pend on terminal
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const reFinished = await db.wagerTransactionRepository.finalizeIfCurrent({
          id: txId,
          expectedStatus: 'PENDING',
          status: 'PROCESSED',
          result: { modified: true },
        });
        expect(reFinished).toBe(false);

        const rePended = await db.wagerTransactionRepository.pendReference(
          txId,
          { status: 'PENDING_REFERENCE' },
          { ttlMs: 86400000, correlationId: txId },
        );
        expect(rePended).toBe(false);
      });

    // 3. Separate failing attempt in its own transaction (aborts without destroying fixture)
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        await expectConstraintFailure(
          em
            .getConnection()
            .execute(
              "UPDATE wager_transactions SET status = 'FAILED' WHERE id = ?",
              [txId],
              'all',
              em.getTransactionContext(),
            ),
        );
      });

    const verifyEm = appDb().em.fork();
    const stored = await verifyEm.findOneOrFail(WagerTransactionRecord, { id: txId });
    expect(stored.status).toBe('PROCESSED');
    expect(stored.result).toEqual(terminalResult);
  });

  test('handles conditional nonterminal transitions between PENDING and PENDING_REFERENCE', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '50.00' }));
    const txId = crypto.randomUUID();

    // 1. Commit valid PENDING -> PENDING_REFERENCE transition
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        await db.wagerTransactionRepository.reserveIdentity({
          id: txId,
          providerId: 'prov_pending',
          externalTransactionId: 'ext_pending_01',
          idempotencyKey: 'key_pending_01',
          payloadHash: '9'.repeat(64),
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'r_pend',
          gameId: 'g_pend',
          kind: 'BET',
          amount: '10.00',
          currency: seeded.currency,
        });

        const pended = await db.wagerTransactionRepository.pendReference(
          txId,
          { status: 'PENDING_REFERENCE' },
          { ttlMs: 86400000, correlationId: txId },
        );
        expect(pended).toBe(true);

        const rePended = await db.wagerTransactionRepository.pendReference(
          txId,
          { status: 'PENDING_REFERENCE' },
          { ttlMs: 86400000, correlationId: txId },
        );
        expect(rePended).toBe(false);
      });

    // 2. Separate failing attempt in its own transaction (aborts without destroying fixture)
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        await expectConstraintFailure(
          em
            .getConnection()
            .execute(
              "UPDATE wager_transactions SET status = 'PENDING' WHERE id = ?",
              [txId],
              'all',
              em.getTransactionContext(),
            ),
        );
      });

    const verifyEm = appDb().em.fork();
    const stored = await verifyEm.findOneOrFail(WagerTransactionRecord, { id: txId });
    expect(stored.status).toBe('PENDING_REFERENCE');
    expect(stored.referenceExpiresAt).toBeInstanceOf(Date);
  });
});

describe('FinancialDatabase: inbox deduplication and atomic processed marking', () => {
  test('deduplicates logical message and preserves original payload hash on collision', async () => {
    const consumerName = 'wager_consumer_v1';
    const messageId = 'msg_logical_001';
    const originalHash = '3'.repeat(64);
    const conflictingHash = '4'.repeat(64);

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);

        const res1 = await db.inboxRepository.reserveIdentity(
          consumerName,
          messageId,
          originalHash,
        );
        expect(res1.inserted).toBe(true);
        expect(res1.matches).toBe(true);
        expect(res1.message.payloadHash).toBe(originalHash);

        const res2 = await db.inboxRepository.reserveIdentity(
          consumerName,
          messageId,
          originalHash,
        );
        expect(res2.inserted).toBe(false);
        expect(res2.matches).toBe(true);
        expect(res2.message.payloadHash).toBe(originalHash);

        const res3 = await db.inboxRepository.reserveIdentity(
          consumerName,
          messageId,
          conflictingHash,
        );
        expect(res3.inserted).toBe(false);
        expect(res3.matches).toBe(false);
        expect(res3.message.payloadHash).toBe(originalHash);

        const resOther = await db.inboxRepository.reserveIdentity(
          'other_consumer',
          messageId,
          conflictingHash,
        );
        expect(resOther.inserted).toBe(true);
        expect(resOther.matches).toBe(true);
        expect(resOther.message.payloadHash).toBe(conflictingHash);
      });

    const verifyEm = appDb().em.fork();
    const stored = await verifyEm.findOneOrFail(InboxMessageRecord, {
      consumerName,
      messageId,
    });
    expect(stored.payloadHash).toBe(originalHash);
  });

  test('atomic markProcessed marks once and rejects mismatched hash or duplicate marking', async () => {
    const consumerName = 'wager_consumer_mark';
    const messageId = 'msg_logical_002';
    const validHash = '5'.repeat(64);

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        await db.inboxRepository.reserveIdentity(consumerName, messageId, validHash);

        const markedWrong = await db.inboxRepository.markProcessed(
          consumerName,
          messageId,
          '6'.repeat(64),
          new Date(),
        );
        expect(markedWrong).toBe(false);

        const markedGood = await db.inboxRepository.markProcessed(
          consumerName,
          messageId,
          validHash,
          new Date(),
        );
        expect(markedGood).toBe(true);

        const markedAgain = await db.inboxRepository.markProcessed(
          consumerName,
          messageId,
          validHash,
          new Date(),
        );
        expect(markedAgain).toBe(false);
      });

    const verifyEm = appDb().em.fork();
    const stored = await verifyEm.findOneOrFail(InboxMessageRecord, {
      consumerName,
      messageId,
    });
    expect(stored.processedAt).toBeInstanceOf(Date);
  });
});

describe('FinancialDatabase: outbox enqueue, claims, retries, and bounds validation', () => {
  test('enqueues outbox message with stable event ID and immutable payload', async () => {
    const outboxId = crypto.randomUUID();
    const aggregateId = crypto.randomUUID();
    const eventPayload = {
      wagerId: crypto.randomUUID(),
      amount: '50.00',
      currency: 'BRL',
      detail: { reason: 'win' },
    };

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const enqueued = await db.outboxRepository.enqueue({
          id: outboxId,
          aggregateId,
          eventType: 'WagerTransactionProcessed',
          payload: eventPayload,
        });
        expect(enqueued.id).toBe(outboxId);
        expect(enqueued.attempts).toBe(0);
        expect(enqueued.publishedAt).toBeNull();
        expect(enqueued.claimToken).toBeNull();
        expect(enqueued.occurredAt).toBeInstanceOf(Date);
        expect(enqueued.createdAt).toBeInstanceOf(Date);

        const found = await db.outboxRepository.findById(outboxId);
        expect(found).toBeDefined();
        expect(found?.payload).toEqual(eventPayload);
        expect(found?.attempts).toBe(enqueued.attempts);
        expect(found?.occurredAt.getTime()).toBe(enqueued.occurredAt.getTime());
        expect(found?.createdAt.getTime()).toBe(enqueued.createdAt.getTime());
      });

    const verifyEm = appDb().em.fork();
    const stored = await verifyEm.findOneOrFail(OutboxMessageRecord, { id: outboxId });
    expect(stored.payload).toEqual(eventPayload);
    expect(stored.attempts).toBe(0);
    expect(stored.publishedAt).toBeNull();
    expect(stored.claimToken).toBeNull();
  });

  test('a stale claimed event cannot overwrite a native publication when a managed insert flushes', async () => {
    const eventId = crypto.randomUUID();
    const aggregateId = crypto.randomUUID();
    const laterEventId = crypto.randomUUID();
    await appDb().em.getConnection().execute('delete from outbox_messages');
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        await new TransactionRepositories(em).outboxRepository.enqueue({
          id: eventId,
          aggregateId,
          eventType: 'ClaimThenPublish',
          payload: { state: 'queued' },
        });
      });

    const runner = new DatabaseTransactionRunner(appDb());
    await runner.run(async (em) => {
      const db = new TransactionRepositories(em);
      const [claimed] = await db.outboxRepository.claimDueEvents({
        limit: 1,
        leaseMs: 15000,
      });
      if (claimed?.id !== eventId || claimed.claimToken == null) {
        throw new Error('Expected the queued event to be claimed');
      }
      const claimToken = claimed.claimToken;
      expect(
        await db.outboxRepository.markPublishedIfOwned(eventId, claimToken, new Date()),
      ).toBe(true);

      claimed.attempts = 99;
      claimed.claimToken = claimToken;
      claimed.claimExpiresAt = new Date(Date.now() + 15000);
      claimed.publishedAt = null;

      const sameAttempt = await db.outboxRepository.findById(eventId);
      expect(sameAttempt?.publishedAt).toBeInstanceOf(Date);
      expect(sameAttempt?.claimToken).toBeNull();
      expect(sameAttempt?.attempts).toBe(0);

      const inserted = await db.outboxRepository.enqueue({
        id: laterEventId,
        aggregateId,
        eventType: 'LaterManagedInsert',
        payload: { state: 'queued' },
      });
      inserted.attempts = 88;
      inserted.publishedAt = new Date();
    });

    const verifyEm = appDb().em.fork();
    const published = await verifyEm.findOneOrFail(OutboxMessageRecord, { id: eventId });
    expect(published.publishedAt).toBeInstanceOf(Date);
    expect(published.claimToken).toBeNull();
    expect(published.claimExpiresAt).toBeNull();
    expect(published.attempts).toBe(0);
  });

  test('pending age includes leased and deferred events, excludes published history, and is zero when empty', async () => {
    // This suite owns an isolated database; no application history is removed.
    await appDb().em.getConnection().execute('DELETE FROM outbox_messages');
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        expect(await db.outboxRepository.pendingAgeSeconds()).toBe(0);
        const oldestId = crypto.randomUUID();
        const youngerId = crypto.randomUUID();
        await db.outboxRepository.enqueue({
          id: oldestId,
          aggregateId: crypto.randomUUID(),
          eventType: 'OldPendingEvent',
          payload: {},
          occurredAt: new Date(Date.now() - 60000),
        });
        await db.outboxRepository.enqueue({
          id: youngerId,
          aggregateId: crypto.randomUUID(),
          eventType: 'NewPendingEvent',
          payload: {},
          occurredAt: new Date(Date.now() - 10000),
        });

        const [oldest] = await db.outboxRepository.claimDueEvents({
          limit: 1,
          leaseMs: 30000,
        });
        const oldestToken = oldest?.claimToken;
        if (oldestToken == null) throw new Error('Oldest event claim is absent.');
        expect(oldest?.id).toBe(oldestId);
        const leasedAge = await db.outboxRepository.pendingAgeSeconds();
        expect(leasedAge).toBeGreaterThanOrEqual(59);
        expect(leasedAge).toBeLessThan(120);
        expect(
          await db.outboxRepository.markPublishedIfOwned(
            oldestId,
            oldestToken,
            new Date(),
          ),
        ).toBe(true);

        const [younger] = await db.outboxRepository.claimDueEvents({
          limit: 1,
          leaseMs: 30000,
        });
        const youngerToken = younger?.claimToken;
        if (youngerToken == null) throw new Error('Younger event claim is absent.');
        expect(younger?.id).toBe(youngerId);
        expect(
          await db.outboxRepository.scheduleRetryIfOwned(
            youngerId,
            youngerToken,
            60000,
            1,
          ),
        ).toBe(true);
        const deferredAge = await db.outboxRepository.pendingAgeSeconds();
        expect(deferredAge).toBeGreaterThanOrEqual(9);
        expect(deferredAge).toBeLessThan(30);
      });
  });

  test('validates claim and retry parameter bounds strictly with RangeError', async () => {
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);

        await expectFailure(
          db.outboxRepository.claimDueEvents({ limit: 0, leaseMs: 1000 }),
          RangeError,
        );
        await expectFailure(
          db.outboxRepository.claimDueEvents({ limit: 1001, leaseMs: 1000 }),
          RangeError,
        );
        await expectFailure(
          db.outboxRepository.claimDueEvents({ limit: 10, leaseMs: 0 }),
          RangeError,
        );
        await expectFailure(
          db.outboxRepository.claimDueEvents({ limit: 10, leaseMs: 300001 }),
          RangeError,
        );

        const fakeId = crypto.randomUUID();
        const fakeToken = crypto.randomUUID();
        await expectFailure(
          db.outboxRepository.scheduleRetryIfOwned(fakeId, fakeToken, -1, 1),
          RangeError,
        );
        await expectFailure(
          db.outboxRepository.scheduleRetryIfOwned(fakeId, fakeToken, 300001, 1),
          RangeError,
        );

        await expectFailure(
          db.wagerTransactionRepository.claimReferences({ limit: 0, leaseMs: 1000 }),
          RangeError,
        );
        await expectFailure(
          db.wagerTransactionRepository.claimReferences({ limit: 1001, leaseMs: 1000 }),
          RangeError,
        );
        await expectFailure(
          db.wagerTransactionRepository.claimReferences({ limit: 10, leaseMs: 0 }),
          RangeError,
        );
        await expectFailure(
          db.wagerTransactionRepository.claimReferences({ limit: 10, leaseMs: 300001 }),
          RangeError,
        );
        await expectFailure(
          db.wagerTransactionRepository.rescheduleReference(
            fakeId,
            fakeToken,
            -1,
            'waiting',
          ),
          RangeError,
        );
        await expectFailure(
          db.wagerTransactionRepository.rescheduleReference(
            fakeId,
            fakeToken,
            300001,
            'waiting',
          ),
          RangeError,
        );
      });
  });

  test('concurrent SKIP LOCKED claims partition work disjointly using deterministic barrier', async () => {
    // Clear outbox to ensure only this test's messages are in the claim queue
    await appDb().em.getConnection().execute('DELETE FROM outbox_messages');

    const msgIds = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        for (const id of msgIds) {
          await db.outboxRepository.enqueue({
            id,
            aggregateId: crypto.randomUUID(),
            eventType: 'WagerEvent',
            payload: { id },
          });
        }
      });

    const forkA = appDb().em.fork();
    const forkB = appDb().em.fork();

    const readyA = Promise.withResolvers<undefined>();
    const readyB = Promise.withResolvers<undefined>();

    let claimedA: OutboxMessageRecord[] = [];
    let claimedB: OutboxMessageRecord[] = [];

    try {
      await Promise.all([
        forkA.transactional(async (em) => {
          const db = new TransactionRepositories(em);
          claimedA = await db.outboxRepository.claimDueEvents({
            limit: 2,
            leaseMs: 15000,
          });
          readyA.resolve(undefined);
          await readyB.promise;
        }),
        forkB.transactional(async (em) => {
          const db = new TransactionRepositories(em);
          await readyA.promise;
          claimedB = await db.outboxRepository.claimDueEvents({
            limit: 2,
            leaseMs: 15000,
          });
          readyB.resolve(undefined);
        }),
      ]);
    } finally {
      await appDb()
        .em.fork()
        .transactional(async (em) => {
          const db = new TransactionRepositories(em);
          for (const msg of [...claimedA, ...claimedB]) {
            const token = msg.claimToken;
            if (typeof token === 'string') {
              await db.outboxRepository.releaseIfOwned(msg.id, token);
            }
          }
        });
    }

    expect(claimedA.length).toBe(2);
    expect(claimedB.length).toBe(2);
    const claimedAIds = claimedA.map((m) => m.id);
    const claimedBIds = claimedB.map((m) => m.id);
    for (const id of claimedAIds) {
      expect(claimedBIds.includes(id)).toBe(false);
    }
  });

  test('expired outbox claim is recovered and stale token actions are rejected without wall clock timers', async () => {
    // Isolate outbox queue
    await appDb().em.getConnection().execute('DELETE FROM outbox_messages');

    const outboxId = crypto.randomUUID();

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        await db.outboxRepository.enqueue({
          id: outboxId,
          aggregateId: crypto.randomUUID(),
          eventType: 'RecoverableEvent',
          payload: { target: 'recovery' },
        });
      });

    let firstToken: string | undefined;

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const claims = await db.outboxRepository.claimDueEvents({
          limit: 1,
          leaseMs: 10000,
        });
        expect(claims.length).toBe(1);
        const claimed = claims[0];
        expect(claimed?.id).toBe(outboxId);
        const token = claimed?.claimToken;
        if (typeof token !== 'string') {
          throw new Error('Claim token missing');
        }
        firstToken = token;
      });

    if (firstToken === undefined) {
      throw new Error('First token missing');
    }
    const staleToken = firstToken;

    // Advance lease expiration deterministically in database time; token is present so chk_outbox_claim_pair holds
    await appDb()
      .em.getConnection()
      .execute(
        "UPDATE outbox_messages SET claim_expires_at = clock_timestamp() - interval '1 second' WHERE id = ?",
        [outboxId],
      );

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const published = await db.outboxRepository.markPublishedIfOwned(
          outboxId,
          staleToken,
          new Date(),
        );
        expect(published).toBe(false);

        const retried = await db.outboxRepository.scheduleRetryIfOwned(
          outboxId,
          staleToken,
          1000,
          1,
        );
        expect(retried).toBe(false);

        const released = await db.outboxRepository.releaseIfOwned(outboxId, staleToken);
        expect(released).toBe(false);
      });

    let recoveredToken: string | undefined;
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const recovered = await db.outboxRepository.claimDueEvents({
          limit: 1,
          leaseMs: 15000,
        });
        expect(recovered.length).toBe(1);
        const recMsg = recovered[0];
        const token = recMsg?.claimToken;
        if (typeof token !== 'string') {
          throw new Error('Recovered token missing');
        }
        recoveredToken = token;
        expect(recoveredToken).not.toBe(firstToken);

        const published = await db.outboxRepository.markPublishedIfOwned(
          outboxId,
          recoveredToken,
          new Date(),
        );
        expect(published).toBe(true);
      });

    const verifyEm = appDb().em.fork();
    const stored = await verifyEm.findOneOrFail(OutboxMessageRecord, { id: outboxId });
    expect(stored.publishedAt).toBeInstanceOf(Date);
    expect(stored.claimToken).toBeNull();
  });
});

describe('FinancialDatabase: reference claims, scheduling and deadline anchor', () => {
  test('claim increments reference attempts, respects 24h deadline anchor and excludes terminal ops', async () => {
    // Finish any prior pending reference rows so this test owns the reference queue
    await appDb()
      .em.getConnection()
      .execute(
        "UPDATE wager_transactions SET status = 'REJECTED', closed_at = clock_timestamp(), failure_code = 'CLEANUP', result = '{}'::jsonb, reference_claim_token = NULL, reference_claim_expires_at = NULL WHERE status = 'PENDING_REFERENCE' OR reference_claim_token IS NOT NULL",
      );

    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '50.00' }));
    const txId = crypto.randomUUID();

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        await db.wagerTransactionRepository.reserveIdentity({
          id: txId,
          providerId: 'prov_ref',
          externalTransactionId: 'ext_ref_01',
          idempotencyKey: 'key_ref_01',
          payloadHash: '7'.repeat(64),
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'r_ref',
          gameId: 'g_ref',
          kind: 'BET',
          amount: '10.00',
          currency: seeded.currency,
        });
        await db.wagerTransactionRepository.pendReference(
          txId,
          { status: 'PENDING_REFERENCE' },
          { ttlMs: 86400000, correlationId: txId },
        );
      });

    let originalDeadline: Date | undefined;
    let claimToken: string | undefined;

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const claims = await db.wagerTransactionRepository.claimReferences({
          limit: 1,
          leaseMs: 15000,
        });
        expect(claims.length).toBe(1);
        const claim = claims[0];
        const token = claim?.referenceClaimToken;
        if (typeof token !== 'string') {
          throw new Error('Claim token missing');
        }
        expect(claim?.referenceAttempts).toBe(1);
        claimToken = token;
        originalDeadline = claim?.referenceExpiresAt ?? undefined;
      });

    if (claimToken === undefined || originalDeadline === undefined) {
      throw new Error('Claim state missing');
    }
    const originalToken = claimToken;

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const rescheduled = await db.wagerTransactionRepository.rescheduleReference(
          txId,
          originalToken,
          0,
          'waiting',
        );
        expect(rescheduled).toBe(true);
      });

    let secondToken: string | undefined;
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const claims = await db.wagerTransactionRepository.claimReferences({
          limit: 1,
          leaseMs: 15000,
        });
        expect(claims.length).toBe(1);
        const claim = claims[0];
        const token = claim?.referenceClaimToken;
        if (typeof token !== 'string') {
          throw new Error('Claim token missing');
        }
        expect(claim?.referenceAttempts).toBe(2);
        expect(claim?.referenceExpiresAt?.getTime()).toBe(originalDeadline?.getTime());
        secondToken = token;

        const finished = await db.wagerTransactionRepository.finalizeIfCurrent({
          id: txId,
          expectedStatus: 'PENDING_REFERENCE',
          status: 'REJECTED',
          failureCode: 'REFERENCE_NOT_FOUND',
          result: { reason: 'timed_out' },
          token: secondToken,
        });
        expect(finished).toBe(true);
      });

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const claims = await db.wagerTransactionRepository.claimReferences({
          limit: 10,
          leaseMs: 15000,
        });
        const foundTerminal = claims.find((c) => c.id === txId);
        expect(foundTerminal).toBeUndefined();
      });

    const verifyEm = appDb().em.fork();
    const stored = await verifyEm.findOneOrFail(WagerTransactionRecord, { id: txId });
    expect(stored.status).toBe('REJECTED');
    expect(stored.referenceClaimToken).toBeNull();
  });

  test('reference scheduling survives across fresh MikroORM instances', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '50.00' }));
    const txId = crypto.randomUUID();

    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        await db.wagerTransactionRepository.reserveIdentity({
          id: txId,
          providerId: 'prov_orm',
          externalTransactionId: 'ext_orm_01',
          idempotencyKey: 'key_orm_01',
          payloadHash: '8'.repeat(64),
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'r_orm',
          gameId: 'g_orm',
          kind: 'BET',
          amount: '10.00',
          currency: seeded.currency,
        });
        await db.wagerTransactionRepository.pendReference(
          txId,
          { status: 'PENDING_REFERENCE' },
          { ttlMs: 86400000, correlationId: txId },
        );
      });

    const freshOrm = await MikroORM.init(
      createDatabaseOptions(databaseUrl('jungle_main', 'main_local'), {
        DB_STATEMENT_TIMEOUT_MS: 10000,
        OPERATION_TIMEOUT_MS: 20000,
      }),
    );

    try {
      await freshOrm.em.fork().transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const readTx = await db.wagerTransactionRepository.findById(txId);
        expect(readTx).toBeDefined();
        expect(readTx?.status).toBe('PENDING_REFERENCE');
        expect(readTx?.referenceExpiresAt).toBeInstanceOf(Date);
        expect(readTx?.referenceAttempts).toBe(0);
      });
    } finally {
      await freshOrm.close(true);
    }
  });

  test('accepted reference deadline and event provenance cannot be replaced or cleared', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '0.00' }));
    const txId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const causationId = crypto.randomUUID();
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        await db.wagerTransactionRepository.reserveIdentity({
          id: txId,
          providerId: 'reference-identity',
          externalTransactionId: txId,
          idempotencyKey: txId,
          payloadHash: '9'.repeat(64),
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'round',
          gameId: 'game',
          kind: 'LOSS',
          amount: '0.00',
          currency: seeded.currency,
        });
        await db.wagerTransactionRepository.pendReference(
          txId,
          { status: 'PENDING_REFERENCE' },
          { ttlMs: 86400000, correlationId, causationId },
        );
      });

    const sql = appDb().em.getConnection();
    const assignments = [
      "reference_expires_at = reference_expires_at + interval '1 hour'",
      'reference_expires_at = NULL',
      "reference_correlation_id = 'replacement'",
      'reference_correlation_id = NULL',
      "reference_causation_id = 'replacement'",
      'reference_causation_id = NULL',
    ];
    for (const assignment of assignments) {
      const error = await expectConstraintFailure(
        sql.execute(`UPDATE wager_transactions SET ${assignment} WHERE id = ?`, [txId]),
      );
      expect(error).toMatchObject({ code: '23514' });
    }
    const stored = await appDb()
      .em.fork()
      .findOneOrFail(WagerTransactionRecord, { id: txId });
    expect(stored.status).toBe('PENDING_REFERENCE');
    expect(stored.referenceCorrelationId).toBe(correlationId);
    expect(stored.referenceCausationId).toBe(causationId);
  });
});

describe('FinancialDatabase: multi-store composition with DatabaseTransactionRunner', () => {
  test('composes wallet, operation, ledger, inbox and outbox in single committed transaction', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const runner = new DatabaseTransactionRunner(appDb());
    const txId = crypto.randomUUID();
    const ledgerId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    const consumerName = 'runner_consumer';
    const messageId = 'runner_msg_01';
    const hash = 'a1b2'.repeat(16);

    await runner.run(async (em) => {
      const db = new TransactionRepositories(em);

      await db.walletRepository.updateGuarded({
        id: seeded.walletId,
        currency: seeded.currency,
        expectedBalance: '100.00',
        expectedVersion: '1',
        balance: '60.00',
      });

      await db.wagerTransactionRepository.reserveIdentity({
        id: txId,
        providerId: 'prov_runner',
        externalTransactionId: 'ext_runner_01',
        idempotencyKey: 'key_runner_01',
        payloadHash: hash,
        walletId: seeded.walletId,
        playerId: seeded.playerId,
        roundId: 'r_run',
        gameId: 'g_run',
        kind: 'BET',
        amount: '40.00',
        currency: seeded.currency,
      });
      await db.wagerTransactionRepository.finalizeIfCurrent({
        id: txId,
        expectedStatus: 'PENDING',
        status: 'PROCESSED',
        result: { balance: '60.00' },
      });

      await db.walletRepository.appendLedger({
        id: ledgerId,
        walletId: seeded.walletId,
        transactionId: txId,
        walletVersion: '2',
        direction: 'DEBIT',
        amount: '40.00',
        currency: seeded.currency,
        balanceBefore: '100.00',
        balanceAfter: '60.00',
      });

      await db.inboxRepository.reserveIdentity(consumerName, messageId, hash);
      await db.inboxRepository.markProcessed(consumerName, messageId, hash, new Date());

      await db.outboxRepository.enqueue({
        id: outboxId,
        aggregateId: seeded.walletId,
        eventType: 'WalletBalanceChanged',
        payload: { walletId: seeded.walletId, balance: '60.00' },
      });
    });

    const verifyEm = appDb().em.fork();
    const wallet = await verifyEm.findOneOrFail(WalletRecord, { id: seeded.walletId });
    expect(wallet.balance).toBe('60.00');
    expect(wallet.version).toBe('2');

    const ledger = await verifyEm.findOneOrFail(WalletLedgerEntryRecord, {
      id: ledgerId,
    });
    expect(ledger.balanceAfter).toBe('60.00');

    const tx = await verifyEm.findOneOrFail(WagerTransactionRecord, { id: txId });
    expect(tx.status).toBe('PROCESSED');

    const inbox = await verifyEm.findOneOrFail(InboxMessageRecord, {
      consumerName,
      messageId,
    });
    expect(inbox.processedAt).toBeInstanceOf(Date);

    const outbox = await verifyEm.findOneOrFail(OutboxMessageRecord, { id: outboxId });
    expect(outbox.aggregateId).toBe(seeded.walletId);
  });

  test('rolls back entire composition atomically on error leaving zero side effects', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const runner = new DatabaseTransactionRunner(appDb());
    const txId = crypto.randomUUID();
    const ledgerId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    const consumerName = 'rollback_consumer';
    const messageId = 'rollback_msg_01';
    const hash = 'c3d4'.repeat(16);

    const rollbackError = new Error('Intentional abort of financial composition');

    let captured: unknown;
    try {
      await runner.run(async (em) => {
        const db = new TransactionRepositories(em);

        await db.walletRepository.updateGuarded({
          id: seeded.walletId,
          currency: seeded.currency,
          expectedBalance: '100.00',
          expectedVersion: '1',
          balance: '50.00',
        });

        await db.wagerTransactionRepository.reserveIdentity({
          id: txId,
          providerId: 'prov_abort',
          externalTransactionId: 'ext_abort_01',
          idempotencyKey: 'key_abort_01',
          payloadHash: hash,
          walletId: seeded.walletId,
          playerId: seeded.playerId,
          roundId: 'r_abort',
          gameId: 'g_abort',
          kind: 'BET',
          amount: '50.00',
          currency: seeded.currency,
        });

        await db.walletRepository.appendLedger({
          id: ledgerId,
          walletId: seeded.walletId,
          transactionId: txId,
          walletVersion: '2',
          direction: 'DEBIT',
          amount: '50.00',
          currency: seeded.currency,
          balanceBefore: '100.00',
          balanceAfter: '50.00',
        });

        await db.inboxRepository.reserveIdentity(consumerName, messageId, hash);

        await db.outboxRepository.enqueue({
          id: outboxId,
          aggregateId: seeded.walletId,
          eventType: 'WagerAborted',
          payload: { aborted: true },
        });

        throw rollbackError;
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(ApplicationError);
    if (captured instanceof ApplicationError) {
      expect(captured.code).toBe('DATABASE_OPERATION_FAILED');
      expect(captured.cause).toBe(rollbackError);
    }

    const verifyEm = appDb().em.fork();
    const wallet = await verifyEm.findOneOrFail(WalletRecord, { id: seeded.walletId });
    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe('1');

    const ledger = await verifyEm.findOne(WalletLedgerEntryRecord, { id: ledgerId });
    expect(ledger).toBeNull();

    const tx = await verifyEm.findOne(WagerTransactionRecord, { id: txId });
    expect(tx).toBeNull();

    const inbox = await verifyEm.findOne(InboxMessageRecord, { consumerName, messageId });
    expect(inbox).toBeNull();

    const outbox = await verifyEm.findOne(OutboxMessageRecord, { id: outboxId });
    expect(outbox).toBeNull();
  });

  test('a managed insert from a rolled-back attempt cannot leak into a fresh retry', async () => {
    const runner = new DatabaseTransactionRunner(appDb(), {
      DB_TRANSACTION_MAX_ATTEMPTS: 2,
      DB_RETRY_BASE_DELAY_MS: 5,
      DB_RETRY_MAX_DELAY_MS: 10,
    });
    const eventId = crypto.randomUUID();
    const aggregateId = crypto.randomUUID();
    const attemptsSeen: number[] = [];

    await runner.run(async (em, context) => {
      attemptsSeen.push(context.attempt);
      await new TransactionRepositories(em).outboxRepository.enqueue({
        id: eventId,
        aggregateId,
        eventType: 'RetryStateIsolation',
        payload: { attempt: context.attempt },
      });
      if (context.attempt === 1) throw new GuardedUpdateConflictError();
    });

    expect(attemptsSeen).toEqual([1, 2]);
    const persisted = await appDb()
      .em.fork()
      .findOneOrFail(OutboxMessageRecord, { id: eventId });
    expect(persisted.payload).toEqual({ attempt: 2 });
    expect(persisted.aggregateId).toBe(aggregateId);
  });

  test('managed insert flush respects the statement timeout and rolls back', async () => {
    const fixtureSql = appDb().em.getConnection();
    await fixtureSql.execute(`
      CREATE OR REPLACE FUNCTION runner_slow_outbox_flush() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'deadline-flush' THEN
          PERFORM pg_sleep(0.25);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trigger_runner_slow_outbox_flush
      BEFORE INSERT ON outbox_messages
      FOR EACH ROW EXECUTE FUNCTION runner_slow_outbox_flush();
    `);

    const eventId = crypto.randomUUID();
    let thrown: unknown;
    try {
      const runner = new DatabaseTransactionRunner(appDb(), {
        OPERATION_TIMEOUT_MS: 3000,
        DB_STATEMENT_TIMEOUT_MS: 50,
        DB_LOCK_TIMEOUT_MS: 10,
      });
      await runner.run(async (em) => {
        await new TransactionRepositories(em).outboxRepository.enqueue({
          id: eventId,
          aggregateId: crypto.randomUUID(),
          eventType: 'deadline-flush',
          payload: { eventId },
        });
      });
    } catch (error) {
      thrown = error;
    } finally {
      await fixtureSql.execute(`
        DROP TRIGGER IF EXISTS trigger_runner_slow_outbox_flush ON outbox_messages;
        DROP FUNCTION IF EXISTS runner_slow_outbox_flush();
      `);
    }

    expect(thrown).toBeInstanceOf(ApplicationError);
    if (thrown instanceof ApplicationError) {
      expect(thrown.code).toBe('DATABASE_STATEMENT_TIMEOUT');
    }
    const rows = await fixtureSql.execute<{ id: string }[]>(
      'select id from outbox_messages where id = ?',
      [eventId],
    );
    expect(rows).toEqual([]);
  });
});
