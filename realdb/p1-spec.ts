import { parseSpec } from '../src/index.js'

/**
 * Spec for P1 security proofs against a REAL database. JWT user system on +
 * one auth-protected resource so the global auth middleware (which now consults
 * the revocation store) guards it.
 */
export const spec = parseSpec({
  version: '1.0.0',
  name: 'p1-e2e',
  auth: { jwt: { enabled: true } },
  resources: [
    {
      name: 'Secret',
      fields: { value: { type: 'string', required: true } },
      auth: { required: true },
    },
  ],
})
