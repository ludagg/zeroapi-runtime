import { randomUUID } from 'crypto'

export interface UserRecord {
  id: string
  email: string
  passwordHash: string
  salt: string
  role: string
  emailVerified: boolean
  createdAt: Date
  updatedAt: Date
}

export interface CreateUserInput {
  email: string
  passwordHash: string
  salt: string
  role?: string
  emailVerified?: boolean
}

/** Input for users created via an OAuth provider — no local credentials. */
export interface CreateOAuthUserInput {
  email: string
  role?: string
  emailVerified?: boolean
}

/**
 * Persistent store for JWT-system users. Implemented in-memory by default;
 * a Prisma-backed implementation lives in `prisma-user-store.ts`.
 */
export interface UserStore {
  findById(id: string): Promise<UserRecord | null>
  findByEmail(email: string): Promise<UserRecord | null>
  create(input: CreateUserInput): Promise<UserRecord>
  /**
   * Create a user originating from an OAuth login. `passwordHash`/`salt` are
   * stored as empty strings — `verifyPassword` will then fail closed, so the
   * user cannot log in with a password until they explicitly set one.
   */
  createOAuth(input: CreateOAuthUserInput): Promise<UserRecord>
}

export class MemoryUserStore implements UserStore {
  private byId = new Map<string, UserRecord>()
  private byEmail = new Map<string, string>()

  async findById(id: string): Promise<UserRecord | null> {
    return this.byId.get(id) ?? null
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const id = this.byEmail.get(email.toLowerCase())
    if (!id) return null
    return this.byId.get(id) ?? null
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    const now = new Date()
    const record: UserRecord = {
      id: randomUUID(),
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      salt: input.salt,
      role: input.role ?? 'user',
      emailVerified: input.emailVerified ?? false,
      createdAt: now,
      updatedAt: now,
    }
    this.byId.set(record.id, record)
    this.byEmail.set(record.email, record.id)
    return record
  }

  async createOAuth(input: CreateOAuthUserInput): Promise<UserRecord> {
    const now = new Date()
    const record: UserRecord = {
      id: randomUUID(),
      email: input.email.toLowerCase(),
      passwordHash: '',
      salt: '',
      role: input.role ?? 'user',
      emailVerified: input.emailVerified ?? true,
      createdAt: now,
      updatedAt: now,
    }
    this.byId.set(record.id, record)
    this.byEmail.set(record.email, record.id)
    return record
  }
}
