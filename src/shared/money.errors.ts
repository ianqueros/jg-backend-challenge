import { ApplicationError } from './errors.js';

export const moneyErrors = {
  unsupportedCurrency: (cause?: unknown) =>
    new ApplicationError(
      {
        category: 'ValidationError',
        code: 'UNSUPPORTED_CURRENCY',
        message: 'The currency is not supported by this application.',
        publicMessage: 'The currency is not supported.',
      },
      undefined,
      cause,
    ),
  invalidAmount: (cause?: unknown) =>
    new ApplicationError(
      {
        category: 'ValidationError',
        code: 'INVALID_MONEY_AMOUNT',
        message: 'The amount must use the required decimal format and supported range.',
        publicMessage: 'The amount has an invalid format or range.',
      },
      undefined,
      cause,
    ),
  currencyMismatch: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'CURRENCY_MISMATCH',
      message: 'The monetary operation requires the same currency for both values.',
      publicMessage: 'The currencies do not match.',
    }),
};
