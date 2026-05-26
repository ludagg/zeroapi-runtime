export { createRuntime } from './runtime/index.js'
export { parseSpec, ParseError } from './parser/index.js'
export { generatePrismaSchema } from './generators/schema.js'
export { generateZodSchemas } from './generators/validation.js'
export { generateTests } from './generators/tests.js'
export { generateRoutes } from './generators/routes.js'
export { createAuthMiddleware, AuthError } from './auth/middleware.js'

export type {
  ZeroAPISpec,
  ResourceDefinition,
  FieldDefinition,
  FieldType,
  CrudAction,
  AuthConfig,
  GlobalAuthConfig,
  ResourceHooks,
  HookConfig,
} from './types/spec.js'

export type { RuntimeResult, RuntimeOptions } from './runtime/index.js'
export type { ResourceSchemas } from './generators/validation.js'
export type { DataStore, ResourceStore } from './generators/routes.js'
