import type { ZeroAPISpec } from '../types/spec.js'
import { getRequiredEnvVars, type AggregatedEnvVar } from './aggregate.js'

function formatLabel(v: AggregatedEnvVar): string {
  if (v.required && v.generate) return 'REQUISE — générée automatiquement si absente'
  if (v.required) return 'REQUISE'
  return 'optionnelle'
}

function formatBlock(v: AggregatedEnvVar): string {
  const lines: string[] = [`# ${v.name} (${formatLabel(v)})`]
  if (v.description) lines.push(`# ${v.description}`)
  if (v.example) lines.push(`# Exemple : ${v.example}`)
  lines.push(`${v.name}=`)
  return lines.join('\n')
}

/**
 * Produces a `.env.example` file body for the given spec. Lists every
 * variable returned by {@link getRequiredEnvVars} in the order the
 * aggregator emits them (explicit declarations first, implicit features
 * after).
 */
export function generateEnvExample(spec: ZeroAPISpec): string {
  const vars = getRequiredEnvVars(spec)
  const header = [
    '# ===================================',
    `# Variables d'environnement — ${spec.name}`,
    '# ===================================',
  ].join('\n')
  if (vars.length === 0) return `${header}\n`
  return `${header}\n\n${vars.map(formatBlock).join('\n\n')}\n`
}
