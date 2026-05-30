import type { StateMachineDef } from '../types/spec.js'

/** Result of checking a requested state transition. */
export type TransitionResult =
  | { ok: true }
  | { ok: false; status: 409 | 403; message: string }

/**
 * Validates a `from → to` change on a state-machine field for a given role.
 *
 *   - `from === to` → no transition, always allowed.
 *   - not listed in `transitions` → 409 (forbidden transition).
 *   - listed but the role isn't in its `roles` (when specified) → 403.
 *   - listed and role permitted (or no `roles` gate) → ok.
 *
 * Pure and mode-agnostic: callers pass the persisted current value (`from`) and
 * the requested value (`to`); it does no I/O.
 */
export function checkTransition(
  sm: StateMachineDef,
  from: unknown,
  to: unknown,
  role: string,
): TransitionResult {
  if (from === to) return { ok: true }

  const transition = sm.transitions.find((t) => t.from === from && t.to === to)
  if (!transition) {
    return {
      ok: false,
      status: 409,
      message: `Invalid transition: ${sm.field} cannot change from "${String(from)}" to "${String(to)}"`,
    }
  }

  if (transition.roles && transition.roles.length > 0 && !transition.roles.includes(role)) {
    return {
      ok: false,
      status: 403,
      message: `Role "${role}" is not allowed to transition ${sm.field} from "${String(from)}" to "${String(to)}"`,
    }
  }

  return { ok: true }
}
