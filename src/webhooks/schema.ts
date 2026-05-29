/**
 * Phase 3.3 — Prisma model snippets for the webhook subsystem. The runtime
 * concatenates these into `generatePrismaSchema()` only when
 * `features.webhooks` is enabled.
 */

export function renderWebhookModels(): string[] {
  const endpoint = `model WebhookEndpoint {
  id        String        @id @default(uuid())
  url       String
  events    String
  secret    String
  active    Boolean       @default(true)
  createdAt DateTime      @default(now())
  events_   WebhookEvent[]
}`

  const event = `model WebhookEvent {
  id          String          @id @default(uuid())
  endpointId  String
  endpoint    WebhookEndpoint @relation(fields: [endpointId], references: [id], onDelete: Cascade)
  eventType   String
  payload     Json
  status      String          @default("pending")
  attempts    Int             @default(0)
  maxAttempts Int             @default(5)
  nextRetryAt DateTime?
  lastError   String?
  lockedAt    DateTime?
  lockedBy    String?
  createdAt   DateTime        @default(now())
  deliveredAt DateTime?
}`

  return [endpoint, event]
}
