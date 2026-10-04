import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { createDatabaseOptions } from '../../src/core/database/database.config.js';
import { DatabaseTransactionRunner } from '../../src/core/database/database-transaction.runner.js';
import { OutboxMessageRecord } from '../../src/domains/outbox/records/outbox-message.record.js';
import { WagerTransactionRecord } from '../../src/domains/wagering/records/wager-transaction.record.js';
import { WalletLedgerEntryRecord } from '../../src/domains/wallet/records/wallet-ledger-entry.record.js';
import { WalletRecord } from '../../src/domains/wallet/records/wallet.record.js';
import {
  type WalletCreationContext,
  type WalletResult,
  WalletUseCase,
} from '../../src/domains/wallet/wallet.use-case.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

const environment = z
  .object({
    ADMIN_DATABASE_URL: z
      .url()
      .default('postgresql://postgres:postgres_local@127.0.0.1:55432/postgres'),
  })
  .parse(process.env);

const databaseName = 'jungle_wuc_' + crypto.randomUUID().replaceAll('-', '');
let admin: MikroORM | undefined;
let application: MikroORM | undefined;
let runner: DatabaseTransactionRunner;
let useCase: WalletUseCase;
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
  runner = new DatabaseTransactionRunner(application, {
    OPERATION_TIMEOUT_MS: 20000,
    DB_STATEMENT_TIMEOUT_MS: 10000,
  });
  useCase = new WalletUseCase(runner);
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

