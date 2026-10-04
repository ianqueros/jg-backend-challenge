import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DatabaseTransactionRunner } from '../../core/database/database-transaction.runner.js';
import {
  getReferenceWorkerSettings,
  type ReferenceWorkerSettings,
} from '../../core/config/reference-worker.settings.js';
import { GuardedUpdateConflictError } from '../../core/database/database.errors.js';
import { TransactionRepositories } from '../../shared/transaction-repositories.js';
import type { WagerTransactionReservation } from './repositories/wager-transaction.repository.js';
import type { WagerTransactionRecord } from './records/wager-transaction.record.js';
import type { WalletRecord } from '../wallet/records/wallet.record.js';
import {
  CANONICAL_HASH_VERSION,
  computeCanonicalInboxHash,
  computeCanonicalTransactionHash,
} from '../../shared/canonical-hash.js';
import { ApplicationError } from '../../shared/errors.js';
import type { MoneyProps } from '../../shared/money.js';
import type { SqsWagerMessageDto } from '../messaging/dto/sqs-wager-message.dto.js';
import { InboxMessage } from '../messaging/entities/inbox-message.entity.js';
import { OutboxMessage } from '../messaging/entities/outbox-message.entity.js';
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  type EventContext,
  type IntegrationEvent,
} from '../messaging/entities/integration-event.entity.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../wallet/entities/wallet-ledger-entry.entity.js';
import { Wallet } from '../wallet/entities/wallet.entity.js';
import {
  validateIdempotencyKey,
  validateSubmitWagerTransaction,
  type SubmitWagerTransactionDto,
} from './dto/submit-wager-transaction.dto.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './entities/wager-transaction.entity.js';
import { wageringErrors } from './wagering.errors.js';
import {
  FinancialTelemetry,
  type FinancialLogContext,
} from '../../shared/financial.telemetry.js';

const wagerKindSchema = z.enum(WagerTransactionKind);
const wagerStatusSchema = z.enum(WagerTransactionStatus);
const failureCodeSchema = z.enum(FailureCode);

export interface FinancialContext {
  readonly providerId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly brokerMessageId?: string | undefined;
}
export interface FinancialResult {
  readonly transactionId: string;
  readonly status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED';
  readonly balance?: MoneyProps;
  readonly walletVersion?: string;
  readonly failureCode?: FailureCode;
  readonly idempotentReplay: boolean;
}
type StoredFinancialResult = Omit<FinancialResult, 'idempotentReplay'> &
  Record<string, unknown>;
interface CommandIdentity {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}
interface Invocation {
  operationId: string;
  ledgerId: string;
  eventId: string;
  balanceEventId: string;
  payload: SubmitWagerTransactionDto;
  key: string;
  hash: string;
  context: FinancialContext;
}

type ReferenceDecision =
  | { outcome: 'resolved'; reference: WagerTransaction | undefined }
  | { outcome: 'wait' }
  | { outcome: 'rejected'; code: FailureCode };

const referenceFailureCodes: Readonly<Record<string, FailureCode>> = {
  WAGER_REFERENCE_PLAYER_MISMATCH: FailureCode.ReferencePlayerMismatch,
  WAGER_REFERENCE_WALLET_MISMATCH: FailureCode.ReferenceWalletMismatch,
  WAGER_REFERENCE_CURRENCY_MISMATCH: FailureCode.ReferenceCurrencyMismatch,
  WAGER_REFERENCE_ROUND_MISMATCH: FailureCode.ReferenceRoundMismatch,
  WAGER_REFERENCE_NOT_PROCESSED: FailureCode.ReferenceInvalidState,
  WAGER_BET_REFERENCE_REQUIRED: FailureCode.ReferenceTypeMismatch,
  WAGER_ROLLBACK_REFERENCE_KIND_INVALID: FailureCode.ReferenceTypeMismatch,
  WAGER_REFERENCE_AMOUNT_MISMATCH: FailureCode.ReferenceAmountMismatch,
};

/**
 * Executes financial wager transactions, balance mutations, and outbox event staging.
 */
