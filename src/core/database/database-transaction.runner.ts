import { setTimeout as delay } from 'node:timers/promises';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { Knex } from 'knex';
import { TimeoutError } from 'tarn';
import type { Pool } from 'tarn';
import { ApplicationError } from '../../shared/errors.js';
import {
  databaseUnavailable,
  findDatabaseDetails,
  GuardedUpdateConflictError,
  translateDatabaseError,
} from './database.errors.js';
import { getDatabaseSettings, type DatabaseSettings } from './database.settings.js';
import { FinancialTelemetry } from '../../shared/financial.telemetry.js';

const conflictCodes: Readonly<Record<string, string | undefined>> = {
  '40001': 'serialization',
  '40P01': 'deadlock',
  '55P03': 'lock_timeout',
};

export interface TransactionAttemptContext {
  readonly attempt: number;
  /** Monotonic performance.now() deadline, not a wall-clock timestamp. */
  readonly deadline: number;
  remainingMs(): number;
}

type DatabaseQuery = string | { sql?: string; bindings?: readonly unknown[] };

/** Knex exposes these internals as any; this is the installed client API we use. */
interface DatabaseClient {
  pool?: Pool<object>;
  query(connection: object, query: DatabaseQuery): Promise<unknown>;
  releaseConnection(connection: object): Promise<void>;
}

interface AttemptState {
  transaction?: Knex.Transaction;
  committing: boolean;
  commitSent: boolean;
  rollbackFailure?: Error;
}

type TransactionCallback<T> = (
  entityManager: EntityManager,
  context: TransactionAttemptContext,
) => Promise<T>;

/**
 * Runs database transactions with a shared deadline and retries confirmed conflicts.
 * Callbacks must await all SQL, use the supplied EM, and not commit or detach work.
 */
export class DatabaseTransactionRunner {
  private readonly settings: DatabaseSettings;
  private readonly active = new Set<Promise<unknown>>();
  private readonly connections = new Set<object>();
  private cancelled = false;

  constructor(
    private readonly mikroOrm: MikroORM,
    settings?: Partial<DatabaseSettings>,
    private readonly financialTelemetry = new FinancialTelemetry(),
  ) {
    this.settings = getDatabaseSettings(settings ?? {});
  }

  /** Tracks one operation until its transaction commits or its failure is confirmed. */
  async run<T>(callback: TransactionCallback<T>): Promise<T> {
    if (this.cancelled) throw databaseUnavailable('DATABASE_SHUTTING_DOWN');

    const work = this.executeRun(callback);
    this.active.add(work);

    try {
      return await work;
    } finally {
      this.active.delete(work);
    }
  }

  /** Waits for admitted operations before the database connection pool closes. */
  async drain(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled(this.active);
  }

  /** Stops new operations and disconnects active connections when shutdown expires. */
  cancelActive(): void {
    this.cancelled = true;

    for (const connection of this.connections) {
      const client = connection as { connection?: { stream?: { destroy(): void } } };
      // Disconnecting does not establish the outcome of an in-flight COMMIT.
      client.connection?.stream?.destroy();
    }
  }

  /** Retries safe conflicts within one deadline, including acquisition and backoff. */
  private async executeRun<T>(callback: TransactionCallback<T>): Promise<T> {
    const deadline = performance.now() + this.settings.OPERATION_TIMEOUT_MS;
    const remainingMs = () => Math.max(0, Math.floor(deadline - performance.now()));
    const knex = this.mikroOrm.em.getConnection().getKnex();

    for (
      let attempt = 1;
      attempt <= this.settings.DB_TRANSACTION_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const context = { attempt, deadline, remainingMs };
      this.assertTime(context);
      try {
        return await this.runAttempt(knex, callback, context);
      } catch (cause) {
        const state = findDatabaseDetails(cause)?.sqlState;
        const conflict =
          cause instanceof GuardedUpdateConflictError
            ? 'guarded_update'
            : conflictCodes[state ?? ''];

        if (conflict !== undefined) {
          this.financialTelemetry.increment('financial_conflict_total', conflict);
          this.financialTelemetry.log('database_conflict', { code: conflict });
        }

        if (!this.isRetryable(cause)) throw cause;
        this.assertTime(context);
        if (attempt === this.settings.DB_TRANSACTION_MAX_ATTEMPTS) {
          throw databaseUnavailable('DATABASE_CONCURRENCY_EXHAUSTED', cause, { attempt });
        }

        this.financialTelemetry.increment('financial_retry_total', 'database');
        this.financialTelemetry.log('database_retry', { code: conflict });
        await this.backoff(context, cause);
      }
    }

    throw databaseUnavailable('DATABASE_CONCURRENCY_EXHAUSTED');
  }

