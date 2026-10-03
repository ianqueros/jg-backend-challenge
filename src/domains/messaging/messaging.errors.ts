import { ApplicationError } from '../../shared/errors.js';

export const messagingErrors = {
  invalidInput: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'ValidationError',
        code: 'SQS_WAGER_MESSAGE_INVALID',
        message: 'The queue message does not satisfy the wager message schema.',
        publicMessage: 'The queue message is invalid.',
      },
      undefined,
      cause,
    ),
  inboxAlreadyProcessed: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'INBOX_ALREADY_PROCESSED',
      message: 'The inbox message has already been processed.',
      publicMessage: 'The inbox message has already been processed.',
    }),
  outboxAlreadyPublished: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'OUTBOX_ALREADY_PUBLISHED',
      message: 'The outbox message has already been published.',
      publicMessage: 'The outbox message has already been published.',
    }),
  publishedRetry: () =>
    new ApplicationError({
      category: 'BusinessRuleError',
      code: 'OUTBOX_PUBLISHED_RETRY_PROHIBITED',
      message: 'A published outbox message cannot be scheduled for retry.',
      publicMessage: 'A published outbox message cannot be scheduled for retry.',
    }),
  walletLedgerMismatch: () =>
    new ApplicationError({
      category: 'ServerError',
      code: 'EVENT_WALLET_LEDGER_MISMATCH',
      message: 'The ledger entry does not belong to the event wallet.',
      publicMessage: 'The server cannot complete this request.',
    }),
  processedEventState: () =>
    new ApplicationError({
      category: 'ServerError',
      code: 'EVENT_PROCESSED_STATE_REQUIRED',
      message:
        'A processed event requires a processed transaction and its processing time.',
      publicMessage: 'The server cannot complete this request.',
    }),
  rejectedEventState: () =>
    new ApplicationError({
      category: 'ServerError',
      code: 'EVENT_REJECTED_STATE_REQUIRED',
      message:
        'A rejected event requires a rejected transaction, failure code, and closing time.',
      publicMessage: 'The server cannot complete this request.',
    }),
  pendingEventState: () =>
    new ApplicationError({
      category: 'ServerError',
      code: 'EVENT_PENDING_REFERENCE_STATE_REQUIRED',
      message:
        'A pending reference event requires a transaction that waits for a reference.',
      publicMessage: 'The server cannot complete this request.',
    }),
};
