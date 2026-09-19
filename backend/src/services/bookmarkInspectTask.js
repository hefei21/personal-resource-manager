import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import { safeAxiosGet, OutboundRequestError } from './outboundRequest.js'
import { getBookmark, safeBookmarkIcon } from './bookmarkService.js'

export const BOOKMARK_INSPECT_TASK = 'bookmark.inspect'
export const bookmarkSourceHash = (url) =>
  createHash('sha256').update(url).digest('hex')
export function createBookmarkInspector({
  databaseProvider,
  fetch = safeAxiosGet,
}) {
  return async ({ task, signal }) => {
    const db = databaseProvider(),
      id = task.input?.bookmarkId,
      sourceHash = task.input?.sourceHash
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      String(id) !== task.subjectId ||
      !/^[a-f0-9]{64}$/.test(sourceHash || '')
    )
      throw new Error('BOOKMARK_TASK_INPUT_INVALID')
    const original = getBookmark(db, id)
    if (bookmarkSourceHash(original.url) !== sourceHash)
      throw new Error('BOOKMARK_SOURCE_CHANGED')
    signal?.throwIfAborted()
    let result = {
      bookmarkId: id,
      sourceHash,
      status: 'unknown',
      checkedAt: new Date().toISOString(),
      title: '',
      description: '',
      iconData: null,
    }
    try {
      const response = await fetch(original.url, {
        timeout: 12000,
        maxContentLength: 1024 * 1024,
        responseType: 'text',
        signal,
        validateStatus: () => true,
      })
      signal?.throwIfAborted()
      result.httpStatus = response.status
      result.status =
        response.status >= 200 && response.status < 400
          ? 'reachable'
          : [404, 410].includes(response.status)
            ? 'unavailable'
            : [401, 403, 429].includes(response.status)
              ? 'restricted'
              : 'unknown'
      if (
        result.status === 'reachable' &&
        /text\/html|application\/xhtml/i.test(
          response.headers['content-type'] || '',
        )
      ) {
        const $ = load(String(response.data)),
          finalUrl = response.safeFinalUrl || original.url
        result.title = $('title').first().text().trim().slice(0, 300)
        result.description =
          $('meta[name="description"]')
            .attr('content')
            ?.trim()
            .slice(0, 5000) || ''
        const rawIcon =
          $('link[rel~="icon"]').first().attr('href') || '/favicon.ico'
        try {
          const icon = await fetch(new URL(rawIcon, finalUrl).href, {
            timeout: 5000,
            maxContentLength: 64 * 1024,
            responseType: 'arraybuffer',
            signal,
          })
          const mime = String(icon.headers['content-type'] || '')
            .split(';')[0]
            .toLowerCase()
          if (Buffer.byteLength(icon.data) <= 64 * 1024)
            result.iconData = safeBookmarkIcon(
              `data:${mime};base64,${Buffer.from(icon.data).toString('base64')}`,
            )
        } catch {
          /* Optional icon failure never invalidates the saved bookmark. */
        }
      }
    } catch (error) {
      signal?.throwIfAborted()
      result.status =
        error instanceof OutboundRequestError ? 'blocked' : 'unknown'
    }
    signal?.throwIfAborted()
    if (bookmarkSourceHash(getBookmark(db, id).url) !== sourceHash)
      throw new Error('BOOKMARK_SOURCE_CHANGED')
    return result
  }
}