export class FinancialUseCase {
  constructor(
    private readonly databaseTransactionRunner: DatabaseTransactionRunner,
    private readonly settings: ReferenceWorkerSettings = getReferenceWorkerSettings(),
    private readonly financialTelemetry = new FinancialTelemetry(),
  ) {}

  /**
   * Processes a direct wager transaction submission.
   */
  async execute(
    payload: unknown,
    idempotencyKey: unknown,
    context: FinancialContext,
  ): Promise<FinancialResult> {
    const data = validateSubmitWagerTransaction(payload);
    const key = validateIdempotencyKey(idempotencyKey);

    this.authorize(data, context);

    return this.invoke(data, key, context);
  }

  /**
   * Processes an asynchronous wager transaction command from message transport.
   */
  async executeCommand(
    message: SqsWagerMessageDto,
    consumerName: string,
    context: FinancialContext,
  ): Promise<FinancialResult> {
    const { idempotencyKey, ...data } = message.data;
    this.authorize(data, context);

    if (
      typeof consumerName !== 'string' ||
      consumerName.length < 1 ||
      consumerName.length > 128
    ) {
      throw wageringErrors.invalidInput(
        new Error('Consumer name must contain 1-128 characters.'),
      );
    }

    return this.invoke(
      data,
      idempotencyKey,
      { ...context, causationId: message.messageId },
      {
        consumerName,
        messageId: message.messageId,
        payloadHash: computeCanonicalInboxHash(message),
      },
    );
  }

  /**
   * Resumes execution of a pending reference transaction claimed from the database.
   */
  async resumeReference(
    operationId: string,
    claimToken: string,
  ): Promise<FinancialResult | undefined> {
    const started = performance.now();
    let origin: WagerTransactionRecord | undefined;
    const result = await this.databaseTransactionRunner.run(async (entityManager) => {
      const transactionRepositories = new TransactionRepositories(entityManager);
      const owned =
        await transactionRepositories.wagerTransactionRepository.findOwnedPendingReference(
          operationId,
          claimToken,
        );
      if (owned === undefined) {
        return undefined;
      }
      origin = owned;
      return this.applyResumedReference(transactionRepositories, owned, claimToken);
    });

    if (result !== undefined && origin !== undefined) {
      this.recordOutcome(result, 'reference', started, {
        correlationId: origin.referenceCorrelationId ?? origin.id,
        causationId: origin.referenceCausationId ?? undefined,
        walletId: origin.walletId,
        providerId: origin.providerId,
      });
    }
    return result;
  }

  /**
   * Verifies that the transaction provider matches the authenticated caller.
   */
  private authorize(data: SubmitWagerTransactionDto, context: FinancialContext): void {
    if (data.providerId !== context.providerId) throw wageringErrors.providerMismatch();
  }

  /**
   * Runs transaction execution within an atomic database transaction boundary.
   */
  private async invoke(
    payload: SubmitWagerTransactionDto,
    key: string,
    context: FinancialContext,
    command?: CommandIdentity,
  ): Promise<FinancialResult> {
    const started = performance.now();
    const invocation: Invocation = {
      operationId: randomUUID(),
      ledgerId: randomUUID(),
      eventId: randomUUID(),
      balanceEventId: randomUUID(),
      payload,
      key,
      hash: computeCanonicalTransactionHash(payload),
      context,
    };

    const result = await this.databaseTransactionRunner
      .run(async (entityManager) => {
        const transactionRepositories = new TransactionRepositories(entityManager);
        let inbox: InboxMessage | undefined;
        // Reserve inbox message to guarantee single execution across command consumers.
        if (command !== undefined) {
          const reservation =
            await transactionRepositories.inboxRepository.reserveIdentity(
              command.consumerName,
              command.messageId,
              command.payloadHash,
            );
          if (!reservation.matches) throw wageringErrors.inboxConflict();
          inbox = InboxMessage.rehydrate({
            messageId: reservation.message.messageId,
            consumerName: reservation.message.consumerName,
            payloadHash: reservation.message.payloadHash,
            receivedAt: reservation.message.receivedAt,
            processedAt: reservation.message.processedAt ?? undefined,
          });
        }

        const result = await this.apply(transactionRepositories, invocation);
        // Completion participates in the same SQL transaction as the financial result.
        if (command !== undefined && inbox !== undefined && !inbox.isProcessed()) {
          const processedAt = new Date();
          inbox.markProcessed(processedAt);
          await transactionRepositories.inboxRepository.markProcessed(
            command.consumerName,
            command.messageId,
            command.payloadHash,
            processedAt,
          );
        }

        return result;
      })
      .catch((cause: unknown) => {
        this.financialTelemetry.observe(
          'financial_processing_seconds',
          (performance.now() - started) / 1000,
        );
        this.financialTelemetry.log('financial_error', {
          correlationId: context.correlationId,
          causationId: context.causationId,
          messageId: command?.messageId,
          brokerMessageId: context.brokerMessageId,
          walletId: payload.walletId,
          providerId: payload.providerId,
          code: ApplicationError.is(cause) ? cause.code : 'FINANCIAL_EXECUTION_FAILED',
        });
        throw cause;
      });

    this.recordOutcome(result, command === undefined ? 'http' : 'command', started, {
      correlationId: context.correlationId,
      causationId: context.causationId,
      messageId: command?.messageId,
      brokerMessageId: context.brokerMessageId,
      walletId: payload.walletId,
      providerId: payload.providerId,
    });
    return result;
  }