describe('WalletUseCase: positive initial opening', () => {
  test('creates wallet with balance, version 1, opening wager transaction, credit ledger, and outbox events', async () => {
    const playerId = crypto.randomUUID();
    const explicitWalletId = crypto.randomUUID();
    const correlationId = 'corr_' + crypto.randomUUID();
    const causationId = 'caus_' + crypto.randomUUID();
    const input = {
      playerId,
      initialBalance: { amount: '250.75', currency: 'BRL' as const },
    };
    const context: WalletCreationContext = {
      walletId: explicitWalletId,
      correlationId,
      causationId,
    };

    const result: WalletResult = await useCase.createWallet(input, context);

    // 1. Result verification
    expect(result.id).toBe(explicitWalletId);
    expect(result.playerId).toBe(playerId);
    expect(result.balance).toEqual({ amount: '250.75', currency: 'BRL' });
    expect(result.version).toBe('1');

    const em = appDb().em.fork();

    // 2. WalletRecord verification
    const walletRecord = await em.findOneOrFail(WalletRecord, { id: result.id });
    expect(walletRecord.playerId).toBe(playerId);
    expect(walletRecord.currency).toBe('BRL');
    expect(walletRecord.balance).toBe('250.75');
    expect(walletRecord.version).toBe('1');

    // 3. WagerTransactionRecord verification
    const txRecords = await em.find(WagerTransactionRecord, { walletId: result.id });
    expect(txRecords.length).toBe(1);
    const tx = txRecords[0];
    if (tx === undefined) throw new Error('Transaction record missing');
    expect(tx.providerId).toBe('__internal__');
    expect(tx.externalTransactionId).toBe(result.id);
    expect(tx.idempotencyKey).toBe('__internal__:' + result.id);
    expect(tx.payloadHash.trim()).toBe('opening:' + tx.id);
    expect(tx.kind).toBe('OPENING');
    expect(tx.status).toBe('PROCESSED');
    expect(tx.amount).toBe('250.75');
    expect(tx.currency).toBe('BRL');
    expect(tx.playerId).toBe(playerId);
    expect(tx.walletId).toBe(result.id);
    expect(tx.result).toEqual({
      transactionId: tx.id,
      status: 'PROCESSED',
      balance: { amount: '250.75', currency: 'BRL' },
      walletVersion: '1',
    });

    // 4. WalletLedgerEntryRecord verification
    const ledgerRecords = await em.find(WalletLedgerEntryRecord, { walletId: result.id });
    expect(ledgerRecords.length).toBe(1);
    const ledger = ledgerRecords[0];
    if (ledger === undefined) throw new Error('Ledger record missing');
    expect(ledger.transactionId).toBe(tx.id);
    expect(ledger.direction).toBe('CREDIT');
    expect(ledger.amount).toBe('250.75');
    expect(ledger.currency).toBe('BRL');
    expect(ledger.balanceBefore).toBe('0.00');
    expect(ledger.balanceAfter).toBe('250.75');
    expect(ledger.walletVersion).toBe('1');

    // 5. OutboxMessageRecord verification (exactly 2 events: WagerTransactionProcessed v1 and WalletBalanceChanged v2)
    const outboxRecords = await em.find(OutboxMessageRecord, { aggregateId: result.id });
    expect(outboxRecords.length).toBe(2);

    const processedMsg = outboxRecords.find(
      (m) => m.eventType === 'WagerTransactionProcessed',
    );
    if (processedMsg === undefined) throw new Error('Processed event missing');
    const processedPayload = processedMsg.payload as {
      eventId: string;
      aggregateId: string;
      eventType: string;
      version: number;
      correlationId?: string;
      causationId?: string;
      data: {
        transactionId: string;
        walletId: string;
        providerId: string;
        externalTransactionId: string;
        kind: string;
        money: { amount: string; currency: string };
        processedAt: string;
      };
    };
    expect(processedPayload.version).toBe(1);
    expect(processedPayload.aggregateId).toBe(result.id);
    expect(processedPayload.correlationId).toBe(correlationId);
    expect(processedPayload.causationId).toBe(causationId);
    expect(processedPayload.data.transactionId).toBe(tx.id);
    expect(processedPayload.data.walletId).toBe(result.id);
    expect(processedPayload.data.providerId).toBe('__internal__');
    expect(processedPayload.data.externalTransactionId).toBe(result.id);
    expect(processedPayload.data.kind).toBe('OPENING');
    expect(processedPayload.data.money).toEqual({ amount: '250.75', currency: 'BRL' });

    const balanceChangedMsg = outboxRecords.find(
      (m) => m.eventType === 'WalletBalanceChanged',
    );
    if (balanceChangedMsg === undefined) throw new Error('Balance changed event missing');
    const balancePayload = balanceChangedMsg.payload as {
      eventId: string;
      aggregateId: string;
      eventType: string;
      version: number;
      correlationId?: string;
      causationId?: string;
      data: {
        walletId: string;
        transactionId: string;
        direction: string;
        money: { amount: string; currency: string };
        balanceBefore: { amount: string; currency: string };
        balanceAfter: { amount: string; currency: string };
        walletVersion: string;
      };
    };
    expect(balancePayload.version).toBe(2);
    expect(balancePayload.aggregateId).toBe(result.id);
    expect(balancePayload.correlationId).toBe(correlationId);
    expect(balancePayload.causationId).toBe(causationId);
    expect(balancePayload.data.walletId).toBe(result.id);
    expect(balancePayload.data.transactionId).toBe(tx.id);
    expect(balancePayload.data.direction).toBe('CREDIT');
    expect(balancePayload.data.walletVersion).toBe('1');
    expect(balancePayload.data.money).toEqual({ amount: '250.75', currency: 'BRL' });
    expect(balancePayload.data.balanceBefore).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    expect(balancePayload.data.balanceAfter).toEqual({
      amount: '250.75',
      currency: 'BRL',
    });
  });

  test('generates walletId when not provided in context', async () => {
    const playerId = crypto.randomUUID();
    const input = {
      playerId,
      initialBalance: { amount: '10.00', currency: 'USD' as const },
    };

    const result = await useCase.createWallet(input);
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.playerId).toBe(playerId);
    expect(result.balance).toEqual({ amount: '10.00', currency: 'USD' });
    expect(result.version).toBe('1');

    const em = appDb().em.fork();
    const walletRecord = await em.findOneOrFail(WalletRecord, { id: result.id });
    expect(walletRecord.balance).toBe('10.00');
    expect(walletRecord.version).toBe('1');
  });
});