  /** Rejects work after shutdown cancellation or exhaustion of the operation deadline. */
  private assertTime(context: TransactionAttemptContext): void {
    if (this.cancelled) throw databaseUnavailable('DATABASE_SHUTTING_DOWN');
    if (context.remainingMs() < 1)
      throw databaseUnavailable('DATABASE_OPERATION_TIMEOUT');
  }

  /** Limits retries to guarded-update conflicts, serialization failures, and deadlocks. */
  private isRetryable(cause: unknown): boolean {
    if (cause instanceof GuardedUpdateConflictError) return true;
    if (ApplicationError.is(cause)) return false;

    const sqlState = findDatabaseDetails(cause)?.sqlState;
    return sqlState === '40001' || sqlState === '40P01';
  }

  /** Exposes the installed Knex client's connection and query operations. */
  private client(knex: Knex): DatabaseClient {
    // The installed Knex client implements this API but declares it untyped.
    const client = knex.client as unknown as DatabaseClient;
    return client;
  }

  /** Bounds pool acquisition by both the pool timeout and the operation deadline. */
  private async acquire(knex: Knex, context: TransactionAttemptContext): Promise<object> {
    const pool = this.client(knex).pool;
    if (pool === undefined) throw databaseUnavailable('DATABASE_CONNECTION_FAILED');

    const acquisition = pool.acquire();
    const acquisitionState = { expired: false };
    const timer = setTimeout(
      () => {
        acquisitionState.expired = true;
        acquisition.abort();
      },
      Math.min(context.remainingMs(), this.settings.DB_POOL_ACQUIRE_TIMEOUT_MS),
    );

    try {
      return await acquisition.promise;
    } catch (cause) {
      this.assertTime(context);

      if (acquisitionState.expired || cause instanceof TimeoutError) {
        throw databaseUnavailable('DATABASE_POOL_EXHAUSTED', cause);
      }

      throw translateDatabaseError(cause);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Pins one connection through callback execution, commit, and failure cleanup. */
  private async runAttempt<T>(
    knex: Knex,
    callback: TransactionCallback<T>,
    context: TransactionAttemptContext,
  ): Promise<T> {
    const connection = await this.acquire(knex, context);
    this.connections.add(connection);
    const state: AttemptState = { committing: false, commitSent: false };

    try {
      this.assertTime(context);
      const transaction = await knex.transaction({
        connection,
        isolationLevel: 'read committed',
      });
      state.transaction = transaction;
      this.installQueryBoundary(knex, transaction, context, state);

      const entityManager = this.mikroOrm.em.fork({ clear: true });
      entityManager.setTransactionContext(transaction);
      const result = await callback(entityManager, context);

      this.assertTime(context);
      await entityManager.commit();
      return result;
    } catch (cause) {
      return await this.failAttempt(knex, connection, context, state, cause);
    } finally {
      await this.client(knex).releaseConnection(connection);
      this.connections.delete(connection);
    }
  }

  /** Applies the remaining deadline to each SQL statement without patching the pool. */
  private installQueryBoundary(
    knex: Knex,
    transaction: Knex.Transaction,
    context: TransactionAttemptContext,
    state: AttemptState,
  ): void {
    const transactionClient = this.client(transaction);
    const originalQuery = transactionClient.query.bind(transactionClient);
    const baseClient = this.client(knex);
    const baseQuery = baseClient.query.bind(baseClient);

    // The transaction client is per attempt; never patch the shared pool client.
    transactionClient.query = async (connection: object, query: DatabaseQuery) => {
      const sql = typeof query === 'string' ? query : (query.sql ?? '');
      if (/^ROLLBACK\b/i.test(sql)) {
        try {
          return await originalQuery(connection, query);
        } catch (cause) {
          state.rollbackFailure =
            cause instanceof Error
              ? cause
              : new Error('The database rollback failed.', { cause });
          throw cause;
        }
      }

      const isCommit = /^COMMIT\b/i.test(sql);
      if (isCommit) state.committing = true;
      this.assertTime(context);
      // Knex marks COMMIT completed as soon as this async boundary returns.
      // Use its base client on the pinned connection, not the completed trx guard.
      const execute = isCommit ? baseQuery : originalQuery;

      const statement = Math.max(
        1,
        Math.min(this.settings.DB_STATEMENT_TIMEOUT_MS, context.remainingMs()),
      );
      const lock = Math.min(this.settings.DB_LOCK_TIMEOUT_MS, Math.max(1, statement - 1));
      await execute(connection, {
        sql: "select set_config('statement_timeout', ?, true), set_config('lock_timeout', ?, true)",
        bindings: [String(statement), String(lock)],
      });

      this.assertTime(context);
      if (isCommit) state.commitSent = true;
      return execute(connection, query);
    };
  }

  /** Confirms rollback before errors can reach the retry loop; rejects uncertain commits. */
  private async failAttempt(
    knex: Knex,
    connection: object,
    context: TransactionAttemptContext,
    state: AttemptState,
    cause: unknown,
  ): Promise<never> {
    if (state.committing && state.commitSent) {
      this.rejectUnknownCommit(connection, context, cause);
    }

    if (state.transaction === undefined) {
      // A failed BEGIN may have reached PostgreSQL; never reuse that connection.
      Object.assign(connection, { __knex__disposed: true });
      throw translateDatabaseError(cause);
    }

    await this.rollback(knex, connection, context, state);
    if (findDatabaseDetails(cause)?.sqlState === '57014') this.assertTime(context);
    // Raw retryable errors escape only after rollback has been confirmed.
    if (this.isRetryable(cause)) throw cause;

    throw translateDatabaseError(cause);
  }

  /** Discards a connection when a failed COMMIT response cannot prove the outcome. */
  private rejectUnknownCommit(
    connection: object,
    context: TransactionAttemptContext,
    cause: unknown,
  ): void {
    const sqlState = findDatabaseDetails(cause)?.sqlState;
    const unknown =
      sqlState === undefined ||
      sqlState.startsWith('08') ||
      sqlState.startsWith('57') ||
      !/^[0-9A-Z]{5}$/.test(sqlState);

    if (unknown) {
      // Losing the COMMIT response (including cancellation) cannot prove rollback.
      Object.assign(connection, { __knex__disposed: true });
      throw databaseUnavailable('DATABASE_COMMIT_OUTCOME_UNKNOWN', cause, {
        attempt: context.attempt,
      });
    }
  }

  /** Confirms rollback on the pinned connection or discards it if cleanup fails. */
  private async rollback(
    knex: Knex,
    connection: object,
    context: TransactionAttemptContext,
    state: AttemptState,
  ): Promise<void> {
    try {
      if (state.committing) {
        // Knex marks failed COMMIT completed; use the same connection directly.
        await this.client(knex).query(connection, 'ROLLBACK');
      } else {
        await state.transaction?.rollback();
      }

      if (state.rollbackFailure !== undefined) throw state.rollbackFailure;
    } catch (cause) {
      Object.assign(connection, { __knex__disposed: true });
      throw databaseUnavailable('DATABASE_ROLLBACK_FAILED', cause, {
        attempt: context.attempt,
      });
    }
  }

  /** Uses capped random backoff without allowing the wait to exhaust the deadline. */
  private async backoff(
    context: TransactionAttemptContext,
    cause: unknown,
  ): Promise<void> {
    const cap = Math.min(
      this.settings.DB_RETRY_MAX_DELAY_MS,
      this.settings.DB_RETRY_BASE_DELAY_MS * 2 ** (context.attempt - 1),
    );

    const delayMs = Math.floor(Math.random() * (cap + 1));
    if (delayMs >= context.remainingMs())
      throw databaseUnavailable('DATABASE_OPERATION_TIMEOUT', cause);

    await delay(delayMs);
  }
}
