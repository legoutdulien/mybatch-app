# 🍳 mybatch.cooking — Handoff du projet

Document de référence pour reprendre le projet dans une nouvelle conversation Claude.

---

## Vue d'ensemble

**mybatch.cooking** est une plateforme SaaS multi-tenant pour cuisinières batch cooking.
Chaque cuisinière inscrite a son propre espace isolé avec ses clientes, recettes, commandes, branding.

**URL principale** : https://mybatch.cooking (déployée sur Netlify)
**Repo Git** : https://github.com/legoutdulien/legoutdulien
**Owner / Founder** : Alizée (compte gratuit à vie via plan = `founder`)

---

## Stack technique

- **Frontend** : HTML/CSS/JS vanilla (pas de framework, pas de build step)
- **Backend** : Supabase (Postgres + Auth + Storage + Realtime)
- **Hosting** : Netlify (site + Functions)
- **Paiement** : Stripe Subscriptions (mode live actuellement)
- **Domaine** : mybatch.cooking

### Fichiers clés

| Fichier | Rôle |
|---|---|
| `index.html` + `app.js` | Login unifié + portail client |
| `admin.html` + `admin.js` | Dashboard cuisinière (admin) + super-admin pour Alizée |
| `salarie.html` + `salarie.js` | Portail partenaires (founder uniquement) |
| `netlify/functions/admin-key.js` | Auth check + retourne service_role + données entreprise |
| `netlify/functions/branding.js` | Endpoint public branding par slug ou id |
| `netlify/functions/stripe-checkout.js` | Génère URL de Checkout Stripe pour abonnement |
| `netlify/functions/stripe-webhook.js` | Reçoit events Stripe et met à jour entreprises |
| `netlify/functions/stripe-portal.js` | Génère URL Customer Portal Stripe (self-service) |
| `netlify/functions/claude.js` | Endpoint ARIA (assistant IA, founder only) |
| `abonnement-confirme.html` / `abonnement-annule.html` | Pages retour Stripe |

---

## Architecture multi-tenant

### Principe

Toutes les tables ont une colonne `entreprise_id` qui scope les données par cuisinière.

### Authentification

