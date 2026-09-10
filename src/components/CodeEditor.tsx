import { useEffect, useRef } from 'react'
import type { EditorView } from '@codemirror/view'

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
}

/** Dynamic import of just the grammar this file needs. */
async function languageFor(path: string) {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  const name = (path.split(/[/\\]/).pop() ?? '').toLowerCase()

  switch (ext) {
    case 'ts': case 'mts': case 'cts':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true })
    case 'tsx':
      return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true })
    case 'jsx':
      return (await import('@codemirror/lang-javascript')).javascript({ jsx: true })
    case 'js': case 'mjs': case 'cjs':
      return (await import('@codemirror/lang-javascript')).javascript()
    case 'json': case 'jsonc': case 'json5':
      return (await import('@codemirror/lang-json')).json()
    case 'rs':
      return (await import('@codemirror/lang-rust')).rust()
    case 'py': case 'pyi':
      return (await import('@codemirror/lang-python')).python()
    case 'md': case 'markdown': case 'mdx':
      return (await import('@codemirror/lang-markdown')).markdown()
    case 'yml': case 'yaml':
      return (await import('@codemirror/lang-yaml')).yaml()
    case 'html': case 'htm': case 'vue': case 'svelte':
      return (await import('@codemirror/lang-html')).html()
    case 'css': case 'scss': case 'less': case 'sass':
      return (await import('@codemirror/lang-css')).css()
    case 'sql':
      return (await import('@codemirror/lang-sql')).sql()
    case 'c': case 'h': case 'cpp': case 'cc': case 'hpp': case 'hh':
      return (await import('@codemirror/lang-cpp')).cpp()
    case 'java':
      return (await import('@codemirror/lang-java')).java()
    case 'php':
      return (await import('@codemirror/lang-php')).php()
    case 'xml': case 'svg':
      return (await import('@codemirror/lang-xml')).xml()
    default:
      if (name.startsWith('dockerfile') || name === 'makefile') return null
      return null
  }
}

export function CodeEditor({ value, path, onChange, onSave, readOnly }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // The callbacks are read through refs so the editor is built once per file
  // rather than torn down whenever the parent re-renders.
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false

    void (async () => {
      const [
        { EditorState, Prec },
        { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor },
        { defaultKeymap, history, historyKeymap, indentWithTab },
        { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap },
        { searchKeymap, highlightSelectionMatches },
        { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap },
        { tags },
      ] = await Promise.all([
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/commands'),
        import('@codemirror/language'),
        import('@codemirror/search'),
        import('@codemirror/autocomplete'),
        import('@lezer/highlight'),
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

      const state = EditorState.create({
        doc: value,
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
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          }),
        ],
      })

      viewRef.current = new EditorView({ state, parent: host })
    })()

    return () => {
      disposed = true
      viewRef.current?.destroy()
      viewRef.current = null
    }
    // Rebuilt only when the file itself changes; `value` is synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly])

  // External changes (a reload from disk) replace the document without
  // disturbing the editor when the user is simply typing.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div ref={hostRef} className="editor" />
}
