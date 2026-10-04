import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { expect, test } from '@playwright/test';
import { z } from 'zod';

const financialResultSchema = z
  .object({
    transactionId: z.uuid(),
    status: z.enum(['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED']),
    balance: z
      .object({
        amount: z.string().regex(/^\d+\.\d{2}$/),
        currency: z.enum(['BRL', 'USD', 'EUR']),
      })
      .strict()
      .optional(),
    walletVersion: z.string().regex(/^\d+$/).optional(),
    failureCode: z.string().optional(),
    idempotentReplay: z.boolean(),
  })
  .strict();

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
  })
  .loose();

const errorEnvelopeSchema = z
  .object({
    category: z.string(),
    code: z.string(),
    message: z.string(),
  })
  .strict();

const LOCAL_PROVIDER_ID = 'provider-a';

async function sendRawHttpRequest(
  path: string,
  rawHeaders: Array<[string, string]>,
  body: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const apiUrl = new URL(path, process.env.API_URL ?? 'http://127.0.0.1:3100');
  const requestHttp = apiUrl.protocol === 'https:' ? httpsRequest : httpRequest;
  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number;
    body: Record<string, unknown>;
  }>();
  const request = requestHttp(
    apiUrl,
    {
      method: 'POST',
      headers: [
        'Host',
        apiUrl.host,
        'Content-Type',
        'application/json',
        'Content-Length',
        String(Buffer.byteLength(body)),
        ...rawHeaders.flat(),
      ],
    },
    (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        responseBody += chunk;
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(responseBody);
          const result = z.record(z.string(), z.unknown()).parse(parsed);
          resolve({ status: response.statusCode ?? 0, body: result });
        } catch (error) {
          reject(error);
        }
      });
    },
  );
  request.on('error', reject);
  request.setTimeout(5000, () => request.destroy(new Error('Gateway request timeout.')));
  request.end(body);
  return promise;
}

