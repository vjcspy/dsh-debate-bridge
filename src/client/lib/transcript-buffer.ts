/**
 * The transcript buffer: watermark arithmetic, text hygiene and the line window.
 *
 * Pure and framework-free — it owns no timer, no `fetch` and no React — so every
 * rule below is provable without a live Opponent. The board drives it: ask for
 * the `since` to send, hand the answer back, read the lines.
 *
 * Three rules exist because of measured behaviour, not taste:
 *
 * 1. **The watermark backs off by one millisecond.** The debate server filters
 *    with a strict `>` over raw timestamp strings, and the gated provider emits
 *    one entry per `text_delta`, so many entries legitimately share one
 *    millisecond. Asking from the newest timestamp alone silently drops that
 *    whole millisecond's siblings. The re-fetched entries are then discarded
 *    locally.
 * 2. **De-duplication is POSITIONAL, never content-keyed.** A real capture
 *    contains byte-identical entries, so a content key would eat legitimately
 *    repeated deltas (consecutive spaces, repeated `[tool] Bash` lines).
 * 3. **Ingestion reads the buffer's CURRENT state.** A response is applied when
 *    it arrives, not against a snapshot taken when its request was issued; two
 *    overlapping responses applied in either order therefore produce neither a
 *    duplicate nor a loss.
 *
 * @module dsh-debate-bridge/client/lib/transcript-buffer
 */
import type { ProviderOutputEntry } from './debate-api.ts'

/** One rendered line of the transcript. */
export interface TranscriptLine {
  /** Stable identity for the renderer; unique across the whole buffer. */
  readonly key: string
  /** The entry type this line came from, drawn as chrome. */
  readonly type: string
  /** Sanitised text: no ANSI, `\n`-separated, already clamped. */
  readonly text: string
}

/** What the board renders, and what it re-reads to know what to ask for next. */
export interface TranscriptSnapshot {
  /** Retained lines, oldest first. */
  readonly lines: readonly TranscriptLine[]
  /** The watermark the next request resumes from, or `undefined` for a replay. */
  readonly watermark: string | undefined
}

/** What one request must carry. */
export interface TranscriptRequest {
  /** Value for the upstream `since` parameter; `undefined` asks for everything. */
  readonly since: string | undefined
}

/** The transcript buffer the board holds across renders. */
export interface TranscriptBuffer {
  /** The watermark to send with the next request. */
  request(): TranscriptRequest
  /**
   * Apply one response against the buffer's current state.
   * @param entries - the decoded entries, in the order the server returned them.
   * @returns the snapshot to render.
   */
  accept(entries: readonly ProviderOutputEntry[]): TranscriptSnapshot
  /** The current snapshot, without changing anything. */
  snapshot(): TranscriptSnapshot
  /**
   * Forget the watermark and every line, so the next request replays the whole
   * buffer. Called on close, on debate change, and on unmount.
   * @returns the empty snapshot.
   */
  reset(): TranscriptSnapshot
}

/**
 * Remove ANSI CSI sequences, of which SGR is one form.
 *
 * The provider decorates tools with SGR today (`\u001b[36m` … `\u001b[0m`); the
 * wider CSI class costs nothing and also covers the cursor and erase sequences a
 * future formatter might add. Removing them here is what lets the panel render
 * as plain text instead of pulling a terminal emulator into the bundle.
 * @param text - raw provider text.
 * @returns the text with every escape sequence removed.
 */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/**
 * Normalise both `\r\n` and a lone `\r` to `\n`.
 *
 * The provider rewrites its own `\n` to `\r\n` before emitting; a lone `\r` was
 * not observed in the live capture, so handling it is defensive rather than
 * measured — but it costs one pass and removes a whole class of stale-line bugs.
 * @param text - text with either line ending.
 * @returns text separated by `\n` only.
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Clamp one entry head-and-tail to a character budget.
 *
 * Applied BEFORE any line cap, and per entry rather than per buffer: tool results
 * are emitted untruncated, so one measured entry carried 38,771 characters
 * across 451 newlines, and a line-capped buffer would evict all model prose
 * after a few file reads. Head and tail are both kept because a tool result's
 * interesting end is as often its last lines as its first.
 * @param text - sanitised entry text.
 * @param maxChars - the budget.
 * @param elision - marker inserted where the middle was dropped.
 * @returns the text, clamped if it exceeded the budget.
 */
