/**
 * The Debate Arena tab body: the selected debate's transcript, with the debate
 * list behind a rail on the right edge.
 *
 * A pure props consumer. Live data arrives through framework hooks — the
 * attachment through the registration's bound `useDebateAttach`, the manual pick
 * and the list's visibility through `useStore`/`actions`, the tab's own
 * visibility through `useTabInfo` — and everything else is local state. The
 * component never sees `ctx` and holds no subscription machinery of its own.
 *
 * The transcript renders the debate server's own content through the core
 * `MarkdownText` primitive, in its compact variant: the content is
 * model-authored Markdown, and printing it as pre-wrapped source was only ever a
 * consequence of this surface owning no renderer.
 *
 * The list is collapsed by default, because the board is opened per conversation
 * and pre-selected by the attach watcher — the conversation is what the user came
 * to read. It is forced open when the Session has no debate and no pick, since
 * the panel is the only debate picker here.
 *
 * The Opponent transcript is a second, independent footer under the transcript
 * scroller. It has exactly ONE source of truth for what it describes — the
 * transcript's own debate row — and it polls only while it is open, the tab is
 * visible, the gate passes, the debate is not `CLOSED`, and the column it lives
 * in is actually on screen.
 *
 * @module dsh-debate-bridge/client/DebateArenaBody
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  Button,
  IconChevronRightOutlineRegular,
  IconCloseOutlineRegular,
  IconFlatListOutlineRegular,
  StateDot,
  Tag,
  type MarkdownLabels,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

import {
  DETAIL_POLL_INTERVAL_MS,
  LOCALE_NAMESPACE,
  TRANSCRIPT_ENTRY_ELISION,
  TRANSCRIPT_ENTRY_MAX_CHARS,
  TRANSCRIPT_MAX_LINES,
  TRANSCRIPT_POLL_INTERVAL_MS,
  TRANSCRIPT_PROVIDER_ALLOWLIST,
  TRANSCRIPT_SINCE_BACKOFF_MS,
} from '../config.ts'
import { NARROW_MAX_WIDTH, type DebateAttachmentSnapshot } from './attach-watch.ts'
import { EntryBody } from './EntryBody.tsx'
import { OpponentTranscriptPanel } from './OpponentTranscriptPanel.tsx'
import {
  fetchArena,
  fetchDebate,
  fetchProviderOutput,
  type ArenaPage,
  type DebateEntry,
  type DebateRow,
  type DebateTranscript,
  type TransportFailure,
} from './lib/debate-api.ts'
import { createTranscriptBuffer, type TranscriptSnapshot } from './lib/transcript-buffer.ts'
import { markdownLabels } from './markdown-labels.ts'
import { resolveSelectedDebate, type ManualPick, type createDebateSelectionStore } from './selection-store.ts'
import { ARENA_ROOT_VALUE } from './styles.ts'

/**
 * Element id of the debate list panel, named by the rail toggle's
 * `aria-controls`. A constant, because `aria-controls` names the panel in both
 * states while the panel itself only exists in one.
 */
const LIST_PANEL_ID = 'dsh-debate-arena-list'

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
 * the board against `debate-web` without translating anything. Only the content
 * is Markdown and goes through the renderer.
 * @param props.entry - the motion or argument to draw.
 * @param props.labels - the locale revision's shared Markdown chrome.
 * @returns the entry element.
 */
