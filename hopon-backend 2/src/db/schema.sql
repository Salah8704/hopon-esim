-- ================================================================
-- HopOn eSIM Platform — PostgreSQL Schema
-- Version 1.0 — 2025
-- ================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- recherche full-text

-- ─────────────────────────────────────────────────────────────────
-- 1. CATALOGUE (synchronisé depuis Transatel OCS)
-- ─────────────────────────────────────────────────────────────────

-- Pays / destinations
CREATE TABLE countries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  iso2            CHAR(2) NOT NULL UNIQUE,   -- 'MA', 'JP', 'US'
  iso3            CHAR(3),
  name_fr         VARCHAR(100) NOT NULL,
  name_en         VARCHAR(100) NOT NULL,
  flag_emoji      VARCHAR(10),
  continent       VARCHAR(50),               -- 'Africa', 'Asia', ...
  region          VARCHAR(50),               -- 'North Africa', ...
  is_active       BOOLEAN DEFAULT true,
  sort_order      INT DEFAULT 0,
  -- SEO
  slug            VARCHAR(120) UNIQUE,
  meta_title_fr   VARCHAR(200),
  meta_desc_fr    VARCHAR(320),
  -- Storyline visuelle (tunnel immersif)
  storyline       JSONB DEFAULT '[]',        -- [{step,img_url,caption,sub}]
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_countries_iso2       ON countries(iso2);
CREATE INDEX idx_countries_continent  ON countries(continent);
CREATE INDEX idx_countries_active     ON countries(is_active);

-- Produits OCS (forfaits eSIM)
CREATE TABLE products (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Source fournisseur — OBLIGATOIRE, jamais NULL si publié
  source_product_id VARCHAR(100) NOT NULL UNIQUE, -- ID produit côté Transatel
  source_option_id  VARCHAR(100),                  -- ID option OCS si applicable
  cos_ref           VARCHAR(100) NOT NULL,          -- ex: WW_M2MA_COS_SPC

  -- Destination
  country_iso2      CHAR(2) REFERENCES countries(iso2),
  region_code       VARCHAR(50),  -- pour les forfaits régionaux
  is_global         BOOLEAN DEFAULT false,

  -- Description
  name              VARCHAR(200) NOT NULL,
  description       TEXT,
  product_type      VARCHAR(50),  -- 'data_only', 'voice_data', 'unlimited', ...
  category          VARCHAR(50),  -- 'weekend', 'short_stay', 'long_stay', 'business', ...

  -- Données techniques
  duration_days     INT,          -- NULL si non fourni par l'API
  data_amount_mb    BIGINT,       -- NULL si illimité
  is_unlimited      BOOLEAN DEFAULT false,
  speed_mbps        INT,
  hotspot_allowed   BOOLEAN DEFAULT true,
  voice_minutes     INT,          -- NULL si pas d'appels
  sms_count         INT,

  -- ─── PRIX — règle stricte ───────────────────────────────
  -- supplier_price : prix brut retourné par l'API OCS — JAMAIS modifié manuellement
  -- public_price   : prix public HopOn — saisi par admin après validation
  -- Un produit ne peut être publié que si :
  --   1. supplier_price IS NOT NULL
  --   2. public_price IS NOT NULL
  --   3. price_status = 'validated'
  supplier_price    NUMERIC(10,4), -- prix fournisseur exact retourné par l'API
  public_price      NUMERIC(10,2), -- prix client final (saisi admin)
  currency          CHAR(3) DEFAULT 'EUR',
  markup_pct        NUMERIC(5,2),  -- calculé automatiquement, jamais forcé

  -- Statut de validation prix
  price_status      VARCHAR(30) DEFAULT 'not_synced',
  -- 'not_synced' | 'api_error' | 'pending_review' | 'validated' | 'rejected'

  -- Statut publication
  is_published      BOOLEAN DEFAULT false,
  is_featured       BOOLEAN DEFAULT false,
  is_recommended    BOOLEAN DEFAULT false,

  -- WooCommerce
  wc_product_id     BIGINT UNIQUE,  -- ID produit WooCommerce correspondant
  wc_last_pushed    TIMESTAMPTZ,

  -- Sync metadata
  last_synced_at    TIMESTAMPTZ,
  sync_error        TEXT,          -- dernière erreur de sync si applicable
  raw_api_data      JSONB,         -- données brutes retournées par l'API (debug)

  -- SEO
  slug              VARCHAR(200),
  meta_title_fr     VARCHAR(200),
  meta_desc_fr      VARCHAR(320),

  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_products_country     ON products(country_iso2);
CREATE INDEX idx_products_status      ON products(price_status);
CREATE INDEX idx_products_published   ON products(is_published);
CREATE INDEX idx_products_source_id   ON products(source_product_id);
CREATE INDEX idx_products_wc          ON products(wc_product_id);

-- Logs de synchronisation catalogue (audit complet)
CREATE TABLE catalog_sync_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sync_type       VARCHAR(30) NOT NULL,   -- 'full', 'incremental', 'manual'
  status          VARCHAR(20) NOT NULL,   -- 'running', 'success', 'error'
  cos_ref         VARCHAR(100),
  products_fetched   INT DEFAULT 0,
  products_created   INT DEFAULT 0,
  products_updated   INT DEFAULT 0,
  products_errors    INT DEFAULT 0,
  price_issues       INT DEFAULT 0,       -- produits avec prix suspects
  error_details   JSONB DEFAULT '[]',    -- liste des erreurs détaillées
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  duration_ms     INT
);

