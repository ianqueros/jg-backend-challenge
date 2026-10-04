import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';

const environment = z
  .object({ SQS_ENDPOINT: z.url().default('http://127.0.0.1:4567') })
  .parse(process.env);
const sqs = new SQSClient({
  endpoint: environment.SQS_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
let queueUrl: string;

beforeAll(async () => {
  const response: unknown = await sqs.send(
    new CreateQueueCommand({
      QueueName: 'jungle-it-' + crypto.randomUUID() + '.fifo',
      Attributes: { FifoQueue: 'true' },
    }),
  );
  queueUrl = z.object({ QueueUrl: z.url() }).parse(response).QueueUrl;
});

afterAll(async () => {
  await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  sqs.destroy();
});

test('real FIFO infrastructure preserves decimal strings through send, receive and acknowledgement', async () => {
  const message = { amount: '999999999999999999.99', currency: 'USD' } as const;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: crypto.randomUUID(),
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
  const response: unknown = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      WaitTimeSeconds: 1,
      MaxNumberOfMessages: 1,
    }),
  );
  const received = z
    .object({
      Messages: z.tuple([z.object({ Body: z.string(), ReceiptHandle: z.string() })]),
    })
    .parse(response).Messages[0];
  const body: unknown = JSON.parse(received.Body);
  expect(
    z
      .object({ amount: z.literal(message.amount), currency: z.literal('USD') })
      .strict()
      .parse(body),
  ).toEqual(message);
  await sqs.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: received.ReceiptHandle,
    }),
  );
  const empty: unknown = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1 }),
  );
  expect(
    z.object({ Messages: z.array(z.unknown()).optional() }).parse(empty).Messages ?? [],
  ).toEqual([]);
});
