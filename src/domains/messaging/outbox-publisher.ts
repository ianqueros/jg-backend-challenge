import { setTimeout as delay } from 'node:timers/promises';
import {
  GetQueueUrlCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { DatabaseTransactionRunner } from '../../core/database/database-transaction.runner.js';
import { TransactionRepositories } from '../../shared/transaction-repositories.js';
import type { OutboxMessageRecord } from '../outbox/records/outbox-message.record.js';
import type { OutboxPublisherSettings } from '../../core/config/outbox-publisher.settings.js';
import { queueDeadline } from '../../core/sqs.transport.js';
import { FinancialTelemetry } from '../../shared/financial.telemetry.js';
import { OutboxMessage } from './entities/outbox-message.entity.js';

/** Publishes transactional outbox events to Amazon SQS with aggregate FIFO ordering. */
export class OutboxPublisher {
  private readonly shutdown = new AbortController();
  private running: Promise<void> | undefined;
  private queueUrl: string | undefined;
  private readonly active = new Set<Promise<number>>();

  constructor(
    private readonly databaseTransactionRunner: DatabaseTransactionRunner,
    private readonly sqsClient: SQSClient,
    private readonly settings: OutboxPublisherSettings,
    private readonly financialTelemetry = new FinancialTelemetry(),
    private readonly cancellation?: AbortSignal,
  ) {}

  onApplicationBootstrap(): void {
    if (this.settings.OUTBOX_PUBLISHER_ENABLED) this.start();
  }

  /** Starts background outbox publishing. */
  start(): void {
    if (this.running !== undefined || this.shutdown.signal.aborted) return;
    this.running = this.publishLoop();
  }

  onModuleDestroy(): void {
    this.shutdown.abort();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Stops the publishing loop, waits for active batches, and closes queue clients. */
  async stop(): Promise<void> {
    this.shutdown.abort();
    await this.running;
    await Promise.allSettled(this.active);
    this.sqsClient.destroy();
  }

  /** Claims and publishes one batch of pending outbox events. */
  async publishOnce(): Promise<number> {
    if (this.shutdown.signal.aborted) return 0;
    const work = this.publishBatch();
    this.active.add(work);
    try {
      return await work;
    } finally {
      this.active.delete(work);
    }
  }

  /**
   * Claims and concurrently dispatches due outbox records.
   * Concurrent delivery prevents earlier broker delays from consuming later batch leases.
   */
  private async publishBatch(): Promise<number> {
    if (this.queueUrl === undefined) {
      const response = await queueDeadline(
        (abortSignal) =>
          this.sqsClient.send(
            new GetQueueUrlCommand({ QueueName: this.settings.EVENT_QUEUE }),
            { abortSignal },
          ),
        this.settings.OUTBOX_BROKER_TIMEOUT_MS,
        this.shutdown.signal,
      );
      if (response.QueueUrl === undefined) throw new Error('Event queue URL is absent.');
      this.queueUrl = response.QueueUrl;
    }

    if (this.shutdown.signal.aborted) return 0;
    const claims = await this.databaseTransactionRunner.run((entityManager) =>
      new TransactionRepositories(entityManager).outboxRepository.claimDueEvents({
        limit: this.settings.OUTBOX_BATCH_SIZE,
        leaseMs: this.settings.OUTBOX_LEASE_MS,
      }),
    );

    // Send concurrently so the last item does not consume the batch's lease waiting for earlier sends.
    const results = await Promise.all(claims.map((claim) => this.publishClaim(claim)));
    return results.reduce((count, published) => count + (published ? 1 : 0), 0);
  }

  /**
   * Dispatches a claimed outbox event to SQS and marks it published in the database.
   * On failure, schedules exponential backoff; expired leases serve as durable recovery.
   */
  private async publishClaim(claim: OutboxMessageRecord): Promise<boolean> {
    const token = claim.claimToken;
    if (token == null) return false;
    const state = {
      id: claim.id,
      aggregateId: claim.aggregateId,
      eventType: claim.eventType,
      payload: claim.payload,
      occurredAt: claim.occurredAt,
      attempts: claim.attempts,
      nextAttemptAt: claim.nextAttemptAt ?? undefined,
      publishedAt: claim.publishedAt ?? undefined,
    };
    const message = OutboxMessage.rehydrate(state);
    if (!message.isPending()) return false;

    try {
      const response = await queueDeadline(
        (abortSignal) =>
          this.sqsClient.send(
            new SendMessageCommand({
              QueueUrl: this.queueUrl,
              MessageBody: JSON.stringify(claim.payload),
              MessageGroupId: claim.aggregateId,
              MessageDeduplicationId: claim.id,
            }),
            { abortSignal },
          ),
        this.settings.OUTBOX_BROKER_TIMEOUT_MS,
        this.cancellation,
      );
      if (response.MessageId === undefined)
        throw new Error('Event send was not confirmed.');

      const publishedAt = new Date();
      message.markPublished(publishedAt);
      const marked = await this.databaseTransactionRunner.run((entityManager) =>
        new TransactionRepositories(entityManager).outboxRepository.markPublishedIfOwned(
          claim.id,
          token,
          publishedAt,
        ),
      );

      this.financialTelemetry.increment(
        'outbox_publish_total',
        marked ? 'confirmed' : 'ownership_lost',
      );
      if (marked) {
        this.financialTelemetry.observe(
          'outbox_delay_seconds',
          (Date.now() - new Date(claim.createdAt).getTime()) / 1000,
        );
        this.financialTelemetry.log('outbox_published', { eventId: claim.id });
      }
      return marked;
    } catch {
      this.financialTelemetry.increment('financial_retry_total', 'outbox');
      this.financialTelemetry.increment('outbox_publish_total', 'retry');
      this.financialTelemetry.log('outbox_retry', {
        eventId: claim.id,
        code: 'BROKER_OR_MARK_UNCONFIRMED',
      });

      // Discard a tentative publication when SQL confirmation is unknown. Conditional
      // persistence still prevents a confirmed terminal row from being retried.
      const retry = OutboxMessage.rehydrate(state).scheduleRetry(new Date(), {
        baseMs: this.settings.OUTBOX_RETRY_BASE_MS,
        maxMs: this.settings.OUTBOX_RETRY_MAX_MS,
      });

      try {
        await this.databaseTransactionRunner.run((entityManager) =>
          new TransactionRepositories(
            entityManager,
          ).outboxRepository.scheduleRetryIfOwned(
            claim.id,
            token,
            retry.delayMs,
            retry.attempts,
          ),
        );
      } catch {
        // An unknown send/mark result remains durable; the expired lease is the recovery path.
      }

      return false;
    }
  }

  /** Continuously polls and publishes due outbox events until shutdown. */
  private async publishLoop(): Promise<void> {
    while (!this.shutdown.signal.aborted) {
      try {
        await this.publishOnce();
      } catch {
        this.financialTelemetry.log('outbox_cycle_retry', {
          code: 'QUEUE_OR_CLAIM_UNCONFIRMED',
        });
      }

      try {
        await delay(this.settings.OUTBOX_POLL_MS, undefined, {
          signal: this.shutdown.signal,
        });
      } catch {
        return;
      }
    }
  }
}
