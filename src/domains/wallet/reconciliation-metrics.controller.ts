import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ReconciliationTelemetry } from './reconciliation.telemetry.js';
import { FinancialTelemetry } from '../../shared/financial.telemetry.js';
import { DatabaseTransactionRunner } from '../../core/database/database-transaction.runner.js';
import { TransactionRepositories } from '../../shared/transaction-repositories.js';

/** Exposes Prometheus metrics for reconciliation checks and financial transaction processing. */
@Controller('metrics')
export class ReconciliationMetricsController {
  constructor(
    @Inject(ReconciliationTelemetry)
    private readonly reconciliationTelemetry: ReconciliationTelemetry,
    @Inject(FinancialTelemetry)
    private readonly financialTelemetry: FinancialTelemetry,
    @Inject(DatabaseTransactionRunner)
    private readonly databaseTransactionRunner: DatabaseTransactionRunner,
  ) {}

  /** Renders combined reconciliation and financial telemetry as Prometheus text. */
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    const age = await this.databaseTransactionRunner.run((entityManager) =>
      new TransactionRepositories(entityManager).outboxRepository.pendingAgeSeconds(),
    );
    return (
      this.reconciliationTelemetry.render() +
      this.financialTelemetry.render() +
      '# HELP outbox_pending_age_seconds Database-wide age of the oldest unpublished event.\n' +
      '# TYPE outbox_pending_age_seconds gauge\n' +
      `outbox_pending_age_seconds ${String(age)}\n`
    );
  }
}
