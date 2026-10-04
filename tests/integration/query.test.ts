import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { createDatabaseOptions } from '../../src/core/database/database.config.js';
import { DatabaseTransactionRunner } from '../../src/core/database/database-transaction.runner.js';
import { TransactionRepositories } from '../../src/shared/transaction-repositories.js';
import { WalletUseCase } from '../../src/domains/wallet/wallet.use-case.js';
import { WageringQueryUseCase } from '../../src/domains/wagering/wagering-query.use-case.js';
import {
  FinancialUseCase,
  type FinancialContext,
} from '../../src/domains/wagering/financial.use-case.js';
import { FailureCode } from '../../src/domains/wagering/entities/wager-transaction.entity.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

const environment = z
  .object({
    ADMIN_DATABASE_URL: z
      .url()
      .default('postgresql://postgres:postgres_local@127.0.0.1:55432/postgres'),
  })
  .parse(process.env);

const databaseName = 'jungle_query_' + crypto.randomUUID().replaceAll('-', '');
let admin: MikroORM | undefined;
let application: MikroORM | undefined;
let runner: DatabaseTransactionRunner;
let walletUseCase: WalletUseCase;
let wageringQueryUseCase: WageringQueryUseCase;
let financialUseCase: FinancialUseCase;
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
    result: { balance: { amount: balance, currency }, walletVersion: '1' },
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
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    'postgresql://jungle_main:main_local@localhost:55432/postgres';
  process.env.SQS_ENDPOINT = process.env.SQS_ENDPOINT || 'http://localhost:4566';
  process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'test';
  process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'test';
  process.env.LEDGER_CURSOR_SECRET =
    process.env.LEDGER_CURSOR_SECRET || 'integration-only-ledger-cursor-secret';

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

  walletUseCase = new WalletUseCase(runner);
  wageringQueryUseCase = new WageringQueryUseCase(runner);
  financialUseCase = new FinancialUseCase(runner);
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

describe('1. Wallet queries (GET /wallets/:walletId)', () => {
  test('returns existing wallet representation with correct id, playerId, balance, version, and timestamps', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '250.75', currency: 'BRL' }));

    const result = await walletUseCase.getWallet(seeded.walletId);
    expect(result.id).toBe(seeded.walletId);
    expect(result.playerId).toBe(seeded.playerId);
    expect(result.balance).toEqual({ amount: '250.75', currency: 'BRL' });
    expect(result.version).toBe('1');
    expect(typeof result.createdAt).toBe('string');
    expect(typeof result.updatedAt).toBe('string');
    expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
    expect(new Date(result.updatedAt).toISOString()).toBe(result.updatedAt);
  });

  test('non-existent wallet returns 404 WALLET_NOT_FOUND (NotFoundError)', async () => {
    const missingWalletId = crypto.randomUUID();

    let useCaseError: unknown;
    try {
      await walletUseCase.getWallet(missingWalletId);
    } catch (err) {
      useCaseError = err;
    }
    expectApplicationError(useCaseError, {
      category: 'NotFoundError',
      code: 'WALLET_NOT_FOUND',
    });
  });

  test.each([
    'not-a-uuid',
    '12345',
    '',
    '123e4567-e89b-12d3-a456-42661417400g',
    ' 73f9166f-40ff-4cf2-8356-0775d79fa5fe',
  ])(
    'invalid UUID %j returns 400 WALLET_ID_INVALID (ValidationError)',
    async (invalidId) => {
      let thrown: unknown;
      try {
        await walletUseCase.getWallet(invalidId);
      } catch (err) {
        thrown = err;
      }
      expectApplicationError(thrown, {
        category: 'ValidationError',
        code: 'WALLET_ID_INVALID',
      });
    },
  );
});

