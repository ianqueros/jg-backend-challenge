import { z } from 'zod';
import { validateInput } from '../../../shared/validation.js';
import { messagingErrors } from '../messaging.errors.js';
import {
  idempotencyKeyHeaderSchema,
  submitWagerTransactionSchema,
} from '../../wagering/dto/submit-wager-transaction.dto.js';

const sqsWagerMessageSchema = z
  .object({
    messageId: z.string().min(1).max(128),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.iso.datetime(),
    data: submitWagerTransactionSchema
      .extend({
        idempotencyKey: idempotencyKeyHeaderSchema,
      })
      .strict(),
  })
  .strict();

export type SqsWagerMessageDto = z.infer<typeof sqsWagerMessageSchema>;

/** Validates raw queue message payload against the wager command schema. */
export function validateSqsWagerMessage(input: unknown): SqsWagerMessageDto {
  return validateInput(sqsWagerMessageSchema, input, messagingErrors.invalidInput);
}
