import { describe, expect, it } from 'bun:test';
import { getOutboxPublisherSettings } from '../../src/core/config/outbox-publisher.settings.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

describe('OutboxPublisherSettings Validation', () => {
  it.each([
    ['true', true],
    ['false', false],
  ])('parses explicit enabled toggle: %s -> %s', (input, expected) => {
    const settings = getOutboxPublisherSettings({
      OUTBOX_PUBLISHER_ENABLED: input,
    });
    expect(settings.OUTBOX_PUBLISHER_ENABLED).toBe(expected);
  });

  it.each(['yes', 'no', '1', '0', 'TRUE', 'FALSE'])(
    'rejects non-boolean-string enabled toggle: %s',
    (invalid) => {
      let thrown: unknown;
      try {
        getOutboxPublisherSettings({ OUTBOX_PUBLISHER_ENABLED: invalid });
      } catch (error) {
        thrown = error;
      }
      expectApplicationError(thrown, {
        category: 'ServerError',
        code: 'ENVIRONMENT_INVALID',
      });
    },
  );

  it.each(['wager-events', 'wager-events.fifo.extra', 'has spaces.fifo', '', '.fifo'])(
    'rejects non-FIFO or malformed event queue name: %s',
    (invalidName) => {
      let thrown: unknown;
      try {
        getOutboxPublisherSettings({ EVENT_QUEUE: invalidName });
      } catch (error) {
        thrown = error;
      }
      expectApplicationError(thrown, {
        category: 'ServerError',
        code: 'ENVIRONMENT_INVALID',
      });
    },
  );

  it.each([1, 10, 50, 100])(
    'accepts valid OUTBOX_BATCH_SIZE within [1, 100]: %i',
    (batchSize) => {
      const settings = getOutboxPublisherSettings({
        OUTBOX_BATCH_SIZE: batchSize.toString(),
      });
      expect(settings.OUTBOX_BATCH_SIZE).toBe(batchSize);
    },
  );

  it.each(['0', '-1', '101', 'abc', '1.5'])(
    'rejects out-of-bounds or non-integer OUTBOX_BATCH_SIZE: %s',
    (invalidSize) => {
      let thrown: unknown;
      try {
        getOutboxPublisherSettings({ OUTBOX_BATCH_SIZE: invalidSize });
      } catch (error) {
        thrown = error;
      }
      expectApplicationError(thrown, {
        category: 'ServerError',
        code: 'ENVIRONMENT_INVALID',
      });
    },
  );

  it.each(['0', '-10', 'abc', '3600001'])(
    'rejects non-positive or out-of-bounds OUTBOX_POLL_MS: %s',
    (value) => {
      let thrown: unknown;
      try {
        getOutboxPublisherSettings({ OUTBOX_POLL_MS: value });
      } catch (error) {
        thrown = error;
      }
      expectApplicationError(thrown, {
        category: 'ServerError',
        code: 'ENVIRONMENT_INVALID',
      });
    },
  );

  it.each(['0', '-1', 'abc'])(
    'rejects non-positive OUTBOX_BROKER_TIMEOUT_MS: %s',
    (value) => {
      let thrown: unknown;
      try {
        getOutboxPublisherSettings({ OUTBOX_BROKER_TIMEOUT_MS: value });
      } catch (error) {
        thrown = error;
      }
      expectApplicationError(thrown, {
        category: 'ServerError',
        code: 'ENVIRONMENT_INVALID',
      });
    },
  );

  it('rejects OUTBOX_RETRY_BASE_MS greater than OUTBOX_RETRY_MAX_MS', () => {
    let thrown: unknown;
    try {
      getOutboxPublisherSettings({
        OUTBOX_RETRY_BASE_MS: '5000',
        OUTBOX_RETRY_MAX_MS: '2000',
      });
    } catch (error) {
      thrown = error;
    }
    expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
  });

  it('accepts equal OUTBOX_RETRY_BASE_MS and OUTBOX_RETRY_MAX_MS', () => {
    const settings = getOutboxPublisherSettings({
      OUTBOX_RETRY_BASE_MS: '3000',
      OUTBOX_RETRY_MAX_MS: '3000',
    });
    expect(settings.OUTBOX_RETRY_BASE_MS).toBe(3000);
    expect(settings.OUTBOX_RETRY_MAX_MS).toBe(3000);
  });

  it.each([
    { lease: '25000', broker: '5000', op: '10000' }, // 25000 is not strictly greater than 5000 + 20000
    { lease: '24999', broker: '5000', op: '10000' },
    { lease: '20000', broker: '5000', op: '10000' },
  ])(
    'rejects OUTBOX_LEASE_MS when not strictly greater than broker + 2 * OPERATION_TIMEOUT_MS: %j',
    ({ lease, broker, op }) => {
      let thrown: unknown;
      try {
        getOutboxPublisherSettings({
          OUTBOX_LEASE_MS: lease,
          OUTBOX_BROKER_TIMEOUT_MS: broker,
          OPERATION_TIMEOUT_MS: op,
        });
      } catch (error) {
        thrown = error;
      }
      expectApplicationError(thrown, {
        category: 'ServerError',
        code: 'ENVIRONMENT_INVALID',
      });
    },
  );

  it('accepts OUTBOX_LEASE_MS strictly greater than broker + 2 * OPERATION_TIMEOUT_MS', () => {
    const settings = getOutboxPublisherSettings({
      OUTBOX_LEASE_MS: '25001',
      OUTBOX_BROKER_TIMEOUT_MS: '5000',
      OPERATION_TIMEOUT_MS: '10000',
    });
    expect(settings.OUTBOX_LEASE_MS).toBe(25001);
  });
});