describe('2. Ledger keyset pagination (GET /wallets/:walletId/ledger)', () => {
  test('empty ledger on zero-opening wallet returns items: [], nextCursor: null, hasMore: false', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '0.00', currency: 'USD' }));

    const result = await walletUseCase.getLedger(seeded.walletId);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(result.hasMore).toBe(false);
  });

  test('non-existent wallet returns 404 WALLET_NOT_FOUND', async () => {
    const missingWalletId = crypto.randomUUID();

    let thrown: unknown;
    try {
      await walletUseCase.getLedger(missingWalletId);
    } catch (err) {
      thrown = err;
    }
    expectApplicationError(thrown, {
      category: 'NotFoundError',
      code: 'WALLET_NOT_FOUND',
    });
  });

  test('invalid wallet UUID returns 400 WALLET_ID_INVALID', async () => {
    let thrown: unknown;
    try {
      await walletUseCase.getLedger('not-a-valid-uuid');
    } catch (err) {
      thrown = err;
    }
    expectApplicationError(thrown, {
      category: 'ValidationError',
      code: 'WALLET_ID_INVALID',
    });
  });

  test.each([0, 201, -1, 1.5, '0', '201', '-5', 'abc', ''])(
    'limit boundary validation rejects limit=%j with 400 PAGINATION_LIMIT_INVALID',
    async (limit) => {
      const seeded = await appDb()
        .em.fork()
        .transactional((em) => seedWallet(em, { balance: '10.00' }));

      let thrown: unknown;
      try {
        await walletUseCase.getLedger(seeded.walletId, { limit });
      } catch (err) {
        thrown = err;
      }
      expectApplicationError(thrown, {
        category: 'ValidationError',
        code: 'PAGINATION_LIMIT_INVALID',
      });
    },
  );

  test('paginates across multiple pages with small limit (limit=2 on 5 entries) until hasMore is false and nextCursor is null', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00', currency: 'BRL' }));

    const providerId = 'prov_keyset_01';
    const roundId = 'round_keyset_01';
    const gameId = 'game_keyset_01';
    const context: FinancialContext = { providerId, correlationId: crypto.randomUUID() };

    // Create 4 more financial operations to produce exactly 5 ledger entries
    // 1. Opening: version 1, balance 100.00 (CREDIT)
    // 2. BET: version 2, balance 90.00 (DEBIT)
    const bet1 = await financialUseCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_ks_bet_01',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
      'idemp_ks_01',
      context,
    );
    expect(bet1.walletVersion).toBe('2');

    // 3. BET: version 3, balance 70.00 (DEBIT)
    const bet2 = await financialUseCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_ks_bet_02',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'BET',
        money: { amount: '20.00', currency: 'BRL' },
      },
      'idemp_ks_02',
      context,
    );
    expect(bet2.walletVersion).toBe('3');

    // 4. WIN: version 4, balance 110.00 (CREDIT)
    const win1 = await financialUseCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_ks_win_01',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'WIN',
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: 'ext_ks_bet_01',
      },
      'idemp_ks_03',
      context,
    );
    expect(win1.walletVersion).toBe('4');

    // 5. WIN: version 5, balance 125.00 (CREDIT)
    const win2 = await financialUseCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_ks_win_02',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'WIN',
        money: { amount: '15.00', currency: 'BRL' },
        referenceExternalTransactionId: 'ext_ks_bet_02',
      },
      'idemp_ks_04',
      context,
    );
    expect(win2.walletVersion).toBe('5');

    // Page 1: limit 2
    const page1 = await walletUseCase.getLedger(seeded.walletId, { limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    const page1Cursor = page1.nextCursor;
    if (page1Cursor === null) {
      throw new Error('Expected page1.nextCursor to be non-null');
    }
    const page1Item0 = page1.items[0];
    const page1Item1 = page1.items[1];
    if (page1Item0 === undefined || page1Item1 === undefined) {
      throw new Error('Expected page1 items to have at least 2 entries');
    }
    expect(page1Item0.walletVersion).toBe('1');
    expect(page1Item0.direction).toBe('CREDIT');
    expect(page1Item0.money).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(page1Item1.walletVersion).toBe('2');
    expect(page1Item1.direction).toBe('DEBIT');
    expect(page1Item1.money).toEqual({ amount: '10.00', currency: 'BRL' });

    // Page 2: limit 2 with cursor from page 1
    const page2 = await walletUseCase.getLedger(seeded.walletId, {
      limit: 2,
      cursor: page1Cursor,
    });
    expect(page2.items.length).toBe(2);
    expect(page2.hasMore).toBe(true);
    expect(page2.nextCursor).not.toBeNull();
    const page2Cursor = page2.nextCursor;
    if (page2Cursor === null) {
      throw new Error('Expected page2.nextCursor to be non-null');
    }
    const page2Item0 = page2.items[0];
    const page2Item1 = page2.items[1];
    if (page2Item0 === undefined || page2Item1 === undefined) {
      throw new Error('Expected page2 items to have at least 2 entries');
    }
    expect(page2Item0.walletVersion).toBe('3');
    expect(page2Item0.direction).toBe('DEBIT');
    expect(page2Item0.money).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(page2Item1.walletVersion).toBe('4');
    expect(page2Item1.direction).toBe('CREDIT');
    expect(page2Item1.money).toEqual({ amount: '40.00', currency: 'BRL' });

    // Page 3: limit 2 with cursor from page 2
    const page3 = await walletUseCase.getLedger(seeded.walletId, {
      limit: 2,
      cursor: page2Cursor,
    });
    expect(page3.items.length).toBe(1);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();
    const page3Item0 = page3.items[0];
    if (page3Item0 === undefined) {
      throw new Error('Expected page3 items to have at least 1 entry');
    }
    expect(page3Item0.walletVersion).toBe('5');
    expect(page3Item0.direction).toBe('CREDIT');
    expect(page3Item0.money).toEqual({ amount: '15.00', currency: 'BRL' });

    // Verify all entries present in exact order by wallet_version ASC, no duplicates or gaps
    const allCollected = [...page1.items, ...page2.items, ...page3.items];
    expect(allCollected.length).toBe(5);
    const versions = allCollected.map((item) => item.walletVersion);
    expect(versions).toEqual(['1', '2', '3', '4', '5']);

    // Check full schema representation of every item
    for (const item of allCollected) {
      expect(typeof item.id).toBe('string');
      expect(item.walletId).toBe(seeded.walletId);
      expect(typeof item.transactionId).toBe('string');
      expect(['DEBIT', 'CREDIT']).toContain(item.direction);
      expect(typeof item.money.amount).toBe('string');
      expect(item.money.currency).toBe('BRL');
      expect(typeof item.balanceBefore.amount).toBe('string');
      expect(typeof item.balanceAfter.amount).toBe('string');
      expect(typeof item.createdAt).toBe('string');
    }
  });

  test('ceiling version stability: new balance operations committed during pagination are excluded from earlier cursor streams', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00', currency: 'EUR' }));

    const providerId = 'prov_ceiling_01';
    const roundId = 'round_ceiling_01';
    const gameId = 'game_ceiling_01';
    const context: FinancialContext = { providerId, correlationId: crypto.randomUUID() };

    // Initial operations: versions 1, 2, 3
    await financialUseCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_ceil_bet_01',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'BET',
        money: { amount: '10.00', currency: 'EUR' },
      },
      'idemp_ceil_01',
      context,
    );
    await financialUseCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_ceil_bet_02',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'BET',
        money: { amount: '15.00', currency: 'EUR' },
      },
      'idemp_ceil_02',
      context,
    );

    // Initial stream starts: wallet is at version 3, so ceilingVersion is captured as 3
    const page1 = await walletUseCase.getLedger(seeded.walletId, { limit: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.items.map((i) => i.walletVersion)).toEqual(['1', '2']);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    const page1Cursor = page1.nextCursor;
    if (page1Cursor === null) {
      throw new Error('Expected page1.nextCursor to be non-null');
    }

    // Now new balance operations are committed AFTER pagination began (versions 4 and 5)
    await financialUseCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_ceil_win_01',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'WIN',
        money: { amount: '50.00', currency: 'EUR' },
        referenceExternalTransactionId: 'ext_ceil_bet_01',
      },
      'idemp_ceil_03',
      context,
    );
    await financialUseCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_ceil_bet_03',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'BET',
        money: { amount: '5.00', currency: 'EUR' },
      },
      'idemp_ceil_04',
      context,
    );

    // Continue the pagination stream using the page 1 cursor (ceiling is locked at 3)
    const page2 = await walletUseCase.getLedger(seeded.walletId, {
      limit: 2,
      cursor: page1Cursor,
    });
    // It must return only version 3, and hasMore must be false, nextCursor must be null
    expect(page2.items.length).toBe(1);
    const page2Item0 = page2.items[0];
    if (page2Item0 === undefined) {
      throw new Error('Expected page2 item to be defined');
    }
    expect(page2Item0.walletVersion).toBe('3');
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  test('tampered cursor payload or modified signature rejected with 400 LEDGER_CURSOR_INVALID', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '50.00' }));

    const bet = await financialUseCase.execute(
      {
        providerId: 'prov_tamper',
        externalTransactionId: 'ext_tamper_01',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId: 'r_tamper',
        gameId: 'g_tamper',
        kind: 'BET',
        money: { amount: '5.00', currency: seeded.currency },
      },
      'idemp_tamper_01',
      { providerId: 'prov_tamper', correlationId: crypto.randomUUID() },
    );
    expect(bet.walletVersion).toBe('2');

    const validPage = await walletUseCase.getLedger(seeded.walletId, { limit: 1 });
    const validCursor = validPage.nextCursor;
    expect(validCursor).not.toBeNull();
    if (validCursor === null) {
      throw new Error('Expected validCursor to be non-null');
    }

    // 1. Non-base64 arbitrary string
    let err1: unknown;
    try {
      await walletUseCase.getLedger(seeded.walletId, { cursor: 'invalid!cursor@string' });
    } catch (err) {
      err1 = err;
    }
    expectApplicationError(err1, {
      category: 'ValidationError',
      code: 'LEDGER_CURSOR_INVALID',
    });

    // 2. Base64 but not valid JSON
    const notJsonCursor = Buffer.from('hello-world-not-json').toString('base64url');
    let err2: unknown;
    try {
      await walletUseCase.getLedger(seeded.walletId, { cursor: notJsonCursor });
    } catch (err) {
      err2 = err;
    }
    expectApplicationError(err2, {
      category: 'ValidationError',
      code: 'LEDGER_CURSOR_INVALID',
    });

    // 3. Decoded JSON with tampered payload (change pointer 'p' without updating signature 's')
    const decoded = JSON.parse(
      Buffer.from(validCursor, 'base64url').toString('utf8'),
    ) as {
      v: number;
      w: string;
      p: string;
      c: string;
      s: string;
    };
    const tamperedPayload = { ...decoded, p: '99' };
    const tamperedCursor = Buffer.from(JSON.stringify(tamperedPayload)).toString(
      'base64url',
    );
    let err3: unknown;
    try {
      await walletUseCase.getLedger(seeded.walletId, { cursor: tamperedCursor });
    } catch (err) {
      err3 = err;
    }
    expectApplicationError(err3, {
      category: 'ValidationError',
      code: 'LEDGER_CURSOR_INVALID',
    });

    // 4. Modifying signature 's'
    const tamperedSigPayload = {
      ...decoded,
      s: decoded.s.slice(0, -1) + (decoded.s.endsWith('A') ? 'B' : 'A'),
    };
    const tamperedSigCursor = Buffer.from(JSON.stringify(tamperedSigPayload)).toString(
      'base64url',
    );
    let err4: unknown;
    try {
      await walletUseCase.getLedger(seeded.walletId, { cursor: tamperedSigCursor });
    } catch (err) {
      err4 = err;
    }
    expectApplicationError(err4, {
      category: 'ValidationError',
      code: 'LEDGER_CURSOR_INVALID',
    });

    // 5. Signed with wrong secret
    const wrongSecretHmac = createHmac(
      'sha256',
      'wrong_secret_at_least_32_characters_long!',
    )
      .update(
        JSON.stringify({
          v: decoded.v,
          w: decoded.w,
          p: decoded.p,
          c: decoded.c,
        }),
      )
      .digest('base64url');
    const wrongSecretCursor = Buffer.from(
      JSON.stringify({ ...decoded, s: wrongSecretHmac }),
    ).toString('base64url');
    let err5: unknown;
    try {
      await walletUseCase.getLedger(seeded.walletId, { cursor: wrongSecretCursor });
    } catch (err) {
      err5 = err;
    }
    expectApplicationError(err5, {
      category: 'ValidationError',
      code: 'LEDGER_CURSOR_INVALID',
    });
  });

  test('cursor created for wallet A used on wallet B rejected with 400 LEDGER_CURSOR_WALLET_MISMATCH', async () => {
    const walletA = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const walletB = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));

    // Create extra entry on wallet A so pagination produces nextCursor
    await financialUseCase.execute(
      {
        providerId: 'prov_cross',
        externalTransactionId: 'ext_cross_01',
        playerId: walletA.playerId,
        walletId: walletA.walletId,
        roundId: 'r_cross',
        gameId: 'g_cross',
        kind: 'BET',
        money: { amount: '10.00', currency: walletA.currency },
      },
      'idemp_cross_01',
      { providerId: 'prov_cross', correlationId: crypto.randomUUID() },
    );

    const pageA = await walletUseCase.getLedger(walletA.walletId, { limit: 1 });
    const cursorA = pageA.nextCursor;
    expect(cursorA).not.toBeNull();
    if (cursorA === null) {
      throw new Error('Expected cursorA to be non-null');
    }

    let thrown: unknown;
    try {
      await walletUseCase.getLedger(walletB.walletId, { cursor: cursorA });
    } catch (err) {
      thrown = err;
    }
    expectApplicationError(thrown, {
      category: 'ValidationError',
      code: 'LEDGER_CURSOR_WALLET_MISMATCH',
    });
  });
});

