import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Knex } from 'knex';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { z } from 'zod';
import { createDatabaseOptions } from '../../src/core/database/database.config.js';
import { DatabaseTransactionRunner } from '../../src/core/database/database-transaction.runner.js';
import { GuardedUpdateConflictError } from '../../src/core/database/database.errors.js';
import { ApplicationError } from '../../src/shared/errors.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

interface SandboxRow {
  readonly id: string;
  readonly value: string;
  readonly version: number;
}

interface IdOnlyRow {
  readonly id: string;
}

interface ValueOnlyRow {
  readonly value: string;
}

interface ValueAndVersionRow {
  readonly value: string;
  readonly version: number;
}

interface AliveRow {
  readonly alive: number;
}

const environment = z
  .object({
    ADMIN_DATABASE_URL: z
      .url()
      .default('postgresql://postgres:postgres_local@127.0.0.1:55432/postgres'),
  })
  .parse(process.env);

const databaseName = 'jungle_runner_' + crypto.randomUUID().replaceAll('-', '');
let admin: MikroORM | undefined;
let application: MikroORM | undefined;
let databaseCreated = false;

function applicationDatabase(): MikroORM {
  if (!application) throw new Error('Application database fixture has not initialized');
  return application;
}

function adminDatabase(): MikroORM {
  if (!admin) throw new Error('Admin database fixture has not initialized');
  return admin;
}

function databaseUrl(user: string, password: string): string {
  const url = new URL(environment.ADMIN_DATABASE_URL);
  url.username = user;
  url.password = password;
  url.pathname = '/' + databaseName;
  return url.toString();
}

interface CommitResponseProxy {
  readonly url: string;
  readonly lostCommitResponses: () => number;
  close(): Promise<void>;
}

function splitProtocolFrames(buffer: Buffer): {
  frames: Buffer[];
  remainder: Buffer;
} {
  const frames: Buffer[] = [];
  let offset = 0;
  while (buffer.length - offset >= 5) {
    const length = buffer.readUInt32BE(offset + 1);
    const frameLength = length + 1;
    if (buffer.length - offset < frameLength) break;
    frames.push(buffer.subarray(offset, offset + frameLength));
    offset += frameLength;
  }
  return { frames, remainder: buffer.subarray(offset) };
}

function isCommitQuery(frame: Buffer): boolean {
  return frame[0] === 0x51 && /^\s*COMMIT\b/i.test(frame.subarray(5).toString('utf8'));
}

async function openCommitResponseProxy(targetUrl: string): Promise<CommitResponseProxy> {
  const target = new URL(targetUrl);
  const sockets = new Set<Socket>();
  let lostCommitResponses = 0;
  const server = createServer((client) => {
    sockets.add(client);
    const upstream = createConnection({
      host: target.hostname,
      port: Number(target.port || 5432),
    });
    sockets.add(upstream);
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    client.on('error', () => {});
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
    upstream.on('error', () => {});

    let clientBuffer: Buffer = Buffer.alloc(0);
    let backendBuffer: Buffer = Buffer.alloc(0);
    let startupForwarded = false;
    let commitPending = false;
    const toUpstream: Buffer[] = [];
    upstream.on('connect', () => {
      for (const packet of toUpstream.splice(0)) upstream.write(packet);
    });
    client.on('data', (chunk: Buffer) => {
      clientBuffer = Buffer.concat([clientBuffer, chunk]);
      if (!startupForwarded) {
        if (clientBuffer.length < 4) return;
        const startupLength = clientBuffer.readUInt32BE(0);
        if (clientBuffer.length < startupLength) return;
        const startup = clientBuffer.subarray(0, startupLength);
        clientBuffer = clientBuffer.subarray(startupLength);
        startupForwarded = true;
        if (upstream.connecting) toUpstream.push(startup);
        else upstream.write(startup);
      }
      const { frames, remainder } = splitProtocolFrames(clientBuffer);
      clientBuffer = remainder;
      for (const frame of frames) {
        if (lostCommitResponses === 0 && isCommitQuery(frame)) commitPending = true;
        if (upstream.connecting) toUpstream.push(frame);
        else upstream.write(frame);
      }
    });
    upstream.on('data', (chunk: Buffer) => {
      backendBuffer = Buffer.concat([backendBuffer, chunk]);
      const { frames, remainder } = splitProtocolFrames(backendBuffer);
      backendBuffer = remainder;
      for (const frame of frames) {
        const type = String.fromCharCode(frame[0] ?? 0);
        if (commitPending && type === 'C') continue;
        if (commitPending && type === 'Z') {
          lostCommitResponses += 1;
          client.destroy();
          upstream.destroy();
          return;
        }
        client.write(frame);
      }
    });
  });

  const listening = Promise.withResolvers<undefined>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', () => {
    listening.resolve(undefined);
  });
  await listening.promise;
  const address = server.address() as AddressInfo;
  const proxiedUrl = new URL(targetUrl);
  proxiedUrl.hostname = '127.0.0.1';
  proxiedUrl.port = String(address.port);

  return {
    url: proxiedUrl.toString(),
    lostCommitResponses: () => lostCommitResponses,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      const closed = Promise.withResolvers<undefined>();
      server.close(() => {
        closed.resolve(undefined);
      });
      await closed.promise;
    },
  };
}

