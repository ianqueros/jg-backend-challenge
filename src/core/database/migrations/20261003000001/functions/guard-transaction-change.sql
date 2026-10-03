-- Business rules: README.md section 6.3 (fixed input and terminal states),
-- section 7 rule 7 (original replay), and ARCHITECTURE.md, workers and recovery.
-- Preserve transaction history, business input, and terminal results.
-- PENDING_REFERENCE cannot return to PENDING.

CREATE FUNCTION guard_transaction_change()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'transaction_delete_prohibited',
      MESSAGE = 'A wager transaction cannot be deleted.';
  END IF;

  -- Terminal results are replay snapshots; later writes must not replace them.
  IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'transaction_terminal_immutable',
      MESSAGE = 'A closed wager transaction cannot change.';
  END IF;

  -- Fixed business input keeps identity and payload hash checks valid.
  IF ROW(NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
         NEW.payload_hash, NEW.hash_version, NEW.wallet_id, NEW.player_id,
         NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
         NEW.reference_external_transaction_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
         OLD.payload_hash, OLD.hash_version, OLD.wallet_id, OLD.player_id,
         OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
         OLD.reference_external_transaction_id, OLD.created_at) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'transaction_payload_immutable',
      MESSAGE = 'The transaction identity and business input cannot change.';
  END IF;

  IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', CONSTRAINT = 'transaction_pending_reference_transition',
      MESSAGE = 'A transaction that waits for a reference cannot return to pending.';
  END IF;

  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
