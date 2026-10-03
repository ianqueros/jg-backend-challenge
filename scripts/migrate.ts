import { MikroORM } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { getDatabaseSettings } from '../src/core/database/database.settings.js';
import { createDatabaseOptions } from '../src/core/database/database.config.js';
import { translateDatabaseError } from '../src/core/database/database.errors.js';
import { invalidMigrationAction } from '../src/core/database/migration.errors.js';
import { invalidEnvironment } from '../src/core/config/environment.errors.js';
import { validateInput } from '../src/shared/validation.js';
import { reportFailure } from '../src/shared/report-failure.js';
import type { ApplicationError } from '../src/shared/errors.js';

const actionSchema = z.enum(['up', 'down']);

async function runMigration(): Promise<void> {
  const rawAction = process.argv[2] ?? 'up';
  const action = validateInput(actionSchema, rawAction, invalidMigrationAction);
  const settings = getDatabaseSettings();
  const databaseUrl = validateInput(
    z
      .url()
      .refine(
        (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      ),
    process.env.DATABASE_URL,
    invalidEnvironment,
  );

  let orm: MikroORM;
  try {
    orm = await MikroORM.init(createDatabaseOptions(databaseUrl, settings));
  } catch (cause) {
    throw translateDatabaseError(cause);
  }

  let failure: ApplicationError | undefined;
  try {
    const migrator = orm.migrator;
    if (action === 'down') {
      await migrator.down();
    } else {
      await migrator.up();
    }
  } catch (cause) {
    failure = translateDatabaseError(cause);
  }
  try {
    await orm.close(true);
  } catch (cause) {
    failure ??= translateDatabaseError(cause);
  }
  if (failure !== undefined) {
    throw failure;
  }
}

try {
  await runMigration();
} catch (cause) {
  reportFailure(cause);
}
