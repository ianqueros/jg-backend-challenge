import { expect, test } from '@playwright/test';
import { z } from 'zod';

const walletResponseSchema = z
  .object({
    id: z.uuid(),
    playerId: z.uuid(),
    balance: z
      .object({
        amount: z.string().regex(/^\d+\.\d{2}$/),
        currency: z.enum(['BRL', 'USD', 'EUR']),
      })
      .strict(),
    version: z.string().regex(/^\d+$/),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const ledgerItemSchema = z
  .object({
    id: z.uuid(),
    walletId: z.uuid(),
    transactionId: z.uuid(),
    direction: z.enum(['DEBIT', 'CREDIT']),
    money: z
      .object({
        amount: z.string().regex(/^\d+\.\d{2}$/),
        currency: z.enum(['BRL', 'USD', 'EUR']),
      })
      .strict(),
    balanceBefore: z
      .object({
        amount: z.string().regex(/^\d+\.\d{2}$/),
        currency: z.enum(['BRL', 'USD', 'EUR']),
      })
      .strict(),
    balanceAfter: z
      .object({
        amount: z.string().regex(/^\d+\.\d{2}$/),
        currency: z.enum(['BRL', 'USD', 'EUR']),
      })
      .strict(),
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

const transactionResponseSchema = z
  .object({
    id: z.uuid(),
    providerId: z.string().min(1),
    externalTransactionId: z.string().min(1),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: z.string().optional(),
    gameId: z.string().optional(),
    kind: z.string().min(1),
    money: z
      .object({
        amount: z.string().regex(/^\d+\.\d{2}$/),
        currency: z.enum(['BRL', 'USD', 'EUR']),
      })
      .strict(),
    status: z.string().min(1),
    referenceExternalTransactionId: z.string().optional(),
    referenceTransactionId: z.string().optional(),
    failureCode: z.string().optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    processedAt: z.iso.datetime().optional(),
    closedAt: z.iso.datetime().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
const errorEnvelopeSchema = z
  .object({
    category: z.string(),
    code: z.string(),
    message: z.string(),
  })
  .strict();

test.describe('GET /wallets/:walletId API', () => {
  test('returns 200 and wallet details for existing wallet', async ({ request }) => {
    const playerId = crypto.randomUUID();
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId,
        initialBalance: { amount: '125.50', currency: 'BRL' },
      },
    });
    expect(createRes.status()).toBe(201);
    const createdWallet = (await createRes.json()) as { id: string };

    const response = await request.get(`/wallets/${createdWallet.id}`);
    expect(response.status()).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const parsed = walletResponseSchema.parse(body);

    expect(parsed.id).toBe(createdWallet.id);
    expect(parsed.playerId).toBe(playerId);
    expect(parsed.balance).toEqual({ amount: '125.50', currency: 'BRL' });
    expect(parsed.version).toBe('1');
    expect(typeof parsed.createdAt).toBe('string');
    expect(typeof parsed.updatedAt).toBe('string');
  });

  test('returns 404 WALLET_NOT_FOUND when wallet does not exist', async ({ request }) => {
    const missingWalletId = crypto.randomUUID();
    const response = await request.get(`/wallets/${missingWalletId}`);

    expect(response.status()).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);

    expect(error.category).toBe('NotFoundError');
    expect(error.code).toBe('WALLET_NOT_FOUND');
  });

  test('returns 400 WALLET_ID_INVALID for invalid wallet UUID', async ({ request }) => {
    const response = await request.get('/wallets/not-a-valid-uuid');

    expect(response.status()).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);

    expect(error.category).toBe('ValidationError');
    expect(error.code).toBe('WALLET_ID_INVALID');
  });
});

test.describe('GET /wallets/:walletId/ledger API', () => {
  test('returns empty ledger on zero-opening wallet (200 OK)', async ({ request }) => {
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '0.00', currency: 'USD' },
      },
    });
    expect(createRes.status()).toBe(201);
    const createdWallet = (await createRes.json()) as { id: string };

    const response = await request.get(`/wallets/${createdWallet.id}/ledger`);
    expect(response.status()).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const parsed = ledgerResponseSchema.parse(body);

    expect(parsed.items).toEqual([]);
    expect(parsed.nextCursor).toBeNull();
    expect(parsed.hasMore).toBe(false);
  });

  test('returns opening credit ledger entry for positive opening wallet (200 OK)', async ({
    request,
  }) => {
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '350.00', currency: 'EUR' },
      },
    });
    expect(createRes.status()).toBe(201);
    const createdWallet = (await createRes.json()) as { id: string };

    const response = await request.get(`/wallets/${createdWallet.id}/ledger`);
    expect(response.status()).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const parsed = ledgerResponseSchema.parse(body);

    expect(parsed.items.length).toBe(1);
    const entry = parsed.items[0];
    expect(entry).toBeDefined();
    if (entry === undefined) {
      throw new Error('Expected entry to be defined');
    }
    expect(entry.walletId).toBe(createdWallet.id);
    expect(entry.direction).toBe('CREDIT');
    expect(entry.money).toEqual({ amount: '350.00', currency: 'EUR' });
    expect(entry.balanceBefore).toEqual({ amount: '0.00', currency: 'EUR' });
    expect(entry.balanceAfter).toEqual({ amount: '350.00', currency: 'EUR' });
    expect(entry.walletVersion).toBe('1');
    expect(parsed.nextCursor).toBeNull();
    expect(parsed.hasMore).toBe(false);
  });

  test('accepts valid limit parameter', async ({ request }) => {
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '50.00', currency: 'BRL' },
      },
    });
    const createdWallet = (await createRes.json()) as { id: string };

    const response = await request.get(`/wallets/${createdWallet.id}/ledger?limit=10`);
    expect(response.status()).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const parsed = ledgerResponseSchema.parse(body);
    expect(parsed.items.length).toBe(1);
  });

  for (const invalidLimit of ['0', '201', '-1', 'abc']) {
    test(`rejects invalid limit=${invalidLimit} with 400 PAGINATION_LIMIT_INVALID`, async ({
      request,
    }) => {
      const createRes = await request.post('/wallets', {
        headers: { 'content-type': 'application/json' },
        data: {
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '10.00', currency: 'BRL' },
        },
      });
      const createdWallet = (await createRes.json()) as { id: string };

      const response = await request.get(
        `/wallets/${createdWallet.id}/ledger?limit=${invalidLimit}`,
      );
      expect(response.status()).toBe(400);

      const body = (await response.json()) as Record<string, unknown>;
      const error = errorEnvelopeSchema.parse(body);
      expect(error.category).toBe('ValidationError');
      expect(error.code).toBe('PAGINATION_LIMIT_INVALID');
    });
  }

  test('rejects tampered or invalid cursor with 400 LEDGER_CURSOR_INVALID', async ({
    request,
  }) => {
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      },
    });
    const createdWallet = (await createRes.json()) as { id: string };

    const response = await request.get(
      `/wallets/${createdWallet.id}/ledger?cursor=tampered_cursor_payload`,
    );
    expect(response.status()).toBe(400);

    const body = (await response.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);
    expect(error.category).toBe('ValidationError');
    expect(error.code).toBe('LEDGER_CURSOR_INVALID');
  });

  test('returns 404 WALLET_NOT_FOUND for non-existent wallet ledger', async ({
    request,
  }) => {
    const missingWalletId = crypto.randomUUID();
    const response = await request.get(`/wallets/${missingWalletId}/ledger`);

    expect(response.status()).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);
    expect(error.category).toBe('NotFoundError');
    expect(error.code).toBe('WALLET_NOT_FOUND');
  });

  test('returns 400 WALLET_ID_INVALID for invalid wallet UUID on ledger endpoint', async ({
    request,
  }) => {
    const response = await request.get('/wallets/invalid-uuid-format/ledger');

    expect(response.status()).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);
    expect(error.category).toBe('ValidationError');
    expect(error.code).toBe('WALLET_ID_INVALID');
  });
});

