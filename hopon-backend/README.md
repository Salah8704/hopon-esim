# hopOn Backend — Guide de déploiement

Le backend hopOn fait le pont entre votre site, l'API Transatel et WooCommerce.
Il est **obligatoire** pour :
- Synchroniser le catalogue Transatel
- Activer les eSIM automatiquement après paiement
- Envoyer les QR codes par email

---

## Option 1 — Railway (RECOMMANDÉ — gratuit, 5 min)

Railway héberge Node.js + PostgreSQL gratuitement.

### Étapes

1. **Créez un compte** sur [railway.app](https://railway.app)

2. **Créez un nouveau projet** → "Deploy from GitHub repo"
   - Importez votre repo GitHub (le dossier `hopon-backend`)
   - OU utilisez "Deploy from local" avec la CLI

3. **Ajoutez PostgreSQL** → "+ New" → "Database" → "PostgreSQL"
   - Railway lie automatiquement la variable `DATABASE_URL`

4. **Configurez les variables d'environnement** → Settings → Variables :

```
NODE_ENV=production
OCS_BASE_URL=https://ocs.transatel.com
OCS_USERNAME=votre_username_transatel
OCS_PASSWORD=votre_password_transatel
COS_REF=WW_M2MA_COS_SPC
WC_BASE_URL=https://votre-boutique.com
WC_CONSUMER_KEY=ck_xxxxx
WC_CONSUMER_SECRET=cs_xxxxx
WC_WEBHOOK_SECRET=whsec_xxxxx
JWT_SECRET=un_secret_aleatoire_32_caracteres_minimum
BREVO_API_KEY=xkeysib-xxxxx
EMAIL_FROM_ADDRESS=contact@hopon.fr
CORS_ORIGINS=https://hopon.fr,https://hopon.fr/admin.html
```

5. **Lancez les migrations** → Railway CLI ou terminal dans le dashboard :
```bash
npm run migrate
```

6. **Votre backend sera disponible sur** : `https://hopon-backend-xxx.railway.app`

7. **Mettez à jour le dashboard admin hopOn** → WooCommerce → URL webhook :
```
https://hopon-backend-xxx.railway.app/webhooks/woocommerce
```

---

## Option 2 — Render.com (gratuit, 10 min)

1. Créez un compte sur [render.com](https://render.com)
2. "+ New" → "Web Service" → connectez votre repo GitHub
3. Sélectionnez le dossier `hopon-backend`
4. "+ New" → "PostgreSQL" (plan Free)
5. Configurez les variables d'environnement (mêmes que ci-dessus)
6. Render lancera `npm run migrate` automatiquement (via `release` command dans render.yaml)

---

## Option 3 — VPS Hostinger (si vous avez un plan VPS)

### Prérequis
- VPS Hostinger avec Ubuntu 22.04
- Accès SSH

### Installation

```bash
# 1. Connexion SSH
ssh root@votre-ip-vps

# 2. Installation Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 3. Installation PostgreSQL
apt install -y postgresql postgresql-contrib
sudo -u postgres createuser --pwprompt hopon_user
sudo -u postgres createdb -O hopon_user hopon_db

# 4. Installation Redis
apt install -y redis-server
systemctl enable redis-server

# 5. Cloner le projet
git clone votre-repo /var/www/hopon-backend
cd /var/www/hopon-backend

# 6. Configuration
cp .env.example .env
nano .env   # Remplir toutes les variables

# 7. Installation des dépendances
npm install --production

# 8. Migration base de données
npm run migrate

# 9. PM2 (gestionnaire de processus)
npm install -g pm2
pm2 start npm --name "hopon-backend" -- start
pm2 save
pm2 startup

# 10. Nginx reverse proxy
apt install -y nginx

cat > /etc/nginx/sites-available/hopon-backend << 'NGINX'
server {
    listen 80;
    server_name api.hopon.fr;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX

ln -s /etc/nginx/sites-available/hopon-backend /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 11. SSL avec Let's Encrypt
apt install -y certbot python3-certbot-nginx
certbot --nginx -d api.hopon.fr
```

---

## Variables d'environnement obligatoires

| Variable | Description | Exemple |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |
| `OCS_USERNAME` | Username Transatel | fourni par Transatel |
| `OCS_PASSWORD` | Password Transatel | fourni par Transatel |
| `COS_REF` | Référence COS Transatel | `WW_M2MA_COS_SPC` |
| `WC_BASE_URL` | URL de votre boutique WooCommerce | `https://votresite.com` |
| `WC_CONSUMER_KEY` | Clé API WooCommerce | `ck_xxx...` |
| `WC_CONSUMER_SECRET` | Secret API WooCommerce | `cs_xxx...` |
| `JWT_SECRET` | Secret JWT (min 32 chars) | chaîne aléatoire |
| `BREVO_API_KEY` | Clé API Brevo | `xkeysib-xxx...` |
| `CORS_ORIGINS` | Origines autorisées | `https://hopon.fr` |

---

## Endpoints principaux

| Route | Description |
|---|---|
| `GET /health` | Statut du serveur |
| `GET /api/v1/catalog/countries` | Liste des pays |
| `GET /api/v1/catalog/products` | Forfaits disponibles |
| `POST /webhooks/woocommerce` | Webhook commandes WC |
| `POST /api/v1/admin/sync/catalog` | Sync catalogue Transatel |
| `GET /api/v1/admin/dashboard` | Stats admin |

---

## Après déploiement

1. **Testez la connexion** : `curl https://votre-backend.railway.app/health`
2. **Mettez à jour le dashboard admin** → Transatel → bouton "Tester"
3. **Lancez une première sync** → Transatel → "Synchroniser le catalogue"
4. **Configurez le webhook WooCommerce** avec l'URL de votre backend

