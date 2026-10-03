-- Challenge section 7.1: pending dependencies have a durable acceptance deadline
-- and retry schedule. Sections 11 and 12: continuation events preserve the original
-- correlation and causation across worker recovery. Once accepted, these fields
-- cannot be replaced by replay, claiming, rescheduling, or terminal completion.

CREATE FUNCTION guard_reference_schedule()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.reference_expires_at IS NOT NULL
       AND NEW.reference_expires_at IS DISTINCT FROM OLD.reference_expires_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', CONSTRAINT = 'reference_deadline_immutable',
        MESSAGE = 'An accepted reference deadline cannot change.';
    END IF;

    IF OLD.reference_correlation_id IS NOT NULL
       AND NEW.reference_correlation_id IS DISTINCT FROM OLD.reference_correlation_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', CONSTRAINT = 'reference_correlation_immutable',
        MESSAGE = 'An accepted reference correlation cannot change.';
    END IF;

    IF OLD.reference_causation_id IS NOT NULL
       AND NEW.reference_causation_id IS DISTINCT FROM OLD.reference_causation_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', CONSTRAINT = 'reference_causation_immutable',
        MESSAGE = 'An accepted reference causation cannot change.';
    END IF;
  END IF;

  -- The use case supplies its configured TTL; direct inserts default to 24 hours.
  IF NEW.status = 'PENDING_REFERENCE' THEN
    NEW.reference_expires_at = COALESCE(NEW.reference_expires_at,
      NEW.created_at + interval '24 hours');
    NEW.reference_next_attempt_at = COALESCE(NEW.reference_next_attempt_at, NEW.created_at);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
