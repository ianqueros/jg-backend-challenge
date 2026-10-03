export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt: Date = new Date();
  processedAt?: Date | null;
}
