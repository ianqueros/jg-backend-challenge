import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { getEnvironment } from '../src/core/config/environment.js';
import { invalidQueueResponse, translateQueueError } from '../src/core/sqs.errors.js';
import { createQueueClient, queueDeadline } from '../src/core/sqs.transport.js';
import { validateInput } from '../src/shared/validation.js';
import { reportFailure } from '../src/shared/report-failure.js';

const queueResponseSchema = z.object({ QueueUrl: z.url() });
const queueArnSchema = z.object({
  Attributes: z.object({ QueueArn: z.string().min(1) }),
});

async function bootstrapQueues(): Promise<void> {
  const environment = getEnvironment();
  const client = createQueueClient(environment);

  async function ensureQueue(QueueName: string): Promise<string> {
    try {
      const response: unknown = await queueDeadline(
        (abortSignal) =>
          client.send(new GetQueueUrlCommand({ QueueName }), { abortSignal }),
        environment.COMMAND_BROKER_TIMEOUT_MS,
      );
      return validateInput(queueResponseSchema, response, invalidQueueResponse).QueueUrl;
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue'].includes(
          cause.name,
        )
      )
        throw cause;
    }
    const response: unknown = await queueDeadline(
      (abortSignal) =>
        client.send(
          new CreateQueueCommand({ QueueName, Attributes: { FifoQueue: 'true' } }),
          { abortSignal },
        ),
      environment.COMMAND_BROKER_TIMEOUT_MS,
    );
    return validateInput(queueResponseSchema, response, invalidQueueResponse).QueueUrl;
  }

  try {
    const dlqUrl = await ensureQueue(environment.COMMAND_DLQ_QUEUE);
    const response: unknown = await queueDeadline(
      (abortSignal) =>
        client.send(
          new GetQueueAttributesCommand({
            QueueUrl: dlqUrl,
            AttributeNames: ['QueueArn'],
          }),
          { abortSignal },
        ),
      environment.COMMAND_BROKER_TIMEOUT_MS,
    );
    const { Attributes } = validateInput(queueArnSchema, response, invalidQueueResponse);
    const sourceUrl = await ensureQueue(environment.COMMAND_SOURCE_QUEUE);
    await queueDeadline(
      (abortSignal) =>
        client.send(
          new SetQueueAttributesCommand({
            QueueUrl: sourceUrl,
            Attributes: {
              VisibilityTimeout: environment.COMMAND_VISIBILITY_SEC.toString(),
              RedrivePolicy: JSON.stringify({
                deadLetterTargetArn: Attributes.QueueArn,
                maxReceiveCount: environment.COMMAND_MAX_RECEIVE_COUNT,
              }),
            },
          }),
          { abortSignal },
        ),
      environment.COMMAND_BROKER_TIMEOUT_MS,
    );
    const eventsUrl = await ensureQueue(environment.EVENT_QUEUE);
    await queueDeadline(
      (abortSignal) =>
        client.send(
          new SetQueueAttributesCommand({
            QueueUrl: eventsUrl,
            Attributes: {
              ContentBasedDeduplication: 'false',
              VisibilityTimeout: '30',
              // An empty value removes an old policy without deleting queued events.
              RedrivePolicy: '',
            },
          }),
          { abortSignal },
        ),
      environment.COMMAND_BROKER_TIMEOUT_MS,
    );
  } catch (cause) {
    throw translateQueueError(cause);
  } finally {
    client.destroy();
  }
}

try {
  await bootstrapQueues();
} catch (cause) {
  reportFailure(cause);
}
