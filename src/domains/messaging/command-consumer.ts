import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import type { CommandConsumerSettings } from '../../core/config/command-consumer.settings.js';
import { queueDeadline } from '../../core/sqs.transport.js';
import { ApplicationError } from '../../shared/errors.js';
import type { FinancialUseCase } from '../wagering/financial.use-case.js';
import { validateSqsWagerMessage } from './dto/sqs-wager-message.dto.js';
import { messagingErrors } from './messaging.errors.js';
import {
  FinancialTelemetry,
  type FinancialLogContext,
} from '../../shared/financial.telemetry.js';

const permanentCodes: Record<string, true | undefined> = {
  INBOX_MESSAGE_CONFLICT: true,
  WAGER_IDEMPOTENCY_CONFLICT: true,
  WAGER_EXTERNAL_IDENTITY_CONFLICT: true,
  WAGER_OPENING_INTERNAL_ONLY: true,
};

/**
 * Consumes wager commands from SQS, executes financial transactions, and manages leases.
 * Quarantines permanent failures to the DLQ and defers transient retries with exponential backoff.
 */
export class CommandConsumer {
  private readonly logger = new Logger(CommandConsumer.name);
  private readonly shutdown = new AbortController();
  private running: Promise<void> | undefined;

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly financialUseCase: FinancialUseCase,
    private readonly settings: CommandConsumerSettings,
    private readonly financialTelemetry = new FinancialTelemetry(),
    private readonly cancellation?: AbortSignal,
  ) {}

  onApplicationBootstrap(): void {
    if (this.settings.COMMAND_CONSUMER_ENABLED) this.start();
  }

  /** Starts background queue consumer loop. */
  start(): void {
    if (this.running !== undefined || this.shutdown.signal.aborted) return;
    this.running = this.consume().catch(() => {
      this.logger.error('Command consumer stopped after an unexpected worker failure.');
    });
  }

  onModuleDestroy(): void {
    this.shutdown.abort();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Signals consumer shutdown, awaits in-flight messages, and closes queue connections. */
  async stop(): Promise<void> {
    this.shutdown.abort();
    await this.running;
    this.sqsClient.destroy();
  }

  /**
   * Processes a command message, renewing visibility leases until committed or quarantined.
   * If lease renewal fails, acknowledgement is withheld to prevent conflicting message deletions.
   */
  async processMessage(
    message: Message,
    sourceUrl: string,
    dlqUrl: string,
  ): Promise<void> {
    const receipt = message.ReceiptHandle;
    if (receipt === undefined) {
      this.logger.warn(
        'Queue message has no receipt handle; no acknowledgement was attempted.',
      );
      return;
    }

    const context: FinancialLogContext = { brokerMessageId: message.MessageId };
    const lease = new AbortController();
    const leaseState: { failed: boolean } = { failed: false };
    const renewal = this.renewVisibility(
      sourceUrl,
      receipt,
      lease.signal,
      () => {
        leaseState.failed = true;
      },
      context,
    );

    let retry = false;
    try {
      const outcome = await this.executeFinancial(message.Body, context);
      retry = outcome.disposition === 'retry' || leaseState.failed;
      if (retry) return;
      if (outcome.disposition === 'permanent') {
        if (message.Body === undefined) {
          retry = true;
          return;
        }
        await this.quarantine(message.Body, outcome.group, sourceUrl, dlqUrl, context);
      }

      if (leaseState.failed) {
        retry = true;
        return;
      }

      await queueDeadline(
        (abortSignal) =>
          this.sqsClient.send(
            new DeleteMessageCommand({ QueueUrl: sourceUrl, ReceiptHandle: receipt }),
            { abortSignal },
          ),
        this.settings.COMMAND_BROKER_TIMEOUT_MS,
        this.cancellation,
      );
      this.financialTelemetry.log('command_acknowledged', context);
    } catch {
      retry = true;
      this.financialTelemetry.log('command_retry', {
        ...context,
        code: 'BROKER_OUTCOME_UNCONFIRMED',
      });
      this.logger.warn('Command transport failed; the source message remains retriable.');
    } finally {
      // A renewal must not overwrite the final retry visibility.
      lease.abort();
      await renewal;

      if (retry) {
        if (this.isStopping()) await this.returnVisibility(message, sourceUrl, context);
        else await this.deferRetry(message, sourceUrl, receipt, context);
      }
    }
  }

  /** Validates and executes a wager command, classifying outcomes as committed, permanent, or retryable. */
  private async executeFinancial(
    body: string | undefined,
    context: FinancialLogContext,
  ): Promise<{
    disposition: 'committed' | 'permanent' | 'retry';
    group: string | undefined;
  }> {
    let group: string | undefined;
    try {
      let parsed: unknown;
      try {
        if (body === undefined) throw new Error('Queue body is absent.');
        parsed = JSON.parse(body) as unknown;
      } catch (cause) {
        throw messagingErrors.invalidInput(cause);
      }

      const envelope = validateSqsWagerMessage(parsed);
      group = envelope.data.walletId;
      context.messageId = envelope.messageId;
      context.correlationId = envelope.messageId;
      context.causationId = envelope.messageId;
      context.walletId = envelope.data.walletId;
      context.providerId = envelope.data.providerId;
      this.financialTelemetry.log('command_received', context);

      const result = await this.financialUseCase.executeCommand(
        envelope,
        this.settings.COMMAND_CONSUMER_NAME,
        {
          providerId: envelope.data.providerId,
          correlationId: envelope.messageId,
          brokerMessageId: context.brokerMessageId,
        },
      );
      context.transactionId = result.transactionId;
      context.status = result.status;
      this.financialTelemetry.log('command_committed', context);

      return { disposition: 'committed', group };
    } catch (cause) {
      const permanent =
        ApplicationError.is(cause) &&
        (cause.category === 'ValidationError' ||
          cause.category === 'AuthenticationError' ||
          permanentCodes[cause.code] === true);

      this.financialTelemetry.log('command_execution_failed', {
        ...context,
        code: permanent ? 'PERMANENT_COMMAND' : 'FINANCIAL_OUTCOME_UNCONFIRMED',
      });

      return { disposition: permanent ? 'permanent' : 'retry', group };
    }
  }

  /** Forwards permanent command failures to the DLQ with deterministic SHA-256 deduplication. */
  private async quarantine(
    body: string,
    group: string | undefined,
    sourceUrl: string,
    dlqUrl: string,
    context: FinancialLogContext,
  ): Promise<void> {
    const identity = createHash('sha256')
      .update(sourceUrl)
      .update('\0')
      .update(body)
      .digest('hex');

    const sent = await queueDeadline(
      (abortSignal) =>
        this.sqsClient.send(
          new SendMessageCommand({
            QueueUrl: dlqUrl,
            MessageBody: body,
            MessageGroupId: group ?? `malformed-${identity}`,
            MessageDeduplicationId: identity,
          }),
          { abortSignal },
        ),
      this.settings.COMMAND_BROKER_TIMEOUT_MS,
      this.cancellation,
    );

    if (sent.MessageId === undefined) throw new Error('DLQ send was not confirmed.');

    this.financialTelemetry.increment('financial_dlq_total', 'confirmed');
    this.financialTelemetry.log('command_dlq_confirmed', {
      ...context,
      code: 'PERMANENT_COMMAND',
    });
  }

  /** Continuously polls and processes command messages until shutdown. */
  private async consume(): Promise<void> {
    let sourceUrl: string | undefined;
    let dlqUrl: string | undefined;
    let failures = 0;
    while (!this.isStopping()) {
      try {
        sourceUrl ??= await this.queueUrl(this.settings.COMMAND_SOURCE_QUEUE);
        dlqUrl ??= await this.queueUrl(this.settings.COMMAND_DLQ_QUEUE);
        const response = await queueDeadline(
          (abortSignal) =>
            this.sqsClient.send(
              new ReceiveMessageCommand({
                QueueUrl: sourceUrl,
                MaxNumberOfMessages: 1,
                WaitTimeSeconds: this.settings.COMMAND_LONG_POLL_SEC,
                VisibilityTimeout: this.settings.COMMAND_VISIBILITY_SEC,
                MessageSystemAttributeNames: ['ApproximateReceiveCount'],
              }),
              { abortSignal },
            ),
          this.settings.COMMAND_BROKER_TIMEOUT_MS +
            this.settings.COMMAND_LONG_POLL_SEC * 1000,
          this.shutdown.signal,
        );
        failures = 0;
        const message = response.Messages?.[0];
        if (message !== undefined) {
          if (this.isStopping()) {
            await this.returnVisibility(message, sourceUrl, {
              brokerMessageId: message.MessageId,
            });
          } else await this.processMessage(message, sourceUrl, dlqUrl);
        } else await this.pause(100);
      } catch {
        if (this.isStopping()) return;
        failures += 1;
        this.financialTelemetry.log('command_receive_retry', {
          code: 'BROKER_RECEIVE_UNCONFIRMED',
        });
        this.logger.warn('Command receive failed; the worker will retry.');
        await this.pause(this.retrySeconds(failures) * 1000);
      }
    }
  }

  /** Checks if worker shutdown has started. */
  private isStopping(): boolean {
    return this.shutdown.signal.aborted;
  }

  /** Resolves the queue URL for a configured queue name. */
  private async queueUrl(name: string): Promise<string> {
    const response = await queueDeadline(
      (abortSignal) =>
        this.sqsClient.send(new GetQueueUrlCommand({ QueueName: name }), { abortSignal }),
      this.settings.COMMAND_BROKER_TIMEOUT_MS,
      this.shutdown.signal,
    );
    if (response.QueueUrl === undefined) throw new Error('Queue URL is absent.');
    return response.QueueUrl;
  }

  /** Periodically extends message visibility and flags lease loss on renewal failure. */
  private async renewVisibility(
    sourceUrl: string,
    receipt: string,
    signal: AbortSignal,
    failed: () => void,
    context: FinancialLogContext,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await delay(this.settings.COMMAND_RENEW_MS, undefined, { signal });
      } catch {
        return;
      }
      try {
        await queueDeadline(
          (abortSignal) =>
            this.sqsClient.send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: sourceUrl,
                ReceiptHandle: receipt,
                VisibilityTimeout: this.settings.COMMAND_VISIBILITY_SEC,
              }),
              { abortSignal },
            ),
          this.settings.COMMAND_BROKER_TIMEOUT_MS,
          this.cancellation,
        );
      } catch {
        failed();
        this.financialTelemetry.log('command_retry', {
          ...context,
          code: 'VISIBILITY_RENEWAL_UNCONFIRMED',
        });
        this.logger.warn(
          'Command lease renewal failed; source acknowledgement will be withheld.',
        );
        return;
      }
    }
  }

  /** Defers message redelivery using exponential backoff based on receive count. */
  private async deferRetry(
    message: Message,
    sourceUrl: string,
    receipt: string,
    context: FinancialLogContext,
  ): Promise<void> {
    const count = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    this.financialTelemetry.increment('financial_retry_total', 'command');
    this.financialTelemetry.log('command_redelivery_scheduled', {
      ...context,
      code: 'COMMAND_REDELIVERY',
    });
    const attempt = Number.isSafeInteger(count) && count > 0 ? count : 1;
    try {
      await queueDeadline(
        (abortSignal) =>
          this.sqsClient.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: sourceUrl,
              ReceiptHandle: receipt,
              VisibilityTimeout: this.retrySeconds(attempt),
            }),
            { abortSignal },
          ),
        this.settings.COMMAND_BROKER_TIMEOUT_MS,
        this.cancellation,
      );
    } catch {
      this.logger.warn(
        'Command retry visibility failed; broker visibility remains in effect.',
      );
    }
  }

  /** Computes exponential retry delay in seconds within configured limits. */
  private retrySeconds(attempt: number): number {
    return Math.min(
      this.settings.COMMAND_RETRY_MAX_SEC,
      this.settings.COMMAND_RETRY_BASE_SEC * 2 ** Math.min(attempt - 1, 16),
    );
  }

  /** Resets message visibility to zero during shutdown for immediate reprocessing. */
  private async returnVisibility(
    message: Message,
    sourceUrl: string,
    context: FinancialLogContext,
  ): Promise<void> {
    if (message.ReceiptHandle === undefined) return;
    try {
      await queueDeadline(
        (abortSignal) =>
          this.sqsClient.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: sourceUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
            { abortSignal },
          ),
        this.settings.COMMAND_BROKER_TIMEOUT_MS,
        this.cancellation,
      );
    } catch {
      this.financialTelemetry.log('command_shutdown_visibility_unknown', context);
    }
  }

  /** Pauses consumer execution with abort signal handling. */
  private async pause(milliseconds: number): Promise<void> {
    try {
      await delay(milliseconds, undefined, { signal: this.shutdown.signal });
    } catch {
      // Shutdown cancels idle waits, not admitted financial work.
    }
  }
}