- Login unifié sur `index.html` (depuis le root mybatch.cooking ou n'importe quel subdomain)
- Après `signInWithPassword`, `detectRole(userId)` cherche le user_id dans :
  1. `admins_entreprise` → role 'admin' → redirige vers `admin.html`
  2. `salaries` → role 'salarie' → redirige vers `salarie.html`
  3. `clients` → role 'client' → charge le portail client sur `index.html`
- Si aucun match → signOut + erreur

### Subdomains (prévu, pas encore activé)

- `mybatch.cooking` → branding générique "Mon espace Batchcooking"
- `legoutdulien.mybatch.cooking` → branding Le Goût du Lien
- `<slug>.mybatch.cooking` → branding de cette cuisinière

`getSubdomainSlug()` dans `app.js` extrait le slug depuis `window.location.hostname` et `loadBranding()` applique le branding.

### Isolation des données (admin)

`admin.js` utilise service_role (qui bypass RLS) MAIS chaque requête est manuellement scopée :

```js
function scoped(q) {
  return CURRENT_ENTREPRISE_ID ? q.eq('entreprise_id', CURRENT_ENTREPRISE_ID) : q;
}
```

Toutes les requêtes dans `chargerTout` passent par `scoped()`. Inserts ajoutent `entreprise_id: CURRENT_ENTREPRISE_ID`.

Le founder voit toutes les entreprises (super-admin) via l'onglet 🏢 Entreprises.

---

## Schema Supabase

### Tables principales

- **entreprises** : id, slug, nom_marque, nom_contact, admin_email, admin_password, plan (founder/standard), formule (standard/premium), cycle (mensuel/annuel), couleur_principale, couleur_secondaire, couleur_topbar, logo_url, montant_client_default, instructions_paiement, active, **subscription_status** (pending/trialing/active/past_due/canceled/incomplete), **stripe_customer_id**, **stripe_subscription_id**, **trial_ends_at**, **current_period_end**, created_at
- **admins_entreprise** : id, user_id (FK auth.users), entreprise_id (FK entreprises), nom
- **clients** : id (= auth.users.id), entreprise_id, nom, email, telephone, adresse, notes, nombre_portions, **courses_par_cuisiniere** (boolean)
- **salaries** : id (= auth.users.id), entreprise_id, nom, email, telephone
- **recettes** : id, entreprise_id, nom_du_plat, categorie, photo_url, instructions_preparation, instructions_rechauffage, congelation, frigo, etat (actif/a_venir/en_stock/inactif), active
- **ingredients** : id, entreprise_id, nom, unite_par_defaut, rayon — unique index sur (entreprise_id, lower(nom))
- **recettes_ingredients** : id, recette_id, ingredient_id, quantite_par_portion, ordre
- **commandes** : id, entreprise_id, client_id, semaine_du, creneau, slot_key, plat_1_id..plat_5_id, nombre_portions, statut, assigne_a_id, **forfait_id**, **montant** (snapshot)
- **creneaux_template** : id, entreprise_id, jour, nom_slot, heure_debut, heure_fin, ordre
- **creneaux** : id, entreprise_id, semaine, slot, actif (overrides ponctuels)
- **favoris** : client_id, recette_id
- **notifications** : id, recipient_id, title, body, read_at
- **forfaits** : id, entreprise_id, nom, prix, description, badge, ordre, active

### Fonction RLS helper

```sql
create function user_entreprise_id() returns uuid as $$
  select coalesce(
    (select entreprise_id from clients where id = auth.uid()),
    (select entreprise_id from salaries where id = auth.uid()),
    (select entreprise_id from admins_entreprise where user_id = auth.uid())
  );
$$ language sql stable security definer;
```

---

## Stripe (paiement abonnement cuisinières)

### Mode

**LIVE** actuellement (pas test). Tester avec vraie CB, 7 jours d'essai = 0€ aujourd'hui.

### Produits configurés dans Stripe Dashboard

| Formule | Cycle | Prix | Price ID (voir env vars Netlify) |
|---|---|---|---|
| Standard | Mensuel | 79€ HT/mois | `STRIPE_PRICE_STANDARD_MENSUEL` |
| Standard | Annuel | 758€ HT/an (-20%) | `STRIPE_PRICE_STANDARD_ANNUEL` |
| Premium | Mensuel | 579€ HT/mois | `STRIPE_PRICE_PREMIUM_MENSUEL` |

Les vrais Price IDs Stripe sont stockés dans les env vars Netlify pour ne pas exposer de secrets dans le repo.

**Note** : Premium n'existe qu'en mensuel (pas d'annuel).

Premium = standard + 4h coaching visio par mois (service livré par Alizée hors plateforme, pas une feature code).

### Webhook configuré

- URL : `https://mybatch.cooking/.netlify/functions/stripe-webhook`
- Events écoutés : `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`

### Variables d'environnement Netlify

À configurer dans Netlify → Site configuration → Environment variables :

- `STRIPE_SECRET_KEY` — clé secrète Stripe (préfixée selon mode)
- `STRIPE_WEBHOOK_SECRET` — secret de signature du webhook
- `STRIPE_PRICE_STANDARD_MENSUEL` — ID du tarif 79€/mois
- `STRIPE_PRICE_STANDARD_ANNUEL` — ID du tarif 758€/an
- `STRIPE_PRICE_PREMIUM_MENSUEL` — ID du tarif 579€/mois (premium n'a pas d'annuel)
- `PUBLIC_BASE_URL` — `https://mybatch.cooking`
- `SUPABASE_URL` — URL du projet Supabase
- `SUPABASE_SERVICE_KEY` — service_role key Supabase
- `ANTHROPIC_API_KEY` — pour ARIA (founder seulement)
- `ADMIN_PASSWORD` — legacy, plus utilisé (à supprimer)

### Flow d'onboarding d'une cuisinière

1. Alizée crée l'entreprise depuis super-admin (formule + cycle choisis)
2. saveEntreprise crée : ligne entreprises (status='pending') + auth user + lien admins_entreprise
3. Alizée clique **💳 Lien** → appelle `stripe-checkout` → retourne URL Checkout
4. Alizée envoie le lien + identifiants à la cuisinière (WhatsApp/email)
5. Cuisinière clique → entre sa CB sur Stripe Checkout → 7 jours trial (0€)
6. Webhook `checkout.session.completed` → met `subscription_status='trialing'`, `stripe_customer_id`, `stripe_subscription_id`
7. Au bout de 7 jours, Stripe débite → webhook `customer.subscription.updated` → status='active'
8. Cuisinière clique **💳 Gérer mon abonnement** dans Paramètres → Customer Portal Stripe (CB, factures, annuler)
9. Si paiement échoue → status='past_due', si Stripe abandonne → 'canceled' + `active=false`

---

## Plan gating (founder vs standard/premium)

`isFounder()` = `CURRENT_PLAN === 'founder'`.

Body classe `plan-founder` ou `plan-standard` posée par admin.js.

### Features founder uniquement (cachées par CSS pour plan-standard)

- 🤖 ARIA assistant IA (`#ariaFab`, `#ariaPanel`)
- 🤝 Onglet Partenaires (`[data-tab="salaries"]`)
- 🏢 Onglet Entreprises super-admin (`[data-tab="entreprises"]`)
- 📈 Chart CA 6 mois (`#stats-six-month`)
- 🍳 Charge prévisionnelle (`#stats-charge-prev`)
- Statuts recettes "À venir" / "En stock" (option `.founder-only-opt`)

### Limites pour non-founder

```js
const PLAN_LIMITS = { recettes: 200, clientes: 30, commandes_mois: 80, photos_mb: 800 };
```

`checkPlanLimit(kind, label)` bloque la création si limite atteinte (alerte douce à 90%, hard block à 100%).

---

## Branding par entreprise

Chaque entreprise configure depuis ⚙️ Paramètres :
- Nom de marque, logo (upload Supabase Storage)
- Email admin (sync avec Supabase auth)
- Mot de passe (sync avec Supabase auth)
- Couleur principale + secondaire + barre du haut (3 color pickers)
- Montant client par défaut (fallback si pas de forfait)
- Instructions de paiement (texte libre — Abby/URSSAF/CESU/virement/etc.)

CSS pilotée par `--brand-primary` et `--brand-secondary`. Toutes les nuances (`--v1` à `--v4`, `--vp`, `--vl`, `--va`) dérivées via `color-mix(in srgb, ...)`.

---

## Forfaits

Chaque entreprise crée ses forfaits depuis ⚙️ Paramètres → 📦 Mes forfaits.

Champs : nom, prix, description, badge, ordre, active.

Côté portail client :
- Si 0 forfait → impossible de commander
- Si 1 forfait → utilisé d'office
- Si 2+ forfaits actifs → sélecteur radio dans le récap

À la commande : `forfait_id` + `montant` snapshot stockés dans `commandes`. Stats CA dérivent de `commande.montant`.

---

## Système de "qui fait les courses"

`clients.courses_par_cuisiniere` (boolean).

Si true (Estelle/Alizée fait les courses pour cette cliente) :
- Portail client : onglet "Liste de courses" caché
- Planning admin : badge "🛒 Courses à faire" sur la commande
- Bouton 🛒 sur chaque commande admin pour voir/imprimer la liste

---

## Suivi des paiements et statuts

Badge subscription_status dans super-admin Entreprises :

| Statut | Visuel | Sens |
|---|---|---|
| pending | ⏳ En attente paiement | Compte créé, lien Stripe pas encore utilisé |
| trialing | 🆓 Essai 7j | Trial en cours, accès complet |
| active | ✓ Abo actif | Abonnement payé, renouvelé |
| past_due | ⚠️ Paiement échoué | Stripe relance, accès maintenu |
| canceled | ✗ Annulé | Abonnement terminé, active=false |

Le founder a status='active' à vie (badge "∞ Gratuit").

---

## Stages complétés (TODO list)

- ✅ Stage 1 — Schema multi-tenant (table entreprises, colonnes entreprise_id partout, RLS)
- ✅ Domaine mybatch.cooking acheté + DNS
- ✅ Stage 2 — Super-admin panel pour Alizée
- ✅ Stage 3 — Login unifié + Supabase auth + création auto compte
- ✅ Stage 4 — Plan gating + limites
- ✅ Stage 5 — Branding par entreprise (onglet Paramètres avec colors, logo, payment instructions)
- ✅ Stage 3d — Branding dynamique du login (subdomain → branding)
- ✅ Forfaits + selection client
- ✅ courses_par_cuisiniere + vue admin shopping list
- ✅ Téléphone/adresse cliquables planning
- ✅ Audit complet flows password (sync Supabase auth)
- ✅ Stripe integration (live mode, checkout/webhook/portal, products created)

### Pending

- ⏳ Stage 6 — Onboarding wizard (skippé tant qu'il n'y a pas 5+ cuisinières)
- ⏳ Subdomains actifs sur Netlify (legoutdulien.mybatch.cooking, etc.) — pour l'instant tout sur le root
- ⏳ Test end-to-end Stripe Checkout avec vraie CB (entreprise "test" créée pour ça)
- ⏳ Vue admin "Courses de la semaine" agrégée (par défaut on a la vue par commande)
- ⏳ Self-service password reset (forgot password) pour clientes/partenaires

---

## Opérations courantes

### Créer une nouvelle cuisinière

1. Onglet 🏢 Entreprises → + Nouvelle cuisinière
2. Remplir : nom contact, nom marque, slug, plan (standard ou founder), formule, cycle, email, password
3. Clic Créer → entreprise + auth user + admins_entreprise créés, starter pack ingrédients copié, alert avec credentials
4. Clic 💳 Lien sur sa ligne → URL Stripe Checkout copiée
5. Envoyer URL + credentials à la cuisinière

### Suspendre une cuisinière

- Soit Stripe annule l'abo → webhook met active=false automatiquement
- Soit manuellement : éditer entreprise → Statut → ⏸️ Suspendu → enregistrer

### Migrer une cuisinière de Standard à Premium (ou inverse)

À documenter (pas encore implémenté). Pour l'instant : annuler abo actuel + recréer avec nouvelle formule.

### Voir/Imprimer la liste de courses d'une commande

Planning admin → clic 🛒 sur la commande → modale avec items cochables + bouton imprimer.

---

## Memory persistant (mybatch_saas)

Voir `C:\Users\visit\.claude\projects\C--Users-visit\memory\projet_mybatch_saas.md` pour le résumé business stratégique.

---

## Debug / outils

### Tester un endpoint depuis PowerShell

```powershell
$body = @{ entreprise_id = "<UUID>" } | ConvertTo-Json
Invoke-WebRequest -Uri "https://mybatch.cooking/.netlify/functions/stripe-checkout" -Method POST -Body $body -ContentType "application/json"
```

### Voir les logs Netlify Functions

Netlify Dashboard → Logs → Functions → choisir la fonction → voir les invocations récentes.

### SQL utiles

```sql
-- Liste des entreprises
select slug, plan, formule, cycle, subscription_status, active from entreprises;

-- Verifier qu'un user_id correspond a un admin
select e.slug from admins_entreprise ae
join entreprises e on e.id = ae.entreprise_id
where ae.user_id = '<UUID>';

-- Nettoyer parasites apres creation entreprise (rare)
delete from clients where id in (select user_id from admins_entreprise);
delete from salaries where id in (select user_id from admins_entreprise);
```

---

*Dernière mise à jour : audit sécurité — RLS verifié, isolation testée, stripe-checkout protégé par auth, password en clair retiré.*
