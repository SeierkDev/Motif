'use client'

import { useState } from 'react'
import { API } from './api'

/**
 * 512KB, matching the api's own per file cap. Checked here as well so a large
 * file is refused before it is uploaded rather than after.
 */
const MAX_IMAGE_BYTES = 512 * 1024

/**
 * Uploading a picture for a launch, for both forms that have one.
 *
 * @dev Extracted when `/launch` gained a picture field, because the same thirty
 *      lines living in two components is how the two of them drift: one gets a
 *      fixed error message and the other does not, and nothing says so. The
 *      only difference between the callers is what they do with the url
 *      afterwards.
 *
 *      The api stores bytes under the sha256 of those bytes and nothing else,
 *      so the same file is always the same url and the url can be checked
 *      against what it serves. That is what stops the api being able to change
 *      a picture behind a launch that already happened: what goes on chain is
 *      the hash, in effect, wearing a url.
 *
 *      `image` is what goes on chain and `preview` is what the form shows, and
 *      they are separate because of the http case below. A picture that cannot
 *      be recorded should still be visible while the person works out why.
 */
export function usePicture() {
  const [image, setImage] = useState('')
  const [preview, setPreview] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function upload(file: File) {
    setError(null)
    if (file.size > MAX_IMAGE_BYTES) {
      setError(`That is ${(file.size / 1024).toFixed(0)}KB, and the limit is 512KB.`)
      return
    }
    setUploading(true)
    try {
      const res = await fetch(`${API}/v1/images`, { method: 'POST', body: file })
      const body = (await res.json()) as { url?: string; error?: string }
      if (!res.ok || !body.url) throw new Error(body.error ?? `HTTP ${res.status}`)
      // The contract records https and ipfs only, because a browser will not
      // load an http image on an https page and a link on an immutable log
      // that nothing will ever load is worse than no link.
      if (!body.url.startsWith('https://')) {
        setImage('')
        setPreview(body.url)
        setError(
          'The api is not on https, so this picture cannot be recorded on chain. ' +
            'That is only ever true locally.',
        )
        return
      }
      setImage(body.url)
      setPreview(body.url)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  function clear() {
    setImage('')
    setPreview('')
    setError(null)
  }

  return { image, preview, uploading, error, upload, clear }
}
