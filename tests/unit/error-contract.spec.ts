import { describe, expect, it } from 'bun:test';
import { translateQueueError } from '../../src/core/sqs.errors.js';
import { ApplicationError } from '../../src/shared/errors.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

describe('ApplicationError Contract', () => {
  it('protects metadata against post-construction mutation', () => {
    const metadata = { accountId: 'acc-42' };
    const error = new ApplicationError(
      {
        category: 'BusinessRuleError',
        code: 'ACTION_REJECTED',
        message: 'Action rejected by policy.',
        publicMessage: 'The action was rejected.',
      },
      metadata,
    );

    Reflect.set(error.metadata as object, 'accountId', 'mutated-account');
    expect(error.metadata?.accountId).toBe('acc-42');
  });

  it('serializes toJSON with strictly category, code, and safe public message', () => {
    const sensitiveCause = new Error(
      'Database password was incorrect in connection string',
    );
    const privateMetadata = {
      internalHost: 'db.internal.jungle',
      queryDurationMs: 450,
      statement: 'SELECT * FROM secret_table',
    };

    const error = new ApplicationError(
      {
        category: 'DatabaseOperationError',
        code: 'DATABASE_OPERATION_FAILED',
        message:
          'Internal query failure on host db.internal.jungle: secret_table inaccessible',
        publicMessage: 'The server cannot complete this database operation.',
      },
      privateMetadata,
      sensitiveCause,
    );

    const serialized = error.toJSON();

    expect(Object.keys(serialized).sort()).toEqual(['category', 'code', 'message']);
    expect(serialized.category).toBe('DatabaseOperationError');
    expect(serialized.code).toBe('DATABASE_OPERATION_FAILED');
    expect(serialized.message).toBe(
      'The server cannot complete this database operation.',
    );

    const rawJson = JSON.stringify(error);
    expect(rawJson).not.toContain('secret_table');
    expect(rawJson).not.toContain('db.internal.jungle');
    expect(rawJson).not.toContain('Database password');
    expect(rawJson).not.toContain('Internal query failure');
    expect(rawJson).not.toContain('metadata');
    expect(rawJson).not.toContain('cause');
    expect(rawJson).not.toContain('stack');
  });

  it('translates SQS connection errors and preserves cause', () => {
    const connectionError = Object.assign(new Error('Connection dropped by broker'), {
      code: 'ECONNREFUSED',
    });

    const translated = expectApplicationError(translateQueueError(connectionError), {
      category: 'ExternalConnectionError',
      code: 'QUEUE_CONNECTION_FAILED',
    });
    expect(translated.cause).toBe(connectionError);

    const timeoutError = Object.assign(new Error('Queue operation timed out'), {
      name: 'TimeoutError',
    });
    expectApplicationError(translateQueueError(timeoutError), {
      category: 'ExternalConnectionError',
      code: 'QUEUE_CONNECTION_FAILED',
    });
  });

  it('translates generic SQS operation errors to ServerError', () => {
    const genericError = new Error('Unknown AWS SDK error');
    const translated = expectApplicationError(translateQueueError(genericError), {
      category: 'ServerError',
      code: 'QUEUE_OPERATION_FAILED',
    });
    expect(translated.cause).toBe(genericError);
  });

  it('does not treat inherited prototype properties as connection codes', () => {
    const prototypeAttackError = Object.assign(new Error('SDK error'), {
      name: 'constructor',
      code: 'toString',
    });

    expectApplicationError(translateQueueError(prototypeAttackError), {
      category: 'ServerError',
      code: 'QUEUE_OPERATION_FAILED',
    });
  });

  it('passes through existing ApplicationError unchanged in translateQueueError', () => {
    const existing = new ApplicationError({
      category: 'ExternalConnectionError',
      code: 'QUEUE_CUSTOM_UNAVAILABLE',
      message: 'Custom queue error',
      publicMessage: 'Queue unavailable',
    });

    const translated = translateQueueError(existing);
    expect(translated).toBe(existing);
  });
});