test.describe('GET /wagering/transactions/:transactionId API', () => {
  test('returns 200 and transaction representation for valid transaction ID', async ({
    request,
  }) => {
    const playerId = crypto.randomUUID();
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId,
        initialBalance: { amount: '220.00', currency: 'USD' },
      },
    });
    expect(createRes.status()).toBe(201);
    const createdWallet = (await createRes.json()) as { id: string };

    // Retrieve ledger to get opening transaction ID
    const ledgerRes = await request.get(`/wallets/${createdWallet.id}/ledger`);
    expect(ledgerRes.status()).toBe(200);
    const ledgerBody = (await ledgerRes.json()) as {
      items: Array<{ transactionId: string }>;
    };
    const transactionId = z.uuid().parse(ledgerBody.items[0]?.transactionId);

    const response = await request.get(`/wagering/transactions/${transactionId}`);
    expect(response.status()).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    const parsed = transactionResponseSchema.parse(body);

    expect(parsed.id).toBe(transactionId);
    expect(parsed.providerId).toBe('__internal__');
    expect(parsed.externalTransactionId).toBe(createdWallet.id);
    expect(parsed.playerId).toBe(playerId);
    expect(parsed.walletId).toBe(createdWallet.id);
    expect(parsed.kind).toBe('OPENING');
    expect(parsed.money).toEqual({ amount: '220.00', currency: 'USD' });
    expect(parsed.status).toBe('PROCESSED');
  });

  test('returns 404 TRANSACTION_NOT_FOUND when transaction does not exist', async ({
    request,
  }) => {
    const missingTxId = crypto.randomUUID();
    const response = await request.get(`/wagering/transactions/${missingTxId}`);

    expect(response.status()).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);

    expect(error.category).toBe('NotFoundError');
    expect(error.code).toBe('TRANSACTION_NOT_FOUND');
  });

  test('returns 400 TRANSACTION_ID_INVALID for invalid transaction UUID', async ({
    request,
  }) => {
    const response = await request.get('/wagering/transactions/not-a-uuid');

    expect(response.status()).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);

    expect(error.category).toBe('ValidationError');
    expect(error.code).toBe('TRANSACTION_ID_INVALID');
  });
});