function TranscriptEntry(
  { entry, labels }: { entry: DebateEntry; labels: MarkdownLabels },
): ReactElement {
  return (
    <article className="dda-entry" data-role={entry.role}>
      <header className="dda-entry-head">
        <Tag tone={entry.type === 'RESOLUTION' ? 'success' : 'outline'}>{entry.type}</Tag>
        <span>{entry.role}</span>
        <span>#{entry.seq}</span>
        <span>{entry.createdAt}</span>
      </header>
      <div className="dda-entry-body">
        <EntryBody content={entry.content} labels={labels} />
      </div>
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
 * @returns the selected debate's transcript, the list panel, and the rail that owns it.
 */
export function DebateArenaBody(props: DebateArenaBodyProps): ReactElement {
  const { t, sessionId } = props
  const tab = props.useTabInfo()
  const visible = tab.tab.visible

  const manual = props.useStore(state => state.manual[sessionId] as ManualPick | undefined)
  const listExpanded = props.useStore(state => state.listExpanded)
  // Keyed to the Session this body is registered for: during a Session switch the
  // watcher may still hold the previous Session's attachment, and drawing it here
  // would briefly show another conversation's debate.
  const attachment = props.useDebateAttach(snapshot => snapshot.sessionId === sessionId ? snapshot.debateId : null)
  const selected = useMemo(
    () => resolveSelectedDebate({ sessionId, manual, attachment }),
    [sessionId, manual, attachment],
  )

  // Derived from the selection and the stored preference together, once per
  // render. A Session that owns no debate and has no pick keeps the list open:
  // collapsed, the board would offer no way to choose one.
  const forcedOpen = selected === undefined
  const expanded = listExpanded || forcedOpen

  // One object per locale revision: `MarkdownText` discards its render cache on a
  // new `labels` identity, and its `memo` compares props shallowly.
  const labels = useMemo(() => markdownLabels(t), [t])

  const [arena, setArena] = useState<ArenaPage | undefined>(undefined)
  const [arenaFailure, setArenaFailure] = useState<TransportFailure | undefined>(undefined)
  const [transcript, setTranscript] = useState<DebateTranscript | undefined>(undefined)
  const [transcriptFailure, setTranscriptFailure] = useState<TransportFailure | undefined>(undefined)
  const [reloadToken, setReloadToken] = useState(0)
  const [pendingFocus, setPendingFocus] = useState(false)
  const scroller = useRef<HTMLDivElement | null>(null)
  const railToggle = useRef<HTMLButtonElement | null>(null)

  // The Opponent transcript panel. Its buffer is a ref rather than state: the
  // watermark and the accumulated lines are mutated by whichever response
  // arrives, against the buffer's CURRENT state, so an overlapping pair of reads
  // applied in either order can neither duplicate a line nor lose one.
  const providerBuffer = useRef(createTranscriptBuffer({
    maxLines: TRANSCRIPT_MAX_LINES,
    entryMaxChars: TRANSCRIPT_ENTRY_MAX_CHARS,
    elision: TRANSCRIPT_ENTRY_ELISION,
    backoffMs: TRANSCRIPT_SINCE_BACKOFF_MS,
  }))
  const [providerOpen, setProviderOpen] = useState(true)
  const [provider, setProvider] = useState<TranscriptSnapshot>(() => providerBuffer.current.snapshot())
  const [providerFailure, setProviderFailure] = useState<TransportFailure | undefined>(undefined)

  // The gate has exactly ONE source: the debate the transcript actually
  // describes. Falling back to the arena list row would be a second source of
  // truth — the list is page 0 only, so the selected debate may be absent from
  // it, and the two 3000 ms polls run out of phase and can briefly disagree on
  // `state`. Requiring the ids to agree is also what stops a stale transcript
  // (a failed detail read never clears it) from describing a newly picked debate.
  const gate = transcript !== undefined && transcript.debate.id === selected
    ? transcript.debate
    : undefined
  const gateDebateId = gate !== undefined
    && gate.state !== 'CLOSED'
    && TRANSCRIPT_PROVIDER_ALLOWLIST.includes(gate.opponentProvider ?? '')
    ? gate.id
    : undefined
  const gated = gateDebateId !== undefined
  const gateLabel = gate?.opponentProvider ?? ''

  // The arena list is polled too, not only fetched once: a debate created while
  // the tab is already open would otherwise never appear in it. The rail's count
  // reads this same snapshot, so gating the poll on the panel would leave the
  // default state advertising a number nothing refreshes.
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

  // Collapsed means no traffic, and a debate switch must never render one
  // debate's lines under another's header, so both reset the watermark and the
  // accumulated lines together. Closing is included on purpose: reopening then
  // replays the WHOLE buffer, which is what makes the panel show what happened
  // while it was shut.
  useEffect(() => {
    if (providerOpen && gated) return
    setProvider(providerBuffer.current.reset())
    setProviderFailure(undefined)
  }, [providerOpen, gated, selected])

  // The transcript loop. It runs only while the panel is open, the tab is
  // visible, the gate passes, and the column it lives in is actually on screen.
  // That last condition is `!(isNarrow() && expanded)` and NOT a bare width
  // test: the stylesheet hides `.dda-detail` in exactly one state — narrow
  // viewport AND list expanded — so at <768 px with the list collapsed the column
  // is perfectly visible and must keep streaming. `expanded` is a dependency so
  // toggling the list re-evaluates the loop, and `isNarrow()` is read per tick so
  // a resize does too.
  useEffect(() => {
    const debateId = gateDebateId
    if (!visible || !providerOpen || debateId === undefined) return
    const controller = new AbortController()
    let inFlight = false
    const read = async (): Promise<void> => {
      // Skip a tick while a read is already in flight. The host deadline is
      // 8000 ms against a 1500 ms interval, so an unguarded full replay over a
      // slow link would stack duplicate large responses.
      if (inFlight) return
      if (typeof window !== 'undefined' && window.innerWidth < NARROW_MAX_WIDTH && expanded) return
      inFlight = true
      try {
        const { since } = providerBuffer.current.request()
        const result = await fetchProviderOutput(debateId, since, controller.signal)
        if (controller.signal.aborted) return
        if (result.ok) {
          setProvider(providerBuffer.current.accept(result.value))
          setProviderFailure(undefined)
        } else {
          setProviderFailure(result.failure)
        }
      } finally {
        inFlight = false
      }
    }
    void read()
    const timer = setInterval(() => { void read() }, TRANSCRIPT_POLL_INTERVAL_MS)
    return () => { controller.abort(); clearInterval(timer) }
  }, [visible, providerOpen, gateDebateId, expanded, reloadToken])

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

  // A pick unmounts the row that was just activated, so focus would drop to
  // `body`. Moving it synchronously inside the click handler does not work: on
  // the forced-open path the rail toggle is `disabled` until the store write
  // commits, and `focus()` on a disabled button is a no-op. The intent is
  // recorded here and consumed once the panel has actually collapsed.
  useLayoutEffect(() => {
    if (!pendingFocus || expanded) return
    setPendingFocus(false)
    railToggle.current?.focus()
  }, [pendingFocus, expanded])

  const refresh = useCallback(() => { setReloadToken(token => token + 1) }, [])
  const choose = useCallback((debateId: string) => {
    props.actions.choose(sessionId, debateId, attachment)
  }, [props.actions, sessionId, attachment])
  // The pick is the moment the user stops browsing and starts reading: the list
  // yields the surface to the conversation, and focus follows the one control
  // that is still on screen.
  const pick = useCallback((debateId: string) => {
    choose(debateId)
    props.actions.setListExpanded(false)
    setPendingFocus(true)
  }, [choose, props.actions])
  const toggleList = useCallback(() => {
    props.actions.setListExpanded(!listExpanded)
  }, [props.actions, listExpanded])
  const hideList = useCallback(() => {
    props.actions.setListExpanded(false)
  }, [props.actions])

  return (
    <div data-dsh-debate={ARENA_ROOT_VALUE} data-list-expanded={expanded}>
      <div className="dda-split">
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
                {transcript.motion === null ? null : <TranscriptEntry entry={transcript.motion} labels={labels} />}
                {transcript.entries.map(entry => <TranscriptEntry key={entry.id} entry={entry} labels={labels} />)}
                {transcript.entries.length === 0 && (
                  <p className="dda-state-detail">{t('transcript.empty')}</p>
                )}
              </div>
            </>
          )}
          {/* Last child of the conversation column, and OUTSIDE the
              `transcript !== undefined` fragment above: the panel stays mounted
              while the argument transcript is loading or failed, and is absent —
              not empty — when there is no gated debate to watch. */}
          {gated && (
            <OpponentTranscriptPanel
              open={providerOpen}
              onToggle={() => { setProviderOpen(open => !open) }}
              harnessLabel={gateLabel}
              live={providerOpen && providerFailure === undefined && provider.lines.length > 0}
              lines={provider.lines}
              emptyLabel={t('transcript.panel.empty')}
              statusLabel={providerFailure !== undefined
                ? t('transcript.panel.failed', { message: providerFailure.message })
                : t('transcript.panel.lines', { count: provider.lines.length })}
            />
          )}
        </section>

        {expanded && (
          <section className="dda-arena" id={LIST_PANEL_ID}>
            <header className="dda-head">
              <h2 className="dda-head-title">{t('arena.heading')}</h2>
              <span className="dda-count">{t('arena.total', { total: arena?.total ?? 0 })}</span>
              <Button size="sm" variant="ghost" onClick={refresh}>{t('action.refresh')}</Button>
              {!forcedOpen && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<IconCloseOutlineRegular />}
                  aria-label={t('action.closeList')}
                  onClick={hideList}
                />
              )}
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
                    onClick={() => { pick(row.id) }}
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
        )}

        <div className="dda-rail">
          <Button
            ref={railToggle}
            size="sm"
            variant="ghost"
            icon={expanded ? <IconChevronRightOutlineRegular /> : <IconFlatListOutlineRegular />}
            aria-label={expanded ? t('action.hideList') : t('action.showList')}
            aria-expanded={expanded}
            aria-controls={LIST_PANEL_ID}
            disabled={forcedOpen}
            onClick={toggleList}
          />
          {/* Only while collapsed, and only from a snapshot that is still being
              refreshed: an unfetched or failed arena has no count to tell. */}
          {!expanded && arena !== undefined && arenaFailure === undefined && (
            <span className="dda-rail-count">{arena.total}</span>
          )}
        </div>
      </div>
    </div>
  )
}
