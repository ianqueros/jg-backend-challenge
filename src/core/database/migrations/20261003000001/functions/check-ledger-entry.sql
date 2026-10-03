-- Business rules: README.md sections 6.2, 6.4, and 7 (valid financial history).
-- At commit, validate each inserted entry against its final transaction state,
-- wallet version and balance, and adjacent ledger balances through the helpers.

CREATE FUNCTION check_ledger_entry()
RETURNS TRIGGER AS $$
DECLARE
  current_transaction wager_transactions;
BEGIN
  -- Processing can follow insertion in the same transaction; read the final row.
  SELECT * INTO current_transaction FROM wager_transactions WHERE id = NEW.transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'ledger_transaction_exists',
      MESSAGE = 'The ledger entry requires an existing transaction.';
  END IF;

  PERFORM check_ledger_transaction(NEW, current_transaction);
  PERFORM check_ledger_wallet(NEW);
  PERFORM check_ledger_chain(NEW, current_transaction.kind);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
