import { setTimeout as delay } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import type { DatabaseTransactionRunner } from '../../core/database/database-transaction.runner.js';
import { TransactionRepositories } from '../../shared/transaction-repositories.js';
import type { WagerTransactionRecord } from './records/wager-transaction.record.js';
import type { ReferenceWorkerSettings } from '../../core/config/reference-worker.settings.js';
import type { FinancialUseCase } from './financial.use-case.js';
import {
  FinancialTelemetry,
  type FinancialLogContext,
} from '../../shared/financial.telemetry.js';

/**
 * Resolves pending reference transactions in the background using polling and exponential backoff.
 */
export class ReferenceWorker {
  private readonly logger = new Logger(ReferenceWorker.name);
  private readonly shutdown = new AbortController();
  private running: Promise<void> | undefined;

  constructor(
    private readonly databaseTransactionRunner: DatabaseTransactionRunner,
    private readonly financialUseCase: FinancialUseCase,
    private readonly settings: ReferenceWorkerSettings,
    private readonly financialTelemetry = new FinancialTelemetry(),
  ) {}

  onApplicationBootstrap(): void {
    if (this.settings.REFERENCE_WORKER_ENABLED) {
      this.start();
    }
  }

  /**
   * Starts the background polling loop if not already running.
   */
  start(): void {
    if (this.running !== undefined || this.shutdown.signal.aborted) {
      return;
    }
    this.running = this.workLoop().catch(() => {
      this.logger.error({ event: 'reference_worker_stopped' });
    });
  }

  onModuleDestroy(): void {
    this.shutdown.abort();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * Signals the worker to stop and waits for the active polling loop to finish.
   */
  async stop(): Promise<void> {
    this.shutdown.abort();
    if (this.running !== undefined) {
      await this.running;
      this.running = undefined;
    }
  }

  /**
   * Runs a single polling cycle to claim and process one pending reference transaction.
   */
  async runOnce(): Promise<boolean> {
    if (this.shutdown.signal.aborted) return false;
    const claimed = await this.claimOne();
    if (claimed === undefined) {
      return false;
    }
    const token = claimed.referenceClaimToken;
    if (token == null) {
      return false;
    }
    await this.processClaimed(claimed, token);
    return true;
  }

  /**
   * Claims one pending reference transaction by acquiring a timed lease.
   */
  private async claimOne(): Promise<WagerTransactionRecord | undefined> {
    return this.databaseTransactionRunner.run(async (entityManager) => {
      const transactionRepositories = new TransactionRepositories(entityManager);
      const rows =
        await transactionRepositories.wagerTransactionRepository.claimReferences({
          limit: 1,
          leaseMs: this.settings.REFERENCE_LEASE_MS,
        });
      return rows[0];
    });
  }

  /**
   * Resumes reference resolution and reschedules the transaction if still pending or on failure.
   */
  private async processClaimed(
    claimed: WagerTransactionRecord,
    token: string,
  ): Promise<void> {
    const delayMs = this.computeBackoffDelay(claimed.referenceAttempts);
    const context: FinancialLogContext = {
      transactionId: claimed.id,
      correlationId: claimed.referenceCorrelationId ?? claimed.id,
      causationId: claimed.referenceCausationId ?? undefined,
      walletId: claimed.walletId,
      providerId: claimed.providerId,
    };

    try {
      const result = await this.financialUseCase.resumeReference(claimed.id, token);
      if (result?.status === 'PENDING_REFERENCE') {
        await this.rescheduleClaimed(claimed.id, token, delayMs, 'waiting', context);
        this.financialTelemetry.increment('financial_retry_total', 'reference');
      }
    } catch {
      this.financialTelemetry.increment('financial_retry_total', 'reference');
      this.logger.warn({ event: 'reference_resume_retry', ...context });
      await this.rescheduleClaimed(claimed.id, token, delayMs, 'retry', context);
    }
  }

  /**
   * Releases the claim lease and schedules the next retry after the backoff delay.
   */
  private async rescheduleClaimed(
    id: string,
    token: string,
    delayMs: number,
    reason: 'waiting' | 'retry',
    context: FinancialLogContext,
  ): Promise<void> {
    try {
      await this.databaseTransactionRunner.run(async (entityManager) => {
        const transactionRepositories = new TransactionRepositories(entityManager);
        await transactionRepositories.wagerTransactionRepository.rescheduleReference(
          id,
          token,
          delayMs,
          reason,
        );
      });
    } catch {
      this.logger.warn({ event: 'reference_reschedule_unknown', ...context });
    }
  }

  /**
   * Computes an exponential retry delay capped at the configured maximum.
   */
  private computeBackoffDelay(attempts: number): number {
    const exponent = Math.max(0, attempts - 1);
    const multiplier = Math.pow(2, Math.min(exponent, 30));
    const delayMs = Math.floor(this.settings.REFERENCE_RETRY_BASE_MS * multiplier);
    return Math.min(delayMs, this.settings.REFERENCE_RETRY_MAX_MS);
  }

  private isStopping(): boolean {
    return this.shutdown.signal.aborted;
  }

  /**
   * Continuously polls and processes pending reference transactions until shutdown is signaled.
   */
  private async workLoop(): Promise<void> {
    while (!this.isStopping()) {
      try {
        const handled = await this.runOnce();
        if (!handled && !this.isStopping()) {
          await this.idleSleep(this.settings.REFERENCE_POLL_MS);
        }
      } catch {
        if (this.isStopping()) {
          break;
        }
        this.logger.warn({ event: 'reference_cycle_retry' });
        await this.idleSleep(this.settings.REFERENCE_POLL_MS);
      }
    }
  }

  /**
   * Pauses execution between polling cycles while honoring shutdown cancellation.
   */
  private async idleSleep(ms: number): Promise<void> {
    try {
      await delay(ms, undefined, { signal: this.shutdown.signal });
    } catch {
      // AbortError when stopping - clean cancellation
    }
  }
}
