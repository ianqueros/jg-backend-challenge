import { Controller, Get, Inject } from '@nestjs/common';
import { HealthUseCase } from './health.use-case.js';

/** Exposes liveness and dependency readiness checks for service orchestration. */
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthUseCase) private readonly healthUseCase: HealthUseCase) {}

  /** Confirms application process vitality. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Confirms external dependency availability before accepting traffic. */
  @Get('ready')
  async ready() {
    await this.healthUseCase.readiness();

    return { status: 'ok' };
  }
}
