import { MikroORM } from '@mikro-orm/postgresql';
import { createDatabaseOptions } from './database.config.js';
import { translateDatabaseError } from './database.errors.js';
import type { DatabaseSettings } from './database.settings.js';

/** Owns the database pool. ShutdownState drains work before this resource closes. */
export class DatabaseResource {
  private constructor(readonly orm: MikroORM) {}

  /** Opens the configured pool without changing the database schema. */
  static async open(
    databaseUrl: string,
    settings: Partial<DatabaseSettings>,
  ): Promise<DatabaseResource> {
    try {
      return new DatabaseResource(
        await MikroORM.init(createDatabaseOptions(databaseUrl, settings)),
      );
    } catch (cause) {
      throw translateDatabaseError(cause);
    }
  }

  /** Closes connections after workers stop and admitted transactions finish. */
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.orm.close(true);
    } catch (cause) {
      throw translateDatabaseError(cause);
    }
  }
}
