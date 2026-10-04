import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import type { Knex } from 'knex';
import { z } from 'zod';
import { WageringQueryUseCase } from '../../src/domains/wagering/wagering-query.use-case.js';
import { createDatabaseOptions } from '../../src/core/database/database.config.js';
import { DatabaseTransactionRunner } from '../../src/core/database/database-transaction.runner.js';
import { TransactionRepositories } from '../../src/shared/transaction-repositories.js';
import {
  FinancialUseCase,
  type FinancialContext,
} from '../../src/domains/wagering/financial.use-case.js';
import { FailureCode } from '../../src/domains/wagering/entities/wager-transaction.entity.js';
import { WagerTransactionRecord } from '../../src/domains/wagering/records/wager-transaction.record.js';
import { WalletRecord } from '../../src/domains/wallet/records/wallet.record.js';
import { WalletLedgerEntryRecord } from '../../src/domains/wallet/records/wallet-ledger-entry.record.js';
import { OutboxMessageRecord } from '../../src/domains/outbox/records/outbox-message.record.js';
import { InboxMessageRecord } from '../../src/domains/inbox/records/inbox-message.record.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';
import { validateSqsWagerMessage } from '../../src/domains/messaging/dto/sqs-wager-message.dto.js';

const environment = z
  .object({
    ADMIN_DATABASE_URL: z
      .url()
      .default('postgresql://postgres:postgres_local@127.0.0.1:55432/postgres'),
  })
  .parse(process.env);

const eventPayloadSchema = z.object({
  version: z.number().optional(),
  data: z.object({
    transactionId: z.string().optional(),
    walletVersion: z.string().optional(),
  }),
});

const databaseName = 'jungle_fuc_' + crypto.randomUUID().replaceAll('-', '');
let admin: MikroORM | undefined;
let application: MikroORM | undefined;
let useCase: FinancialUseCase;
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
  // These tests close database connections to check recovery.
  const client = application.em.getConnection().getKnex().client as Knex.Client;
  spyOn(client.logger, 'warn').mockImplementation(() => {});
  await application.migrator.up();
  useCase = new FinancialUseCase(
    new DatabaseTransactionRunner(application, {
      OPERATION_TIMEOUT_MS: 20000,
      DB_STATEMENT_TIMEOUT_MS: 10000,
    }),
  );
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

describe('FinancialUseCase: accepted operations & exact financial values', () => {
  test('processes valid BET, WIN, and non-financial LOSS with exact versions, ledgers, and outbox', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_accepted';
    const roundId = 'round_flow_01';
    const gameId = 'game_slots_01';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    // 1. Primary BET: debits wallet from 100.00 to 70.00, version increments to '2'
    const betExtId = 'ext_bet_01';
    const betKey = 'key_bet_01';
    const betPayload = {
      providerId,
      externalTransactionId: betExtId,
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId,
      gameId,
      kind: 'BET' as const,
      money: { amount: '30.00', currency: seeded.currency },
    };

    const betResult = await useCase.execute(betPayload, betKey, context);
    expect(betResult.status).toBe('PROCESSED');
    expect(betResult.balance).toEqual({ amount: '70.00', currency: seeded.currency });
    expect(betResult.walletVersion).toBe('2');
    expect(betResult.idempotentReplay).toBe(false);

    // Verify DB state for BET
    const emAfterBet = appDb().em.fork();
    const walletAfterBet = await emAfterBet.findOneOrFail(WalletRecord, {
      id: seeded.walletId,
    });
    expect(walletAfterBet.balance).toBe('70.00');
    expect(walletAfterBet.version).toBe('2');

    const betLedger = await emAfterBet.findOneOrFail(WalletLedgerEntryRecord, {
      transactionId: betResult.transactionId,
    });
    expect(betLedger.direction).toBe('DEBIT');
    expect(betLedger.amount).toBe('30.00');
    expect(betLedger.balanceBefore).toBe('100.00');
    expect(betLedger.balanceAfter).toBe('70.00');
    expect(betLedger.walletVersion).toBe('2');

    const outboxAfterBet = await emAfterBet.find(
      OutboxMessageRecord,
      { aggregateId: seeded.walletId },
      { orderBy: { occurredAt: 'asc' } },
    );
    const balanceEvents = outboxAfterBet.filter(
      (m) => m.eventType === 'WalletBalanceChanged',
    );
    expect(balanceEvents.length).toBe(1);
    const firstBalanceEvent = balanceEvents[0];
    if (firstBalanceEvent === undefined) {
      throw new Error('Expected at least one WalletBalanceChanged event');
    }
    const payload = eventPayloadSchema.parse(firstBalanceEvent.payload);
    expect(payload.version).toBe(2);
    expect(payload.data.walletVersion).toBe('2');

    // 2. Primary WIN: credits wallet from 70.00 to 120.00 referencing BET, version becomes '3'
    const winExtId = 'ext_win_01';
    const winKey = 'key_win_01';
    const winPayload = {
      providerId,
      externalTransactionId: winExtId,
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId,
      gameId,
      kind: 'WIN' as const,
      money: { amount: '50.00', currency: seeded.currency },
      referenceExternalTransactionId: betExtId,
    };

    const winResult = await useCase.execute(winPayload, winKey, context);
    expect(winResult.status).toBe('PROCESSED');
    expect(winResult.balance).toEqual({ amount: '120.00', currency: seeded.currency });
    expect(winResult.walletVersion).toBe('3');
    expect(winResult.idempotentReplay).toBe(false);

    const emAfterWin = appDb().em.fork();
    const winTx = await emAfterWin.findOneOrFail(WagerTransactionRecord, {
      id: winResult.transactionId,
    });
    expect(winTx.referenceTransactionId).toBe(betResult.transactionId);

    // 3. Primary LOSS: non-financial history (amount 0.00). Does NOT change balance, version, or append ledger!
    const lossExtId = 'ext_loss_01';
    const lossKey = 'key_loss_01';
    const lossPayload = {
      providerId,
      externalTransactionId: lossExtId,
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId,
      gameId,
      kind: 'LOSS' as const,
      money: { amount: '0.00', currency: seeded.currency },
      referenceExternalTransactionId: betExtId,
    };

    const lossResult = await useCase.execute(lossPayload, lossKey, context);
    expect(lossResult.status).toBe('PROCESSED');
    expect(lossResult.balance).toEqual({ amount: '120.00', currency: seeded.currency });
    expect(lossResult.walletVersion).toBe('3');
    expect(lossResult.idempotentReplay).toBe(false);

    const emAfterLoss = appDb().em.fork();
    const walletAfterLoss = await emAfterLoss.findOneOrFail(WalletRecord, {
      id: seeded.walletId,
    });
    expect(walletAfterLoss.balance).toBe('120.00');
    expect(walletAfterLoss.version).toBe('3');

    const lossLedger = await emAfterLoss.findOne(WalletLedgerEntryRecord, {
      transactionId: lossResult.transactionId,
    });
    expect(lossLedger).toBeNull();

    // Verify LOSS emitted WagerTransactionProcessed but NOT WalletBalanceChanged
    const lossProcessedEvents = (
      await emAfterLoss.find(OutboxMessageRecord, {
        aggregateId: seeded.walletId,
        eventType: 'WagerTransactionProcessed',
      })
    ).filter(
      (m) =>
        eventPayloadSchema.parse(m.payload).data.transactionId ===
        lossResult.transactionId,
    );
    expect(lossProcessedEvents.length).toBe(1);
  });

  test('maintains exact decimal precision with large financial amounts without floating-point errors', async () => {
    const largeBalance = '12345678901234.50';
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: largeBalance }));
    const providerId = 'prov_large_num';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    const betPayload = {
      providerId,
      externalTransactionId: 'ext_large_01',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_lg',
      gameId: 'game_lg',
      kind: 'BET' as const,
      money: { amount: '0.01', currency: seeded.currency },
    };

    const result = await useCase.execute(betPayload, 'key_large_01', context);
    expect(result.status).toBe('PROCESSED');
    expect(result.balance?.amount).toBe('12345678901234.49');

    const em = appDb().em.fork();
    const ledger = await em.findOneOrFail(WalletLedgerEntryRecord, {
      transactionId: result.transactionId,
    });
    expect(ledger.balanceBefore).toBe('12345678901234.50');
    expect(ledger.balanceAfter).toBe('12345678901234.49');
  });
});

