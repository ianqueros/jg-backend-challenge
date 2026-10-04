import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { createDatabaseOptions } from '../../src/core/database/database.config.js';
import { DatabaseTransactionRunner } from '../../src/core/database/database-transaction.runner.js';
import { TransactionRepositories } from '../../src/shared/transaction-repositories.js';
import {
  FinancialUseCase,
  type FinancialContext,
} from '../../src/domains/wagering/financial.use-case.js';
import { WalletUseCase } from '../../src/domains/wallet/wallet.use-case.js';
import { ReferenceWorker } from '../../src/domains/wagering/reference-worker.js';
import { type ReferenceWorkerSettings } from '../../src/core/config/reference-worker.settings.js';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domains/wagering/entities/wager-transaction.entity.js';
import { WagerTransactionRecord } from '../../src/domains/wagering/records/wager-transaction.record.js';
import { WalletRecord } from '../../src/domains/wallet/records/wallet.record.js';
import { WalletLedgerEntryRecord } from '../../src/domains/wallet/records/wallet-ledger-entry.record.js';
import { OutboxMessageRecord } from '../../src/domains/outbox/records/outbox-message.record.js';

interface SeedWalletResult {
  readonly walletId: string;
  readonly playerId: string;
  readonly currency: string;
}

const environment = z
  .object({
    ADMIN_DATABASE_URL: z
      .url()
      .default('postgresql://postgres:postgres_local@127.0.0.1:55432/postgres'),
  })
  .parse(process.env);

const databaseName = 'jungle_rw_' + randomUUID().replaceAll('-', '');
let admin: MikroORM | undefined;
let application: MikroORM | undefined;
let databaseCreated = false;

function adminDb(): MikroORM {
  assert.ok(admin, 'Admin database is not initialized');
  return admin;
}

function appDb(): MikroORM {
  assert.ok(application, 'Application database is not initialized');
  return application;
}

function databaseUrl(user: string, password: string): string {
  const url = new URL(environment.ADMIN_DATABASE_URL);
  url.username = user;
  url.password = password;
  url.pathname = '/' + databaseName;
  return url.toString();
}

function createTestRunner(orm: MikroORM = appDb()): DatabaseTransactionRunner {
  return new DatabaseTransactionRunner(orm, {
    DB_TRANSACTION_MAX_ATTEMPTS: 3,
    DB_RETRY_BASE_DELAY_MS: 20,
    DB_RETRY_MAX_DELAY_MS: 100,
    OPERATION_TIMEOUT_MS: 5000,
  });
}

function createWorker(
  runner: DatabaseTransactionRunner,
  financial: FinancialUseCase,
  overrides: Partial<ReferenceWorkerSettings> = {},
): ReferenceWorker {
  const settings: ReferenceWorkerSettings = {
    REFERENCE_WORKER_ENABLED: true,
    REFERENCE_TTL_MS: 86400000,
    REFERENCE_POLL_MS: 50,
    REFERENCE_LEASE_MS: 30000,
    REFERENCE_RETRY_BASE_MS: 50,
    REFERENCE_RETRY_MAX_MS: 500,
    ...overrides,
  };
  return new ReferenceWorker(runner, financial, settings);
}

async function createTestWallet(
  walletUseCase: WalletUseCase,
  balance = '100.00',
  currency = 'BRL',
): Promise<SeedWalletResult> {
  const playerId = randomUUID();
  const wallet = await walletUseCase.createWallet({
    playerId,
    initialBalance: { amount: balance, currency },
  });
  return { walletId: wallet.id, playerId, currency };
}

function withIdempotencyKey<T extends object>(
  payload: T,
  key: string,
): T & { idempotencyKey: string } {
  Object.defineProperty(payload, 'idempotencyKey', {
    value: key,
    enumerable: false,
    configurable: true,
  });
  return payload as T & { idempotencyKey: string };
}

function makeBetPayload(
  wallet: SeedWalletResult,
  externalTransactionId: string,
  amount: string,
  options: { roundId?: string; gameId?: string } = {},
) {
  return withIdempotencyKey(
    {
      providerId: 'provider-ref-test',
      externalTransactionId,
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      roundId: options.roundId ?? 'round-ref-1',
      gameId: options.gameId ?? 'game-ref-1',
      kind: WagerTransactionKind.Bet,
      money: { amount, currency: wallet.currency },
    },
    'key-' + externalTransactionId,
  );
}

function makeRefundPayload(
  wallet: SeedWalletResult,
  externalTransactionId: string,
  referenceExternalTransactionId: string,
  amount: string,
  options: { roundId?: string; gameId?: string } = {},
) {
  return withIdempotencyKey(
    {
      providerId: 'provider-ref-test',
      externalTransactionId,
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      roundId: options.roundId ?? 'round-ref-1',
      gameId: options.gameId ?? 'game-ref-1',
      kind: WagerTransactionKind.Refund,
      money: { amount, currency: wallet.currency },
      referenceExternalTransactionId,
    },
    'key-' + externalTransactionId,
  );
}