describe('WalletUseCase: zero initial opening', () => {
  test('creates wallet with balance 0.00 and version 1 without financial transaction, ledger, or outbox entries', async () => {
    const playerId = crypto.randomUUID();
    const input = {
      playerId,
      initialBalance: { amount: '0.00', currency: 'USD' as const },
    };

    const result = await useCase.createWallet(input);

    // 1. Result verification
    expect(result.playerId).toBe(playerId);
    expect(result.balance).toEqual({ amount: '0.00', currency: 'USD' });
    expect(result.version).toBe('1');

    const em = appDb().em.fork();

    // 2. WalletRecord exists with 0.00 and version 1
    const walletRecord = await em.findOneOrFail(WalletRecord, { id: result.id });
    expect(walletRecord.playerId).toBe(playerId);
    expect(walletRecord.currency).toBe('USD');
    expect(walletRecord.balance).toBe('0.00');
    expect(walletRecord.version).toBe('1');

    // 3. Zero wager_transactions rows for wallet
    const txRecords = await em.find(WagerTransactionRecord, { walletId: result.id });
    expect(txRecords.length).toBe(0);

    // 4. Zero wallet_ledger_entries rows for wallet
    const ledgerRecords = await em.find(WalletLedgerEntryRecord, { walletId: result.id });
    expect(ledgerRecords.length).toBe(0);

    // 5. Zero outbox_messages rows for wallet
    const outboxRecords = await em.find(OutboxMessageRecord, { aggregateId: result.id });
    expect(outboxRecords.length).toBe(0);
  });
});