describe('FinancialUseCase: persistent historical replay & service restart', () => {
  test('returns historical balance and version on replay after later writes and service restart', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_replay_history';
    const roundId = 'round_hist';
    const gameId = 'game_hist';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    // 1. Initial BET: 100.00 -> 90.00 (version 2)
    const initialUseCase = useCase;
    const betPayload = {
      providerId,
      externalTransactionId: 'ext_hist_bet_01',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId,
      gameId,
      kind: 'BET' as const,
      money: { amount: '10.00', currency: seeded.currency },
    };
    const betKey = 'key_hist_bet_01';

    const firstResult = await initialUseCase.execute(betPayload, betKey, context);
    expect(firstResult.status).toBe('PROCESSED');
    expect(firstResult.balance?.amount).toBe('90.00');
    expect(firstResult.walletVersion).toBe('2');
    expect(firstResult.idempotentReplay).toBe(false);

    // 2. Later WIN: 90.00 -> 140.00 (version 3)
    const winPayload = {
      providerId,
      externalTransactionId: 'ext_hist_win_01',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId,
      gameId,
      kind: 'WIN' as const,
      money: { amount: '50.00', currency: seeded.currency },
      referenceExternalTransactionId: betPayload.externalTransactionId,
    };
    await initialUseCase.execute(winPayload, 'key_hist_win_01', context);

    // Verify current wallet balance in DB is now 140.00
    const emVerify = appDb().em.fork();
    const currentWallet = await emVerify.findOneOrFail(WalletRecord, {
      id: seeded.walletId,
    });
    expect(currentWallet.balance).toBe('140.00');
    expect(currentWallet.version).toBe('3');

    const outboxCountBeforeReplay = await emVerify.count(OutboxMessageRecord);
    const ledgerCountBeforeReplay = await emVerify.count(WalletLedgerEntryRecord);

    // 3. Simulate service restart by creating a brand-new use case instance
    const restartedUseCase = new FinancialUseCase(
      new DatabaseTransactionRunner(appDb(), {
        OPERATION_TIMEOUT_MS: 20000,
        DB_STATEMENT_TIMEOUT_MS: 10000,
      }),
    );

    // Replay the first BET
    const replayedResult = await restartedUseCase.execute(betPayload, betKey, context);
    expect(replayedResult.transactionId).toBe(firstResult.transactionId);
    expect(replayedResult.status).toBe('PROCESSED');
    expect(replayedResult.balance?.amount).toBe('90.00'); // MUST be historical balance 90.00, NOT current 140.00!
    expect(replayedResult.walletVersion).toBe('2');
    expect(replayedResult.idempotentReplay).toBe(true);

    // Verify DB was NOT mutated by replay
    const emAfterReplay = appDb().em.fork();
    const walletAfterReplay = await emAfterReplay.findOneOrFail(WalletRecord, {
      id: seeded.walletId,
    });
    expect(walletAfterReplay.balance).toBe('140.00');
    expect(walletAfterReplay.version).toBe('3');

    const outboxCountAfterReplay = await emAfterReplay.count(OutboxMessageRecord);
    const ledgerCountAfterReplay = await emAfterReplay.count(WalletLedgerEntryRecord);
    expect(outboxCountAfterReplay).toBe(outboxCountBeforeReplay);
    expect(ledgerCountAfterReplay).toBe(ledgerCountBeforeReplay);
  });
});

describe('FinancialUseCase: validation & trusted provider authorization before idempotency', () => {
  test('rejects provider mismatch immediately before any database reservation or idempotency check', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));

    // Context trusted provider is 'trusted_provider_A', but payload providerId is 'untrusted_provider_B'
    const context: FinancialContext = {
      providerId: 'trusted_provider_A',
      correlationId: crypto.randomUUID(),
    };
    const payload = {
      providerId: 'untrusted_provider_B',
      externalTransactionId: 'ext_prov_mismatch_01',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_pm',
      gameId: 'game_pm',
      kind: 'BET' as const,
      money: { amount: '10.00', currency: seeded.currency },
    };

    let caughtError: unknown;
    try {
      await useCase.execute(payload, 'key_prov_mismatch', context);
    } catch (error) {
      caughtError = error;
    }

    expectApplicationError(caughtError, {
      category: 'AuthenticationError',
      code: 'WAGER_PROVIDER_MISMATCH',
    });

    // Verify no reservation or transaction was written to DB
    const em = appDb().em.fork();
    const rows = await em.find(WagerTransactionRecord, {
      externalTransactionId: payload.externalTransactionId,
    });
    expect(rows.length).toBe(0);
  });

  test('rejects invalid DTO input and invalid idempotency keys before DB interaction', async () => {
    const context: FinancialContext = {
      providerId: 'prov_val_test',
      correlationId: crypto.randomUUID(),
    };

    // 1. Invalid payload: BET with zero amount
    let invalidDtoError: unknown;
    try {
      await useCase.execute(
        {
          providerId: 'prov_val_test',
          externalTransactionId: 'ext_invalid_01',
          playerId: crypto.randomUUID(),
          walletId: crypto.randomUUID(),
          roundId: 'round_1',
          gameId: 'game_1',
          kind: 'BET',
          money: { amount: '0.00', currency: 'BRL' },
        },
        'valid-key-01',
        context,
      );
    } catch (error) {
      invalidDtoError = error;
    }
    expectApplicationError(invalidDtoError, {
      category: 'ValidationError',
      code: 'WAGER_INPUT_INVALID',
    });

    // 2. Invalid idempotency key: contains spaces
    let invalidKeyError: unknown;
    try {
      await useCase.execute(
        {
          providerId: 'prov_val_test',
          externalTransactionId: 'ext_invalid_02',
          playerId: crypto.randomUUID(),
          walletId: crypto.randomUUID(),
          roundId: 'round_1',
          gameId: 'game_1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
        'key with invalid spaces',
        context,
      );
    } catch (error) {
      invalidKeyError = error;
    }
    expectApplicationError(invalidKeyError, {
      category: 'ValidationError',
      code: 'IDEMPOTENCY_KEY_INVALID',
    });
  });
});