-- ─────────────────────────────────────────────────────────────────
-- 2. STOCK eSIM (profils SIM physiques)
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE sim_stock (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  iccid           VARCHAR(25) NOT NULL UNIQUE,  -- identifiant unique SIM
  eid             VARCHAR(40),                   -- eUICC ID
  sim_serial      VARCHAR(50),                   -- serial interne Transatel
  batch_ref       VARCHAR(100),                  -- référence du lot d'approvisionnement
  country_scope   CHAR(2),                       -- si SIM dédiée à un pays
  region_scope    VARCHAR(50),

  -- Statut du profil
  status          VARCHAR(30) DEFAULT 'available',
  -- 'available' | 'reserved' | 'subscribed' | 'active' | 'expired' | 'error'

  -- Liaison à une commande
  order_id        UUID,    -- rempli lors de la réservation
  reserved_at     TIMESTAMPTZ,
  reservation_expires_at TIMESTAMPTZ, -- auto-libération si paiement échoue

  -- Détails eSIM récupérés post-souscription
  activation_code VARCHAR(200),
  qr_code_url     VARCHAR(500),   -- URL du QR code fourni par Transatel
  qr_code_data    TEXT,           -- donnée QR brute (base64 ou texte)
  activation_details JSONB,       -- données brutes API SIM Management

  -- Lifecycle
  subscribed_at   TIMESTAMPTZ,
  activated_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sim_status     ON sim_stock(status);
CREATE INDEX idx_sim_iccid      ON sim_stock(iccid);
CREATE INDEX idx_sim_order      ON sim_stock(order_id);

-- ─────────────────────────────────────────────────────────────────
-- 3. CLIENTS
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           VARCHAR(200) NOT NULL UNIQUE,
  email_verified  BOOLEAN DEFAULT false,
  password_hash   VARCHAR(200),             -- NULL si auth SSO uniquement
  first_name      VARCHAR(100),
  last_name       VARCHAR(100),
  phone           VARCHAR(30),
  locale          CHAR(2) DEFAULT 'fr',
  account_type    VARCHAR(20) DEFAULT 'b2c', -- 'b2c' | 'pro'
  pro_company_id  UUID,                      -- liaison compte Pro si applicable
  is_active       BOOLEAN DEFAULT true,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email    ON users(email);
CREATE INDEX idx_users_type     ON users(account_type);

-- Comptes professionnels B2B
CREATE TABLE pro_accounts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_name    VARCHAR(200) NOT NULL,
  vat_number      VARCHAR(50),
  address         JSONB,                    -- {line1, city, zip, country}
  billing_email   VARCHAR(200) NOT NULL,
  account_manager VARCHAR(100),             -- email account manager HopOn
  account_type    VARCHAR(30) DEFAULT 'business', -- 'business'|'agency'|'hotel'|'airline'
  sla_tier        VARCHAR(20) DEFAULT 'standard', -- 'standard'|'premium'
  discount_pct    NUMERIC(5,2) DEFAULT 0,
  credit_limit    NUMERIC(12,2) DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────
-- 4. COMMANDES
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE orders (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_number        VARCHAR(30) NOT NULL UNIQUE,  -- ex: HOP-2025-00001

  -- Source
  wc_order_id         BIGINT UNIQUE,   -- ID WooCommerce
  user_id             UUID REFERENCES users(id),
  customer_email      VARCHAR(200) NOT NULL,
  customer_name       VARCHAR(200),
  pro_account_id      UUID REFERENCES pro_accounts(id),

  -- Produit commandé
  product_id          UUID REFERENCES products(id),
  country_iso2        CHAR(2),
  duration_days       INT,
  quantity            INT DEFAULT 1,

  -- Prix (snapshot au moment de la commande — immuable)
  unit_price          NUMERIC(10,2) NOT NULL,
  total_price         NUMERIC(10,2) NOT NULL,
  currency            CHAR(3) DEFAULT 'EUR',
  supplier_price_snapshot NUMERIC(10,4),   -- prix fournisseur au moment de la commande

  -- Statut de la commande (workflow complet)
  status              VARCHAR(40) NOT NULL DEFAULT 'order_created',
  -- 'order_created' | 'payment_pending' | 'payment_succeeded'
  -- | 'esim_reserved' | 'subscription_requested' | 'subscription_pending'
  -- | 'subscription_success' | 'esim_details_retrieved'
  -- | 'delivery_sent' | 'delivery_failed'
  -- | 'support_required' | 'cancelled' | 'refunded'

  -- eSIM associée
  sim_iccid           VARCHAR(25),     -- rempli lors de la réservation
  activation_code     VARCHAR(200),
  qr_code_url         VARCHAR(500),

  -- Paiement
  payment_method      VARCHAR(50),
  payment_intent_id   VARCHAR(200),   -- Stripe payment intent (via WC)
  paid_at             TIMESTAMPTZ,

  -- Subscription OCS
  ocs_subscription_id VARCHAR(200),   -- ID souscription Transatel
  ocs_transaction_id  VARCHAR(200),
  ocs_status          VARCHAR(100),

  -- Delivery
  delivery_sent_at    TIMESTAMPTZ,
  delivery_attempts   INT DEFAULT 0,

  -- Timestamps status
  status_history      JSONB DEFAULT '[]',  -- [{status, at, note}]
  error_message       TEXT,
  retry_count         INT DEFAULT 0,
  next_retry_at       TIMESTAMPTZ,

  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orders_status      ON orders(status);
CREATE INDEX idx_orders_user        ON orders(user_id);
CREATE INDEX idx_orders_wc          ON orders(wc_order_id);
CREATE INDEX idx_orders_iccid       ON orders(sim_iccid);
CREATE INDEX idx_orders_email       ON orders(customer_email);
CREATE INDEX idx_orders_created     ON orders(created_at DESC);

-- ─────────────────────────────────────────────────────────────────
-- 5. LOGS
-- ─────────────────────────────────────────────────────────────────

-- Logs API Transatel (audit de chaque appel)
CREATE TABLE api_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID REFERENCES orders(id),
  service     VARCHAR(50) NOT NULL,  -- 'ocs_catalog'|'ocs_subscription'|'sim_management'|'connectivity'
  method      VARCHAR(10),           -- GET, POST, PUT
  endpoint    VARCHAR(300),
  request_body  JSONB,
  response_status INT,
  response_body   JSONB,
  duration_ms  INT,
  error        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_api_logs_order   ON api_logs(order_id);
CREATE INDEX idx_api_logs_service ON api_logs(service);
CREATE INDEX idx_api_logs_status  ON api_logs(response_status);

-- Logs emails
CREATE TABLE email_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID REFERENCES orders(id),
  user_id     UUID REFERENCES users(id),
  template    VARCHAR(50) NOT NULL,   -- 'delivery', 'confirmation', 'error', ...
  to_email    VARCHAR(200) NOT NULL,
  subject     VARCHAR(300),
  status      VARCHAR(20),            -- 'sent', 'failed', 'bounced'
  provider_id VARCHAR(200),           -- ID Brevo/SMTP
  error       TEXT,
  sent_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────
-- 6. SEO / CONTENU
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE seo_pages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  page_type   VARCHAR(30) NOT NULL,  -- 'country'|'region'|'category'|'guide'|'faq'
  entity_id   UUID,                  -- ref vers country/product selon type
  slug        VARCHAR(200) NOT NULL UNIQUE,
  lang        CHAR(2) DEFAULT 'fr',
  title       VARCHAR(200) NOT NULL,
  meta_title  VARCHAR(200),
  meta_desc   VARCHAR(320),
  h1          VARCHAR(200),
  content     TEXT,
  schema_data JSONB,                 -- données structurées JSON-LD
  is_indexed  BOOLEAN DEFAULT true,
  score       SMALLINT DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE faq_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category    VARCHAR(50),     -- 'activation'|'installation'|'payment'|'general'
  question_fr VARCHAR(500) NOT NULL,
  answer_fr   TEXT NOT NULL,
  sort_order  INT DEFAULT 0,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────
-- 7. TRIGGERS — updated_at automatique
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['countries','products','sim_stock','users','pro_accounts','orders']
  LOOP
    EXECUTE FORMAT(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at()', tbl);
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────────
-- 8. SEED — pays de base
-- ─────────────────────────────────────────────────────────────────

INSERT INTO countries (iso2, iso3, name_fr, name_en, flag_emoji, continent, region, slug) VALUES
('JP','JPN','Japon',    'Japan',        '🇯🇵','Asia',   'East Asia',         'esim-japon'),
('MA','MAR','Maroc',    'Morocco',      '🇲🇦','Africa', 'North Africa',      'esim-maroc'),
('TH','THA','Thaïlande','Thailand',     '🇹🇭','Asia',   'Southeast Asia',    'esim-thailande'),
('US','USA','États-Unis','United States','🇺🇸','Americas','North America',   'esim-usa'),
('IT','ITA','Italie',   'Italy',        '🇮🇹','Europe', 'Southern Europe',   'esim-italie'),
('AU','AUS','Australie','Australia',    '🇦🇺','Oceania','Oceania',           'esim-australie'),
('AE','ARE','Émirats',  'UAE',          '🇦🇪','Asia',   'Middle East',       'esim-emirats'),
('ES','ESP','Espagne',  'Spain',        '🇪🇸','Europe', 'Southern Europe',   'esim-espagne'),
('BR','BRA','Brésil',   'Brazil',       '🇧🇷','Americas','South America',    'esim-bresil'),
('MX','MEX','Mexique',  'Mexico',       '🇲🇽','Americas','North America',    'esim-mexique'),
('IN','IND','Inde',     'India',        '🇮🇳','Asia',   'South Asia',        'esim-inde'),
('SN','SEN','Sénégal',  'Senegal',      '🇸🇳','Africa', 'West Africa',       'esim-senegal'),
('TR','TUR','Turquie',  'Turkey',       '🇹🇷','Europe', 'Southern Europe',   'esim-turquie'),
('EG','EGY','Égypte',   'Egypt',        '🇪🇬','Africa', 'North Africa',      'esim-egypte')
ON CONFLICT (iso2) DO NOTHING;
