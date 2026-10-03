import { Logger } from '@nestjs/common';
import { installTestEnvironment } from '../scripts/test-environment.js';

installTestEnvironment();

Logger.overrideLogger(['error', 'fatal']);
process.env.MIKRO_ORM_MIGRATIONS_SILENT = 'true';