describe('FinancialUseCase: identity, hash, and cross-identity conflicts', () => {
  test('rejects same idempotency key with altered payload hash as WAGER_IDEMPOTENCY_CONFLICT', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_hash_conflict';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };
    const idempotencyKey = 'key_shared_conflict_01';

    // First request succeeds
    const initialPayload = {
      providerId,
      externalTransactionId: 'ext_hash_01',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_hash',
      gameId: 'game_hash',
      kind: 'BET' as const,
      money: { amount: '10.00', currency: seeded.currency },
    };
    const res1 = await useCase.execute(initialPayload, idempotencyKey, context);
    expect(res1.status).toBe('PROCESSED');

    // Second request with SAME idempotency key but altered amount (different business hash)
    const alteredPayload = {
      ...initialPayload,
      money: { amount: '20.00', currency: seeded.currency },
    };

    let caughtError: unknown;
    try {
      await useCase.execute(alteredPayload, idempotencyKey, context);
    } catch (error) {
      caughtError = error;
    }
    expectApplicationError(caughtError, {
      category: 'ConflictError',
      code: 'WAGER_IDEMPOTENCY_CONFLICT',
    });
    const em = appDb().em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, { id: seeded.walletId });
    expect(wallet.balance).toBe('90.00');
    expect(wallet.version).toBe('2');
    expect(await em.count(WagerTransactionRecord, { walletId: seeded.walletId })).toBe(2);
    expect(await em.count(WalletLedgerEntryRecord, { walletId: seeded.walletId })).toBe(
      2,
    );
    expect(await em.count(OutboxMessageRecord, { aggregateId: seeded.walletId })).toBe(2);
  });

  test('rejects different idempotency key with same externalTransactionId as WAGER_EXTERNAL_IDENTITY_CONFLICT', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_ext_conflict';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };
    const externalTransactionId = 'ext_collision_01';

    // First request with key 1
    const payload1 = {
      providerId,
      externalTransactionId,
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_ext',
      gameId: 'game_ext',
      kind: 'BET' as const,
      money: { amount: '15.00', currency: seeded.currency },
    };
    const res1 = await useCase.execute(payload1, 'key_first_01', context);
    expect(res1.status).toBe('PROCESSED');

    // Second request with DIFFERENT key 2 but SAME externalTransactionId
    const payload2 = {
      ...payload1,
    };

    let caughtError: unknown;
    try {
      await useCase.execute(payload2, 'key_second_alias_02', context);
    } catch (error) {
      caughtError = error;
    }
    expectApplicationError(caughtError, {
      category: 'ConflictError',
      code: 'WAGER_EXTERNAL_IDENTITY_CONFLICT',
    });
    const em = appDb().em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, { id: seeded.walletId });
    expect(wallet.balance).toBe('85.00');
    expect(wallet.version).toBe('2');
    expect(await em.count(WagerTransactionRecord, { walletId: seeded.walletId })).toBe(2);
    expect(await em.count(WalletLedgerEntryRecord, { walletId: seeded.walletId })).toBe(
      2,
    );
    expect(await em.count(OutboxMessageRecord, { aggregateId: seeded.walletId })).toBe(2);
  });
});

