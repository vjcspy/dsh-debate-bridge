/**
 * Debate-Opponent session lifecycle, executed IN PROCESS inside the running
 * `dsh web` host.
 *
 * Why in-process is not an implementation detail: the Web GUI's session list is
 * built from live ids in the in-memory `SessionStore` plus cold rows read from
 * disk (`packages/api/session-controller/src/list.ts:126-144`), and the push
 * event `api-session/added` fires only from `ctx.on('session/created')`
 * (`packages/api/session-controller/src/index.ts:146-148`). There is no
 * filesystem watcher, and a session written by a *separate* process surfaces
 * only as a cold row that cannot be adopted while it is live
 * (`session/writer-held`, `packages/api/session-controller/src/agent.ts:218-221`).
 * Creating the Session here is what makes the Human see it live.
 *
 * The creation sequence is the blessed `createWebhookSession` sequence
 * (`packages/webhook/webhook/src/session.ts:132-173`) with one difference that
 * matters: this caller chooses the session id, so it can return it and be
 * idempotent.
 *
 * @module dsh-debate-bridge/session
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
// Side-effect type imports: these declare the `agentDefaultModel`,
// `workspaceRegistry`, `permissionPresets`, `sessionTitle` and `agentPresets`
// members this module reads.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import { brandString } from '@deepseek-ai/dsh-brand'
import { boundContextSummary, createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import {
  SessionAlreadyExistsError,
  SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { buildSessionTitle, deriveSessionId, type StartRequest } from './request.ts'
import { DEBATE_OPPONENT_SOURCE_KIND } from './source.ts'

/** The one input of {@link DebateSessions.open}. */
export interface OpenSessionInput {
  /** Validated `POST /dsh-debate/opponent` body. */
  readonly request: StartRequest
  /**
   * Canonical agent-preset id resolved against the live registry by the caller,
   * or `undefined` for the host default. `meta.agentPreset` is the real carrier
   * (`packages/core/agent/src/index.ts:84`); passing the raw request string
   * without resolving it would accept a typo and silently use the default.
   */
  readonly agentPresetId: string | undefined
  /**
   * Permission preset to APPLY, already resolved by the caller from the live
   * registry. This is never the raw request value: `''` on the wire means "host
   * default", and the caller substitutes the concrete default name so the
   * mandated `permissionPresets.set` step always runs. Applying an explicitly
   * named default is observable; omitting the call is not.
   */
  readonly permissionPreset: string
  /**
   * Complete model route resolved by {@link resolveModelRoute}, already checked
   * non-blank. Resolving in the ROUTE (before anything is created) is what keeps
   * a half-configured host from minting a session whose every turn dies.
   */
  readonly modelRoute: { readonly provider: string; readonly model: string }
}

/** Edge-derived status of one session, as reported by `POST /dsh-debate/opponent/status`. */
export interface SessionStatus {
  /** Whether the host currently holds a live Agent for this id. */
  readonly live: boolean
  /**
   * Whether the Agent's last observed status transition landed on `idle`, i.e.
   * its turn ended and no driver is scheduled.
   *
   * Edge-derived, never an elapsed-time predicate: a session blocked inside a
   * long `aw debate wait` is MID-TURN and emits no turn-end, so a
   * `now - lastActivityAt > threshold` rule would flag a healthy Opponent,
   * nudge it, and abort a legitimate wait.
   */
  readonly idle: boolean
  /** Last observed status transition, ISO-8601. Display only — never the predicate. */
  readonly lastActivityAt: string | null
}

/** Minimal logging seam, so this module needs no Cordis logger in tests. */
export interface SessionLog {
  warn(message: string): void
}

