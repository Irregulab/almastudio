import { useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import type { FileDiff } from '@almastudio/protocol'
import { pairChangedLines, wordDiff } from '@almastudio/shared/src/wordDiff'
import { usePalette } from '../lib/theme'

/** A unified diff, with the words that changed inside a line marked. */
export function DiffHunks({ diff }: { diff: FileDiff }) {
  const p = usePalette()
  return (
    <View>
      {diff.hunks.map((hunk, h) => (
        <Hunk key={h} header={hunk.header} lines={hunk.lines} p={p} />
      ))}
    </View>
  )
}

function Hunk({
  header, lines, p,
}: {
  header: string
  lines: FileDiff['hunks'][number]['lines']
  p: ReturnType<typeof usePalette>
}) {
  // Removed lines and the added lines replacing them, compared word by word.
  const words = useMemo(() => {
    const pairs = pairChangedLines(lines)
    const out = new Map<number, ReturnType<typeof wordDiff>['removed']>()
    for (const [del, add] of pairs) {
      const { removed, added } = wordDiff(lines[del].content, lines[add].content)
      out.set(del, removed)
      out.set(add, added)
    }
    return out
  }, [lines])

  return (
    <View style={styles.hunk}>
      <Text style={[styles.header, { color: p.subtle, backgroundColor: p.panel }]}>{header.trim()}</Text>
      {lines.map((line, i) => {
        const add = line.origin === '+'
        const del = line.origin === '-'
        const bg = add ? p.green + '22' : del ? p.red + '22' : 'transparent'
        const strong = add ? p.green + '55' : p.red + '55'
        const segments = words.get(i)
        return (
          <View key={i} style={[styles.line, { backgroundColor: bg }]}>
            <Text style={[styles.no, { color: p.subtle }]}>{line.oldLineno ?? ''}</Text>
            <Text style={[styles.no, { color: p.subtle }]}>{line.newLineno ?? ''}</Text>
            <Text style={[styles.sign, { color: add ? p.green : del ? p.red : p.subtle }]}>
              {add ? '+' : del ? '−' : ' '}
            </Text>
            <Text style={[styles.code, { color: p.fg }]}>
              {segments
                ? segments.map((s, k) => (
                    <Text key={k} style={s.changed ? { backgroundColor: strong } : undefined}>{s.text}</Text>
                  ))
                : line.content.replace(/\n$/, '')}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  hunk: { marginBottom: 10 },
  header: { fontFamily: 'Menlo', fontSize: 11, paddingHorizontal: 10, paddingVertical: 5 },
  line: { flexDirection: 'row', alignItems: 'flex-start' },
  no: { fontFamily: 'Menlo', fontSize: 10.5, width: 30, textAlign: 'right', paddingTop: 2 },
  sign: { fontFamily: 'Menlo', fontSize: 12, width: 16, textAlign: 'center' },
  code: { fontFamily: 'Menlo', fontSize: 12, flex: 1, paddingRight: 8, lineHeight: 17 },
})
