/**
 * The reverse session-id mapping the board's Opponent rule is built on.
 *
 * The two directions must agree for every debate id the bridge can mint, and a
 * Session that is not an Opponent Session must resolve to nothing rather than to
 * a plausible-looking id: the board would otherwise select a debate the server
 * cannot serve.
 */
import { describe, expect, test } from 'vitest'

import { debateIdFromSessionId } from '../../src/client/lib/debate-session.ts'
import { SESSION_ID_PREFIX, deriveSessionId } from '../../src/request.ts'

describe('debateIdFromSessionId', () => {
  const debateIds = [
    'b1897c94-c639-4818-ab3d-e5bab9fcccc3',
    'surface-1',
    'a',
    'Debate_With.Dots-And-Dashes',
  ]

  test('is the total inverse of deriveSessionId', () => {
    for (const debateId of debateIds) {
      expect(debateIdFromSessionId(deriveSessionId(debateId))).toBe(debateId)
    }
  })

  test('rejects a Session id that carries no debate prefix', () => {
    for (const sessionId of ['session-abc', 'dsh-debate', '', 'opponent-1', 'DSH-DEBATE-x']) {
      expect(debateIdFromSessionId(sessionId), `${sessionId} must not resolve`).toBeUndefined()
    }
  })

  test('rejects the bare prefix, which deriveSessionId can never produce', () => {
    expect(debateIdFromSessionId(SESSION_ID_PREFIX)).toBeUndefined()
  })
})
