import DOMPurify from 'dompurify'
import type { RecordEntry } from './api'
const localFragment = /^#[\w:.-]+$/
// Keep local gradients, masks and filters; external CSS references are never needed.
const localUrls = (value: string) =>
  value.replace(/url\s*\([^)]*\)/gi, (url) =>
    /^url\(\s*(['"]?)#[\w:.-]+\1\s*\)$/i.test(url) ? url : '',
  )

function firstCompleteSvg(text: string): string | undefined {
  const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?svg(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'"<>])*>/gi
  let start = 0, depth = 0
  for (const match of text.matchAll(tags)) {
    const tag = match[0]
    if (tag.startsWith('<!')) continue
    if (tag.startsWith('</')) {
      if (depth > 0 && --depth === 0) return text.slice(start, match.index + tag.length)
    } else if (!tag.endsWith('/>')) {
      if (depth++ === 0) start = match.index
    }
  }
}

export function artwork(record: RecordEntry) {
  const sample = record.samples.find(
    (s) =>
      s.status === 'completed' &&
      s.valid !== false &&
      s.answer?.completed !== false &&
      s.answer?.text,
  )
  const raw = sample?.answer?.text ?? ''
  if (!raw || record.kind !== 'pelican') return { raw: '', code: '', url: '', legacy: false }
  const block = raw.match(/```(?:xml|html|svg)?[ \t]*\r?\n([\s\S]*?)```/i)?.[1]
  const legacy =
    record.outputVersion === 'legacy-animation-v1' ||
    (!record.outputVersion && /<(?:html|body|div)\b/i.test(block ?? raw))
  const code = legacy ? block ?? raw : (block && firstCompleteSvg(block)) || firstCompleteSvg(raw) || block || raw
  const xml = new DOMParser().parseFromString(code.trim(), 'image/svg+xml')
  if (legacy || xml.querySelector('parsererror') || xml.documentElement.localName !== 'svg')
    return { raw, code, url: '', legacy }
  const clean = DOMPurify.sanitize(code, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
    FORBID_TAGS: [
      'script',
      'foreignObject',
      'image',
      'a',
      'animate',
      'set',
      'iframe',
      'object',
      'embed',
      'link',
    ],
    FORBID_ATTR: ['src', 'onload', 'xml:base'],
  })
  const document = new DOMParser().parseFromString(clean, 'image/svg+xml')
  if (document.querySelector('parsererror')) return { raw, code, url: '', legacy }
  document.querySelectorAll('style').forEach((s) => {
    s.textContent = localUrls((s.textContent ?? '').replace(/@import[^;]*;/gi, ''))
  })
  document.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes])
      if (
        (a.localName === 'href' && (el.localName !== 'use' || !localFragment.test(a.value))) ||
        ((localUrls(a.value) !== a.value || /javascript:|https?:/i.test(a.value)) &&
          a.name !== 'xmlns' && a.name !== 'xmlns:xlink')
      )
        el.removeAttribute(a.name)
  })
  document.documentElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return {
    raw,
    code,
    url:
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(new XMLSerializer().serializeToString(document)),
    legacy,
  }
}
export function download(text: string, name: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
