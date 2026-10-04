import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getEnvironment } from '../../core/config/environment.js';
import { DatabaseTransactionRunner } from '../../core/database/database-transaction.runner.js';
import { GuardedUpdateConflictError } from '../../core/database/database.errors.js';
import { TransactionRepositories } from '../../shared/transaction-repositories.js';
import { Money, type MoneyProps } from '../../shared/money.js';
import { validateInput } from '../../shared/validation.js';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
  type EventContext,
} from '../messaging/entities/integration-event.entity.js';
import { OutboxMessage } from '../messaging/entities/outbox-message.entity.js';
import { WagerTransaction } from '../wagering/entities/wager-transaction.entity.js';
import { validateCreateWallet } from './dto/create-wallet.dto.js';
import { Wallet } from './entities/wallet.entity.js';
import { walletErrors } from './wallet.errors.js';
import { FinancialTelemetry } from '../../shared/financial.telemetry.js';
import { ApplicationError } from '../../shared/errors.js';
import { INTERNAL_PROVIDER_ID } from '../../shared/internal-provider.js';

export interface WalletCreationContext {
  readonly walletId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
}

export interface WalletResult {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: string;
}

export interface WalletQueryResult extends WalletResult {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LedgerQueryOptions {
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

interface LedgerQueryResultItem {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: string;
  readonly createdAt: string;
}

export interface LedgerQueryResult {
  readonly items: readonly LedgerQueryResultItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const versionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const cursorSchema = z
  .object({
    v: z.literal(1),
    w: z.uuid(),
    p: versionSchema,
    c: versionSchema,
    s: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict()
  .refine((value) => BigInt(value.p) <= BigInt(value.c));
type LedgerCursor = z.infer<typeof cursorSchema>;

/**
 * Coordinates wallet lifecycle operations and ledger queries.
 * Enforces money movement invariants, manages opening balance transactions,
 * and provides tamper-evident keyset pagination for wallet ledger entries.
 */
export class WalletUseCase {
  constructor(
    private readonly databaseTransactionRunner: DatabaseTransactionRunner,
    private readonly financialTelemetry = new FinancialTelemetry(),
  ) {}

  /** Retrieves current wallet balance and timestamps by wallet identifier. */
  async getWallet(walletId: string): Promise<WalletQueryResult> {
    const id = validateInput(uuidSchema, walletId, walletErrors.invalidWalletId);

    return this.databaseTransactionRunner.run(async (entityManager) => {
      const wallet = await new TransactionRepositories(
        entityManager,
      ).walletRepository.findById(id);
      if (wallet === undefined) throw walletErrors.notFound(id);

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: { amount: wallet.balance, currency: wallet.currency },
        version: wallet.version,
        createdAt: wallet.createdAt.toISOString(),
        updatedAt: wallet.updatedAt.toISOString(),
      };
    });
  }

  /** Retrieves a keyset-paginated slice of wallet ledger entries using a signed cursor. */
  async getLedger(
    walletId: string,
    options: LedgerQueryOptions = {},
  ): Promise<LedgerQueryResult> {
    const id = validateInput(uuidSchema, walletId, walletErrors.invalidWalletId);

    const rawLimit = options.limit === undefined ? 50 : options.limit;
    if (
      typeof rawLimit !== 'number' &&
      (typeof rawLimit !== 'string' || !/^[0-9]+$/.test(rawLimit))
    ) {
      throw walletErrors.invalidPaginationLimit();
    }
    const limit = validateInput(
      z.number().int().min(1).max(200),
      Number(rawLimit),
      walletErrors.invalidPaginationLimit,
    );

    const cursor =
      options.cursor === undefined ? undefined : this.decodeCursor(options.cursor);
    if (cursor !== undefined && cursor.w !== id) {
      throw walletErrors.ledgerCursorWalletMismatch();
    }

    return this.databaseTransactionRunner.run(async (entityManager) => {
      const transactionRepositories = new TransactionRepositories(entityManager);
      const wallet = await transactionRepositories.walletRepository.findById(id);
      if (wallet === undefined) throw walletErrors.notFound(id);

      // Keyset pagination pins ceilingVersion to snapshot the upper version boundary across pages.
      const ceilingVersion = cursor?.c ?? wallet.version;
      const rows = await transactionRepositories.walletRepository.findLedgerEntriesKeyset(
        id,
        cursor?.p ?? '0',
        ceilingVersion,
        limit + 1,
      );

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      const items = page.map((row): LedgerQueryResultItem => ({
        id: row.id,
        walletId: row.walletId,
        transactionId: row.transactionId,
        direction: validateInput(
          z.enum(['DEBIT', 'CREDIT']),
          row.direction,
          walletErrors.invalidInput,
        ),
        money: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balanceBefore, currency: row.currency },
        balanceAfter: { amount: row.balanceAfter, currency: row.currency },
        walletVersion: row.walletVersion,
        createdAt: row.createdAt.toISOString(),
      }));

      const last = page[page.length - 1];

      return {
        items,
        hasMore,
        nextCursor:
          hasMore && last !== undefined
            ? this.encodeCursor(id, last.walletVersion, ceilingVersion)
            : null,
      };
    });
  }

  /** Computes an HMAC-SHA256 signature across cursor fields to prevent client tampering. */
  private cursorSignature(cursor: Pick<LedgerCursor, 'v' | 'w' | 'p' | 'c'>): Buffer {
    return createHmac('sha256', getEnvironment().LEDGER_CURSOR_SECRET)
      .update(JSON.stringify({ v: cursor.v, w: cursor.w, p: cursor.p, c: cursor.c }))
      .digest();
  }

  /** Serializes cursor fields and HMAC signature into a URL-safe base64 string. */
  private encodeCursor(
    walletId: string,
    afterVersion: string,
    ceilingVersion: string,
  ): string {
    const payload = { v: 1 as const, w: walletId, p: afterVersion, c: ceilingVersion };
    const s = this.cursorSignature(payload).toString('base64url');
    return Buffer.from(JSON.stringify({ ...payload, s })).toString('base64url');
  }

  /** Decodes and verifies the HMAC signature of a base64url ledger cursor. */
  private decodeCursor(encoded: string): LedgerCursor {
    let parsed: unknown;
    try {
      if (
        typeof encoded !== 'string' ||
        encoded.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(encoded)
      ) {
        throw walletErrors.invalidLedgerCursor();
      }
      const decoded = Buffer.from(encoded, 'base64url');
      if (decoded.toString('base64url') !== encoded) {
        throw walletErrors.invalidLedgerCursor();
      }
      parsed = JSON.parse(decoded.toString('utf8')) as unknown;
    } catch (cause) {
      throw walletErrors.invalidLedgerCursor(cause);
    }

    const cursor = validateInput(cursorSchema, parsed, walletErrors.invalidLedgerCursor);
    const actual = Buffer.from(cursor.s, 'base64url');
    const expected = this.cursorSignature(cursor);

    // Uses timingSafeEqual to prevent HMAC timing analysis attacks.
    if (
      actual.toString('base64url') !== cursor.s ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw walletErrors.invalidLedgerCursor();
    }

    return cursor;
  }

  /** Creates a new player wallet with either zero or funded opening balance. */
  async createWallet(
    input: unknown,
    context?: WalletCreationContext,
  ): Promise<WalletResult> {
    const data = validateCreateWallet(input);
    const initialMoney = Money.from(data.initialBalance);
    const started = performance.now();
    const openingTransactionId = randomUUID();
    const creationContext = {
      ...context,
      correlationId: context?.correlationId ?? randomUUID(),
    };
    const walletId = context?.walletId ?? randomUUID();

    const result = await this.databaseTransactionRunner
      .run(async (entityManager) => {
        const transactionRepositories = new TransactionRepositories(entityManager);
        const existing =
          await transactionRepositories.walletRepository.findByPlayerCurrency(
            data.playerId,
            data.initialBalance.currency,
          );
        if (existing !== undefined) {
          throw walletErrors.alreadyExists();
        }

        const timestamp = new Date();

        // Zero balance creates the wallet directly; positive balance requires an opening transaction.
        if (initialMoney.isZero()) {
          return this.createZeroWallet(
            transactionRepositories,
            data.playerId,
            initialMoney,
            walletId,
            timestamp,
          );
        }

        return this.createPositiveWallet(
          transactionRepositories,
          data.playerId,
          initialMoney,
          walletId,
          timestamp,
          openingTransactionId,
          creationContext,
        );
      })
      .catch((cause: unknown) => {
        if (!initialMoney.isZero()) {
          this.financialTelemetry.observe(
            'financial_processing_seconds',
            (performance.now() - started) / 1000,
          );
          this.financialTelemetry.log('financial_error', {
            correlationId: creationContext.correlationId,
            walletId,
            providerId: INTERNAL_PROVIDER_ID,
            code: ApplicationError.is(cause) ? cause.code : 'FINANCIAL_EXECUTION_FAILED',
          });
        }
        throw cause;
      });

    if (!initialMoney.isZero()) {
      this.financialTelemetry.increment('financial_status_total', 'PROCESSED');
      this.financialTelemetry.observe(
        'financial_processing_seconds',
        (performance.now() - started) / 1000,
      );
      this.financialTelemetry.log('financial_result', {
        correlationId: creationContext.correlationId,
        walletId: result.id,
        providerId: INTERNAL_PROVIDER_ID,
        transactionId: openingTransactionId,
        status: 'PROCESSED',
        replay: false,
      });
    }

    return result;
  }

  /** Inserts a zero-balance wallet without creating transactions or ledger entries. */
  private async createZeroWallet(
    transactionRepositories: TransactionRepositories,
    playerId: string,
    initialMoney: Money,
    walletId: string,
    timestamp: Date,
  ): Promise<WalletResult> {
    const { wallet } = Wallet.open({
      id: walletId,
      playerId,
      currency: initialMoney.currency,
      initialBalance: initialMoney,
      at: timestamp,
    });

    await transactionRepositories.walletRepository.insert({
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  /** Atomically creates a funded wallet, opening transaction, ledger entry, and outbox events. */
  private async createPositiveWallet(
    transactionRepositories: TransactionRepositories,
    playerId: string,
    initialMoney: Money,
    walletId: string,
    timestamp: Date,
    openingTransactionId: string,
    context?: WalletCreationContext,
  ): Promise<WalletResult> {
    const openingLedgerEntryId = randomUUID();

    const { wallet, openingLedger } = Wallet.open({
      id: walletId,
      playerId,
      currency: initialMoney.currency,
      initialBalance: initialMoney,
      openingTransactionId,
      openingLedgerEntryId,
      at: timestamp,
    });

    if (openingLedger === undefined) {
      throw new Error('Opening ledger entry is missing.');
    }

    const transaction = WagerTransaction.createOpening({
      id: openingTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: initialMoney,
      createdAt: timestamp,
    });

    transaction.markProcessed(undefined, timestamp);

    await transactionRepositories.walletRepository.insert({
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
    });

    const reservation =
      await transactionRepositories.wagerTransactionRepository.reserveIdentity({
        id: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        idempotencyKey: transaction.idempotencyKey,
        payloadHash: transaction.payloadHash,
        hashVersion: 'v1',
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: null,
        gameId: null,
        kind: transaction.kind,
        amount: transaction.money.toString(),
        currency: transaction.money.currency,
        referenceExternalTransactionId: null,
      });

    if (!reservation.inserted) {
      throw new GuardedUpdateConflictError();
    }

    await transactionRepositories.walletRepository.appendLedger({
      id: openingLedger.id,
      walletId: openingLedger.walletId,
      transactionId: openingLedger.transactionId,
      walletVersion: openingLedger.walletVersion,
      direction: openingLedger.direction,
      amount: openingLedger.money.toString(),
      currency: openingLedger.money.currency,
      balanceBefore: openingLedger.balanceBefore.toString(),
      balanceAfter: openingLedger.balanceAfter.toString(),
    });

    const result = {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
      walletVersion: wallet.version,
    };

    const finished =
      await transactionRepositories.wagerTransactionRepository.finalizeIfCurrent({
        id: transaction.id,
        expectedStatus: 'PENDING',
        status: 'PROCESSED',
        result,
        at: timestamp,
      });

    if (!finished) {
      throw new GuardedUpdateConflictError();
    }

    const eventContext: EventContext = {
      correlationId: context?.correlationId ?? randomUUID(),
      ...(context?.causationId !== undefined ? { causationId: context.causationId } : {}),
      occurredAt: timestamp,
    };

    const processedEvent = WagerTransactionProcessed.from(transaction, eventContext);
    const balanceChangedEvent = WalletBalanceChanged.from(
      wallet,
      openingLedger,
      eventContext,
    );

    await transactionRepositories.outboxRepository.enqueue(
      OutboxMessage.enqueue(processedEvent),
    );
    await transactionRepositories.outboxRepository.enqueue(
      OutboxMessage.enqueue(balanceChangedEvent),
    );

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
