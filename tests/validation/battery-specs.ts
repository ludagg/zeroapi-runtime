/**
 * EXHAUSTIVE schema-validation battery.
 *
 * Every entry is a raw spec (pre-`parseSpec`) that exercises one tricky corner
 * of the generator. The battery test feeds each through THREE validators:
 *   1. generated Prisma schema → real `prisma validate`
 *   2. generated OpenAPI doc   → `@apidevtools/swagger-parser` validate
 *   3. generated TS SDK        → `tsc --strict`
 *
 * The goal: it must be IMPOSSIBLE to emit an invalid schema/OpenAPI/SDK without
 * a test here turning red. When adding a generator feature, add a spec here too.
 */

export interface BatterySpec {
  /** Stable, human-readable id used in test names and temp filenames. */
  name: string
  /** Raw spec object, parsed via `parseSpec` by the battery test. */
  raw: unknown
}

// ── 1. RELATIONS ──────────────────────────────────────────────────────────────

const relationSpecs: BatterySpec[] = [
  {
    name: 'rel-one-to-one-required',
    raw: {
      version: '1.0.0',
      name: 'oto-req',
      resources: [
        { name: 'Account', fields: { login: { type: 'string', required: true } } },
        {
          name: 'Profile',
          fields: { bio: { type: 'text' } },
          relations: [{ type: 'oneToOne', resource: 'Account', field: 'accountId', required: true }],
        },
      ],
    },
  },
  {
    name: 'rel-one-to-one-optional',
    raw: {
      version: '1.0.0',
      name: 'oto-opt',
      resources: [
        { name: 'Account', fields: { login: { type: 'string', required: true } } },
        {
          name: 'Profile',
          fields: { bio: { type: 'text' } },
          relations: [{ type: 'oneToOne', resource: 'Account', field: 'accountId' }],
        },
      ],
    },
  },
  {
    name: 'rel-one-to-many-toplevel',
    raw: {
      version: '1.0.0',
      name: 'otm',
      resources: [
        { name: 'Category', fields: { name: { type: 'string', required: true } } },
        { name: 'Product', fields: { title: { type: 'string', required: true } } },
      ],
      relations: [{ from: 'Category', to: 'Product', type: 'one-to-many', field: 'products' }],
    },
  },
  {
    name: 'rel-many-to-one',
    raw: {
      version: '1.0.0',
      name: 'mto',
      resources: [
        { name: 'Category', fields: { name: { type: 'string', required: true } } },
        {
          name: 'Product',
          fields: { title: { type: 'string', required: true } },
          relations: [{ type: 'manyToOne', resource: 'Category', field: 'categoryId', required: true }],
        },
      ],
    },
  },
  {
    name: 'rel-m2m-through-declared',
    raw: {
      version: '1.0.0',
      name: 'm2m-decl',
      resources: [
        { name: 'Product', fields: { title: { type: 'string', required: true } } },
        { name: 'Order', fields: { total: { type: 'decimal', required: true } } },
        {
          name: 'OrderItem',
          fields: {
            quantity: { type: 'integer', required: true },
            priceAtPurchase: { type: 'decimal', required: true },
          },
        },
      ],
      relations: [
        { from: 'Product', to: 'Order', type: 'many-to-many', field: 'orders', through: 'OrderItem' },
      ],
    },
  },
  {
    name: 'rel-m2m-through-undeclared',
    raw: {
      version: '1.0.0',
      name: 'm2m-auto',
      resources: [
        {
          name: 'Post',
          fields: { title: { type: 'string', required: true } },
          relations: [{ type: 'manyToMany', resource: 'Tag', through: 'PostTags' }],
        },
        { name: 'Tag', fields: { name: { type: 'string', required: true } } },
      ],
    },
  },
  {
    // The through model is ALSO a first-class resource directly related to BOTH
    // endpoints. Without de-duplication this emits two unnamed `OrderItem[]`
    // back-relations on each endpoint → "Ambiguous relation … both refer to
    // OrderItem". Each endpoint must end up with exactly one OrderItem array.
    name: 'rel-m2m-through-plus-direct',
    raw: {
      version: '1.0.0',
      name: 'm2m-through-direct',
      resources: [
        { name: 'Product', fields: { name: { type: 'string', required: true } } },
        { name: 'Order', fields: { total: { type: 'decimal', required: true } } },
        {
          name: 'OrderItem',
          fields: {
            quantity: { type: 'integer', required: true },
            priceAtPurchase: { type: 'decimal', required: true },
          },
        },
      ],
      relations: [
        { from: 'Order', to: 'Product', type: 'many-to-many', field: 'products', through: 'OrderItem' },
        { from: 'Product', to: 'OrderItem', type: 'one-to-many', field: 'orderItems' },
        { from: 'Order', to: 'OrderItem', type: 'one-to-many', field: 'orderItems' },
      ],
    },
  },
  {
    // Same shape, but the through model declares its OWN manyToOne relations to
    // the endpoints (instead of the inverse one-to-many being declared on them).
    name: 'rel-m2m-through-owns-fks',
    raw: {
      version: '1.0.0',
      name: 'm2m-through-owns',
      resources: [
        { name: 'Product', fields: { name: { type: 'string', required: true } } },
        { name: 'Order', fields: { total: { type: 'decimal', required: true } } },
        {
          name: 'OrderItem',
          fields: { quantity: { type: 'integer', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'Order', field: 'orderId', required: true },
            { type: 'manyToOne', resource: 'Product', field: 'productId', required: true },
          ],
        },
      ],
      relations: [
        { from: 'Order', to: 'Product', type: 'many-to-many', field: 'products', through: 'OrderItem' },
      ],
    },
  },
  {
    name: 'rel-multi-same-target-user',
    raw: {
      version: '1.0.0',
      name: 'marketplace',
      auth: { jwt: { enabled: true } },
      resources: [
        {
          name: 'Order',
          fields: { total: { type: 'decimal', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'User', field: 'buyerId' },
            { type: 'manyToOne', resource: 'User', field: 'sellerId' },
          ],
        },
      ],
    },
  },
  {
    name: 'rel-multi-same-target-user-defined',
    raw: {
      version: '1.0.0',
      name: 'chat',
      resources: [
        { name: 'Person', fields: { name: { type: 'string', required: true } } },
        {
          name: 'Message',
          fields: { body: { type: 'string', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'Person', field: 'senderId', required: true },
            { type: 'manyToOne', resource: 'Person', field: 'receiverId', required: true },
          ],
        },
      ],
    },
  },
  {
    name: 'rel-to-system-user',
    raw: {
      version: '1.0.0',
      name: 'notes-user',
      auth: { jwt: { enabled: true } },
      resources: [
        {
          name: 'Note',
          fields: { body: { type: 'text', required: true } },
          relations: [{ type: 'manyToOne', resource: 'User', field: 'userId', required: true }],
        },
      ],
    },
  },
  {
    name: 'rel-to-system-oauthaccount',
    raw: {
      version: '1.0.0',
      name: 'audit-oauth',
      auth: {
        jwt: { enabled: true },
        oauth: { providers: [{ name: 'github', clientIdEnv: 'GH_ID', clientSecretEnv: 'GH_SECRET' }] },
      },
      resources: [
        {
          name: 'AuditLog',
          fields: { action: { type: 'string', required: true } },
          relations: [{ type: 'manyToOne', resource: 'OAuthAccount', field: 'oauthAccountId' }],
        },
      ],
    },
  },
  {
    name: 'rel-self-comment',
    raw: {
      version: '1.0.0',
      name: 'forum',
      resources: [
        {
          name: 'Comment',
          fields: { body: { type: 'text', required: true } },
          relations: [{ type: 'manyToOne', resource: 'Comment', field: 'parentId' }],
        },
      ],
    },
  },
  {
    name: 'rel-self-person-follow',
    raw: {
      version: '1.0.0',
      name: 'follow',
      resources: [
        {
          name: 'Person',
          fields: { handle: { type: 'string', required: true } },
          relations: [{ type: 'manyToOne', resource: 'Person', field: 'followsId' }],
        },
      ],
    },
  },
  {
    name: 'rel-self-both-sides',
    raw: {
      version: '1.0.0',
      name: 'tree',
      resources: [
        {
          name: 'Comment',
          fields: { body: { type: 'text', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'Comment', field: 'parentId' },
            { type: 'oneToMany', resource: 'Comment' },
          ],
        },
      ],
    },
  },
  {
    name: 'rel-deep-chain-abcd',
    raw: {
      version: '1.0.0',
      name: 'chain',
      resources: [
        { name: 'A', fields: { n: { type: 'string', required: true } } },
        {
          name: 'B',
          fields: { n: { type: 'string', required: true } },
          relations: [{ type: 'manyToOne', resource: 'A', field: 'aId', required: true }],
        },
        {
          name: 'C',
          fields: { n: { type: 'string', required: true } },
          relations: [{ type: 'manyToOne', resource: 'B', field: 'bId', required: true }],
        },
        {
          name: 'D',
          fields: { n: { type: 'string', required: true } },
          relations: [{ type: 'manyToOne', resource: 'C', field: 'cId', required: true }],
        },
      ],
    },
  },
  {
    name: 'rel-ondelete-cascade',
    raw: {
      version: '1.0.0',
      name: 'od-cascade',
      resources: [
        { name: 'Parent', fields: { n: { type: 'string', required: true } } },
        {
          name: 'Child',
          fields: { n: { type: 'string', required: true } },
          relations: [{ type: 'manyToOne', resource: 'Parent', field: 'parentId', required: true, onDelete: 'Cascade' }],
        },
      ],
    },
  },
  {
    name: 'rel-ondelete-setnull-optional',
    raw: {
      version: '1.0.0',
      name: 'od-setnull',
      resources: [
        { name: 'Parent', fields: { n: { type: 'string', required: true } } },
        {
          name: 'Child',
          fields: { n: { type: 'string', required: true } },
          relations: [{ type: 'manyToOne', resource: 'Parent', field: 'parentId', onDelete: 'SetNull' }],
        },
      ],
    },
  },
  {
    name: 'rel-ondelete-restrict',
    raw: {
      version: '1.0.0',
      name: 'od-restrict',
      resources: [
        { name: 'Parent', fields: { n: { type: 'string', required: true } } },
        {
          name: 'Child',
          fields: { n: { type: 'string', required: true } },
          relations: [{ type: 'manyToOne', resource: 'Parent', field: 'parentId', required: true, onDelete: 'Restrict' }],
        },
      ],
    },
  },
  {
    name: 'rel-many-relations-5plus',
    raw: {
      version: '1.0.0',
      name: 'hub',
      resources: [
        { name: 'A', fields: { n: { type: 'string', required: true } } },
        { name: 'B', fields: { n: { type: 'string', required: true } } },
        { name: 'C', fields: { n: { type: 'string', required: true } } },
        { name: 'D', fields: { n: { type: 'string', required: true } } },
        { name: 'E', fields: { n: { type: 'string', required: true } } },
        {
          name: 'Hub',
          fields: { n: { type: 'string', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'A', field: 'aId' },
            { type: 'manyToOne', resource: 'B', field: 'bId' },
            { type: 'manyToOne', resource: 'C', field: 'cId' },
            { type: 'manyToOne', resource: 'D', field: 'dId' },
            { type: 'manyToOne', resource: 'E', field: 'eId' },
          ],
        },
      ],
    },
  },
]

