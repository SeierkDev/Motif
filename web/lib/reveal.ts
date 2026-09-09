'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * Reveal a long list a page at a time as the reader scrolls.
 *
 * @dev Both grids fetched one batch and rendered every row of it, so a phone
 *      built the whole grid up front and then scrolled a very long page. This
 *      renders `step` rows and adds another `step` each time the sentinel comes
 *      near the viewport.
 *
 *      `rootMargin` is 600px, so the next page is added before the reader
 *      reaches the end and the grid never visibly stops.
 *
 *      `resetKey` rather than the array itself in the dependency list. The list
 *      is a new array on every render, so depending on it would reset the count
 *      forever; depending on nothing means changing the sort or the filter
 *      leaves a short list already fully revealed, or a long one still cut to
 *      the previous page. The caller passes what actually changed.
 */
export function useReveal<T>(items: T[], resetKey: string, step = 24) {
  const [count, setCount] = useState(step)
  const sentinel = useRef<HTMLDivElement | null>(null)

  useEffect(() => setCount(step), [resetKey, step])

  useEffect(() => {
    const el = sentinel.current
    if (!el || count >= items.length) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setCount((c) => Math.min(items.length, c + step))
        }
      },
      { rootMargin: '600px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [count, items.length, step])

  const shown = useMemo(() => items.slice(0, count), [items, count])
  return { shown, sentinel, done: count >= items.length, count }
}
