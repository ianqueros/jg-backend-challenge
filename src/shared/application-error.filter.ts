import {
  ArgumentsHost,
  Catch,
  HttpException,
  Inject,
  Injectable,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ApplicationError, boundaryErrors, type ErrorCategory } from './errors.js';

const statusByCategory: Record<ErrorCategory, number> = {
  AuthenticationError: 401,
  NotFoundError: 404,
  ValidationError: 400,
  ExternalConnectionError: 503,
  DatabaseConstraintError: 500,
  DatabaseOperationError: 500,
  BusinessRuleError: 422,
  ConflictError: 409,
  ServerError: 500,
};

@Injectable()
@Catch()
/** Global HTTP exception filter translating application errors into standardized HTTP responses. */
export class ApplicationErrorFilter implements ExceptionFilter {
  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  catch(cause: unknown, host: ArgumentsHost): void {
    // Express body-limit errors reach this filter without Nest's HttpException wrapper.
    const tooLarge =
      cause instanceof HttpException
        ? cause.getStatus() === 413
        : cause instanceof Error &&
          'type' in cause &&
          cause.type === 'entity.too.large' &&
          'status' in cause &&
          cause.status === 413;
    const error = tooLarge
      ? boundaryErrors.payloadTooLarge(cause)
      : this.translate(cause);
    this.adapterHost.httpAdapter.reply(
      host.switchToHttp().getResponse(),
      error.toJSON(),
      tooLarge ? 413 : statusByCategory[error.category],
    );
  }

  private translate(cause: unknown): ApplicationError {
    if (ApplicationError.is(cause)) {
      return cause;
    }
    if (cause instanceof HttpException) {
      switch (cause.getStatus()) {
        case 400:
          return boundaryErrors.validation(cause);
        case 401:
          return boundaryErrors.authentication(cause);
        case 404:
          return boundaryErrors.notFound(cause);
        case 409:
          return boundaryErrors.conflict(cause);
        case 422:
          return boundaryErrors.businessRule(cause);
        case 503:
          return boundaryErrors.unavailable(cause);
      }
    }
    return boundaryErrors.unexpected(cause);
  }
}
