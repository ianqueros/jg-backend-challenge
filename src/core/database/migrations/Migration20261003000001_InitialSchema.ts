import { readFileSync } from 'node:fs';
import { Migration } from '@mikro-orm/migrations';

const initialSchemaFiles = [
  'tables.sql',
  'functions/guard-wallet-change.sql',
  'functions/guard-transaction-change.sql',
  'functions/guard-reference-schedule.sql',
  'functions/protect-transaction-wallet.sql',
  'functions/prevent-ledger-mutation.sql',
  'functions/check-wallet-ledger.sql',
  'functions/check-ledger-transaction.sql',
  'functions/check-ledger-wallet.sql',
  'functions/check-ledger-chain.sql',
  'functions/check-ledger-entry.sql',
  'functions/check-transaction-reference.sql',
  'functions/check-transaction-ledger.sql',
  'triggers.sql',
] as const;

/** Installs wallet, wager, and messaging tables with database-enforced financial rules. */
export class Migration20261003000001_InitialSchema extends Migration {
  override up(): void {
    // Explicit SQL assets keep financial invariants and worker recovery readable.
    for (const file of initialSchemaFiles) {
      this.addSql(this.readSql(file));
    }
  }

  override down(): void {
    this.addSql(this.readSql('down.sql'));
  }

  private readSql(file: string): string {
    return readFileSync(new URL(`./20261003000001/${file}`, import.meta.url), 'utf8');
  }
}
