import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { translateDatabaseError } from '../../core/database/database.errors.js';
import { invalidQueueResponse, translateQueueError } from '../../core/sqs.errors.js';
import { validateInput } from '../../shared/validation.js';
import { healthErrors } from './health.errors.js';
import { DatabaseTransactionRunner } from '../../core/database/database-transaction.runner.js';
import type { ShutdownState } from '../../core/shutdown.js';

const databaseProbeSchema = z.array(z.object({ alive: z.literal(1) })).length(1);
const queueProbeSchema = z.object({ QueueUrl: z.url() });

/** Verifies dependency readiness without ownership of database resources. */
export class HealthUseCase {
  constructor(
    private readonly databaseTransactionRunner: DatabaseTransactionRunner,
    private readonly sqsClient: SQSClient,
    private readonly queueNames: readonly string[],
    private readonly shutdownState: ShutdownState,
  ) {}

  /** Probes database and message queues concurrently; fails fast during shutdown. */
  async readiness(): Promise<void> {
    if (this.shutdownState.stopping)
      throw healthErrors.dependenciesUnavailable(undefined);

    try {
      await Promise.all([this.probeDatabase(), this.probeQueues()]);
    } catch (cause) {
      throw healthErrors.dependenciesUnavailable(cause);
    }
  }

  /** Closes the queue client after readiness work stops. */
  onApplicationShutdown(): void {
    this.sqsClient.destroy();
  }

  /** Probes database query execution and validates schema response. */
  private async probeDatabase(): Promise<void> {
    try {
      await this.databaseTransactionRunner.run(async (entityManager) => {
        const rows: unknown = await entityManager.execute('select 1 as alive');
        validateInput(databaseProbeSchema, rows, healthErrors.invalidDatabaseResponse);
      });
    } catch (cause) {
      throw translateDatabaseError(cause);
    }
  }

  /** Probes message queue reachability by resolving queue URLs within a deadline. */
  private async probeQueues(): Promise<void> {
    for (const QueueName of this.queueNames) {
      try {
        const response: unknown = await this.sqsClient.send(
          new GetQueueUrlCommand({ QueueName }),
          { abortSignal: AbortSignal.timeout(2000) },
        );
        validateInput(queueProbeSchema, response, invalidQueueResponse);
      } catch (cause) {
        throw translateQueueError(cause);
      }
    }
  }
}
