# Migration mybatch-app : actions manuelles restantes

Document de bord pour ouvrir mybatch.cooking au public. Toutes les modifs code sont déjà faites, il reste 2 lots d'actions à faire dans Supabase et Stripe.

---

## 1. Créer le compte super-admin Supabase

**But** : que `structify.crm@gmail.com` puisse se connecter à `app.mybatch.cooking` et accéder à l'onglet "🏢 Entreprises" pour gérer les abonnées.

### Étapes dans Supabase Studio

Va sur **https://app.supabase.com/project/<ton_project_id>/auth/users** puis :

#### A. Créer le user d'auth

1. Clique **"Add user"** → "Create new user"
2. Email : `structify.crm@gmail.com`
3. Password : choisis-en un solide (16+ chars), note-le
4. Coche **"Auto Confirm User"**
5. Crée → tu obtiens un `user_id` (UUID), copie-le

#### B. Créer l'entreprise "My Batch Admin"

Va dans **Table Editor → entreprises** puis "Insert row" :

```
slug                 : mybatch-admin
nom_marque           : My Batch (Super-Admin)
nom_contact          : Super-Admin
admin_email          : structify.crm@gmail.com
admin_password       : [le mot de passe que tu as noté]
plan                 : founder
formule              : premium
cycle                : annuel
couleur_principale   : #E8843D
couleur_secondaire   : #3D6B4F
couleur_topbar       : #1A1A1A
active               : true
subscription_status  : active
```

Save → copie le `id` (UUID) de la ligne créée.

#### C. Lier le user à l'entreprise

Va dans **Table Editor → admins_entreprise** puis "Insert row" :

```
user_id        : [le user_id de l'étape A]
entreprise_id  : [le id de l'étape B]
nom            : Super-Admin
```

Save.

#### D. Tester

- Va sur https://app.mybatch.cooking
- Login avec `structify.crm@gmail.com` + le mot de passe
- Tu devrais arriver sur `admin.html` avec tous les onglets super-admin visibles, dont "🏢 Entreprises"
- Vérification : Le Goût du Lien ne doit PAS apparaître dans la liste des entreprises (filtré dans admin.js)

---

## 2. Configurer Stripe pour les 3 produits

**But** : avoir les bons price_id pour brancher le tunnel d'inscription depuis `mybatch.cooking`.

### Étapes dans Stripe Dashboard (mode live)

Va sur **https://dashboard.stripe.com/products** :

#### Produit 1 : Abonnement mensuel

- Name : `my batch — Mensuel`
- Description : `Abonnement mensuel à l'app my batch — 79€/mois sans engagement`
- Pricing :
  - Type : `Recurring`
  - Price : `79.00 EUR`
  - Billing period : `Monthly`
- Trial period : `7 days` (essai gratuit)
- Save → copie le `price_id` (commence par `price_`)

#### Produit 2 : Abonnement annuel

- Name : `my batch — Annuel`
- Description : `Abonnement annuel à l'app my batch — 49€/mois (588€/an), guide complet inclus`
- Pricing :
  - Type : `Recurring`
  - Price : `588.00 EUR` (49 × 12)
  - Billing period : `Yearly`
- Trial period : `7 days`
- Save → copie le `price_id`

#### Produit 3 : Guide à l'unité

- Name : `Guide complet — Se lancer comme batchcookeuse`
- Description : `Le guide complet 14 chapitres en achat unique`
- Pricing :
  - Type : `One time`
  - Price : `149.00 EUR`
- Save → copie le `price_id`

### Coller les price_id dans le code

Ouvre `netlify/functions/stripe-checkout.js` et trouve la ligne qui gère les price_id. Crée 3 cas selon le produit choisi :

```js
const PRICES = {
  monthly:  'price_XXXXXXXXX',  // <- price_id du produit 1
  annual:   'price_YYYYYYYYY',  // <- price_id du produit 2
  guide:    'price_ZZZZZZZZZ',  // <- price_id du produit 3
}
```

---

## 3. Vérifications de bout en bout

Une fois 1 et 2 faits :

- [ ] `https://app.mybatch.cooking` + login `structify.crm@gmail.com` → super-admin accessible
- [ ] LGDL absent de la liste Entreprises
- [ ] Création d'une fausse entreprise test depuis l'onglet "🏢 Entreprises"
- [ ] Stripe dashboard montre les 3 produits avec les bons prix
- [ ] Test depuis site marketing : clic "Essai 7j" → checkout Stripe → CB acceptée → compte créé

---

## Mémo : modifs code déjà faites côté repo

| Fichier | Modif |
|---|---|
| `admin.js` ligne 167 | Filtre LGDL hors de la liste entreprises pour les founders |

À venir (code à implémenter plus tard) :
- Page `superadmin.html` dédiée (dashboard MRR, churn, support inbox) — pour l'instant on utilise l'onglet "🏢 Entreprises" de admin.html qui fait déjà le job
- Tunnel signup public sur la page d'accueil (formulaire d'inscription) — pour l'instant les comptes sont créés manuellement par le super-admin
- Webhook Stripe pour basculer entreprise plan=`trial` → `active` au premier débit J+7
- Logique "guide locked J+15" si renonciation non cochée
