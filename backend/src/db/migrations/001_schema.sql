-- Fanbassy Database Schema
-- Run once: psql $DATABASE_URL -f 001_schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── USERS
CREATE TABLE IF NOT EXISTS users (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  username      VARCHAR(50)  UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20)  NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  referred_by   UUID         REFERENCES users(id),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── WALLETS
CREATE TABLE IF NOT EXISTS wallets (
  user_id         UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance         DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_deposited DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_withdrawn DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_won       DECIMAL(12,2) NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── TRANSACTIONS
CREATE TABLE IF NOT EXISTS transactions (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID         NOT NULL REFERENCES users(id),
  type           VARCHAR(30)  NOT NULL,
  amount         DECIMAL(12,2) NOT NULL,
  balance_before DECIMAL(12,2) NOT NULL,
  balance_after  DECIMAL(12,2) NOT NULL,
  description    TEXT,
  metadata       JSONB        NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tx_user    ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at DESC);

-- ── PREDICTIONS
CREATE TABLE IF NOT EXISTS predictions (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id        VARCHAR(100) NOT NULL,
  type            CHAR(1)      NOT NULL CHECK (type IN ('A','B','C')),
  question        TEXT         NOT NULL,
  options         JSONB        NOT NULL,
  votes           JSONB        NOT NULL DEFAULT '[]',
  pools           JSONB        NOT NULL DEFAULT '[]',
  total_pool      DECIMAL(12,2) NOT NULL DEFAULT 0,
  status          VARCHAR(20)  NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','cancelled')),
  winner          INTEGER,
  house_win       BOOLEAN      NOT NULL DEFAULT false,
  house_sweep_amt DECIMAL(12,2) NOT NULL DEFAULT 0,
  resolve_mode    VARCHAR(30)  NOT NULL DEFAULT 'normal',
  null_label      TEXT,
  triple_idx      INTEGER,
  multiplier      INTEGER,
  duration_sec    INTEGER      NOT NULL,
  closes_at       TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pred_status ON predictions(status);
CREATE INDEX IF NOT EXISTS idx_pred_match  ON predictions(match_id);

-- ── BETS
CREATE TABLE IF NOT EXISTS bets (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL REFERENCES users(id),
  prediction_id UUID         NOT NULL REFERENCES predictions(id),
  option_idx    INTEGER      NOT NULL,
  amount        DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  payout        DECIMAL(12,2) NOT NULL DEFAULT 0,
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','refunded')),
  is_jackpot    BOOLEAN      NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, prediction_id)
);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id);
CREATE INDEX IF NOT EXISTS idx_bets_pred ON bets(prediction_id);

-- ── AUDIT LOG (immutable — never delete rows)
CREATE TABLE IF NOT EXISTS audit_log (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id   UUID         REFERENCES predictions(id),
  match_id        VARCHAR(100),
  type            CHAR(1),
  resolve_mode    VARCHAR(30),
  total_pool      DECIMAL(12,2),
  house_sweep_amt DECIMAL(12,2),
  winner_idx      INTEGER,
  bets_count      INTEGER,
  distribution    JSONB,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── AFFILIATES
CREATE TABLE IF NOT EXISTS affiliates (
  user_id        UUID         PRIMARY KEY REFERENCES users(id),
  code           VARCHAR(20)  UNIQUE NOT NULL,
  level          INTEGER      NOT NULL DEFAULT 1,
  commission_pct DECIMAL(4,2) NOT NULL DEFAULT 0.20,
  total_earned   DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_referrals INTEGER     NOT NULL DEFAULT 0,
  is_active      BOOLEAN      NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── WITHDRAWALS
CREATE TABLE IF NOT EXISTS withdrawals (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID         NOT NULL REFERENCES users(id),
  amount     DECIMAL(12,2) NOT NULL,
  clabe      VARCHAR(18)  NOT NULL,
  status     VARCHAR(20)  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','processing','done')),
  notes      TEXT,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── SEED: default admin user (password: admin123)
INSERT INTO users (id, email, username, password_hash, role)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'admin@fanbassy.com',
  'Admin',
  '$2b$12$K8GpYgp.9e3r6H6Q2ZGxLeKJH8vLwYJ7fGO4A8xHiJd7kN3FvILSW',
  'admin'
) ON CONFLICT (email) DO NOTHING;

INSERT INTO wallets (user_id, balance, total_deposited)
VALUES ('00000000-0000-0000-0000-000000000001', 1000, 1000)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO affiliates (user_id, code, level, commission_pct)
VALUES ('00000000-0000-0000-0000-000000000001', 'ADMIN2026', 2, 0.30)
ON CONFLICT (user_id) DO NOTHING;
