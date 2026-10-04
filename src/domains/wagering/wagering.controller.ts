import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { z } from 'zod';
import { externalProviderIdSchema } from '../../shared/identifiers.js';
import { validateInput } from '../../shared/validation.js';
import { FinancialUseCase, type FinancialResult } from './financial.use-case.js';
import { wageringErrors } from './wagering.errors.js';
import {
  type WagerTransactionQueryResult,
  WageringQueryUseCase,
} from './wagering-query.use-case.js';

const localProviderSchema = z.object({ providerId: externalProviderIdSchema });
const statusByResult: Record<FinancialResult['status'], number> = {
  PROCESSED: HttpStatus.OK,
  PENDING_REFERENCE: HttpStatus.ACCEPTED,
  REJECTED: HttpStatus.UNPROCESSABLE_ENTITY,
  FAILED: HttpStatus.INTERNAL_SERVER_ERROR,
};

/**
 * Exposes HTTP endpoints for wagering transactions and transaction queries.
 */
@Controller()
export class WageringController {
  constructor(
    @Inject(WageringQueryUseCase)
    private readonly wageringQueryUseCase: WageringQueryUseCase,
    @Inject(FinancialUseCase)
    private readonly financialUseCase: FinancialUseCase,
  ) {}

  /**
   * Submits a financial wager transaction for processing.
   */
  @Post('wagering/transactions')
  @HttpCode(HttpStatus.OK)
  async submitTransaction(
    @Body() body: unknown,
    @Req() request: IncomingMessage,
    @Res({ passthrough: true }) response: ServerResponse,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<FinancialResult> {
    // Validate that the request supplies exactly one Idempotency-Key header.
    let headerCount = 0;
    let idempotencyKey: string | undefined;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === 'idempotency-key') {
        headerCount++;
        idempotencyKey = request.rawHeaders[index + 1];
      }
    }
    if (headerCount !== 1) {
      throw wageringErrors.invalidIdempotencyKey(
        new Error('Exactly one Idempotency-Key header is required.'),
      );
    }

    // Local HTTP is deliberately unauthenticated: the caller selects its provider namespace.
    // Trusted transports still supply their independently resolved identity to the use case.
    const { providerId } = validateInput(
      localProviderSchema,
      body,
      wageringErrors.invalidInput,
    );

    const result = await this.financialUseCase.execute(body, idempotencyKey, {
      providerId,
      correlationId: correlationId ?? randomUUID(),
    });

    response.statusCode = statusByResult[result.status];
    return result;
  }

  /**
   * Retrieves a wager transaction by its internal identifier.
   */
  @Get('wagering/transactions/:transactionId')
  async getTransactionById(
    @Param('transactionId') transactionId: string,
  ): Promise<WagerTransactionQueryResult> {
    return this.wageringQueryUseCase.getTransactionById(transactionId);
  }

  /**
   * Retrieves a wager transaction by provider and external transaction identifiers.
   */
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getTransactionByExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionQueryResult> {
    return this.wageringQueryUseCase.getTransactionByExternal(
      providerId,
      externalTransactionId,
    );
  }
}
