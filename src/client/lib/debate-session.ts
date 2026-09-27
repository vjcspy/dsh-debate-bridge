/**
 * The reverse of the bridge's session-id convention.
 *
 * The host half mints the Opponent Session as `dsh-debate-<debateId>`
 * (`src/request.ts`'s {@link SESSION_ID_PREFIX} and `deriveSessionId`), and the
 * debate exists before that Session does. Stripping the prefix is therefore a
 * total inverse for the Opponent case, and it is the only Session→debate link
 * that needs no observation at all.
 *
 * @module dsh-debate-bridge/client/lib/debate-session
 */
import { SESSION_ID_PREFIX } from '../../config.ts'

/**
 * Read the debate id out of an Opponent Session id.
 *
 * A non-debate Session and a bare prefix both yield `undefined`: the second
 * cannot come from {@link deriveSessionId} (a debate id is non-blank), and
 * treating it as a debate would open the board on an id nothing serves.
 * @param sessionId - the Session id to read.
 * @returns the debate id, or `undefined` when this is not an Opponent Session.
 */
export function debateIdFromSessionId(sessionId: string): string | undefined {
  if (!sessionId.startsWith(SESSION_ID_PREFIX)) return undefined
  const debateId = sessionId.slice(SESSION_ID_PREFIX.length)
  return debateId === '' ? undefined : debateId
}
