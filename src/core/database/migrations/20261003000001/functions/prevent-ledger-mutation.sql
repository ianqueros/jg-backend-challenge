-- Business rules: README.md section 5 rule 5 and section 6.4 (immutable ledger).
-- Financial history cannot be rewritten or removed through UPDATE, DELETE,
-- or TRUNCATE. Corrections must use new ledger entries.

CREATE FUNCTION prevent_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  -- Corrections require new entries so financial history remains complete.
  RAISE EXCEPTION USING
    ERRCODE = '23514', CONSTRAINT = 'ledger_immutable',
    MESSAGE = 'Ledger entries cannot be changed, deleted, or truncated.';
END;
$$ LANGUAGE plpgsql;
