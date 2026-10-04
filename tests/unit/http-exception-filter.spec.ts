import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  ConflictException,
  Controller,
  Get,
  Module,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { healthErrors } from '../../src/domains/health/health.errors.js';
import { walletErrors } from '../../src/domains/wallet/wallet.errors.js';
import { ApplicationErrorFilter } from '../../src/shared/application-error.filter.js';
import { ApplicationError } from '../../src/shared/errors.js';

@Controller('test-errors')
class TestErrorController {
  @Get('business-rule')
  throwBusinessRule() {
    throw walletErrors.insufficientBalance();
  }

  @Get('validation')
  throwValidation() {
    throw walletErrors.invalidInput(
      new Error('Internal Zod validation issue on field amount'),
    );
  }

  @Get('connection')
  throwConnection() {
    throw healthErrors.dependenciesUnavailable(
      new Error('PostgreSQL TCP connection refused'),
    );
  }

  @Get('unknown-server-error')
  throwUnknown() {
    throw Object.assign(
      new Error('Database password was leaked in raw internal error message'),
      { status: 413 },
    );
  }

  @Get('custom-with-metadata')
  throwCustomWithMetadata() {
    throw new ApplicationError(
      {
        category: 'BusinessRuleError',
        code: 'ACTION_DISALLOWED',
        message: 'Developer internal diagnosis with secret details',
        publicMessage: 'The action is not permitted.',
      },
      { internalQuery: 'SELECT secret_token FROM keys', executionTimeMs: 12 },
      new Error('Private root cause'),
    );
  }

  @Get('http-401')
  throwHttp401() {
    throw new UnauthorizedException();
  }

  @Get('http-409')
  throwHttp409() {
    throw new ConflictException('Private database conflict details');
  }

  @Get('http-422')
  throwHttp422() {
    throw new UnprocessableEntityException();
  }

  @Get('http-503')
  throwHttp503() {
    throw new ServiceUnavailableException();
  }
}

@Module({
  controllers: [TestErrorController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: ApplicationErrorFilter,
    },
  ],
})
class TestAppModule {}

describe('HTTP Exception Filter (Isolated Nest Instance)', () => {
  let app: INestApplication | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(TestAppModule, { logger: false });
    await app.listen(0);
    const server = app.getHttpServer() as Server;
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Server address is not AddressInfo');
    }
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('maps BusinessRuleError to HTTP 422 with safe category and code', async () => {
    const response = await fetch(`${baseUrl}/test-errors/business-rule`);

    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['category']).toBe('BusinessRuleError');
    expect(body['code']).toBe('WALLET_INSUFFICIENT_BALANCE');
    expect(typeof body['message']).toBe('string');
    expect((body['message'] as string).length).toBeGreaterThan(0);
    expect(Object.keys(body).sort()).toEqual(['category', 'code', 'message']);
  });

  it('maps ValidationError to HTTP 400 without leaking raw validation cause', async () => {
    const response = await fetch(`${baseUrl}/test-errors/validation`);

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['category']).toBe('ValidationError');
    expect(body['code']).toBe('WALLET_INPUT_INVALID');
    expect(typeof body['message']).toBe('string');
    expect((body['message'] as string).length).toBeGreaterThan(0);
    expect(body['cause']).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('Internal Zod validation issue');
    expect(Object.keys(body).sort()).toEqual(['category', 'code', 'message']);
  });

  it('maps ExternalConnectionError to HTTP 503 without leaking connection details', async () => {
    const response = await fetch(`${baseUrl}/test-errors/connection`);

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['category']).toBe('ExternalConnectionError');
    expect(body['code']).toBe('DEPENDENCIES_UNAVAILABLE');
    expect(typeof body['message']).toBe('string');
    expect((body['message'] as string).length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain('TCP connection refused');
    expect(Object.keys(body).sort()).toEqual(['category', 'code', 'message']);
  });

  it('maps unknown internal exception to HTTP 500 without leaking error text', async () => {
    const response = await fetch(`${baseUrl}/test-errors/unknown-server-error`);

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['category']).toBe('ServerError');
    expect(body['code']).toBe('SERVER_ERROR');
    expect(typeof body['message']).toBe('string');
    expect((body['message'] as string).length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain('Database password was leaked');
    expect(Object.keys(body).sort()).toEqual(['category', 'code', 'message']);
  });

  it('omits metadata and private cause from custom ApplicationError responses', async () => {
    const response = await fetch(`${baseUrl}/test-errors/custom-with-metadata`);

    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['category']).toBe('BusinessRuleError');
    expect(body['code']).toBe('ACTION_DISALLOWED');
    expect(typeof body['message']).toBe('string');
    expect((body['message'] as string).length).toBeGreaterThan(0);
    expect(body['metadata']).toBeUndefined();
    expect(body['cause']).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('SELECT secret_token');
    expect(JSON.stringify(body)).not.toContain('Developer internal diagnosis');
    expect(Object.keys(body).sort()).toEqual(['category', 'code', 'message']);
  });

  it('maps framework 404 route not found to safe NotFoundError envelope', async () => {
    const response = await fetch(`${baseUrl}/non-existent-test-route`);

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['category']).toBe('NotFoundError');
    expect(body['code']).toBe('ROUTE_NOT_FOUND');
    expect(typeof body['message']).toBe('string');
    expect((body['message'] as string).length).toBeGreaterThan(0);
    expect(Object.keys(body).sort()).toEqual(['category', 'code', 'message']);
  });

  it('maps framework 401 UnauthorizedException to AuthenticationError', async () => {
    const response = await fetch(`${baseUrl}/test-errors/http-401`);

    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['category']).toBe('AuthenticationError');
    expect(body['code']).toBe('AUTHENTICATION_REQUIRED');
    expect(typeof body['message']).toBe('string');
    expect((body['message'] as string).length).toBeGreaterThan(0);
    expect(Object.keys(body).sort()).toEqual(['category', 'code', 'message']);
  });

  it('maps framework 409 to a safe ConflictError envelope', async () => {
    const response = await fetch(`${baseUrl}/test-errors/http-409`);
    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['category']).toBe('ConflictError');
    expect(body['code']).toBe('HTTP_REQUEST_CONFLICT');
    expect(body['message']).not.toContain('Private database conflict details');
    expect(Object.keys(body).sort()).toEqual(['category', 'code', 'message']);
  });

  it('maps framework 422 UnprocessableEntityException to BusinessRuleError', async () => {
    const response = await fetch(`${baseUrl}/test-errors/http-422`);

    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['category']).toBe('BusinessRuleError');
    expect(body['code']).toBe('HTTP_BUSINESS_RULE_REJECTED');
    expect(typeof body['message']).toBe('string');
    expect((body['message'] as string).length).toBeGreaterThan(0);
    expect(Object.keys(body).sort()).toEqual(['category', 'code', 'message']);
  });

  it('maps framework 503 ServiceUnavailableException to ExternalConnectionError', async () => {
    const response = await fetch(`${baseUrl}/test-errors/http-503`);

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['category']).toBe('ExternalConnectionError');
    expect(body['code']).toBe('HTTP_SERVICE_UNAVAILABLE');
    expect(typeof body['message']).toBe('string');
    expect((body['message'] as string).length).toBeGreaterThan(0);
    expect(Object.keys(body).sort()).toEqual(['category', 'code', 'message']);
  });
});