function makeWinPayload(
  wallet: SeedWalletResult,
  externalTransactionId: string,
  referenceExternalTransactionId: string,
  amount: string,
  options: { roundId?: string; gameId?: string } = {},
) {
  return withIdempotencyKey(
    {
      providerId: 'provider-ref-test',
      externalTransactionId,
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      roundId: options.roundId ?? 'round-ref-1',
      gameId: options.gameId ?? 'game-ref-1',
      kind: WagerTransactionKind.Win,
      money: { amount, currency: wallet.currency },
      referenceExternalTransactionId,
    },
    'key-' + externalTransactionId,
  );
}

function makeLossPayload(
  wallet: SeedWalletResult,
  externalTransactionId: string,
  referenceExternalTransactionId: string,
  options: { roundId?: string; gameId?: string } = {},
) {
  return withIdempotencyKey(
    {
      providerId: 'provider-ref-test',
      externalTransactionId,
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      roundId: options.roundId ?? 'round-ref-1',
      gameId: options.gameId ?? 'game-ref-1',
      kind: WagerTransactionKind.Loss,
      money: { amount: '0.00', currency: wallet.currency },
      referenceExternalTransactionId,
    },
    'key-' + externalTransactionId,
  );
}

function makeContext(
  correlationId: string = randomUUID(),
  causationId?: string,
): FinancialContext {
  return {
    providerId: 'provider-ref-test',
    correlationId,
    ...(causationId !== undefined ? { causationId } : {}),
  };
}

function extractOutboxTransactionId(payload: unknown): string | undefined {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'data' in payload &&
    typeof payload.data === 'object' &&
    payload.data !== null &&
    'transactionId' in payload.data &&
    typeof payload.data.transactionId === 'string'
  ) {
    return payload.data.transactionId;
  }
  return undefined;
}

function extractOutboxCorrelationId(payload: unknown): string | undefined {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'correlationId' in payload &&
    typeof payload.correlationId === 'string'
  ) {
    return payload.correlationId;
  }
  return undefined;
}

beforeAll(async () => {
  admin = await MikroORM.init(
    createDatabaseOptions(environment.ADMIN_DATABASE_URL, {
      DB_STATEMENT_TIMEOUT_MS: 10000,
      OPERATION_TIMEOUT_MS: 20000,
    }),
  );
  await adminDb()
    .em.getConnection()
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
    await adminDb()
      .em.getConnection()
      .execute('drop database ' + databaseName + ' with (force)');
  }
  await admin?.close(true);
});

beforeEach(async () => {
  await appDb()
    .em.getConnection()
    .execute(
      `UPDATE wager_transactions
         SET status = 'REJECTED', closed_at = clock_timestamp(), failure_code = 'TEST_CLEANUP',
             reference_claim_token = NULL, reference_claim_expires_at = NULL,
             result = '{"cleaned":true}'::jsonb
         WHERE status = 'PENDING_REFERENCE'`,
    );
});

