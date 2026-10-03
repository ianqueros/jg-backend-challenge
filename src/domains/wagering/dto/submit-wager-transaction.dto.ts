import { z } from 'zod';
import {
  externalProviderIdSchema,
  opaqueIdentifierSchema,
} from '../../../shared/identifiers.js';
import { moneyPropsSchema } from '../../../shared/money.js';
import { validateInput } from '../../../shared/validation.js';
import { wageringErrors } from '../wagering.errors.js';

// Keys use visible ASCII without spaces.
const IDEMPOTENCY_KEY_REGEX = /^[\x21-\x7E]{1,256}$/;

export const idempotencyKeyHeaderSchema = z.string().regex(IDEMPOTENCY_KEY_REGEX, {
  message: 'Idempotency-Key must contain 1-256 visible ASCII characters without spaces',
});

export const submitWagerTransactionSchema = z
  .object({
    providerId: externalProviderIdSchema,
    externalTransactionId: opaqueIdentifierSchema,
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: opaqueIdentifierSchema,
    gameId: opaqueIdentifierSchema,
    kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
    money: moneyPropsSchema,
    referenceExternalTransactionId: opaqueIdentifierSchema.optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.kind !== 'LOSS' && data.money.amount === '0.00') {
        return false;
      }
      return true;
    },
    {
      message:
        'Financial operations other than LOSS must have an amount strictly greater than zero',
      path: ['money', 'amount'],
    },
  )
  .refine(
    (data) => {
      const requiresRef = data.kind === 'REFUND' || data.kind === 'ROLLBACK';
      if (requiresRef && !data.referenceExternalTransactionId) {
        return false;
      }
      return true;
    },
    {
      message: 'referenceExternalTransactionId is required for REFUND and ROLLBACK',
      path: ['referenceExternalTransactionId'],
    },
  );

export type SubmitWagerTransactionDto = z.infer<typeof submitWagerTransactionSchema>;

/**
 * Validates untrusted input against the wager transaction submission schema.
 */
export function validateSubmitWagerTransaction(
  input: unknown,
): SubmitWagerTransactionDto {
  return validateInput(submitWagerTransactionSchema, input, wageringErrors.invalidInput);
}

/**
 * Validates untrusted input against the idempotency key format schema.
 */
export function validateIdempotencyKey(input: unknown): string {
  return validateInput(
    idempotencyKeyHeaderSchema,
    input,
    wageringErrors.invalidIdempotencyKey,
  );
}
