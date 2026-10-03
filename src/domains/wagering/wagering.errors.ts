import { ApplicationError } from '../../shared/errors.js';

export const wageringErrors = {
  providerMismatch: () =>
    new ApplicationError({
      category: 'AuthenticationError',
      code: 'WAGER_PROVIDER_MISMATCH',
      message: 'The submitted provider does not match the trusted provider.',
      publicMessage: 'The provider is not authorized.',
    }),
  idempotencyConflict: () =>
    new ApplicationError({
      category: 'ConflictError',
      code: 'WAGER_IDEMPOTENCY_CONFLICT',
      message: 'The idempotency key identifies a different business payload.',
      publicMessage: 'The idempotency key conflicts with an accepted transaction.',
    }),
  externalIdentityConflict: () =>
    new ApplicationError({
      category: 'ConflictError',
      code: 'WAGER_EXTERNAL_IDENTITY_CONFLICT',
      message: 'The external identity belongs to another idempotency key.',
      publicMessage: 'The external transaction identity is already accepted.',
    }),
  inboxConflict: () =>
    new ApplicationError({
      category: 'ConflictError',
      code: 'INBOX_MESSAGE_CONFLICT',
      message: 'The consumer message identity belongs to a different envelope.',
      publicMessage: 'The message identity conflicts with an accepted command.',
    }),
  invalidInput: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'ValidationError',
        code: 'WAGER_INPUT_INVALID',
        message: 'The wager input does not satisfy the transaction request schema.',
        publicMessage: 'The wager input is invalid.',
      },
      undefined,
      cause,
    ),
  invalidIdempotencyKey: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'ValidationError',
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: 'The idempotency key does not satisfy the header schema.',
        publicMessage: 'The idempotency key is invalid.',
      },
      undefined,
      cause,
    ),
  negativeLoss: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_LOSS_AMOUNT_NEGATIVE',
      message: 'A loss amount cannot be negative.',
      publicMessage: 'A loss amount cannot be negative.',
    }),
  positiveAmountRequired: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_POSITIVE_AMOUNT_REQUIRED',
      message: 'This transaction kind requires a strictly positive amount.',
      publicMessage: 'This transaction kind requires a strictly positive amount.',
    }),
  externalReferenceRequired: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_EXTERNAL_REFERENCE_REQUIRED',
      message: 'This transaction kind requires an external reference identifier.',
      publicMessage: 'This transaction kind requires an external reference identifier.',
    }),
  negativeOpening: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_OPENING_AMOUNT_NEGATIVE',
      message: 'An opening amount cannot be negative.',
      publicMessage: 'An opening amount cannot be negative.',
    }),
  internalOpening: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_OPENING_INTERNAL_ONLY',
      message:
        'Opening transactions must be created through the internal opening operation.',
      publicMessage:
        'Opening transactions must be created through the internal opening operation.',
    }),
  resolvedReferenceRequired: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_RESOLVED_REFERENCE_REQUIRED',
      message: 'Processing this transaction requires a resolved reference identifier.',
      publicMessage:
        'Processing this transaction requires a resolved reference identifier.',
    }),
  pendingRequired: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_PENDING_STATE_REQUIRED',
      message: 'Only a pending transaction can wait for a reference.',
      publicMessage: 'Only a pending transaction can wait for a reference.',
    }),
  rollbackReferenceRequired: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_ROLLBACK_REFERENCE_REQUIRED',
      message: 'A rollback requires a reference to determine its ledger direction.',
      publicMessage: 'A rollback requires a reference to determine its ledger direction.',
    }),
  rollbackKindInvalid: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_ROLLBACK_REFERENCE_KIND_INVALID',
      message: 'A rollback can reference only a debit or credit transaction.',
      publicMessage: 'A rollback can reference only a debit or credit transaction.',
    }),
  noLedger: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_KIND_HAS_NO_LEDGER',
      message: 'This transaction kind does not change the wallet balance.',
      publicMessage: 'This transaction kind does not change the wallet balance.',
    }),
  referenceExternalIdMismatch: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_REFERENCE_EXTERNAL_ID_MISMATCH',
      message:
        'The reference external identifier does not match the requested identifier.',
      publicMessage:
        'The reference external identifier does not match the requested identifier.',
    }),
  referenceProviderMismatch: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_REFERENCE_PROVIDER_MISMATCH',
      message: 'The reference belongs to a different provider.',
      publicMessage: 'The reference belongs to a different provider.',
    }),
  referencePlayerMismatch: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_REFERENCE_PLAYER_MISMATCH',
      message: 'The reference belongs to a different player.',
      publicMessage: 'The reference belongs to a different player.',
    }),
  referenceWalletMismatch: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_REFERENCE_WALLET_MISMATCH',
      message: 'The reference belongs to a different wallet.',
      publicMessage: 'The reference belongs to a different wallet.',
    }),
  referenceCurrencyMismatch: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_REFERENCE_CURRENCY_MISMATCH',
      message: 'The reference uses a different currency.',
      publicMessage: 'The reference uses a different currency.',
    }),
  referenceRoundMismatch: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_REFERENCE_ROUND_MISMATCH',
      message: 'The reference belongs to a different round.',
      publicMessage: 'The reference belongs to a different round.',
    }),
  referenceNotProcessed: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_REFERENCE_NOT_PROCESSED',
      message: 'The reference transaction has not been processed.',
      publicMessage: 'The reference transaction has not been processed.',
    }),
  betReferenceRequired: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_BET_REFERENCE_REQUIRED',
      message: 'A win or refund can reference only a bet transaction.',
      publicMessage: 'The reference must be a bet transaction.',
    }),
  referenceAmountMismatch: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_REFERENCE_AMOUNT_MISMATCH',
      message: 'A reversal amount must equal its reference amount.',
      publicMessage: 'The reversal and reference amounts do not match.',
    }),
  terminalTransition: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'WAGER_TERMINAL_TRANSITION_PROHIBITED',
      message: 'A terminal transaction cannot change its status.',
      publicMessage: 'The transaction is already closed.',
    }),
  notFound: () =>
    new ApplicationError({
      category: 'NotFoundError',
      code: 'TRANSACTION_NOT_FOUND',
      message: 'The requested transaction was not found.',
      publicMessage: 'The requested transaction was not found.',
    }),
  invalidTransactionId: (cause?: unknown) =>
    new ApplicationError(
      {
        category: 'ValidationError',
        code: 'TRANSACTION_ID_INVALID',
        message: 'The transactionId must be a valid UUID.',
        publicMessage: 'The transactionId must be a valid UUID.',
      },
      undefined,
      cause,
    ),
};