// ── 2. FIELDS ──────────────────────────────────────────────────────────────────

const fieldSpecs: BatterySpec[] = [
  {
    name: 'fields-all-15-types',
    raw: {
      version: '1.0.0',
      name: 'all-types',
      resources: [
        {
          name: 'Everything',
          fields: {
            str: { type: 'string' },
            txt: { type: 'text' },
            mail: { type: 'email' },
            link: { type: 'url' },
            ident: { type: 'uuid' },
            num: { type: 'number' },
            int: { type: 'integer' },
            dec: { type: 'decimal' },
            flag: { type: 'boolean' },
            day: { type: 'date' },
            ts: { type: 'datetime' },
            blob: { type: 'json' },
            doc: { type: 'file' },
            docs: { type: 'file[]' },
            status: { type: 'enum', values: ['draft', 'published', 'archived'] },
          },
        },
      ],
    },
  },
  {
    name: 'fields-short-and-long-names',
    raw: {
      version: '1.0.0',
      name: 'names',
      resources: [
        {
          name: 'Widget',
          fields: {
            a: { type: 'string', required: true },
            ab: { type: 'integer' },
            abc: { type: 'boolean' },
            fourteenCharsXX: { type: 'string' }, // 15 chars
            aFieldNameThatIsAtLeastTwenty: { type: 'decimal' }, // ≥20 chars
            anotherVeryLongDescriptiveFieldName: { type: 'text' },
          },
        },
      ],
    },
  },
  {
    name: 'fields-modifiers',
    raw: {
      version: '1.0.0',
      name: 'modifiers',
      resources: [
        {
          name: 'Item',
          fields: {
            req: { type: 'string', required: true },
            opt: { type: 'string', required: false },
            uniq: { type: 'string', unique: true },
            idx: { type: 'string', index: true },
            uniqReq: { type: 'email', required: true, unique: true },
          },
        },
      ],
    },
  },
  {
    name: 'fields-defaults-each-type',
    raw: {
      version: '1.0.0',
      name: 'defaults',
      resources: [
        {
          name: 'Settings',
          fields: {
            label: { type: 'string', default: 'untitled' },
            count: { type: 'integer', default: 0 },
            ratio: { type: 'number', default: 1.5 },
            price: { type: 'decimal', default: 9.99 },
            active: { type: 'boolean', default: true },
            tier: { type: 'enum', values: ['free', 'pro'], default: 'free' },
          },
        },
      ],
    },
  },
  {
    name: 'fields-enum-multi-values',
    raw: {
      version: '1.0.0',
      name: 'enums',
      resources: [
        {
          name: 'Ticket',
          fields: {
            title: { type: 'string', required: true },
            priority: { type: 'enum', values: ['low', 'medium', 'high', 'urgent', 'critical'], required: true },
            state: { type: 'enum', values: ['open', 'closed'] },
          },
        },
      ],
    },
  },
  {
    name: 'fields-reserved-prisma-words',
    raw: {
      version: '1.0.0',
      name: 'reserved',
      resources: [
        {
          name: 'Thing',
          fields: {
            model: { type: 'string', required: true },
            type: { type: 'string' },
            enum: { type: 'string' },
            index: { type: 'string' },
            map: { type: 'string' },
            default: { type: 'string' },
            relation: { type: 'string' },
          },
        },
      ],
    },
  },
]

