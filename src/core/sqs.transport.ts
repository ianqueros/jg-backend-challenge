import { SQSClient } from '@aws-sdk/client-sqs';

interface QueueConnection {
  SQS_ENDPOINT: string;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}

export function createQueueClient(settings: QueueConnection): SQSClient {
  return new SQSClient({
    endpoint: settings.SQS_ENDPOINT,
    region: settings.AWS_REGION,
    credentials: {
      accessKeyId: settings.AWS_ACCESS_KEY_ID,
      secretAccessKey: settings.AWS_SECRET_ACCESS_KEY,
    },
    maxAttempts: 1,
  });
}

/** Gives one broker request a deadline and honors caller cancellation if supplied. */
export async function queueDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort();
  }, timeoutMs);

  try {
    return await operation(
      signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]),
    );
  } finally {
    clearTimeout(timer);
  }
}
