# chat-frontend — Frontend séparé pour PRIMUM FACTI Assistant Universel

שושנה ז״ל

## Sanctuarisation

Ce projet est **totalement séparé** du frontend principal PRIMUM FACTI :

- ❌ Aucun import depuis `../frontend/`
- ❌ Aucune dépendance partagée
- ❌ Aucun shim
- ✅ Déploiement Vercel séparé (sous-domaine dédié)
- ✅ Build, lint, dev indépendants

## Backend

Ce frontend appelle le backend `@primum/chat` (`packages/chat/`) qui est lui-même
totalement séparé du moteur juridique principal.

URL : configurée via `NEXT_PUBLIC_CHAT_API_URL`.

## Déploiement Vercel

Lors de la création du projet Vercel pour ce frontend :

- **Root Directory** : `chat-frontend`
- **Framework** : Next.js
- **Build Command** : `npm install && npm run build`
- **Environment Variables** :
  - `NEXT_PUBLIC_CHAT_API_URL` = URL publique du backend `@primum/chat` Render
- **Domain** : `chat.primum-facti.com` (recommandé)

## Développement local

```bash
cd chat-frontend
npm install
npm run dev    # port 3001
```

Backend chat doit tourner en parallèle :

```bash
cd packages/chat
npm run dev    # port 8787
```