describe('FinancialUseCase: durable wallet rejections & uppercase UUID handling', () => {
  test('persists durable rejection for missing wallet with WALLET_NOT_FOUND without fabricating balance', async () => {
    const providerId = 'prov_missing_wallet';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };
    const missingWalletId = crypto.randomUUID();
    const playerId = crypto.randomUUID();

    const payload = {
      providerId,
      externalTransactionId: 'ext_miss_wall_01',
      playerId,
      walletId: missingWalletId,
      roundId: 'round_mw',
      gameId: 'game_mw',
      kind: 'BET' as const,
      money: { amount: '10.00', currency: 'BRL' },
    };
    const key = 'key_miss_wall_01';

    const result = await useCase.execute(payload, key, context);
    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(FailureCode.WalletNotFound);
    expect(result.balance).toBeUndefined(); // NEVER fabricate balance when no valid wallet observed
    expect(result.idempotentReplay).toBe(false);

    // Verify DB stored transaction
    const em = appDb().em.fork();
    const stored = await em.findOneOrFail(WagerTransactionRecord, {
      id: result.transactionId,
    });
    expect(stored.status).toBe('REJECTED');
    expect(stored.failureCode).toBe(FailureCode.WalletNotFound);
    expect(stored.result?.balance).toBeUndefined();

    // Replay of missing wallet rejection
    const replayed = await useCase.execute(payload, key, context);
    expect(replayed.transactionId).toBe(result.transactionId);
    expect(replayed.status).toBe('REJECTED');
    expect(replayed.failureCode).toBe(FailureCode.WalletNotFound);
    expect(replayed.balance).toBeUndefined();
    expect(replayed.idempotentReplay).toBe(true);
  });

  test('persists durable rejection for player and currency mismatches without mutating existing wallet', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00', currency: 'BRL' }));
    const providerId = 'prov_wall_mismatch';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    // 1. Player mismatch
    const playerMismatchPayload = {
      providerId,
      externalTransactionId: 'ext_pm_01',
      playerId: crypto.randomUUID(), // different player
      walletId: seeded.walletId,
      roundId: 'round_mismatch',
      gameId: 'game_mismatch',
      kind: 'BET' as const,
      money: { amount: '10.00', currency: seeded.currency },
    };
    const pmResult = await useCase.execute(playerMismatchPayload, 'key_pm_01', context);
    expect(pmResult.status).toBe('REJECTED');
    expect(pmResult.failureCode).toBe(FailureCode.WalletPlayerMismatch);

    // 2. Currency mismatch
    const currencyMismatchPayload = {
      providerId,
      externalTransactionId: 'ext_cm_01',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_mismatch',
      gameId: 'game_mismatch',
      kind: 'BET' as const,
      money: { amount: '10.00', currency: 'USD' }, // wallet is BRL
    };
    const cmResult = await useCase.execute(currencyMismatchPayload, 'key_cm_01', context);
    expect(cmResult.status).toBe('REJECTED');
    expect(cmResult.failureCode).toBe(FailureCode.WalletCurrencyMismatch);

    // Verify existing wallet is completely unmodified
    const em = appDb().em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, { id: seeded.walletId });
    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe('1');
  });

  test('persists durable rejection for insufficient funds on BET, preserving original balance', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '50.00' }));
    const providerId = 'prov_insufficient';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    const payload = {
      providerId,
      externalTransactionId: 'ext_insuf_01',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_insuf',
      gameId: 'game_insuf',
      kind: 'BET' as const,
      money: { amount: '100.00', currency: seeded.currency }, // 100.00 > 50.00 balance
    };
    const key = 'key_insuf_01';

    const result = await useCase.execute(payload, key, context);
    expect(result.status).toBe('REJECTED');
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance).toEqual({ amount: '50.00', currency: seeded.currency });
    expect(result.walletVersion).toBe('1');
    expect(result.idempotentReplay).toBe(false);

    // Verify wallet in DB is still 50.00 at version 1
    const em = appDb().em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, { id: seeded.walletId });
    expect(wallet.balance).toBe('50.00');
    expect(wallet.version).toBe('1');

    // Replay of insufficient funds rejection
    const replayed = await useCase.execute(payload, key, context);
    expect(replayed).toEqual({ ...result, idempotentReplay: true });
    const replayEm = appDb().em.fork();
    const replayWallet = await replayEm.findOneOrFail(WalletRecord, {
      id: seeded.walletId,
    });
    expect(replayWallet.balance).toBe('50.00');
    expect(replayWallet.version).toBe('1');
    expect(
      await replayEm.count(WagerTransactionRecord, { walletId: seeded.walletId }),
    ).toBe(2);
    expect(
      await replayEm.count(WalletLedgerEntryRecord, { walletId: seeded.walletId }),
    ).toBe(1);
    expect(
      await replayEm.count(OutboxMessageRecord, { aggregateId: seeded.walletId }),
    ).toBe(1);
  });

  test('processes uppercase UUID payload without false mismatch rejection and replays cleanly', async () => {
    // Seed wallet with lowercase UUIDs
    const walletId = crypto.randomUUID().toLowerCase();
    const playerId = crypto.randomUUID().toLowerCase();
    await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { walletId, playerId, balance: '100.00' }));

    const providerId = 'prov_case_uuid';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    // Payload uses UPPERCASE UUIDs
    const upperWalletId = walletId.toUpperCase();
    const upperPlayerId = playerId.toUpperCase();
    const payload = {
      providerId,
      externalTransactionId: 'ext_upper_uuid_01',
      playerId: upperPlayerId,
      walletId: upperWalletId,
      roundId: 'round_upper',
      gameId: 'game_upper',
      kind: 'BET' as const,
      money: { amount: '25.00', currency: 'BRL' },
    };
    const key = 'key_upper_uuid_01';

    const result = await useCase.execute(payload, key, context);
    expect(result.status).toBe('PROCESSED');
    expect(result.balance?.amount).toBe('75.00');
    expect(result.walletVersion).toBe('2');
    expect(result.idempotentReplay).toBe(false);

    // Replay with identical uppercase UUIDs
    const replayed = await useCase.execute(payload, key, context);
    expect(replayed.status).toBe('PROCESSED');
    expect(replayed.idempotentReplay).toBe(true);
    expect(replayed.balance?.amount).toBe('75.00');
  });
});

