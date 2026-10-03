-- Reverse the complete schema only on a disposable database. Dropping the
-- functions removes their triggers; table drops remove their indexes/constraints.
DROP FUNCTION IF EXISTS guard_reference_schedule CASCADE;
DROP FUNCTION IF EXISTS protect_transaction_wallet CASCADE;
DROP FUNCTION IF EXISTS check_transaction_ledger CASCADE;
DROP FUNCTION IF EXISTS check_transaction_reference CASCADE;
DROP FUNCTION IF EXISTS check_ledger_entry CASCADE;
DROP FUNCTION IF EXISTS check_ledger_chain CASCADE;
DROP FUNCTION IF EXISTS check_ledger_wallet CASCADE;
DROP FUNCTION IF EXISTS check_ledger_transaction CASCADE;
DROP FUNCTION IF EXISTS check_wallet_ledger CASCADE;
DROP FUNCTION IF EXISTS guard_transaction_change CASCADE;
DROP FUNCTION IF EXISTS prevent_ledger_mutation CASCADE;
DROP FUNCTION IF EXISTS guard_wallet_change CASCADE;

DROP TABLE IF EXISTS outbox_messages CASCADE;
DROP TABLE IF EXISTS inbox_messages CASCADE;
DROP TABLE IF EXISTS wallet_ledger_entries CASCADE;
DROP TABLE IF EXISTS wager_transactions CASCADE;
DROP TABLE IF EXISTS wallets CASCADE;
