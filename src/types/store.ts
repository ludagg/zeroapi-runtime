/** One resource collection: a map of record id → record. */
export type ResourceMap = Map<string, Record<string, unknown>>
/** The whole in-memory dataset: a map of resource key → that resource's collection. */
export type DataStore = Map<string, ResourceMap>