describe('FinancialUseCase: reference semantics, pending references, and full reversal exclusivity', () => {
  test('handles supplied reference context and PENDING_REFERENCE transitions for BET and LOSS', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_ref_semantics';
    const roundId = 'round_ref_sem';
    const gameId = 'game_ref_sem';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    // 1. Primary BET with absent reference processes immediately without dependency
    const bet1 = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_bet_independent',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'BET',
        money: { amount: '10.00', currency: seeded.currency },
      },
      'key_bet_indep',
      context,
    );
    expect(bet1.status).toBe('PROCESSED');

    // 2. BET with supplied reference pointing to missing transaction transitions to PENDING_REFERENCE
    const pendingBet = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_bet_with_missing_ref',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'BET',
        money: { amount: '10.00', currency: seeded.currency },
        referenceExternalTransactionId: 'ext_missing_parent_bet',
      },
      'key_bet_missing_ref',
      context,
    );
    expect(pendingBet.status).toBe('PENDING_REFERENCE');
    expect(pendingBet.idempotentReplay).toBe(false);

    // 3. LOSS with absent reference processes immediately
    const lossIndep = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_loss_indep',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'LOSS',
        money: { amount: '0.00', currency: seeded.currency },
      },
      'key_loss_indep',
      context,
    );
    expect(lossIndep.status).toBe('PROCESSED');

    // 4. LOSS with supplied reference pointing to missing transaction transitions to PENDING_REFERENCE
    const pendingLoss = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_loss_with_missing_ref',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'LOSS',
        money: { amount: '0.00', currency: seeded.currency },
        referenceExternalTransactionId: 'ext_nonexistent_ref_for_loss',
      },
      'key_loss_missing_ref',
      context,
    );
    expect(pendingLoss.status).toBe('PENDING_REFERENCE');

    // 5. LOSS with supplied reference pointing to valid PROCESSED transaction in same context processes
    const resolvedLoss = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_loss_valid_ref',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'LOSS',
        money: { amount: '0.00', currency: seeded.currency },
        referenceExternalTransactionId: 'ext_bet_independent',
      },
      'key_loss_valid_ref',
      context,
    );
    expect(resolvedLoss.status).toBe('PROCESSED');
  });

  test('emits single outbox event for PENDING_REFERENCE and replays idempotently without duplicate event', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_pend_replay';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    const payload = {
      providerId,
      externalTransactionId: 'ext_pend_01',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_pend',
      gameId: 'game_pend',
      kind: 'REFUND' as const,
      money: { amount: '20.00', currency: seeded.currency },
      referenceExternalTransactionId: 'ext_unseen_bet_parent',
    };
    const key = 'key_pend_01';

    // First attempt: enters PENDING_REFERENCE
    const result1 = await useCase.execute(payload, key, context);
    expect(result1.status).toBe('PENDING_REFERENCE');
    expect(result1.idempotentReplay).toBe(false);

    // Verify outbox has exactly one WagerTransactionPendingReference event
    const em1 = appDb().em.fork();
    const pendingEvents = (
      await em1.find(OutboxMessageRecord, {
        aggregateId: seeded.walletId,
        eventType: 'WagerTransactionPendingReference',
      })
    ).filter(
      (m) =>
        eventPayloadSchema.parse(m.payload).data.transactionId === result1.transactionId,
    );
    expect(pendingEvents.length).toBe(1);
    // Replay pending operation
    const result2 = await useCase.execute(payload, key, context);
    expect(result2.transactionId).toBe(result1.transactionId);
    expect(result2.status).toBe('PENDING_REFERENCE');
    expect(result2.idempotentReplay).toBe(true);

    // Verify NO second event emitted on replay
    const em2 = appDb().em.fork();
    const pendingEventsAfterReplay = (
      await em2.find(OutboxMessageRecord, {
        aggregateId: seeded.walletId,
        eventType: 'WagerTransactionPendingReference',
      })
    ).filter(
      (m) =>
        eventPayloadSchema.parse(m.payload).data.transactionId === result1.transactionId,
    );
    expect(pendingEventsAfterReplay.length).toBe(1);
  });

  test('validates reference context before waiting: pending reference with mismatched context rejects immediately without pending event', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_pend_ctx_order';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    // 1. Create a parent transaction that is currently in PENDING_REFERENCE state in round_A
    const parentExtId = 'ext_parent_currently_pending';
    const pendingParentResult = await useCase.execute(
      {
        providerId,
        externalTransactionId: parentExtId,
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId: 'round_A',
        gameId: 'game_A',
        kind: 'BET',
        money: { amount: '10.00', currency: seeded.currency },
        referenceExternalTransactionId: 'ext_grandparent_unseen',
      },
      'key_parent_pend',
      context,
    );
    expect(pendingParentResult.status).toBe('PENDING_REFERENCE');

    // 2. Child REFUND referencing parent with MISMATCHED round (round_B vs round_A)
    // MUST reject immediately with ReferenceRoundMismatch, NOT wait in PENDING_REFERENCE!
    const mismatchedChildResult = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_child_mismatched_ctx',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId: 'round_B', // Mismatch!
        gameId: 'game_A',
        kind: 'REFUND',
        money: { amount: '10.00', currency: seeded.currency },
        referenceExternalTransactionId: parentExtId,
      },
      'key_child_mismatched',
      context,
    );

    expect(mismatchedChildResult.status).toBe('REJECTED');
    expect(mismatchedChildResult.failureCode).toBe(FailureCode.ReferenceRoundMismatch);

    // Verify outbox has WagerTransactionRejected, NOT WagerTransactionPendingReference
    const emCheck = appDb().em.fork();
    const rejectedEvents = (
      await emCheck.find(OutboxMessageRecord, {
        aggregateId: seeded.walletId,
        eventType: 'WagerTransactionRejected',
      })
    ).filter(
      (m) =>
        eventPayloadSchema.parse(m.payload).data.transactionId ===
        mismatchedChildResult.transactionId,
    );
    expect(rejectedEvents.length).toBe(1);

    const pendingEvents = (
      await emCheck.find(OutboxMessageRecord, {
        aggregateId: seeded.walletId,
        eventType: 'WagerTransactionPendingReference',
      })
    ).filter(
      (m) =>
        eventPayloadSchema.parse(m.payload).data.transactionId ===
        mismatchedChildResult.transactionId,
    );
    expect(pendingEvents.length).toBe(0);

    // 3. Child REFUND referencing parent with MATCHING round (round_A)
    // Context matches, but parent is still pending -> transitions to PENDING_REFERENCE!
    const matchingChildResult = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_child_matching_ctx',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId: 'round_A', // Matches!
        gameId: 'game_A',
        kind: 'REFUND',
        money: { amount: '10.00', currency: seeded.currency },
        referenceExternalTransactionId: parentExtId,
      },
      'key_child_matching',
      context,
    );

    expect(matchingChildResult.status).toBe('PENDING_REFERENCE');

    const matchingPendingEvents = (
      await emCheck.find(OutboxMessageRecord, {
        aggregateId: seeded.walletId,
        eventType: 'WagerTransactionPendingReference',
      })
    ).filter(
      (m) =>
        eventPayloadSchema.parse(m.payload).data.transactionId ===
        matchingChildResult.transactionId,
    );
    expect(matchingPendingEvents.length).toBe(1);
  });

  test('enforces reference context matches (round, player, wallet, currency) and rejects mismatches', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_ref_ctx';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    // Seed target BET in round 1
    const betPayload = {
      providerId,
      externalTransactionId: 'ext_target_bet_01',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_1',
      gameId: 'game_1',
      kind: 'BET' as const,
      money: { amount: '30.00', currency: seeded.currency },
    };
    await useCase.execute(betPayload, 'key_target_bet_01', context);

    // REFUND referencing target BET but with DIFFERENT round (round_2)
    const refundMismatchPayload = {
      providerId,
      externalTransactionId: 'ext_refund_mismatch_01',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_2', // mismatch
      gameId: 'game_1',
      kind: 'REFUND' as const,
      money: { amount: '30.00', currency: seeded.currency },
      referenceExternalTransactionId: 'ext_target_bet_01',
    };
    const res = await useCase.execute(
      refundMismatchPayload,
      'key_ref_mismatch_01',
      context,
    );
    expect(res.status).toBe('REJECTED');
    expect(res.failureCode).toBe(FailureCode.ReferenceRoundMismatch);
  });

  test('enforces full amount and reversal exclusivity including ROLLBACK of REFUND', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_reversals';
    const roundId = 'round_rev';
    const gameId = 'game_rev';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    // 1. Process initial BET of 40.00 (balance becomes 60.00)
    const betPayload = {
      providerId,
      externalTransactionId: 'ext_rev_bet_01',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId,
      gameId,
      kind: 'BET' as const,
      money: { amount: '40.00', currency: seeded.currency },
    };
    const betRes = await useCase.execute(betPayload, 'key_rev_bet_01', context);
    expect(betRes.status).toBe('PROCESSED');
    expect(betRes.balance?.amount).toBe('60.00');

    // 2. Partial REFUND (amount 20.00 != BET 40.00) must be rejected
    const partialRefund = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_rev_refund_partial',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'REFUND',
        money: { amount: '20.00', currency: seeded.currency },
        referenceExternalTransactionId: 'ext_rev_bet_01',
      },
      'key_rev_refund_partial',
      context,
    );
    expect(partialRefund.status).toBe('REJECTED');
    expect(partialRefund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);

    // 3. Full REFUND of 40.00 succeeds (balance credits back to 100.00)
    const fullRefund = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_rev_refund_full',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId: 'different-game-refund',
        kind: 'REFUND',
        money: { amount: '40.00', currency: seeded.currency },
        referenceExternalTransactionId: 'ext_rev_bet_01',
      },
      'key_rev_refund_full',
      context,
    );
    expect(fullRefund.status).toBe('PROCESSED');
    expect(fullRefund.balance?.amount).toBe('100.00');

    // 4. Second REFUND on the same BET is rejected (REFERENCE_ALREADY_REVERSED)
    const secondRefund = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_rev_refund_second',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'REFUND',
        money: { amount: '40.00', currency: seeded.currency },
        referenceExternalTransactionId: 'ext_rev_bet_01',
      },
      'key_rev_refund_second',
      context,
    );
    expect(secondRefund.status).toBe('REJECTED');
    expect(secondRefund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);

    // 5. ROLLBACK on the original BET is ALSO rejected (already consumed by REFUND)
    const rollbackOnBet = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_rev_rollback_bet',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'ROLLBACK',
        money: { amount: '40.00', currency: seeded.currency },
        referenceExternalTransactionId: 'ext_rev_bet_01',
      },
      'key_rev_rollback_bet',
      context,
    );
    expect(rollbackOnBet.status).toBe('REJECTED');
    expect(rollbackOnBet.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);

    // 6. ROLLBACK targeting the processed REFUND succeeds and debits the wallet back to 60.00
    const rollbackOnRefund = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_rev_rollback_refund',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'ROLLBACK',
        money: { amount: '40.00', currency: seeded.currency },
        referenceExternalTransactionId: 'ext_rev_refund_full',
      },
      'key_rev_rollback_refund',
      context,
    );
    expect(rollbackOnRefund.status).toBe('PROCESSED');
    expect(rollbackOnRefund.balance?.amount).toBe('60.00');

    // 7. Second ROLLBACK on the REFUND is rejected
    const secondRollbackOnRefund = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_rev_rollback_refund_2',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'ROLLBACK',
        money: { amount: '40.00', currency: seeded.currency },
        referenceExternalTransactionId: 'ext_rev_refund_full',
      },
      'key_rev_rollback_refund_2',
      context,
    );
    expect(secondRollbackOnRefund.status).toBe('REJECTED');
    expect(secondRollbackOnRefund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);

    // 8. Rolling back REFUND does NOT release original BET: re-attempting REFUND on original BET remains rejected
    const thirdRefundOnBet = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_rev_refund_third',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'REFUND',
        money: { amount: '40.00', currency: seeded.currency },
        referenceExternalTransactionId: 'ext_rev_bet_01',
      },
      'key_rev_refund_third',
      context,
    );
    expect(thirdRefundOnBet.status).toBe('REJECTED');
    expect(thirdRefundOnBet.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test('rejects debit ROLLBACK when wallet has insufficient balance with INSUFFICIENT_REFUND_BALANCE', async () => {
    // Seed wallet with 50.00, process a WIN of 50.00 (total 100.00), then debit 90.00 (leaving 10.00)
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_rollback_insuf';
    const roundId = 'round_rb_insuf';
    const gameId = 'game_rb_insuf';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    // BET of 10.00 -> balance 90.00
    await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_target_for_win',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'BET',
        money: { amount: '10.00', currency: seeded.currency },
      },
      'key_target_for_win',
      context,
    );

    // WIN of 80.00 -> balance 170.00
    await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_win_to_rollback',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'WIN',
        money: { amount: '80.00', currency: seeded.currency },
        referenceExternalTransactionId: 'ext_target_for_win',
      },
      'key_win_to_rollback',
      context,
    );

    // BET of 150.00 -> balance becomes 20.00
    await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_bet_drain',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'BET',
        money: { amount: '150.00', currency: seeded.currency },
      },
      'key_bet_drain',
      context,
    );

    // Now attempt ROLLBACK of the 80.00 WIN: requires debiting 80.00, but wallet only has 20.00!
    const rollbackResult = await useCase.execute(
      {
        providerId,
        externalTransactionId: 'ext_rollback_insuf',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'ROLLBACK',
        money: { amount: '80.00', currency: seeded.currency },
        referenceExternalTransactionId: 'ext_win_to_rollback',
      },
      'key_rollback_insuf',
      context,
    );

    expect(rollbackResult.status).toBe('REJECTED');
    expect(rollbackResult.failureCode).toBe(FailureCode.InsufficientRefundBalance);
    expect(rollbackResult.balance?.amount).toBe('20.00');

    // Verify wallet balance remained 20.00
    const em = appDb().em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, { id: seeded.walletId });
    expect(wallet.balance).toBe('20.00');
  });
});

