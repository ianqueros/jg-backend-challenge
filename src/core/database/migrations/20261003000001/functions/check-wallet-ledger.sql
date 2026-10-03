-- Business rule: README.md section 6.2 (every balance change has a ledger entry).
-- Each balance change, including a positive opening, must have an entry for
-- the same wallet version with matching balances before and after the change.

CREATE FUNCTION check_wallet_ledger()
RETURNS TRIGGER AS $$
DECLARE
  prior_balance NUMERIC(20, 2);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance = 0.00 THEN
      RETURN NEW;
    END IF;
    prior_balance := 0.00;
  ELSE
    IF NEW.balance = OLD.balance THEN
      RETURN NEW;
    END IF;
    prior_balance := OLD.balance;
  END IF;

  -- This deferred check permits wallet and ledger writes in either order.
  IF NOT EXISTS (
    SELECT 1 FROM wallet_ledger_entries
    WHERE wallet_id = NEW.id
      AND wallet_version = NEW.version
      AND balance_before = prior_balance
      AND balance_after = NEW.balance
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'wallet_ledger_correspondence',
      MESSAGE = 'The wallet balance change has no matching ledger entry.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
