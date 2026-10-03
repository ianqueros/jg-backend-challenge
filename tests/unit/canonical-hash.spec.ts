import { describe, expect, it } from 'bun:test';
import {
  type CanonicalInboxEnvelope,
  type CanonicalTransactionPayload,
  computeCanonicalInboxHash,
  computeCanonicalTransactionHash,
} from '../../src/shared/canonical-hash.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

describe('Canonical Hash (v1)', () => {
  const basePayload: CanonicalTransactionPayload = {
    providerId: 'provider-alpha',
    externalTransactionId: 'ext-tx-999',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-abc',
    gameId: 'game-fortune',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  it('computes deterministic SHA-256 hash irrespective of key definition order', () => {
    // Construct payload with reversed key order
    const reversedPayload = {
      walletId: basePayload.walletId,
      roundId: basePayload.roundId,
      providerId: basePayload.providerId,
      playerId: basePayload.playerId,
      money: { currency: 'BRL', amount: '25.00' },
      kind: basePayload.kind,
      gameId: basePayload.gameId,
      externalTransactionId: basePayload.externalTransactionId,
    } as CanonicalTransactionPayload;

    const hash1 = computeCanonicalTransactionHash(basePayload);
    const hash2 = computeCanonicalTransactionHash(reversedPayload);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex string
  });

  it('changes hash when any business field changes', () => {
    const hashOriginal = computeCanonicalTransactionHash(basePayload);
    const hashModified = computeCanonicalTransactionHash({
      ...basePayload,
      money: { amount: '25.01', currency: 'BRL' },
    });

    expect(hashOriginal).not.toBe(hashModified);
  });

  it('differentiates omitted reference from provided reference', () => {
    const hashWithoutRef = computeCanonicalTransactionHash(basePayload);
    const hashWithRef = computeCanonicalTransactionHash({
      ...basePayload,
      referenceExternalTransactionId: 'ref-bet-001',
    });

    expect(hashWithoutRef).not.toBe(hashWithRef);
  });

  it('rejects null for referenceExternalTransactionId', () => {
    const invalid = {
      ...basePayload,
      referenceExternalTransactionId: null as unknown as string,
    };
    let thrown: unknown;
    try {
      computeCanonicalTransactionHash(invalid);
    } catch (error) {
      thrown = error;
    }
    expectApplicationError(thrown, {
      category: 'ValidationError',
      code: 'TRANSACTION_REFERENCE_NULL',
    });
  });

  it('computes deterministic canonical inbox envelope hash', () => {
    const envelope: CanonicalInboxEnvelope = {
      type: 'WagerTransactionRequested',
      occurredAt: '2026-07-29T15:00:00.000Z',
      data: {
        providerId: 'provider-alpha',
        externalTransactionId: 'ext-123',
        money: { amount: '10.00', currency: 'BRL' },
      },
    };

    const envelopeReordered: CanonicalInboxEnvelope = {
      occurredAt: '2026-07-29T15:00:00.000Z',
      type: 'WagerTransactionRequested',
      data: {
        money: { currency: 'BRL', amount: '10.00' },
        externalTransactionId: 'ext-123',
        providerId: 'provider-alpha',
      },
    };

    const hash1 = computeCanonicalInboxHash(envelope);
    const hash2 = computeCanonicalInboxHash(envelopeReordered);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});
