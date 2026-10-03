import { describe, expect, it } from 'bun:test';
import { getCommandConsumerSettings } from '../../src/core/config/command-consumer.settings.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

describe('CommandConsumerSettings Validation', () => {
  it.each([true, false])('parses an explicit enabled flag: %s', (enabled) => {
    const settings = getCommandConsumerSettings({
      COMMAND_CONSUMER_ENABLED: enabled.toString(),
    });
    expect(settings.COMMAND_CONSUMER_ENABLED).toBe(enabled);
  });

  it('rejects queue names that do not end with .fifo', () => {
    let thrown: unknown;
    try {
      getCommandConsumerSettings({ COMMAND_SOURCE_QUEUE: 'invalid-name' });
    } catch (error) {
      thrown = error;
    }
    expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
  });

  it('rejects identical source and dead-letter queue names', () => {
    let thrown: unknown;
    try {
      getCommandConsumerSettings({
        COMMAND_SOURCE_QUEUE: 'same-queue.fifo',
        COMMAND_DLQ_QUEUE: 'same-queue.fifo',
      });
    } catch (error) {
      thrown = error;
    }
    expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
  });

  it.each([6000, 5000])(
    'rejects renewal that cannot finish within visibility: %i',
    (renewMs) => {
      let thrown: unknown;
      try {
        getCommandConsumerSettings({
          COMMAND_VISIBILITY_SEC: '10',
          COMMAND_RENEW_MS: renewMs.toString(),
          COMMAND_BROKER_TIMEOUT_MS: '5000',
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

  it('rejects retry base delay greater than retry maximum delay', () => {
    let thrown: unknown;
    try {
      getCommandConsumerSettings({
        COMMAND_RETRY_BASE_SEC: '70',
        COMMAND_RETRY_MAX_SEC: '60',
      });
    } catch (error) {
      thrown = error;
    }
    expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
  });
});