/** The per-plugin session table. One instance per plugin mount. */
export interface DebateSessions {
  /**
   * Open (or adopt) the Opponent session for one debate and admit one turn.
   * @param ctx - host context carrying the live services.
   * @param input - validated request plus the resolved agent-preset id.
   * @returns the session id, which is the id returned to the caller.
   */
  open(ctx: Context, input: OpenSessionInput): Promise<SessionId>
  /**
   * Cancel the session's current activity.
   * @param ctx - host context.
   * @param sessionId - exact session to cancel.
   * @returns whether a live session was found and cancellation requested; an
   *   already-gone session is an idempotent `false`, never an error.
   */
  stop(ctx: Context, sessionId: string): boolean
  /**
   * Read the session's liveness and edge-derived idle state.
   * @param ctx - host context.
   * @param sessionId - exact session to report on.
   * @returns the status projection; `live: false` also forces `idle: false`,
   *   because "idle" is a property of a driver that exists.
   */
  status(ctx: Context, sessionId: string): SessionStatus
  /** Remove every status listener this table registered. */
  dispose(): void
}

/** One session's recorded status edges. */
interface SessionWatch {
  /** The last observed status. Seeded from `agent.status` at watch time. */
  idle: boolean
  /** ISO-8601 instant of the last observed transition. */
  lastActivityAt: string
  /** Cordis listener disposer. */
  dispose: () => void
}

/**
 * Whether an error from `ctx.agents.resume` means "no such persisted session",
 * which is the one condition that falls through to creation. Every other
 * failure — corruption, ownership conflict, backend error — stays loud,
 * mirroring the loop's own rule
 * (`packages/core/agent-loop/src/index.ts:495-498`).
 * @param error - the rejection.
 * @returns true when the id is simply absent.
 */
function isAbsentSession(error: unknown): boolean {
  return error instanceof SessionPersistenceNotFoundError
    || (error as { name?: unknown } | null)?.name === 'SessionPersistenceNotFoundError'
}

/**
 * Whether an error from `ctx.agents.create` means "this id already exists",
 * thrown from two layers: the disk layer
 * (`SessionAlreadyExistsError`, `packages/session/session-persistence-jsonl/src/index.ts:317`)
 * and the in-memory store's plain `Error` (`session "<id>" already exists`,
 * `packages/core/session/src/index.ts:1009`).
 *
 * Both map onto the adopt branch rather than a 5xx: the caller asked for a
 * deterministic id, so a lost race means the session it wanted now exists.
 * @param error - the rejection.
 * @returns true when the id is occupied.
 */
function isOccupiedSession(error: unknown): boolean {
  if (error instanceof SessionAlreadyExistsError) return true
  if ((error as { name?: unknown } | null)?.name === 'SessionAlreadyExistsError') return true
  return error instanceof Error && /^session ".*" already exists$/u.test(error.message)
}

/** Resolved agent route, or one machine-readable reason the request is refused. */
export type RouteResolution =
  | { readonly ok: true; readonly value: { readonly provider: string; readonly model: string } }
  | { readonly ok: false; readonly error: string }

/**
 * Resolve the session's complete model route, fail closed.
 *
 * Both `provider` AND `model` are mandatory: the agent loop refuses to run a turn
 * on a session missing either (`agent "<id>" has no provider/model`), so a route
 * carrying only one half is no route at all. `request.model` therefore
 * carries the full `provider/model` route, split on the FIRST `/` — provider ids
 * never contain one and model ids may.
 *
 * A single-token `request.model` is REFUSED rather than guessed: no service here
 * knows which provider owns an arbitrary model id, and guessing is exactly the
 * silent-wrong-route defect this resolver exists to close.
 *
 * The post-resolution blank check is the safety net: it makes the
 * `prompt variable "{{model}}" has no value` crash unreachable, because a session
 * whose route is incomplete is never created at all.
 * @param ctx - host context carrying the live `agentDefaultModel` service.
 * @param request - validated request; `model` is absent when the caller wants the default.
 * @returns the complete route, or one machine-readable reason.
 */
