import { messagingErrors } from '../messaging.errors.js';

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt?: Date | undefined;
}

export interface InboxMessageState {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
  readonly processedAt?: Date | undefined;
}

/** Tracks inbound message processing state to guarantee idempotent consumer execution. */
export class InboxMessage {
  private readonly _receivedAt: Date;
  private _processedAt?: Date | undefined;

  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    receivedAt: Date,
    processedAt?: Date,
  ) {
    this._receivedAt = new Date(receivedAt.getTime());
    this._processedAt = processedAt ? new Date(processedAt.getTime()) : undefined;
  }

  public static receive(props: ReceiveInboxProps): InboxMessage {
    const receivedAt = props.receivedAt
      ? new Date(props.receivedAt.getTime())
      : new Date();
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      receivedAt,
    );
  }

  public static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  public get receivedAt(): Date {
    return new Date(this._receivedAt.getTime());
  }

  public get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  public isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Marks the message as processed; prevents duplicate execution. */
  public markProcessed(at: Date): void {
    if (this._processedAt !== undefined) {
      throw messagingErrors.inboxAlreadyProcessed();
    }
    this._processedAt = new Date(at.getTime());
  }
}