describe('ReferenceWorker Integration', () => {
  test('late BET resolves pending REFUND for same transaction, maintaining wallet/ledger/outbox atomicity and replay', async () => {
    const runner = createTestRunner();
    const financial = new FinancialUseCase(runner);
    const walletUseCase = new WalletUseCase(runner);
    const worker = createWorker(runner, financial);

    const wallet = await createTestWallet(walletUseCase, '100.00');
    const parentExtBetId = 'ext-bet-late-' + randomUUID();
    const childExtRefundId = 'ext-refund-late-' + randomUUID();
    const refundPayload = makeRefundPayload(
      wallet,
      childExtRefundId,
      parentExtBetId,
      '20.00',
    );
    const context = makeContext();

    // 1. Submit REFUND before parent BET exists -> enters PENDING_REFERENCE
    const pendingResult = await financial.execute(
      refundPayload,
      refundPayload.idempotencyKey,
      context,
    );
    expect(pendingResult.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pendingResult.idempotentReplay).toBe(false);

    // Verify wallet balance is unchanged, pending outbox event emitted, no refund ledger entry
    const emCheck = appDb().em.fork();
    const walletInitial = await emCheck.findOneOrFail(WalletRecord, {
      id: wallet.walletId,
    });
    expect(walletInitial.balance).toBe('100.00');

    const pendingOutbox = await emCheck.find(OutboxMessageRecord, {
      aggregateId: wallet.walletId,
      eventType: 'WagerTransactionPendingReference',
    });
    expect(pendingOutbox.length).toBe(1);

    // 2. Parent BET arrives and is processed
    const betPayload = makeBetPayload(wallet, parentExtBetId, '20.00');
    const betResult = await financial.execute(
      betPayload,
      betPayload.idempotencyKey,
      makeContext(),
    );
    expect(betResult.status).toBe(WagerTransactionStatus.Processed);

    const walletAfterBet = await appDb()
      .em.fork()
      .findOneOrFail(WalletRecord, { id: wallet.walletId });
    expect(walletAfterBet.balance).toBe('80.00');

    // 3. Worker cycle claims and resolves the pending REFUND
    const cycleRan = await worker.runOnce();
    expect(cycleRan).toBe(true);

    // 4. Verify terminal atomicity
    const emResolved = appDb().em.fork();
    const refundRecord = await emResolved.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId: childExtRefundId,
    });
    expect(refundRecord.status).toBe(WagerTransactionStatus.Processed);
    expect(refundRecord.referenceClaimToken).toBeNull();
    expect(refundRecord.referenceClaimExpiresAt).toBeNull();
    expect(refundRecord.processedAt).toBeInstanceOf(Date);
    expect(refundRecord.closedAt).toBeNull();

    const walletAfterRefund = await emResolved.findOneOrFail(WalletRecord, {
      id: wallet.walletId,
    });
    expect(walletAfterRefund.balance).toBe('100.00');

    const refundLedger = await emResolved.find(WalletLedgerEntryRecord, {
      transactionId: refundRecord.id,
    });
    expect(refundLedger.length).toBe(1);
    const ledgerEntry = refundLedger[0];
    assert.ok(ledgerEntry, 'Ledger entry must exist');
    expect(ledgerEntry.amount).toBe('20.00');

    const processedOutbox = await emResolved.find(OutboxMessageRecord, {
      aggregateId: wallet.walletId,
      eventType: 'WagerTransactionProcessed',
    });
    const refundProcessedEvent = processedOutbox.find(
      (msg) => extractOutboxTransactionId(msg.payload) === refundRecord.id,
    );
    expect(refundProcessedEvent).toBeDefined();
    expect(
      await emResolved.count(OutboxMessageRecord, {
        aggregateId: wallet.walletId,
        eventType: 'WagerTransactionPendingReference',
      }),
    ).toBe(1);

    // 5. Idempotent replay: calling execute on the refund replays terminal result without mutations
    const replayResult = await financial.execute(
      refundPayload,
      refundPayload.idempotencyKey,
      context,
    );
    expect(replayResult.status).toBe(WagerTransactionStatus.Processed);
    expect(replayResult.idempotentReplay).toBe(true);

    const walletReplay = await appDb()
      .em.fork()
      .findOneOrFail(WalletRecord, { id: wallet.walletId });
    expect(walletReplay.balance).toBe('100.00');

    const recheckLedger = await appDb().em.fork().find(WalletLedgerEntryRecord, {
      transactionId: refundRecord.id,
    });
    expect(recheckLedger.length).toBe(1);
  });

  test('optional reference WIN and LOSS resume to PROCESSED after parent BET arrives', async () => {
    const runner = createTestRunner();
    const financial = new FinancialUseCase(runner);
    const walletUseCase = new WalletUseCase(runner);
    const worker = createWorker(runner, financial);

    const wallet = await createTestWallet(walletUseCase, '50.00');

    // Case A: WIN referencing missing parent BET
    const parentBetWinId = 'ext-bet-win-' + randomUUID();
    const winExtId = 'ext-win-' + randomUUID();
    const winPayload = makeWinPayload(wallet, winExtId, parentBetWinId, '35.00');

    const winPending = await financial.execute(
      winPayload,
      winPayload.idempotencyKey,
      makeContext(),
    );
    expect(winPending.status).toBe(WagerTransactionStatus.PendingReference);

    // Parent BET arrives
    const betWinPayload = makeBetPayload(wallet, parentBetWinId, '10.00');
    await financial.execute(betWinPayload, betWinPayload.idempotencyKey, makeContext());

    // Worker resolves WIN
    const winRan = await worker.runOnce();
    expect(winRan).toBe(true);

    const emCheckWin = appDb().em.fork();
    const winRecord = await emCheckWin.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId: winExtId,
    });
    expect(winRecord.status).toBe(WagerTransactionStatus.Processed);

    const walletAfterWin = await emCheckWin.findOneOrFail(WalletRecord, {
      id: wallet.walletId,
    });
    // 50 - 10 + 35 = 75.00
    expect(walletAfterWin.balance).toBe('75.00');

    // Case B: LOSS referencing missing parent BET
    const parentBetLossId = 'ext-bet-loss-' + randomUUID();
    const lossExtId = 'ext-loss-' + randomUUID();
    const lossPayload = makeLossPayload(wallet, lossExtId, parentBetLossId);

    const lossPending = await financial.execute(
      lossPayload,
      lossPayload.idempotencyKey,
      makeContext(),
    );
    expect(lossPending.status).toBe(WagerTransactionStatus.PendingReference);

    // Parent BET arrives
    const betLossPayload = makeBetPayload(wallet, parentBetLossId, '15.00');
    await financial.execute(betLossPayload, betLossPayload.idempotencyKey, makeContext());

    // Worker resolves LOSS
    const lossRan = await worker.runOnce();
    expect(lossRan).toBe(true);

    const emCheckLoss = appDb().em.fork();
    const lossRecord = await emCheckLoss.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId: lossExtId,
    });
    expect(lossRecord.status).toBe(WagerTransactionStatus.Processed);

    const walletAfterLoss = await emCheckLoss.findOneOrFail(WalletRecord, {
      id: wallet.walletId,
    });
    // 75 - 15 = 60.00 (LOSS has no balance change)
    expect(walletAfterLoss.balance).toBe('60.00');
  });

  test('nonterminal reference remains pending, reschedules persistently, and preserves deadline and result', async () => {
    const runner = createTestRunner();
    const financial = new FinancialUseCase(runner);
    const walletUseCase = new WalletUseCase(runner);
    const worker = createWorker(runner, financial, { REFERENCE_RETRY_BASE_MS: 50 });

    const wallet = await createTestWallet(walletUseCase, '50.00');
    const absentBetId = 'ext-bet-absent-' + randomUUID();
    const refundExtId = 'ext-refund-persistent-' + randomUUID();
    const refundPayload = makeRefundPayload(wallet, refundExtId, absentBetId, '10.00');

    await financial.execute(refundPayload, refundPayload.idempotencyKey, makeContext());

    const emInitial = appDb().em.fork();
    const initialRecord = await emInitial.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId: refundExtId,
    });
    expect(initialRecord.status).toBe(WagerTransactionStatus.PendingReference);
    const initialDeadline = initialRecord.referenceExpiresAt;
    const initialResult = initialRecord.result;
    assert.ok(initialDeadline, 'Deadline must exist on pending reference');

    const initialOutboxCount = await emInitial.count(OutboxMessageRecord, {
      aggregateId: wallet.walletId,
      eventType: 'WagerTransactionPendingReference',
    });
    expect(initialOutboxCount).toBe(1);

    // Worker runs while parent is STILL missing
    const cycleRan = await worker.runOnce();
    expect(cycleRan).toBe(true);

    const emUpdated = appDb().em.fork();
    const updatedRecord = await emUpdated.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId: refundExtId,
    });
    expect(updatedRecord.status).toBe(WagerTransactionStatus.PendingReference);
    expect(updatedRecord.referenceExpiresAt).toEqual(initialDeadline);
    expect(updatedRecord.result).toEqual(initialResult);
    expect(updatedRecord.referenceClaimToken).toBeNull();
    expect(updatedRecord.referenceClaimExpiresAt).toBeNull();
    expect(updatedRecord.referenceAttempts).toBeGreaterThanOrEqual(1);

    // Crucially: no duplicate PendingReference outbox event is enqueued
    const recheckOutboxCount = await emUpdated.count(OutboxMessageRecord, {
      aggregateId: wallet.walletId,
      eventType: 'WagerTransactionPendingReference',
    });
    expect(recheckOutboxCount).toBe(1);
  });

  test('failed expiry execution backs off durably while another due reference progresses', async () => {
    const runner = createTestRunner();
    const financial = new FinancialUseCase(runner, {
      REFERENCE_WORKER_ENABLED: true,
      REFERENCE_TTL_MS: 1,
      REFERENCE_POLL_MS: 50,
      REFERENCE_LEASE_MS: 30000,
      REFERENCE_RETRY_BASE_MS: 50,
      REFERENCE_RETRY_MAX_MS: 500,
    });
    const wallet = await createTestWallet(new WalletUseCase(runner), '50.00');
    const firstPayload = makeRefundPayload(wallet, randomUUID(), randomUUID(), '10.00');
    const secondPayload = makeRefundPayload(wallet, randomUUID(), randomUUID(), '10.00');
    const first = await financial.execute(
      firstPayload,
      firstPayload.idempotencyKey,
      makeContext(),
    );
    const second = await financial.execute(
      secondPayload,
      secondPayload.idempotencyKey,
      makeContext(),
    );
    await delay(10);
    let failFirst = true;
    class FailingExpiry extends FinancialUseCase {
      override async resumeReference(id: string, token: string) {
        if (id === first.transactionId && failFirst) {
          throw new Error('Expiry execution outcome unconfirmed');
        }
        return super.resumeReference(id, token);
      }
    }
    const worker = createWorker(runner, new FailingExpiry(runner), {
      REFERENCE_RETRY_BASE_MS: 60000,
      REFERENCE_RETRY_MAX_MS: 60000,
    });
    expect(await worker.runOnce()).toBe(true);
    // The oldest expired row must not monopolize subsequent claims.
    expect(await worker.runOnce()).toBe(true);
    const em = appDb().em.fork();
    const deferred = await em.findOneOrFail(WagerTransactionRecord, {
      id: first.transactionId,
    });
    const completed = await em.findOneOrFail(WagerTransactionRecord, {
      id: second.transactionId,
    });
    expect(deferred.status).toBe(WagerTransactionStatus.PendingReference);
    expect(deferred.referenceAttempts).toBe(1);
    expect(deferred.referenceNextAttemptAt?.getTime()).toBeGreaterThan(Date.now());
    expect(deferred.referenceClaimToken).toBeNull();
    expect(completed.status).toBe(WagerTransactionStatus.Rejected);
    expect(completed.failureCode).toBe(FailureCode.ReferenceExpired);
    expect(await worker.runOnce()).toBe(false);

    // A new worker observes the persisted deadline, then retries when it is due.
    const restarted = createWorker(
      createTestRunner(),
      new FailingExpiry(createTestRunner()),
    );
    expect(await restarted.runOnce()).toBe(false);
    failFirst = false;
    await em
      .getConnection()
      .execute(
        `UPDATE wager_transactions SET reference_next_attempt_at = clock_timestamp() - interval '1 second' WHERE id = ?`,
        [first.transactionId],
      );
    expect(await restarted.runOnce()).toBe(true);
    const final = await appDb()
      .em.fork()
      .findOneOrFail(WagerTransactionRecord, { id: first.transactionId });
    expect(final.status).toBe(WagerTransactionStatus.Rejected);
    expect(final.failureCode).toBe(FailureCode.ReferenceExpired);
    expect(final.referenceAttempts).toBe(2);
    expect(
      (await financial.execute(firstPayload, firstPayload.idempotencyKey, makeContext()))
        .status,
    ).toBe('REJECTED');
    const check = appDb().em.fork();
    expect(
      (await check.findOneOrFail(WalletRecord, { id: wallet.walletId })).balance,
    ).toBe('50.00');
    expect(
      await check.count(WalletLedgerEntryRecord, { walletId: wallet.walletId }),
    ).toBe(1);
    expect(
      await check.count(OutboxMessageRecord, {
        aggregateId: wallet.walletId,
        eventType: 'WagerTransactionRejected',
      }),
    ).toBe(2);
  });

  test('terminal invalid parent reference rejects with REFERENCE_INVALID_STATE and zero money effect', async () => {
    const runner = createTestRunner();
    const financial = new FinancialUseCase(runner);
    const walletUseCase = new WalletUseCase(runner);
    const worker = createWorker(runner, financial);

    const wallet = await createTestWallet(walletUseCase, '20.00');
    const parentBetId = 'ext-bet-fail-' + randomUUID();
    const refundExtId = 'ext-refund-term-inv-' + randomUUID();

    // 1. Submit REFUND -> enters PENDING_REFERENCE
    const refundPayload = makeRefundPayload(wallet, refundExtId, parentBetId, '10.00');
    await financial.execute(refundPayload, refundPayload.idempotencyKey, makeContext());

    // 2. Submit parent BET with amount exceeding wallet balance (200.00 > 20.00) -> ends in REJECTED
    const failingBetPayload = makeBetPayload(wallet, parentBetId, '200.00');
    const betResult = await financial.execute(
      failingBetPayload,
      failingBetPayload.idempotencyKey,
      makeContext(),
    );
    expect(betResult.status).toBe(WagerTransactionStatus.Rejected);

    // 3. Worker resumes REFUND and detects parent is terminal-invalid
    const cycleRan = await worker.runOnce();
    expect(cycleRan).toBe(true);

    const emCheck = appDb().em.fork();
    const refundRecord = await emCheck.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId: refundExtId,
    });
    expect(refundRecord.status).toBe(WagerTransactionStatus.Rejected);
    expect(refundRecord.failureCode).toBe(FailureCode.ReferenceInvalidState);
    expect(refundRecord.closedAt).toBeInstanceOf(Date);
    expect(refundRecord.referenceClaimToken).toBeNull();

    // Zero balance change, zero ledger entries
    const walletCheck = await emCheck.findOneOrFail(WalletRecord, {
      id: wallet.walletId,
    });
    expect(walletCheck.balance).toBe('20.00');

    const ledgerEntries = await emCheck.find(WalletLedgerEntryRecord, {
      transactionId: refundRecord.id,
    });
    expect(ledgerEntries.length).toBe(0);

    const rejectedOutbox = await emCheck.find(OutboxMessageRecord, {
      aggregateId: wallet.walletId,
      eventType: 'WagerTransactionRejected',
    });
    const foundEvent = rejectedOutbox.find(
      (msg) => extractOutboxTransactionId(msg.payload) === refundRecord.id,
    );
    expect(foundEvent).toBeDefined();
  });

  test('context mismatch with parent BET rejects reference with contextual failure code', async () => {
    const runner = createTestRunner();
    const financial = new FinancialUseCase(runner);
    const walletUseCase = new WalletUseCase(runner);
    const worker = createWorker(runner, financial);

    const wallet = await createTestWallet(walletUseCase, '50.00');
    const parentBetId = 'ext-bet-ctx-' + randomUUID();
    const refundExtId = 'ext-refund-ctx-' + randomUUID();

    // 1. REFUND created in round_alpha referencing parent BET
    const refundPayload = makeRefundPayload(wallet, refundExtId, parentBetId, '15.00', {
      roundId: 'round_alpha',
    });
    await financial.execute(refundPayload, refundPayload.idempotencyKey, makeContext());

    // 2. Parent BET processed in round_beta (mismatched round!)
    const betPayload = makeBetPayload(wallet, parentBetId, '15.00', {
      roundId: 'round_beta',
    });
    const betResult = await financial.execute(
      betPayload,
      betPayload.idempotencyKey,
      makeContext(),
    );
    expect(betResult.status).toBe(WagerTransactionStatus.Processed);

    // 3. Worker resumes REFUND and detects context mismatch
    const cycleRan = await worker.runOnce();
    expect(cycleRan).toBe(true);

    const refundRecord = await appDb().em.fork().findOneOrFail(WagerTransactionRecord, {
      externalTransactionId: refundExtId,
    });
    expect(refundRecord.status).toBe(WagerTransactionStatus.Rejected);
    expect(refundRecord.failureCode).toBe(FailureCode.ReferenceRoundMismatch);
  });

  test('partial refund rejects identically before and after reference resumption without financial effects', async () => {
    const runner = createTestRunner();
    const financial = new FinancialUseCase(runner);
    const walletUseCase = new WalletUseCase(runner);
    for (const resumed of [false, true]) {
      const wallet = await createTestWallet(walletUseCase, '100.00');
      const parentId = randomUUID();
      const bet = makeBetPayload(wallet, parentId, '20.00');
      const refund = makeRefundPayload(wallet, randomUUID(), parentId, '10.00');
      const context = makeContext();
      if (resumed) {
        const pending = await financial.execute(refund, refund.idempotencyKey, context);
        expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
      }
      await financial.execute(bet, bet.idempotencyKey, makeContext());
      if (resumed) {
        expect(await createWorker(runner, financial).runOnce()).toBe(true);
      }
      const result = await financial.execute(refund, refund.idempotencyKey, context);
      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
      expect(result.idempotentReplay).toBe(resumed);
      const em = appDb().em.fork();
      const stored = await em.findOneOrFail(WalletRecord, { id: wallet.walletId });
      expect(stored.balance).toBe('80.00');
      expect(stored.version).toBe('2');
      expect(
        await em.count(WalletLedgerEntryRecord, { transactionId: result.transactionId }),
      ).toBe(0);
      const events = await em.find(OutboxMessageRecord, { aggregateId: wallet.walletId });
      const refundEvents = events.filter(
        (event) => extractOutboxTransactionId(event.payload) === result.transactionId,
      );
      expect(refundEvents.map((event) => event.eventType).sort()).toEqual(
        resumed
          ? ['WagerTransactionPendingReference', 'WagerTransactionRejected']
          : ['WagerTransactionRejected'],
      );
      for (const event of refundEvents)
        expect(extractOutboxCorrelationId(event.payload)).toBe(context.correlationId);
      const replay = await financial.execute(refund, refund.idempotencyKey, context);
      expect(replay).toEqual({ ...result, idempotentReplay: true });
    }
  });

  test('competing reversals against the same parent BET produce exactly one winner', async () => {
    const runner = createTestRunner();
    const financial = new FinancialUseCase(runner);
    const walletUseCase = new WalletUseCase(runner);
    const worker = createWorker(runner, financial);

    const wallet = await createTestWallet(walletUseCase, '100.00');
    const parentBetId = 'ext-bet-compete-' + randomUUID();
    const refund1ExtId = 'ext-ref1-compete-' + randomUUID();
    const refund2ExtId = 'ext-ref2-compete-' + randomUUID();

    // Two competing full refunds pended before parent BET arrives
    const refund1Payload = makeRefundPayload(wallet, refund1ExtId, parentBetId, '30.00');
    const refund2Payload = makeRefundPayload(wallet, refund2ExtId, parentBetId, '30.00');
    await financial.execute(refund1Payload, refund1Payload.idempotencyKey, makeContext());
    await financial.execute(refund2Payload, refund2Payload.idempotencyKey, makeContext());

    // Parent BET arrives and debits 30.00 -> balance 70.00
    const betPayload = makeBetPayload(wallet, parentBetId, '30.00');
    await financial.execute(betPayload, betPayload.idempotencyKey, makeContext());

    // Worker cycle 1: resolves first refund
    const cycle1Ran = await worker.runOnce();
    expect(cycle1Ran).toBe(true);

    // Worker cycle 2: resolves second refund
    const cycle2Ran = await worker.runOnce();
    expect(cycle2Ran).toBe(true);

    const emCheck = appDb().em.fork();
    const rec1 = await emCheck.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId: refund1ExtId,
    });
    const rec2 = await emCheck.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId: refund2ExtId,
    });

    // One PROCESSED, one REJECTED
    const statuses = [rec1.status, rec2.status].sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);

    const rejectedRec = rec1.status === 'REJECTED' ? rec1 : rec2;
    expect(rejectedRec.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);

    // Exactly 30.00 credited back (balance 100.00, not 130.00)
    const walletFinal = await emCheck.findOneOrFail(WalletRecord, {
      id: wallet.walletId,
    });
    expect(walletFinal.balance).toBe('100.00');
  });

  test('configurable natural expiry rejects with REFERENCE_EXPIRED and no money effect', async () => {
    const runner = createTestRunner();
    // Configure very short TTL so reference expires quickly
    const financial = new FinancialUseCase(runner, {
      REFERENCE_WORKER_ENABLED: true,
      REFERENCE_TTL_MS: 100,
      REFERENCE_POLL_MS: 50,
      REFERENCE_LEASE_MS: 30000,
      REFERENCE_RETRY_BASE_MS: 50,
      REFERENCE_RETRY_MAX_MS: 500,
    });
    const walletUseCase = new WalletUseCase(runner);
    const worker = createWorker(runner, financial);

    const wallet = await createTestWallet(walletUseCase, '50.00');
    const absentBetId = 'ext-bet-expired-' + randomUUID();
    const refundExtId = 'ext-refund-expired-' + randomUUID();
    const refundPayload = makeRefundPayload(wallet, refundExtId, absentBetId, '10.00');

    await financial.execute(refundPayload, refundPayload.idempotencyKey, makeContext());

    // Wait until database clock_timestamp exceeds reference_expires_at
    await delay(150);

    const cycleRan = await worker.runOnce();
    expect(cycleRan).toBe(true);

    const emCheck = appDb().em.fork();
    const expiredRecord = await emCheck.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId: refundExtId,
    });
    expect(expiredRecord.status).toBe(WagerTransactionStatus.Rejected);
    expect(expiredRecord.failureCode).toBe(FailureCode.ReferenceExpired);
    expect(expiredRecord.closedAt).toBeInstanceOf(Date);

    const walletCheck = await emCheck.findOneOrFail(WalletRecord, {
      id: wallet.walletId,
    });
    expect(walletCheck.balance).toBe('50.00');

    // Replay on expired transaction returns terminal rejected result
    const replay = await financial.execute(
      refundPayload,
      refundPayload.idempotencyKey,
      makeContext(),
    );
    expect(replay.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.failureCode).toBe(FailureCode.ReferenceExpired);
    expect(replay.idempotentReplay).toBe(true);
  });

  test('disjoint instances recover expired claims and fence stale claim tokens', async () => {
    const runner = createTestRunner();
    const financial = new FinancialUseCase(runner);
    const walletUseCase = new WalletUseCase(runner);

    const wallet = await createTestWallet(walletUseCase, '100.00');
    const parentBetId = 'ext-bet-stale-' + randomUUID();
    const refundExtId = 'ext-refund-stale-' + randomUUID();
    const refundPayload = makeRefundPayload(wallet, refundExtId, parentBetId, '25.00');

    await financial.execute(refundPayload, refundPayload.idempotencyKey, makeContext());

    // Instance 1 claims row with short lease (100ms)
    let instance1Token: string | undefined;
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const claims = await db.wagerTransactionRepository.claimReferences({
          limit: 1,
          leaseMs: 100,
        });
        const targetClaim = claims.find((c) => c.externalTransactionId === refundExtId);
        assert.ok(targetClaim?.referenceClaimToken, 'Instance 1 claim token required');
        instance1Token = targetClaim.referenceClaimToken;
      });
    assert.ok(instance1Token, 'Instance 1 token must be set');

    // Instance 1 stalls / loses connection; wait for lease to expire
    await delay(150);

    // Instance 2 recovers and claims the row with fresh lease
    let instance2Token: string | undefined;
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const claims = await db.wagerTransactionRepository.claimReferences({
          limit: 1,
          leaseMs: 15000,
        });
        const targetClaim = claims.find((c) => c.externalTransactionId === refundExtId);
        assert.ok(targetClaim?.referenceClaimToken, 'Instance 2 claim token required');
        instance2Token = targetClaim.referenceClaimToken;
      });
    assert.ok(instance2Token, 'Instance 2 token must be set');
    expect(instance2Token).not.toBe(instance1Token);

    // Parent BET arrives
    const betPayload = makeBetPayload(wallet, parentBetId, '25.00');
    await financial.execute(betPayload, betPayload.idempotencyKey, makeContext());

    // Instance 1 wakes up late and attempts resume with STALE token -> MUST be fenced (returns undefined)
    const emCheckTx = appDb().em.fork();
    const refundRow = await emCheckTx.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId: refundExtId,
    });
    const staleResult = await financial.resumeReference(refundRow.id, instance1Token);
    expect(staleResult).toBeUndefined();

    // Verify Instance 1 had zero effect (wallet still 75.00 from BET)
    const walletAfterStale = await appDb()
      .em.fork()
      .findOneOrFail(WalletRecord, { id: wallet.walletId });
    expect(walletAfterStale.balance).toBe('75.00');

    // Instance 2 resumes with VALID token -> succeeds
    const validResult = await financial.resumeReference(refundRow.id, instance2Token);
    expect(validResult?.status).toBe(WagerTransactionStatus.Processed);

    const walletFinal = await appDb()
      .em.fork()
      .findOneOrFail(WalletRecord, { id: wallet.walletId });
    expect(walletFinal.balance).toBe('100.00');
  });

  test('late injected failure rolls back transaction atomically without orphaned records', async () => {
    const runner = createTestRunner();
    const financial = new FinancialUseCase(runner);
    const walletUseCase = new WalletUseCase(runner);

    const wallet = await createTestWallet(walletUseCase, '60.00');
    const absentBetId = 'ext-bet-rollback-' + randomUUID();
    const refundExtId = 'ext-refund-rollback-' + randomUUID();
    const refundPayload = makeRefundPayload(wallet, refundExtId, absentBetId, '20.00');

    await financial.execute(refundPayload, refundPayload.idempotencyKey, makeContext());

    // Claim reference to obtain token
    let claimToken: string | undefined;
    let targetId: string | undefined;
    await appDb()
      .em.fork()
      .transactional(async (em) => {
        const db = new TransactionRepositories(em);
        const claims = await db.wagerTransactionRepository.claimReferences({
          limit: 1,
          leaseMs: 15000,
        });
        const claim = claims.find((c) => c.externalTransactionId === refundExtId);
        assert.ok(claim?.referenceClaimToken, 'Claim token required');
        claimToken = claim.referenceClaimToken;
        targetId = claim.id;
      });
    assert.ok(claimToken, 'Claim token required');
    assert.ok(targetId, 'Target ID required');

    // In an aborted transaction, modify wallet and throw an error
    let failureCaptured: unknown;
    try {
      await appDb()
        .em.fork()
        .transactional(async (em) => {
          await em
            .getConnection()
            .execute('UPDATE wallets SET balance = balance + 100 WHERE id = ?', [
              wallet.walletId,
            ]);
          throw new Error('Simulated late failure');
        });
    } catch (error) {
      failureCaptured = error;
    }
    expect(failureCaptured).toBeDefined();

    // Verify wallet was NOT modified, row is still PENDING_REFERENCE
    const emCheck = appDb().em.fork();
    const walletCheck = await emCheck.findOneOrFail(WalletRecord, {
      id: wallet.walletId,
    });
    expect(walletCheck.balance).toBe('60.00');

    const refundCheck = await emCheck.findOneOrFail(WagerTransactionRecord, {
      id: targetId,
    });
    expect(refundCheck.status).toBe(WagerTransactionStatus.PendingReference);
  });

  test('original event provenance retained across process and ORM restart', async () => {
    const runner = createTestRunner();
    const financial = new FinancialUseCase(runner);
    const walletUseCase = new WalletUseCase(runner);

    const wallet = await createTestWallet(walletUseCase, '80.00');
    const parentBetId = 'ext-bet-prov-' + randomUUID();
    const refundExtId = 'ext-refund-prov-' + randomUUID();
    const originCorrelationId = 'corr-persisted-' + randomUUID();
    const originCausationId = 'caus-persisted-' + randomUUID();

    const refundPayload = makeRefundPayload(wallet, refundExtId, parentBetId, '15.00');
    const context = makeContext(originCorrelationId, originCausationId);

    // 1. Submit REFUND -> enters PENDING_REFERENCE with provenance
    await financial.execute(refundPayload, refundPayload.idempotencyKey, context);

    // 2. Simulate process/ORM restart: close application ORM and open fresh ORM instance
    await appDb().close(true);

    application = await MikroORM.init(
      createDatabaseOptions(databaseUrl('jungle_main', 'main_local'), {
        DB_STATEMENT_TIMEOUT_MS: 10000,
        OPERATION_TIMEOUT_MS: 20000,
      }),
    );

    // 3. Verify provenance persisted in wager_transactions table across restart
    const freshEm = appDb().em.fork();
    const storedPending = await freshEm.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId: refundExtId,
    });
    expect(storedPending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(storedPending.referenceCorrelationId).toBe(originCorrelationId);
    expect(storedPending.referenceCausationId).toBe(originCausationId);

    // 4. Resolve using fresh instances
    const freshRunner = createTestRunner();
    const freshFinancial = new FinancialUseCase(freshRunner);
    const freshWorker = createWorker(freshRunner, freshFinancial);

    // Parent BET arrives
    const betPayload = makeBetPayload(wallet, parentBetId, '15.00');
    await freshFinancial.execute(betPayload, betPayload.idempotencyKey, makeContext());

    const cycleRan = await freshWorker.runOnce();
    expect(cycleRan).toBe(true);

    // 5. Verify terminal event retains original correlation ID
    const verifyEm = appDb().em.fork();
    const terminalRecord = await verifyEm.findOneOrFail(WagerTransactionRecord, {
      externalTransactionId: refundExtId,
    });
    expect(terminalRecord.status).toBe(WagerTransactionStatus.Processed);
    expect(terminalRecord.referenceCorrelationId).toBe(originCorrelationId);

    const outboxEvents = await verifyEm.find(OutboxMessageRecord, {
      aggregateId: wallet.walletId,
      eventType: 'WagerTransactionProcessed',
    });
    const terminalOutbox = outboxEvents.find(
      (msg) => extractOutboxTransactionId(msg.payload) === terminalRecord.id,
    );
    assert.ok(terminalOutbox, 'Terminal outbox message must exist');
    const correlationId = extractOutboxCorrelationId(terminalOutbox.payload);
    expect(correlationId).toBe(originCorrelationId);
  });

  test('worker lifecycle start() and stop() runs background cycle and drains cleanly', async () => {
    const runner = createTestRunner();
    const financial = new FinancialUseCase(runner);
    const walletUseCase = new WalletUseCase(runner);
    const worker = createWorker(runner, financial, { REFERENCE_POLL_MS: 20 });

    const wallet = await createTestWallet(walletUseCase, '50.00');
    const parentBetId = 'ext-bet-life-' + randomUUID();
    const refundExtId = 'ext-refund-life-' + randomUUID();

    const refundPayload = makeRefundPayload(wallet, refundExtId, parentBetId, '10.00');
    await financial.execute(refundPayload, refundPayload.idempotencyKey, makeContext());

    const betPayload = makeBetPayload(wallet, parentBetId, '10.00');
    await financial.execute(betPayload, betPayload.idempotencyKey, makeContext());

    // Start background worker loop
    worker.start();

    // Poll until background worker picks up and resolves the pending REFUND
    let resolved = false;
    for (let i = 0; i < 40; i++) {
      await delay(50);
      const row = await appDb().em.fork().findOne(WagerTransactionRecord, {
        externalTransactionId: refundExtId,
      });
      if (row?.status === WagerTransactionStatus.Processed) {
        resolved = true;
        break;
      }
    }
    expect(resolved).toBe(true);

    // Stop worker cleanly without dangling promises
    await worker.stop();

    // Calling runOnce when no work remains returns false
    const extraCycle = await worker.runOnce();
    expect(extraCycle).toBe(false);
  });
});
