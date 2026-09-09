import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useT } from '../i18n'

// ---------------------------------------------------------------- popover --

interface PopoverProps {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  align?: 'start' | 'end'
  children: ReactNode
}

/** Anchored dropdown. Closes on outside click, Escape, scroll or resize. */
export function Popover({ anchor, open, onClose, align = 'start', children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useLayoutEffect(() => {
    if (!open || !anchor) return
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const el = ref.current
      const w = el?.offsetWidth ?? 200
      const h = el?.offsetHeight ?? 100
      let left = align === 'end' ? r.right - w : r.left
      let top = r.bottom + 4
      // Keep the panel on screen without ever covering its own anchor.
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4)
      setPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor, align])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, anchor, onClose])

  if (!open) return null
  return createPortal(
    <div ref={ref} className="popover" style={{ top: pos.top, left: pos.left }} role="menu">
      {children}
    </div>,
    document.body,
  )
}

export function MenuItem({
  icon, label, hint, onClick, danger, disabled, checked,
}: {
  icon?: ReactNode
  label: string
  hint?: string
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  checked?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item${danger ? ' menu-item--danger' : ''}`}
      disabled={disabled}
      aria-checked={checked}
      onClick={onClick}
    >
      <span className="menu-item__icon">{icon}</span>
      <span className="menu-item__label truncate">{label}</span>
      {hint && <span className="menu-item__hint mono">{hint}</span>}
    </button>
  )
}

export const MenuSeparator = () => <div className="menu-sep" role="separator" />

// ------------------------------------------------------------------ modal --

export function Modal({
  title, onClose, children, footer, wide,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  const t = useT()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal--wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal__head">
          <span className="spacer truncate">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <X size={15} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmDialog({
  title, message, confirmLabel, danger, onConfirm, onCancel,
}: {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const t = useT()
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>{t('common.cancel')}</button>
          <button
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel ?? t('common.confirm')}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.6 }}>{message}</p>
    </Modal>
  )
}

/** Single-field prompt, used for naming and renaming files and folders. */
export function PromptDialog({
  title, label, initial, confirmLabel, selectBase, onConfirm, onCancel,
}: {
  title: string
  label: string
  initial?: string
  confirmLabel?: string
  /** Preselect the name without its extension, as a rename dialog should. */
  selectBase?: boolean
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  const t = useT()
  const [value, setValue] = useState(initial ?? '')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const dot = (initial ?? '').lastIndexOf('.')
    if (selectBase && dot > 0) el.setSelectionRange(0, dot)
    else el.select()
  }, [initial, selectBase])

  const submit = () => {
    const v = value.trim()
    if (v) onConfirm(v)
  }

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>{t('common.cancel')}</button>
          <button className="btn btn--primary" disabled={!value.trim()} onClick={submit}>
            {confirmLabel ?? t('common.confirm')}
          </button>
        </>
      }
    >
      <Field label={label}>
        <input
          ref={ref}
          className="input mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
      </Field>
    </Modal>
  )
}

// --------------------------------------------------------------- controls --

export function Field({
  label, hint, children, row,
}: { label: string; hint?: string; children: ReactNode; row?: boolean }) {
  return (
    <div className={`field${row ? ' field--row' : ''}`}>
      {row ? (
        <div style={{ minWidth: 0 }}>
          <div className="field__label">{label}</div>
          {hint && <div className="field__hint">{hint}</div>}
        </div>
      ) : (
        <label className="field__label">{label}</label>
      )}
      {children}
      {!row && hint && <div className="field__hint">{hint}</div>}
    </div>
  )
}

export function Toggle({
  checked, onChange, label,
}: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      onClick={() => onChange(!checked)}
    />
  )
}

export function NumberInput({
  value, onChange, min, max, step = 1, suffix,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
}) {
  return (
    <div className="num">
      <input
        className="input"
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange(clamp(n, min, max))
        }}
      />
      {suffix && <span className="num__suffix subtle">{suffix}</span>}
    </div>
  )
}

const clamp = (n: number, min?: number, max?: number) =>
  Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))

export function Segmented<T extends string>({
  value, options, onChange,
}: {
  value: T
  options: Array<{ value: T; label: string; icon?: ReactNode }>
  onChange: (v: T) => void
}) {
  const id = useId()
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={`${id}-${o.value}`}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className="segmented__item"
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Text input that commits on blur / Enter, so typing does not thrash state. */
export function TextInput({
  value, onCommit, placeholder, mono, autoFocus,
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  mono?: boolean
  autoFocus?: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = useCallback(() => {
    if (draft !== value) onCommit(draft)
  }, [draft, value, onCommit])
  return (
    <input
      className={`input${mono ? ' mono' : ''}`}
      value={draft}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setDraft(value)
      }}
    />
  )
}
