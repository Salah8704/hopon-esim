# Déploiement de HopOn Partner

## Ce qui est livré

- Portail public et espace partenaire : `/partner/`
- Administration dédiée : `/partner/admin.html`
- API : `/api/v1/partners/*`
- Attribution Stripe et WooCommerce
- Affiche PDF véhicule ou hébergement avec QR code personnel
- Migration PostgreSQL : `hopon-backend/src/db/schema_partners.sql`

## Variables obligatoires

Ajouter à l'environnement du backend :

```env
SITE_URL=https://hopon.fr
PARTNER_JWT_SECRET=une-cle-aleatoire-d-au-moins-32-caracteres
IP_HASH_SALT=une-autre-valeur-aleatoire
```

Conserver aussi les variables existantes (`DATABASE_URL`, Stripe, Transatel, Redis et administration).

## Mise en production

1. Sauvegarder la base PostgreSQL.
2. Exécuter `hopon-backend/src/db/schema_partners.sql` sur la base.
3. Dans `hopon-backend`, exécuter `npm ci` puis redéployer le service API.
4. Déployer `index.html` et le dossier `partner/` sur le site HopOn.
5. Vérifier que le webhook Stripe vise `/api/v1/stripe/webhook`.
6. Créer un compte test, l'activer dans `/partner/admin.html`, télécharger son affiche et effectuer une commande Stripe en mode test.

## Règles métier

- Un nouveau partenaire reste `pending` jusqu'à validation.
- Le taux de commission est `0` tant que l'administrateur ne l'a pas défini.
- Une vente remboursée doit être passée à `cancelled` dans l'administration.
- Une commission versée doit être passée à `paid`.
- Les affiches ne sont téléchargeables que par les partenaires actifs.
