import { TimeoutError } from 'tarn';
import { ApplicationError } from '../../shared/errors.js';

interface DatabaseMetadata {
  readonly sqlState: string;
  readonly constraint?: string;
}

const connectionCodes: Readonly<Record<string, true>> = {
  ECONNREFUSED: true,
  ECONNRESET: true,
  ETIMEDOUT: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
  ENOTFOUND: true,
  EAI_AGAIN: true,
};

const uniqueConflicts: Readonly<Record<string, { code: string; message: string }>> = {
  uq_wallets_player_currency: {
    code: 'WALLET_ALREADY_EXISTS',
    message: 'A wallet already exists for this player and currency.',
  },
  uq_wager_transactions_provider_key: {
    code: 'WAGER_IDEMPOTENCY_KEY_ALREADY_EXISTS',
    message: 'The provider idempotency key already belongs to a transaction.',
  },
  uq_wager_transactions_provider_external: {
    code: 'WAGER_EXTERNAL_ID_ALREADY_EXISTS',
    message: 'The provider external identifier already belongs to a transaction.',
  },
  uq_wager_transactions_processed_reference_id: {
    code: 'WAGER_REFERENCE_ALREADY_REVERSED',
    message: 'The reference transaction already has a processed reversal.',
  },
};
const transientCodes: Readonly<Record<string, string>> = {
  '40001': 'DATABASE_CONCURRENCY_EXHAUSTED',
  '40P01': 'DATABASE_CONCURRENCY_EXHAUSTED',
  '55P03': 'DATABASE_LOCK_TIMEOUT',
  '57014': 'DATABASE_STATEMENT_TIMEOUT',
  '53300': 'DATABASE_POOL_EXHAUSTED',
};
export class GuardedUpdateConflictError extends Error {
  constructor() {
    super('The guarded update did not match the previously read state.');
    this.name = 'GuardedUpdateConflictError';
  }
}

export function databaseUnavailable(
  code: string,
  cause?: unknown,
  metadata?: object,
): ApplicationError {
  return new ApplicationError(
    {
      category: 'ExternalConnectionError',
      code,
      message: `Database execution failed: ${code}.`,
      publicMessage: 'The database operation could not be completed. Try again later.',
    },
    metadata,
    cause,
  );
}

/** Preserves application errors and maps database failures to stable public categories. */
export function translateDatabaseError(cause: unknown): ApplicationError {
  if (ApplicationError.is(cause)) {
    return cause;
  }

  const details = findDatabaseDetails(cause);
  const transient = transientDatabaseFailure(details, cause);
  if (transient !== undefined) return transient;

  const conflict = knownUniqueConflict(details, cause);
  if (conflict !== undefined) {
    return conflict;
  }

  if (details?.sqlState.startsWith('23')) {
    return new ApplicationError(
      {
        category: 'DatabaseConstraintError',
        code: 'DATABASE_CONSTRAINT_VIOLATION',
        message:
          'The database rejected an operation because an integrity constraint failed.',
        publicMessage: 'The server cannot complete this database operation.',
      },
      details,
      cause,
    );
  }

  if (isDatabaseConnection(details?.sqlState)) {
    return new ApplicationError(
      {
        category: 'ExternalConnectionError',
        code: 'DATABASE_CONNECTION_FAILED',
        message: 'The application cannot establish or maintain the database connection.',
        publicMessage: 'The database is unavailable.',
      },
      details,
      cause,
    );
  }

  return new ApplicationError(
    {
      category: 'DatabaseOperationError',
      code: 'DATABASE_OPERATION_FAILED',
      message:
        'The database operation failed without a recognized integrity or connection condition.',
      publicMessage: 'The server cannot complete this database operation.',
    },
    details,
    cause,
  );
}

function transientDatabaseFailure(
  details: DatabaseMetadata | undefined,
  cause: unknown,
): ApplicationError | undefined {
  if (cause instanceof GuardedUpdateConflictError) {
    return databaseUnavailable('DATABASE_CONCURRENCY_EXHAUSTED', cause);
  }

  const transient = details === undefined ? undefined : transientCodes[details.sqlState];
  if (transient !== undefined) {
    return databaseUnavailable(transient, cause, details);
  }

  if (
    cause instanceof TimeoutError ||
    (cause instanceof Error && cause.name === 'KnexTimeoutError')
  ) {
    return databaseUnavailable('DATABASE_POOL_EXHAUSTED', cause);
  }
  return undefined;
}

function knownUniqueConflict(
  details: DatabaseMetadata | undefined,
  cause: unknown,
): ApplicationError | undefined {
  if (
    details?.sqlState !== '23505' ||
    details.constraint === undefined ||
    !Object.hasOwn(uniqueConflicts, details.constraint)
  ) {
    return undefined;
  }
  const conflict = uniqueConflicts[details.constraint];
  if (conflict === undefined) {
    return undefined;
  }
  return new ApplicationError(
    {
      category: 'ConflictError',
      code: conflict.code,
      message: conflict.message,
      publicMessage: conflict.message,
    },
    details,
    cause,
  );
}

function isDatabaseConnection(sqlState: string | undefined): boolean {
  return (
    sqlState !== undefined &&
    (sqlState.startsWith('08') ||
      ['57P01', '57P02', '57P03'].includes(sqlState) ||
      Object.hasOwn(connectionCodes, sqlState))
  );
}

function readDatabaseDetails(
  fields: Record<string, unknown>,
): DatabaseMetadata | undefined {
  const sqlState = fields.sqlState ?? fields.code;
  if (
    typeof sqlState !== 'string' ||
    (!/^[0-9A-Z]{5}$/.test(sqlState) && !Object.hasOwn(connectionCodes, sqlState))
  ) {
    return undefined;
  }
  return typeof fields.constraint === 'string'
    ? { sqlState, constraint: fields.constraint }
    : { sqlState };
}

/** Searches wrapped causes without cycles, preferring details that identify a constraint. */
export function findDatabaseDetails(cause: unknown): DatabaseMetadata | undefined {
  const queue: unknown[] = [cause];
  const visited = new Set<object>();
  let fallback: DatabaseMetadata | undefined;

  for (let index = 0; index < queue.length; index += 1) {
    const value = queue[index];
    if (typeof value !== 'object' || value === null || visited.has(value)) {
      continue;
    }

    visited.add(value);
    const fields = value as Record<string, unknown>;
    const details = readDatabaseDetails(fields);
    if (details !== undefined) {
      if (details.constraint !== undefined) {
        return details;
      }
      fallback ??= details;
    }

    queue.push(fields.cause, fields.nativeError, fields.originalError);
  }

  return fallback;
}
