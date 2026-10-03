-- Challenge sections 6.2 and 6.3: accepted operations retain their wallet context,
-- including pending operations and LOSS without a ledger entry. Rejected input
-- does not require a valid wallet. Paired with the deferred key-share wallet check,
-- this guard prevents deletion from orphaning accepted history under concurrency.

CREATE FUNCTION protect_transaction_wallet()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM wager_transactions
    WHERE wallet_id = OLD.id AND status <> 'REJECTED'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503', CONSTRAINT = 'transaction_wallet_context',
      MESSAGE = 'A wallet referenced by accepted financial history cannot be removed.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
