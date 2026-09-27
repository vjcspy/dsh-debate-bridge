/**
 * Host-only configuration schema.
 *
 * Kept apart from `./config.ts` so the browser bundle never pulls schemastery —
 * a Host library with no business in the page — through the shared module.
 *
 * The Loader validates the bundle patch's `config` row with this schema before
 * the plugin applies, so a malformed deployment value fails at load instead of
 * degrading a request at run time. A deployment that names no row at all gets
 * the defaults below, which point at the debate server on the same machine.
 */
import z from '@deepseek-ai/schemastery'

import {
  DEFAULT_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS_MAX,
  REQUEST_TIMEOUT_MS_MIN,
} from './config.ts'

/** Debate-server connection settings. */
export interface DebateServerConfig {
  /** Debate-server origin, without a trailing slash. */
  baseUrl: string
  /** Upstream deadline per forwarded read, in milliseconds. */
  requestTimeoutMs: number
  /**
   * Name of the environment variable holding the debate server's bearer token,
   * or the empty string for none.
   *
   * A NAME, never the token: every tracked file in this repository is public, so
   * a literal secret in a config row would be published. The Host reads the
   * variable per request, which also means a rotated token needs no reload.
   */
  authTokenEnv: string
}

/** Host configuration for the plugin, as the Loader resolves it. */
export interface Config {
  /** Debate-server connection settings. */
  debateServer: DebateServerConfig
}

/**
 * `requestTimeoutMs` schema: a positive whole-millisecond deadline.
 *
 * The step is the finite guard. `min`/`max` compare with `<`/`>`, which both
 * report false for `NaN`, so a bare range check would resolve `NaN` instead of
 * rejecting it.
 */
const timeoutMs = (): z<number> => z
  .number()
  .step(1)
  .min(REQUEST_TIMEOUT_MS_MIN)
  .max(REQUEST_TIMEOUT_MS_MAX)
  .default(DEFAULT_REQUEST_TIMEOUT_MS)

/** Plugin configuration: the debate-server origin, the upstream deadline, and the bearer source. */
export const Config: z<Config> = z.object({
  debateServer: z.object({
    baseUrl: z.string().pattern(/^https?:\/\/\S+$/).default(DEFAULT_BASE_URL),
    requestTimeoutMs: timeoutMs(),
    authTokenEnv: z.string().default(''),
  }),
})
