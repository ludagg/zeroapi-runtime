# Publishing `@zeroapi/runtime` to npm

La publication est automatique : tout push sur `main` déclenche le workflow
`.github/workflows/publish.yml` qui lance les tests, le build, puis `npm publish`.

---

## 1. Obtenir un NPM_TOKEN

1. Connectez-vous sur [npmjs.com](https://www.npmjs.com).
2. Cliquez sur votre avatar → **Access Tokens**.
3. **Generate New Token** → choisissez **Granular Access Token** (recommandé) :
   - Expiration : selon votre politique (90 jours est un bon défaut)
   - Packages : sélectionnez `@zeroapi/runtime` → permission **Read and Write**
   - Ou choisissez **Automation** (classic token) si vous préférez la simplicité.
4. Copiez le token immédiatement — il n'est affiché qu'une seule fois.

---

## 2. Ajouter le secret dans GitHub

1. Ouvrez le dépôt sur GitHub.
2. **Settings** → **Secrets and variables** → **Actions**.
3. Cliquez **New repository secret**.
4. Nom : `NPM_TOKEN`
5. Valeur : collez le token copié à l'étape précédente.
6. **Add secret**.

---

## 3. Déclencher la publication

### Automatique (recommandé)

```bash
# 1. Mettez à jour la version dans package.json
npm version patch   # 0.1.0 → 0.1.1
# ou
npm version minor   # 0.1.0 → 0.2.0
# ou
npm version major   # 0.1.0 → 1.0.0

# 2. Poussez le commit + le tag créé par npm version
git push origin main --follow-tags
```

Le workflow se déclenche dès que le push arrive sur `main`.

### Manuel (re-déclencher sans changer la version)

Depuis l'onglet **Actions** du dépôt → sélectionnez **Publish to npm** →
**Run workflow** → choisissez la branche `main`.

> **Note :** npm refuse de publier deux fois la même version.
> Pensez toujours à incrémenter `version` dans `package.json` avant de pousser.

---

## 4. Vérifier la publication

```bash
npm info @zeroapi/runtime
# ou
npx @zeroapi/runtime --version   # si un bin est déclaré
```

La page du package sera disponible sur :
`https://www.npmjs.com/package/@zeroapi/runtime`

---

## Ce qui est publié

Seul le dossier `dist/` est inclus dans le package (défini par `"files": ["dist"]`
dans `package.json` et confirmé par `.npmignore`).

```
@zeroapi/runtime@0.1.0
└── dist/
    ├── index.js       # CommonJS
    ├── index.mjs      # ESM
    └── index.d.ts     # TypeScript declarations
```

Le code source (`src/`), les tests (`tests/`), les exemples (`examples/`),
et la configuration de build sont exclus du package publié.
