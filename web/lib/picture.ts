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
      /*
       * http is usable, and only the on chain route refuses it.
       *
       * The contract records https and ipfs only, because a browser will not
       * load an http image on an https page and a link in an immutable log
       * that nothing will ever load is worse than no link. That reasoning is
       * about the log. A picture kept with the api is served from the same
       * origin the page is already calling for its data, so if the api is
       * reachable at all its images are too.
       *
       * This used to blank the picture outright, which meant a local api made
       * the field look broken rather than making one route unavailable. Now
       * the url is kept and `onChainSafe` says which routes can take it.
       */
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

  /*
   * Whether this url can go in the log, as opposed to only into the api.
   *
   * `_checkImage` on the router accepts https and ipfs and reverts on anything
   * else, so passing an http url to a router that does take pictures fails the
   * whole launch. The caller needs to know before it picks which overload to
   * call, and it cannot tell from the url alone what the router will accept.
   */
  const onChainSafe = image.startsWith('https://') || image.startsWith('ipfs://')

  return { image, preview, uploading, error, upload, clear, onChainSafe }
}
