/**
 * Single authoritative implementation of resource-name pluralization.
 * Used by route generation, nested-relation key extraction, and OpenAPI docs.
 *
 * Rules (sufficient for English resource names):
 *   words ending in -y  → replace y with -ies  (category → categories)
 *   words already ending in -s → unchanged      (status → status)
 *   everything else     → append -s             (book → books)
 *
 * Always returns lowercase.
 */
export function toPlural(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('s')) return lower
  if (lower.endsWith('y')) return lower.slice(0, -1) + 'ies'
  return lower + 's'
}