describe('FinancialUseCase: inbox deduplication, hash conflict, and consumer isolation', () => {
  test('executes command, dedups identical message, isolates consumers, and rejects hash conflict', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_inbox_cmd';
    const roundId = 'round_cmd';
    const gameId = 'game_cmd';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    const messageId = 'sqs_msg_001';
    const envelope = {
      messageId,
      type: 'WagerTransactionRequested' as const,
      occurredAt: new Date().toISOString(),
      data: {
        idempotencyKey: 'key_cmd_bet_01',
        providerId,
        externalTransactionId: 'ext_cmd_bet_01',
        playerId: seeded.playerId,
        walletId: seeded.walletId,
        roundId,
        gameId,
        kind: 'BET' as const,
        money: { amount: '35.00', currency: seeded.currency },
      },
    };

    // 1. Initial executeCommand under consumer 'consumer_A'
    const cmdResult1 = await useCase.executeCommand(
      validateSqsWagerMessage(envelope),
      'consumer_A',
      context,
    );
    expect(cmdResult1.status).toBe('PROCESSED');
    expect(cmdResult1.balance?.amount).toBe('65.00');
    expect(cmdResult1.idempotentReplay).toBe(false);

    // Verify inbox record committed
    const em1 = appDb().em.fork();
    const inboxRowA = await em1.findOneOrFail(InboxMessageRecord, {
      consumerName: 'consumer_A',
      messageId,
    });
    expect(inboxRowA.processedAt).toBeInstanceOf(Date);

    // 2. Duplicate executeCommand under consumer 'consumer_A': returns replayed result
    const cmdResult2 = await useCase.executeCommand(
      validateSqsWagerMessage(envelope),
      'consumer_A',
      context,
    );
    expect(cmdResult2.status).toBe('PROCESSED');
    expect(cmdResult2.balance?.amount).toBe('65.00');
    expect(cmdResult2.idempotentReplay).toBe(true);

    // 3. Hash conflict: same consumer 'consumer_A' + same messageId, but altered payload
    const alteredEnvelope = {
      ...envelope,
      data: {
        ...envelope.data,
        money: { amount: '40.00', currency: seeded.currency },
      },
    };
    let caughtConflict: unknown;
    try {
      await useCase.executeCommand(
        validateSqsWagerMessage(alteredEnvelope),
        'consumer_A',
        context,
      );
    } catch (error) {
      caughtConflict = error;
    }
    expectApplicationError(caughtConflict, {
      category: 'ConflictError',
      code: 'INBOX_MESSAGE_CONFLICT',
    });
    const conflictEm = appDb().em.fork();
    const conflictWallet = await conflictEm.findOneOrFail(WalletRecord, {
      id: seeded.walletId,
    });
    expect(conflictWallet.balance).toBe('65.00');
    expect(conflictWallet.version).toBe('2');
    expect(
      await conflictEm.count(WagerTransactionRecord, { walletId: seeded.walletId }),
    ).toBe(2);
    expect(
      await conflictEm.count(WalletLedgerEntryRecord, { walletId: seeded.walletId }),
    ).toBe(2);
    expect(
      await conflictEm.count(OutboxMessageRecord, { aggregateId: seeded.walletId }),
    ).toBe(2);

    // 4. Consumer isolation: same messageId under consumer 'consumer_B'
    // Consumer B has its own inbox namespace. However, since the underlying wager operation has
    // the same providerId + idempotencyKey, the internal financial flow returns the replayed operation!
    const cmdResultB = await useCase.executeCommand(
      validateSqsWagerMessage(envelope),
      'consumer_B',
      context,
    );
    expect(cmdResultB.status).toBe('PROCESSED');
    expect(cmdResultB.balance?.amount).toBe('65.00');
    expect(cmdResultB.idempotentReplay).toBe(true);

    const em2 = appDb().em.fork();
    const inboxRowB = await em2.findOneOrFail(InboxMessageRecord, {
      consumerName: 'consumer_B',
      messageId,
    });
    expect(inboxRowB.processedAt).toBeInstanceOf(Date);
  });
});

