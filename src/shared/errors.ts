export type ErrorCategory =
  | 'AuthenticationError'
  | 'NotFoundError'
  | 'ValidationError'
  | 'ExternalConnectionError'
  | 'DatabaseConstraintError'
  | 'DatabaseOperationError'
  | 'BusinessRuleError'
  | 'ConflictError'
  | 'ServerError';

interface ErrorDefinition {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly message: string;
  readonly publicMessage: string;
}

/** Base application error carrying error categories, machine-readable codes, and public messages. */
export class ApplicationError<Metadata extends object = object> extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly publicMessage: string;
  readonly metadata: Readonly<Metadata> | undefined;

  static is(value: unknown): value is ApplicationError {
    return value instanceof ApplicationError;
  }

  constructor(definition: ErrorDefinition, metadata?: Metadata, cause?: unknown) {
    super(definition.message, cause === undefined ? undefined : { cause });
    this.name = definition.category;
    this.category = definition.category;
    this.code = definition.code;
    this.publicMessage = definition.publicMessage;
    this.metadata = metadata === undefined ? undefined : Object.freeze(metadata);
  }

  toJSON() {
    return { category: this.category, code: this.code, message: this.publicMessage };
  }
}

export const boundaryErrors = {
  conflict: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'ConflictError',
        code: 'HTTP_REQUEST_CONFLICT',
        message: 'The HTTP framework rejected the request due to a resource conflict.',
        publicMessage: 'The request conflicts with the current resource state.',
      },
      undefined,
      cause,
    ),
  businessRule: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'BusinessRuleError',
        code: 'HTTP_BUSINESS_RULE_REJECTED',
        message: 'The HTTP framework rejected the request as an unprocessable operation.',
        publicMessage: 'The request cannot be processed.',
      },
      undefined,
      cause,
    ),
  unavailable: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'ExternalConnectionError',
        code: 'HTTP_SERVICE_UNAVAILABLE',
        message: 'The HTTP framework reported that a required service is unavailable.',
        publicMessage: 'A required service is unavailable.',
      },
      undefined,
      cause,
    ),
  authentication: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'AuthenticationError',
        code: 'AUTHENTICATION_REQUIRED',
        message: 'The HTTP framework rejected the request authentication.',
        publicMessage: 'Authentication is required.',
      },
      undefined,
      cause,
    ),
  payloadTooLarge: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'ValidationError',
        code: 'HTTP_REQUEST_TOO_LARGE',
        message: 'The HTTP framework rejected the request body size.',
        publicMessage: 'The request body exceeds the size limit.',
      },
      undefined,
      cause,
    ),
  validation: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'ValidationError',
        code: 'HTTP_REQUEST_INVALID',
        message: 'The HTTP framework rejected the request format.',
        publicMessage: 'The request is invalid.',
      },
      undefined,
      cause,
    ),
  unexpected: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'ServerError',
        code: 'SERVER_ERROR',
        message: 'An unexpected application failure occurred.',
        publicMessage: 'The server cannot complete this request.',
      },
      undefined,
      cause,
    ),
  notFound: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'NotFoundError',
        code: 'ROUTE_NOT_FOUND',
        message: 'No HTTP route matches the request.',
        publicMessage: 'The requested resource was not found.',
      },
      undefined,
      cause,
    ),
};
