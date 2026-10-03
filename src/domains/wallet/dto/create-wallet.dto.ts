import { z } from 'zod';
import { moneyPropsSchema } from '../../../shared/money.js';
import { validateInput } from '../../../shared/validation.js';
import { walletErrors } from '../wallet.errors.js';

const createWalletSchema = z
  .object({
    playerId: z.uuid(),
    initialBalance: moneyPropsSchema,
  })
  .strict();

export type CreateWalletDto = z.infer<typeof createWalletSchema>;

/** Validates input payload against the wallet creation schema. */
export function validateCreateWallet(input: unknown): CreateWalletDto {
  return validateInput(createWalletSchema, input, walletErrors.invalidInput);
}
