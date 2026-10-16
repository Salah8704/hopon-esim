# Déploiement Hostinger — HopOn Partner

Cette branche conserve l'ancien code historique à la racine et fournit deux dossiers de production compatibles avec l'installation Hostinger réelle :

- `deploy/frontend` : site HopOn v35 + correctif v35.1 + portail partenaire ;
- `deploy/api` : API HopOn v30 Node.js + MySQL + attribution des commissions.

## Préparation obligatoire

1. Sauvegarder les fichiers du site et la base MySQL depuis Hostinger.
2. Ne pas remplacer le fichier `.env` de production.
3. Ajouter dans l'environnement de l'API :

```env
PARTNER_JWT_SECRET=une-cle-aleatoire-differente-de-JWT_SECRET
IP_HASH_SALT=une-autre-valeur-aleatoire
```

## API `api.hopon.fr`

1. Déployer le contenu de `deploy/api` dans l'application Node.js Hostinger.
2. Exécuter `npm ci`.
3. Exécuter `npm run migrate` : la migration MySQL ajoute uniquement les tables et colonnes partenaires manquantes.
4. Redémarrer l'application avec `npm start`.
5. Vérifier `https://api.hopon.fr/health` avant de toucher au frontend.

## Frontend `hopon.fr`

Après validation de l'API, déployer le contenu de `deploy/frontend` dans `public_html`.

Pages ajoutées :

- `/partner.html` : inscription, connexion, tableau de bord et affiche PDF ;
- `/partner-admin.html` : validation des comptes et commissions.

## Test avant paiements réels

1. Créer un partenaire test.
2. L'activer et définir sa commission dans `/partner-admin.html`.
3. Télécharger l'affiche et ouvrir son QR code.
4. Effectuer un paiement Stripe en mode test.
5. Vérifier l'attribution dans le tableau de bord partenaire et l'administration.

La fusion dans `main` ne doit être faite qu'après ces contrôles, car le site public renvoie actuellement une erreur 502 indépendante du module partenaire.
