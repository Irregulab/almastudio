/**
 * A menu an agent waits on — a permission prompt, a question with options —
 * read off the screen: numbered lines, one of them pointed at. The app shows
 * arrow keys for it while it is up.
 */
export interface Choice {
  options: string[]
  selected: number
}

const POINTER = /^[❯›>▶➤→]$/
const OPTION = /^\s*(?:[│┃|]\s*)?([❯›>▶➤→])?\s*(\d{1,2})[.)]\s+(.*?)\s*(?:[│┃|]\s*)?$/

export function findChoice(lines: string[]): Choice | null {
  // The pointed-at option nearest the bottom: the menu in front.
  let at = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = OPTION.exec(lines[i])
    if (m?.[1] && POINTER.test(m[1])) {
      at = i
      break
    }
  }
  if (at < 0) return null
  const parse = (i: number) => {
    const m = OPTION.exec(lines[i])
    return m ? { n: Number(m[2]), label: m[3], pointed: !!m[1] } : null
  }
  const found = new Map<number, string>()
  const first = parse(at)!
  found.set(first.n, first.label)
  // Walk away from it both ways, over wrapped descriptions, while the
  // numbers keep counting.
  for (const dir of [-1, 1]) {
    let expect = first.n + dir
    let gap = 0
    for (let i = at + dir; i >= 0 && i < lines.length && gap <= 3; i += dir) {
      const o = parse(i)
      if (o && o.n === expect && !o.pointed) {
        found.set(o.n, o.label)
        expect += dir
        gap = 0
      } else if (o) {
        break
      } else {
        gap++
      }
    }
  }
  if (found.size < 2) return null
  const numbers = [...found.keys()].sort((a, b) => a - b)
  return { options: numbers.map((n) => found.get(n)!), selected: numbers.indexOf(first.n) }
}
