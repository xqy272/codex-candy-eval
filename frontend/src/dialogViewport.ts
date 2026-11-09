// CPR frames grow with their content and can be scrolled by the containing page.
// The observed rectangle is local to this frame, even for an opaque origin.
let users = 0
let stop: (() => void) | undefined

function observeViewport() {
  const root = document.documentElement
  const probe = document.createElement('div')
  probe.className = 'dialog-viewport-probe'
  probe.setAttribute('aria-hidden', 'true')
  document.body.append(probe)
  let lastTop = -1, lastHeight = -1
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry || !entry.isIntersecting) return
    const top = Math.max(0, Math.ceil(entry.intersectionRect.top))
    const height = Math.floor(entry.intersectionRect.bottom) - top
    if (height <= 0 || (top === lastTop && height === lastHeight)) return
    lastTop = top
    lastHeight = height
    root.style.setProperty('--eval-visible-top', top + 'px')
    root.style.setProperty('--eval-visible-height', height + 'px')
  })
  const sample = () => {
    // An outer scroll can move the visible rectangle without changing its area.
    // Request a fresh observation only while a dialog is open.
    observer.unobserve(probe)
    observer.observe(probe)
  }
  sample()
  const timer = window.setInterval(sample, 100)
  window.addEventListener('resize', sample)
  return () => {
    window.clearInterval(timer)
    window.removeEventListener('resize', sample)
    observer.disconnect()
    probe.remove()
    root.style.removeProperty('--eval-visible-top')
    root.style.removeProperty('--eval-visible-height')
  }
}

export function trackDialogViewport() {
  if (window.top === window || typeof IntersectionObserver === 'undefined') return () => {}
  if (++users === 1) stop = observeViewport()
  return () => {
    if (--users === 0) { stop?.(); stop = undefined }
  }
}
