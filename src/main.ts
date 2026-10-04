import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { getEnvironment } from './core/config/environment.js';
import { reportFailure } from './shared/report-failure.js';

try {
  const environment = getEnvironment();
  const application = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new ConsoleLogger({ json: true }),
    abortOnError: false,
  });
  application.useBodyParser('json', { limit: 100 * 1024 });
  application.enableShutdownHooks();
  await application.listen(environment.PORT, environment.HOST);
} catch (cause) {
  reportFailure(cause);
}
