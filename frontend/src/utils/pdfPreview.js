let pdfRuntimePromise = null
const pdfLoadingTasks = new WeakMap()
const MOBILE_PDF_COMPATIBILITY_OPTIONS = Object.freeze({
  useWorkerFetch: false,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false
})

function runtimeBasePath() {
  const base = import.meta.env.BASE_URL || '/'
  return base.endsWith('/') ? base : `${base}/`
}

async function loadPdfRuntime() {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
    ]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      return pdfjs
    }).catch(error => {
      pdfRuntimePromise = null
      throw error
    })
  }
  return pdfRuntimePromise
}

export async function openPdfDocument(source, options = {}) {
  const pdfjs = await loadPdfRuntime()
  const base = `${runtimeBasePath()}pdfjs/`
  const loadingTask = pdfjs.getDocument({
    ...(typeof source === 'string'
      ? { url: source, withCredentials: true, rangeChunkSize: 64 * 1024 }
      : { data: source }),
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    ...options
  })
  try {
    const document = await loadingTask.promise
    pdfLoadingTasks.set(document, loadingTask)
    return document
  } catch (error) {
    try { await loadingTask.destroy() } catch { /* Preserve the original loading failure. */ }
    throw error
  }
}

export async function disposePdfDocument(document) {
  if (!document) return
  const loadingTask = pdfLoadingTasks.get(document)
  pdfLoadingTasks.delete(document)
  if (loadingTask && typeof loadingTask.destroy === 'function') {
    await loadingTask.destroy()
    return
  }
  if (typeof document.cleanup === 'function') await document.cleanup()
}

export async function openAuthenticatedPdfDocument(url, fetchImpl = globalThis.fetch, options = {}) {
  try {
    return await openPdfDocument(url, options)
  } catch (rangeError) {
    if (typeof fetchImpl !== 'function') throw rangeError

    try {
      const response = await fetchImpl(url, {
        credentials: 'include',
        headers: { Accept: 'application/pdf' }
      })
      if (!response.ok) throw new Error(`PDF request failed with status ${response.status}.`)
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength === 0) throw new Error('PDF response is empty.')
      return await openPdfDocument(new Uint8Array(buffer), options)
    } catch (fallbackError) {
      const error = new Error('PDF preview failed with both range and buffered loading.', { cause: rangeError })
      error.fallbackError = fallbackError
      throw error
    }
  }
}

export function openMobilePdfDocument(url, fetchImpl = globalThis.fetch) {
  return openAuthenticatedPdfDocument(url, fetchImpl, MOBILE_PDF_COMPATIBILITY_OPTIONS)
}
