-- Immediate guards preserve identities, terminal snapshots, ledger immutability,
-- and accepted reference deadlines/provenance (challenge sections 6, 7.1, 11, 12).
-- Deferred checks enforce final wallet/operation/ledger coherence at commit
-- (sections 6.2, 6.4, 7, 9), allowing atomic writes in either order.

CREATE TRIGGER trg_wallets_before_guard
BEFORE INSERT OR UPDATE ON wallets
FOR EACH ROW EXECUTE FUNCTION guard_wallet_change();

CREATE TRIGGER trg_protect_transaction_wallet
BEFORE DELETE ON wallets
FOR EACH ROW EXECUTE FUNCTION protect_transaction_wallet();

CREATE TRIGGER trg_wallet_ledger_entries_immutable
BEFORE UPDATE OR DELETE ON wallet_ledger_entries
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER trg_wallet_ledger_entries_truncate
BEFORE TRUNCATE ON wallet_ledger_entries
FOR EACH STATEMENT EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER trg_wager_transactions_terminal_protection
BEFORE UPDATE OR DELETE ON wager_transactions
FOR EACH ROW EXECUTE FUNCTION guard_transaction_change();

CREATE TRIGGER trg_reference_schedule
BEFORE INSERT OR UPDATE ON wager_transactions
FOR EACH ROW EXECUTE FUNCTION guard_reference_schedule();

CREATE CONSTRAINT TRIGGER trg_wallets_ledger_correspondence
AFTER INSERT OR UPDATE ON wallets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();

CREATE CONSTRAINT TRIGGER trg_ledger_entries_validity
AFTER INSERT ON wallet_ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_ledger_entry();

CREATE CONSTRAINT TRIGGER trg_wager_transactions_ledger_coherence
AFTER INSERT OR UPDATE ON wager_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
