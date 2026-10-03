-- Business rules: README.md sections 6.4 and 7 (financial ledger effects),
-- and section 9, Create wallet (OPENING credit).
-- An entry must match a PROCESSED transaction's wallet, currency, and amount.
-- Its direction must match the operation; ROLLBACK inverts the reference effect.

CREATE FUNCTION check_ledger_transaction(entry wallet_ledger_entries, transaction_row wager_transactions)
RETURNS VOID AS $$
DECLARE
  expected_direction VARCHAR(10);
BEGIN
  IF ROW(entry.wallet_id, entry.currency, entry.amount)
     IS DISTINCT FROM ROW(transaction_row.wallet_id, transaction_row.currency, transaction_row.amount) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'ledger_transaction_context',
      MESSAGE = 'The ledger wallet, currency, and amount must match the transaction.';
  END IF;

  IF transaction_row.status <> 'PROCESSED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'ledger_transaction_processed',
      MESSAGE = 'A ledger entry must belong to a processed transaction.';
  END IF;

  -- A rollback reverses the reference effect, not a fixed debit or credit direction.
  expected_direction := CASE transaction_row.kind
    WHEN 'BET' THEN 'DEBIT'
    WHEN 'WIN' THEN 'CREDIT'
    WHEN 'REFUND' THEN 'CREDIT'
    WHEN 'OPENING' THEN 'CREDIT'
    WHEN 'ROLLBACK' THEN CASE (
      SELECT kind FROM wager_transactions WHERE id = transaction_row.reference_transaction_id
    ) WHEN 'BET' THEN 'CREDIT' ELSE 'DEBIT' END
    ELSE NULL
  END;

  IF expected_direction IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'ledger_transaction_kind',
      MESSAGE = 'This transaction kind cannot produce a ledger entry.';
  END IF;

  IF entry.direction <> expected_direction THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'ledger_direction',
      MESSAGE = 'The ledger direction does not match the transaction effect.';
  END IF;
END;
$$ LANGUAGE plpgsql;