describe('3. Transaction query by internal ID (GET /wagering/transactions/:transactionId)', () => {
  test('returns full transaction representation for OPENING, BET, WIN, LOSS, REJECTED', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '200.00', currency: 'USD' }));

    const providerId = 'prov_tx_01';
    const roundId = 'round_tx_01';
    const gameId = 'game_tx_01';
    const context: FinancialContext = { providerId, correlationId: crypto.randomUUID() };

    // 1. OPENING transaction
    const openingTx = await wageringQueryUseCase.getTransactionById(seeded.transactionId);
    expect(openingTx.id).toBe(seeded.transactionId);
    expect(openingTx.providerId).toBe('__internal__');
    expect(openingTx.externalTransactionId).toBe(seeded.walletId);
    expect(openingTx.playerId).toBe(seeded.playerId);
    expect(openingTx.walletId).toBe(seeded.walletId);
    expect(openingTx.kind).toBe('OPENING');
    expect(openingTx.money).toEqual({ amount: '200.00', currency: 'USD' });
    expect(openingTx.status).toBe('PROCESSED');
    expect(openingTx.roundId).toBeUndefined();
    expect(openingTx.gameId).toBeUndefined();
    expect(typeof openingTx.createdAt).toBe('string');
    expect(typeof openingTx.updatedAt).toBe('string');

    // 2. BET transaction
    const betRes = await financialUseCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_tx_bet_01',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'BET',
        money: { amount: '50.00', currency: 'USD' },
      },
      'idemp_tx_bet_01',
      context,
    );
    const betTx = await wageringQueryUseCase.getTransactionById(betRes.transactionId);
    expect(betTx.id).toBe(betRes.transactionId);
    expect(betTx.providerId).toBe(providerId);
    expect(betTx.externalTransactionId).toBe('ext_tx_bet_01');
    expect(betTx.playerId).toBe(seeded.playerId);
    expect(betTx.walletId).toBe(seeded.walletId);
    expect(betTx.roundId).toBe(roundId);
    expect(betTx.gameId).toBe(gameId);
    expect(betTx.kind).toBe('BET');
    expect(betTx.money).toEqual({ amount: '50.00', currency: 'USD' });
    expect(betTx.status).toBe('PROCESSED');

    // 3. WIN transaction referencing BET
    const winRes = await financialUseCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_tx_win_01',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'WIN',
        money: { amount: '120.00', currency: 'USD' },
        referenceExternalTransactionId: 'ext_tx_bet_01',
      },
      'idemp_tx_win_01',
      context,
    );
    const winTx = await wageringQueryUseCase.getTransactionById(winRes.transactionId);
    expect(winTx.id).toBe(winRes.transactionId);
    expect(winTx.kind).toBe('WIN');
    expect(winTx.money).toEqual({ amount: '120.00', currency: 'USD' });
    expect(winTx.referenceExternalTransactionId).toBe('ext_tx_bet_01');
    expect(winTx.referenceTransactionId).toBe(betRes.transactionId);
    expect(winTx.status).toBe('PROCESSED');

    // 4. LOSS transaction
    const lossRes = await financialUseCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_tx_loss_01',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'LOSS',
        money: { amount: '0.00', currency: 'USD' },
      },
      'idemp_tx_loss_01',
      context,
    );
    const lossTx = await wageringQueryUseCase.getTransactionById(lossRes.transactionId);
    expect(lossTx.id).toBe(lossRes.transactionId);
    expect(lossTx.kind).toBe('LOSS');
    expect(lossTx.money).toEqual({ amount: '0.00', currency: 'USD' });
    expect(lossTx.status).toBe('PROCESSED');

    // 5. REJECTED transaction (overdraft BET exceeding available balance)
    const rejectedRes = await financialUseCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_tx_rejected_01',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'BET',
        money: { amount: '99999.00', currency: 'USD' },
      },
      'idemp_tx_rej_01',
      context,
    );
    expect(rejectedRes.status).toBe('REJECTED');
    const rejectedTx = await wageringQueryUseCase.getTransactionById(
      rejectedRes.transactionId,
    );
    expect(rejectedTx.id).toBe(rejectedRes.transactionId);
    expect(rejectedTx.kind).toBe('BET');
    expect(rejectedTx.status).toBe('REJECTED');
    expect(rejectedTx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('non-existent ID returns 404 TRANSACTION_NOT_FOUND', async () => {
    const missingTxId = crypto.randomUUID();

    let thrown: unknown;
    try {
      await wageringQueryUseCase.getTransactionById(missingTxId);
    } catch (err) {
      thrown = err;
    }
    expectApplicationError(thrown, {
      category: 'NotFoundError',
      code: 'TRANSACTION_NOT_FOUND',
    });
  });

  test.each(['not-a-uuid', '12345', '', '73f9166f-40ff-4cf2-8356-0775d79fa5fg'])(
    'invalid UUID %j returns 400 TRANSACTION_ID_INVALID',
    async (invalidId) => {
      let thrown: unknown;
      try {
        await wageringQueryUseCase.getTransactionById(invalidId);
      } catch (err) {
        thrown = err;
      }
      expectApplicationError(thrown, {
        category: 'ValidationError',
        code: 'TRANSACTION_ID_INVALID',
      });
    },
  );
});

