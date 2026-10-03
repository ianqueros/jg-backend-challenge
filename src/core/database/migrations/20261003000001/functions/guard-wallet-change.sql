-- Business rules: README.md section 6.2 (Wallet identity and version).
-- Wallet identity stays fixed. Version starts at one and increases by exactly
-- one for each balance change; updates without a balance change keep the version.

CREATE FUNCTION guard_wallet_change()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', CONSTRAINT = 'wallet_initial_version',
        MESSAGE = 'A new wallet must have version one.';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id, NEW.player_id, NEW.currency)
     IS DISTINCT FROM ROW(OLD.id, OLD.player_id, OLD.currency) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'wallet_identity_immutable',
      MESSAGE = 'The wallet identity cannot change after creation.';
  END IF;

  -- Versions identify balance changes, not other row updates.
  IF NEW.version <> OLD.version + (CASE WHEN NEW.balance <> OLD.balance THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'wallet_balance_version',
      MESSAGE = 'The wallet version must increase by one only when the balance changes.';
  END IF;

  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
