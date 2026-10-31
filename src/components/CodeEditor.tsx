import { useEffect, useRef } from 'react'
import type { ChangeSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

import { changedRange } from '../lib/textChange'
import type { FileReveal } from '../lib/types'
import type { ConflictLabels } from './conflictMarkers'

/** CodeMirror 6, loaded on first use.
 *
 * The theme is expressed entirely in `var(--…)` values, so the editor tracks
 * the app's theme with no re-initialisation — including its syntax colours,
 * which map Lezer tags onto the same `--syn-*` tokens the read-only viewer
 * and the diffs use.
 */

interface Props {
  value: string
  path: string
  onChange: (value: string) => void
  onSave: () => void
  readOnly?: boolean
  /** A spot to select and scroll to, e.g. a search result's line. */
  reveal?: FileReveal
  /** The buttons on merge conflicts; without labels, conflicts are not marked. */
  conflictLabels?: ConflictLabels
  /** Bumped to open the search panel (⌘F reaches the app menu, not the editor). */
  findNonce?: number
  wordWrap?: boolean
}

export function CodeEditor({
  value, path, onChange, onSave, readOnly, reveal, conflictLabels, findNonce, wordWrap,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  /** Applies text from outside the editor; set up with it. */
  const applyExternalRef = useRef<((view: EditorView, changes: ChangeSpec) => void) | null>(null)
  const wordWrapRef = useRef(wordWrap)
  wordWrapRef.current = wordWrap
  /** Turns wrapping on or off; set up with the editor. */
  const setWrappingRef = useRef<((view: EditorView, on: boolean) => void) | null>(null)
  // The callbacks are read through refs so the editor is built once per file
  // rather than torn down whenever the parent re-renders.
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  const revealRef = useRef(reveal)
  revealRef.current = reveal
  const conflictLabelsRef = useRef(conflictLabels)
  conflictLabelsRef.current = conflictLabels
  /** The request last carried out, so a later re-render does not jump back. */
  const revealedRef = useRef<number | null>(null)
  /** CodeMirror's view class, loaded with the editor, for its scroll effect. */
  const viewClassRef = useRef<typeof EditorView | null>(null)
  /** The search command, loaded with the editor. */
  const openSearchRef = useRef<((view: EditorView) => boolean) | null>(null)
  const findNonceRef = useRef(findNonce)
  findNonceRef.current = findNonce
  /** The find request last carried out, as with reveal above. */
  const foundRef = useRef<number | undefined>(undefined)

  const openFindNow = () => {
    const view = viewRef.current
    const nonce = findNonceRef.current
    if (!view || !openSearchRef.current || !nonce || foundRef.current === nonce) return
    foundRef.current = nonce
    openSearchRef.current(view)
  }

  const revealNow = () => {
    const view = viewRef.current
    const target = revealRef.current
    const View = viewClassRef.current
    if (!view || !View || !target || revealedRef.current === target.nonce) return
    revealedRef.current = target.nonce
    const doc = view.state.doc
    const line = doc.line(Math.min(Math.max(1, target.line), doc.lines))
    const from = Math.min(line.from + target.column, line.to)
    const to = Math.min(from + target.length, line.to)
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: View.scrollIntoView(from, { y: 'center' }),
    })
    view.focus()
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false

    void (async () => {
      const [
        { Annotation, Compartment, EditorState, Prec, Transaction },
        { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor },
        { defaultKeymap, history, historyKeymap, indentWithTab },
        { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap },
        { searchKeymap, highlightSelectionMatches, openSearchPanel },
        { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap },
        { tags },
        { conflictMarkers },
        { languageFor },
      ] = await Promise.all([
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/commands'),
        import('@codemirror/language'),
        import('@codemirror/search'),
        import('@codemirror/autocomplete'),
        import('@lezer/highlight'),
        import('./conflictMarkers'),
        import('../lib/editorLanguage'),
      ])
      if (disposed) return

      const language = await languageFor(path)
      if (disposed) return

      const theme = EditorView.theme(
        {
          '&': {
            color: 'var(--fg)',
            backgroundColor: 'var(--bg)',
            height: '100%',
            fontSize: 'var(--code-size, 12.5px)',
          },
          '.cm-content': {
            fontFamily: 'var(--font-mono)',
            padding: '6px 0',
            caretColor: 'var(--accent-strong)',
          },
          '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
          '.cm-gutters': {
            backgroundColor: 'var(--bg)',
            color: 'var(--fg-subtle)',
            border: 'none',
            borderRight: '1px solid var(--border)',
          },
          '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)', color: 'var(--fg-muted)' },
          '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--bg-hover) 55%, transparent)' },
          '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent-strong)' },
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
            backgroundColor: 'var(--bg-selected)',
          },
          '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
          '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
            backgroundColor: 'color-mix(in srgb, var(--accent) 26%, transparent)',
            outline: 'none',
          },
          '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--yellow) 34%, transparent)' },
          '.cm-tooltip': {
            backgroundColor: 'var(--bg-raised)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)',
          },
          '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
            backgroundColor: 'var(--bg-active)',
            color: 'var(--fg)',
          },
          // Search / replace panel
          '.cm-panel': {
            backgroundColor: 'var(--bg-raised)',
            borderTop: '1px solid var(--border)',
            padding: '6px 8px',
          },
          '.cm-panel.cm-search': {
            display: 'flex',
            flexWrap: 'wrap',
            gap: '4px',
            alignItems: 'center',
          },
          '.cm-panel input[type="text"], .cm-panel input:not([type])': {
            backgroundColor: 'var(--bg-inset)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--fg)',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            padding: '2px 6px',
            outline: 'none',
          },
          '.cm-panel input[type="text"]:focus, .cm-panel input:not([type]):focus': {
            borderColor: 'var(--accent)',
          },
          '.cm-panel input[type="checkbox"]': {
            accentColor: 'var(--accent)',
          },
          '.cm-panel button': {
            backgroundColor: 'var(--bg-inset)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--fg)',
            cursor: 'pointer',
            fontSize: '12px',
            padding: '2px 8px',
          },
          '.cm-panel button:hover': {
            backgroundColor: 'var(--bg-hover)',
          },
          '.cm-panel button[name="close"]': {
            background: 'none',
            border: 'none',
            color: 'var(--fg-muted)',
            padding: '0 4px',
          },
          '.cm-panel label': {
            color: 'var(--fg-muted)',
            fontSize: '11.5px',
            display: 'flex',
            alignItems: 'center',
            gap: '3px',
          },
          '.cm-searchMatch.cm-searchMatch-selected': {
            backgroundColor: 'color-mix(in srgb, var(--yellow) 60%, transparent)',
          },
        },
        { dark: true },
      )

      const highlight = HighlightStyle.define([
        { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
        { tag: [tags.keyword, tags.modifier, tags.self], color: 'var(--syn-keyword)' },
        { tag: [tags.controlKeyword, tags.moduleKeyword], color: 'var(--syn-control)' },
        { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
        { tag: [tags.number, tags.bool, tags.null], color: 'var(--syn-number)' },
        {
          tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
          color: 'var(--syn-function)',
        },
        {
          tag: [tags.typeName, tags.className, tags.namespace, tags.definition(tags.typeName)],
          color: 'var(--syn-type)',
        },
        { tag: [tags.variableName, tags.propertyName], color: 'var(--syn-variable)' },
        {
          tag: [tags.constant(tags.variableName), tags.standard(tags.variableName)],
          color: 'var(--syn-constant)',
        },
        { tag: tags.tagName, color: 'var(--syn-tag)' },
        { tag: tags.attributeName, color: 'var(--syn-attr)' },
        { tag: tags.regexp, color: 'var(--syn-regexp)' },
        { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--syn-operator)' },
        { tag: [tags.meta, tags.processingInstruction], color: 'var(--syn-meta)' },
        { tag: tags.heading, fontWeight: '600', color: 'var(--syn-keyword)' },
        { tag: tags.emphasis, fontStyle: 'italic' },
        { tag: tags.strong, fontWeight: '600' },
        { tag: tags.link, textDecoration: 'underline', color: 'var(--syn-constant)' },
        { tag: tags.strikethrough, textDecoration: 'line-through' },
        { tag: tags.invalid, color: 'var(--red)' },
      ])

      const external = Annotation.define<boolean>()
      const wrapping = new Compartment()
      const wrap = (on?: boolean) => (on ? EditorView.lineWrapping : [])
      const state = EditorState.create({
        // The text may have changed while the editor was loading.
        doc: valueRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          foldGutter(),
          history(),
          drawSelection(),
          rectangularSelection(),
          crosshairCursor(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightSelectionMatches(),
          syntaxHighlighting(highlight),
          theme,
          language ? [language] : [],
          wrapping.of(wrap(wordWrapRef.current)),
          conflictLabelsRef.current ? conflictMarkers(conflictLabelsRef.current) : [],
          EditorState.readOnly.of(!!readOnly),
          EditorView.editable.of(!readOnly),
          // On Windows AltGr arrives as Ctrl+Alt, and CodeMirror looks a key up
          // by its typed character first, so AltGr+è (an Italian "[") ran
          // fold-all (Ctrl-Alt-[) instead of typing, and a German AltGr "\"
          // re-indented. A character typed through AltGr is text: claim the
          // key so no binding runs and let the browser type it. A deliberate
          // left Ctrl+Alt is not AltGraph and still reaches the bindings.
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (e) => e.key.length === 1 && e.getModifierState('AltGraph'),
            }),
          ),
          keymap.of([
            // Save must win over anything the browser or CodeMirror would do.
            { key: 'Mod-s', preventDefault: true, run: () => (onSaveRef.current(), true) },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((u) => {
            // Text from outside is not an edit, and reporting it back would
            // make it one: the editor holds line ends as \n, so a CRLF file
            // would come back different from the disk.
            if (!u.docChanged || u.transactions.some((tr) => tr.annotation(external))) return
            onChangeRef.current(u.state.doc.toString())
          }),
        ],
      })

      viewRef.current = new EditorView({ state, parent: host })
      viewClassRef.current = EditorView
      openSearchRef.current = openSearchPanel
      // Out of the undo history, so undoing cannot take back an agent's edit.
      applyExternalRef.current = (view, changes) =>
        view.dispatch({ changes, annotations: [external.of(true), Transaction.addToHistory.of(false)] })
      setWrappingRef.current = (view, on) =>
        view.dispatch({ effects: wrapping.reconfigure(wrap(on)) })
      revealNow()
      openFindNow()
    })()

    return () => {
      disposed = true
      viewRef.current?.destroy()
      viewRef.current = null
    }
    // Rebuilt only when the file itself changes; `value` is synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly])

  // External changes (a reload from disk) replace only what differs, so the
  // view stays where it is, and do not disturb the user simply typing.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    const next = value.replace(/\r\n?/g, '\n')
    if (current !== next) applyExternalRef.current?.(view, changedRange(current, next))
  }, [value])

  useEffect(() => {
    if (viewRef.current) setWrappingRef.current?.(viewRef.current, !!wordWrap)
  }, [wordWrap])

  // A new request on an editor that already exists; a first one is carried
  // out as the editor is built.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => revealNow(), [reveal?.nonce])

  // Opening the panel again moves the cursor back into its field and takes
  // the current selection as the term, as ⌘F does in an editor.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => openFindNow(), [findNonce])

  return <div ref={hostRef} className="editor" />
}
