let pdfRuntimePromise = null

function runtimeBasePath() {
  const base = import.meta.env.BASE_URL || '/'
  return base.endsWith('/') ? base : `${base}/`
}

async function loadPdfRuntime() {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url')
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

export async function openPdfDocument(source) {
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
    iccUrl: `${base}iccs/`
  })
  return loadingTask.promise
}

export async function openAuthenticatedPdfDocument(url, fetchImpl = globalThis.fetch) {
  try {
    return await openPdfDocument(url)
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
      return await openPdfDocument(new Uint8Array(buffer))
    } catch (fallbackError) {
      const error = new Error('PDF preview failed with both range and buffered loading.', { cause: rangeError })
      error.fallbackError = fallbackError
      throw error
    }
  }
}