describe('FinancialUseCase: atomic rollback on late real PostgreSQL failure', () => {
  test('completely rolls back transaction, wallet updates, ledger, and outbox on late DB failure', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_atomic_rollback';
    const failingCorrelationId = 'fail_late_correlation_' + crypto.randomUUID();
    const context: FinancialContext = {
      providerId,
      correlationId: failingCorrelationId,
    };

    // Install a real PostgreSQL trigger on outbox_messages that throws late when the correlationId matches
    const knex = appDb().em.getConnection().getKnex();
    await knex.raw(`
      CREATE OR REPLACE FUNCTION fail_late_on_outbox() RETURNS trigger AS $$
      BEGIN
        IF NEW.payload->>'correlationId' = '${failingCorrelationId}' THEN
          RAISE EXCEPTION 'Simulated real PostgreSQL late commit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_test_fail_late
      BEFORE INSERT ON outbox_messages
      FOR EACH ROW EXECUTE FUNCTION fail_late_on_outbox();
    `);

    const payload = {
      providerId,
      externalTransactionId: 'ext_fail_late_01',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_fl',
      gameId: 'game_fl',
      kind: 'BET' as const,
      money: { amount: '30.00', currency: seeded.currency },
    };

    let caughtError: unknown;
    try {
      await useCase.execute(payload, 'key_fail_late_01', context);
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeDefined();

    // Verify full atomic rollback in PostgreSQL:
    const emVerify = appDb().em.fork();

    // 1. Wallet balance and version are strictly unchanged
    const wallet = await emVerify.findOneOrFail(WalletRecord, { id: seeded.walletId });
    expect(wallet.balance).toBe('100.00');
    expect(wallet.version).toBe('1');

    // 2. No wager_transaction record exists
    const tx = await emVerify.findOne(WagerTransactionRecord, {
      externalTransactionId: payload.externalTransactionId,
    });
    expect(tx).toBeNull();

    // 3. No ledger entry exists for this wallet beyond opening
    const ledgerEntries = await emVerify.find(WalletLedgerEntryRecord, {
      walletId: seeded.walletId,
    });
    expect(ledgerEntries.length).toBe(1); // only opening

    // 4. Clean up trigger
    await knex.raw(`
      DROP TRIGGER IF EXISTS trg_test_fail_late ON outbox_messages;
      DROP FUNCTION IF EXISTS fail_late_on_outbox();
    `);

    // 5. Subsequent normal operation on the same wallet succeeds cleanly
    const normalResult = await useCase.execute(
      {
        ...payload,
        externalTransactionId: 'ext_after_rollback_recovered',
      },
      'key_after_rollback_recovered',
      { providerId, correlationId: 'normal_corr_01' },
    );
    expect(normalResult.status).toBe('PROCESSED');
    expect(normalResult.balance?.amount).toBe('70.00');
  });
});

