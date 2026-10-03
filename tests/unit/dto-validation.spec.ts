import { describe, expect, it } from 'bun:test';
import { ZodError } from 'zod';
import { validateSqsWagerMessage } from '../../src/domains/messaging/dto/sqs-wager-message.dto.js';
import {
  validateIdempotencyKey,
  validateSubmitWagerTransaction,
} from '../../src/domains/wagering/dto/submit-wager-transaction.dto.js';
import { validateCreateWallet } from '../../src/domains/wallet/dto/create-wallet.dto.js';
import type { ApplicationError } from '../../src/shared/errors.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

function assertValidationError(
  action: () => unknown,
  expectedCode: string,
): ApplicationError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  const appError = expectApplicationError(thrown, {
    category: 'ValidationError',
    code: expectedCode,
  });
  expect(appError.cause).toBeInstanceOf(ZodError);
  return appError;
}
describe('DTO Validation (Strict Zod)', () => {
  const validPlayerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
  const validWalletId = '0192f291-27dd-7d3f-8071-5f8685deef37';

  describe('CreateWalletDto', () => {
    it('accepts valid input', () => {
      const dto = validateCreateWallet({
        playerId: validPlayerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      expect(dto.playerId).toBe(validPlayerId);
      expect(dto.initialBalance.amount).toBe('100.00');
    });

    it('rejects invalid UUID, negative amount, and unsupported currency', () => {
      assertValidationError(
        () =>
          validateCreateWallet({
            playerId: 'not-a-uuid',
            initialBalance: { amount: '100.00', currency: 'BRL' },
          }),
        'WALLET_INPUT_INVALID',
      );

      assertValidationError(
        () =>
          validateCreateWallet({
            playerId: validPlayerId,
            initialBalance: { amount: '-10.00', currency: 'BRL' },
          }),
        'WALLET_INPUT_INVALID',
      );

      assertValidationError(
        () =>
          validateCreateWallet({
            playerId: validPlayerId,
            initialBalance: { amount: '10.00', currency: 'JPY' },
          }),
        'WALLET_INPUT_INVALID',
      );
    });

    it('rejects unexpected unknown fields', () => {
      assertValidationError(
        () =>
          validateCreateWallet({
            playerId: validPlayerId,
            initialBalance: { amount: '100.00', currency: 'BRL' },
            extraField: 'unexpected',
          }),
        'WALLET_INPUT_INVALID',
      );
    });
  });

  describe('SubmitWagerTransactionDto', () => {
    const validPayload = {
      providerId: 'provider-a',
      externalTransactionId: 'tx-123',
      playerId: validPlayerId,
      walletId: validWalletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };

    it('accepts valid wager transaction payload', () => {
      const dto = validateSubmitWagerTransaction(validPayload);
      expect(dto.kind).toBe('BET');
      expect(dto.money.amount).toBe('25.00');
    });

    it('rejects external OPENING kind', () => {
      assertValidationError(
        () =>
          validateSubmitWagerTransaction({
            ...validPayload,
            kind: 'OPENING',
          }),
        'WAGER_INPUT_INVALID',
      );
    });

    it('rejects reserved internal provider namespace', () => {
      assertValidationError(
        () =>
          validateSubmitWagerTransaction({
            ...validPayload,
            providerId: '__internal__',
          }),
        'WAGER_INPUT_INVALID',
      );

      assertValidationError(
        () =>
          validateSubmitWagerTransaction({
            ...validPayload,
            providerId: '__system__',
          }),
        'WAGER_INPUT_INVALID',
      );
    });

    it('enforces strictly positive amount for non-LOSS operations and permits zero for LOSS', () => {
      assertValidationError(
        () =>
          validateSubmitWagerTransaction({
            ...validPayload,
            money: { amount: '0.00', currency: 'BRL' },
          }),
        'WAGER_INPUT_INVALID',
      );
      const lossDto = validateSubmitWagerTransaction({
        ...validPayload,
        kind: 'LOSS',
        money: { amount: '0.00', currency: 'BRL' },
      });
      expect(lossDto.kind).toBe('LOSS');
      expect(lossDto.money.amount).toBe('0.00');
    });

    it('requires referenceExternalTransactionId for REFUND and ROLLBACK', () => {
      assertValidationError(
        () =>
          validateSubmitWagerTransaction({
            ...validPayload,
            kind: 'REFUND',
          }),
        'WAGER_INPUT_INVALID',
      );
      const refundDto = validateSubmitWagerTransaction({
        ...validPayload,
        kind: 'REFUND',
        referenceExternalTransactionId: 'ref-bet-123',
      });
      expect(refundDto.referenceExternalTransactionId).toBe('ref-bet-123');
    });

    it('rejects whitespace and control characters in opaque identifiers', () => {
      assertValidationError(
        () =>
          validateSubmitWagerTransaction({
            ...validPayload,
            externalTransactionId: '  leading-space',
          }),
        'WAGER_INPUT_INVALID',
      );

      assertValidationError(
        () =>
          validateSubmitWagerTransaction({
            ...validPayload,
            providerId: 'trailing-space  ',
          }),
        'WAGER_INPUT_INVALID',
      );

      assertValidationError(
        () =>
          validateSubmitWagerTransaction({
            ...validPayload,
            roundId: 'control\x00char',
          }),
        'WAGER_INPUT_INVALID',
      );
    });

    it('validates Idempotency-Key header rules (1-256 ASCII visible without spaces)', () => {
      expect(validateIdempotencyKey('provider-a:tx-123')).toBe('provider-a:tx-123');

      assertValidationError(() => validateIdempotencyKey(''), 'IDEMPOTENCY_KEY_INVALID');
      assertValidationError(
        () => validateIdempotencyKey('has space in key'),
        'IDEMPOTENCY_KEY_INVALID',
      );
      assertValidationError(
        () => validateIdempotencyKey('a'.repeat(257)),
        'IDEMPOTENCY_KEY_INVALID',
      );
    });
  });

  describe('SqsWagerMessageDto', () => {
    it('accepts valid SQS envelope', () => {
      const message = {
        messageId: 'msg-001',
        type: 'WagerTransactionRequested',
        occurredAt: '2026-07-29T15:00:00.000Z',
        data: {
          providerId: 'provider-a',
          externalTransactionId: 'tx-123',
          idempotencyKey: 'provider-a:tx-123',
          playerId: validPlayerId,
          walletId: validWalletId,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
      };

      const dto = validateSqsWagerMessage(message);
      expect(dto.messageId).toBe('msg-001');
      expect(dto.data.idempotencyKey).toBe('provider-a:tx-123');
    });

    it('rejects invalid message type or missing idempotencyKey in data', () => {
      assertValidationError(
        () =>
          validateSqsWagerMessage({
            messageId: 'msg-001',
            type: 'WrongType',
            occurredAt: '2026-07-29T15:00:00.000Z',
            data: {},
          }),
        'SQS_WAGER_MESSAGE_INVALID',
      );
    });
  });
});
