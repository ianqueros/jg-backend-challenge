import { ApplicationError } from './errors.js';

export function nullTransactionReference() {
  return new ApplicationError({
    category: 'ValidationError',
    code: 'TRANSACTION_REFERENCE_NULL',
    message: 'An absent transaction reference must be omitted, not set to null.',
    publicMessage: 'An absent transaction reference must be omitted.',
  });
}
