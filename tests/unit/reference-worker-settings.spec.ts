import { describe, expect, it } from 'bun:test';
import { getReferenceWorkerSettings } from '../../src/core/config/reference-worker.settings.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

describe('ReferenceWorkerSettings Validation', () => {
  it.each([false, true])('parses explicit enabled toggle: %s', (enabled) => {
    const settings = getReferenceWorkerSettings({
      REFERENCE_WORKER_ENABLED: enabled.toString(),
    });
    expect(settings.REFERENCE_WORKER_ENABLED).toBe(enabled);
  });

  it.each(['0', '-1', 'abc'])('rejects non-positive REFERENCE_TTL_MS: %s', (value) => {
    let thrown: unknown;
    try {
      getReferenceWorkerSettings({ REFERENCE_TTL_MS: value });
    } catch (error) {
      thrown = error;
    }
    expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
  });

  it('rejects REFERENCE_TTL_MS exceeding 32-bit signed integer boundary', () => {
    let thrown: unknown;
    try {
      getReferenceWorkerSettings({ REFERENCE_TTL_MS: '2147483648' });
    } catch (error) {
      thrown = error;
    }
    expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
  });

  it('accepts REFERENCE_TTL_MS at upper integer boundary 2147483647', () => {
    const settings = getReferenceWorkerSettings({
      REFERENCE_TTL_MS: '2147483647',
    });
    expect(settings.REFERENCE_TTL_MS).toBe(2147483647);
  });

  it.each(['0', '-10'])('rejects non-positive REFERENCE_POLL_MS: %s', (value) => {
    let thrown: unknown;
    try {
      getReferenceWorkerSettings({ REFERENCE_POLL_MS: value });
    } catch (error) {
      thrown = error;
    }
    expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
  });

  it.each(['0', '300001'])('rejects out-of-bounds REFERENCE_LEASE_MS: %s', (value) => {
    let thrown: unknown;
    try {
      getReferenceWorkerSettings({ REFERENCE_LEASE_MS: value });
    } catch (error) {
      thrown = error;
    }
    expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
  });

  it('accepts upper store boundary REFERENCE_LEASE_MS of 300000', () => {
    const settings = getReferenceWorkerSettings({
      REFERENCE_LEASE_MS: '300000',
    });
    expect(settings.REFERENCE_LEASE_MS).toBe(300000);
  });

  it.each(['0', '-5'])('rejects non-positive REFERENCE_RETRY_BASE_MS: %s', (value) => {
    let thrown: unknown;
    try {
      getReferenceWorkerSettings({ REFERENCE_RETRY_BASE_MS: value });
    } catch (error) {
      thrown = error;
    }
    expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
  });

  it.each(['0', '300001'])(
    'rejects out-of-bounds REFERENCE_RETRY_MAX_MS: %s',
    (value) => {
      let thrown: unknown;
      try {
        getReferenceWorkerSettings({ REFERENCE_RETRY_MAX_MS: value });
      } catch (error) {
        thrown = error;
      }
      expectApplicationError(thrown, {
        category: 'ServerError',
        code: 'ENVIRONMENT_INVALID',
      });
    },
  );

  it('rejects retry base delay greater than retry max delay', () => {
    let thrown: unknown;
    try {
      getReferenceWorkerSettings({
        REFERENCE_RETRY_BASE_MS: '10000',
        REFERENCE_RETRY_MAX_MS: '5000',
      });
    } catch (error) {
      thrown = error;
    }
    expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
  });

  it('accepts equal retry base delay and retry max delay', () => {
    const settings = getReferenceWorkerSettings({
      REFERENCE_RETRY_BASE_MS: '5000',
      REFERENCE_RETRY_MAX_MS: '5000',
    });
    expect(settings.REFERENCE_RETRY_BASE_MS).toBe(5000);
    expect(settings.REFERENCE_RETRY_MAX_MS).toBe(5000);
  });

  it.each(['5000', '4000'])(
    'rejects REFERENCE_LEASE_MS when not strictly greater than OPERATION_TIMEOUT_MS: %s',
    (leaseMs) => {
      let thrown: unknown;
      try {
        getReferenceWorkerSettings({
          OPERATION_TIMEOUT_MS: '5000',
          REFERENCE_LEASE_MS: leaseMs,
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
});
