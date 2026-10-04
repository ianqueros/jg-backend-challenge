import { Module } from '@nestjs/common';
import { DatabaseResource } from './core/database/database.resource.js';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ApplicationErrorFilter } from './shared/application-error.filter.js';
import { getEnvironment } from './core/config/environment.js';
import { HealthController } from './domains/health/health.controller.js';
import { HealthUseCase } from './domains/health/health.use-case.js';
import { DatabaseTransactionRunner } from './core/database/database-transaction.runner.js';
import { FinancialUseCase } from './domains/wagering/financial.use-case.js';
import { WalletController } from './domains/wallet/wallet.controller.js';
import { WalletUseCase } from './domains/wallet/wallet.use-case.js';
import { ReconciliationUseCase } from './domains/wallet/reconciliation.use-case.js';
import { ReconciliationTelemetry } from './domains/wallet/reconciliation.telemetry.js';
import { ReconciliationMetricsController } from './domains/wallet/reconciliation-metrics.controller.js';
import { WageringController } from './domains/wagering/wagering.controller.js';
import { WageringQueryUseCase } from './domains/wagering/wagering-query.use-case.js';
import { CommandConsumer } from './domains/messaging/command-consumer.js';
import { ReferenceWorker } from './domains/wagering/reference-worker.js';
import { createQueueClient } from './core/sqs.transport.js';
import { OutboxPublisher } from './domains/messaging/outbox-publisher.js';
import { FinancialTelemetry } from './shared/financial.telemetry.js';
import { AdmissionGuard, ShutdownState } from './core/shutdown.js';

@Module({
  controllers: [
    HealthController,
    WalletController,
    WageringController,
    ReconciliationMetricsController,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApplicationErrorFilter },
    { provide: APP_GUARD, useClass: AdmissionGuard },
    { provide: FinancialTelemetry, useFactory: () => new FinancialTelemetry() },
    {
      provide: ShutdownState,
      inject: [DatabaseTransactionRunner],
      useFactory: (databaseTransactionRunner: DatabaseTransactionRunner) =>
        new ShutdownState(databaseTransactionRunner, getEnvironment().SHUTDOWN_GRACE_MS),
    },
    {
      provide: OutboxPublisher,
      inject: [DatabaseTransactionRunner, FinancialTelemetry, ShutdownState],
      useFactory: (
        databaseTransactionRunner: DatabaseTransactionRunner,
        financialTelemetry: FinancialTelemetry,
        shutdownState: ShutdownState,
      ) => {
        const environment = getEnvironment();
        return new OutboxPublisher(
          databaseTransactionRunner,
          createQueueClient(environment),
          environment,
          financialTelemetry,
          shutdownState.deadline.signal,
        );
      },
    },
    {
      provide: DatabaseResource,
      useFactory: () => {
        const environment = getEnvironment();
        return DatabaseResource.open(environment.DATABASE_URL, environment);
      },
    },
    {
      provide: DatabaseTransactionRunner,
      inject: [DatabaseResource, FinancialTelemetry],
      useFactory: (database: DatabaseResource, financialTelemetry: FinancialTelemetry) =>
        new DatabaseTransactionRunner(database.orm, getEnvironment(), financialTelemetry),
    },
    {
      provide: FinancialUseCase,
      inject: [DatabaseTransactionRunner, FinancialTelemetry],
      useFactory: (
        databaseTransactionRunner: DatabaseTransactionRunner,
        financialTelemetry: FinancialTelemetry,
      ) =>
        new FinancialUseCase(
          databaseTransactionRunner,
          getEnvironment(),
          financialTelemetry,
        ),
    },
    {
      provide: ReferenceWorker,
      inject: [DatabaseTransactionRunner, FinancialUseCase, FinancialTelemetry],
      useFactory: (
        databaseTransactionRunner: DatabaseTransactionRunner,
        financialUseCase: FinancialUseCase,
        financialTelemetry: FinancialTelemetry,
      ) =>
        new ReferenceWorker(
          databaseTransactionRunner,
          financialUseCase,
          getEnvironment(),
          financialTelemetry,
        ),
    },
    {
      provide: CommandConsumer,
      inject: [FinancialUseCase, FinancialTelemetry, ShutdownState],
      useFactory: (
        financialUseCase: FinancialUseCase,
        financialTelemetry: FinancialTelemetry,
        shutdownState: ShutdownState,
      ) => {
        const environment = getEnvironment();
        return new CommandConsumer(
          createQueueClient(environment),
          financialUseCase,
          environment,
          financialTelemetry,
          shutdownState.deadline.signal,
        );
      },
    },
    {
      provide: WageringQueryUseCase,
      inject: [DatabaseTransactionRunner],
      useFactory: (databaseTransactionRunner: DatabaseTransactionRunner) =>
        new WageringQueryUseCase(databaseTransactionRunner),
    },
    {
      provide: WalletUseCase,
      inject: [DatabaseTransactionRunner, FinancialTelemetry],
      useFactory: (
        databaseTransactionRunner: DatabaseTransactionRunner,
        financialTelemetry: FinancialTelemetry,
      ) => new WalletUseCase(databaseTransactionRunner, financialTelemetry),
    },
    {
      provide: ReconciliationTelemetry,
      useFactory: () => new ReconciliationTelemetry(),
    },
    {
      provide: ReconciliationUseCase,
      inject: [DatabaseTransactionRunner, ReconciliationTelemetry],
      useFactory: (
        databaseTransactionRunner: DatabaseTransactionRunner,
        reconciliationTelemetry: ReconciliationTelemetry,
      ) => new ReconciliationUseCase(databaseTransactionRunner, reconciliationTelemetry),
    },
    {
      provide: HealthUseCase,
      inject: [DatabaseTransactionRunner, ShutdownState],
      useFactory: (
        databaseTransactionRunner: DatabaseTransactionRunner,
        shutdownState: ShutdownState,
      ) => {
        const environment = getEnvironment();
        const sqsClient = createQueueClient(environment);
        return new HealthUseCase(
          databaseTransactionRunner,
          sqsClient,
          [
            environment.COMMAND_SOURCE_QUEUE,
            environment.COMMAND_DLQ_QUEUE,
            environment.EVENT_QUEUE,
          ],
          shutdownState,
        );
      },
    },
  ],
  exports: [FinancialUseCase, WalletUseCase, WageringQueryUseCase, ReconciliationUseCase],
})
export class AppModule {}
