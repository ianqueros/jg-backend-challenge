import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { DatabaseTransactionRunner } from './database/database-transaction.runner.js';
import { healthErrors } from '../domains/health/health.errors.js';

/** Drains admitted database work, then cancels it if the shutdown grace period expires. */
export class ShutdownState {
  stopping = false;
  readonly deadline = new AbortController();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly databaseTransactionRunner: DatabaseTransactionRunner,
    private readonly graceMs: number,
  ) {}

  /** Closes admission and starts the grace-period timer for forced cancellation. */
  onModuleDestroy(): void {
    this.stopping = true;

    this.timer = setTimeout(() => {
      this.deadline.abort();
      this.databaseTransactionRunner.cancelActive();
    }, this.graceMs);
    this.timer.unref();
  }

  /** Keeps dependencies open until admitted database operations finish. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.databaseTransactionRunner.drain();
  }

  /** Clears the grace-period timer after shutdown completes. */
  onApplicationShutdown(): void {
    clearTimeout(this.timer);
  }
}

/** Rejects new HTTP work during shutdown while keeping the liveness route available. */
@Injectable()
export class AdmissionGuard implements CanActivate {
  constructor(@Inject(ShutdownState) private readonly shutdownState: ShutdownState) {}

  /** Keeps liveness reachable but rejects other requests after admission closes. */
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ url: string; route?: { path?: string } }>();

    let path = request.route?.path;
    if (path == null) {
      const queryIndex = request.url.indexOf('?');
      const urlPath = queryIndex === -1 ? request.url : request.url.slice(0, queryIndex);
      path = urlPath.replace(/\/+$/, '');
    }

    if (this.shutdownState.stopping && path !== '/health/live') {
      throw healthErrors.dependenciesUnavailable(undefined);
    }

    return true;
  }
}
