import assert from 'node:assert/strict';
import { expect, test } from '@playwright/test';
import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { createDatabaseOptions } from '../../src/core/database/database.config.js';

const LOCAL_PROVIDER_ID = 'provider-a';

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

const ledgerItemSchema = z
  .object({
    id: z.uuid(),
    walletId: z.uuid(),
    transactionId: z.uuid(),
    direction: z.enum(['DEBIT', 'CREDIT']),
    money: moneySchema,
    balanceBefore: moneySchema,
    balanceAfter: moneySchema,
    walletVersion: z.string().regex(/^\d+$/),
    createdAt: z.iso.datetime(),
  })
  .strict();

const ledgerResponseSchema = z
  .object({
    items: z.array(ledgerItemSchema),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();

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

const errorEnvelopeSchema = z
  .object({
    category: z.string(),
    code: z.string(),
    message: z.string(),
  })
  .strict();

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

interface WalletRecordRow {
  readonly id: string;
  readonly balance: string;
  readonly currency: string;
  readonly version: string;
}

interface LedgerEntryRow {
  readonly id: string;
  readonly direction: string;
  readonly amount: string;
  readonly balance_before: string;
  readonly balance_after: string;
  readonly wallet_version: string;
}

interface TransactionRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly amount: string;
  readonly failure_code: string | null;
}

test.describe('Real Financial Flows (Item 26)', () => {
  test('positive opening creates atomic balance and ledger; zero opening creates version one without financial entry (B01)', async ({
    request,
  }) => {
    // 1. Positive opening balance: 100.00 BRL
    const positivePlayerId = crypto.randomUUID();
    const positiveRes = await request.post('/wallets', {
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': 'flow-open-pos-' + crypto.randomUUID(),
      },
      data: {
        playerId: positivePlayerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      },
    });
    expect(positiveRes.status()).toBe(201);
    const positiveWallet = walletResponseSchema.parse(await positiveRes.json());
    expect(positiveWallet.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(positiveWallet.version).toBe('1');

    // Separate IA SQL assertions for positive opening
    const positiveDbWallets = await queryDatabaseRows<WalletRecordRow>(
      'SELECT id, balance, currency, version FROM wallets WHERE id = ?',
      [positiveWallet.id],
    );
    const positiveDbWallet = positiveDbWallets.at(0);
    assert.ok(positiveDbWallet, 'Positive wallet must exist in DB');
    expect(positiveDbWallet.balance).toBe('100.00');
    expect(positiveDbWallet.currency).toBe('BRL');
    expect(positiveDbWallet.version).toBe('1');

    const positiveLedger = await queryDatabaseRows<LedgerEntryRow>(
      'SELECT id, direction, amount, balance_before, balance_after, wallet_version FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY wallet_version ASC',
      [positiveWallet.id],
    );
    expect(positiveLedger.length).toBe(1);
    const firstPositiveEntry = positiveLedger.at(0);
    assert.ok(firstPositiveEntry, 'First positive ledger entry must exist');
    expect(firstPositiveEntry.direction).toBe('CREDIT');
    expect(firstPositiveEntry.amount).toBe('100.00');
    expect(firstPositiveEntry.balance_before).toBe('0.00');
    expect(firstPositiveEntry.balance_after).toBe('100.00');
    expect(firstPositiveEntry.wallet_version).toBe('1');

    const positiveTxRows = await queryDatabaseRows<TransactionRow>(
      'SELECT id, kind, status, amount, failure_code FROM wager_transactions WHERE wallet_id = ?',
      [positiveWallet.id],
    );
    expect(positiveTxRows.length).toBe(1);
    const firstPositiveTx = positiveTxRows.at(0);
    assert.ok(firstPositiveTx, 'First positive transaction must exist');
    expect(firstPositiveTx.kind).toBe('OPENING');
    expect(firstPositiveTx.status).toBe('PROCESSED');
    expect(firstPositiveTx.amount).toBe('100.00');

    // 2. Zero opening balance: 0.00 USD
    const zeroPlayerId = crypto.randomUUID();
    const zeroRes = await request.post('/wallets', {
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': 'flow-open-zero-' + crypto.randomUUID(),
      },
      data: {
        playerId: zeroPlayerId,
        initialBalance: { amount: '0.00', currency: 'USD' },
      },
    });
    expect(zeroRes.status()).toBe(201);
    const zeroWallet = walletResponseSchema.parse(await zeroRes.json());
    expect(zeroWallet.balance).toEqual({ amount: '0.00', currency: 'USD' });
    expect(zeroWallet.version).toBe('1');

    // Separate IA SQL assertions for zero opening: version 1, but NO ledger entry or opening transaction
    const zeroDbWallets = await queryDatabaseRows<WalletRecordRow>(
      'SELECT id, balance, currency, version FROM wallets WHERE id = ?',
      [zeroWallet.id],
    );
    const zeroDbWallet = zeroDbWallets.at(0);
    assert.ok(zeroDbWallet, 'Zero wallet must exist in DB');
    expect(zeroDbWallet.balance).toBe('0.00');
    expect(zeroDbWallet.version).toBe('1');

    const zeroLedger = await queryDatabaseRows<LedgerEntryRow>(
      'SELECT id, direction, amount, balance_before, balance_after, wallet_version FROM wallet_ledger_entries WHERE wallet_id = ?',
      [zeroWallet.id],
    );
    expect(zeroLedger.length).toBe(0);

    const zeroTxRows = await queryDatabaseRows<TransactionRow>(
      'SELECT id, kind, status, amount, failure_code FROM wager_transactions WHERE wallet_id = ?',
      [zeroWallet.id],
    );
    expect(zeroTxRows.length).toBe(0);

    // 3. External OPENING submission rejection
    const externalOpenRes = await request.post('/wagering/transactions', {
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'key-open-' + crypto.randomUUID(),
      },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: 'ext-open-' + crypto.randomUUID(),
        playerId: zeroPlayerId,
        walletId: zeroWallet.id,
        kind: 'OPENING',
        money: { amount: '50.00', currency: 'USD' },
      },
    });
    expect(externalOpenRes.status()).toBe(400);
    const errorBody = errorEnvelopeSchema.parse(await externalOpenRes.json());
    expect(errorBody.category).toBe('ValidationError');
  });

  test('executes real lifecycle BET -> WIN -> LOSS -> ROLLBACK with exact balance and ledger transitions (B05, B08)', async ({
    request,
  }) => {
    // 1. Initial wallet: 100.00 EUR
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'EUR' },
      },
    });
    expect(createRes.status()).toBe(201);
    const wallet = walletResponseSchema.parse(await createRes.json());
    const roundId = 'round-' + crypto.randomUUID();

    // 2. BET 25.00 EUR
    const betExtId = 'ext-bet-' + crypto.randomUUID();
    const betRes = await request.post('/wagering/transactions', {
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idemp-bet-' + crypto.randomUUID(),
      },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-roulette',
        kind: 'BET',
        money: { amount: '25.00', currency: 'EUR' },
      },
    });
    expect(betRes.status()).toBe(200);
    const betResult = financialResultSchema.parse(await betRes.json());
    expect(betResult.status).toBe('PROCESSED');
    expect(betResult.balance).toEqual({ amount: '75.00', currency: 'EUR' });
    expect(betResult.walletVersion).toBe('2');
    expect(betResult.idempotentReplay).toBe(false);

    // 3. WIN 10.00 EUR referencing the BET
    const winExtId = 'ext-win-' + crypto.randomUUID();
    const winRes = await request.post('/wagering/transactions', {
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idemp-win-' + crypto.randomUUID(),
      },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: winExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-roulette',
        kind: 'WIN',
        money: { amount: '10.00', currency: 'EUR' },
        referenceExternalTransactionId: betExtId,
      },
    });
    expect(winRes.status()).toBe(200);
    const winResult = financialResultSchema.parse(await winRes.json());
    expect(winResult.status).toBe('PROCESSED');
    expect(winResult.balance).toEqual({ amount: '85.00', currency: 'EUR' });
    expect(winResult.walletVersion).toBe('3');
    expect(winResult.idempotentReplay).toBe(false);

    // 4. LOSS 0.00 EUR in the same round (does not change balance or version)
    const lossExtId = 'ext-loss-' + crypto.randomUUID();
    const lossRes = await request.post('/wagering/transactions', {
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idemp-loss-' + crypto.randomUUID(),
      },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: lossExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-roulette',
        kind: 'LOSS',
        money: { amount: '0.00', currency: 'EUR' },
      },
    });
    expect(lossRes.status()).toBe(200);
    const lossResult = financialResultSchema.parse(await lossRes.json());
    expect(lossResult.status).toBe('PROCESSED');
    expect(lossResult.balance).toEqual({ amount: '85.00', currency: 'EUR' });
    expect(lossResult.walletVersion).toBe('3');

    // 5. ROLLBACK 10.00 EUR referencing WIN (inverts WIN credit back to 75.00)
    const rollbackExtId = 'ext-roll-' + crypto.randomUUID();
    const rollbackRes = await request.post('/wagering/transactions', {
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idemp-roll-' + crypto.randomUUID(),
      },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: rollbackExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId,
        gameId: 'game-roulette',
        kind: 'ROLLBACK',
        money: { amount: '10.00', currency: 'EUR' },
        referenceExternalTransactionId: winExtId,
      },
    });
    expect(rollbackRes.status()).toBe(200);
    const rollbackResult = financialResultSchema.parse(await rollbackRes.json());
    expect(rollbackResult.status).toBe('PROCESSED');
    expect(rollbackResult.balance).toEqual({ amount: '75.00', currency: 'EUR' });
    expect(rollbackResult.walletVersion).toBe('4');
    expect(rollbackResult.idempotentReplay).toBe(false);

    // Separate IA SQL assertions: inspect ledger history and balance consistency
    const finalDbWallets = await queryDatabaseRows<WalletRecordRow>(
      'SELECT id, balance, currency, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    const finalDbWallet = finalDbWallets.at(0);
    assert.ok(finalDbWallet, 'Final wallet must exist in DB');
    expect(finalDbWallet.balance).toBe('75.00');
    expect(finalDbWallet.version).toBe('4');

    const ledgerEntries = await queryDatabaseRows<LedgerEntryRow>(
      'SELECT id, direction, amount, balance_before, balance_after, wallet_version FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY wallet_version ASC',
      [wallet.id],
    );
    // 4 ledger entries: OPENING (+100), BET (-25), WIN (+10), ROLLBACK (-10). LOSS creates no entry.
    expect(ledgerEntries.length).toBe(4);
    const e0 = ledgerEntries.at(0);
    const e1 = ledgerEntries.at(1);
    const e2 = ledgerEntries.at(2);
    const e3 = ledgerEntries.at(3);
    assert.ok(e0 && e1 && e2 && e3, 'All 4 ledger entries must exist');
    expect(e0).toMatchObject({
      direction: 'CREDIT',
      amount: '100.00',
      balance_before: '0.00',
      balance_after: '100.00',
    });
    expect(e1).toMatchObject({
      direction: 'DEBIT',
      amount: '25.00',
      balance_before: '100.00',
      balance_after: '75.00',
    });
    expect(e2).toMatchObject({
      direction: 'CREDIT',
      amount: '10.00',
      balance_before: '75.00',
      balance_after: '85.00',
    });
    expect(e3).toMatchObject({
      direction: 'DEBIT',
      amount: '10.00',
      balance_before: '85.00',
      balance_after: '75.00',
    });
  });

  test('stored historical replay preserves snapshot at execution time; payload mismatch returns 409 conflict (C03, C07)', async ({
    request,
  }) => {
    // 1. Initial wallet: 100.00 BRL
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      },
    });
    expect(createRes.status()).toBe(201);
    const wallet = walletResponseSchema.parse(await createRes.json());

    const key1 = 'idemp-replay-' + crypto.randomUUID();
    const extBet1 = 'ext-replay-1-' + crypto.randomUUID();
    const payload1 = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId: extBet1,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-replay-1',
      gameId: 'game-replay',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    // 2. Submit BET 1 (25.00 BRL) -> balance becomes 75.00, version 2
    const res1 = await request.post('/wagering/transactions', {
      headers: { 'content-type': 'application/json', 'idempotency-key': key1 },
      data: payload1,
    });
    expect(res1.status()).toBe(200);
    const result1 = financialResultSchema.parse(await res1.json());
    expect(result1.status).toBe('PROCESSED');
    expect(result1.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(result1.walletVersion).toBe('2');
    expect(result1.idempotentReplay).toBe(false);

    // 3. Submit unrelated BET 2 (10.00 BRL) -> advances wallet balance to 65.00, version 3
    const key2 = 'idemp-replay-2-' + crypto.randomUUID();
    const res2 = await request.post('/wagering/transactions', {
      headers: { 'content-type': 'application/json', 'idempotency-key': key2 },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: 'ext-replay-2-' + crypto.randomUUID(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-replay-2',
        gameId: 'game-replay',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    });
    expect(res2.status()).toBe(200);
    const result2 = financialResultSchema.parse(await res2.json());
    expect(result2.balance).toEqual({ amount: '65.00', currency: 'BRL' });
    expect(result2.walletVersion).toBe('3');

    // 4. Replay BET 1 with original key1 and exact payload: must return HISTORICAL 75.00 balance
    const replayRes = await request.post('/wagering/transactions', {
      headers: { 'content-type': 'application/json', 'idempotency-key': key1 },
      data: payload1,
    });
    expect(replayRes.status()).toBe(200);
    const replayResult = financialResultSchema.parse(await replayRes.json());
    expect(replayResult.idempotentReplay).toBe(true);
    expect(replayResult.transactionId).toBe(result1.transactionId);
    expect(replayResult.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(replayResult.walletVersion).toBe('2');

    // 5. A changed amount conflicts with the accepted key and returns HTTP 409.
    const conflictRes = await request.post('/wagering/transactions', {
      headers: { 'content-type': 'application/json', 'idempotency-key': key1 },
      data: { ...payload1, money: { amount: '50.00', currency: 'BRL' } },
    });
    expect(conflictRes.status()).toBe(409);
    const conflictError = errorEnvelopeSchema.parse(await conflictRes.json());
    expect(conflictError.category).toBe('ConflictError');
    expect(conflictError.code).toBe('WAGER_IDEMPOTENCY_CONFLICT');

    // IA check: verify wallet remains at 65.00, version 3, and no phantom ledger entry exists
    const dbWallets = await queryDatabaseRows<WalletRecordRow>(
      'SELECT id, balance, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    const dbWallet = dbWallets.at(0);
    assert.ok(dbWallet, 'Wallet record must exist in DB');
    expect(dbWallet.balance).toBe('65.00');
    expect(dbWallet.version).toBe('3');

    const ledgerCountRows = await queryDatabaseRows<{ count: string }>(
      'SELECT count(*) as count FROM wallet_ledger_entries WHERE wallet_id = ?',
      [wallet.id],
    );
    const countRow = ledgerCountRows.at(0);
    assert.ok(countRow, 'Ledger count must be returned');
    expect(countRow.count).toBe('3'); // 1 opening + 2 bets
  });

  test('insufficient balance rejects BET with 422 REJECTED, without debiting wallet or writing ledger (B06)', async ({
    request,
  }) => {
    // 1. Initial wallet: 10.00 USD
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.00', currency: 'USD' },
      },
    });
    expect(createRes.status()).toBe(201);
    const wallet = walletResponseSchema.parse(await createRes.json());

    const rejKey = 'idemp-rej-' + crypto.randomUUID();
    const rejExtId = 'ext-rej-' + crypto.randomUUID();
    const rejPayload = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId: rejExtId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-rej',
      gameId: 'game-rej',
      kind: 'BET',
      money: { amount: '50.00', currency: 'USD' },
    };

    // 2. Submit BET exceeding available balance (50.00 > 10.00)
    const rejRes = await request.post('/wagering/transactions', {
      headers: { 'content-type': 'application/json', 'idempotency-key': rejKey },
      data: rejPayload,
    });
    expect(rejRes.status()).toBe(422);
    const rejResult = financialResultSchema.parse(await rejRes.json());
    expect(rejResult.status).toBe('REJECTED');
    expect(rejResult.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejResult.balance).toEqual({ amount: '10.00', currency: 'USD' });
    expect(rejResult.idempotentReplay).toBe(false);

    // Separate IA assertions: wallet still 10.00, version 1, only opening ledger entry
    const rejDbWallets = await queryDatabaseRows<WalletRecordRow>(
      'SELECT balance, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    const rejDbWallet = rejDbWallets.at(0);
    assert.ok(rejDbWallet, 'Wallet must exist in DB');
    expect(rejDbWallet.balance).toBe('10.00');
    expect(rejDbWallet.version).toBe('1');

    const ledgerRows = await queryDatabaseRows<LedgerEntryRow>(
      'SELECT id, direction, amount FROM wallet_ledger_entries WHERE wallet_id = ?',
      [wallet.id],
    );
    expect(ledgerRows.length).toBe(1);
    const openingEntry = ledgerRows.at(0);
    assert.ok(openingEntry, 'Opening ledger entry must exist');
    expect(openingEntry.direction).toBe('CREDIT'); // Opening only
    // 3. Replay with the same key returns identical REJECTED response
    const replayRejRes = await request.post('/wagering/transactions', {
      headers: { 'content-type': 'application/json', 'idempotency-key': rejKey },
      data: rejPayload,
    });
    expect(replayRejRes.status()).toBe(422);
    const replayRejResult = financialResultSchema.parse(await replayRejRes.json());
    expect(replayRejResult.status).toBe('REJECTED');
    expect(replayRejResult.idempotentReplay).toBe(true);
    expect(replayRejResult.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('processes REFUND of BET and rejects duplicate reversal attempts (B07, B12)', async ({
    request,
  }) => {
    // 1. Initial wallet: 100.00 BRL
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      },
    });
    expect(createRes.status()).toBe(201);
    const wallet = walletResponseSchema.parse(await createRes.json());

    // 2. BET 30.00 BRL -> balance becomes 70.00
    const betExtId = 'ext-bet-ref-' + crypto.randomUUID();
    const betRes = await request.post('/wagering/transactions', {
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idemp-bet-ref-' + crypto.randomUUID(),
      },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-ref',
        gameId: 'game-ref',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      },
    });
    expect(betRes.status()).toBe(200);
    const betResult = financialResultSchema.parse(await betRes.json());
    expect(betResult.balance).toEqual({ amount: '70.00', currency: 'BRL' });

    // 3. First REFUND 30.00 BRL -> succeeds, balance restored to 100.00
    const refundExtId1 = 'ext-refund-1-' + crypto.randomUUID();
    const refundRes1 = await request.post('/wagering/transactions', {
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idemp-refund-1-' + crypto.randomUUID(),
      },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: refundExtId1,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-ref',
        gameId: 'game-ref',
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      },
    });
    expect(refundRes1.status()).toBe(200);
    const refundResult1 = financialResultSchema.parse(await refundRes1.json());
    expect(refundResult1.status).toBe('PROCESSED');
    expect(refundResult1.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    // 4. Second REFUND with different transaction identity for the SAME BET: must be rejected
    const refundExtId2 = 'ext-refund-2-' + crypto.randomUUID();
    const refundRes2 = await request.post('/wagering/transactions', {
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idemp-refund-2-' + crypto.randomUUID(),
      },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: refundExtId2,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-ref',
        gameId: 'game-ref',
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      },
    });
    expect(refundRes2.status()).toBe(422);
    const refundResult2 = financialResultSchema.parse(await refundRes2.json());
    expect(refundResult2.status).toBe('REJECTED');
    expect(refundResult2.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(refundResult2.balance).toEqual({ amount: '100.00', currency: 'BRL' });

    // IA check: exactly 1 refund in ledger (OPENING + BET + REFUND_1 = 3 entries)
    const ledgerRows = await queryDatabaseRows<LedgerEntryRow>(
      'SELECT id, direction, amount FROM wallet_ledger_entries WHERE wallet_id = ?',
      [wallet.id],
    );
    expect(ledgerRows.length).toBe(3);
  });
  test('out-of-order reference creation enters PENDING_REFERENCE (202 Accepted) without balance change, and replays idempotently (B11, R01)', async ({
    request,
  }) => {
    // 1. Initial wallet: 100.00 EUR
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'EUR' },
      },
    });
    expect(createRes.status()).toBe(201);
    const wallet = walletResponseSchema.parse(await createRes.json());

    const idempotencyKey = 'key-pending-ref-' + crypto.randomUUID();
    const externalTransactionId = 'ext-pending-ref-' + crypto.randomUUID();
    const missingRefId = 'ext-unseen-bet-' + crypto.randomUUID();

    const refundPayload = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-pending-1',
      gameId: 'game-pending',
      kind: 'REFUND',
      money: { amount: '20.00', currency: 'EUR' },
      referenceExternalTransactionId: missingRefId,
    };

    // 2. Initial submission returns 202 Accepted with PENDING_REFERENCE
    const res1 = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': idempotencyKey,
        'content-type': 'application/json',
      },
      data: refundPayload,
    });
    expect(res1.status()).toBe(202);
    const body1 = financialResultSchema.parse(await res1.json());
    expect(body1.status).toBe('PENDING_REFERENCE');
    expect(body1.idempotentReplay).toBe(false);
    expect(body1.balance).toEqual({ amount: '100.00', currency: 'EUR' });
    expect(body1.walletVersion).toBe('1');

    // 3. Replay returns 202 Accepted with idempotentReplay: true
    const res2 = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': idempotencyKey,
        'content-type': 'application/json',
      },
      data: refundPayload,
    });
    expect(res2.status()).toBe(202);
    const body2 = financialResultSchema.parse(await res2.json());
    expect(body2.status).toBe('PENDING_REFERENCE');
    expect(body2.idempotentReplay).toBe(true);
    expect(body2.balance).toEqual({ amount: '100.00', currency: 'EUR' });
    expect(body2.walletVersion).toBe('1');

    // Separate IA check: wager_transactions has 1 row with status PENDING_REFERENCE, ledger has only opening entry
    const txRows = await queryDatabaseRows<TransactionRow>(
      'SELECT id, kind, status, amount, failure_code FROM wager_transactions WHERE id = ?',
      [body1.transactionId],
    );
    expect(txRows.length).toBe(1);
    const pendingTx = txRows.at(0);
    assert.ok(pendingTx, 'Pending transaction must exist in DB');
    expect(pendingTx.status).toBe('PENDING_REFERENCE');
    expect(pendingTx.amount).toBe('20.00');
    const ledgerRows = await queryDatabaseRows<LedgerEntryRow>(
      'SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?',
      [wallet.id],
    );
    expect(ledgerRows.length).toBe(1); // Opening only
  });

  test('keyset pagination deterministically traverses all ledger entries and rejects invalid cursors (B14)', async ({
    request,
  }) => {
    // 1. Initial wallet: 500.00 USD
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '500.00', currency: 'USD' },
      },
    });
    expect(createRes.status()).toBe(201);
    const wallet = walletResponseSchema.parse(await createRes.json());

    // 2. Perform 5 sequential transactions to create 6 total ledger entries (1 opening + 5 bets)
    for (let i = 1; i <= 5; i++) {
      const betRes = await request.post('/wagering/transactions', {
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `idemp-page-${String(i)}-` + crypto.randomUUID(),
        },
        data: {
          providerId: LOCAL_PROVIDER_ID,
          externalTransactionId: `ext-page-${String(i)}-` + crypto.randomUUID(),
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: `round-page-${String(i)}`,
          gameId: 'game-page',
          kind: 'BET',
          money: { amount: '10.00', currency: 'USD' },
        },
      });
      expect(betRes.status()).toBe(200);
    }

    // 3. Page through ledger with limit = 2
    const collectedIds: string[] = [];
    let cursor: string | null = null;
    let pageCount = 0;

    do {
      pageCount++;
      const url = cursor
        ? `/wallets/${wallet.id}/ledger?limit=2&cursor=${encodeURIComponent(cursor)}`
        : `/wallets/${wallet.id}/ledger?limit=2`;
      const pageRes = await request.get(url);
      expect(pageRes.status()).toBe(200);
      const page = ledgerResponseSchema.parse(await pageRes.json());
      for (const item of page.items) {
        collectedIds.push(item.id);
      }
      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    } while (cursor !== null && pageCount < 10);

    // Total items: 1 OPENING + 5 BETs = 6 entries
    expect(collectedIds.length).toBe(6);
    const uniqueIds = new Set(collectedIds);
    expect(uniqueIds.size).toBe(6); // No duplicates, no omissions

    // 4. Reject invalid or tampered cursor
    const invalidCursorRes = await request.get(
      `/wallets/${wallet.id}/ledger?limit=2&cursor=invalid_tampered_cursor_data`,
    );
    expect(invalidCursorRes.status()).toBe(400);
    const err = errorEnvelopeSchema.parse(await invalidCursorRes.json());
    expect(err.category).toBe('ValidationError');
  });

  test('wallet reconciliation computes exact match between stored and calculated balances (B15)', async ({
    request,
  }) => {
    // 1. Initial wallet: 100.00 EUR
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'EUR' },
      },
    });
    expect(createRes.status()).toBe(201);
    const wallet = walletResponseSchema.parse(await createRes.json());

    // 2. Perform BET 20.00 EUR -> 80.00 EUR
    const betExtId = 'ext-rec-bet-' + crypto.randomUUID();
    await request.post('/wagering/transactions', {
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idemp-rec-bet-' + crypto.randomUUID(),
      },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: betExtId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-rec-1',
        gameId: 'game-rec',
        kind: 'BET',
        money: { amount: '20.00', currency: 'EUR' },
      },
    });

    // 3. Perform WIN 15.00 EUR -> 95.00 EUR
    await request.post('/wagering/transactions', {
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idemp-rec-win-' + crypto.randomUUID(),
      },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: 'ext-rec-win-' + crypto.randomUUID(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-rec-1',
        gameId: 'game-rec',
        kind: 'WIN',
        money: { amount: '15.00', currency: 'EUR' },
      },
    });

    // 4. POST /wallets/:id/reconciliation
    const reconcileRes = await request.post(`/wallets/${wallet.id}/reconciliation`, {
      headers: { 'x-correlation-id': 'corr-rec-' + crypto.randomUUID() },
    });
    expect(reconcileRes.status()).toBe(200);
    const reconcile = reconciliationResponseSchema.parse(await reconcileRes.json());

    expect(reconcile.walletId).toBe(wallet.id);
    expect(reconcile.consistent).toBe(true);
    expect(reconcile.storedBalance).toEqual({ amount: '95.00', currency: 'EUR' });
    expect(reconcile.calculatedBalance).toEqual({ amount: '95.00', currency: 'EUR' });
    expect(reconcile.difference).toEqual({ amount: '0.00', currency: 'EUR' });
    expect(reconcile.checkedEntries).toBe(3); // 1 opening + 1 bet + 1 win

    // IA SQL check: verify calculated balance matches raw SQL sum
    const calcRows = await queryDatabaseRows<{ sum: string }>(
      `SELECT COALESCE(SUM(
         CASE direction WHEN 'CREDIT' THEN amount::numeric ELSE -amount::numeric END
       ), 0)::text as sum FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [wallet.id],
    );
    const calcRow = calcRows.at(0);
    assert.ok(calcRow, 'Calculated sum must exist');
    expect(calcRow.sum).toBe('95.00');
  });
});
