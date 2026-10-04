import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Param,
  Query,
} from '@nestjs/common';
import {
  type LedgerQueryResult,
  type WalletQueryResult,
  type WalletResult,
  WalletUseCase,
} from './wallet.use-case.js';
import {
  ReconciliationUseCase,
  type ReconciliationResult,
} from './reconciliation.use-case.js';

/** Exposes wallet creation, balance inspection, cursor ledger queries, and balance reconciliation. */
@Controller('wallets')
export class WalletController {
  constructor(
    @Inject(WalletUseCase) private readonly walletUseCase: WalletUseCase,
    @Inject(ReconciliationUseCase)
    private readonly reconciliationUseCase: ReconciliationUseCase,
  ) {}

  /** Retrieves current wallet balance and timestamps by wallet identifier. */
  @Get(':walletId')
  async getWallet(@Param('walletId') walletId: string): Promise<WalletQueryResult> {
    return this.walletUseCase.getWallet(walletId);
  }

  /** Retrieves a keyset-paginated slice of wallet ledger entries. */
  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LedgerQueryResult> {
    return this.walletUseCase.getLedger(walletId, { cursor, limit });
  }

  /** Reconciles wallet balance against cumulative ledger transactions. */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(
    @Param('walletId') walletId: string,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<ReconciliationResult> {
    return this.reconciliationUseCase.reconcile(walletId, correlationId);
  }

  /** Opens a new player wallet with an initial balance. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<WalletResult> {
    return this.walletUseCase.createWallet(body, { correlationId });
  }
}
