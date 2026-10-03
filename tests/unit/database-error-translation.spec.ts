import { describe, expect, it } from 'bun:test';
import { TimeoutError as TarnTimeoutError } from 'tarn';
import {
  GuardedUpdateConflictError,
  translateDatabaseError,
} from '../../src/core/database/database.errors.js';
import { ApplicationError } from '../../src/shared/errors.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

describe('Database Error Translation', () => {
  it('translates known UNIQUE conflict uq_wallets_player_currency to ConflictError', () => {
    const rawError = {
      sqlState: '23505',
      constraint: 'uq_wallets_player_currency',
      message:
        'duplicate key value violates unique constraint uq_wallets_player_currency',
    };

    const translated = expectApplicationError(translateDatabaseError(rawError), {
      category: 'ConflictError',
      code: 'WALLET_ALREADY_EXISTS',
    });
    expect(translated.cause).toBe(rawError);
    expect(translated.metadata).toEqual({
      sqlState: '23505',
      constraint: 'uq_wallets_player_currency',
    });
  });

  it('translates known provider key, external id, and reversal UNIQUE conflicts to ConflictError', () => {
    const providerKeyConflict = {
      sqlState: '23505',
      constraint: 'uq_wager_transactions_provider_key',
    };
    expectApplicationError(translateDatabaseError(providerKeyConflict), {
      category: 'ConflictError',
      code: 'WAGER_IDEMPOTENCY_KEY_ALREADY_EXISTS',
    });

    const providerExtConflict = {
      sqlState: '23505',
      constraint: 'uq_wager_transactions_provider_external',
    };
    expectApplicationError(translateDatabaseError(providerExtConflict), {
      category: 'ConflictError',
      code: 'WAGER_EXTERNAL_ID_ALREADY_EXISTS',
    });

    const refIdConflict = {
      sqlState: '23505',
      constraint: 'uq_wager_transactions_processed_reference_id',
    };
    expectApplicationError(translateDatabaseError(refIdConflict), {
      category: 'ConflictError',
      code: 'WAGER_REFERENCE_ALREADY_REVERSED',
    });
  });

  it('keeps unknown 23505 unique constraint violation as DatabaseConstraintError', () => {
    const unknownUnique = {
      sqlState: '23505',
      constraint: 'uq_unknown_table_column',
    };

    const translated = expectApplicationError(translateDatabaseError(unknownUnique), {
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });
    expect(translated.metadata).toEqual({
      sqlState: '23505',
      constraint: 'uq_unknown_table_column',
    });
  });

  it('keeps unknown 23505 with constraint set to inherited property as DatabaseConstraintError', () => {
    const prototypeAttack1 = {
      sqlState: '23505',
      constraint: 'constructor',
    };
    expectApplicationError(translateDatabaseError(prototypeAttack1), {
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });

    const prototypeAttack2 = {
      sqlState: '23505',
      constraint: 'toString',
    };
    expectApplicationError(translateDatabaseError(prototypeAttack2), {
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });
  });

  it('translates trigger integrity failure (ERRCODE 23514) to DatabaseConstraintError', () => {
    const triggerConstraints = [
      'wallet_initial_version',
      'wallet_balance_version',
      'wallet_ledger_correspondence',
      'ledger_immutable',
      'transaction_terminal_immutable',
      'transaction_payload_immutable',
      'ledger_transaction_processed',
      'transaction_reference_resolved',
    ];

    for (const constraint of triggerConstraints) {
      const error = {
        sqlState: '23514',
        constraint,
      };

      const translated = expectApplicationError(translateDatabaseError(error), {
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
      });
      expect(translated.metadata).toEqual({
        sqlState: '23514',
        constraint,
      });
    }
  });

  it('translates check constraint, not null, and foreign key violations to DatabaseConstraintError', () => {
    const notNullError = { sqlState: '23502', column: 'wallet_id' };
    const fkError = { sqlState: '23503', constraint: 'fk_wager_wallet' };

    expectApplicationError(translateDatabaseError(notNullError), {
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });
    expectApplicationError(translateDatabaseError(fkError), {
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });
  });

  it('translates connection loss and shutdown codes to ExternalConnectionError', () => {
    const connectionDrop = { sqlState: '08006' };
    const adminShutdown = { sqlState: '57P01' };
    const crashShutdown = { sqlState: '57P02' };
    const cannotConnectNow = { sqlState: '57P03' };
    const networkRefused = { code: 'ECONNREFUSED' };
    const networkTimeout = { code: 'ETIMEDOUT' };

    for (const error of [
      connectionDrop,
      adminShutdown,
      crashShutdown,
      cannotConnectNow,
      networkRefused,
      networkTimeout,
    ]) {
      expectApplicationError(translateDatabaseError(error), {
        category: 'ExternalConnectionError',
        code: 'DATABASE_CONNECTION_FAILED',
      });
    }
  });

  it('translates GuardedUpdateConflictError, 40001, and 40P01 to ExternalConnectionError with DATABASE_CONCURRENCY_EXHAUSTED', () => {
    const guardError = new GuardedUpdateConflictError();
    const translatedGuard = expectApplicationError(translateDatabaseError(guardError), {
      category: 'ExternalConnectionError',
      code: 'DATABASE_CONCURRENCY_EXHAUSTED',
    });
    expect(translatedGuard.cause).toBe(guardError);
    const guardJson = translatedGuard.toJSON();
    expect(guardJson.category).toBe('ExternalConnectionError');
    expect(guardJson.code).toBe('DATABASE_CONCURRENCY_EXHAUSTED');
    expect(typeof guardJson.message).toBe('string');
    expect(guardJson.message).not.toContain('GuardedUpdateConflictError');
    expect((guardJson as Record<string, unknown>)['metadata']).toBeUndefined();
    expect((guardJson as Record<string, unknown>)['cause']).toBeUndefined();
    expect((guardJson as Record<string, unknown>)['stack']).toBeUndefined();

    for (const sqlState of ['40001', '40P01']) {
      const raw = { sqlState, message: 'secret internal database query text' };
      const translated = expectApplicationError(translateDatabaseError(raw), {
        category: 'ExternalConnectionError',
        code: 'DATABASE_CONCURRENCY_EXHAUSTED',
      });
      const json = translated.toJSON();
      expect(json.category).toBe('ExternalConnectionError');
      expect(json.code).toBe('DATABASE_CONCURRENCY_EXHAUSTED');
      expect(typeof json.message).toBe('string');
      expect(json.message).not.toContain('secret internal database query text');
      expect((json as Record<string, unknown>)['metadata']).toBeUndefined();
      expect((json as Record<string, unknown>)['cause']).toBeUndefined();
      expect((json as Record<string, unknown>)['stack']).toBeUndefined();
    }
  });

  it('translates lock timeout (55P03) to ExternalConnectionError with DATABASE_LOCK_TIMEOUT', () => {
    const lockTimeout = {
      sqlState: '55P03',
      message: 'SELECT FOR UPDATE locked by another transaction',
    };
    const translated = expectApplicationError(translateDatabaseError(lockTimeout), {
      category: 'ExternalConnectionError',
      code: 'DATABASE_LOCK_TIMEOUT',
    });
    const json = translated.toJSON();
    expect(json.category).toBe('ExternalConnectionError');
    expect(json.code).toBe('DATABASE_LOCK_TIMEOUT');
    expect(typeof json.message).toBe('string');
    expect(json.message).not.toContain('SELECT FOR UPDATE');
    expect((json as Record<string, unknown>)['metadata']).toBeUndefined();
    expect((json as Record<string, unknown>)['cause']).toBeUndefined();
    expect((json as Record<string, unknown>)['stack']).toBeUndefined();
  });

  it('translates statement timeout (57014) to ExternalConnectionError with DATABASE_STATEMENT_TIMEOUT', () => {
    const statementTimeout = {
      sqlState: '57014',
      message: 'canceling statement due to statement timeout',
    };
    const translated = expectApplicationError(translateDatabaseError(statementTimeout), {
      category: 'ExternalConnectionError',
      code: 'DATABASE_STATEMENT_TIMEOUT',
    });
    const json = translated.toJSON();
    expect(json.category).toBe('ExternalConnectionError');
    expect(json.code).toBe('DATABASE_STATEMENT_TIMEOUT');
    expect(typeof json.message).toBe('string');
    expect((json as Record<string, unknown>)['metadata']).toBeUndefined();
    expect((json as Record<string, unknown>)['cause']).toBeUndefined();
    expect((json as Record<string, unknown>)['stack']).toBeUndefined();
  });

  it('translates pool saturation (53300) and Knex connection timeouts to ExternalConnectionError with DATABASE_POOL_EXHAUSTED', () => {
    const poolSql = { sqlState: '53300' };
    expectApplicationError(translateDatabaseError(poolSql), {
      category: 'ExternalConnectionError',
      code: 'DATABASE_POOL_EXHAUSTED',
    });

    const knexTimeout = new Error(
      'Knex: Timeout acquiring a connection. The pool is probably full.',
    );
    knexTimeout.name = 'KnexTimeoutError';
    const translatedKnex = expectApplicationError(translateDatabaseError(knexTimeout), {
      category: 'ExternalConnectionError',
      code: 'DATABASE_POOL_EXHAUSTED',
    });
    expect(translatedKnex.cause).toBe(knexTimeout);

    const tarnTimeout = new TarnTimeoutError('ResourceRequest timed out');
    const translatedTarn = expectApplicationError(translateDatabaseError(tarnTimeout), {
      category: 'ExternalConnectionError',
      code: 'DATABASE_POOL_EXHAUSTED',
    });
    expect(translatedTarn.cause).toBe(tarnTimeout);
  });

  it('ensures concurrency exhaustion and timeouts map to ExternalConnectionError and never BusinessRuleError (HTTP 422)', () => {
    const conditions = [
      new GuardedUpdateConflictError(),
      { sqlState: '40001' },
      { sqlState: '40P01' },
      { sqlState: '55P03' },
      { sqlState: '57014' },
      { sqlState: '53300' },
    ];

    for (const condition of conditions) {
      const translated = translateDatabaseError(condition);
      expect(translated.category).toBe('ExternalConnectionError');
      expect(translated.category).not.toBe('BusinessRuleError');
      const json = translated.toJSON();
      expect(json.category).toBe('ExternalConnectionError');
      expect(typeof json.message).toBe('string');
      expect((json as Record<string, unknown>)['metadata']).toBeUndefined();
      expect((json as Record<string, unknown>)['cause']).toBeUndefined();
      expect((json as Record<string, unknown>)['stack']).toBeUndefined();
    }
  });

  it('translates unclassified database failures to DatabaseOperationError', () => {
    const syntaxError = { sqlState: '42601', message: 'syntax error at or near SELECT' };
    expectApplicationError(translateDatabaseError(syntaxError), {
      category: 'DatabaseOperationError',
      code: 'DATABASE_OPERATION_FAILED',
    });
  });

  it('ignores misleading exception text when resolving error category', () => {
    const misleadingBusinessError = {
      message: 'Connection dropped unexpectedly by database server',
      sqlState: '23505',
      constraint: 'uq_wallets_player_currency',
    };

    expectApplicationError(translateDatabaseError(misleadingBusinessError), {
      category: 'ConflictError',
      code: 'WALLET_ALREADY_EXISTS',
    });

    const misleadingSyntaxError = {
      message:
        'duplicate key value violates unique constraint uq_wallets_player_currency',
      sqlState: '42P01',
    };

    expectApplicationError(translateDatabaseError(misleadingSyntaxError), {
      category: 'DatabaseOperationError',
      code: 'DATABASE_OPERATION_FAILED',
    });
  });

  it('unwraps MikroORM DriverException and nested cause chains', () => {
    const mikroDriverException = {
      name: 'DriverException',
      message: 'Error executing query',
      nativeError: {
        code: '23505',
        constraint: 'uq_wager_transactions_provider_key',
      },
    };

    const translatedDriver = expectApplicationError(
      translateDatabaseError(mikroDriverException),
      {
        category: 'ConflictError',
        code: 'WAGER_IDEMPOTENCY_KEY_ALREADY_EXISTS',
      },
    );
    expect(translatedDriver.cause).toBe(mikroDriverException);

    const nestedError = {
      message: 'Top level repository failure',
      cause: {
        message: 'Mid level query execution failure',
        cause: {
          sqlState: '23514',
          constraint: 'ledger_immutable',
        },
      },
    };

    const translatedNested = expectApplicationError(translateDatabaseError(nestedError), {
      category: 'DatabaseConstraintError',
      code: 'DATABASE_CONSTRAINT_VIOLATION',
    });
    expect(translatedNested.metadata).toEqual({
      sqlState: '23514',
      constraint: 'ledger_immutable',
    });
  });

  it('passes through existing ApplicationError without double translation', () => {
    const existing = new ApplicationError({
      category: 'BusinessRuleError',
      code: 'ALREADY_TRANSLATED',
      message: 'Custom translated error',
      publicMessage: 'Already translated',
    });

    const result = translateDatabaseError(existing);
    expect(result).toBe(existing);
  });
});
