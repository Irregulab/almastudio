/** Markdown rendering for the file preview.
 *
 * File contents are untrusted input — a README from a cloned repository is
 * arbitrary text — so the parsed HTML goes through DOMPurify before it reaches
 * the DOM. The app's CSP already blocks inline scripts, but defence in depth is
 * cheap here and the alternative (a hand-written renderer) would be far more
 * code to get right.
 *
 * Loaded on demand, as its own chunk, alongside the highlighter.
 */

import { languageOf, loadHljs } from './syntax'

export interface RenderedMarkdown {
  html: string
  /** Headings, for a future outline; also tells the caller the doc was parsed. */
  headings: Array<{ depth: number; text: string }>
}

export async function renderMarkdown(source: string): Promise<RenderedMarkdown> {
  const [{ Marked }, { default: DOMPurify }, hljs] = await Promise.all([
    import('marked'),
    import('dompurify'),
    // Awaited up front so the code-block renderer below can stay synchronous.
    loadHljs(),
  ])

  const headings: Array<{ depth: number; text: string }> = []

  const marked = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      code({ text, lang }) {
        const language = lang ? (languageOf(`x.${lang}`) ?? lang) : null
        if (language && hljs.getLanguage(language)) {
          const out = hljs.highlight(text, { language, ignoreIllegals: true }).value
          return `<pre><code class="hljs language-${escapeAttr(language)}">${out}</code></pre>`
        }
        return `<pre><code>${escapeHtml(text)}</code></pre>`
      },
      heading({ text, depth }) {
        headings.push({ depth, text: stripTags(text) })
        return `<h${depth}>${text}</h${depth}>\n`
      },
    },
  })

  const raw = marked.parse(source, { async: false })
  const html = DOMPurify.sanitize(raw, {
    // Anything that can execute or embed is dropped outright.
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
    FORBID_ATTR: ['style', 'srcset', 'formaction', 'ping'],
    ADD_ATTR: ['target', 'rel'],
  })
  return { html, headings }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

const escapeAttr = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '')

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '')
