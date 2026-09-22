import { useCallback, useEffect, useRef, useState } from 'react'
import { CaseSensitive, ChevronDown, ChevronRight, ChevronRightSquare, Ellipsis, Regex, Replace, WholeWord } from 'lucide-react'
import { create } from 'zustand'

import { replaceText, searchText, type FileMatches, type LineMatch, type SearchResults } from '../lib/ipc'
import { useWorkspace } from '../store/workspace'
import { useT } from '../i18n'
import { ConfirmDialog } from './ui'
import { FileIcon } from './FileIcon'

interface SearchOptions {
  pattern: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  include: string
  exclude: string
  showFilters: boolean
  replacement: string
  showReplace: boolean
}

const DEFAULTS: SearchOptions = {
  pattern: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: '',
  exclude: '',
  showFilters: false,
  replacement: '',
  showReplace: false,
}

/** Kept per project, so switching panel views or projects keeps the query. */
const useSearchOptions = create<Record<string, SearchOptions>>(() => ({}))

/**
 * Text search across the panel's folder, like VS Code's Search view: case,
 * whole-word and regex toggles, files to include and exclude, and results
 * grouped by file. Searches as you type; a newer search cancels the last.
 */
export function SearchView({
  projectId, root, revision,
}: { projectId: string; root: string; revision: number }) {
  const t = useT()
  const options = useSearchOptions((s) => s[projectId]) ?? DEFAULTS
  const openFileTab = useWorkspace((s) => s.openFileTab)
  const inputRef = useRef<HTMLInputElement>(null)
  const [results, setResults] = useState<SearchResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [replaceNotice, setReplaceNotice] = useState<string | null>(null)
  const [replaceError, setReplaceError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** Replace All when 'all', or in one file; set to ask before running it. */
  const [confirmReplace, setConfirmReplace] = useState<'all' | FileMatches | null>(null)
  /** Enter searches at once rather than after the typing pause. */
  const [runNow, setRunNow] = useState(0)
  const immediate = useRef(false)

  const set = useCallback(
    (patch: Partial<SearchOptions>) =>
      useSearchOptions.setState((s) => ({
        ...s,
        [projectId]: { ...(s[projectId] ?? DEFAULTS), ...patch },
      })),
    [projectId],
  )

  // ⇧⌘F lands here, whether the view was already open or just opened.
  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    focus()
    window.addEventListener('almastudio:search-focus', focus)
    return () => window.removeEventListener('almastudio:search-focus', focus)
  }, [])

  const { pattern, caseSensitive, wholeWord, regex, include, exclude, replacement } = options

  useEffect(() => {
    if (!pattern) {
      setResults(null)
      setError(null)
      setSearching(false)
      // Still sent: an empty search stops one that is running.
      void searchText({ root, pattern: '' }).catch(() => {})
      return
    }
    let stale = false
    const delay = immediate.current ? 0 : 250
    immediate.current = false
    const timer = window.setTimeout(() => {
      setSearching(true)
      void searchText({ root, pattern, caseSensitive, wholeWord, regex, include, exclude })
        .then((r) => {
          if (stale || r.cancelled) return
          setResults(r)
          setError(null)
        })
        .catch((e) => {
          if (stale) return
          setResults(null)
          setError(String(e))
        })
        .finally(() => !stale && setSearching(false))
    }, delay)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [root, pattern, caseSensitive, wholeWord, regex, include, exclude, revision, runNow])

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const runReplaceAll = useCallback(async () => {
    if (!pattern || !replacement) return
    setReplacing(true)
    setReplaceError(null)
    setReplaceNotice(null)
    try {
      const r = await replaceText({
        root, pattern, caseSensitive, wholeWord, regex, include, exclude, replacement,
      })
      const msg = t('search.replaceDone', { n: r.replacements, f: r.filesChanged })
      setReplaceNotice(msg)
      window.setTimeout(() => setReplaceNotice(null), 3000)
      // Re-run the search to refresh results.
      immediate.current = true
      setRunNow((n) => n + 1)
    } catch (e) {
      setReplaceError(String(e))
    } finally {
      setReplacing(false)
    }
  }, [root, pattern, caseSensitive, wholeWord, regex, include, exclude, replacement, t])

  const runReplaceFile = useCallback(async (file: FileMatches) => {
    if (!pattern || !replacement) return
    setReplacing(true)
    setReplaceError(null)
    setReplaceNotice(null)
    // Use the file's relative path as an include glob so only that one file
    // is affected.
    try {
      const r = await replaceText({
        root, pattern, caseSensitive, wholeWord, regex,
        include: file.rel,
        exclude: '',
        replacement,
      })
      const msg = t('search.replaceDone', { n: r.replacements, f: r.filesChanged })
      setReplaceNotice(msg)
      window.setTimeout(() => setReplaceNotice(null), 3000)
      immediate.current = true
      setRunNow((n) => n + 1)
    } catch (e) {
      setReplaceError(String(e))
    } finally {
      setReplacing(false)
    }
  }, [root, pattern, caseSensitive, wholeWord, regex, replacement, t])

  // A click previews the match, a double click keeps the file open, as in VS Code.
  const open = (file: FileMatches, match: LineMatch, preview: boolean) =>
    openFileTab({
      projectId, root, path: file.path,
      line: match.line, column: match.column, length: match.length, preview,
    })

  const summary = (r: SearchResults) => {
    if (r.matchCount === 0) return t('search.noResults')
    const found = r.matchCount === 1 ? t('search.resultsOne') : t('search.resultsMany', { n: r.matchCount })
    const files = r.files.length === 1 ? t('search.filesOne') : t('search.filesMany', { n: r.files.length })
    return `${found} ${files}`
  }

  const confirmReplaceProps = (() => {
    if (!confirmReplace || !results) return null
    if (confirmReplace === 'all') {
      return {
        title: t('search.replaceAll'),
        message: t('search.replaceAllConfirmMessage', { n: results.matchCount, f: results.files.length }),
        run: runReplaceAll,
      }
    }
    return {
      title: t('search.replaceInFile'),
      message: t('search.replaceInFileConfirmMessage', {
        n: confirmReplace.matches.length, file: confirmReplace.rel,
      }),
      run: () => runReplaceFile(confirmReplace),
    }
  })()

  return (
    <div className="search">
      <div className="search__bar">
        <Toggle on={options.showReplace} label={t('search.toggleReplace')}
          onClick={() => set({ showReplace: !options.showReplace })}>
          <ChevronRightSquare size={14} />
        </Toggle>
        <div className="search__field">
          <input
            ref={inputRef}
            className="input input--sm search__input"
            placeholder={t('search.placeholder')}
            value={pattern}
            spellCheck={false}
            onChange={(e) => set({ pattern: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                immediate.current = true
                setRunNow((n) => n + 1)
              }
              if (e.key === 'Escape' && pattern) set({ pattern: '' })
            }}
          />
          <div className="search__toggles">
            <Toggle on={caseSensitive} label={t('search.matchCase')}
              onClick={() => set({ caseSensitive: !caseSensitive })}>
              <CaseSensitive size={14} />
            </Toggle>
            <Toggle on={wholeWord} label={t('search.wholeWord')}
              onClick={() => set({ wholeWord: !wholeWord })}>
              <WholeWord size={14} />
            </Toggle>
            <Toggle on={regex} label={t('search.regex')} onClick={() => set({ regex: !regex })}>
              <Regex size={14} />
            </Toggle>
          </div>
        </div>
        <Toggle on={options.showFilters} label={t('search.toggleFilters')}
          onClick={() => set({ showFilters: !options.showFilters })}>
          <Ellipsis size={14} />
        </Toggle>
      </div>

      {options.showReplace && (
        <div className="search__replace-row">
          <input
            className="input input--sm search__replace-input"
            placeholder={t('search.replacePlaceholder')}
            value={replacement}
            spellCheck={false}
            onChange={(e) => set({ replacement: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pattern && replacement) setConfirmReplace('all')
              if (e.key === 'Escape') set({ replacement: '' })
            }}
          />
          <button
            className="btn btn--sm"
            disabled={!pattern || !replacement || replacing}
            title={t('search.replaceAll')}
            onClick={() => setConfirmReplace('all')}
          >
            <Replace size={12} /> {t('search.replaceAll')}
          </button>
        </div>
      )}

      {options.showFilters && (
        <div className="search__filters">
          <label className="search__label">
            {t('search.include')}
            <input
              className="input input--sm mono" value={include} spellCheck={false}
              placeholder={t('search.includePlaceholder')}
              onChange={(e) => set({ include: e.target.value })}
            />
          </label>
          <label className="search__label">
            {t('search.exclude')}
            <input
              className="input input--sm mono" value={exclude} spellCheck={false}
              placeholder={t('search.excludePlaceholder')}
              onChange={(e) => set({ exclude: e.target.value })}
            />
          </label>
        </div>
      )}

      <div className="search__status subtle">
        {replaceError ? (
          <span className="search__error">{replaceError}</span>
        ) : replaceNotice ? (
          <span>{replaceNotice}</span>
        ) : error ? (
          <span className="search__error">{error}</span>
        ) : results && pattern ? (
          <>
            {summary(results)}
            {results.truncated && <div>{t('search.truncated', { n: results.matchCount })}</div>}
          </>
        ) : (
          searching && t('search.searching')
        )}
      </div>

      <div className="search__results">
        {pattern && !error && results?.files.map((file) => {
          const closed = collapsed.has(file.path)
          const slash = file.rel.lastIndexOf('/')
          const name = file.rel.slice(slash + 1)
          return (
            <section key={file.path}>
              <button className="search__file-head" title={file.rel} onClick={() => toggle(file.path)}>
                {closed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <FileIcon name={name} size={13} />
                <span className="search__file-name truncate">{name}</span>
                <span className="search__file-dir truncate subtle">
                  {slash > 0 ? file.rel.slice(0, slash) : ''}
                </span>
                <span className="search__count">{file.matches.length}</span>
                {options.showReplace && replacement && (
                  <button
                    className="icon-btn icon-btn--tiny search__file-replace"
                    title={t('search.replaceInFile')}
                    disabled={replacing}
                    onClick={(e) => { e.stopPropagation(); setConfirmReplace(file) }}
                  >
                    <Replace size={11} />
                  </button>
                )}
              </button>
              {!closed && file.matches.map((match) => (
                <button
                  key={match.line}
                  className="search__match"
                  title={`${file.rel}:${match.line}`}
                  onClick={() => open(file, match, true)}
                  onDoubleClick={() => open(file, match, false)}
                >
                  <Highlighted text={match.preview} ranges={match.ranges} />
                  <span className="search__line subtle">{match.line}</span>
                </button>
              ))}
            </section>
          )
        })}
      </div>
      {confirmReplaceProps && (
        <ConfirmDialog
          title={confirmReplaceProps.title}
          message={confirmReplaceProps.message}
          confirmLabel={t('search.replaceAll')}
          danger
          onCancel={() => setConfirmReplace(null)}
          onConfirm={() => {
            setConfirmReplace(null)
            void confirmReplaceProps.run()
          }}
        />
      )}
    </div>
  )
}

function Toggle({
  on, label, onClick, children,
}: { on: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="icon-btn icon-btn--tiny" aria-pressed={on} aria-label={label} title={label}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** A result line with its matches marked. */
function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: React.ReactNode[] = []
  let at = 0
  ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(<mark key={i} className="search__hit">{text.slice(start, end)}</mark>)
    at = end
  })
  if (at < text.length) parts.push(text.slice(at))
  return <span className="search__preview">{parts}</span>
}
