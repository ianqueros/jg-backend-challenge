-- Business rule: README.md section 6.2 (balance and ledger correspondence).
-- An entry cannot exceed the current wallet version. The entry at the current
-- version must end at the materialized wallet balance.

CREATE FUNCTION check_ledger_wallet(entry wallet_ledger_entries)
RETURNS VOID AS $$
DECLARE
  current_wallet wallets;
BEGIN
  SELECT * INTO current_wallet FROM wallets WHERE id = entry.wallet_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'ledger_wallet_exists',
      MESSAGE = 'The ledger entry requires an existing wallet.';
  END IF;

  IF current_wallet.version < entry.wallet_version THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'ledger_wallet_version',
      MESSAGE = 'The ledger version cannot exceed the wallet version.';
  END IF;

  -- After several changes, only the final entry can match the current wallet.
  IF current_wallet.version = entry.wallet_version AND current_wallet.balance <> entry.balance_after THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'ledger_wallet_balance',
      MESSAGE = 'The last ledger balance must match the current wallet balance.';
  END IF;
END;
$$ LANGUAGE plpgsql;