beforeAll(async () => {
  admin = await MikroORM.init(
    createDatabaseOptions(environment.ADMIN_DATABASE_URL, {
      DB_STATEMENT_TIMEOUT_MS: 10000,
      OPERATION_TIMEOUT_MS: 20000,
    }),
  );
  await adminDatabase()
    .em.getConnection()
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
  await applicationDatabase().em.getConnection().execute(`
      create table if not exists runner_sandbox (
        id text primary key,
        value text not null,
        version integer not null default 1
      );
    `);
}, 60000);

afterAll(async () => {
  await application?.close(true);
  if (admin && databaseCreated) {
    await adminDatabase()
      .em.getConnection()
      .execute('drop database ' + databaseName + ' with (force)');
  }
  await admin?.close(true);
});

beforeEach(async () => {
  if (application) {
    await applicationDatabase()
      .em.getConnection()
      .execute('truncate table runner_sandbox;');
  }
});

describe('DatabaseTransactionRunner', () => {
  test('commits a single-attempt transaction durably to PostgreSQL', async () => {
    const runner = new DatabaseTransactionRunner(applicationDatabase());
    const id = crypto.randomUUID();

    const result = await runner.run(async (em, context) => {
      expect(context.attempt).toBe(1);
      expect(context.remainingMs()).toBeGreaterThan(0);
      await em.execute(
        'insert into runner_sandbox (id, value, version) values (?, ?, ?)',
        [id, 'initial-value', 1],
      );
      return { ok: true, id };
    });

    expect(result.ok).toBe(true);

    const rows = await applicationDatabase()
      .em.getConnection()
      .execute<SandboxRow[]>(
        'select id, value, version from runner_sandbox where id = ?',
        [id],
      );
    expect(rows.length).toBe(1);
    expect(rows[0]?.value).toBe('initial-value');
  });

  test('succeeds on third attempt after two guarded misses, rolling back partial writes each time and committing durably', async () => {
    const runner = new DatabaseTransactionRunner(applicationDatabase(), {
      DB_TRANSACTION_MAX_ATTEMPTS: 3,
      DB_RETRY_BASE_DELAY_MS: 5,
      DB_RETRY_MAX_DELAY_MS: 15,
    });

    const rowId = crypto.randomUUID();
    await applicationDatabase()
      .em.getConnection()
      .execute('insert into runner_sandbox (id, value, version) values (?, ?, ?)', [
        rowId,
        'state-v1',
        1,
      ]);

    const attemptsSeen: number[] = [];
    const result = await runner.run(async (em, context) => {
      attemptsSeen.push(context.attempt);

      const current = await em.execute<ValueAndVersionRow[]>(
        'select value, version from runner_sandbox where id = ?',
        [rowId],
      );
      expect(current.length).toBe(1);

      if (context.attempt === 1) {
        expect(current[0]?.value).toBe('state-v1');
        await em.execute('update runner_sandbox set value = ? where id = ?', [
          'mutated-attempt-1',
          rowId,
        ]);
        throw new GuardedUpdateConflictError();
      }

      if (context.attempt === 2) {
        expect(current[0]?.value).toBe('state-v1');
        await em.execute('update runner_sandbox set value = ? where id = ?', [
          'mutated-attempt-2',
          rowId,
        ]);
        throw new GuardedUpdateConflictError();
      }

      expect(current[0]?.value).toBe('state-v1');
      await em.execute('update runner_sandbox set value = ?, version = 2 where id = ?', [
        'durable-v2',
        rowId,
      ]);
      return 'committed-on-3';
    });

    expect(result).toBe('committed-on-3');
    expect(attemptsSeen).toEqual([1, 2, 3]);

    const rows = await applicationDatabase()
      .em.getConnection()
      .execute<ValueAndVersionRow[]>(
        'select value, version from runner_sandbox where id = ?',
        [rowId],
      );
    expect(rows.length).toBe(1);
    expect(rows[0]?.value).toBe('durable-v2');
    expect(rows[0]?.version).toBe(2);
  });

  test('enforces max attempt cap including the first attempt, raising DATABASE_CONCURRENCY_EXHAUSTED', async () => {
    const runner = new DatabaseTransactionRunner(applicationDatabase(), {
      DB_TRANSACTION_MAX_ATTEMPTS: 3,
      DB_RETRY_BASE_DELAY_MS: 5,
      DB_RETRY_MAX_DELAY_MS: 10,
    });

    const attemptsSeen: number[] = [];
    let thrown: unknown;
    try {
      await runner.run((_em, context) => {
        attemptsSeen.push(context.attempt);
        return Promise.reject(new GuardedUpdateConflictError());
      });
    } catch (error) {
      thrown = error;
    }

    expect(attemptsSeen).toEqual([1, 2, 3]);
    const appError = expectApplicationError(thrown, {
      category: 'ExternalConnectionError',
      code: 'DATABASE_CONCURRENCY_EXHAUSTED',
    });
    expect(appError.metadata).toEqual({ attempt: 3 });
  });

  test('respects single attempt limit (max attempts = 1) without retrying', async () => {
    const runner = new DatabaseTransactionRunner(applicationDatabase(), {
      DB_TRANSACTION_MAX_ATTEMPTS: 1,
    });

    const attemptsSeen: number[] = [];
    let thrown: unknown;
    try {
      await runner.run((_em, context) => {
        attemptsSeen.push(context.attempt);
        return Promise.reject(new GuardedUpdateConflictError());
      });
    } catch (error) {
      thrown = error;
    }

    expect(attemptsSeen).toEqual([1]);
    expectApplicationError(thrown, {
      category: 'ExternalConnectionError',
      code: 'DATABASE_CONCURRENCY_EXHAUSTED',
    });
  });

  test('operation deadline abort leaves no committed writes and throws DATABASE_OPERATION_TIMEOUT', async () => {
    const runner = new DatabaseTransactionRunner(applicationDatabase(), {
      OPERATION_TIMEOUT_MS: 200,
      DB_STATEMENT_TIMEOUT_MS: 150,
      DB_LOCK_TIMEOUT_MS: 50,
      DB_POOL_ACQUIRE_TIMEOUT_MS: 200,
      DB_CONNECT_TIMEOUT_MS: 200,
    });

    const testId = crypto.randomUUID();
    let thrown: unknown;
    try {
      await runner.run(async (em, context) => {
        await em.execute(
          'insert into runner_sandbox (id, value, version) values (?, ?, ?)',
          [testId, 'doomed-record', 1],
        );
        // Integration test deliberately exercising real timer behavior against platform clock
        // because DatabaseTransactionRunner deadline is evaluated against monotonic performance.now().
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        });
        expect(context.remainingMs()).toBe(0);
      });
    } catch (error) {
      thrown = error;
    }

    expectApplicationError(thrown, {
      category: 'ExternalConnectionError',
      code: 'DATABASE_OPERATION_TIMEOUT',
    });

    const rows = await applicationDatabase()
      .em.getConnection()
      .execute<IdOnlyRow[]>('select id from runner_sandbox where id = ?', [testId]);
    expect(rows.length).toBe(0);
  });

  test('retries SQLSTATE 40001 (serialization failure) and rolls back uncommitted attempt', async () => {
    const runner = new DatabaseTransactionRunner(applicationDatabase(), {
      DB_TRANSACTION_MAX_ATTEMPTS: 2,
      DB_RETRY_BASE_DELAY_MS: 5,
      DB_RETRY_MAX_DELAY_MS: 10,
    });

    const rowId = crypto.randomUUID();
    const attemptsSeen: number[] = [];

    await runner.run(async (em, context) => {
      attemptsSeen.push(context.attempt);
      if (context.attempt === 1) {
        await em.execute(
          'insert into runner_sandbox (id, value, version) values (?, ?, ?)',
          [rowId, 'uncommitted-40001', 1],
        );
        await em.execute(
          "DO $$ BEGIN RAISE EXCEPTION 'simulated serialization failure' USING ERRCODE = '40001'; END $$;",
        );
      }
      await em.execute(
        'insert into runner_sandbox (id, value, version) values (?, ?, ?)',
        [rowId, 'committed-40001', 2],
      );
    });

    expect(attemptsSeen).toEqual([1, 2]);
    const rows = await applicationDatabase()
      .em.getConnection()
      .execute<ValueAndVersionRow[]>(
        'select value, version from runner_sandbox where id = ?',
        [rowId],
      );
    expect(rows[0]?.value).toBe('committed-40001');
    expect(rows[0]?.version).toBe(2);
  });

  test('retries SQLSTATE 40P01 (deadlock detected) and commits second attempt', async () => {
    const runner = new DatabaseTransactionRunner(applicationDatabase(), {
      DB_TRANSACTION_MAX_ATTEMPTS: 2,
      DB_RETRY_BASE_DELAY_MS: 5,
      DB_RETRY_MAX_DELAY_MS: 10,
    });

    const rowId = crypto.randomUUID();
    const attemptsSeen: number[] = [];

    await runner.run(async (em, context) => {
      attemptsSeen.push(context.attempt);
      if (context.attempt === 1) {
        await em.execute(
          "DO $$ BEGIN RAISE EXCEPTION 'simulated deadlock detected' USING ERRCODE = '40P01'; END $$;",
        );
      }
      await em.execute(
        'insert into runner_sandbox (id, value, version) values (?, ?, ?)',
        [rowId, 'committed-40P01', 1],
      );
    });

    expect(attemptsSeen).toEqual([1, 2]);
    const rows = await applicationDatabase()
      .em.getConnection()
      .execute<ValueOnlyRow[]>('select value from runner_sandbox where id = ?', [rowId]);
    expect(rows[0]?.value).toBe('committed-40P01');
  });

  test('enforces configured lock timeout on real concurrent row lock, rolls back immediately, and classifies as DATABASE_LOCK_TIMEOUT', async () => {
    const rowId = crypto.randomUUID();
    await applicationDatabase()
      .em.getConnection()
      .execute('insert into runner_sandbox (id, value, version) values (?, ?, ?)', [
        rowId,
        'initial-locked-state',
        1,
      ]);

    const knex = applicationDatabase().em.getConnection().getKnex();
    const blockingTrx = await knex.transaction();
    try {
      await blockingTrx('runner_sandbox').where({ id: rowId }).forUpdate();

      const runner = new DatabaseTransactionRunner(applicationDatabase(), {
        OPERATION_TIMEOUT_MS: 3000,
        DB_STATEMENT_TIMEOUT_MS: 500,
        DB_LOCK_TIMEOUT_MS: 50,
        DB_TRANSACTION_MAX_ATTEMPTS: 3,
      });

      const attemptsSeen: number[] = [];
      let thrown: unknown;

      try {
        await runner.run(async (em, context) => {
          attemptsSeen.push(context.attempt);
          await em.execute('update runner_sandbox set value = ? where id = ?', [
            'runner-lock-attempt',
            rowId,
          ]);
        });
      } catch (error) {
        thrown = error;
      }

      expect(attemptsSeen).toEqual([1]);
      expectApplicationError(thrown, {
        category: 'ExternalConnectionError',
        code: 'DATABASE_LOCK_TIMEOUT',
      });
    } finally {
      await blockingTrx.rollback();
    }

    const rows = await applicationDatabase()
      .em.getConnection()
      .execute<ValueOnlyRow[]>('select value from runner_sandbox where id = ?', [rowId]);
    expect(rows[0]?.value).toBe('initial-locked-state');
  });

  test('enforces configured statement timeout on slow query (pg_sleep), rolls back immediately, and classifies as DATABASE_STATEMENT_TIMEOUT', async () => {
    const runner = new DatabaseTransactionRunner(applicationDatabase(), {
      OPERATION_TIMEOUT_MS: 3000,
      DB_STATEMENT_TIMEOUT_MS: 80,
      DB_LOCK_TIMEOUT_MS: 30,
      DB_TRANSACTION_MAX_ATTEMPTS: 3,
    });

    const rowId = crypto.randomUUID();
    const attemptsSeen: number[] = [];
    let thrown: unknown;

    try {
      await runner.run(async (em, context) => {
        attemptsSeen.push(context.attempt);
        await em.execute(
          'insert into runner_sandbox (id, value, version) values (?, ?, ?)',
          [rowId, 'stmt-doomed', 1],
        );
        await em.execute('select pg_sleep(0.3)');
      });
    } catch (error) {
      thrown = error;
    }

    expect(attemptsSeen).toEqual([1]);
    expectApplicationError(thrown, {
      category: 'ExternalConnectionError',
      code: 'DATABASE_STATEMENT_TIMEOUT',
    });

    const rows = await applicationDatabase()
      .em.getConnection()
      .execute<IdOnlyRow[]>('select id from runner_sandbox where id = ?', [rowId]);
    expect(rows.length).toBe(0);
  });

  test('does NOT retry BusinessRuleError, rolls back immediately, and preserves original error', async () => {
    const runner = new DatabaseTransactionRunner(applicationDatabase(), {
      DB_TRANSACTION_MAX_ATTEMPTS: 3,
    });

    const rowId = crypto.randomUUID();
    const attemptsSeen: number[] = [];
    const businessError = new ApplicationError({
      category: 'BusinessRuleError',
      code: 'INSUFFICIENT_FUNDS',
      message: 'The wallet balance is insufficient.',
      publicMessage: 'Insufficient funds.',
    });

    let thrown: unknown;
    try {
      await runner.run(async (em, context) => {
        attemptsSeen.push(context.attempt);
        await em.execute(
          'insert into runner_sandbox (id, value, version) values (?, ?, ?)',
          [rowId, 'biz-uncommitted', 1],
        );
        throw businessError;
      });
    } catch (error) {
      thrown = error;
    }

    expect(attemptsSeen).toEqual([1]);
    expect(thrown).toBe(businessError);

    const rows = await applicationDatabase()
      .em.getConnection()
      .execute<IdOnlyRow[]>('select id from runner_sandbox where id = ?', [rowId]);
    expect(rows.length).toBe(0);
  });

  test('does NOT retry identity unique constraint violations (23505), rolling back immediately', async () => {
    const runner = new DatabaseTransactionRunner(applicationDatabase(), {
      DB_TRANSACTION_MAX_ATTEMPTS: 3,
    });

    const duplicateId = crypto.randomUUID();
    await applicationDatabase()
      .em.getConnection()
      .execute('insert into runner_sandbox (id, value, version) values (?, ?, ?)', [
        duplicateId,
        'original',
        1,
      ]);

    const attemptsSeen: number[] = [];
    let thrown: unknown;
    try {
      await runner.run(async (em, context) => {
        attemptsSeen.push(context.attempt);
        await em.execute(
          'insert into runner_sandbox (id, value, version) values (?, ?, ?)',
          [duplicateId, 'collision', 1],
        );
      });
    } catch (error) {
      thrown = error;
    }

    expect(attemptsSeen).toEqual([1]);
    expectApplicationError(thrown, {
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });
  });

  test('classifies pool acquisition timeout as DATABASE_POOL_EXHAUSTED (HTTP 503) and proves subsequent pool reuse', async () => {
    const poolOrm = await MikroORM.init(
      createDatabaseOptions(databaseUrl('jungle_main', 'main_local'), {
        DB_POOL_MAX: 1,
        DB_POOL_ACQUIRE_TIMEOUT_MS: 80,
        DB_CONNECT_TIMEOUT_MS: 500,
        DB_STATEMENT_TIMEOUT_MS: 500,
        OPERATION_TIMEOUT_MS: 2000,
        DB_LOCK_TIMEOUT_MS: 100,
      }),
    );

    const runner = new DatabaseTransactionRunner(poolOrm);

    let unblockTx1: () => void = () => undefined;
    const blockTx1 = new Promise<void>((resolve) => {
      unblockTx1 = resolve;
    });
    let markTx1Acquired: () => void = () => undefined;
    const tx1Acquired = new Promise<void>((resolve) => {
      markTx1Acquired = resolve;
    });

    const tx1Promise = runner.run(async (em) => {
      markTx1Acquired();
      await em.execute('select 1');
      await blockTx1;
      return 'tx1-completed';
    });

    try {
      await tx1Acquired;

      let tx2Error: unknown;
      try {
        await runner.run(() => Promise.resolve('tx2-unreachable'));
      } catch (error) {
        tx2Error = error;
      }

      const appError = expectApplicationError(tx2Error, {
        category: 'ExternalConnectionError',
        code: 'DATABASE_POOL_EXHAUSTED',
      });
      expect(appError.category).not.toBe('ServerError');
      expect(appError.category).not.toBe('BusinessRuleError');

      unblockTx1();
      const tx1Result = await tx1Promise;
      expect(tx1Result).toBe('tx1-completed');

      const tx3Result = await runner.run(async (em) => {
        const rows = await em.execute<AliveRow[]>('select 1 as alive');
        return rows[0]?.alive;
      });
      expect(tx3Result).toBe(1);
    } finally {
      unblockTx1();
      await tx1Promise.catch(() => undefined);
      await poolOrm.close(true);
    }
  });

  test('classifies a lost COMMIT response after PostgreSQL commits and recovers the proxied pool', async () => {
    const proxy = await openCommitResponseProxy(databaseUrl('jungle_main', 'main_local'));
    const proxiedOrm = await MikroORM.init(
      createDatabaseOptions(proxy.url, {
        DB_STATEMENT_TIMEOUT_MS: 10000,
        OPERATION_TIMEOUT_MS: 20000,
      }),
    );
    const runner = new DatabaseTransactionRunner(proxiedOrm, {
      DB_TRANSACTION_MAX_ATTEMPTS: 3,
      DB_RETRY_BASE_DELAY_MS: 5,
      DB_RETRY_MAX_DELAY_MS: 10,
    });
    const rowId = crypto.randomUUID();
    const attemptsSeen: number[] = [];
    let thrown: unknown;

    try {
      try {
        await runner.run(async (em, context) => {
          attemptsSeen.push(context.attempt);
          await em.execute(
            'insert into runner_sandbox (id, value, version) values (?, ?, ?)',
            [rowId, 'committed-response-lost', 1],
          );
        });
      } catch (error) {
        thrown = error;
      }

      expect(attemptsSeen).toEqual([1]);
      expect(proxy.lostCommitResponses()).toBe(1);
      expectApplicationError(thrown, {
        category: 'ExternalConnectionError',
        code: 'DATABASE_COMMIT_OUTCOME_UNKNOWN',
      });

      const committed = await applicationDatabase()
        .em.getConnection()
        .execute<SandboxRow[]>(
          'select id, value, version from runner_sandbox where id = ?',
          [rowId],
        );
      expect(committed).toEqual([
        { id: rowId, value: 'committed-response-lost', version: 1 },
      ]);

      const recovered = await runner.run(async (em) => {
        const rows = await em.execute<AliveRow[]>('select 1 as alive');
        return rows[0]?.alive;
      });
      expect(recovered).toBe(1);
    } finally {
      await proxiedOrm.close(true);
      await proxy.close();
    }
  });

  test('distinguishes unknown commit outcome when connection is terminated during COMMIT without blind retry', async () => {
    const fixtureSql = applicationDatabase().em.getConnection();
    await fixtureSql.execute(`
      CREATE OR REPLACE FUNCTION runner_terminate_commit() RETURNS trigger AS $$
      BEGIN
        IF NEW.value = 'terminate-on-commit' THEN
          PERFORM pg_terminate_backend(pg_backend_pid());
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE CONSTRAINT TRIGGER trigger_runner_terminate_commit
      AFTER INSERT ON runner_sandbox
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION runner_terminate_commit();
    `);

    try {
      const runner = new DatabaseTransactionRunner(applicationDatabase(), {
        DB_TRANSACTION_MAX_ATTEMPTS: 3,
      });

      const attemptsSeen: number[] = [];
      let thrown: unknown;

      try {
        await runner.run(async (em, context) => {
          attemptsSeen.push(context.attempt);
          await em.execute(
            'insert into runner_sandbox (id, value, version) values (?, ?, ?)',
            [crypto.randomUUID(), 'terminate-on-commit', 1],
          );
        });
      } catch (error) {
        thrown = error;
      }

      expect(attemptsSeen).toEqual([1]);
      expectApplicationError(thrown, {
        category: 'ExternalConnectionError',
        code: 'DATABASE_COMMIT_OUTCOME_UNKNOWN',
      });

      const recoveryResult = await runner.run(async (em) => {
        const rows = await em.execute<AliveRow[]>('select 1 as alive');
        return rows[0]?.alive;
      });
      expect(recoveryResult).toBe(1);
    } finally {
      await fixtureSql.execute(`
        DROP TRIGGER IF EXISTS trigger_runner_terminate_commit ON runner_sandbox;
        DROP FUNCTION IF EXISTS runner_terminate_commit();
      `);
    }
  });
});