test.describe('POST /wagering/transactions API', () => {
  for (const paddingBytes of [150 * 1024, 1100 * 1024]) {
    test(`rejects a ${String(paddingBytes)}-byte padded JSON body before reserving its identity`, async ({
      request,
    }) => {
      const create = await request.post('/wallets', {
        data: {
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        },
      });
      expect(create.status()).toBe(201);
      const wallet = walletResponseSchema
        .omit({ createdAt: true, updatedAt: true })
        .parse(await create.json());
      const key = crypto.randomUUID();
      const payload = {
        providerId: LOCAL_PROVIDER_ID,
        externalTransactionId: crypto.randomUUID(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-body-limit',
        gameId: 'game-body-limit',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      };
      const response = await request.post('/wagering/transactions', {
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        data: JSON.stringify(payload) + ' '.repeat(paddingBytes),
      });
      expect(response.status()).toBe(413);
      expect(errorEnvelopeSchema.parse(await response.json())).toMatchObject({
        category: 'ValidationError',
        code: 'HTTP_REQUEST_TOO_LARGE',
      });
      const lookup = await request.get(
        `/providers/${LOCAL_PROVIDER_ID}/wagering/transactions/${payload.externalTransactionId}`,
      );
      expect(lookup.status()).toBe(404);
      const unchanged = walletResponseSchema.parse(
        await (await request.get(`/wallets/${wallet.id}`)).json(),
      );
      expect(unchanged.balance).toEqual(wallet.balance);
      expect(unchanged.version).toBe(wallet.version);
      const accepted = await request.post('/wagering/transactions', {
        headers: { 'idempotency-key': key },
        data: payload,
      });
      expect(accepted.status()).toBe(200);
      expect(financialResultSchema.parse(await accepted.json())).toMatchObject({
        status: 'PROCESSED',
        idempotentReplay: false,
        balance: { amount: '90.00', currency: 'BRL' },
        walletVersion: '2',
      });
    });
  }
  test('processes valid BET and returns idempotent historical replay on retry (200 OK)', async ({
    request,
  }) => {
    const playerId = crypto.randomUUID();
    const createWalletRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      },
    });
    expect(createWalletRes.status()).toBe(201);
    const wallet = (await createWalletRes.json()) as { id: string; playerId: string };

    const idempotencyKey = 'key_bet_' + crypto.randomUUID();
    const externalTransactionId = 'ext_bet_' + crypto.randomUUID();
    const betPayload = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round_01',
      gameId: 'game_01',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    // 1. Initial submission
    const res1 = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': idempotencyKey,
        'content-type': 'application/json',
      },
      data: betPayload,
    });
    expect(res1.status()).toBe(200);
    const body1 = financialResultSchema.parse(await res1.json());
    expect(body1.status).toBe('PROCESSED');
    expect(body1.idempotentReplay).toBe(false);
    expect(body1.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(body1.walletVersion).toBe('2');

    // 2. Replay with exact same key and payload
    const res2 = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': idempotencyKey,
        'content-type': 'application/json',
      },
      data: betPayload,
    });
    expect(res2.status()).toBe(200);
    const body2 = financialResultSchema.parse(await res2.json());
    expect(body2.status).toBe('PROCESSED');
    expect(body2.idempotentReplay).toBe(true);
    expect(body2.transactionId).toBe(body1.transactionId);
    expect(body2.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(body2.walletVersion).toBe('2');

    // 3. Confirm wallet state in database
    const walletCheck = await request.get(`/wallets/${wallet.id}`);
    expect(walletCheck.status()).toBe(200);
    const walletBody = walletResponseSchema.parse(await walletCheck.json());
    expect(walletBody.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(walletBody.version).toBe('2');
  });

  test('preserves historical snapshot balance on replay after subsequent financial changes', async ({
    request,
  }) => {
    const playerId = crypto.randomUUID();
    const createWalletRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId,
        initialBalance: { amount: '100.00', currency: 'EUR' },
      },
    });
    const wallet = (await createWalletRes.json()) as { id: string; playerId: string };

    const betKey = 'key_hist_bet_' + crypto.randomUUID();
    const betPayload = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId: 'ext_hist_bet_' + crypto.randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round_hist_01',
      gameId: 'game_hist_01',
      kind: 'BET',
      money: { amount: '30.00', currency: 'EUR' },
    };

    // First operation: BET 30.00 -> balance 70.00, version 2
    const betRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': betKey,
        'content-type': 'application/json',
      },
      data: betPayload,
    });
    expect(betRes.status()).toBe(200);
    const betBody = financialResultSchema.parse(await betRes.json());
    expect(betBody.balance).toEqual({ amount: '70.00', currency: 'EUR' });
    expect(betBody.walletVersion).toBe('2');

    // Subsequent operation: WIN 50.00 -> balance 120.00, version 3
    const winKey = 'key_hist_win_' + crypto.randomUUID();
    const winPayload = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId: 'ext_hist_win_' + crypto.randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round_hist_01',
      gameId: 'game_hist_01',
      kind: 'WIN',
      money: { amount: '50.00', currency: 'EUR' },
    };
    const winRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': winKey,
        'content-type': 'application/json',
      },
      data: winPayload,
    });
    expect(winRes.status()).toBe(200);
    const winBody = financialResultSchema.parse(await winRes.json());
    expect(winBody.balance).toEqual({ amount: '120.00', currency: 'EUR' });
    expect(winBody.walletVersion).toBe('3');

    // Replay the FIRST BET: MUST return historical balance 70.00, version 2, not current 120.00
    const replayRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': betKey,
        'content-type': 'application/json',
      },
      data: betPayload,
    });
    expect(replayRes.status()).toBe(200);
    const replayBody = financialResultSchema.parse(await replayRes.json());
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.transactionId).toBe(betBody.transactionId);
    expect(replayBody.balance).toEqual({ amount: '70.00', currency: 'EUR' });
    expect(replayBody.walletVersion).toBe('2');

    // Confirm current wallet balance remains 120.00, version 3 (no double effect)
    const walletCheck = await request.get(`/wallets/${wallet.id}`);
    expect(walletCheck.status()).toBe(200);
    const walletBody = walletResponseSchema.parse(await walletCheck.json());
    expect(walletBody.balance).toEqual({ amount: '120.00', currency: 'EUR' });
    expect(walletBody.version).toBe('3');
  });

  test('durable rejection on insufficient funds returns 422 and preserves state on replay', async ({
    request,
  }) => {
    const playerId = crypto.randomUUID();
    const createWalletRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId,
        initialBalance: { amount: '20.00', currency: 'USD' },
      },
    });
    const wallet = (await createWalletRes.json()) as { id: string; playerId: string };

    const idempotencyKey = 'key_insufficient_' + crypto.randomUUID();
    const payload = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId: 'ext_insufficient_' + crypto.randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round_rej_01',
      gameId: 'game_rej_01',
      kind: 'BET',
      money: { amount: '50.00', currency: 'USD' },
    };

    // 1. Initial attempt rejected with 422
    const res1 = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': idempotencyKey,
        'content-type': 'application/json',
      },
      data: payload,
    });
    expect(res1.status()).toBe(422);
    const body1 = financialResultSchema.parse(await res1.json());
    expect(body1.status).toBe('REJECTED');
    expect(body1.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(body1.idempotentReplay).toBe(false);
    expect(body1.balance).toEqual({ amount: '20.00', currency: 'USD' });
    expect(body1.walletVersion).toBe('1');

    // 2. Replay returns 422 with idempotentReplay: true
    const res2 = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': idempotencyKey,
        'content-type': 'application/json',
      },
      data: payload,
    });
    expect(res2.status()).toBe(422);
    const body2 = financialResultSchema.parse(await res2.json());
    expect(body2).toEqual({ ...body1, idempotentReplay: true });

    // 3. Query transaction shows durable REJECTED record
    const txQuery = await request.get(`/wagering/transactions/${body1.transactionId}`);
    expect(txQuery.status()).toBe(200);
    const txBody = transactionResponseSchema.parse(await txQuery.json());
    expect(txBody.status).toBe('REJECTED');
    expect(txBody.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('rejects identity conflicts with 409 ConflictError', async ({ request }) => {
    const playerId = crypto.randomUUID();
    const createWalletRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId,
        initialBalance: { amount: '100.00', currency: 'EUR' },
      },
    });
    const wallet = (await createWalletRes.json()) as { id: string; playerId: string };

    const sharedKey = 'key_conflict_' + crypto.randomUUID();
    const sharedExtId = 'ext_conflict_' + crypto.randomUUID();

    const originalPayload = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId: sharedExtId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round_conf_01',
      gameId: 'game_conf_01',
      kind: 'BET',
      money: { amount: '10.00', currency: 'EUR' },
    };

    // Commit original
    const origRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': sharedKey,
        'content-type': 'application/json',
      },
      data: originalPayload,
    });
    expect(origRes.status()).toBe(200);

    // 1. Same Idempotency-Key with different payload -> WAGER_IDEMPOTENCY_CONFLICT
    const conflictingPayloadRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': sharedKey,
        'content-type': 'application/json',
      },
      data: {
        ...originalPayload,
        money: { amount: '20.00', currency: 'EUR' },
      },
    });
    expect(conflictingPayloadRes.status()).toBe(409);
    const err1 = errorEnvelopeSchema.parse(await conflictingPayloadRes.json());
    expect(err1.category).toBe('ConflictError');
    expect(err1.code).toBe('WAGER_IDEMPOTENCY_CONFLICT');

    // 2. Different Idempotency-Key with already accepted externalTransactionId -> WAGER_EXTERNAL_IDENTITY_CONFLICT
    const conflictingExtIdRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': 'different_key_' + crypto.randomUUID(),
        'content-type': 'application/json',
      },
      data: originalPayload,
    });
    expect(conflictingExtIdRes.status()).toBe(409);
    const err2 = errorEnvelopeSchema.parse(await conflictingExtIdRes.json());
    expect(err2.category).toBe('ConflictError');
    expect(err2.code).toBe('WAGER_EXTERNAL_IDENTITY_CONFLICT');
  });

  test('strict validation rejects missing key, invalid key, and invalid payloads with 400', async ({
    request,
  }) => {
    const playerId = crypto.randomUUID();
    const createWalletRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
      },
    });
    const wallet = (await createWalletRes.json()) as { id: string; playerId: string };

    const validPayload = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId: 'ext_strict_' + crypto.randomUUID(),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round_01',
      gameId: 'game_01',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };

    // 1. Missing Idempotency-Key
    const missingKeyRes = await request.post('/wagering/transactions', {
      headers: { 'content-type': 'application/json' },
      data: validPayload,
    });
    expect(missingKeyRes.status()).toBe(400);
    const errMissingKey = errorEnvelopeSchema.parse(await missingKeyRes.json());
    expect(errMissingKey.category).toBe('ValidationError');
    expect(errMissingKey.code).toBe('IDEMPOTENCY_KEY_INVALID');

    // 2. Idempotency-Key with spaces
    const spaceKeyRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': 'key with spaces',
        'content-type': 'application/json',
      },
      data: validPayload,
    });
    expect(spaceKeyRes.status()).toBe(400);
    const errSpaceKey = errorEnvelopeSchema.parse(await spaceKeyRes.json());
    expect(errSpaceKey.category).toBe('ValidationError');
    expect(errSpaceKey.code).toBe('IDEMPOTENCY_KEY_INVALID');

    // 3. Zero amount for non-LOSS transaction
    const zeroAmountRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': 'key_zero_' + crypto.randomUUID(),
        'content-type': 'application/json',
      },
      data: {
        ...validPayload,
        money: { amount: '0.00', currency: 'BRL' },
      },
    });
    expect(zeroAmountRes.status()).toBe(400);
    const errZero = errorEnvelopeSchema.parse(await zeroAmountRes.json());
    expect(errZero.category).toBe('ValidationError');
    expect(errZero.code).toBe('WAGER_INPUT_INVALID');

    // 4. Unknown/extra field rejected by strict schema
    const extraFieldRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': 'key_extra_' + crypto.randomUUID(),
        'content-type': 'application/json',
      },
      data: {
        ...validPayload,
        unrecognizedField: 'illegal',
      },
    });
    expect(extraFieldRes.status()).toBe(400);
    const errExtra = errorEnvelopeSchema.parse(await extraFieldRes.json());
    expect(errExtra.category).toBe('ValidationError');
    expect(errExtra.code).toBe('WAGER_INPUT_INVALID');

    // 5. Reserved internal provider ID in payload rejected by schema
    const internalProvRes = await request.post('/wagering/transactions', {
      headers: {
        'idempotency-key': 'key_internal_' + crypto.randomUUID(),
        'content-type': 'application/json',
      },
      data: {
        ...validPayload,
        providerId: '__internal__',
      },
    });
    expect(internalProvRes.status()).toBe(400);
    const errInternal = errorEnvelopeSchema.parse(await internalProvRes.json());
    expect(errInternal.category).toBe('ValidationError');
    expect(errInternal.code).toBe('WAGER_INPUT_INVALID');
  });

  test('rejects repeated raw Idempotency-Key headers with 400', async () => {
    const payload = JSON.stringify({
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId: 'ext_repeat_' + crypto.randomUUID(),
      playerId: crypto.randomUUID(),
      walletId: crypto.randomUUID(),
      roundId: 'round_01',
      gameId: 'game_01',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });

    // 1. Repeated headers with different casing
    const diffCasingRes = await sendRawHttpRequest(
      '/wagering/transactions',
      [
        ['Idempotency-Key', 'key_first'],
        ['idempotency-key', 'key_second'],
      ],
      payload,
    );
    expect(diffCasingRes.status).toBe(400);
    const errDiff = errorEnvelopeSchema.parse(diffCasingRes.body);
    expect(errDiff.category).toBe('ValidationError');
    expect(errDiff.code).toBe('IDEMPOTENCY_KEY_INVALID');

    // 2. Repeated headers with identical casing
    const sameCasingRes = await sendRawHttpRequest(
      '/wagering/transactions',
      [
        ['Idempotency-Key', 'key_one'],
        ['Idempotency-Key', 'key_two'],
      ],
      payload,
    );
    expect(sameCasingRes.status).toBe(400);
    const errSame = errorEnvelopeSchema.parse(sameCasingRes.body);
    expect(errSame.category).toBe('ValidationError');
    expect(errSame.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  test('handles PENDING_REFERENCE creation, idempotent replay without balance change, and dual lookups (202 Accepted)', async ({
    request,
  }) => {
    const playerId = crypto.randomUUID();
    const createWalletRes = await request.post('/wallets', {
      headers: { 'content-type': 'application/json' },
      data: {
        playerId,
        initialBalance: { amount: '100.00', currency: 'EUR' },
      },
    });
    expect(createWalletRes.status()).toBe(201);
    const wallet = (await createWalletRes.json()) as { id: string; playerId: string };

    const idempotencyKey = 'key_refund_' + crypto.randomUUID();
    const externalTransactionId = 'ext_refund_' + crypto.randomUUID();
    const missingRefId = 'ext_unseen_bet_' + crypto.randomUUID();

    const refundPayload = {
      providerId: LOCAL_PROVIDER_ID,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round_ref_01',
      gameId: 'game_ref_01',
      kind: 'REFUND',
      money: { amount: '20.00', currency: 'EUR' },
      referenceExternalTransactionId: missingRefId,
    };

    // 1. Initial submission returns 202 Accepted with PENDING_REFERENCE
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

    // 2. Replay returns 202 Accepted with idempotentReplay: true
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
    expect(body2.transactionId).toBe(body1.transactionId);
    expect(body2.balance).toEqual({ amount: '100.00', currency: 'EUR' });
    expect(body2.walletVersion).toBe('1');

    // 3. Confirm wallet balance and version remain unchanged
    const walletCheck = await request.get(`/wallets/${wallet.id}`);
    expect(walletCheck.status()).toBe(200);
    const walletBody = walletResponseSchema.parse(await walletCheck.json());
    expect(walletBody.balance).toEqual({ amount: '100.00', currency: 'EUR' });
    expect(walletBody.version).toBe('1');

    // 4. Lookup by internal transactionId
    const internalLookup = await request.get(
      `/wagering/transactions/${body1.transactionId}`,
    );
    expect(internalLookup.status()).toBe(200);
    const internalData = transactionResponseSchema.parse(await internalLookup.json());
    expect(internalData.id).toBe(body1.transactionId);
    expect(internalData.status).toBe('PENDING_REFERENCE');
    expect(internalData.referenceExternalTransactionId).toBe(missingRefId);

    // 5. Both lookup routes identify the same pending financial operation.
    const externalLookup = await request.get(
      `/providers/${LOCAL_PROVIDER_ID}/wagering/transactions/${externalTransactionId}`,
    );
    expect(externalLookup.status()).toBe(200);
    const externalData = transactionResponseSchema.parse(await externalLookup.json());
    expect(externalData).toMatchObject({
      id: body1.transactionId,
      status: 'PENDING_REFERENCE',
      referenceExternalTransactionId: missingRefId,
    });
  });

  test('two local HTTP providers have isolated keys, external identities, and references', async ({
    request,
  }) => {
    const create = await request.post('/wallets', {
      data: {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '100.00', currency: 'BRL' },
      },
    });
    expect(create.status()).toBe(201);
    const wallet = walletResponseSchema
      .omit({ createdAt: true, updatedAt: true })
      .parse(await create.json());
    const sharedKey = crypto.randomUUID();
    const sharedExternalId = crypto.randomUUID();
    const payload = {
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'local-provider-round',
      gameId: 'local-provider-game',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const identities: Record<string, string> = {};
    for (const providerId of ['provider-a', 'provider-b']) {
      const data = { ...payload, providerId, externalTransactionId: sharedExternalId };
      const response = await request.post('/wagering/transactions', {
        headers: { 'idempotency-key': sharedKey },
        data,
      });
      expect(response.status()).toBe(200);
      const result = financialResultSchema.parse(await response.json());
      expect(result.status).toBe('PROCESSED');
      expect(result.idempotentReplay).toBe(false);
      identities[providerId] = result.transactionId;
      const replay = await request.post('/wagering/transactions', {
        headers: { 'idempotency-key': sharedKey },
        data,
      });
      expect(replay.status()).toBe(200);
      expect(financialResultSchema.parse(await replay.json())).toEqual({
        ...result,
        idempotentReplay: true,
      });
      const lookup = await request.get(
        `/providers/${providerId}/wagering/transactions/${sharedExternalId}`,
      );
      expect(lookup.status()).toBe(200);
      expect(transactionResponseSchema.parse(await lookup.json())).toMatchObject({
        id: result.transactionId,
        providerId,
      });
    }
    expect(identities['provider-a']).not.toBe(identities['provider-b']);

    const referenceId = crypto.randomUUID();
    const reference = {
      ...payload,
      externalTransactionId: referenceId,
      money: { amount: '5.00', currency: 'BRL' },
    };
    const parentA = await request.post('/wagering/transactions', {
      headers: { 'idempotency-key': crypto.randomUUID() },
      data: { ...reference, providerId: 'provider-a' },
    });
    expect(parentA.status()).toBe(200);
    const refund = await request.post('/wagering/transactions', {
      headers: { 'idempotency-key': crypto.randomUUID() },
      data: {
        ...reference,
        providerId: 'provider-b',
        externalTransactionId: crypto.randomUUID(),
        kind: 'REFUND',
        referenceExternalTransactionId: referenceId,
      },
    });
    expect(refund.status()).toBe(202);
    const pending = financialResultSchema.parse(await refund.json());
    expect(pending.status).toBe('PENDING_REFERENCE');
    const parentB = await request.post('/wagering/transactions', {
      headers: { 'idempotency-key': crypto.randomUUID() },
      data: { ...reference, providerId: 'provider-b' },
    });
    expect(parentB.status()).toBe(200);
    const ownParent = financialResultSchema.parse(await parentB.json());
    await expect
      .poll(async () => {
        const lookup = await request.get(
          `/wagering/transactions/${pending.transactionId}`,
        );
        expect(lookup.status()).toBe(200);
        return transactionResponseSchema.parse(await lookup.json());
      })
      .toMatchObject({
        status: 'PROCESSED',
        providerId: 'provider-b',
        referenceTransactionId: ownParent.transactionId,
      });
    const balance = walletResponseSchema.parse(
      await (await request.get(`/wallets/${wallet.id}`)).json(),
    );
    expect(balance.balance.amount).toBe('75.00');
  });

  for (const providerId of [null, '__internal__']) {
    test(`rejects local provider ${JSON.stringify(providerId)} and accepts a corrected submission`, async ({
      request,
    }) => {
      const externalTransactionId = crypto.randomUUID();
      const key = crypto.randomUUID();
      const create = await request.post('/wallets', {
        data: {
          playerId: crypto.randomUUID(),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        },
      });
      expect(create.status()).toBe(201);
      const wallet = walletResponseSchema
        .omit({ createdAt: true, updatedAt: true })
        .parse(await create.json());
      const payload = {
        providerId,
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'invalid-provider-round',
        gameId: 'invalid-provider-game',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      };
      const rejected = await request.post('/wagering/transactions', {
        headers: { 'idempotency-key': key },
        data: payload,
      });
      expect(rejected.status()).toBe(400);
      const accepted = await request.post('/wagering/transactions', {
        headers: { 'idempotency-key': key },
        data: { ...payload, providerId: 'provider-b' },
      });
      expect(accepted.status()).toBe(200);
      expect(financialResultSchema.parse(await accepted.json())).toMatchObject({
        status: 'PROCESSED',
        idempotentReplay: false,
        balance: { amount: '90.00' },
      });
    });
  }
});