test.describe('GET /providers/:providerId/wagering/transactions/:externalTransactionId API', () => {
  test('returns identical data as internal transaction lookup', async ({ request }) => {
    const playerId = crypto.randomUUID();
    const createRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId,
        initialBalance: { amount: '180.00', currency: 'EUR' },
      },
    });
    expect(createRes.status()).toBe(201);
    const createdWallet = (await createRes.json()) as { id: string };

    const ledgerRes = await request.get(`/wallets/${createdWallet.id}/ledger`);
    const ledgerBody = (await ledgerRes.json()) as {
      items: Array<{ transactionId: string }>;
    };
    const transactionId = z.uuid().parse(ledgerBody.items[0]?.transactionId);

    const internalRes = await request.get(`/wagering/transactions/${transactionId}`);
    expect(internalRes.status()).toBe(200);
    const internalData = (await internalRes.json()) as Record<string, unknown>;

    const externalRes = await request.get(
      `/providers/__internal__/wagering/transactions/${createdWallet.id}`,
    );
    expect(externalRes.status()).toBe(200);
    const externalData = (await externalRes.json()) as Record<string, unknown>;

    expect(externalData).toEqual(internalData);
  });

  test('returns 404 TRANSACTION_NOT_FOUND for non-existent external transaction ID', async ({
    request,
  }) => {
    const response = await request.get(
      '/providers/__internal__/wagering/transactions/ext_does_not_exist',
    );

    expect(response.status()).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);

    expect(error.category).toBe('NotFoundError');
    expect(error.code).toBe('TRANSACTION_NOT_FOUND');
  });

  test('returns 400 for invalid provider or external ID format', async ({ request }) => {
    const response = await request.get(
      '/providers/%20invalid_space/wagering/transactions/ext_valid',
    );

    expect(response.status()).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);

    expect(error.category).toBe('ValidationError');
  });
});
