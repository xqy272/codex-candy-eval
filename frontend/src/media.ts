import DOMPurify from 'dompurify'
import type { RecordEntry } from './api'
// Keep local gradients, masks and filters; external CSS references are never needed.
const localUrls = (value: string) =>
  value.replace(/url\s*\([^)]*\)/gi, (url) =>
    /^url\(\s*(['"]?)#[\w:.-]+\1\s*\)$/i.test(url) ? url : '',
  )
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
  const code = raw.match(/```(?:xml|html|svg)?\s*\n([\s\S]*?)```/i)?.[1] ?? raw
  const legacy =
    record.outputVersion === 'legacy-animation-v1' ||
    (!record.outputVersion && /<(?:html|body|div)\b/i.test(code))
  const xml = new DOMParser().parseFromString(code.trim(), 'image/svg+xml')
  if (legacy || xml.querySelector('parsererror') || xml.documentElement.localName !== 'svg')
    return { raw, code, url: '', legacy }
  const clean = DOMPurify.sanitize(code, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      'script',
      'foreignObject',
      'image',
      'a',
      'use',
      'iframe',
      'object',
      'embed',
      'link',
    ],
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'onload'],
  })
  const document = new DOMParser().parseFromString(clean, 'image/svg+xml')
  if (document.querySelector('parsererror')) return { raw, code, url: '', legacy }
  document.querySelectorAll('style').forEach((s) => {
    s.textContent = localUrls((s.textContent ?? '').replace(/@import[^;]*;/gi, ''))
  })
  document.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes])
      if (
        (localUrls(a.value) !== a.value || /javascript:|https?:/i.test(a.value)) &&
        a.name !== 'xmlns'
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
