import { createHash } from 'node:crypto';
import { nullTransactionReference } from './canonical-hash.errors.js';
import type { MoneyProps } from './money.js';

export const CANONICAL_HASH_VERSION = 'v1';

export interface CanonicalTransactionPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
}

export interface CanonicalInboxEnvelope {
  readonly type: string;
  readonly occurredAt: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Computes deterministic SHA-256 hash for transaction idempotency.
 * Sorts keys alphabetically; rejects null references to prevent replay collisions.
 */
export function computeCanonicalTransactionHash(
  data: CanonicalTransactionPayload,
): string {
  // Absence must be omitted so invalid null cannot become a valid replay.
  const rawRef = (data as unknown as Record<string, unknown>)[
    'referenceExternalTransactionId'
  ];
  if (rawRef === null) {
    throw nullTransactionReference();
  }

  const entries: string[] = [
    `"externalTransactionId":${JSON.stringify(data.externalTransactionId)}`,
    `"gameId":${JSON.stringify(data.gameId)}`,
    `"kind":${JSON.stringify(data.kind)}`,
    `"money":{"amount":${JSON.stringify(data.money.amount)},"currency":${JSON.stringify(data.money.currency)}}`,
    `"playerId":${JSON.stringify(data.playerId)}`,
    `"providerId":${JSON.stringify(data.providerId)}`,
    `"roundId":${JSON.stringify(data.roundId)}`,
    `"walletId":${JSON.stringify(data.walletId)}`,
  ];

  if (data.referenceExternalTransactionId !== undefined) {
    entries.push(
      `"referenceExternalTransactionId":${JSON.stringify(data.referenceExternalTransactionId)}`,
    );
  }

  entries.sort();
  const canonicalJson = `{${entries.join(',')}}`;
  return createHash('sha256').update(canonicalJson).digest('hex');
}

/**
 * Computes deterministic SHA-256 hash for inbox message deduplication.
 * Sorts root and nested keys iteratively to avoid recursive stack overhead.
 */
export function computeCanonicalInboxHash(envelope: CanonicalInboxEnvelope): string {
  const sortedDataKeys = Object.keys(envelope.data).sort();
  const dataPairs: string[] = [];

  for (const key of sortedDataKeys) {
    const val = envelope.data[key];
    if (val === undefined) {
      continue;
    }
    // Handle nested money object linearly to prevent unconstrained recursion.
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      const nestedObj = val as Record<string, unknown>;
      const nestedKeys = Object.keys(nestedObj).sort();
      const nestedPairs = nestedKeys
        .filter((k) => nestedObj[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${JSON.stringify(nestedObj[k])}`);
      dataPairs.push(`${JSON.stringify(key)}:{${nestedPairs.join(',')}}`);
      continue;
    }
    dataPairs.push(`${JSON.stringify(key)}:${JSON.stringify(val)}`);
  }

  const dataObjectLiteral = `{${dataPairs.join(',')}}`;
  const canonicalJson = `{"data":${dataObjectLiteral},"occurredAt":${JSON.stringify(envelope.occurredAt)},"type":${JSON.stringify(envelope.type)}}`;

  return createHash('sha256').update(canonicalJson).digest('hex');
}
