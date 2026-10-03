-- Business rules: README.md sections 6.2 and 9, Create wallet;
-- ARCHITECTURE.md, financial rules (opening credit at wallet version one).
-- Consecutive versions must have matching ending and starting balances.
-- Version one is an OPENING from zero; wallets opened at zero have no opening entry.

CREATE FUNCTION check_ledger_chain(entry wallet_ledger_entries, transaction_kind VARCHAR)
RETURNS VOID AS $$
DECLARE
  prior_balance NUMERIC(20, 2);
  next_balance NUMERIC(20, 2);
BEGIN
  -- Check both neighbors because inserts need not follow version order.
  IF entry.wallet_version = 1 THEN
    IF transaction_kind <> 'OPENING' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', CONSTRAINT = 'ledger_opening_kind',
        MESSAGE = 'Only an opening transaction can produce ledger version one.';
    END IF;
    IF entry.balance_before <> 0.00 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', CONSTRAINT = 'ledger_opening_balance',
        MESSAGE = 'An opening ledger entry must start at zero balance.';
    END IF;
  ELSE
    SELECT balance_after INTO prior_balance FROM wallet_ledger_entries
    WHERE wallet_id = entry.wallet_id AND wallet_version = entry.wallet_version - 1;

    IF FOUND THEN
      IF entry.balance_before <> prior_balance THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514', CONSTRAINT = 'ledger_predecessor_balance',
          MESSAGE = 'The ledger starting balance must match the previous ending balance.';
      END IF;
    ELSIF entry.wallet_version <> 2 OR entry.balance_before <> 0.00 THEN
      -- A wallet opened at zero has no version-one ledger entry.
      RAISE EXCEPTION USING
        ERRCODE = '23514', CONSTRAINT = 'ledger_predecessor_exists',
        MESSAGE = 'The ledger entry requires the previous wallet version.';
    END IF;
  END IF;

  SELECT balance_before INTO next_balance FROM wallet_ledger_entries
  WHERE wallet_id = entry.wallet_id AND wallet_version = entry.wallet_version + 1;

  IF FOUND AND next_balance <> entry.balance_after THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'ledger_successor_balance',
      MESSAGE = 'The ledger ending balance must match the next starting balance.';
  END IF;
END;
$$ LANGUAGE plpgsql;
