import { expect, test } from '@playwright/test';
import { z } from 'zod';

const healthSchema = z.object({ status: z.literal('ok') }).strict();

const errorEnvelopeSchema = z
  .object({
    category: z.string(),
    code: z.string(),
    message: z.string(),
  })
  .strict();
test('liveness is public and independent of financial routes', async ({ request }) => {
  const response = await request.get('/health/live');
  expect(response.status()).toBe(200);
  expect(healthSchema.parse(await response.json())).toEqual({ status: 'ok' });
});

test('readiness checks real database and required queues', async ({ request }) => {
  const response = await request.get('/health/ready');
  expect(response.status()).toBe(200);
  expect(healthSchema.parse(await response.json())).toEqual({ status: 'ok' });
});

test('non-existent route returns 404 with safe error envelope and no leaked cause or metadata', async ({
  request,
}) => {
  const response = await request.get('/non-existent-api-path');
  expect(response.status()).toBe(404);
  const body = (await response.json()) as Record<string, unknown>;
  const parsed = errorEnvelopeSchema.parse(body);
  expect(parsed.category).toBe('NotFoundError');
  expect(parsed.code).toBe('ROUTE_NOT_FOUND');
  expect(body['cause']).toBeUndefined();
  expect(body['metadata']).toBeUndefined();
  expect(body['stack']).toBeUndefined();
});
