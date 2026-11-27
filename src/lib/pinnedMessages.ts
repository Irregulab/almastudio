/**
 * Messages pinned to a terminal tab: the requests sent to Claude Code, found
 * in what the terminal shows, and any pinned text found there again.
 *
 * Claude Code draws each request in its transcript on a band of background
 * colour: the first line opens with `❯ `, the others are indented two columns
 * past it, and the lines are wrapped one column short of the terminal's
 * width. Its prompt shows the same sign with no band, so the colour is what
 * tells a request sent from one still being typed.
 */

export interface PinCell {
  chars: string
  /** 0 for the second half of a wide character. */
  width: number
  /** The background colour with its mode, as xterm encodes them; -1 when the default. */
  bg: number
}

export interface PinRow {
  cells: PinCell[]
  /** The row goes on from the one above, wrapped by the terminal itself. */
  wrapped: boolean
}

/** The buffer row `y`, or undefined past the buffer. */
export type PinRowReader = (y: number) => PinRow | undefined

/** A request on screen: its rows, `first` to `last`, and what it said. */
export interface SentMessage {
  first: number
  last: number
  text: string
}

/** Where a request's text starts, past `❯ ` or its indent. */
const INDENT = 2
/** How many rows one request may take; a longer one is not looked through. */
const MAX_MESSAGE_ROWS = 400
/** How much of a pinned text is kept. */
export const MAX_PIN_LENGTH = 4000
/** How much of a pinned selection is looked for. */
const NEEDLE_LENGTH = 40
/** How much of a long request's start has to show, when the rest is off screen. */
const MIN_PREFIX = 60
/** A selection shorter than this is only found as whole words. */
const MIN_WORDS_ALONE = 16

const SIGN = '❯'
// The prompt Claude Code is typed in follows its sign with a no-break space.
const isBlank = (c: PinCell | undefined) =>
  !c || c.chars === '' || c.chars === ' ' || c.chars === ' '

/** The same text whatever the width it was wrapped at. */
export const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

/** A row's text from column `from`, without the blanks after it. */
export function rowText(row: PinRow, from = 0): string {
  let s = ''
  for (let x = from; x < row.cells.length; x++) {
    const c = row.cells[x]
    if (c.width === 0) continue
    s += c.chars || ' '
  }
  return s.trimEnd()
}

/** The first row of a request: the sign on a coloured background, then a space. */
function isMessageStart(row: PinRow | undefined): boolean {
  const c = row?.cells[0]
  return !!c && c.chars === SIGN && c.bg !== -1 && isBlank(row?.cells[1])
}

/** A row further down the same request: its band's colour, and no sign of its own. */
function continues(row: PinRow | undefined, bg: number): boolean {
  if (!row || row.cells[0]?.chars === SIGN) return false
  return row.cells.some((c) => c.bg === bg)
}

/**
 * Joins a request's lines back into what was typed. A line Claude Code broke
 * because the next word did not fit on it ends in a space; one that was short
 * of the edge ended where the user pressed Enter.
 */
export function joinLines(lines: string[], cols: number): string {
  let text = lines[0] ?? ''
  for (let i = 1; i < lines.length; i++) {
    const before = INDENT + lines[i - 1].length
    const word = lines[i].trimStart().split(' ')[0].length
    // One column of slack: Claude Code's edge is a column short of the terminal's.
    const wrapped = before + 1 + word > cols - 2
    text += (wrapped ? ' ' : '\n') + lines[i]
  }
  return text
}

/** The request whose first row is `first`, or null when no request starts there. */
export function messageFrom(read: PinRowReader, first: number): SentMessage | null {
  const head = read(first)
  if (!head || !isMessageStart(head)) return null
  const bg = head.cells[0].bg
  let last = first
  while (last - first < MAX_MESSAGE_ROWS && continues(read(last + 1), bg)) last++
  const lines: string[] = []
  for (let y = first; y <= last; y++) lines.push(rowText(read(y)!, INDENT))
  // The band can run on a blank row past the text.
  return { first, last, text: joinLines(lines, head.cells.length).trimEnd() }
}

/** The request that row `y` is part of, or null when it is part of none. */
export function messageAt(read: PinRowReader, y: number): SentMessage | null {
  let first = y
  for (;;) {
    const row = read(first)
    if (!row) return null
    if (isMessageStart(row)) break
    // Above the band there is nothing coloured left to belong to.
    if (first === 0 || y - first >= MAX_MESSAGE_ROWS || !row.cells.some((c) => c.bg !== -1)) {
      return null
    }
    first--
  }
  const message = messageFrom(read, first)
  return message && message.last >= y ? message : null
}

/**
 * How a request on screen is the pinned one: `whole`; by `start`, when one is
 * the start of the other — a long request part of which is off screen, or
 * one longer than what was kept of it; or not at all. Only a long one goes by
 * its start, or "fix it" would be found in "fix it and the tests too".
 */
function requestMatch(shown: string, pinned: string): 'whole' | 'start' | null {
  const a = normalize(shown)
  const b = normalize(pinned)
  if (!a || !b) return null
  if (a === b) return 'whole'
  const long = a.length >= MIN_PREFIX && b.length >= MIN_PREFIX
  return long && (b.startsWith(a) || a.startsWith(b)) ? 'start' : null
}

/** Whether a request on screen is the pinned one; see `requestMatch`. */
export function sameRequest(shown: string, pinned: string): boolean {
  return requestMatch(shown, pinned) !== null
}

/**
 * The first row of the pinned request, searched for from `bottom` up to
 * `top` — the latest, when it was sent more than once, and one that is all of
 * it before one that only starts the same. Only requests are looked at: its
 * words elsewhere — Claude quoting it, say — are not it.
 */
export function findRequest(read: PinRowReader, top: number, bottom: number, text: string): number | null {
  let byStart: number | null = null
  for (let y = bottom; y >= top; y--) {
    const message = messageFrom(read, y)
    const match = message && requestMatch(message.text, text)
    if (match === 'whole') return y
    if (match === 'start') byStart ??= y
  }
  return byStart
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c)

/**
 * The row the latest occurrence of a pinned selection starts on, found by its
 * first words from `bottom` up to `top`. A short one only as words of its
 * own, so that `test` is not found in `latest`.
 */
export function findText(read: PinRowReader, top: number, bottom: number, text: string): number | null {
  const want = normalize(text)
  if (!want) return null
  const needle = want.slice(0, NEEDLE_LENGTH)
  const whole = want.length < MIN_WORDS_ALONE
  // The row below, already read: the words may run on to it.
  let below = ''
  let belowWrapped = false
  for (let y = bottom; y >= top; y--) {
    const row = read(y)
    if (!row) continue
    const here = normalize(rowText(row))
    const joined = here + (belowWrapped ? '' : ' ') + below
    for (let at = joined.indexOf(needle); at >= 0 && at < here.length; at = joined.indexOf(needle, at + 1)) {
      if (!whole || (!isWordChar(joined[at - 1]) && !isWordChar(joined[at + needle.length]))) return y
    }
    below = here
    belowWrapped = row.wrapped
  }
  return null
}

/** Where a pin is between `top` and `bottom`: a request among requests, a selection anywhere. */
export function findPinned(
  read: PinRowReader, top: number, bottom: number, pin: { text: string; selection?: boolean },
): number | null {
  return pin.selection
    ? findText(read, top, bottom, pin.text)
    : findRequest(read, top, bottom, pin.text)
}
