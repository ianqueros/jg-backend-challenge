import { Logger } from '@nestjs/common';

/** Tracks reconciliation check counts and detected balance divergences for Prometheus exposition. */
export class ReconciliationTelemetry {
  private readonly logger = new Logger(ReconciliationTelemetry.name);
  private total = 0n;
  private divergences = 0n;

  /** Records a reconciliation outcome and logs a warning event on balance divergence. */
  record(
    result: {
      readonly walletId: string;
      readonly consistent: boolean;
      readonly checkedEntries: number;
    },
    correlationId: string,
  ): void {
    this.total += 1n;
    if (result.consistent) return;

    this.divergences += 1n;
    this.logger.warn({
      event: 'wallet_reconciliation_divergence',
      walletId: result.walletId,
      correlationId,
      checkedEntries: result.checkedEntries,
    });
  }

  /** Formats recorded reconciliation counters into Prometheus text exposition format. */
  render(): string {
    return [
      '# HELP wallet_reconciliation_total Successful wallet reconciliation checks.',
      '# TYPE wallet_reconciliation_total counter',
      `wallet_reconciliation_total ${this.total.toString()}`,
      '# HELP wallet_reconciliation_divergence_total Wallet reconciliation checks with a balance difference.',
      '# TYPE wallet_reconciliation_divergence_total counter',
      `wallet_reconciliation_divergence_total ${this.divergences.toString()}`,
      '',
    ].join('\n');
  }
}