  /**
   * Emits telemetry metrics and logs for transaction execution results.
   */
  private recordOutcome(
    result: FinancialResult,
    source: 'http' | 'command' | 'reference',
    started: number,
    context: FinancialLogContext,
  ): void {
    this.financialTelemetry.increment('financial_status_total', result.status);
    if (result.idempotentReplay && source !== 'reference')
      this.financialTelemetry.increment('financial_duplicate_total', source);
    this.financialTelemetry.observe(
      'financial_processing_seconds',
      (performance.now() - started) / 1000,
    );
    this.financialTelemetry.log('financial_result', {
      ...context,
      transactionId: result.transactionId,
      status: result.status,
      code: result.failureCode,
      replay: result.idempotentReplay,
    });
  }

  /**
   * Applies transaction reservation, reference resolution, and balance updates.
   */
  private async apply(
    transactionRepositories: TransactionRepositories,
    invocation: Invocation,
  ): Promise<FinancialResult> {
    const { payload, key, hash } = invocation;
    const reservation =
      await transactionRepositories.wagerTransactionRepository.reserveIdentity({
        ...payload,
        id: invocation.operationId,
        idempotencyKey: key,
        payloadHash: hash,
        hashVersion: CANONICAL_HASH_VERSION,
        amount: payload.money.amount,
        currency: payload.money.currency,
        referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
      });

    if (!reservation.inserted) return this.replay(reservation, invocation);
    const record = reservation.byId;
    if (record === undefined) throw new Error('Operation reservation returned no row.');

    const transaction = this.transaction(record);
    const at = new Date();
    const context: EventContext = {
      ...invocation.context,
      eventId: invocation.eventId,
      occurredAt: at,
    };

    return this.applyFinancialDecision(
      transactionRepositories,
      transaction,
      context,
      invocation.ledgerId,
      invocation.balanceEventId,
    );
  }

  /**
   * Returns the stored result for a matching idempotent submission.
   */
  private replay(
    reservation: WagerTransactionReservation,
    invocation: Invocation,
  ): FinancialResult {
    const existing = reservation.byKey;
    if (
      existing !== undefined &&
      (existing.payloadHash !== invocation.hash ||
        existing.hashVersion !== CANONICAL_HASH_VERSION)
    ) {
      throw wageringErrors.idempotencyConflict();
    }
    if (
      reservation.byExternal !== undefined &&
      reservation.byExternal.id !== existing?.id
    ) {
      throw wageringErrors.externalIdentityConflict();
    }
    if (existing === undefined) throw wageringErrors.externalIdentityConflict();
    if (existing.result == null) throw new GuardedUpdateConflictError();
    return { ...(existing.result as StoredFinancialResult), idempotentReplay: true };
  }

