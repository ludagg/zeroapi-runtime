import type { CreateOAuthUserInput, CreateUserInput, UserRecord, UserStore } from './user-store.js'

export interface PrismaUserRow {
  id: string
  email: string
  passwordHash: string
  salt: string
  role: string
  emailVerified: boolean
  createdAt: Date
  updatedAt: Date
}

export interface PrismaUserDelegate {
  findUnique(args: { where: { id?: string; email?: string } }): Promise<PrismaUserRow | null>
  create(args: {
    data: {
      email: string
      passwordHash: string
      salt: string
      role?: string
      emailVerified?: boolean
    }
  }): Promise<PrismaUserRow>
}

export interface PrismaUserLikeClient {
  user: PrismaUserDelegate
}

function toRecord(r: PrismaUserRow): UserRecord {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.passwordHash,
    salt: r.salt,
    role: r.role,
    emailVerified: r.emailVerified,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/**
 * Prisma-backed `UserStore`. Persists JWT-system users to the database — the
 * default in production whenever a Prisma client is detected.
 */
export class PrismaUserStore implements UserStore {
  constructor(private readonly prisma: PrismaUserLikeClient) {}

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.prisma.user.findUnique({ where: { id } })
    return row ? toRecord(row) : null
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } })
    return row ? toRecord(row) : null
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    const row = await this.prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
        salt: input.salt,
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.emailVerified !== undefined ? { emailVerified: input.emailVerified } : {}),
      },
    })
    return toRecord(row)
  }

  async createOAuth(input: CreateOAuthUserInput): Promise<UserRecord> {
    const row = await this.prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        passwordHash: '',
        salt: '',
        role: input.role ?? 'user',
        emailVerified: input.emailVerified ?? true,
      },
    })
    return toRecord(row)
  }
}
