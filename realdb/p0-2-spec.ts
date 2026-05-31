import { parseSpec } from '../src/index.js'

/**
 * Spec for P0-2 — relations in Prisma mode against a REAL database:
 *   - nested routes      Author → Post   (GET/POST /authors/:id/posts)
 *   - nested M2M create  Post  ↔ Hashtag (POST /posts { hashtags:[…] })
 *   - system cascade     Article(Cascade) / Profile(SetNull) / AuditLog(Restrict)
 *                        / Session(NoAction → DB blocks) all → User
 *   - scope preserved    Post is tenant-scoped (organizationId ↔ JWT `org`)
 */
export const spec = parseSpec({
  version: '1.0.0',
  name: 'p0-2-e2e',
  auth: { jwt: { enabled: true } },
  permissions: [
    {
      resource: 'Post',
      rules: [
        {
          role: 'member',
          actions: ['create', 'read', 'update', 'delete'],
          scope: { column: 'organizationId', claim: 'org' },
        },
      ],
    },
  ],
  resources: [
    // ── nested routes parent ──
    { name: 'Author', fields: { name: { type: 'string', required: true } } },

    // ── nested child (scoped) + M2M owner ──
    {
      name: 'Post',
      fields: {
        title: { type: 'string', required: true },
        organizationId: { type: 'string', required: true },
      },
      relations: [
        { type: 'manyToOne', resource: 'Author', field: 'authorId', required: true },
        { type: 'manyToMany', resource: 'Hashtag', through: 'PostHashtags' },
      ],
    },
    { name: 'Hashtag', fields: { label: { type: 'string', required: true } } },

    // ── system cascade: each points at User with a different onDelete ──
    {
      name: 'Article',
      fields: { headline: { type: 'string', required: true } },
      relations: [{ type: 'manyToOne', resource: 'User', field: 'userId', required: true, onDelete: 'Cascade' }],
    },
    {
      name: 'Profile',
      fields: { bio: { type: 'string', required: false } },
      relations: [{ type: 'manyToOne', resource: 'User', field: 'userId', required: false, onDelete: 'SetNull' }],
    },
    {
      name: 'AuditLog',
      fields: { action: { type: 'string', required: true } },
      relations: [{ type: 'manyToOne', resource: 'User', field: 'userId', required: true, onDelete: 'Restrict' }],
    },
    {
      // No onDelete → Prisma default (Restrict at the DB). Used to force the
      // User delete to fail AFTER the cascade mutated children → proves rollback.
      name: 'Session',
      fields: { token: { type: 'string', required: true } },
      relations: [{ type: 'manyToOne', resource: 'User', field: 'userId', required: true }],
    },
  ],
})