// ── 3. AUTH ─────────────────────────────────────────────────────────────────────

const authSpecs: BatterySpec[] = [
  {
    name: 'auth-jwt-only',
    raw: {
      version: '1.0.0',
      name: 'jwt-only',
      auth: { jwt: { enabled: true } },
      resources: [{ name: 'Note', fields: { body: { type: 'text', required: true } } }],
    },
  },
  {
    name: 'auth-apikey-only',
    raw: {
      version: '1.0.0',
      name: 'apikey-only',
      auth: { apikey: { enabled: true } },
      resources: [{ name: 'Widget', fields: { name: { type: 'string', required: true } } }],
    },
  },
  {
    name: 'auth-oauth-google-only',
    raw: {
      version: '1.0.0',
      name: 'oauth-google',
      auth: {
        jwt: { enabled: true },
        oauth: { providers: [{ name: 'google', clientIdEnv: 'G_ID', clientSecretEnv: 'G_SECRET' }] },
      },
      resources: [{ name: 'Doc', fields: { title: { type: 'string', required: true } } }],
    },
  },
  {
    name: 'auth-oauth-github-only',
    raw: {
      version: '1.0.0',
      name: 'oauth-github',
      auth: {
        jwt: { enabled: true },
        oauth: { providers: [{ name: 'github', clientIdEnv: 'GH_ID', clientSecretEnv: 'GH_SECRET' }] },
      },
      resources: [{ name: 'Repo', fields: { slug: { type: 'string', required: true } } }],
    },
  },
  {
    name: 'auth-all-three-combined',
    raw: {
      version: '1.0.0',
      name: 'all-auth',
      auth: {
        jwt: { enabled: true },
        apikey: { enabled: true },
        oauth: {
          providers: [
            { name: 'google', clientIdEnv: 'G_ID', clientSecretEnv: 'G_SECRET' },
            { name: 'github', clientIdEnv: 'GH_ID', clientSecretEnv: 'GH_SECRET' },
          ],
        },
      },
      resources: [
        {
          name: 'Project',
          fields: { name: { type: 'string', required: true } },
          relations: [{ type: 'manyToOne', resource: 'User', field: 'ownerId', required: true }],
        },
      ],
    },
  },
  {
    name: 'auth-rbac-permissions-ownonly',
    raw: {
      version: '1.0.0',
      name: 'rbac',
      auth: { jwt: { enabled: true } },
      roles: [{ name: 'admin' }, { name: 'user' }],
      permissions: [
        {
          resource: 'Doc',
          rules: [
            { role: 'admin', actions: ['create', 'read', 'update', 'delete'] },
            { role: 'user', actions: ['read', 'update'], ownOnly: true },
          ],
        },
      ],
      resources: [{ name: 'Doc', fields: { title: { type: 'string', required: true } } }],
    },
  },
]

