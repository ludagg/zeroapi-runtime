import type {
  ZeroAPISpec,
  ResourceDefinition,
  FieldDefinition,
  FieldType,
  CrudAction,
  GlobalAuthConfig,
  PermissionRule,
  SpecRelation,
} from '../types/spec.js'
import { toPlural } from '../utils/plural.js'
import { getRequiredEnvVars, type AggregatedEnvVar } from '../env/aggregate.js'
import { buildOAuthCallbackUrl } from '../auth/oauth-config.js'

const DEFAULT_ENDPOINTS: CrudAction[] = ['list', 'create', 'read', 'update', 'delete']
const RESERVED_FIELDS = new Set(['id', 'createdAt', 'updatedAt'])

// ── Auth detection ────────────────────────────────────────────────────────────

interface AuthFlags {
  jwt: boolean
  apikey: boolean
  oauth: boolean
  any: boolean
}

function detectAuth(auth?: GlobalAuthConfig): AuthFlags {
  if (!auth) return { jwt: false, apikey: false, oauth: false, any: false }
  const jwt = auth.jwt?.enabled === true || auth.strategy === 'jwt' || auth.strategy === 'bearer'
  const apikey = auth.apikey?.enabled === true || auth.strategy === 'apikey'
  const oauth = (auth.oauth?.providers?.length ?? 0) > 0
  return { jwt, apikey, oauth, any: jwt || apikey || oauth }
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function baseUrlPlaceholder(spec: ZeroAPISpec): string {
  return spec.baseUrl ?? 'http://localhost:3000'
}

function envLabel(v: AggregatedEnvVar): string {
  if (v.required && v.generate) return 'Auto-générée'
  if (v.required) return 'Oui'
  return 'Non'
}

function envDescription(v: AggregatedEnvVar): string {
  if (v.description) return v.description
  return '—'
}

// ── Section: header ───────────────────────────────────────────────────────────

function renderHeader(spec: ZeroAPISpec): string {
  const lines: string[] = [`# ${spec.name}`]
  if (spec.description) lines.push('', spec.description)
  lines.push('', '> Généré par ZeroAPI')
  return lines.join('\n')
}

// ── Section: quickstart ───────────────────────────────────────────────────────

function renderQuickstart(): string {
  return [
    '## 🚀 Démarrage rapide',
    '',
    '1. **Installer les dépendances** : `npm install`',
    '2. **Configurer l\'environnement** : copier `.env.example` vers `.env` et remplir les variables',
    '3. **Préparer la base de données** : `npx prisma db push`',
    '4. **Démarrer l\'API** : `npm start`',
  ].join('\n')
}

// ── Section: env vars ─────────────────────────────────────────────────────────

function renderEnv(spec: ZeroAPISpec): string {
  const vars = getRequiredEnvVars(spec)
  const lines: string[] = ['## ⚙️ Variables d\'environnement', '']
  if (vars.length === 0) {
    lines.push('Cette API ne requiert aucune variable d\'environnement.')
    return lines.join('\n')
  }
  lines.push('| Variable | Requise | Description |')
  lines.push('| --- | --- | --- |')
  for (const v of vars) {
    lines.push(`| \`${v.name}\` | ${envLabel(v)} | ${envDescription(v)} |`)
  }
  const hasGenerated = vars.some((v) => v.generate)
  if (hasGenerated) {
    lines.push('')
    lines.push(
      '> Les variables marquées **Auto-générée** sont créées au premier démarrage si elles sont absentes — pratique en développement, mais en production fournissez vos propres valeurs.',
    )
  }
  lines.push('')
  lines.push('Reportez-vous à `.env.example` pour la liste complète et les exemples.')
  return lines.join('\n')
}

// ── Section: authentication ───────────────────────────────────────────────────

function renderAuth(spec: ZeroAPISpec, flags: AuthFlags): string {
  if (!flags.any) return ''
  const lines: string[] = ['## 🔐 Authentification', '']

  if (flags.jwt) {
    lines.push('### JWT (email + mot de passe)')
    lines.push('')
    lines.push('Les utilisateurs s\'enregistrent puis se connectent pour obtenir un access token (JWT) et un refresh token.')
    lines.push('')
    lines.push('- `POST /auth/register` — crée un compte (`email`, `password`)')
    lines.push('- `POST /auth/login` — retourne `{ accessToken, refreshToken }`')
    lines.push('- `POST /auth/refresh` — échange un refresh token contre un nouvel access token')
    lines.push('- `GET /auth/me` — profil de l\'utilisateur connecté')
    lines.push('')
    lines.push('Ajoutez le header `Authorization: Bearer <accessToken>` sur les requêtes protégées.')
    lines.push('')
  }

  if (flags.apikey) {
    const header = spec.auth?.apikey?.header ?? spec.auth?.header ?? 'Authorization'
    const prefix = spec.auth?.apikey?.prefix ?? 'zak_live_'
    lines.push('### Clés API')
    lines.push('')
    lines.push(`Envoyez votre clé via le header \`${header}: Bearer <clé>\` (préfixe par défaut : \`${prefix}\`).`)
    lines.push('')
    lines.push('> Au tout premier démarrage, une clé "bootstrap" est imprimée dans les logs. Sauvegardez-la immédiatement : elle ne sera plus jamais affichée.')
    lines.push('')
  }

  if (flags.oauth) {
    const providers = spec.auth?.oauth?.providers ?? []
    const base = baseUrlPlaceholder(spec)
    lines.push('### OAuth')
    lines.push('')
    lines.push('Providers configurés :')
    lines.push('')
    for (const p of providers) {
      lines.push(`- **${p.name}** — démarrage : \`GET /auth/oauth/${p.name}\` · callback à enregistrer côté provider : \`${buildOAuthCallbackUrl(base, p.name)}\``)
    }
    lines.push('')
    lines.push('Renseignez `OAUTH_CALLBACK_BASE_URL` ainsi que le `clientId` / `clientSecret` de chaque provider dans le fichier `.env`.')
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}

// ── Section: endpoints ────────────────────────────────────────────────────────

function permissionsForResource(spec: ZeroAPISpec, name: string): PermissionRule[] {
  const block = spec.permissions?.find((p) => p.resource === name)
  return block?.rules ?? []
}

function formatPermissions(rules: PermissionRule[], action: 'create' | 'read' | 'update' | 'delete'): string {
  const matching = rules.filter((r) => r.actions.includes(action))
  if (matching.length === 0) return ''
  const parts = matching.map((r) => (r.ownOnly ? `\`${r.role}\` (ses propres ressources)` : `\`${r.role}\``))
  return ` — rôles : ${parts.join(', ')}`
}

function relationsFor(spec: ZeroAPISpec, from: string): SpecRelation[] {
  return (spec.relations ?? []).filter((r) => r.from === from)
}

function renderResourceEndpoints(spec: ZeroAPISpec, resource: ResourceDefinition): string {
  const plural = toPlural(resource.name)
  const endpoints: CrudAction[] = resource.endpoints ?? DEFAULT_ENDPOINTS
  const rules = permissionsForResource(spec, resource.name)
  const lines: string[] = [`### ${resource.name}`]
  if (resource.description) lines.push('', resource.description)
  lines.push('')

  if (endpoints.includes('list')) {
    lines.push(`- \`GET /${plural}\` — liste paginée (filtres, tri, recherche)`)
  }
  if (endpoints.includes('create')) {
    lines.push(`- \`POST /${plural}\` — créer un(e) ${resource.name}${formatPermissions(rules, 'create')}`)
  }
  if (endpoints.includes('read')) {
    lines.push(`- \`GET /${plural}/:id\` — détail${formatPermissions(rules, 'read')}`)
  }
  if (endpoints.includes('update')) {
    lines.push(`- \`PUT /${plural}/:id\` — mise à jour${formatPermissions(rules, 'update')}`)
  }
  if (endpoints.includes('delete')) {
    lines.push(`- \`DELETE /${plural}/:id\` — suppression${formatPermissions(rules, 'delete')}`)
  }
  for (const ep of resource.customEndpoints ?? []) {
    const auth = ep.roles?.length ? ` — rôles : ${ep.roles.map((r) => `\`${r}\``).join(', ')}` : ep.auth ? ' — auth requise' : ''
    lines.push(`- \`${ep.method} /${plural}${ep.path}\` — endpoint personnalisé${auth}`)
  }
  for (const rel of relationsFor(spec, resource.name)) {
    const target = toPlural(rel.to)
    lines.push(`- \`GET /${plural}/:id/${target}\` — ${rel.type} → ${rel.to}`)
  }
  return lines.join('\n')
}

