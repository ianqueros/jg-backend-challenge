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
    version: z.literal('1'),
  })
  .strict();

const errorEnvelopeSchema = z
  .object({
    category: z.string(),
    code: z.string(),
    message: z.string(),
  })
  .strict();

test.describe('POST /wallets API', () => {
  test('creates a wallet with positive initial balance (201 Created)', async ({
    request,
  }) => {
    const playerId = crypto.randomUUID();
    const correlationId = 'http-api-' + crypto.randomUUID();

    const response = await request.post('/wallets', {
      headers: {
        'x-correlation-id': correlationId,
        'content-type': 'application/json',
      },
      data: {
        playerId,
        initialBalance: { amount: '100.50', currency: 'BRL' },
      },
    });

    expect(response.status()).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    const parsed = walletResponseSchema.parse(body);

    expect(parsed.playerId).toBe(playerId);
    expect(parsed.balance).toEqual({ amount: '100.50', currency: 'BRL' });
    expect(parsed.version).toBe('1');
  });

  test('creates a wallet with zero balance (201 Created)', async ({ request }) => {
    const playerId = crypto.randomUUID();

    const response = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId,
        initialBalance: { amount: '0.00', currency: 'USD' },
      },
    });

    expect(response.status()).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    const parsed = walletResponseSchema.parse(body);

    expect(parsed.playerId).toBe(playerId);
    expect(parsed.balance).toEqual({ amount: '0.00', currency: 'USD' });
    expect(parsed.version).toBe('1');
  });

  test('allows same player to open wallets in different currencies', async ({
    request,
  }) => {
    const playerId = crypto.randomUUID();

    const brlResponse = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      },
    });
    expect(brlResponse.status()).toBe(201);

    const eurResponse = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId,
        initialBalance: { amount: '75.00', currency: 'EUR' },
      },
    });
    expect(eurResponse.status()).toBe(201);

    const brlBody = walletResponseSchema.parse(await brlResponse.json());
    const eurBody = walletResponseSchema.parse(await eurResponse.json());

    expect(brlBody.id).not.toBe(eurBody.id);
    expect(brlBody.balance.currency).toBe('BRL');
    expect(eurBody.balance.currency).toBe('EUR');
  });

  test('rejects duplicate wallet creation with 409 Conflict', async ({ request }) => {
    const playerId = crypto.randomUUID();
    const payload = {
      playerId,
      initialBalance: { amount: '10.00', currency: 'USD' },
    };

    const first = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: payload,
    });
    expect(first.status()).toBe(201);

    const duplicate = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: payload,
    });
    expect(duplicate.status()).toBe(409);

    const body = (await duplicate.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);
    expect(error.category).toBe('ConflictError');
    expect(error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test('rejects invalid input schema with 400 Bad Request', async ({ request }) => {
    const response = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: 'not-a-valid-uuid',
        initialBalance: { amount: '10.00', currency: 'BRL' },
      },
    });

    expect(response.status()).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);
    expect(error.category).toBe('ValidationError');
    expect(error.code).toBe('WALLET_INPUT_INVALID');
  });

  test('rejects unsupported currency with 400 Bad Request', async ({ request }) => {
    const response = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.00', currency: 'GBP' },
      },
    });

    expect(response.status()).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);
    expect(error.category).toBe('ValidationError');
    expect(error.code).toBe('WALLET_INPUT_INVALID');
  });

  test('rejects negative opening balance with 400 Bad Request', async ({ request }) => {
    const response = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '-25.00', currency: 'USD' },
      },
    });

    expect(response.status()).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);
    expect(error.category).toBe('ValidationError');
    expect(error.code).toBe('WALLET_INPUT_INVALID');
  });

  test('rejects extra properties with 400 Bad Request (strict schema)', async ({
    request,
  }) => {
    const response = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
        extraField: true,
      },
    });

    expect(response.status()).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    const error = errorEnvelopeSchema.parse(body);
    expect(error.category).toBe('ValidationError');
    expect(error.code).toBe('WALLET_INPUT_INVALID');
  });
});
