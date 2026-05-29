import type { ZeroAPISpec } from '../types/spec.js'

/**
 * Where a dependency came from: always needed by every generated API
 * (`base`), pulled in by the database layer, or required by a specific
 * feature / auth strategy enabled in the spec.
 */
export type DependencySource =
  | 'base'
  | 'database'
  | 'feature.fileUpload'

/** A single npm dependency the generated API needs, with all metadata. */
export interface AggregatedDependency {
  /** Package name, e.g. `@aws-sdk/client-s3`. */
  name: string
  /** Semver range to pin in package.json, e.g. `^3.0.0`. */
  version: string
  /** `true` when it belongs in `devDependencies` rather than `dependencies`. */
  dev: boolean
  /** Why this dependency is included. */
  source: DependencySource
}

/**
 * Centralised version ranges for every package the generated API may need.
 * Runtime ranges are kept in sync with this package's own `dependencies` /
 * `peerDependencies` so the code the runtime imports at runtime always matches
 * what the generated `package.json` installs.
 */
const VERSIONS = {
  runtime: '^0.16.0',
  hono: '^4.0.0',
  zod: '^3.22.0',
  prismaClient: '^5.22.0',
  // Matches the optional peerDependency declared by @ludagg/zeroapi-runtime.
  awsClientS3: '^3.0.0',
  // dev tooling
  prisma: '^5.22.0',
  typescript: '^5.4.0',
  typesNode: '^22.0.0',
  tsup: '^8.0.0',
  tsx: '^4.0.0',
} as const

/** The package name of the runtime itself, referenced by the generated API. */
const RUNTIME_PACKAGE = '@ludagg/zeroapi-runtime'

/** True when the spec enables S3/R2 uploads (which require the AWS SDK). */
function usesS3Storage(spec: ZeroAPISpec): boolean {
  const fu = spec.features?.fileUpload
  return fu?.enabled === true && (fu.provider === 's3' || fu.provider === 'r2')
}

/**
 * Computes the COMPLETE list of npm dependencies the generated API needs:
 * the base packages every API imports (the runtime, Hono, Zod, the Prisma
 * client) plus the conditional packages required by the features / auth
 * strategies enabled in the spec.
 *
 * The most important conditional dependency is `@aws-sdk/client-s3`, which the
 * runtime lazy-loads when `features.fileUpload.provider` is `s3` or `r2`. The
 * runtime declares it as an OPTIONAL peer dependency for itself, but the
 * generated API must list it as a real dependency — otherwise `npm install`
 * skips it and the API crashes at boot with:
 *
 *   `storage provider "s3"/"r2" requires the optional dependency "@aws-sdk/client-s3"`
 *
 * No package used at runtime should ever be missing from this list. To add a
 * new conditional dependency, append it here guarded by the relevant feature /
 * auth flag — the package.json generator picks it up automatically.
 *
 * Duplicate names keep the first occurrence.
 */
export function getRequiredDependencies(spec: ZeroAPISpec): AggregatedDependency[] {
  const result: AggregatedDependency[] = []
  const byName = new Map<string, AggregatedDependency>()

  const add = (d: AggregatedDependency): void => {
    if (byName.has(d.name)) return
    byName.set(d.name, d)
    result.push(d)
  }

  // ── Base runtime dependencies (always imported by the generated API) ────────
  add({ name: RUNTIME_PACKAGE, version: VERSIONS.runtime, dev: false, source: 'base' })
  add({ name: 'hono', version: VERSIONS.hono, dev: false, source: 'base' })
  add({ name: 'zod', version: VERSIONS.zod, dev: false, source: 'base' })

  // ── Database (Prisma client is always used; the CLI is a dev dependency) ────
  add({ name: '@prisma/client', version: VERSIONS.prismaClient, dev: false, source: 'database' })
  add({ name: 'prisma', version: VERSIONS.prisma, dev: true, source: 'database' })

  // ── Conditional: S3 / R2 uploads need the AWS SDK at runtime ────────────────
  if (usesS3Storage(spec)) {
    add({
      name: '@aws-sdk/client-s3',
      version: VERSIONS.awsClientS3,
      dev: false,
      source: 'feature.fileUpload',
    })
  }

  // ── Base dev tooling (build + run) ──────────────────────────────────────────
  add({ name: 'typescript', version: VERSIONS.typescript, dev: true, source: 'base' })
  add({ name: '@types/node', version: VERSIONS.typesNode, dev: true, source: 'base' })
  add({ name: 'tsup', version: VERSIONS.tsup, dev: true, source: 'base' })
  add({ name: 'tsx', version: VERSIONS.tsx, dev: true, source: 'base' })

  return result
}

export interface PackageJsonOptions {
  /** Override the generated package version. Defaults to `1.0.0`. */
  version?: string
}

/** Sanitises a spec name into a valid, lowercase npm package name. */
function toPackageName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-~._]/g, '-')
    .replace(/^[-_.]+/, '')
    .replace(/[-_.]+$/, '')
  return cleaned.length > 0 ? cleaned : 'zeroapi-app'
}

/** Builds a sorted `{ name: version }` record for a dependency bucket. */
function toDependencyMap(deps: AggregatedDependency[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const d of [...deps].sort((a, b) => a.name.localeCompare(b.name))) {
    map[d.name] = d.version
  }
  return map
}

/**
 * Generates the `package.json` for the API described by `spec`. Dependencies
 * are computed by {@link getRequiredDependencies} so every package the runtime
 * imports — including conditional ones like `@aws-sdk/client-s3` for S3/R2
 * uploads — is always present. The returned string is suitable for writing to
 * `package.json` inside the exported project bundle.
 */
export function generatePackageJson(spec: ZeroAPISpec, options: PackageJsonOptions = {}): string {
  const deps = getRequiredDependencies(spec)
  const runtimeDeps = deps.filter((d) => !d.dev)
  const devDeps = deps.filter((d) => d.dev)

  const pkg = {
    name: toPackageName(spec.name),
    version: options.version ?? '1.0.0',
    private: true,
    type: 'module',
    main: 'dist/index.js',
    scripts: {
      build: 'tsup src/index.ts --format esm --clean',
      start: 'node dist/index.js',
      dev: 'tsx watch src/index.ts',
      'db:generate': 'prisma generate',
      'db:push': 'prisma db push',
    },
    dependencies: toDependencyMap(runtimeDeps),
    devDependencies: toDependencyMap(devDeps),
    engines: {
      node: '>=18.0.0',
    },
  }

  return JSON.stringify(pkg, null, 2) + '\n'
}
