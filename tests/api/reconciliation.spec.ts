import { expect, test, type APIRequestContext } from '@playwright/test';
import { z } from 'zod';

const LOCAL_PROVIDER_ID = 'provider-a';

const moneySchema = z
  .object({
    amount: z.string().regex(/^-?\d+\.\d{2}$/),
    currency: z.enum(['BRL', 'USD', 'EUR']),
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

const walletResponseSchema = z
  .object({
    id: z.uuid(),
    playerId: z.uuid(),
    balance: moneySchema,
    version: z.string().regex(/^\d+$/),
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

const errorEnvelopeSchema = z
  .object({
    category: z.string(),
    code: z.string(),
    message: z.string(),
  })
  .strict();

interface CreatedWallet {
  readonly id: string;
  readonly playerId: string;
}

async function createWalletFixture(
  request: APIRequestContext,
  amount: string,
  currency: 'BRL' | 'USD' | 'EUR',
): Promise<CreatedWallet> {
  const playerId = crypto.randomUUID();
  const response = await request.post('/wallets', {
    headers: { 'content-type': 'application/json' },
    data: {
      playerId,
      initialBalance: { amount, currency },
    },
  });
  expect(response.status()).toBe(201);
  const parsed = walletResponseSchema.parse(await response.json());
  return { id: parsed.id, playerId: parsed.playerId };
}

test.describe('POST /wallets/:walletId/reconciliation API', () => {
  test('reconciles empty ledger wallet with zero balance (200 OK)', async ({
    request,
  }) => {
    const wallet = await createWalletFixture(request, '0.00', 'USD');

    const response = await request.post(`/wallets/${wallet.id}/reconciliation`, {
      headers: { 'x-correlation-id': 'reconcile-zero-' + crypto.randomUUID() },
    });

    expect(response.status()).toBe(200);
    const parsed = reconciliationResponseSchema.parse(await response.json());

    expect(parsed.walletId).toBe(wallet.id);
    expect(parsed.storedBalance).toEqual({ amount: '0.00', currency: 'USD' });
    expect(parsed.calculatedBalance).toEqual({ amount: '0.00', currency: 'USD' });
    expect(parsed.difference).toEqual({ amount: '0.00', currency: 'USD' });
    expect(parsed.consistent).toBe(true);
    expect(parsed.checkedEntries).toBe(0);
  });

  test('reconciles positive opening wallet (200 OK)', async ({ request }) => {
    const wallet = await createWalletFixture(request, '150.00', 'BRL');

    const response = await request.post(`/wallets/${wallet.id}/reconciliation`, {
      headers: { 'x-correlation-id': 'reconcile-opening-' + crypto.randomUUID() },
    });

    expect(response.status()).toBe(200);
    const parsed = reconciliationResponseSchema.parse(await response.json());

    expect(parsed.walletId).toBe(wallet.id);
    expect(parsed.storedBalance).toEqual({ amount: '150.00', currency: 'BRL' });
    expect(parsed.calculatedBalance).toEqual({ amount: '150.00', currency: 'BRL' });
    expect(parsed.difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(parsed.consistent).toBe(true);
    expect(parsed.checkedEntries).toBe(1);
  });

  test('tracks BET, WIN, LOSS, rejection, pending flows, and replay with no extra entries', async ({
    request,
  }) => {
    const wallet = await createWalletFixture(request, '100.00', 'EUR');

    // 1. Initial snapshot has 1 entry (OPENING credit)
    const initialRec = await request.post(`/wallets/${wallet.id}/reconciliation`);
    expect(initialRec.status()).toBe(200);
    const initialData = reconciliationResponseSchema.parse(await initialRec.json());
    expect(initialData.checkedEntries).toBe(1);
    expect(initialData.storedBalance.amount).toBe('100.00');

    // 2. BET of 30.00 EUR -> Debit creates entry #2, balance becomes 70.00 EUR
    const betIdempotencyKey = 'key_bet_' + crypto.randomUUID();
    const betPayload = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId: 'ext_bet_' + crypto.randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round_01',
      gameId: 'game_01',
      kind: 'BET',
      money: { amount: '30.00', currency: 'EUR' },
    };

    const betRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': betIdempotencyKey,
        'content-type': 'application/json',
      },
      data: betPayload,
    });
    expect(betRes.status()).toBe(200);
    const betResult = financialResultSchema.parse(await betRes.json());
    expect(betResult.status).toBe('PROCESSED');
    expect(betResult.balance).toEqual({ amount: '70.00', currency: 'EUR' });

    const postBetRec = await request.post(`/wallets/${wallet.id}/reconciliation`);
    expect(postBetRec.status()).toBe(200);
    const postBetData = reconciliationResponseSchema.parse(await postBetRec.json());
    expect(postBetData.checkedEntries).toBe(2);
    expect(postBetData.storedBalance.amount).toBe('70.00');
    expect(postBetData.calculatedBalance.amount).toBe('70.00');
    expect(postBetData.difference.amount).toBe('0.00');
    expect(postBetData.consistent).toBe(true);

    // 3. Idempotent replay of BET creates NO extra ledger entry
    const betReplayRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': betIdempotencyKey,
        'content-type': 'application/json',
      },
      data: betPayload,
    });
    expect(betReplayRes.status()).toBe(200);
    const betReplayResult = financialResultSchema.parse(await betReplayRes.json());
    expect(betReplayResult.idempotentReplay).toBe(true);

    const postReplayRec = await request.post(`/wallets/${wallet.id}/reconciliation`);
    expect(postReplayRec.status()).toBe(200);
    const postReplayData = reconciliationResponseSchema.parse(await postReplayRec.json());
    expect(postReplayData.checkedEntries).toBe(2);
    expect(postReplayData.storedBalance.amount).toBe('70.00');
    expect(postReplayData.consistent).toBe(true);

    // 4. WIN of 50.00 EUR -> Credit creates entry #3, balance becomes 120.00 EUR
    const winIdempotencyKey = 'key_win_' + crypto.randomUUID();
    const winPayload = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId: 'ext_win_' + crypto.randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round_01',
      gameId: 'game_01',
      kind: 'WIN',
      money: { amount: '50.00', currency: 'EUR' },
    };

    const winRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': winIdempotencyKey,
        'content-type': 'application/json',
      },
      data: winPayload,
    });
    expect(winRes.status()).toBe(200);
    const winResult = financialResultSchema.parse(await winRes.json());
    expect(winResult.status).toBe('PROCESSED');
    expect(winResult.balance).toEqual({ amount: '120.00', currency: 'EUR' });

    const postWinRec = await request.post(`/wallets/${wallet.id}/reconciliation`);
    expect(postWinRec.status()).toBe(200);
    const postWinData = reconciliationResponseSchema.parse(await postWinRec.json());
    expect(postWinData.checkedEntries).toBe(3);
    expect(postWinData.storedBalance.amount).toBe('120.00');
    expect(postWinData.calculatedBalance.amount).toBe('120.00');
    expect(postWinData.difference.amount).toBe('0.00');
    expect(postWinData.consistent).toBe(true);

    // 5. LOSS of 20.00 EUR -> Result recorded, but does not affect balance (no ledger entry)
    const lossRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': 'key_loss_' + crypto.randomUUID(),
        'content-type': 'application/json',
      },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: 'ext_loss_' + crypto.randomUUID(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round_02',
        gameId: 'game_01',
        kind: 'LOSS',
        money: { amount: '20.00', currency: 'EUR' },
      },
    });
    expect(lossRes.status()).toBe(200);
    const lossResult = financialResultSchema.parse(await lossRes.json());
    expect(lossResult.status).toBe('PROCESSED');
    expect(lossResult.balance).toEqual({ amount: '120.00', currency: 'EUR' });

    const postLossRec = await request.post(`/wallets/${wallet.id}/reconciliation`);
    expect(postLossRec.status()).toBe(200);
    const postLossData = reconciliationResponseSchema.parse(await postLossRec.json());
    expect(postLossData.checkedEntries).toBe(3);
    expect(postLossData.storedBalance.amount).toBe('120.00');
    expect(postLossData.consistent).toBe(true);

    // 6. REJECTION on insufficient funds -> 422 Unprocessable, no ledger entry
    const rejectRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': 'key_reject_' + crypto.randomUUID(),
        'content-type': 'application/json',
      },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: 'ext_reject_' + crypto.randomUUID(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round_03',
        gameId: 'game_01',
        kind: 'BET',
        money: { amount: '500.00', currency: 'EUR' },
      },
    });
    expect(rejectRes.status()).toBe(422);
    const rejectResult = financialResultSchema.parse(await rejectRes.json());
    expect(rejectResult.status).toBe('REJECTED');
    expect(rejectResult.failureCode).toBe('INSUFFICIENT_FUNDS');

    const postRejectRec = await request.post(`/wallets/${wallet.id}/reconciliation`);
    expect(postRejectRec.status()).toBe(200);
    const postRejectData = reconciliationResponseSchema.parse(await postRejectRec.json());
    expect(postRejectData.checkedEntries).toBe(3);
    expect(postRejectData.storedBalance.amount).toBe('120.00');
    expect(postRejectData.consistent).toBe(true);

    // 7. PENDING_REFERENCE (refund with unknown reference) -> 202 Accepted, no ledger entry
    const pendingRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': 'key_pending_' + crypto.randomUUID(),
        'content-type': 'application/json',
      },
      data: {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: 'ext_pending_' + crypto.randomUUID(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round_04',
        gameId: 'game_01',
        kind: 'REFUND',
        money: { amount: '10.00', currency: 'EUR' },
        referenceExternalTransactionId: 'ext_non_existent_' + crypto.randomUUID(),
      },
    });
    expect(pendingRes.status()).toBe(202);
    const pendingResult = financialResultSchema.parse(await pendingRes.json());
    expect(pendingResult.status).toBe('PENDING_REFERENCE');

    const postPendingRec = await request.post(`/wallets/${wallet.id}/reconciliation`);
    expect(postPendingRec.status()).toBe(200);
    const postPendingData = reconciliationResponseSchema.parse(
      await postPendingRec.json(),
    );
    expect(postPendingData.checkedEntries).toBe(3);
    expect(postPendingData.storedBalance.amount).toBe('120.00');
    expect(postPendingData.calculatedBalance.amount).toBe('120.00');
    expect(postPendingData.difference.amount).toBe('0.00');
    expect(postPendingData.consistent).toBe(true);
  });

  test('reconciles wallets across all supported currencies', async ({ request }) => {
    const currencies = ['BRL', 'USD', 'EUR'] as const;

    for (const currency of currencies) {
      const wallet = await createWalletFixture(request, '75.25', currency);
      const response = await request.post(`/wallets/${wallet.id}/reconciliation`);

      expect(response.status()).toBe(200);
      const parsed = reconciliationResponseSchema.parse(await response.json());

      expect(parsed.walletId).toBe(wallet.id);
      expect(parsed.storedBalance).toEqual({ amount: '75.25', currency });
      expect(parsed.calculatedBalance).toEqual({ amount: '75.25', currency });
      expect(parsed.difference).toEqual({ amount: '0.00', currency });
      expect(parsed.consistent).toBe(true);
      expect(parsed.checkedEntries).toBe(1);
    }
  });

  test('returns 404 WALLET_NOT_FOUND when wallet does not exist', async ({ request }) => {
    const missingWalletId = crypto.randomUUID();
    const response = await request.post(`/wallets/${missingWalletId}/reconciliation`);

    expect(response.status()).toBe(404);
    const error = errorEnvelopeSchema.parse(await response.json());

    expect(error.category).toBe('NotFoundError');
    expect(error.code).toBe('WALLET_NOT_FOUND');
  });

  test('returns 400 WALLET_ID_INVALID for non-UUID wallet identifier', async ({
    request,
  }) => {
    const response = await request.post('/wallets/not-a-valid-uuid/reconciliation');

    expect(response.status()).toBe(400);
    const error = errorEnvelopeSchema.parse(await response.json());

    expect(error.category).toBe('ValidationError');
    expect(error.code).toBe('WALLET_ID_INVALID');
  });

  test('maintains atomic snapshots during concurrent sequential writes with external oracle', async ({
    request,
  }) => {
    const wallet = await createWalletFixture(request, '100.00', 'USD');

    // Oracle keeps exact valid snapshot states: balance and count of entries
    interface ValidSnapshot {
      readonly balanceAmount: string;
      readonly entries: number;
    }

    const validSnapshots: ValidSnapshot[] = [
      { balanceAmount: '100.00', entries: 1 }, // initial opening
      { balanceAmount: '90.00', entries: 2 }, // -10.00 BET
      { balanceAmount: '75.00', entries: 3 }, // -15.00 BET
      { balanceAmount: '95.00', entries: 4 }, // +20.00 WIN
      { balanceAmount: '90.00', entries: 5 }, // -5.00 BET
    ];

    const writes = [
      { kind: 'BET', amount: '10.00' },
      { kind: 'BET', amount: '15.00' },
      { kind: 'WIN', amount: '20.00' },
      { kind: 'BET', amount: '5.00' },
    ];

    const { promise: startGate, resolve: releaseStart } =
      Promise.withResolvers<undefined>();
    const reconciliationResults: Array<z.infer<typeof reconciliationResponseSchema>> = [];

    // Background reconciliation poller
    const poller = (async () => {
      await startGate;
      for (let i = 0; i < 12; i++) {
        const response = await request.post(`/wallets/${wallet.id}/reconciliation`, {
          headers: { 'x-correlation-id': `concurrent-rec-${i.toString()}` },
        });
        expect(response.status()).toBe(200);
        reconciliationResults.push(
          reconciliationResponseSchema.parse(await response.json()),
        );
      }
    })();

    // Sequential writer
    const writer = (async () => {
      releaseStart(undefined);
      for (const write of writes) {
        const res = await request.post('/wagering/transactions', {
          headers: {
            'idempotency-key': 'seq_key_' + crypto.randomUUID(),
            'content-type': 'application/json',
          },
          data: {
            providerId: LOCAL_PROVIDER_ID,
            externalTransactionId: 'seq_ext_' + crypto.randomUUID(),
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'round_seq',
            gameId: 'game_seq',
            kind: write.kind,
            money: { amount: write.amount, currency: 'USD' },
          },
        });
        expect(res.status()).toBe(200);
      }
    })();

    await Promise.all([writer, poller]);

    for (const rec of reconciliationResults) {
      // 1. Never report false divergence
      expect(rec.consistent).toBe(true);
      expect(rec.difference.amount).toBe('0.00');
      expect(rec.storedBalance.amount).toBe(rec.calculatedBalance.amount);

      // 2. Must match an exact valid oracle state (no torn balance vs entry count)
      const matchingState = validSnapshots.find(
        (state) =>
          state.balanceAmount === rec.storedBalance.amount &&
          state.entries === rec.checkedEntries,
      );
      expect(matchingState).toBeDefined();
    }

    // Final reconciliation must see state after all 4 writes
    const finalRec = await request.post(`/wallets/${wallet.id}/reconciliation`);
    expect(finalRec.status()).toBe(200);
    const finalData = reconciliationResponseSchema.parse(await finalRec.json());
    expect(finalData.checkedEntries).toBe(5);
    expect(finalData.storedBalance.amount).toBe('90.00');
    expect(finalData.consistent).toBe(true);
  });
});

test.describe('GET /metrics Prometheus surface', () => {
  test('serves reconciliation metrics with correct Prometheus content type and counter format', async ({
    request,
  }) => {
    const response = await request.get('/metrics');

    expect(response.status()).toBe(200);
    const contentType = response.headers()['content-type'] ?? '';
    expect(contentType).toContain('text/plain');

    const text = await response.text();

    // Verify presence of total counter and HELP/TYPE lines
    expect(text).toContain('# HELP wallet_reconciliation_total');
    expect(text).toContain('# TYPE wallet_reconciliation_total counter');
    expect(text).toMatch(/^wallet_reconciliation_total \d+$/m);

    // Verify presence of divergence counter and HELP/TYPE lines
    expect(text).toContain('# HELP wallet_reconciliation_divergence_total');
    expect(text).toContain('# TYPE wallet_reconciliation_divergence_total counter');
    expect(text).toMatch(/^wallet_reconciliation_divergence_total \d+$/m);
  });
});
