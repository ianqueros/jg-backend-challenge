import { Logger } from '@nestjs/common';

const counters = {
  financial_status_total: ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'],
  financial_duplicate_total: ['http', 'command'],
  financial_retry_total: ['database', 'command', 'reference', 'outbox'],
  financial_conflict_total: [
    'guarded_update',
    'serialization',
    'deadlock',
    'lock_timeout',
  ],
  financial_dlq_total: ['confirmed'],
  outbox_publish_total: ['confirmed', 'retry', 'ownership_lost'],
} as const;
type Counter = keyof typeof counters;
type Observation = 'financial_processing_seconds' | 'outbox_delay_seconds';

/** Safe identifiers and fixed outcomes only; never financial payloads or metric labels. */
export interface FinancialLogContext {
  correlationId?: string | undefined;
  causationId?: string | undefined;
  messageId?: string | undefined;
  brokerMessageId?: string | undefined;
  transactionId?: string | undefined;
  walletId?: string | undefined;
  providerId?: string | undefined;
  eventId?: string | undefined;
  status?: string | undefined;
  code?: string | undefined;
  replay?: boolean | undefined;
}

/** Collects process-local Prometheus counters and latency histograms for financial operations. */
export class FinancialTelemetry {
  private readonly logger = new Logger(FinancialTelemetry.name);
  private readonly counts = new Map<string, bigint>();
  private readonly observations = new Map<
    Observation,
    { count: number; sum: number; buckets: number[] }
  >();
  private readonly bounds = [0.01, 0.1, 0.5, 1, 5, 10, 30, 60, 300];

  /** Increments a financial counter for a validated outcome category. */
  increment(name: Counter, outcome: string): void {
    if (!(counters[name] as readonly string[]).includes(outcome))
      throw new Error('Unknown telemetry outcome.');

    const key = `${name}{outcome="${outcome}"}`;
    this.counts.set(key, (this.counts.get(key) ?? 0n) + 1n);
  }

  /** Records a latency observation into cumulative counts, sum, and histogram buckets. */
  observe(name: Observation, seconds: number): void {
    const value = Math.max(0, seconds);
    const sample = this.observations.get(name) ?? {
      count: 0,
      sum: 0,
      buckets: this.bounds.map(() => 0),
    };

    sample.count += 1;
    sample.sum += value;
    this.bounds.forEach((bound, index) => {
      if (value <= bound) sample.buckets[index] = (sample.buckets[index] ?? 0) + 1;
    });

    this.observations.set(name, sample);
  }

  /** Emits a structured log event with financial tracing context. */
  log(event: string, context: FinancialLogContext): void {
    this.logger.log({ event, ...context });
  }

  /** Formats recorded metrics into standard Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    for (const [name, outcomes] of Object.entries(counters)) {
      lines.push(
        `# HELP ${name} Process-local durable financial and worker outcomes.`,
        `# TYPE ${name} counter`,
      );
      for (const outcome of outcomes) {
        const key = `${name}{outcome="${outcome}"}`;
        lines.push(`${key} ${(this.counts.get(key) ?? 0n).toString()}`);
      }
    }

    for (const name of [
      'financial_processing_seconds',
      'outbox_delay_seconds',
    ] as const) {
      this.renderHistogram(name, lines);
    }

    return `${lines.join('\n')}\n`;
  }

  /** Formats histogram bucket, count, and sum metrics for a specific observation metric. */
  private renderHistogram(name: Observation, lines: string[]): void {
    const sample = this.observations.get(name);
    lines.push(
      `# HELP ${name} Observed processing or event delivery latency.`,
      `# TYPE ${name} histogram`,
    );

    this.bounds.forEach((bound, index) =>
      lines.push(
        `${name}_bucket{le="${String(bound)}"} ${String(sample?.buckets[index] ?? 0)}`,
      ),
    );

    lines.push(
      `${name}_bucket{le="+Inf"} ${String(sample?.count ?? 0)}`,
      `${name}_count ${String(sample?.count ?? 0)}`,
      `${name}_sum ${String(sample?.sum ?? 0)}`,
    );
  }
}