// ── 4. REAL-WORLD CASES ─────────────────────────────────────────────────────────

const realWorldSpecs: BatterySpec[] = [
  {
    name: 'real-ecommerce',
    raw: {
      version: '1.0.0',
      name: 'ecommerce',
      auth: { jwt: { enabled: true } },
      resources: [
        { name: 'Category', fields: { name: { type: 'string', required: true } } },
        {
          name: 'Product',
          fields: { name: { type: 'string', required: true }, price: { type: 'decimal', required: true } },
        },
        { name: 'Order', fields: { total: { type: 'decimal', required: true } } },
        {
          name: 'OrderItem',
          fields: {
            quantity: { type: 'integer', required: true },
            priceAtPurchase: { type: 'decimal', required: true },
          },
        },
        { name: 'Review', fields: { rating: { type: 'integer', required: true } } },
      ],
      relations: [
        { from: 'Category', to: 'Product', type: 'one-to-many', field: 'products' },
        { from: 'Product', to: 'Order', type: 'many-to-many', field: 'orders', through: 'OrderItem' },
        { from: 'Review', to: 'Product', type: 'many-to-one', field: 'productId' },
        { from: 'Review', to: 'User', type: 'many-to-one', field: 'userId' },
        { from: 'Order', to: 'User', type: 'many-to-one', field: 'userId' },
      ],
    },
  },
  {
    // The REAL spec produced by the clarifier for an e-commerce app — captured
    // verbatim from the job that failed `prisma validate` in production. It
    // differs from `real-ecommerce` above by ALSO declaring direct one-to-many
    // relations from Product/Order to the OrderItem through-model, which is what
    // triggered the ambiguous-relation P1012.
    name: 'real-ecommerce-clarifier',
    raw: {
      version: '1.0.0',
      name: 'ecommerce-clarifier',
      auth: { jwt: { enabled: true } },
      resources: [
        { name: 'Category', fields: { name: { type: 'string', required: true } } },
        {
          name: 'Product',
          fields: { name: { type: 'string', required: true }, price: { type: 'decimal', required: true } },
        },
        { name: 'Order', fields: { total: { type: 'decimal', required: true } } },
        {
          name: 'OrderItem',
          fields: {
            quantity: { type: 'integer', required: true },
            priceAtPurchase: { type: 'decimal', required: true },
          },
        },
        { name: 'Review', fields: { rating: { type: 'integer', required: true } } },
      ],
      relations: [
        { from: 'Category', to: 'Product', type: 'one-to-many', field: 'products' },
        { from: 'Order', to: 'Product', type: 'many-to-many', field: 'products', through: 'OrderItem' },
        { from: 'Product', to: 'OrderItem', type: 'one-to-many', field: 'orderItems' },
        { from: 'Order', to: 'OrderItem', type: 'one-to-many', field: 'orderItems' },
        { from: 'Review', to: 'Product', type: 'many-to-one', field: 'productId' },
        { from: 'Review', to: 'User', type: 'many-to-one', field: 'userId' },
        { from: 'Order', to: 'User', type: 'many-to-one', field: 'userId' },
      ],
    },
  },
  {
    name: 'real-blog',
    raw: {
      version: '1.0.0',
      name: 'blog',
      auth: { jwt: { enabled: true } },
      resources: [
        { name: 'Category', fields: { name: { type: 'string', required: true } } },
        {
          name: 'Article',
          fields: {
            title: { type: 'string', required: true },
            body: { type: 'text', required: true },
            status: { type: 'enum', values: ['draft', 'published'], default: 'draft' },
          },
          relations: [
            { type: 'manyToOne', resource: 'Category', field: 'categoryId' },
            { type: 'manyToOne', resource: 'User', field: 'authorId', required: true },
            { type: 'manyToMany', resource: 'Tag', through: 'ArticleTags' },
          ],
        },
        {
          name: 'Comment',
          fields: { body: { type: 'text', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'Article', field: 'articleId', required: true },
            { type: 'manyToOne', resource: 'User', field: 'authorId', required: true },
          ],
        },
        { name: 'Tag', fields: { name: { type: 'string', required: true } } },
      ],
    },
  },
  {
    name: 'real-social-network',
    raw: {
      version: '1.0.0',
      name: 'social',
      auth: { jwt: { enabled: true } },
      resources: [
        {
          name: 'Profile',
          fields: { handle: { type: 'string', required: true, unique: true } },
          relations: [
            { type: 'manyToOne', resource: 'User', field: 'userId', required: true },
            { type: 'manyToOne', resource: 'Profile', field: 'followsId' },
          ],
        },
        {
          name: 'Post',
          fields: { body: { type: 'text', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'Profile', field: 'authorId', required: true },
            { type: 'manyToMany', resource: 'Hashtag', through: 'PostHashtags' },
          ],
        },
        {
          name: 'Like',
          fields: { reaction: { type: 'enum', values: ['like', 'love', 'haha'], default: 'like' } },
          relations: [
            { type: 'manyToOne', resource: 'Post', field: 'postId', required: true },
            { type: 'manyToOne', resource: 'Profile', field: 'profileId', required: true },
          ],
        },
        {
          name: 'Comment',
          fields: { body: { type: 'text', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'Post', field: 'postId', required: true },
            { type: 'manyToOne', resource: 'Profile', field: 'authorId', required: true },
            { type: 'manyToOne', resource: 'Comment', field: 'parentId' },
          ],
        },
        { name: 'Hashtag', fields: { tag: { type: 'string', required: true, unique: true } } },
      ],
    },
  },
  {
    name: 'real-saas-b2b',
    raw: {
      version: '1.0.0',
      name: 'saas',
      auth: { jwt: { enabled: true } },
      resources: [
        { name: 'Organization', fields: { name: { type: 'string', required: true } } },
        {
          name: 'Membership',
          fields: { role: { type: 'enum', values: ['owner', 'admin', 'member'], required: true } },
          relations: [
            { type: 'manyToOne', resource: 'Organization', field: 'organizationId', required: true, onDelete: 'Cascade' },
            { type: 'manyToOne', resource: 'User', field: 'userId', required: true, onDelete: 'Cascade' },
          ],
        },
        {
          name: 'Project',
          fields: { name: { type: 'string', required: true } },
          relations: [
            { type: 'manyToOne', resource: 'Organization', field: 'organizationId', required: true, onDelete: 'Cascade' },
          ],
        },
        {
          name: 'Task',
          fields: {
            title: { type: 'string', required: true },
            done: { type: 'boolean', default: false },
          },
          relations: [
            { type: 'manyToOne', resource: 'Project', field: 'projectId', required: true, onDelete: 'Cascade' },
            { type: 'manyToOne', resource: 'User', field: 'assigneeId' },
            { type: 'manyToOne', resource: 'User', field: 'reporterId', required: true },
          ],
        },
      ],
    },
  },
  {
    name: 'real-booking',
    raw: {
      version: '1.0.0',
      name: 'booking',
      auth: { jwt: { enabled: true } },
      permissions: [
        {
          resource: 'Booking',
          rules: [
            { role: 'user', actions: ['create', 'read', 'update', 'delete'], ownOnly: true },
            { role: 'admin', actions: ['read'] },
          ],
        },
      ],
      resources: [
        { name: 'Venue', fields: { name: { type: 'string', required: true } } },
        {
          name: 'TimeSlot',
          fields: { startsAt: { type: 'datetime', required: true }, endsAt: { type: 'datetime', required: true } },
          relations: [{ type: 'manyToOne', resource: 'Venue', field: 'venueId', required: true, onDelete: 'Cascade' }],
        },
        {
          name: 'Booking',
          fields: { status: { type: 'enum', values: ['pending', 'confirmed', 'cancelled'], default: 'pending' } },
          relations: [
            { type: 'manyToOne', resource: 'TimeSlot', field: 'timeSlotId', required: true },
            { type: 'manyToOne', resource: 'User', field: 'userId', required: true },
          ],
        },
      ],
    },
  },
]

export const batterySpecs: BatterySpec[] = [
  ...relationSpecs,
  ...fieldSpecs,
  ...authSpecs,
  ...realWorldSpecs,
]
