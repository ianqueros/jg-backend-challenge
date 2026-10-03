import {
  FlushMode,
  type EntityDictionary,
  type EntityName,
  type FilterQuery,
  type FindOptions,
  type RequiredEntityData,
} from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { Knex } from 'knex';

/** Keeps persistence records detached from financial decisions and native updates. */
export class TransactionRecordStore {
  constructor(private readonly entityManager: EntityManager) {}

  /** Executes explicit projections on the caller's active transaction. */
  async rows<T extends object>(sql: string, parameters: unknown[] = []): Promise<T[]> {
    const transaction = this.activeTransaction();
    return this.entityManager
      .getConnection()
      .execute<T[]>(sql, parameters, 'all', transaction);
  }

  /** Uses metadata to hydrate retained SQL returns without retaining managed state. */
  async records<T extends object>(
    entity: EntityName<T>,
    sql: string,
    parameters: unknown[] = [],
  ): Promise<T[]> {
    const rows = await this.rows<EntityDictionary<T>>(sql, parameters);
    return this.mapRecords(entity, rows);
  }

  /** Hydrates full records from SQL metadata and removes write tracking. */
  mapRecords<T extends object>(entity: EntityName<T>, rows: EntityDictionary<T>[]): T[] {
    const fork = this.entityManager.fork({ clear: true, keepTransactionContext: true });
    try {
      return rows.map((row) => fork.map(entity, row));
    } finally {
      fork.clear();
    }
  }

  /** A separate identity map forces each decision to use current database state. */
  async find<T extends object>(
    entity: EntityName<T>,
    where: FilterQuery<T>,
    options: Pick<FindOptions<T>, 'orderBy' | 'limit' | 'lockMode'> = {},
  ): Promise<T[]> {
    this.activeTransaction();
    return this.entityManager.find<T>(entity, where, {
      ...options,
      disableIdentityMap: true,
      flushMode: FlushMode.COMMIT,
    });
  }

  /** Flushes new records before dependent SQL, then removes write tracking. */
  async insert<T extends object>(
    entity: EntityName<T>,
    data: RequiredEntityData<T>,
  ): Promise<T> {
    this.activeTransaction();
    const fork = this.entityManager.fork({ clear: true, keepTransactionContext: true });
    try {
      const record = fork.create(entity, data);
      await fork.persist(record).flush();
      // Read database normalization and nullable defaults before detaching.
      await fork.refreshOrFail(record);
      return record;
    } finally {
      fork.clear();
    }
  }

  private activeTransaction(): Knex.Transaction {
    const transaction = this.entityManager.getTransactionContext<Knex.Transaction>();
    if (transaction === undefined || transaction.isCompleted()) {
      throw new Error('Financial database access requires an active transaction.');
    }
    return transaction;
  }
}

export interface ClaimOptions {
  limit: number;
  leaseMs: number;
}

export function validateClaim(options: ClaimOptions): void {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new RangeError('Claim limit must be an integer between 1 and 1000.');
  }

  if (
    !Number.isInteger(options.leaseMs) ||
    options.leaseMs < 1 ||
    options.leaseMs > 300000
  ) {
    throw new RangeError(
      'Claim lease must be an integer between 1 and 300000 milliseconds.',
    );
  }
}

export function validateDelay(delayMs: number): void {
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 300000) {
    throw new RangeError(
      'Retry delay must be an integer between 0 and 300000 milliseconds.',
    );
  }
}
