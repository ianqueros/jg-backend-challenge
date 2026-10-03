import { ApplicationError } from '../../shared/errors.js';

export const walletErrors = {
  versionExhausted: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WALLET_VERSION_EXHAUSTED',
      message: 'The wallet version cannot exceed the PostgreSQL bigint range.',
      publicMessage: 'The wallet version has reached its maximum.',
    }),
  invalidInput: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'ValidationError',
        code: 'WALLET_INPUT_INVALID',
        message: 'The wallet input does not satisfy the wallet request schema.',
        publicMessage: 'The wallet input is invalid.',
      },
      undefined,
      cause,
    ),
  balanceOverflow: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WALLET_BALANCE_OUT_OF_RANGE',
      message: 'The wallet balance exceeds the database decimal range.',
      publicMessage: 'The wallet balance exceeds the database decimal range.',
    }),
  negativeOpeningBalance: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WALLET_OPENING_BALANCE_NEGATIVE',
      message: 'The initial wallet balance cannot be negative.',
      publicMessage: 'The initial wallet balance cannot be negative.',
    }),
  openingReferencesRequired: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WALLET_OPENING_REFERENCES_REQUIRED',
      message: 'A positive opening balance requires transaction and ledger identifiers.',
      publicMessage:
        'A positive opening balance requires transaction and ledger identifiers.',
    }),
  debitAmountInvalid: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WALLET_DEBIT_AMOUNT_INVALID',
      message: 'A debit requires a strictly positive amount.',
      publicMessage: 'A debit requires a strictly positive amount.',
    }),
  creditAmountInvalid: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WALLET_CREDIT_AMOUNT_INVALID',
      message: 'A credit requires a strictly positive amount.',
      publicMessage: 'A credit requires a strictly positive amount.',
    }),
  insufficientBalance: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WALLET_INSUFFICIENT_BALANCE',
      message: 'The available wallet balance is smaller than the debit amount.',
      publicMessage: 'The available wallet balance is smaller than the debit amount.',
    }),
  ledgerUnbalanced: () =>
    new ApplicationError({
      category: 'ServerError',
      code: 'LEDGER_ARITHMETIC_INVALID',
      message: 'The ledger balances do not match the amount and direction.',
      publicMessage: 'The server cannot complete this request.',
    }),
  alreadyExists: (cause?: unknown) =>
    new ApplicationError(
      {
        category: 'ConflictError',
        code: 'WALLET_ALREADY_EXISTS',
        message: 'A wallet already exists for this player and currency.',
        publicMessage: 'A wallet already exists for this player and currency.',
      },
      undefined,
      cause,
    ),
  notFound: (walletId?: string) =>
    new ApplicationError({
      category: 'NotFoundError',
      code: 'WALLET_NOT_FOUND',
      message: walletId
        ? `Wallet '${walletId}' was not found.`
        : 'The requested wallet was not found.',
      publicMessage: 'The requested wallet was not found.',
    }),
  invalidWalletId: (cause?: unknown) =>
    new ApplicationError(
      {
        category: 'ValidationError',
        code: 'WALLET_ID_INVALID',
        message: 'The walletId must be a valid UUID.',
        publicMessage: 'The walletId must be a valid UUID.',
      },
      undefined,
      cause,
    ),
  invalidPaginationLimit: (cause?: unknown) =>
    new ApplicationError(
      {
        category: 'ValidationError',
        code: 'PAGINATION_LIMIT_INVALID',
        message: 'The pagination limit must be an integer between 1 and 200.',
        publicMessage: 'The pagination limit must be an integer between 1 and 200.',
      },
      undefined,
      cause,
    ),
  invalidLedgerCursor: (cause?: unknown) =>
    new ApplicationError(
      {
        category: 'ValidationError',
        code: 'LEDGER_CURSOR_INVALID',
        message: 'The ledger pagination cursor is invalid or has an invalid signature.',
        publicMessage: 'The ledger pagination cursor is invalid.',
      },
      undefined,
      cause,
    ),
  ledgerCursorWalletMismatch: () =>
    new ApplicationError({
      category: 'ValidationError',
      code: 'LEDGER_CURSOR_WALLET_MISMATCH',
      message: 'The ledger cursor wallet does not match the requested wallet.',
      publicMessage: 'The ledger cursor wallet does not match the requested wallet.',
    }),
};
