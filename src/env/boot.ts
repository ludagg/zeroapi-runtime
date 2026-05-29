import crypto from 'crypto'
import type { ZeroAPISpec } from '../types/spec.js'
import { getRequiredEnvVars, type AggregatedEnvVar } from './aggregate.js'

export type EnvBootLogger = (line: string) => void

export interface BootEnvOptions {
  /** Receives warnings (missing-in-dev, auto-generated values). Defaults to `console.warn`. */
  log?: EnvBootLogger
  /** Whether we are in production. Defaults to `NODE_ENV === 'production'`. */
  isProduction?: boolean
  /** Custom RNG for generated values. Defaults to `crypto.randomBytes(48).toString('hex')`. */
  generateValue?: () => string
}

export interface BootEnvResult {
  /** Vars whose value was generated and written into `process.env`. */
  generated: string[]
  /** Required-but-missing vars in dev (downgraded to a warning). */
  warnings: AggregatedEnvVar[]
  /** Required-but-missing vars that prevented startup in production. */
  fatal: AggregatedEnvVar[]
}

function defaultGenerate(): string {
  return crypto.randomBytes(48).toString('hex')
}

/**
 * Walks the explicit `spec.env` block at boot:
 *
 *  - `generate: true` + absent → mint a random value, set `process.env`, log a warning.
 *  - `required: true` + absent + no generate → fatal in prod, warning in dev.
 *  - `required: false` + absent → ignored.
 *
 * Implicit feature vars (auth.jwt, auth.oauth, file uploads, database) are
 * **not** validated here — they keep their dedicated guards (resolveJwtSecret,
 * Prisma autodetect, …) so we never mask their tailored error messages. They
 * still appear in {@link getRequiredEnvVars} and {@link generateEnvExample}.
 *
 * Throws a single error listing every fatal var when at least one is found in
 * production. Always collects them all before deciding (no "fail on first").
 */
export function validateAndGenerateEnv(
  spec: ZeroAPISpec,
  options: BootEnvOptions = {},
): BootEnvResult {
  const log = options.log ?? ((line: string) => console.warn(line))
  const isProduction = options.isProduction ?? process.env['NODE_ENV'] === 'production'
  const generateValue = options.generateValue ?? defaultGenerate

  const vars = getRequiredEnvVars(spec).filter((v) => v.source === 'explicit')
  const generated: string[] = []
  const warnings: AggregatedEnvVar[] = []
  const fatal: AggregatedEnvVar[] = []

  for (const v of vars) {
    const current = process.env[v.name]
    if (current && current.length > 0) continue

    if (v.generate) {
      const value = generateValue()
      process.env[v.name] = value
      generated.push(v.name)
      log(
        `⚠️  ${v.name} généré automatiquement (éphémère). Définis-le pour la production.`,
      )
      continue
    }

    if (!v.required) continue

    if (isProduction) {
      fatal.push(v)
    } else {
      warnings.push(v)
    }
  }

  if (warnings.length > 0) {
    const lines = warnings.map((v) => formatLine(v))
    log(
      `⚠️  Variables d'environnement manquantes (non bloquant en dev) :\n${lines.join('\n')}`,
    )
  }

  if (fatal.length > 0) {
    const lines = fatal.map((v) => formatLine(v))
    throw new Error(
      `❌ Variables requises manquantes (refus de démarrer en production) :\n${lines.join('\n')}`,
    )
  }

  return { generated, warnings, fatal }
}

function formatLine(v: AggregatedEnvVar): string {
  const desc = v.description ? `\n   Description : ${v.description}` : ''
  return `  • ${v.name}${desc}`
}

/** Snapshot used by /health to surface config status without leaking values. */
export interface ConfigCheck {
  allRequiredPresent: boolean
  missing: string[]
}

/**
 * Returns the current configuration health: names of required vars that are
 * still missing from `process.env`. Variables that get auto-generated
 * (`generate: true`) are considered "present" once mounted, since the runtime
 * sets them in `process.env` at boot. Values are never returned.
 */
export function getConfigCheck(spec: ZeroAPISpec): ConfigCheck {
  const missing: string[] = []
  for (const v of getRequiredEnvVars(spec)) {
    if (!v.required) continue
    const current = process.env[v.name]
    if (!current || current.length === 0) missing.push(v.name)
  }
  return { allRequiredPresent: missing.length === 0, missing }
}