export function clampEntry(text: string, maxChars: number, elision: string): string {
  if (text.length <= maxChars || maxChars <= 0) return text
  // The marker is part of the budget, not an addition to it.
  if (maxChars <= elision.length) return text.slice(0, maxChars)
  const budget = maxChars - elision.length
  const head = Math.ceil(budget / 2)
  const tail = budget - head
  return `${text.slice(0, head)}${elision}${tail === 0 ? '' : text.slice(-tail)}`
}

/**
 * Subtract milliseconds from a fixed-width UTC timestamp.
 *
 * `new Date().toISOString()` is the provider's own timestamp source, so every
 * value is a 24-character `YYYY-MM-DDTHH:mm:ss.sssZ` string: lexicographic order
 * equals chronological order, and re-formatting the result through
 * `toISOString()` restores the exact width the server compares against.
 * @param timestamp - an ISO timestamp.
 * @param milliseconds - how far to step back.
 * @returns the shifted timestamp, in the same shape.
 */
export function minusMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(new Date(timestamp).getTime() - milliseconds).toISOString()
}

/**
 * Create a transcript buffer.
 * @param options.maxLines - ceiling on retained lines.
 * @param options.entryMaxChars - per-entry character budget.
 * @param options.elision - marker for a clamped entry.
 * @param options.backoffMs - milliseconds subtracted to build the watermark.
 * @returns the buffer the board drives.
 */
export function createTranscriptBuffer(options: {
  readonly maxLines: number
  readonly entryMaxChars: number
  readonly elision: string
  readonly backoffMs: number
}): TranscriptBuffer {
  let lastTimestamp: string | undefined
  let consumedAtLastTimestamp = 0
  let lines: readonly TranscriptLine[] = []
  // Identity for the renderer only. Kept outside the documented state triple
  // because it is bookkeeping, not a fact about the stream.
  let minted = 0

  return {
    request: () => ({
      since: lastTimestamp === undefined
        ? undefined
        : minusMilliseconds(lastTimestamp, options.backoffMs),
    }),

    accept: (entries) => {
      // Read the CURRENT watermark: a response issued before another one landed
      // must not re-append what that one already appended.
      let skip = 0
      if (lastTimestamp !== undefined) {
        while (skip < entries.length && entries[skip]!.timestamp < lastTimestamp) skip += 1
        // Positional, not content-keyed: the first N entries still sitting on the
        // previous watermark are exactly the ones already consumed.
        let consumed = 0
        while (skip < entries.length && consumed < consumedAtLastTimestamp && entries[skip]!.timestamp === lastTimestamp) {
          skip += 1
          consumed += 1
        }
      }

      const appended: TranscriptLine[] = []
      let newest = lastTimestamp
      let atNewest = 0
      for (let index = skip; index < entries.length; index += 1) {
        const entry = entries[index]!
        // Strip first, then clamp: the budget bounds what is retained, and the
        // escapes are not text a user reads.
        const body = clampEntry(
          normalizeNewlines(stripAnsi(entry.content)),
          options.entryMaxChars,
          options.elision,
        )
        if (entry.timestamp === newest) {
          atNewest += 1
        } else {
          newest = entry.timestamp
          atNewest = 1
        }
        for (const text of body.split('\n')) {
          minted += 1
          appended.push({ key: `${String(minted)}`, type: entry.type, text })
        }
      }

      if (appended.length > 0) {
        const previous = lastTimestamp
        lastTimestamp = newest
        // How many entries on the final watermark this buffer has consumed in
        // total — the count the next positional skip needs. When the run ends on
        // the previous watermark, that millisecond gained entries since the last
        // read, so its count accumulates; otherwise the new watermark starts at
        // the entries just appended.
        consumedAtLastTimestamp = newest === previous ? consumedAtLastTimestamp + atNewest : atNewest
        const merged = [...lines, ...appended]
        lines = merged.length > options.maxLines ? merged.slice(merged.length - options.maxLines) : merged
      }
      return { lines, watermark: lastTimestamp }
    },

    snapshot: () => ({ lines, watermark: lastTimestamp }),

    reset: () => {
      lastTimestamp = undefined
      consumedAtLastTimestamp = 0
      lines = []
      return { lines, watermark: lastTimestamp }
    },
  }
}
