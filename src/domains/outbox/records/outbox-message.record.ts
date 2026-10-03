import { OptionalProps } from '@mikro-orm/core';

export class OutboxMessageRecord {
  [OptionalProps]?: 'occurredAt' | 'attempts' | 'createdAt' | 'updatedAt';
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
  claimToken?: string | null;
  claimExpiresAt?: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}
