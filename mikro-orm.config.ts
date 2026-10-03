import { getEnvironment } from './src/core/config/environment.js';
import { createDatabaseOptions } from './src/core/database/database.config.js';

const environment = getEnvironment();

export default createDatabaseOptions(environment.DATABASE_URL, environment);