function renderEndpoints(spec: ZeroAPISpec): string {
  const lines: string[] = ['## 📚 Endpoints', '']
  for (const r of spec.resources) {
    lines.push(renderResourceEndpoints(spec, r))
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

// ── Section: search & filters ─────────────────────────────────────────────────

function renderSearch(spec: ZeroAPISpec): string {
  const search = spec.features?.search?.enabled === true
  const pagination = spec.features?.pagination !== undefined
  if (!search && !pagination) return ''
  const lines: string[] = ['## 🔍 Recherche & filtres', '']
  if (search) {
    lines.push('- **Recherche plein texte** : `GET /<ressource>?q=mot-clé`')
  }
  lines.push('- **Filtres par champ** : `?prix[gte]=10&prix[lte]=100`')
  lines.push('- **Tri** : `?sort=createdAt:desc` (ou `?sort=-createdAt`)')
  const defaultLimit = spec.features?.pagination?.defaultLimit ?? 20
  const maxLimit = spec.features?.pagination?.maxLimit ?? 100
  lines.push(`- **Pagination** : \`?page=1&limit=${defaultLimit}\` (max ${maxLimit})`)
  const sample = spec.resources[0]
  if (sample) {
    const plural = toPlural(sample.name)
    lines.push('')
    lines.push('Exemple :')
    lines.push('')
    lines.push('```bash')
    lines.push(`curl "${baseUrlPlaceholder(spec)}/${plural}?page=1&limit=10&sort=-createdAt"`)
    lines.push('```')
  }
  return lines.join('\n')
}

// ── Section: file upload ──────────────────────────────────────────────────────

function renderUpload(spec: ZeroAPISpec): string {
  const fu = spec.features?.fileUpload
  if (!fu?.enabled) return ''
  const lines: string[] = ['## 📎 Upload de fichiers', '']
  lines.push(`- **Endpoint** : \`POST /upload\` (champ \`file\`, multipart/form-data)`)
  lines.push(`- **Provider** : \`${fu.provider}\``)
  lines.push(`- **Taille max** : ${fu.maxSizeMB} MB`)
  if (fu.allowedTypes.length > 0) {
    lines.push(`- **Types autorisés** : ${fu.allowedTypes.map((t) => `\`${t}\``).join(', ')}`)
  } else {
    lines.push('- **Types autorisés** : tous')
  }
  return lines.join('\n')
}

// ── Section: webhooks ─────────────────────────────────────────────────────────

function renderWebhooks(spec: ZeroAPISpec): string {
  const wh = spec.features?.webhooks
  const outbound = wh?.outbound ?? []
  const inbound = wh?.inbound ?? []
  if (outbound.length === 0 && inbound.length === 0) return ''
  const lines: string[] = ['## 🪝 Webhooks', '']
  if (outbound.length > 0) {
    lines.push('### Sortants (événements émis)')
    lines.push('')
    for (const ev of outbound) lines.push(`- \`${ev}\``)
    lines.push('')
    lines.push('Abonnement : `POST /webhooks/endpoints` avec `{ url, events: [...] }`. Chaque livraison transporte un header `x-webhook-signature` (HMAC SHA-256 du body avec votre `secret`).')
    lines.push('')
  }
  if (inbound.length > 0) {
    lines.push('### Entrants (sources reçues)')
    lines.push('')
    for (const src of inbound) lines.push(`- \`POST /webhooks/inbound/${src}\``)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

// ── Section: examples ─────────────────────────────────────────────────────────

function exampleValueFor(field: FieldDefinition, name: string): unknown {
  const t: FieldType = field.type
  if (field.values && field.values.length > 0) return field.values[0]
  if (field.default !== undefined && field.default !== null) return field.default
  switch (t) {
    case 'string':
    case 'text':
      return `Exemple ${name}`
    case 'email':
      return 'user@example.com'
    case 'url':
      return 'https://example.com'
    case 'uuid':
      return '00000000-0000-0000-0000-000000000000'
    case 'number':
    case 'decimal':
      return 99.9
    case 'integer':
      return field.min ?? 1
    case 'boolean':
      return true
    case 'date':
      return '2025-01-01'
    case 'datetime':
      return '2025-01-01T00:00:00Z'
    case 'json':
      return {}
    case 'enum':
      return field.values?.[0] ?? 'value'
    case 'file':
      return 'https://cdn.example.com/file.png'
    case 'file[]':
      return ['https://cdn.example.com/file.png']
  }
}

function buildSampleBody(resource: ResourceDefinition): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const requiredEntries = Object.entries(resource.fields)
    .filter(([name, f]) => !RESERVED_FIELDS.has(name) && f.required)
  const source = requiredEntries.length > 0
    ? requiredEntries
    : Object.entries(resource.fields).filter(([name]) => !RESERVED_FIELDS.has(name)).slice(0, 2)
  for (const [name, field] of source) {
    body[name] = exampleValueFor(field, name)
  }
  return body
}

function renderExamples(spec: ZeroAPISpec, flags: AuthFlags): string {
  const target = spec.resources.find((r) => {
    const endpoints = r.endpoints ?? DEFAULT_ENDPOINTS
    return endpoints.includes('create')
  })
  if (!target) return ''
  const plural = toPlural(target.name)
  const body = buildSampleBody(target)
  const base = baseUrlPlaceholder(spec)
  const authHeader = flags.jwt || flags.apikey
    ? `\n  -H "Authorization: Bearer VOTRE_TOKEN" \\`
    : ''
  const lines: string[] = ['## 💡 Exemples', '']
  lines.push(`Créer un(e) **${target.name}** :`)
  lines.push('')
  lines.push('```bash')
  lines.push(`curl -X POST ${base}/${plural} \\${authHeader}`)
  lines.push(`  -H "Content-Type: application/json" \\`)
  lines.push(`  -d '${JSON.stringify(body)}'`)
  lines.push('```')
  lines.push('')
  lines.push(`Lister les **${plural}** :`)
  lines.push('')
  lines.push('```bash')
  lines.push(`curl ${base}/${plural}`)
  lines.push('```')
  return lines.join('\n')
}

// ── Section: deployment ───────────────────────────────────────────────────────

function renderDeployment(): string {
  return [
    '## 🌍 Déploiement',
    '',
    '- **ZeroAPI Cloud** : déploiement automatique — les variables managées sont injectées pour vous.',
    '- **Render / Railway / Fly.io / VPS** : configurez les variables d\'environnement listées plus haut puis déployez le `Dockerfile` fourni.',
  ].join('\n')
}

// ── Section: interactive docs ─────────────────────────────────────────────────

function renderInteractiveDocs(): string {
  return [
    '## 📖 Documentation interactive',
    '',
    '- **OpenAPI JSON** : `GET /openapi.json`',
    '- **Health check** : `GET /health`',
  ].join('\n')
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds a Markdown README describing how to install, configure and call the
 * API described by `spec`. Sections adapt to the spec — no auth section if
 * auth is not configured, no webhooks section if no webhook event is
 * declared, etc. The returned string is suitable for writing to `README.md`
 * inside the exported project bundle.
 */
export function generateReadme(spec: ZeroAPISpec): string {
  const flags = detectAuth(spec.auth)
  const sections: string[] = [
    renderHeader(spec),
    renderQuickstart(),
    renderEnv(spec),
    renderAuth(spec, flags),
    renderEndpoints(spec),
    renderSearch(spec),
    renderUpload(spec),
    renderWebhooks(spec),
    renderExamples(spec, flags),
    renderDeployment(),
    renderInteractiveDocs(),
  ].filter((s) => s.length > 0)
  return sections.join('\n\n') + '\n'
}
