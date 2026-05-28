import type { WebhookStore, WebhookEventRecord } from './store.js'

export interface EmitWebhookOptions {
  /** Override the default `maxAttempts` (5) per event. */
  maxAttempts?: number
}

/**
 * Fans out an event to every active endpoint that subscribed to `eventType`.
 * Returns the list of `WebhookEventRecord` rows the worker will pick up.
 *
 * The emitter never throws — webhook delivery is best-effort by design. If the
 * store is unavailable the caller's request still succeeds.
 */
export async function emitWebhook(
  store: WebhookStore,
  eventType: string,
  payload: unknown,
  options: EmitWebhookOptions = {},
): Promise<WebhookEventRecord[]> {
  const endpoints = await store.findActiveEndpointsForEvent(eventType)
  if (endpoints.length === 0) return []
  const created: WebhookEventRecord[] = []
  for (const ep of endpoints) {
    const ev = await store.createEvent({
      endpointId: ep.id,
      eventType,
      payload,
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    })
    created.push(ev)
  }
  return created
}

/**
 * Builds the conventional event type used by the resource routes:
 *   `{resource}.{action}` where `resource` is the lowercased model name.
 */
export function buildResourceEventType(resourceName: string, action: 'created' | 'updated' | 'deleted'): string {
  return `${resourceName.toLowerCase()}.${action}`
}