describe('FinancialUseCase: concurrency, simultaneous duplicates, and competing bets', () => {
  test('handles simultaneous duplicate requests with one execution and one idempotent replay', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_simul_dup';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    const payload = {
      providerId,
      externalTransactionId: 'ext_simul_01',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_simul',
      gameId: 'game_simul',
      kind: 'BET' as const,
      money: { amount: '40.00', currency: seeded.currency },
    };
    const key = 'key_simul_01';

    // Fire two identical requests simultaneously
    const [res1, res2] = await Promise.all([
      useCase.execute(payload, key, context),
      useCase.execute(payload, key, context),
    ]);

    expect(res1.status).toBe('PROCESSED');
    expect(res2.status).toBe('PROCESSED');
    expect(res1.balance?.amount).toBe('60.00');
    expect(res2.balance?.amount).toBe('60.00');

    // Exactly one was the original and one was the idempotent replay
    const replays = [res1.idempotentReplay, res2.idempotentReplay];
    expect(replays).toContain(false);
    expect(replays).toContain(true);

    // Verify wallet balance was debited ONLY ONCE (60.00, not 20.00)
    const em = appDb().em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, { id: seeded.walletId });
    expect(wallet.balance).toBe('60.00');
    expect(wallet.version).toBe('2');

    // Verify only one ledger entry was appended
    const ledgers = await em.find(WalletLedgerEntryRecord, {
      transactionId: res1.transactionId,
    });
    expect(ledgers.length).toBe(1);
  });

  test('re-evaluates competing 80-bets on 100 balance: exactly one succeeds and one rejected for insufficient funds', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'prov_competing_bets';
    const context: FinancialContext = {
      providerId,
      correlationId: crypto.randomUUID(),
    };

    const bet1 = {
      providerId,
      externalTransactionId: 'ext_comp_bet_1',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_comp',
      gameId: 'game_comp',
      kind: 'BET' as const,
      money: { amount: '80.00', currency: seeded.currency },
    };

    const bet2 = {
      providerId,
      externalTransactionId: 'ext_comp_bet_2',
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_comp',
      gameId: 'game_comp',
      kind: 'BET' as const,
      money: { amount: '80.00', currency: seeded.currency },
    };

    // Fire competing bets concurrently
    const [res1, res2] = await Promise.all([
      useCase.execute(bet1, 'key_comp_1', context),
      useCase.execute(bet2, 'key_comp_2', context),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);

    const processed = res1.status === 'PROCESSED' ? res1 : res2;
    const rejected = res1.status === 'REJECTED' ? res1 : res2;

    expect(processed.balance?.amount).toBe('20.00');
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(rejected.balance?.amount).toBe('20.00');

    // Authoritative final wallet balance in DB is strictly 20.00 (NOT -60.00!)
    const em = appDb().em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, { id: seeded.walletId });
    expect(wallet.balance).toBe('20.00');
    expect(wallet.version).toBe('2');
  });
});
describe('FinancialUseCase: unknown commit outcome handling and replay recovery', () => {
  test('simulates lost commit confirmation after real commit at runner boundary: returns safe DATABASE_COMMIT_OUTCOME_UNKNOWN error and idempotent retry returns committed historical replay with single ledger effect', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'provider-a';
    const externalTransactionId = 'ext_lost_commit_' + crypto.randomUUID();
    const idempotencyKey = 'key_lost_commit_' + crypto.randomUUID();
    const bet = {
      providerId,
      externalTransactionId,
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: 'round_lost_commit',
      gameId: 'game_lost_commit',
      kind: 'BET' as const,
      money: { amount: '40.00', currency: seeded.currency },
    };
    const context: FinancialContext = {
      providerId,
      correlationId: 'corr_lost_commit',
    };

    const knex = appDb().em.getConnection().getKnex();
    const client = knex.client as {
      query: (conn: object, q: unknown) => Promise<unknown>;
    };
    const originalQuery = client.query;
    let simulateLostConfirmation = true;

    client.query = async function (connection: object, query: unknown) {
      const result = await originalQuery.call(this, connection, query);
      const statement =
        typeof query === 'object' && query !== null && 'sql' in query ? query.sql : query;
      if (
        simulateLostConfirmation &&
        typeof statement === 'string' &&
        /^COMMIT\b/i.test(statement)
      ) {
        simulateLostConfirmation = false;
        throw new Error(
          'Simulated network drop / lost connection after COMMIT confirmed by PostgreSQL',
        );
      }
      return result;
    };

    let thrown: unknown;
    try {
      await useCase.execute(bet, idempotencyKey, context);
    } catch (error) {
      thrown = error;
    } finally {
      client.query = originalQuery;
    }

    const appError = expectApplicationError(thrown, {
      category: 'ExternalConnectionError',
      code: 'DATABASE_COMMIT_OUTCOME_UNKNOWN',
    });
    expect(Object.keys(appError.toJSON()).sort()).toEqual([
      'category',
      'code',
      'message',
    ]);

    // 2. PostgreSQL committed the transaction before connection failure
    const emAfter = appDb().em.fork();
    const txRow = await emAfter.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId,
    });
    expect(txRow.status).toBe('PROCESSED');

    const walletAfter = await emAfter.findOneOrFail(WalletRecord, {
      id: seeded.walletId,
    });
    expect(walletAfter.balance).toBe('60.00');
    expect(walletAfter.version).toBe('2');

    const queried = await new WageringQueryUseCase(
      new DatabaseTransactionRunner(appDb()),
    ).getTransactionByExternal(providerId, externalTransactionId);
    expect(queried.id).toBe(txRow.id);
    await useCase.execute(
      {
        ...bet,
        externalTransactionId: crypto.randomUUID(),
        kind: 'WIN',
        money: { amount: '10.00', currency: seeded.currency },
      },
      crypto.randomUUID(),
      context,
    );
    const retryResult = await useCase.execute(bet, idempotencyKey, context);
    expect(retryResult.idempotentReplay).toBe(true);
    expect(retryResult.status).toBe('PROCESSED');
    expect(retryResult.transactionId).toBe(txRow.id);
    expect(retryResult.balance?.amount).toBe('60.00');
    expect(retryResult.walletVersion).toBe('2');

    // 4. Ledger effect remains strictly single (no double-debit)
    const ledgerEntries = await emAfter.find(WalletLedgerEntryRecord, {
      transactionId: txRow.id,
    });
    expect(ledgerEntries.length).toBe(1);
    emAfter.clear();

    const recheckWallet = await emAfter.findOneOrFail(WalletRecord, {
      id: seeded.walletId,
    });
    expect(recheckWallet.balance).toBe('70.00');
    expect(recheckWallet.version).toBe('3');
  });

  test('simulates aborted commit during connection termination: returns safe DATABASE_COMMIT_OUTCOME_UNKNOWN with no confirmed result in database and allows subsequent fresh submission', async () => {
    const seeded = await appDb()
      .em.fork()
      .transactional((em) => seedWallet(em, { balance: '100.00' }));
    const providerId = 'provider-a';
    const externalTransactionId = 'ext_abort_' + crypto.randomUUID();
    const idempotencyKey = 'key_abort_' + crypto.randomUUID();
    const abortRoundId = 'round_abort_' + crypto.randomUUID();
    const bet = {
      providerId,
      externalTransactionId,
      playerId: seeded.playerId,
      walletId: seeded.walletId,
      roundId: abortRoundId,
      gameId: 'game_abort',
      kind: 'BET' as const,
      money: { amount: '40.00', currency: seeded.currency },
    };
    const context: FinancialContext = {
      providerId,
      correlationId: 'corr_abort',
    };

    // Install isolated deferred trigger in this test DB only
    const conn = appDb().em.getConnection();
    await conn.execute(`
      CREATE OR REPLACE FUNCTION test_terminate_commit_abort() RETURNS trigger AS $$
      BEGIN
        IF NEW.round_id = '${abortRoundId}' THEN
          PERFORM pg_terminate_backend(pg_backend_pid());
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE CONSTRAINT TRIGGER trigger_test_terminate_commit_abort
      AFTER INSERT ON wager_transactions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION test_terminate_commit_abort();
    `);

    let thrown: unknown;
    try {
      await useCase.execute(bet, idempotencyKey, context);
    } catch (error) {
      thrown = error;
    } finally {
      await conn.execute(`
        DROP TRIGGER IF EXISTS trigger_test_terminate_commit_abort ON wager_transactions;
        DROP FUNCTION IF EXISTS test_terminate_commit_abort();
      `);
    }

    const appError = expectApplicationError(thrown, {
      category: 'ExternalConnectionError',
      code: 'DATABASE_COMMIT_OUTCOME_UNKNOWN',
    });
    expect(Object.keys(appError.toJSON()).sort()).toEqual([
      'category',
      'code',
      'message',
    ]);

    // 2. Verify no confirmed result in PostgreSQL (transaction was aborted)
    const emAfter = appDb().em.fork();
    const txRow = await emAfter.findOne(WagerTransactionRecord, {
      externalTransactionId,
    });
    expect(txRow).toBeNull();

    const walletAfter = await emAfter.findOneOrFail(WalletRecord, {
      id: seeded.walletId,
    });
    expect(walletAfter.balance).toBe('100.00');
    expect(walletAfter.version).toBe('1');

    // 3. Resubmit original identity: now succeeds with fresh execution
    const retryResult = await useCase.execute(bet, idempotencyKey, context);
    expect(retryResult.idempotentReplay).toBe(false);
    expect(retryResult.status).toBe('PROCESSED');
    expect(retryResult.balance?.amount).toBe('60.00');
    expect(retryResult.walletVersion).toBe('2');

    const confirmedTx = await emAfter.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId,
    });
    expect(confirmedTx.status).toBe('PROCESSED');
    expect(confirmedTx.id).toBe(retryResult.transactionId);
  });
});
