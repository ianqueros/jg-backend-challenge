-- Challenge section 7: supplied references resolve by provider/external identity
-- to a PROCESSED operation in the same player, wallet, currency, and round.
-- WIN/REFUND require BET; ROLLBACK permits BET, WIN, or REFUND and uses the full
-- amount. Optional BET/LOSS references enforce context without restricting kind.

CREATE FUNCTION check_transaction_reference(transaction_row wager_transactions)
RETURNS VOID AS $$
DECLARE
  reference_row wager_transactions;
BEGIN
  IF transaction_row.kind = 'OPENING' THEN
    RETURN;
  END IF;

  IF transaction_row.reference_transaction_id IS NULL THEN
    IF transaction_row.reference_external_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', CONSTRAINT = 'transaction_reference_resolved',
        MESSAGE = 'A processed dependent transaction requires a resolved reference.';
    END IF;
    RETURN;
  END IF;

  SELECT * INTO reference_row FROM wager_transactions
  WHERE id = transaction_row.reference_transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'transaction_reference_exists',
      MESSAGE = 'The reference transaction must exist.';
  END IF;

  IF reference_row.status <> 'PROCESSED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'transaction_reference_processed',
      MESSAGE = 'The reference transaction must be processed.';
  END IF;

  IF ROW(reference_row.provider_id, reference_row.player_id, reference_row.wallet_id,
         reference_row.currency, reference_row.round_id, reference_row.external_transaction_id)
     IS DISTINCT FROM
     ROW(transaction_row.provider_id, transaction_row.player_id, transaction_row.wallet_id,
         transaction_row.currency, transaction_row.round_id, transaction_row.reference_external_transaction_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'transaction_reference_context',
      MESSAGE = 'The reference must match the provider, player, wallet, currency, round, and external identity.';
  END IF;

  IF (transaction_row.kind IN ('WIN', 'REFUND') AND reference_row.kind <> 'BET')
     OR (transaction_row.kind = 'ROLLBACK' AND reference_row.kind NOT IN ('BET', 'WIN', 'REFUND')) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'transaction_reference_kind',
      MESSAGE = 'The reference kind is not permitted for this transaction.';
  END IF;

  -- A full reversal uses the reference amount; partial reversals are not permitted.
  IF transaction_row.kind IN ('REFUND', 'ROLLBACK') AND reference_row.amount <> transaction_row.amount THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'transaction_reference_amount',
      MESSAGE = 'A reversal amount must equal the full reference amount.';
  END IF;
END;
$$ LANGUAGE plpgsql;
