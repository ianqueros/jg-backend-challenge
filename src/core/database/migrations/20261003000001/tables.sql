-- Challenge sections 6 and 7: durable identities, exact money, immutable-history
-- relationships, and row-local financial invariants. Cross-row rules are checked
-- by deferred triggers so wallet, operation, and ledger writes commit together.
-- Sections 7.1, 10, and 11: persistent reference scheduling, inbox, and outbox
-- with recoverable per-row ownership for concurrent workers.

-- Section 6.2: one wallet per player/currency, exact non-negative balance,
-- and positive version. The composite identity is the ledger's currency-safe FK.
CREATE TABLE wallets (
  id UUID PRIMARY KEY,
  player_id UUID NOT NULL,
  currency VARCHAR(3) NOT NULL,
  balance NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
  CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency),
  CONSTRAINT chk_wallets_currency CHECK (currency IN ('BRL', 'USD', 'EUR')),
  CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0 AND balance <> 'NaN'::numeric),
  CONSTRAINT chk_wallets_version_positive CHECK (version >= 1)
);

-- Sections 6.3 and 7: provider-scoped operation identities, durable replay
-- results, explicit terminal timestamps, and full reversal references.
CREATE TABLE wager_transactions (
  id UUID PRIMARY KEY,
  provider_id VARCHAR(128) NOT NULL,
  external_transaction_id VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(256) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  hash_version VARCHAR(16) NOT NULL DEFAULT 'v1',
  wallet_id UUID NOT NULL,
  player_id UUID NOT NULL,
  round_id VARCHAR(128) NULL,
  game_id VARCHAR(128) NULL,
  kind VARCHAR(32) NOT NULL,
  amount NUMERIC(20, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  reference_external_transaction_id VARCHAR(128) NULL,
  reference_transaction_id UUID NULL REFERENCES wager_transactions(id),
  reference_expires_at TIMESTAMPTZ NULL,
  reference_attempts INTEGER NOT NULL DEFAULT 0,
  reference_next_attempt_at TIMESTAMPTZ NULL,
  reference_claim_token UUID NULL,
  reference_claim_expires_at TIMESTAMPTZ NULL,
  reference_correlation_id VARCHAR(256) NULL,
  reference_causation_id VARCHAR(256) NULL,
  status VARCHAR(32) NOT NULL,
  failure_code VARCHAR(64) NULL,
  result JSONB NULL,
  processed_at TIMESTAMPTZ NULL,
  closed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_wager_transactions_provider_key UNIQUE (provider_id, idempotency_key),
  CONSTRAINT uq_wager_transactions_provider_external UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT chk_reference_attempts CHECK (reference_attempts >= 0),
  CONSTRAINT chk_reference_claim_pair CHECK (
    (reference_claim_token IS NULL) = (reference_claim_expires_at IS NULL)
  ),
  CONSTRAINT chk_reference_deadline CHECK (
    status <> 'PENDING_REFERENCE' OR reference_expires_at IS NOT NULL
  ),
  CONSTRAINT chk_wager_transactions_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
  CONSTRAINT chk_wager_transactions_status CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
  CONSTRAINT chk_wager_transactions_amount_finite CHECK (amount <> 'NaN'::numeric),
  CONSTRAINT chk_wager_transactions_terminal_result CHECK (status NOT IN ('PROCESSED', 'REJECTED', 'FAILED') OR result IS NOT NULL),
  CONSTRAINT chk_wager_transactions_amount CHECK (
    (kind IN ('LOSS', 'OPENING') AND amount >= 0.00) OR
    (kind IN ('BET', 'WIN', 'REFUND', 'ROLLBACK') AND amount > 0.00)
  ),
  CONSTRAINT chk_wager_transactions_status_timestamps CHECK (
    (status = 'PROCESSED' AND processed_at IS NOT NULL AND closed_at IS NULL) OR
    (status IN ('REJECTED', 'FAILED') AND closed_at IS NOT NULL AND processed_at IS NULL AND failure_code IS NOT NULL) OR
    (status IN ('PENDING', 'PENDING_REFERENCE') AND processed_at IS NULL AND closed_at IS NULL)
  ),
  CONSTRAINT chk_wager_transactions_round_game CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),
  CONSTRAINT chk_wager_transactions_requires_reference CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL)
);

-- Accepted-history deletion checks locate operations by wallet. The reference
-- worker scans only pending dependencies, never all terminal financial history.
CREATE INDEX idx_wager_transactions_wallet_id ON wager_transactions (wallet_id);
CREATE INDEX idx_wager_transactions_pending_reference ON wager_transactions (created_at) WHERE status = 'PENDING_REFERENCE';

-- Section 7: one processed reversal consumes a resolved operation. Reference
-- context validation binds that ID to its provider/external identity.
CREATE UNIQUE INDEX uq_wager_transactions_processed_reference_id
ON wager_transactions (reference_transaction_id)
WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK') AND reference_transaction_id IS NOT NULL;

-- Sections 6.2 and 6.4: exact immutable entries, one per operation/wallet and
-- financial wallet version, with non-negative balanced before/after snapshots.
CREATE TABLE wallet_ledger_entries (
  id UUID PRIMARY KEY,
  wallet_id UUID NOT NULL,
  transaction_id UUID NOT NULL REFERENCES wager_transactions(id),
  wallet_version BIGINT NOT NULL,
  direction VARCHAR(10) NOT NULL,
  amount NUMERIC(20, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  balance_before NUMERIC(20, 2) NOT NULL,
  balance_after NUMERIC(20, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_wallet_ledger_entries_wallet FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
  CONSTRAINT uq_wallet_ledger_entries_tx_wallet UNIQUE (transaction_id, wallet_id),
  CONSTRAINT uq_wallet_ledger_entries_wallet_version UNIQUE (wallet_id, wallet_version),
  CONSTRAINT chk_wallet_ledger_entries_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
  CONSTRAINT chk_wallet_ledger_entries_amount_positive CHECK (amount > 0 AND amount <> 'NaN'::numeric),
  CONSTRAINT chk_wallet_ledger_entries_balance_before_non_negative CHECK (balance_before >= 0 AND balance_before <> 'NaN'::numeric),
  CONSTRAINT chk_wallet_ledger_entries_balance_after_non_negative CHECK (balance_after >= 0 AND balance_after <> 'NaN'::numeric),
  CONSTRAINT chk_wallet_ledger_entries_arithmetic CHECK (
    (direction = 'DEBIT' AND balance_after = balance_before - amount) OR
    (direction = 'CREDIT' AND balance_after = balance_before + amount)
  )
);

-- Section 10: the logical message identity is unique within each consumer.
CREATE TABLE inbox_messages (
  consumer_name VARCHAR(128) NOT NULL,
  message_id VARCHAR(256) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  processed_at TIMESTAMPTZ NULL,
  PRIMARY KEY (consumer_name, message_id)
);

-- Section 11: committed integration events remain durable through broker failure.
-- Paired token/lease fields fence ownership; attempts count failed publications.
CREATE TABLE outbox_messages (
  id UUID PRIMARY KEY,
  aggregate_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NULL,
  published_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  claim_token UUID NULL,
  claim_expires_at TIMESTAMPTZ NULL,
  CONSTRAINT chk_outbox_attempts CHECK (attempts >= 0),
  CONSTRAINT chk_outbox_claim_pair CHECK (
    (claim_token IS NULL) = (claim_expires_at IS NULL)
  )
);

-- Publishers restrict scans to unpublished events eligible for retry.
CREATE INDEX idx_outbox_messages_pending ON outbox_messages (published_at, next_attempt_at)
WHERE published_at IS NULL;
