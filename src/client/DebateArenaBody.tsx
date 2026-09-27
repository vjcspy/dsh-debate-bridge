/**
 * The Debate Arena tab body: the arena list beside the selected debate's
 * transcript.
 *
 * A pure props consumer. Live data arrives through framework hooks — the
 * attachment through the registration's bound `useDebateAttach`, the manual pick
 * through `useStore`/`actions`, the tab's own visibility through `useTabInfo` —
 * and everything else is local state. The component never sees `ctx` and holds no
 * subscription machinery of its own.
 *
 * The transcript renders the debate server's own content verbatim as pre-wrapped
 * text. That is deliberate: the content is markdown, and this half owns no
 * markdown renderer (the conversation's belongs to another UI domain and must not
 * be imported), so rendering it as source is honest where a half-parsed subset
 * would not be.
 *
 * @module dsh-debate-bridge/client/DebateArenaBody
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Button, StateDot, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

import { DETAIL_POLL_INTERVAL_MS, LOCALE_NAMESPACE } from '../config.ts'
import type { DebateAttachmentSnapshot } from './attach-watch.ts'
import {
  fetchArena,
  fetchDebate,
  type ArenaPage,
  type DebateEntry,
  type DebateRow,
  type DebateTranscript,
  type TransportFailure,
} from './lib/debate-api.ts'
import { resolveSelectedDebate, type ManualPick, type createDebateSelectionStore } from './selection-store.ts'
import { ARENA_ROOT_VALUE } from './styles.ts'

/** What this registration injects: the Host's attachment as a bare observable. */
export interface DebateArenaInjected {
  hooks: { debateAttach: ObservableSnapshot<DebateAttachmentSnapshot> }
}

/**
 * The component's props, derived from its registration: the slot's runtime
 * share, the declared store, the inject face with its hooks compartment bound,
 * and the declared locale namespace.
 */
export type DebateArenaBodyProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createDebateSelectionStore>>
  & InjectFace<DebateArenaInjected>
  & PropsLocale<typeof LOCALE_NAMESPACE>

/**
 * The tag tone a debate state reads as.
 * @param state - the server's own state token.
 * @returns the tone that token is drawn with.
 */
function stateTone(state: string): TagTone {
  if (state === 'CLOSED' || state === 'COMPLETED') return 'neutral'
  if (state === 'AWAITING_OPPONENT' || state === 'AWAITING_PROPOSER') return 'info'
  if (state === 'ERROR' || state === 'FAILED') return 'danger'
  return 'outline'
}

/**
 * The one-line account of a failed read.
 * @param failure - the read's failure.
 * @param t - the namespace-bound translate seat.
 * @returns the title and detail to show.
 */
function failureText(
  failure: TransportFailure,
  t: DebateArenaBodyProps['t'],
): { readonly title: string; readonly detail: string } {
  if (failure.status === 401 || failure.status === 403) {
    return { title: t('state.unauthorized.title'), detail: t('state.unauthorized.detail', { status: failure.status }) }
  }
  if (failure.status === 404) {
    return { title: t('state.gone.title'), detail: t('state.gone.detail') }
  }
  return { title: t('state.failed.title'), detail: t('state.failed.detail', { message: failure.message }) }
}

/**
 * Render one entry of the transcript.
 *
 * `type` and `role` are drawn as the wire tokens they are, so a Human can read
 * the board against `debate-web` without translating anything.
 * @param props.entry - the motion or argument to draw.
 * @returns the entry element.
 */
function TranscriptEntry({ entry }: { entry: DebateEntry }): ReactElement {
  return (
    <article className="dda-entry" data-role={entry.role}>
      <header className="dda-entry-head">
        <Tag tone={entry.type === 'RESOLUTION' ? 'success' : 'outline'}>{entry.type}</Tag>
        <span>{entry.role}</span>
        <span>#{entry.seq}</span>
        <span>{entry.createdAt}</span>
      </header>
      <div className="dda-entry-body">{entry.content}</div>
    </article>
  )
}

/**
 * Render one read's failure.
 * @param props.failure - the failure.
 * @param props.t - the translate seat.
 * @returns the failure block.
 */
function FailureState({ failure, t }: { failure: TransportFailure; t: DebateArenaBodyProps['t'] }): ReactElement {
  const text = failureText(failure, t)
  return (
    <div className="dda-state">
      <StateDot state="error" />
      <p className="dda-state-title">{text.title}</p>
      <p className="dda-state-detail">{text.detail}</p>
    </div>
  )
}

/**
 * Render the Debate Arena tab.
 * @param props - the derived props shares described by {@link DebateArenaBodyProps}.
 * @returns the arena list and the selected debate's transcript.
 */
