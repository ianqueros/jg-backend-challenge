-- Challenge sections 6.2, 6.4, 7, and 9 (opening credit).
-- Non-rejected operations require the same wallet, owner, and currency; rejected
-- input remains auditable even without a valid wallet. A key-share lock protects
-- accepted history against concurrent wallet deletion. Financial PROCESSED
-- operations require one entry; other states, LOSS, and zero openings require none.
-- References are validated against the final PROCESSED state.

CREATE FUNCTION check_transaction_ledger()
RETURNS TRIGGER AS $$
DECLARE
  current_transaction wager_transactions;
  ledger_count INTEGER;
  expected_count INTEGER := 0;
BEGIN
  -- Deferred events can contain an earlier status. Validate the final stored row.
  SELECT * INTO current_transaction FROM wager_transactions WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF current_transaction.status <> 'REJECTED' THEN
    PERFORM 1 FROM wallets
    WHERE id = current_transaction.wallet_id
      AND player_id = current_transaction.player_id
      AND currency = current_transaction.currency
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', CONSTRAINT = 'transaction_wallet_context',
        MESSAGE = 'A non-rejected transaction requires its matching wallet.';
    END IF;
  END IF;

  -- LOSS and a zero opening have no balance effect and therefore no ledger entry.
  IF current_transaction.status = 'PROCESSED'
     AND current_transaction.kind <> 'LOSS'
     AND NOT (current_transaction.kind = 'OPENING' AND current_transaction.amount = 0.00) THEN
    expected_count := 1;
  END IF;

  SELECT COUNT(*) INTO ledger_count FROM wallet_ledger_entries
  WHERE transaction_id = current_transaction.id;
  IF ledger_count <> expected_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'transaction_ledger_count',
      MESSAGE = 'The ledger entry count does not match the transaction state and kind.';
  END IF;

  IF current_transaction.status <> 'PROCESSED' THEN
    RETURN NEW;
  END IF;

  PERFORM check_transaction_reference(current_transaction);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