export function resolveModelRoute(ctx: Context, request: StartRequest): RouteResolution {
  // Blank is "absent", not a route: a blank value would otherwise travel to the
  // prompt template, which then dies on an empty `{{model}}` after a green 200.
  const route = request.model?.trim() ?? ''
  if (route === '') {
    const selected = ctx.agentDefaultModel.currentSelection()
    return checkRoute(selected.provider, selected.model)
  }

  const separator = route.indexOf('/')
  if (separator <= 0) {
    return {
      ok: false,
      error: 'model must name a provider and a model as "provider/model"'
        + ` (got ${JSON.stringify(route)}); omit model to use the host default`,
    }
  }
  return checkRoute(route.slice(0, separator).trim(), route.slice(separator + 1).trim())
}

/**
 * Require both halves of a route to be usable.
 *
 * A blank half is never a route the loop can run, so it is refused here with the
 * fix named, instead of creating a session whose every turn dies.
 * @param provider - candidate provider id.
 * @param model - candidate model id.
 * @returns the route, or one machine-readable reason.
 */
function checkRoute(provider: string, model: string): RouteResolution {
  if (provider === '' || model === '') {
    const missing = provider === '' ? 'provider' : 'model'
    return {
      ok: false,
      error: `no ${missing} is available for this session: set "dsh.model" as "provider/model" in the debate provider config, `
        + 'or give the host a default model (agent-default-model provider/model)',
    }
  }
  return { ok: true, value: { provider, model } }
}

/**
 * Create the per-plugin session table.
 * @param log - warning sink for rollback failures and follow-up rejections.
 * @returns the table; the owner must call {@link DebateSessions.dispose}.
 */
