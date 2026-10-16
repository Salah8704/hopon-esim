-- ================================================================
-- HopOn — Schéma Partenaires & Affiliation
-- ================================================================

CREATE TABLE IF NOT EXISTS partners (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_code    VARCHAR(50) NOT NULL UNIQUE,  -- ex: RIAD-MAR-001
  name            VARCHAR(200) NOT NULL,
  business_name   VARCHAR(200),
  password_hash   VARCHAR(200),
  type            VARCHAR(30) NOT NULL,  -- driver|host|hotel|agency|other
  country_iso2    CHAR(2),
  email           VARCHAR(200) NOT NULL UNIQUE,
  phone           VARCHAR(30),
  website         VARCHAR(300),
  -- Commission
  commission_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  commission_fixed NUMERIC(10,2) NOT NULL DEFAULT 0,
  commission_type VARCHAR(20) DEFAULT 'percentage',  -- percentage|fixed
  -- Paiement
  payment_method  VARCHAR(30),   -- sepa|paypal|wise
  payment_details JSONB,
  min_payout      NUMERIC(8,2) DEFAULT 20.00,
  -- Statut
  status          VARCHAR(20) DEFAULT 'pending',  -- pending|active|suspended|terminated
  poster_version  INT DEFAULT 1,
  -- Métriques
  total_clicks    INT DEFAULT 0,
  total_sales     INT DEFAULT 0,
  total_revenue   NUMERIC(12,2) DEFAULT 0,
  total_commission NUMERIC(12,2) DEFAULT 0,
  commission_paid NUMERIC(12,2) DEFAULT 0,
  -- Notes
  notes           TEXT,
  created_by      VARCHAR(100),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE partners ADD COLUMN IF NOT EXISTS business_name VARCHAR(200);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS password_hash VARCHAR(200);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS commission_fixed NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS poster_version INT DEFAULT 1;

-- Clics / visites depuis les liens partenaires
CREATE TABLE IF NOT EXISTS partner_clicks (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id  UUID NOT NULL REFERENCES partners(id),
  source      VARCHAR(50),   -- link|qr|widget
  page        VARCHAR(200),
  ip_hash     VARCHAR(32),   -- hash pour déduplications, jamais l'IP brute
  user_agent  VARCHAR(200),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pclicks_partner ON partner_clicks(partner_id);
CREATE INDEX IF NOT EXISTS idx_pclicks_date    ON partner_clicks(created_at DESC);

-- Ventes attribuées à un partenaire
CREATE TABLE IF NOT EXISTS partner_referrals (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id          UUID NOT NULL REFERENCES partners(id),
  order_id            UUID REFERENCES orders(id),
  country_iso2        CHAR(2),
  sale_amount         NUMERIC(10,2) NOT NULL,
  commission_pct      NUMERIC(5,2) NOT NULL,
  commission_amount   NUMERIC(10,2) NOT NULL,
  currency            CHAR(3) DEFAULT 'EUR',
  status              VARCHAR(20) DEFAULT 'pending',  -- pending|validated|paid|cancelled
  paid_at             TIMESTAMPTZ,
  payout_id           UUID,
  source              VARCHAR(50) DEFAULT 'link',
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE partner_referrals ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'link';
ALTER TABLE partner_referrals ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE INDEX IF NOT EXISTS idx_preferrals_partner ON partner_referrals(partner_id);
CREATE INDEX IF NOT EXISTS idx_preferrals_order   ON partner_referrals(order_id);
CREATE INDEX IF NOT EXISTS idx_preferrals_status  ON partner_referrals(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_preferrals_order_unique ON partner_referrals(order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_preferrals_notes_unique ON partner_referrals(notes) WHERE notes IS NOT NULL;

-- Versements de commissions
CREATE TABLE IF NOT EXISTS commission_payouts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id      UUID NOT NULL REFERENCES partners(id),
  amount          NUMERIC(10,2) NOT NULL,
  currency        CHAR(3) DEFAULT 'EUR',
  referral_ids    UUID[],       -- liste des referrals couverts
  payment_method  VARCHAR(30),
  payment_ref     VARCHAR(200),
  status          VARCHAR(20) DEFAULT 'pending',  -- pending|processing|completed|failed
  processed_by    VARCHAR(100),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  paid_at         TIMESTAMPTZ
);

-- Ajouter la colonne partner_id à orders
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='partner_id') THEN
    ALTER TABLE orders ADD COLUMN partner_id UUID REFERENCES partners(id);
    ALTER TABLE orders ADD COLUMN partner_source VARCHAR(50);
    CREATE INDEX idx_orders_partner ON orders(partner_id);
  END IF;
END $$;
