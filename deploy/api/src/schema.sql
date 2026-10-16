SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS countries(
  iso2 CHAR(2) PRIMARY KEY,
  name_fr VARCHAR(100) NOT NULL,
  name_en VARCHAR(100),
  flag_emoji VARCHAR(16),
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products(
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  transatel_product_id VARCHAR(120) NOT NULL UNIQUE,
  transatel_option_id VARCHAR(120),
  country_iso2 CHAR(2),
  name VARCHAR(220) NOT NULL,
  description TEXT,
  data_amount_mb BIGINT,
  duration_days INT,
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  purchase_price_ht DECIMAL(10,4),
  recommended_price_ht DECIMAL(10,2),
  supplier_retail_price_ttc DECIMAL(10,2),
  markup_percent DECIMAL(7,2),
  selling_price_ht DECIMAL(10,2),
  vat_rate DECIMAL(5,2) NOT NULL DEFAULT 20.00,
  vat_amount DECIMAL(10,2) GENERATED ALWAYS AS (ROUND(COALESCE(selling_price_ht,0)*vat_rate/100,2)) STORED,
  selling_price_ttc DECIMAL(10,2) GENERATED ALWAYS AS (ROUND(COALESCE(selling_price_ht,0)*(1+vat_rate/100),2)) STORED,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  supplier_change_label VARCHAR(80),
  raw_data JSON,
  last_synced_at DATETIME,
  last_price_import_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_product_country FOREIGN KEY(country_iso2) REFERENCES countries(iso2),
  INDEX idx_products_public(country_iso2,is_published),
  INDEX idx_products_sync(last_synced_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS country_purchase_rates(
  country_iso2 CHAR(2) PRIMARY KEY,
  transatel_reference CHAR(3) NOT NULL UNIQUE,
  country_name VARCHAR(100) NOT NULL,
  availability VARCHAR(40),
  price_per_gb_eur DECIMAL(12,6) NOT NULL,
  source_filename VARCHAR(255),
  imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_purchase_rates_reference(transatel_reference)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS esim_profiles(
  id CHAR(36) PRIMARY KEY,
  serial_number VARCHAR(22) NOT NULL UNIQUE,
  iccid VARCHAR(22) NOT NULL UNIQUE,
  imsi VARCHAR(20) NOT NULL UNIQUE,
  msisdn VARCHAR(20) NOT NULL UNIQUE,
  sim_type VARCHAR(100),
  sim_reference VARCHAR(180),
  provisioning_status VARCHAR(60),
  prepaid_status VARCHAR(60),
  esim_status VARCHAR(60),
  service_pack VARCHAR(180),
  rate_plan VARCHAR(180),
  mvno_ref VARCHAR(120),
  assignment_status VARCHAR(20) NOT NULL DEFAULT 'unavailable',
  assigned_order_id CHAR(36),
  assigned_email VARCHAR(220),
  reserved_at DATETIME,
  assigned_at DATETIME,
  source_filename VARCHAR(255),
  last_imported_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_esim_stock(assignment_status,provisioning_status),
  INDEX idx_esim_email(assigned_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS esim_stock_imports(
  id CHAR(36) PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL,
  profiles_received INT NOT NULL DEFAULT 0,
  profiles_inserted INT NOT NULL DEFAULT 0,
  profiles_updated INT NOT NULL DEFAULT 0,
  profiles_skipped INT NOT NULL DEFAULT 0,
  available_after_import INT NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  INDEX idx_esim_import_started(started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS checkout_batches(
  id CHAR(36) PRIMARY KEY,
  stripe_session_id VARCHAR(255) UNIQUE,
  payer_email VARCHAR(220) NOT NULL,
  payer_name VARCHAR(180) NOT NULL,
  language VARCHAR(5) NOT NULL DEFAULT 'fr',
  items_json JSON NOT NULL,
  item_count INT NOT NULL,
  total_ttc DECIMAL(10,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  terms_version VARCHAR(20),
  accepted_at DATETIME,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  processed_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_checkout_batches_created(created_at),
  INDEX idx_checkout_batches_status(status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders(
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  order_number VARCHAR(32) NOT NULL UNIQUE,
  stripe_session_id VARCHAR(255) NOT NULL,
  stripe_payment_intent VARCHAR(255),
  stripe_invoice_id VARCHAR(255),
  stripe_livemode BOOLEAN NOT NULL DEFAULT FALSE,
  customer_email VARCHAR(220) NOT NULL,
  customer_name VARCHAR(180),
  payer_email VARCHAR(220),
  payer_name VARCHAR(180),
  customer_phone VARCHAR(60),
  customer_address JSON,
  language VARCHAR(5) NOT NULL DEFAULT 'fr',
  order_type VARCHAR(20) NOT NULL DEFAULT 'new_esim',
  checkout_batch_id CHAR(36),
  batch_item_index INT NOT NULL DEFAULT 0,
  esim_profile_id CHAR(36),
  parent_order_id CHAR(36),
  product_id CHAR(36),
  product_name VARCHAR(220) NOT NULL,
  country_iso2 CHAR(2),
  purchase_price_ht DECIMAL(10,4),
  selling_price_ht DECIMAL(10,2) NOT NULL,
  vat_rate DECIMAL(5,2) NOT NULL,
  vat_amount DECIMAL(10,2) NOT NULL,
  total_ttc DECIMAL(10,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  terms_version VARCHAR(20),
  terms_accepted_at DATETIME,
  withdrawal_waiver_at DATETIME,
  status VARCHAR(30) NOT NULL DEFAULT 'paid',
  transatel_subscription_id VARCHAR(180),
  activation_code TEXT,
  qr_code_url TEXT,
  failure_reason TEXT,
  paid_at DATETIME,
  delivered_at DATETIME,
  invoice_sent_at DATETIME,
  invoice_number VARCHAR(32),
  invoice_issued_at DATETIME,
  recipient_sent_at DATETIME,
  payer_confirmation_sent_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_product FOREIGN KEY(product_id) REFERENCES products(id),
  UNIQUE KEY uq_orders_session_item(stripe_session_id,batch_item_index),
  UNIQUE KEY uq_orders_invoice_number(invoice_number),
  INDEX idx_orders_created(created_at), INDEX idx_orders_status(status), INDEX idx_orders_email(customer_email), INDEX idx_orders_esim(esim_profile_id), INDEX idx_orders_batch(checkout_batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invoice_sequences(
  invoice_year INT PRIMARY KEY,
  last_number BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS recharge_codes(
  id CHAR(36) PRIMARY KEY,
  customer_email VARCHAR(220) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  used_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_recharge_code_email(customer_email,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS jobs(
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  job_key VARCHAR(190) NOT NULL UNIQUE,
  type VARCHAR(60) NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  run_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at DATETIME,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_jobs_ready(status,run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sync_logs(
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  status VARCHAR(20) NOT NULL,
  products_received INT DEFAULT 0,
  products_created INT DEFAULT 0,
  products_updated INT DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_changes(
  id CHAR(36) PRIMARY KEY,
  sync_log_id CHAR(36),
  product_id CHAR(36),
  transatel_product_id VARCHAR(120),
  country_iso2 CHAR(2),
  change_type VARCHAR(40) NOT NULL,
  field_name VARCHAR(80),
  old_value TEXT,
  new_value TEXT,
  is_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_catalog_changes_reviewed(is_reviewed,created_at),
  INDEX idx_catalog_changes_product(product_id),
  CONSTRAINT fk_catalog_change_sync FOREIGN KEY(sync_log_id) REFERENCES sync_logs(id),
  CONSTRAINT fk_catalog_change_product FOREIGN KEY(product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS catalog_imports(
  id CHAR(36) PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL,
  products_received INT NOT NULL DEFAULT 0,
  products_created INT NOT NULL DEFAULT 0,
  products_updated INT NOT NULL DEFAULT 0,
  prices_changed INT NOT NULL DEFAULT 0,
  products_removed INT NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  INDEX idx_catalog_imports_started(started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_settings(
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS partners(
  id CHAR(36) PRIMARY KEY, partner_code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL, business_name VARCHAR(200), type VARCHAR(30) NOT NULL,
  email VARCHAR(200) NOT NULL UNIQUE, phone VARCHAR(30), password_hash VARCHAR(200) NOT NULL,
  commission_type VARCHAR(20) NOT NULL DEFAULT 'percentage', commission_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  commission_fixed DECIMAL(10,2) NOT NULL DEFAULT 0, status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_partners_status(status), INDEX idx_partners_code(partner_code)
);
CREATE TABLE IF NOT EXISTS partner_clicks(
  id CHAR(36) PRIMARY KEY, partner_id CHAR(36) NOT NULL, source VARCHAR(50), page VARCHAR(200),
  ip_hash VARCHAR(32), user_agent VARCHAR(200), created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_partner_clicks_partner FOREIGN KEY(partner_id) REFERENCES partners(id), INDEX idx_partner_clicks(partner_id,created_at)
);
CREATE TABLE IF NOT EXISTS partner_referrals(
  id CHAR(36) PRIMARY KEY, partner_id CHAR(36) NOT NULL, order_id CHAR(36), country_iso2 CHAR(2),
  sale_amount DECIMAL(10,2) NOT NULL, commission_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  commission_amount DECIMAL(10,2) NOT NULL, currency CHAR(3) NOT NULL DEFAULT 'EUR',
  status VARCHAR(20) NOT NULL DEFAULT 'pending', source VARCHAR(50) DEFAULT 'link', stripe_session_id VARCHAR(255),
  paid_at DATETIME, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_partner_referrals_partner FOREIGN KEY(partner_id) REFERENCES partners(id),
  UNIQUE KEY uq_partner_order(order_id), UNIQUE KEY uq_partner_stripe(stripe_session_id), INDEX idx_partner_referrals(partner_id,status)
);

INSERT INTO countries(iso2,name_fr,name_en,flag_emoji,sort_order) VALUES
('FR','France','France','🇫🇷',1),('MA','Maroc','Morocco','🇲🇦',2),
('US','États-Unis','United States','🇺🇸',3),('JP','Japon','Japan','🇯🇵',4),
('GB','Royaume-Uni','United Kingdom','🇬🇧',5),('ES','Espagne','Spain','🇪🇸',6),
('IT','Italie','Italy','🇮🇹',7),('TR','Turquie','Turkey','🇹🇷',8),
('TH','Thaïlande','Thailand','🇹🇭',9),('AE','Émirats arabes unis','United Arab Emirates','🇦🇪',10)
ON DUPLICATE KEY UPDATE name_fr=VALUES(name_fr),name_en=VALUES(name_en),flag_emoji=VALUES(flag_emoji);
