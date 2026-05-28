export type {
  StorageProvider, UploadInput, UploadOutput,
} from './provider.js'

export { LocalStorage, mountLocalUploadRoute } from './local.js'
export type { LocalStorageOptions } from './local.js'

export {
  S3Storage,
  readS3ConfigFromEnv, hasS3EnvConfig, loadS3Module,
  __setS3ModuleForTests, __resetS3ModuleCache,
  S3_ENDPOINT_ENV, S3_BUCKET_ENV, S3_ACCESS_KEY_ID_ENV,
  S3_SECRET_ACCESS_KEY_ENV, S3_REGION_ENV, S3_PUBLIC_URL_ENV,
} from './s3.js'
export type { S3StorageConfig, S3Module } from './s3.js'

export { resolveStorageProvider, LOCAL_IN_PROD_WARNING } from './factory.js'
export type { ResolveStorageOptions, StorageBootLogger } from './factory.js'

export { mountUploadRoutes } from './routes.js'
export type { UploadRoutesOptions } from './routes.js'