describe('WalletUseCase: duplicate wallet rejection', () => {
  test('rejects sequential creation for same (playerId, currency) with WALLET_ALREADY_EXISTS', async () => {
    const playerId = crypto.randomUUID();
    const input = {
      playerId,
      initialBalance: { amount: '50.00', currency: 'BRL' as const },
    };

    const outboxCount = await appDb().em.fork().count(OutboxMessageRecord, {});
    const firstResult = await useCase.createWallet(input);
    expect(firstResult.version).toBe('1');

    let caughtError: unknown;
    try {
      await useCase.createWallet(input);
    } catch (error) {
      caughtError = error;
    }

    expectApplicationError(caughtError, {
      category: 'ConflictError',
      code: 'WALLET_ALREADY_EXISTS',
    });

    // Ensure database still has only one wallet
    const em = appDb().em.fork();
    const wallets = await em.find(WalletRecord, { playerId, currency: 'BRL' });
    expect(wallets.length).toBe(1);
    expect(wallets[0]?.balance).toBe('50.00');
    expect(wallets[0]?.version).toBe('1');
    expect(await em.count(WagerTransactionRecord, { playerId })).toBe(1);
    expect(await em.count(WalletLedgerEntryRecord, { walletId: firstResult.id })).toBe(1);
    expect(await em.count(OutboxMessageRecord, {})).toBe(outboxCount + 2);
  });

  test('resolves concurrent creation race deterministically: exactly one succeeds and one fails', async () => {
    const racePlayerId = crypto.randomUUID();
    const raceInput = {
      playerId: racePlayerId,
      initialBalance: { amount: '100.00', currency: 'EUR' as const },
    };

    const outboxCount = await appDb().em.fork().count(OutboxMessageRecord, {});
    const outcomes = await Promise.allSettled([
      useCase.createWallet(raceInput),
      useCase.createWallet(raceInput),
    ]);

    const fulfilled = outcomes.filter(
      (o): o is PromiseFulfilledResult<WalletResult> => o.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const winningResult = fulfilled[0];
    const failingResult = rejected[0];
    if (winningResult === undefined || failingResult === undefined) {
      throw new Error('Expected one fulfilled and one rejected outcome');
    }
    expect(winningResult.value.balance).toEqual({ amount: '100.00', currency: 'EUR' });
    expect(winningResult.value.version).toBe('1');

    expectApplicationError(failingResult.reason, {
      category: 'ConflictError',
      code: 'WALLET_ALREADY_EXISTS',
    });

    // Ensure database contains exactly one wallet for this player and currency
    const em = appDb().em.fork();
    const wallets = await em.find(WalletRecord, {
      playerId: racePlayerId,
      currency: 'EUR',
    });
    expect(wallets.length).toBe(1);
    expect(wallets[0]?.balance).toBe('100.00');
    expect(wallets[0]?.version).toBe('1');
    expect(await em.count(WagerTransactionRecord, { playerId: racePlayerId })).toBe(1);
    expect(
      await em.count(WalletLedgerEntryRecord, { walletId: winningResult.value.id }),
    ).toBe(1);
    expect(await em.count(OutboxMessageRecord, {})).toBe(outboxCount + 2);
  });
});

describe('WalletUseCase: currency isolation', () => {
  test('allows same playerId to successfully open wallets in different currencies (BRL, USD, EUR)', async () => {
    const playerId = crypto.randomUUID();

    const brlWallet = await useCase.createWallet({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' as const },
    });
    const usdWallet = await useCase.createWallet({
      playerId,
      initialBalance: { amount: '50.00', currency: 'USD' as const },
    });
    const eurWallet = await useCase.createWallet({
      playerId,
      initialBalance: { amount: '0.00', currency: 'EUR' as const },
    });

    expect(brlWallet.playerId).toBe(playerId);
    expect(brlWallet.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(brlWallet.version).toBe('1');

    expect(usdWallet.playerId).toBe(playerId);
    expect(usdWallet.balance).toEqual({ amount: '50.00', currency: 'USD' });
    expect(usdWallet.version).toBe('1');

    expect(eurWallet.playerId).toBe(playerId);
    expect(eurWallet.balance).toEqual({ amount: '0.00', currency: 'EUR' });
    expect(eurWallet.version).toBe('1');

    // All three wallet IDs must be distinct
    expect(brlWallet.id).not.toBe(usdWallet.id);
    expect(brlWallet.id).not.toBe(eurWallet.id);
    expect(usdWallet.id).not.toBe(eurWallet.id);
    // Query database for all wallets belonging to this player
    const em = appDb().em.fork();
    const walletsInDb = await em.find(WalletRecord, { playerId });
    expect(walletsInDb.length).toBe(3);

    const currencies = walletsInDb.map((w) => w.currency).sort();
    expect(currencies).toEqual(['BRL', 'EUR', 'USD']);
  });
});

describe('WalletUseCase: validation', () => {
  test('rejects invalid playerId (not a UUID) with WALLET_INPUT_INVALID', async () => {
    let caught: unknown;
    try {
      await useCase.createWallet({
        playerId: 'not-a-valid-uuid',
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });
    } catch (error) {
      caught = error;
    }
    expectApplicationError(caught, {
      category: 'ValidationError',
      code: 'WALLET_INPUT_INVALID',
    });
  });

  test('rejects negative initial amount with WALLET_INPUT_INVALID', async () => {
    let caught: unknown;
    try {
      await useCase.createWallet({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '-10.00', currency: 'BRL' },
      });
    } catch (error) {
      caught = error;
    }
    expectApplicationError(caught, {
      category: 'ValidationError',
      code: 'WALLET_INPUT_INVALID',
    });
  });

  test('rejects extra properties with WALLET_INPUT_INVALID (strict schema)', async () => {
    let caught: unknown;
    try {
      await useCase.createWallet({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
        extraProperty: 'forbidden',
      });
    } catch (error) {
      caught = error;
    }
    expectApplicationError(caught, {
      category: 'ValidationError',
      code: 'WALLET_INPUT_INVALID',
    });
  });

  test('rejects unsupported currency with WALLET_INPUT_INVALID', async () => {
    let caught: unknown;
    try {
      await useCase.createWallet({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.00', currency: 'GBP' },
      });
    } catch (error) {
      caught = error;
    }
    expectApplicationError(caught, {
      category: 'ValidationError',
      code: 'WALLET_INPUT_INVALID',
    });
  });

  test('rejects invalid decimal places with WALLET_INPUT_INVALID', async () => {
    let caught: unknown;
    try {
      await useCase.createWallet({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.5', currency: 'USD' },
      });
    } catch (error) {
      caught = error;
    }
    expectApplicationError(caught, {
      category: 'ValidationError',
      code: 'WALLET_INPUT_INVALID',
    });
  });

  test('rejects missing initialBalance with WALLET_INPUT_INVALID', async () => {
    let caught: unknown;
    try {
      await useCase.createWallet({
        playerId: crypto.randomUUID(),
      });
    } catch (error) {
      caught = error;
    }
    expectApplicationError(caught, {
      category: 'ValidationError',
      code: 'WALLET_INPUT_INVALID',
    });
  });

  test('rejects non-object inputs (null, undefined, string, empty object)', async () => {
    for (const invalid of [null, undefined, '', 'invalid', 42, {}]) {
      let caught: unknown;
      try {
        await useCase.createWallet(invalid);
      } catch (error) {
        caught = error;
      }
      expectApplicationError(caught, {
        category: 'ValidationError',
        code: 'WALLET_INPUT_INVALID',
      });
    }
  });
});

describe('WalletUseCase: atomicity and rollback', () => {
  test('rolls back completely when outbox enqueue fails (no partial wallet, transaction, or ledger)', async () => {
    const playerId = crypto.randomUUID();
    const failingCorrelationId = 'fail_outbox_' + crypto.randomUUID();
    const knex = appDb().em.getConnection().getKnex();

    await knex.raw(`
      CREATE OR REPLACE FUNCTION fail_wallet_outbox() RETURNS trigger AS $$
      BEGIN
        IF NEW.payload->>'correlationId' = '${failingCorrelationId}' THEN
          RAISE EXCEPTION 'Simulated outbox storage failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_test_wallet_outbox_fail
      BEFORE INSERT ON outbox_messages
      FOR EACH ROW EXECUTE FUNCTION fail_wallet_outbox();
    `);

    let caught: unknown;
    try {
      await useCase.createWallet(
        {
          playerId,
          initialBalance: { amount: '120.00', currency: 'USD' as const },
        },
        { correlationId: failingCorrelationId },
      );
    } catch (error) {
      caught = error;
    } finally {
      await knex.raw(`
        DROP TRIGGER IF EXISTS trg_test_wallet_outbox_fail ON outbox_messages;
        DROP FUNCTION IF EXISTS fail_wallet_outbox();
      `);
    }

    expect(caught).toBeDefined();

    // Verify database state: no rows in wallets, wager_transactions, or wallet_ledger_entries
    const em = appDb().em.fork();
    const wallets = await em.find(WalletRecord, { playerId });
    expect(wallets.length).toBe(0);

    const txs = await em.find(WagerTransactionRecord, { playerId });
    expect(txs.length).toBe(0);

    const ledgers = await em.find(WalletLedgerEntryRecord, { currency: 'USD' });
    const matchingLedgers = ledgers.filter((l) => l.amount === '120.00');
    expect(matchingLedgers.length).toBe(0);
  });

  test('rolls back completely when ledger insertion fails (no partial wallet or transaction)', async () => {
    const playerId = crypto.randomUUID();
    const knex = appDb().em.getConnection().getKnex();

    await knex.raw(`
      CREATE OR REPLACE FUNCTION fail_wallet_ledger() RETURNS trigger AS $$
      BEGIN
        IF NEW.amount = 80.00 THEN
          RAISE EXCEPTION 'Simulated ledger insertion failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_test_wallet_ledger_fail
      BEFORE INSERT ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION fail_wallet_ledger();
    `);

    let caught: unknown;
    try {
      await useCase.createWallet({
        playerId,
        initialBalance: { amount: '80.00', currency: 'BRL' as const },
      });
    } catch (error) {
      caught = error;
    } finally {
      await knex.raw(`
        DROP TRIGGER IF EXISTS trg_test_wallet_ledger_fail ON wallet_ledger_entries;
        DROP FUNCTION IF EXISTS fail_wallet_ledger();
      `);
    }

    expect(caught).toBeDefined();

    // Verify database state: no partial wallet or transaction row
    const em = appDb().em.fork();
    const wallets = await em.find(WalletRecord, { playerId });
    expect(wallets.length).toBe(0);

    const txs = await em.find(WagerTransactionRecord, { playerId });
    expect(txs.length).toBe(0);
  });
});
