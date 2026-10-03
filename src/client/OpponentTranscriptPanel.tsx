/**
 * The Opponent transcript footer.
 *
 * A collapsed-by-default panel at the bottom of the conversation column, showing
 * the running Opponent harness's own output — the same buffer `debate-web`
 * renders in its terminal. It is a pure props consumer: it holds no `ctx`, opens
 * no read and owns no timer, so every state it can draw is reachable from a test
 * or a story without a live Opponent.
 *
 * Its imports are React and `ui-primitives` and nothing else: core ships no
 * transcript renderer, and a feature plugin may not import another feature
 * plugin's values, so the line list is this plugin's own markup.
 *
 * Deliberately NOT a terminal emulator. The stream is decoded NDJSON, not a PTY
 * byte stream, so ANSI is stripped upstream and every line is drawn as text:
 * unrecognised content degrades to plain text rather than to a parse failure.
 *
 * @module dsh-debate-bridge/client/OpponentTranscriptPanel
 */
import { useEffect, useRef, type ReactElement } from 'react'
import { IconChevronRightOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'

import type { TranscriptLine } from './lib/transcript-buffer.ts'

/**
 * Distance from the bottom, in pixels, still counted as "pinned".
 *
 * A user who scrolled up to read must not be yanked back by every poll, so
 * auto-scroll is armed only while the body was already at the end.
 */
const PIN_THRESHOLD_PX = 24

/** What the panel draws; every string arrives already translated. */
export interface OpponentTranscriptPanelProps {
  /** Whether the body is expanded. */
  readonly open: boolean
  /** Toggle the body. */
  readonly onToggle: () => void
  /** The Opponent provider this output belongs to, as the wire spells it. */
  readonly harnessLabel: string
  /** Whether output has arrived recently enough to read as a live stream. */
  readonly live: boolean
  /** The retained lines, oldest first. */
  readonly lines: readonly TranscriptLine[]
  /** Shown in the body when no line has arrived yet. */
  readonly emptyLabel: string
  /** Secondary header chrome: how much output there is, or how the read went. */
  readonly statusLabel: string
}

/**
 * Render the Opponent transcript footer.
 * @param props - the panel's whole state, described by {@link OpponentTranscriptPanelProps}.
 * @returns the collapsed header, and the body when open.
 */
export function OpponentTranscriptPanel(props: OpponentTranscriptPanelProps): ReactElement {
  const body = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)

  // Follow the newest line, but only while the body was already at the end.
  useEffect(() => {
    const element = body.current
    if (element === null) return
    if (pinned.current) element.scrollTop = element.scrollHeight
  }, [props.open, props.lines])

  return (
    <section className="dda-provider" data-open={props.open}>
      <button
        type="button"
        className="dda-provider-head"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <span className="dda-provider-chevron" data-open={props.open}>
          <IconChevronRightOutlineRegular />
        </span>
        <span className="dda-provider-title">{props.harnessLabel}</span>
        {/* `aria-hidden` by contract: the dot is decoration, the status text
            beside it carries the meaning. */}
        {props.live && <StateDot state="ongoing" />}
        <span className="dda-provider-status">{props.statusLabel}</span>
      </button>
      {props.open && (
        <div
          className="dda-provider-body"
          ref={body}
          onScroll={(event) => {
            const element = event.currentTarget
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight <= PIN_THRESHOLD_PX
          }}
        >
          {props.lines.length === 0
            ? <p className="dda-provider-empty">{props.emptyLabel}</p>
            : props.lines.map(line => (
                <span key={line.key} className="dda-provider-line" data-type={line.type}>{line.text}</span>
              ))}
        </div>
      )}
    </section>
  )
}