export function DebateArenaBody(props: DebateArenaBodyProps): ReactElement {
  const { t, sessionId } = props
  const tab = props.useTabInfo()
  const visible = tab.tab.visible

  const manual = props.useStore(state => state.manual[sessionId] as ManualPick | undefined)
  // Keyed to the Session this body is registered for: during a Session switch the
  // watcher may still hold the previous Session's attachment, and drawing it here
  // would briefly show another conversation's debate.
  const attachment = props.useDebateAttach(snapshot => snapshot.sessionId === sessionId ? snapshot.debateId : null)
  const selected = useMemo(
    () => resolveSelectedDebate({ sessionId, manual, attachment }),
    [sessionId, manual, attachment],
  )

  const [arena, setArena] = useState<ArenaPage | undefined>(undefined)
  const [arenaFailure, setArenaFailure] = useState<TransportFailure | undefined>(undefined)
  const [transcript, setTranscript] = useState<DebateTranscript | undefined>(undefined)
  const [transcriptFailure, setTranscriptFailure] = useState<TransportFailure | undefined>(undefined)
  const [reloadToken, setReloadToken] = useState(0)
  const scroller = useRef<HTMLDivElement | null>(null)

  // The arena list is polled too, not only fetched once: a debate created while
  // the tab is already open would otherwise never appear in it.
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    const read = async (): Promise<void> => {
      const result = await fetchArena(0, controller.signal)
      if (controller.signal.aborted) return
      if (result.ok) {
        setArena(result.value)
        setArenaFailure(undefined)
      } else {
        setArenaFailure(result.failure)
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, DETAIL_POLL_INTERVAL_MS)
    return () => { controller.abort(); clearInterval(timer) }
  }, [visible, reloadToken])

  // Polled only while the tab is visible: a hidden tab skips its reads.
  useEffect(() => {
    if (!visible || selected === undefined) {
      setTranscript(undefined)
      setTranscriptFailure(undefined)
      return
    }
    const controller = new AbortController()
    const read = async (): Promise<void> => {
      const result = await fetchDebate(selected, controller.signal)
      if (controller.signal.aborted) return
      if (result.ok) {
        setTranscript(result.value)
        setTranscriptFailure(undefined)
      } else {
        setTranscriptFailure(result.failure)
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, DETAIL_POLL_INTERVAL_MS)
    return () => { controller.abort(); clearInterval(timer) }
  }, [visible, selected, reloadToken])

  // Pin the transcript to its newest argument. Auto-scrolling on every content
  // change makes the scroll offset lost by the `keepMounted: false` unmount moot.
  const newest = transcript === undefined
    ? undefined
    : transcript.entries[transcript.entries.length - 1]?.id ?? transcript.motion?.id
  useEffect(() => {
    const element = scroller.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
  }, [newest, selected])

  const refresh = useCallback(() => { setReloadToken(token => token + 1) }, [])
  const choose = useCallback((debateId: string) => {
    props.actions.choose(sessionId, debateId, attachment)
  }, [props.actions, sessionId, attachment])

  return (
    <div data-dsh-debate={ARENA_ROOT_VALUE}>
      <div className="dda-split">
        <section className="dda-arena">
          <header className="dda-head">
            <h2 className="dda-head-title">{t('arena.heading')}</h2>
            <span className="dda-count">{t('arena.total', { total: arena?.total ?? 0 })}</span>
            <Button size="sm" variant="ghost" onClick={refresh}>{t('action.refresh')}</Button>
          </header>
          {arenaFailure !== undefined && <FailureState failure={arenaFailure} t={t} />}
          {arena !== undefined && arena.debates.length === 0 && (
            <div className="dda-state">
              <p className="dda-state-title">{t('arena.empty.title')}</p>
              <p className="dda-state-detail">{t('arena.empty.detail')}</p>
            </div>
          )}
          <ul className="dda-list">
            {arena?.debates.map((row: DebateRow) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="dda-row"
                  data-selected={row.id === selected}
                  onClick={() => { choose(row.id) }}
                >
                  <span className="dda-row-title">{row.title}</span>
                  <span className="dda-row-meta">
                    <Tag tone={stateTone(row.state)}>{row.state}</Tag>
                    <span>{row.updatedAt}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="dda-detail">
          <header className="dda-head">
            <h2 className="dda-head-title">{t('transcript.heading')}</h2>
            <span className="dda-count">
              {transcript === undefined ? '' : t('transcript.count', { count: transcript.entries.length })}
            </span>
            <Button size="sm" variant="ghost" onClick={refresh}>{t('action.reload')}</Button>
          </header>
          {selected === undefined && <p className="dda-state">{t('state.noSelection')}</p>}
          {selected !== undefined && transcriptFailure !== undefined && (
            <FailureState failure={transcriptFailure} t={t} />
          )}
          {selected !== undefined && transcript === undefined && transcriptFailure === undefined && (
            <p className="dda-state">{t('state.transcriptLoading')}</p>
          )}
          {transcript !== undefined && (
            <>
              <header className="dda-head">
                <h3 className="dda-head-title">{transcript.debate.title}</h3>
                <span className="dda-row-meta">
                  <Tag tone={stateTone(transcript.debate.state)}>{transcript.debate.state}</Tag>
                  <span>
                    {t('transcript.proposer', {
                      provider: transcript.debate.proposerProvider ?? t('transcript.unknownProvider'),
                    })}
                  </span>
                  <span>
                    {t('transcript.opponent', {
                      provider: transcript.debate.opponentProvider ?? t('transcript.unknownProvider'),
                    })}
                  </span>
                </span>
              </header>
              <div className="dda-transcript" ref={scroller}>
                {transcript.motion === null ? null : <TranscriptEntry entry={transcript.motion} />}
                {transcript.entries.map(entry => <TranscriptEntry key={entry.id} entry={entry} />)}
                {transcript.entries.length === 0 && (
                  <p className="dda-state-detail">{t('transcript.empty')}</p>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
