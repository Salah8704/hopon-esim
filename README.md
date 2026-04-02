# hopOn eSIM — Site web premium

Site web immersif pour la plateforme eSIM hopOn.

## Structure

```
/
├── index.html          # Site principal (globe D3, tunnel achat, SEO international)
├── admin.html          # Dashboard admin (accès restreint — noindex)
├── hopon-backend.tar.gz # Backend Node.js (API Transatel + WooCommerce)
├── sitemap.xml
├── robots.txt
└── site.webmanifest
```

## Déploiement rapide

### GitHub Pages (gratuit)
1. Activer GitHub Pages → Settings → Pages → Source: `main` `/root`
2. Le site sera accessible sur `https://[username].github.io/[repo]`

### Vercel (recommandé)
```bash
npm i -g vercel
vercel --prod
```

### Netlify
Glisser-déposer le dossier sur [netlify.com/drop](https://app.netlify.com/drop)

## Backend

```bash
tar -xzf hopon-backend.tar.gz
cd hopon-backend
cp .env.example .env
# Remplir OCS_USERNAME, OCS_PASSWORD, WC_*, SMTP_*, JWT_SECRET
npm install
npm run migrate
npm start
```

## Contact
contact@hopon.fr