export function createDebateSessions(log: SessionLog): DebateSessions {
  const watches = new Map<SessionId, SessionWatch>()

  /**
   * Begin recording status edges for one Agent, at most once per session id.
   *
   * Registration happens BEFORE the first `followup` so the `running` edge that
   * follow-up triggers cannot be missed, and the seed is the Agent's own
   * current status — an edge we observed late, not an elapsed-time guess.
   * @param agent - the live Agent to watch.
   */
  const watch = (agent: Agent): void => {
    const id = agent.session.id
    if (watches.has(id)) return
    const record: SessionWatch = {
      idle: agent.status === 'idle',
      lastActivityAt: new Date().toISOString(),
      dispose: () => {},
    }
    // Registered on the AGENT's own context so Cordis' scope filter delivers
    // only this agent's transitions, and so the listener unwinds with it.
    record.dispose = agent.ctx.on('agent/status', ({ status }) => {
      record.idle = status === 'idle'
      record.lastActivityAt = new Date().toISOString()
    })
    watches.set(id, record)
  }

  /** Admit one user turn carrying the request's prompt. Always the LAST step of a branch. */
  const prompt = (agent: Agent, request: StartRequest): void => {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: request.prompt }],
      source: {
        kind: DEBATE_OPPONENT_SOURCE_KIND,
        debateId: request.debateId,
        form: 'notice',
        summary: boundContextSummary(`Opponent turn admitted for debate ${request.debateId}`),
      },
    }))
  }

  /**
   * Create the session, in the exact order the preset step requires.
   *
   * `meta.cwd` comes from the `Workspace` just created, never the raw request
   * string: `attachSession` compares resolved directories
   * (`packages/workspace/workspace/src/types.ts:68-79`).
   *
   * The `permissionPresets.set` call is MANDATORY and fails SILENTLY if omitted:
   * without it the session is live on the default `workspace-write` /
   * `approval: 'ask'` preset, the sidebar row appears, the id is returned and
   * persisted, everything looks healthy — and the unattended Opponent never
   * acts. It is applied AFTER `session/created` fires, which is why
   * `followup()` stays last and keeps that window harmless.
   * @param ctx - host context.
   * @param sessionId - the chosen identity.
   * @param input - validated request plus resolved preset id.
   * @returns the session id.
   */
  const create = async (
    ctx: Context,
    sessionId: SessionId,
    input: OpenSessionInput,
  ): Promise<SessionId> => {
    const { request, agentPresetId, permissionPreset, modelRoute } = input
    const workspace = await ctx.workspaceRegistry.create(request.workspacePath)
    let handle: AgentHandle | undefined
    let attached = false
    try {
      handle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd: workspace.path,
          ...agentPresetId === undefined ? {} : { agentPreset: agentPresetId },
        },
        agentOptions: { provider: modelRoute.provider, model: modelRoute.model },
      })
      await workspace.attachSession(sessionId)
      attached = true
      ctx.permissionPresets.set(handle.agent.session, permissionPreset)
      ctx.sessionTitle.rename(handle.agent.session, buildSessionTitle(request.title))
      watch(handle.agent)
      prompt(handle.agent, request)
      return sessionId
    } catch (error: unknown) {
      // Roll back exactly what was created, and never let a rollback failure
      // replace the operation's original failure.
      if (handle !== undefined) {
        if (attached) {
          try {
            await workspace.detachSession(sessionId)
          } catch (rollbackError: unknown) {
            log.warn(`dsh-debate-bridge: workspace detach for "${sessionId}" failed: ${errorChain(rollbackError)}`)
          }
        }
        try {
          await handle.dispose()
        } catch (rollbackError: unknown) {
          log.warn(`dsh-debate-bridge: agent disposal for "${sessionId}" failed: ${errorChain(rollbackError)}`)
        }
      }
      throw error
    }
  }

  return {
    async open(ctx, input) {
      const { request } = input
      // A caller-supplied id is honoured so a persisted id from an earlier
      // scheme can still be adopted; in practice it equals the derived one.
      const sessionId = brandString<SessionId>(request.sessionId ?? deriveSessionId(request.debateId))

      // Branch 1 — a live session for this debate: skip creation and admit the
      // turn. This branch IS the idle-recovery nudge: the provider re-POSTs the
      // start verb with the same id and a different prompt, and lands here.
      const live = ctx.agents.get(sessionId)
      if (live !== undefined) {
        watch(live)
        prompt(live, request)
        return sessionId
      }

      // Branch 2 — a cold-but-persisted session: a live `get()` cannot see it,
      // and `create` would throw from the disk layer, so resume it. The route is
      // passed here too: `resume` rebuilds the loop, which needs it just as much
      // as `create` does.
      try {
        const handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: { provider: input.modelRoute.provider, model: input.modelRoute.model },
        })
        watch(handle.agent)
        prompt(handle.agent, request)
        return sessionId
      } catch (error: unknown) {
        if (!isAbsentSession(error)) throw error
      }

      // Branch 3 — no session at all.
      try {
        return await create(ctx, sessionId, input)
      } catch (error: unknown) {
        // A concurrent open won the residual race (there is no atomic
        // check-and-insert in `SessionStore.prepare`): adopt the winner.
        if (!isOccupiedSession(error)) throw error
        const winner = ctx.agents.get(sessionId)
        if (winner === undefined) throw error
        watch(winner)
        prompt(winner, request)
        return sessionId
      }
    },

    stop(ctx, sessionId) {
      const id = brandString<SessionId>(sessionId)
      const agent = ctx.agents.get(id)
      // Already gone is a success for the caller's intent, not an error.
      if (agent === undefined) return false
      agent.cancel({ kind: 'user' })
      return true
    },

    status(ctx, sessionId) {
      const id = brandString<SessionId>(sessionId)
      const record = watches.get(id)
      const lastActivityAt = record?.lastActivityAt ?? null
      const agent = ctx.agents.get(id)
      if (agent === undefined) return { live: false, idle: false, lastActivityAt }
      return {
        live: true,
        // Fall back to the Agent's own status when this mount holds no watch
        // (a session created before a plugin reload): still an edge read of the
        // driver's real state, never an elapsed-time inference.
        idle: record?.idle ?? agent.status === 'idle',
        lastActivityAt,
      }
    },

    dispose() {
      for (const record of watches.values()) record.dispose()
      watches.clear()
    },
  }
}
