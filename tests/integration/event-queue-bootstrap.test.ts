import { afterAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const suffix = randomUUID();
const names = {
  source: `bootstrap-source-${suffix}.fifo`,
  dlq: `bootstrap-dlq-${suffix}.fifo`,
  events: `bootstrap-events-${suffix}.fifo`,
};
const endpoint = process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4567';
const client = new SQSClient({
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  maxAttempts: 1,
});
const urls = new Set<string>();
afterAll(async () => {
  for (const url of urls) await client.send(new DeleteQueueCommand({ QueueUrl: url }));
  client.destroy();
});
async function bootstrap(): Promise<void> {
  const child = Bun.spawn([process.execPath, 'scripts/bootstrap-queues.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://jungle_main:main_local@127.0.0.1:55432/jungle_test',
      SQS_ENDPOINT: endpoint,
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      LEDGER_CURSOR_SECRET: 'bootstrap-test-ledger-cursor-secret',
      COMMAND_SOURCE_QUEUE: names.source,
      COMMAND_DLQ_QUEUE: names.dlq,
      EVENT_QUEUE: names.events,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  assert.equal(await child.exited, 0, 'Queue bootstrap failed.');
  for (const name of Object.values(names)) {
    const queue = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    assert(queue.QueueUrl);
    urls.add(queue.QueueUrl);
  }
}

test('bootstrap adds the dedicated FIFO event destination, retains messages, and has no event DLQ', async () => {
  await bootstrap();
  const response = await client.send(new GetQueueUrlCommand({ QueueName: names.events }));
  assert(response.QueueUrl);
  const url = response.QueueUrl;
  const eventId = randomUUID();
  const body = JSON.stringify({ eventId });
  await client.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: body,
      MessageGroupId: randomUUID(),
      MessageDeduplicationId: eventId,
    }),
  );
  await bootstrap();
  expect(
    (await client.send(new GetQueueUrlCommand({ QueueName: names.events }))).QueueUrl,
  ).toBe(url);
  const attributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['FifoQueue', 'ContentBasedDeduplication', 'RedrivePolicy'],
    }),
  );
  expect(attributes.Attributes?.FifoQueue).toBe('true');
  expect(attributes.Attributes?.ContentBasedDeduplication).toBe('false');
  expect(attributes.Attributes?.RedrivePolicy).toBeUndefined();
  const received = await client.send(
    new ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 1 }),
  );
  expect(received.Messages?.map((message) => message.Body)).toEqual([body]);
}, 20000);
