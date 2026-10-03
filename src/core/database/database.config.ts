import { Options, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletSchema } from '../../domains/wallet/schemas/wallet.schema.js';
import { WagerTransactionSchema } from '../../domains/wagering/schemas/wager-transaction.schema.js';
import { WalletLedgerEntrySchema } from '../../domains/wallet/schemas/wallet-ledger-entry.schema.js';
import { InboxMessageSchema } from '../../domains/inbox/schemas/inbox-message.schema.js';
import { OutboxMessageSchema } from '../../domains/outbox/schemas/outbox-message.schema.js';
import { Migration20261003000001_InitialSchema } from './migrations/Migration20261003000001_InitialSchema.js';
import { getDatabaseSettings, type DatabaseSettings } from './database.settings.js';

const databaseEntities = [
  WalletSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
export function createDatabaseOptions(
  databaseUrl: string,
  settings?: Partial<DatabaseSettings>,
): Options {
  const budget = getDatabaseSettings(settings ?? {});
  return {
    clientUrl: databaseUrl,
    driver: PostgreSqlDriver,
    pool: {
      min: 0,
      max: budget.DB_POOL_MAX,
      acquireTimeoutMillis: budget.DB_POOL_ACQUIRE_TIMEOUT_MS,
      createTimeoutMillis: budget.DB_CONNECT_TIMEOUT_MS,
    },
    driverOptions: {
      acquireConnectionTimeout: budget.DB_POOL_ACQUIRE_TIMEOUT_MS,
      connection: {
        connectionTimeoutMillis: budget.DB_CONNECT_TIMEOUT_MS,
        options: `-c lock_timeout=${String(budget.DB_LOCK_TIMEOUT_MS)} -c statement_timeout=${String(budget.DB_STATEMENT_TIMEOUT_MS)}`,
      },
    },
    entities: databaseEntities,
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      path: './dist/core/database/migrations',
      pathTs: './src/core/database/migrations',
      glob: '!(*.d).{js,ts}',
      transactional: true,
      disableForeignKeys: false,
      allOrNothing: true,
      snapshot: false,
      migrationsList: [
        {
          name: 'Migration20261003000001_InitialSchema',
          class: Migration20261003000001_InitialSchema,
        },
      ],
    },
  };
}