describe('4. Transaction query by external ID (GET /providers/:providerId/wagering/transactions/:externalTransactionId)', () => {
  test('both internal and external lookups return identical data for the same operation', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '300.00', currency: 'BRL' }));

    const providerId = 'prov_external_check';
    const externalTransactionId = 'ext_lookup_bet_01';
    const context: FinancialContext = { providerId, correlationId: crypto.randomUUID() };

    const betRes = await financialUseCase.execute(
      {
        providerId,
        externalTransactionId,
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId: 'r_lookup_01',
        gameId: 'g_lookup_01',
        kind: 'BET',
        money: { amount: '45.00', currency: 'BRL' },
      },
      'idemp_lookup_01',
      context,
    );

    const byId = await wageringQueryUseCase.getTransactionById(betRes.transactionId);
    const byExternal = await wageringQueryUseCase.getTransactionByExternal(
      providerId,
      externalTransactionId,
    );

    expect(byExternal).toEqual(byId);
  });

  test('non-existent external ID returns 404 TRANSACTION_NOT_FOUND', async () => {
    let thrown: unknown;
    try {
      await wageringQueryUseCase.getTransactionByExternal(
        'prov_some_provider',
        'ext_does_not_exist',
      );
    } catch (err) {
      thrown = err;
    }
    expectApplicationError(thrown, {
      category: 'NotFoundError',
      code: 'TRANSACTION_NOT_FOUND',
    });
  });

  test.each([
    ['', 'ext_valid_01'],
    ['   ', 'ext_valid_01'],
    ['prov_valid', ''],
    ['prov_valid', '   '],
    [' prov_leading_space', 'ext_valid_01'],
    ['prov_valid', 'ext_trailing_space '],
    ['a'.repeat(129), 'ext_valid_01'],
    ['prov_valid', 'b'.repeat(129)],
    ['prov_\x00_ctrl', 'ext_valid_01'],
  ])(
    'invalid provider %j or external ID %j format rejected with 400 ValidationError',
    async (pId, extId) => {
      let thrown: unknown;
      try {
        await wageringQueryUseCase.getTransactionByExternal(pId, extId);
      } catch (err) {
        thrown = err;
      }
      expectApplicationError(thrown, {
        category: 'ValidationError',
        code: 'WAGER_INPUT_INVALID',
      });
    },
  );
});
