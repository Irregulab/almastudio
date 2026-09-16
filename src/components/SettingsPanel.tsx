import { useEffect, useState } from 'react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { platform } from '@tauri-apps/plugin-os'
import {
  Bot, Info, Monitor, Palette, RefreshCw, Sparkles, SquareCode, SquareTerminal,
  Terminal,
} from 'lucide-react'

import { appInfo, defaultShell, stateDirPath } from '../lib/ipc'
import { DEFAULT_SETTINGS, useSettings } from '../store/settings'
import { useUi, type SettingsSection } from '../store/ui'
import { AVAILABLE_LOCALES, LOCALE_NAMES, useT } from '../i18n'
import { SCHEME_NAMES } from '../lib/schemes'
import { UI_THEMES } from '../lib/uiThemes'
import { useInstalledHarnesses } from '../hooks/useInstalledHarnesses'
import { useTheme } from '../hooks/useTheme'
import { ConfirmDialog, Field, Modal, NumberInput, Segmented, Toggle } from './ui'
import { UpdateSection } from './Updater'
import type { AppInfo, HarnessKind, Language, PanelView, ThemeMode } from '../lib/types'

type Section = SettingsSection

const ACCENTS = [
  '#0078d4', '#7cb518', '#e0973c', '#d1594f',
  '#9b6bdb', '#2fae91', '#d4b03c', '#8a94a6',
]

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const t = useT()
  // In the store, so "Check for Updates…" can open the panel on its page.
  const section = useUi((s) => s.settingsSection)
  const setSection = useUi((s) => s.setSettingsSection)
  const [confirmReset, setConfirmReset] = useState(false)
  const reset = useSettings((s) => s.reset)

  const sections: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
    { id: 'appearance', label: t('settings.appearance'), icon: <Palette size={14} /> },
    { id: 'terminal', label: t('settings.terminal'), icon: <SquareTerminal size={14} /> },
    { id: 'harness', label: t('settings.harness'), icon: <Sparkles size={14} /> },
    { id: 'workspace', label: t('settings.workspace'), icon: <Monitor size={14} /> },
    { id: 'updates', label: t('settings.updates'), icon: <RefreshCw size={14} /> },
    { id: 'about', label: t('settings.about'), icon: <Info size={14} /> },
  ]

  return (
    <Modal
      title={t('settings.title')}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn--danger btn--sm" onClick={() => setConfirmReset(true)}>
            {t('settings.resetDefaults')}
          </button>
          <span className="spacer" />
          <button className="btn btn--primary" onClick={onClose}>{t('common.close')}</button>
        </>
      }
    >
      <div className="settings">
        <nav className="settings__nav">
          {sections.map((s) => (
            <button
              key={s.id}
              className={`settings__navitem${section === s.id ? ' settings__navitem--on' : ''}`}
              onClick={() => setSection(s.id)}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings__pane">
          {section === 'appearance' && <AppearanceSection />}
          {section === 'terminal' && <TerminalSection />}
          {section === 'harness' && <HarnessSection />}
          {section === 'workspace' && <WorkspaceSection />}
          {section === 'updates' && <UpdateSection />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>

      {confirmReset && (
        <ConfirmDialog
          title={t('settings.resetDefaults')} message={t('settings.resetConfirm')}
          danger confirmLabel={t('settings.resetDefaults')}
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => { reset(); setConfirmReset(false) }}
        />
      )}
    </Modal>
  )
}

// ------------------------------------------------------------ appearance ---

function AppearanceSection() {
  const t = useT()
  const s = useSettings((x) => x.settings)
  const set = useSettings((x) => x.set)
  const patch = useSettings((x) => x.patch)

  return (
    <>
      <Field label={t('settings.theme')}>
        <Segmented<ThemeMode>
          value={s.theme}
          onChange={(v) => set({ theme: v })}
          options={[
            { value: 'system', label: t('settings.themeSystem') },
            { value: 'dark', label: t('settings.themeDark') },
            { value: 'light', label: t('settings.themeLight') },
          ]}
        />
      </Field>

      <Field label={t('settings.uiTheme')} hint={t('settings.uiThemeHint')}>
        <ThemeGrid value={s.uiTheme} onChange={(id) => set({ uiTheme: id })} />
      </Field>

      <Field label={t('settings.accent')}>
        <div className="row">
          <button
            className={`swatch swatch--auto${s.accent === '' ? ' swatch--on' : ''}`}
            onClick={() => set({ accent: '' })}
            title={t('settings.uiTheme')}
            aria-label={t('settings.uiTheme')}
          />
          {ACCENTS.map((c) => (
            <button
              key={c} className={`swatch${c === s.accent ? ' swatch--on' : ''}`}
              style={{ background: c }} onClick={() => set({ accent: c })} aria-label={c}
            />
          ))}
          <input
            className="swatch swatch--input" type="color"
            value={s.accent || '#0078d4'}
            onChange={(e) => set({ accent: e.target.value })} aria-label={t('settings.accent')}
          />
        </div>
      </Field>

      <Field label={t('settings.language')}>
        <select
          className="select" value={s.language}
          onChange={(e) => set({ language: e.target.value as Language })}
        >
          <option value="system">{t('settings.languageSystem')}</option>
          {AVAILABLE_LOCALES.map((l) => (
            <option key={l} value={l}>{LOCALE_NAMES[l]}</option>
          ))}
        </select>
      </Field>

      <Field label={t('settings.uiFont')} hint="e.g. Inter, 'SF Pro Text', system-ui">
        <input
          className="input" value={s.ui.fontFamily} placeholder="System"
          onChange={(e) => patch('ui', { fontFamily: e.target.value })}
        />
      </Field>

      <Field label={t('settings.uiFontSize')}>
        <NumberInput
          value={s.ui.fontSize} min={11} max={18}
          onChange={(v) => patch('ui', { fontSize: v })} suffix="px"
        />
      </Field>

      <Field label={t('settings.density')}>
        <Segmented
          value={s.ui.density}
          onChange={(v) => patch('ui', { density: v })}
          options={[
            { value: 'comfortable' as const, label: t('settings.comfortable') },
            { value: 'compact' as const, label: t('settings.compact') },
          ]}
        />
      </Field>
    </>
  )
}

/**
 * Themes are shown as swatches rather than as a dropdown: the name of a theme
 * tells you far less about it than four of its colours do.
 */
function ThemeGrid({
  value, onChange,
}: { value: string; onChange: (id: string) => void }) {
  const isDark = useTheme()
  return (
    <div className="themegrid">
      {UI_THEMES.map((theme) => {
        const v = isDark ? theme.dark : theme.light
        const active = theme.id === value
        return (
          <button
            key={theme.id}
            type="button"
            className={`themecard${active ? ' themecard--on' : ''}`}
            aria-pressed={active}
            onClick={() => onChange(theme.id)}
          >
            <span
              className="themecard__preview"
              style={{ background: v.bg, borderColor: v['border-strong'] }}
            >
              <span className="themecard__bar" style={{ background: v['bg-panel'] }} />
              <span className="themecard__chip" style={{ background: v.accent }} />
              <span className="themecard__chip" style={{ background: v['syn-string'] }} />
              <span className="themecard__chip" style={{ background: v['syn-keyword'] }} />
              <span className="themecard__chip" style={{ background: v['syn-function'] }} />
            </span>
            <span className="themecard__name truncate">{theme.name}</span>
          </button>
        )
      })}
    </div>
  )
}

// -------------------------------------------------------------- terminal ---

function TerminalSection() {
  const t = useT()
  const s = useSettings((x) => x.settings)
  const patch = useSettings((x) => x.patch)
  const [systemShell, setSystemShell] = useState('')

  useEffect(() => {
    void defaultShell().then(setSystemShell).catch(() => {})
  }, [])

  return (
    <>
      <Field label={t('settings.scheme')}>
        <select
          className="select" value={s.terminal.scheme}
          onChange={(e) => patch('terminal', { scheme: e.target.value })}
        >
          {Object.entries(SCHEME_NAMES).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </Field>

      <Field label={t('settings.termFont')} hint="e.g. 'JetBrains Mono', 'Fira Code', Menlo">
        <input
          className="input mono" value={s.terminal.fontFamily} placeholder="System monospace"
          onChange={(e) => patch('terminal', { fontFamily: e.target.value })}
        />
      </Field>

      <div className="grid2">
        <Field label={t('settings.termFontSize')}>
          <NumberInput
            value={s.terminal.fontSize} min={9} max={24}
            onChange={(v) => patch('terminal', { fontSize: v })} suffix="px"
          />
        </Field>
        <Field label={t('settings.lineHeight')}>
          <NumberInput
            value={s.terminal.lineHeight} min={1} max={2} step={0.05}
            onChange={(v) => patch('terminal', { lineHeight: v })}
          />
        </Field>
      </div>

      <Field label={t('settings.cursorStyle')}>
        <Segmented
          value={s.terminal.cursorStyle}
          onChange={(v) => patch('terminal', { cursorStyle: v })}
          options={[
            { value: 'bar' as const, label: 'Bar' },
            { value: 'block' as const, label: 'Block' },
            { value: 'underline' as const, label: 'Underline' },
          ]}
        />
      </Field>

      <Field label={t('settings.cursorBlink')} row>
        <Toggle
          checked={s.terminal.cursorBlink}
          onChange={(v) => patch('terminal', { cursorBlink: v })}
        />
      </Field>

      <Field label={t('settings.scrollback')}>
        <NumberInput
          value={s.terminal.scrollback} min={500} max={100000} step={500}
          onChange={(v) => patch('terminal', { scrollback: v })}
        />
      </Field>

      <Field label={t('settings.copyOnSelect')} row>
        <Toggle
          checked={s.terminal.copyOnSelect}
          onChange={(v) => patch('terminal', { copyOnSelect: v })}
        />
      </Field>

      <Field label={t('settings.rightClickPaste')} row>
        <Toggle
          checked={s.terminal.rightClickPaste}
          onChange={(v) => patch('terminal', { rightClickPaste: v })}
        />
      </Field>

      {/* Only macOS has the choice: elsewhere Alt is always Meta and AltGr types. */}
      {platform() === 'macos' && (
        <Field label={t('settings.optionIsMeta')} hint={t('settings.optionIsMetaHint')} row>
          <Toggle
            checked={s.terminal.optionIsMeta}
            onChange={(v) => patch('terminal', { optionIsMeta: v })}
          />
        </Field>
      )}

      <Field label={t('settings.shell')} hint={t('settings.shellHint', { shell: systemShell })}>
        <input
          className="input mono" value={s.terminal.shell} placeholder={systemShell}
          onChange={(e) => patch('terminal', { shell: e.target.value })}
        />
      </Field>

      <Field label={t('settings.loginShell')} hint={t('settings.loginShellHint')} row>
        <Toggle
          checked={s.terminal.loginShell}
          onChange={(v) => patch('terminal', { loginShell: v })}
        />
      </Field>
    </>
  )
}

// --------------------------------------------------------------- harness ---

function HarnessSection() {
  const t = useT()
  const s = useSettings((x) => x.settings)
  const set = useSettings((x) => x.set)
  const [kind, setKind] = useState<HarnessKind>('claude')
  const cfg = s.harness[kind]
  const harnesses = useInstalledHarnesses()
  const setHarness = useSettings((x) => x.setHarness)

  return (
    <>
      <Field label={t('settings.defaultHarness')}>
        <Segmented<HarnessKind>
          value={s.defaultHarness}
          onChange={(v) => set({ defaultHarness: v })}
          options={[
            { value: 'claude', label: t('tabs.claude'), icon: <Sparkles size={13} /> },
            { value: 'codex', label: t('tabs.codex'), icon: <Bot size={13} /> },
            { value: 'opencode', label: t('tabs.opencode'), icon: <SquareCode size={13} /> },
            { value: 'shell', label: t('tabs.shell'), icon: <Terminal size={13} /> },
          ]}
        />
      </Field>

      <div className="settings__sep" />

      <Segmented<HarnessKind>
        value={kind}
        onChange={setKind}
        options={[
          { value: 'claude', label: t('tabs.claude') },
          { value: 'codex', label: t('tabs.codex') },
          { value: 'opencode', label: t('tabs.opencode') },
        ]}
      />

      <div style={{ height: 12 }} />

      <Field
        label={t('settings.command')}
        hint={harnesses.includes(kind) ? undefined : t('settings.notInstalled')}
      >
        <input
          className="input mono" value={cfg.command}
          onChange={(e) => setHarness(kind, { command: e.target.value })}
        />
      </Field>

      <div className="grid2">
        <Field label={t('settings.args')} hint={t('settings.argsHint')}>
          <textarea
            className="textarea" rows={4} value={cfg.args.join('\n')}
            onChange={(e) => setHarness(kind, { args: splitLines(e.target.value) })}
          />
        </Field>
        <Field label={t('settings.resumeArgs')} hint={t('settings.resumeArgsHint')}>
          <textarea
            className="textarea" rows={4} value={cfg.resumeArgs.join('\n')}
            onChange={(e) => setHarness(kind, { resumeArgs: splitLines(e.target.value) })}
          />
        </Field>
      </div>

      <Field label={t('settings.instructionsMode')} hint={t('settings.instructionsHint')}>
        <select
          className="select" value={cfg.instructionsMode}
          onChange={(e) =>
            setHarness(kind, {
              instructionsMode: e.target.value as typeof cfg.instructionsMode,
            })
          }
        >
          <option value="flag">{t('settings.modeFlag')}</option>
          <option value="env">{t('settings.modeEnv')}</option>
          <option value="none">{t('settings.modeNone')}</option>
        </select>
      </Field>

      {cfg.instructionsMode === 'flag' && (
        <Field label={t('settings.instructionsFlag')}>
          <input
            className="input mono" value={cfg.instructionsFlag}
            placeholder="--append-system-prompt"
            onChange={(e) => setHarness(kind, { instructionsFlag: e.target.value })}
          />
        </Field>
      )}
    </>
  )
}

const splitLines = (v: string) =>
  v.split('\n').map((l) => l.trim()).filter(Boolean)

// ------------------------------------------------------------- workspace ---

function WorkspaceSection() {
  const t = useT()
  const s = useSettings((x) => x.settings)
  const patch = useSettings((x) => x.patch)

  return (
    <>
      <Field label={t('settings.defaultPanel')}>
        <Segmented<PanelView>
          value={s.panel.defaultView}
          onChange={(v) => patch('panel', { defaultView: v })}
          options={[
            { value: 'changes', label: t('panel.changes') },
            { value: 'files', label: t('panel.files') },
            { value: 'git', label: t('panel.git') },
            { value: 'search', label: t('panel.search') },
          ]}
        />
      </Field>

      <Field label={t('settings.diffView')}>
        <Segmented
          value={s.panel.diffView}
          onChange={(v) => patch('panel', { diffView: v })}
          options={[
            { value: 'unified' as const, label: t('diff.unified') },
            { value: 'split' as const, label: t('diff.split') },
          ]}
        />
      </Field>

      <Field label={t('settings.contextLines')}>
        <NumberInput
          value={s.panel.contextLines} min={0} max={20}
          onChange={(v) => patch('panel', { contextLines: v })}
        />
      </Field>

      <Field label={t('panel.showHidden')} row>
        <Toggle checked={s.panel.showHidden} onChange={(v) => patch('panel', { showHidden: v })} />
      </Field>

      <Field label={t('panel.respectGitignore')} row>
        <Toggle
          checked={s.panel.respectGitignore}
          onChange={(v) => patch('panel', { respectGitignore: v })}
        />
      </Field>

      <Field label={t('settings.watch')} hint={t('settings.watchHint')} row>
        <Toggle checked={s.panel.watch} onChange={(v) => patch('panel', { watch: v })} />
      </Field>

      <Field label={t('settings.autoFetch')} hint={t('settings.autoFetchHint')}>
        <NumberInput
          value={s.panel.autoFetchMinutes} min={0} max={120} suffix={t('settings.autoFetchUnit')}
          onChange={(v) => patch('panel', { autoFetchMinutes: v })}
        />
      </Field>

      <div className="settings__sep" />

      <Field label={t('settings.restoreTabs')} row>
        <Toggle
          checked={s.startup.restoreTabs}
          onChange={(v) => patch('startup', { restoreTabs: v })}
        />
      </Field>

      <Field label={t('settings.restoreScrollback')} row>
        <Toggle
          checked={s.startup.restoreScrollback}
          onChange={(v) => patch('startup', { restoreScrollback: v })}
        />
      </Field>

      <Field label={t('settings.autoStartTabs')} hint={t('settings.autoStartHint')} row>
        <Toggle
          checked={s.startup.autoStartTabs}
          onChange={(v) => patch('startup', { autoStartTabs: v })}
        />
      </Field>

      <Field label={t('settings.confirmOnExit')} hint={t('settings.confirmOnExitHint')} row>
        <Toggle
          checked={s.startup.confirmOnExit}
          onChange={(v) => patch('startup', { confirmOnExit: v })}
        />
      </Field>
    </>
  )
}

// ----------------------------------------------------------------- about ---

function AboutSection() {
  const t = useT()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [dir, setDir] = useState('')

  useEffect(() => {
    void appInfo().then(setInfo).catch(() => {})
    void stateDirPath().then(setDir).catch(() => {})
  }, [])

  return (
    <>
      <div className="about">
        <div className="about__name">AlmaStudio</div>
        <div className="subtle">
          {t('settings.version')} {info?.version ?? '—'}
          {info ? ` · ${info.os}/${info.arch} · Tauri ${info.tauriVersion}` : ''}
        </div>
      </div>

      <Field label={t('settings.dataFolder')}>
        <div className="row">
          <input className="input mono" value={dir} readOnly />
          <button
            className="btn" disabled={!dir}
            onClick={() => void revealItemInDir(dir).catch(() => {})}
          >
            {t('settings.reveal')}
          </button>
        </div>
      </Field>

      <p className="field__hint">
        Settings and the workspace are stored as JSON next to a rolling backup of each
        file, so an unclean shutdown can never lose your project list.
      </p>
    </>
  )
}

export { DEFAULT_SETTINGS }
