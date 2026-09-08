# my batch — app

⚠️ Le nom du dossier (`legoutdulien-repo`) est trompeur : **ce repo EST l'app my batch**, pas LGDL.
- App en prod : https://app.mybatch.cooking · Netlify site `035cc271-9dc8-41a2-a68c-b643af387377`
- SaaS multi-tenant de batchcooking à domicile. Front statique (HTML/JS) + fonctions Netlify + Supabase.
- Supabase PARTAGÉ avec lgdl-app : projet ref `loiaubdlhkcnohtbwtxg`.

## Règles à respecter
- **Auto-deploy git CASSÉ** : un `git push` ne déploie RIEN. Déploiement = MANUEL via
  `netlify deploy --prod --site 035cc271-9dc8-41a2-a68c-b643af387377` (avec go explicite de Yo).
- **Multi-poste** : on bosse à 2 machines via GitHub (branche `main`). Pull en arrivant, push en partant.
- `signup.html` = version **79€ LIVE**. La version 59€/offre rentrée se déploie SEULEMENT au lancement.
- **Secrets** (service_role, token `sbp_`) : jamais en clair, jamais commités. Les fonctions utilisent des env vars Netlify. La clé `SB_ANON_KEY` dans le front est publique (OK).
- Modifs de schéma Supabase (DDL) : API Management `https://api.supabase.com/v1/projects/loiaubdlhkcnohtbwtxg/database/query` (Bearer `sbp_...` fourni par Yo, à révoquer après). Forcer l'UTF-8.
- Après chaque modif d'app : mettre à jour `HANDOFF.md`.

## Contexte complet (multi-projets, Insta, lancement…)
Si le disque externe est branché : lire **`F:\STRUCTIFY\CONTEXT-CLAUDE.md`** + le dossier `F:\STRUCTIFY\claude-memory\`.
Sinon, sur le PC principal : `C:\Users\visit\.claude\projects\C--Users-visit\memory\`.