  /**
   * Finalizes the transaction as processed and enqueues the processed event.
   */
  private async finalizeProcessed(
    transactionRepositories: TransactionRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | undefined,
    context: EventContext,
    claimToken?: string,
  ): Promise<FinancialResult> {
    if (context.occurredAt === undefined)
      throw new Error('Financial event time is missing.');
    transaction.markProcessed(reference?.id, context.occurredAt);
    const result = this.result(transaction, wallet);
    if (
      !(await transactionRepositories.wagerTransactionRepository.finalizeIfCurrent({
        id: transaction.id,
        expectedStatus: claimToken !== undefined ? 'PENDING_REFERENCE' : 'PENDING',
        status: 'PROCESSED',
        result,
        ...(reference === undefined ? {} : { referenceTransactionId: reference.id }),
        ...(claimToken === undefined ? {} : { token: claimToken }),
        at: context.occurredAt,
      }))
    )
      throw new GuardedUpdateConflictError();
    await this.enqueue(
      transactionRepositories,
      WagerTransactionProcessed.from(transaction, context),
    );
    return { ...result, idempotentReplay: false };
  }

  /**
   * Resolves and validates the referenced transaction required by dependent operations.
   */
  private async resolveReference(
    transactionRepositories: TransactionRepositories,
    transaction: WagerTransaction,
  ): Promise<ReferenceDecision> {
    if (transaction.referenceExternalTransactionId === undefined)
      return { outcome: 'resolved', reference: undefined };
    const record =
      await transactionRepositories.wagerTransactionRepository.findByExternal(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
    if (record === undefined) return { outcome: 'wait' };
    const reference = this.transaction(record);
    try {
      // The domain checks known context before checking whether the reference is processed.
      transaction.validateReference(reference);
    } catch (cause) {
      if (!ApplicationError.is(cause)) throw cause;
      if (cause.code === 'WAGER_REFERENCE_NOT_PROCESSED' && !reference.isTerminal()) {
        return { outcome: 'wait' };
      }
      const code = referenceFailureCodes[cause.code];
      if (code === undefined) throw cause;
      return { outcome: 'rejected', code };
    }

    if (
      transaction.requiresReference() &&
      (await transactionRepositories.wagerTransactionRepository.findProcessedReversal(
        reference.id,
      )) !== undefined
    ) {
      return { outcome: 'rejected', code: FailureCode.ReferenceAlreadyReversed };
    }
    return { outcome: 'resolved', reference };
  }

  /**
   * Marks a transaction pending reference when its parent transaction is not yet resolved.
   */
  private async pendReference(
    transactionRepositories: TransactionRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    context: EventContext,
  ): Promise<FinancialResult> {
    transaction.markPendingReference();
    const result = this.result(transaction, wallet);
    if (
      !(await transactionRepositories.wagerTransactionRepository.pendReference(
        transaction.id,
        result,
        {
          ttlMs: this.settings.REFERENCE_TTL_MS,
          correlationId: context.correlationId,
          causationId: context.causationId,
        },
      ))
    )
      throw new GuardedUpdateConflictError();
    await this.enqueue(
      transactionRepositories,
      WagerTransactionPendingReference.from(transaction, context),
    );
    return { ...result, idempotentReplay: false };
  }

  /**
   * Updates wallet balance and appends an immutable ledger entry.
   */
  private async changeBalance(
    transactionRepositories: TransactionRepositories,
    transaction: WagerTransaction,
    record: WalletRecord,
    reference: WagerTransaction | undefined,
    context: EventContext,
    ledgerId: string,
    balanceEventId: string,
    claimToken?: string,
  ): Promise<
    | { outcome: 'applied'; wallet: Wallet }
    | { outcome: 'rejected'; result: FinancialResult }
  > {
    const wallet = this.wallet(record);
    let entry: WalletLedgerEntry;
    try {
      const props = {
        transactionId: transaction.id,
        money: transaction.money,
        ledgerEntryId: ledgerId,
        at: context.occurredAt,
      };
      entry =
        transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(props)
          : wallet.credit(props);
    } catch (cause) {
      if (!ApplicationError.is(cause)) throw cause;
      const code = this.mapWalletBalanceFailure(cause.code, transaction.kind);
      if (code === undefined) throw cause;
      return {
        outcome: 'rejected',
        result: await this.reject(
          transactionRepositories,
          transaction,
          code,
          context,
          this.wallet(record),
          claimToken,
        ),
      };
    }

    const updated = await transactionRepositories.walletRepository.updateGuarded({
      id: wallet.id,
      currency: wallet.currency,
      expectedBalance: record.balance,
      expectedVersion: record.version,
      balance: wallet.balance.toString(),
    });

    const authoritativeWallet = this.wallet(updated);
    entry = WalletLedgerEntry.create({
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money,
      balanceBefore: entry.balanceBefore,
      balanceAfter: authoritativeWallet.balance,
      walletVersion: updated.version,
      createdAt: context.occurredAt,
    });
    await transactionRepositories.walletRepository.appendLedger({
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toString(),
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      walletVersion: entry.walletVersion,
    });

    await this.enqueue(
      transactionRepositories,
      WalletBalanceChanged.from(authoritativeWallet, entry, {
        ...context,
        eventId: balanceEventId,
      }),
    );

    return { outcome: 'applied', wallet: authoritativeWallet };
  }

  /**
   * Maps wallet errors to domain failure codes for the transaction kind.
   */
  private mapWalletBalanceFailure(
    causeCode: string,
    kind: WagerTransactionKind,
  ): FailureCode | undefined {
    if (causeCode === 'WALLET_INSUFFICIENT_BALANCE') {
      return kind === WagerTransactionKind.Bet
        ? FailureCode.InsufficientFunds
        : FailureCode.InsufficientRefundBalance;
    }
    if (causeCode === 'WALLET_BALANCE_OUT_OF_RANGE') return FailureCode.BalanceOverflow;
    if (causeCode === 'WALLET_VERSION_EXHAUSTED')
      return FailureCode.WalletVersionExhausted;
    return undefined;
  }

  /**
   * Validates wallet existence, player ownership, and currency match.
   */
  private walletFailure(
    wallet: WalletRecord | undefined,
    transaction: WagerTransaction,
  ): FailureCode | undefined {
    if (wallet === undefined) return FailureCode.WalletNotFound;
    if (wallet.playerId !== transaction.playerId) return FailureCode.WalletPlayerMismatch;
    if (wallet.currency !== transaction.money.currency)
      return FailureCode.WalletCurrencyMismatch;
    return undefined;
  }

  /**
   * Rejects the transaction with a failure code and records the rejection event.
   */
  private async reject(
    transactionRepositories: TransactionRepositories,
    transaction: WagerTransaction,
    code: FailureCode,
    context: EventContext,
    wallet?: Wallet,
    claimToken?: string,
  ): Promise<FinancialResult> {
    transaction.reject(code, context.occurredAt);
    const result = this.result(transaction, wallet);
    if (
      !(await transactionRepositories.wagerTransactionRepository.finalizeIfCurrent({
        id: transaction.id,
        expectedStatus: claimToken !== undefined ? 'PENDING_REFERENCE' : 'PENDING',
        status: 'REJECTED',
        result,
        failureCode: code,
        ...(claimToken === undefined ? {} : { token: claimToken }),
        at: transaction.closedAt,
      }))
    )
      throw new GuardedUpdateConflictError();
    await this.enqueue(
      transactionRepositories,
      WagerTransactionRejected.from(transaction, context),
    );
    return { ...result, idempotentReplay: false };
  }

  /**
   * Re-evaluates and executes a claimed pending reference transaction.
   */
  private async applyResumedReference(
    transactionRepositories: TransactionRepositories,
    owned: WagerTransactionRecord & { isExpired: boolean },
    claimToken: string,
  ): Promise<FinancialResult> {
    const transaction = this.transaction(owned);
    const context: EventContext = {
      eventId: randomUUID(),
      correlationId: owned.referenceCorrelationId ?? owned.id,
      causationId: owned.referenceCausationId ?? undefined,
      occurredAt: new Date(),
    };

    return this.applyFinancialDecision(
      transactionRepositories,
      transaction,
      context,
      randomUUID(),
      randomUUID(),
      claimToken,
      owned.isExpired,
    );
  }

  /** One decision path for both reserved submissions and fenced reference claims. */
  private async applyFinancialDecision(
    transactionRepositories: TransactionRepositories,
    transaction: WagerTransaction,
    context: EventContext,
    ledgerId: string,
    balanceEventId: string,
    claimToken?: string,
    isExpired = false,
  ): Promise<FinancialResult> {
    const walletRecord = await transactionRepositories.walletRepository.findById(
      transaction.walletId,
    );
    const failure = isExpired
      ? FailureCode.ReferenceExpired
      : this.walletFailure(walletRecord, transaction);
    if (failure !== undefined)
      return this.reject(
        transactionRepositories,
        transaction,
        failure,
        context,
        this.claimedWallet(walletRecord, claimToken),
        claimToken,
      );
    if (walletRecord === undefined) throw new Error('Validated wallet is missing.');
    let wallet = this.wallet(walletRecord);

    const decision = await this.resolveReference(transactionRepositories, transaction);
    if (decision.outcome === 'wait') {
      return claimToken === undefined
        ? this.pendReference(transactionRepositories, transaction, wallet, context)
        : this.keepPending(transaction, wallet);
    }
    if (decision.outcome === 'rejected')
      return this.reject(
        transactionRepositories,
        transaction,
        decision.code,
        context,
        wallet,
        claimToken,
      );

    if (transaction.affectsBalance()) {
      const change = await this.changeBalance(
        transactionRepositories,
        transaction,
        walletRecord,
        decision.reference,
        context,
        ledgerId,
        balanceEventId,
        claimToken,
      );
      if (change.outcome === 'rejected') return change.result;
      wallet = change.wallet;
    }
    return this.finalizeProcessed(
      transactionRepositories,
      transaction,
      wallet,
      decision.reference,
      context,
      claimToken,
    );
  }

  /** Initial invalid-wallet submissions must not disclose another player's balance. */
  private claimedWallet(
    record: WalletRecord | undefined,
    claimToken?: string,
  ): Wallet | undefined {
    if (claimToken === undefined || record === undefined) return undefined;
    return this.wallet(record);
  }

  /**
   * Returns a pending reference result when the parent transaction is not yet resolved.
   */
  private keepPending(transaction: WagerTransaction, wallet?: Wallet): FinancialResult {
    return {
      transactionId: transaction.id,
      status: 'PENDING_REFERENCE',
      ...(wallet === undefined
        ? {}
        : { balance: wallet.balance.toJSON(), walletVersion: wallet.version }),
      idempotentReplay: false,
    };
  }

  /**
   * Builds the durable financial result shape for persistence and caller response.
   */
  private result(transaction: WagerTransaction, wallet?: Wallet): StoredFinancialResult {
    if (transaction.status === WagerTransactionStatus.Pending)
      throw new Error('A financial result must be durable.');
    return {
      transactionId: transaction.id,
      status: transaction.status,
      ...(wallet === undefined
        ? {}
        : { balance: wallet.balance.toJSON(), walletVersion: wallet.version }),
      ...(transaction.failureCode === undefined
        ? {}
        : { failureCode: transaction.failureCode }),
    };
  }

  /**
   * Stages an integration event in the transactional outbox table.
   */
  private async enqueue(
    transactionRepositories: TransactionRepositories,
    event: IntegrationEvent<unknown>,
  ): Promise<void> {
    await transactionRepositories.outboxRepository.enqueue(OutboxMessage.enqueue(event));
  }

  /**
   * Rehydrates a wallet domain entity from a database record.
   */
  private wallet(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: { amount: record.balance, currency: record.currency },
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  /**
   * Rehydrates a wager transaction domain entity from a database record.
   */
  private transaction(record: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId ?? undefined,
      gameId: record.gameId ?? undefined,
      kind: wagerKindSchema.parse(record.kind),
      money: { amount: record.amount, currency: record.currency },
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      status: wagerStatusSchema.parse(record.status),
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      failureCode:
        record.failureCode != null
          ? failureCodeSchema.parse(record.failureCode)
          : undefined,
      createdAt: record.createdAt,
      processedAt: record.processedAt ?? undefined,
      closedAt: record.closedAt ?? undefined,
    });
  }
}
