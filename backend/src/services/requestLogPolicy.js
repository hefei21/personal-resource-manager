export function logPath(req) {
  return String(req.originalUrl || req.path || '/').split(/[?#]/, 1)[0]
}

export function isEmptyWorkerClaim(req, res) {
  return req.method === 'POST' && logPath(req) === '/api/pc-worker-agent/tasks/claim' &&
    Boolean(req.pcWorker?.id) && res.statusCode === 204 && res.pcWorkerEmptyClaim === true
}

export function logActor(req) {
  return req.pcWorker?.id
    ? { userId: null, username: `worker:${req.pcWorker.id}` }
    : { userId: req.user?.id || null, username: req.user?.username || 'guest' }
}

// Observe the response, not the request start: only the authenticated route
// can prove that a successful claim was empty. Keep bounded aggregate state.
export function createRequestLogger({ write = console.log, now = Date.now, intervalMs = 300_000 } = {}) {
  let emptyClaims = 0
  let windowStart = now()
  return (req, res, next) => {
    const path = logPath(req)
    res.once('finish', () => {
      const time = now()
      const quiet = isEmptyWorkerClaim(req, res)
      if (quiet) emptyClaims += 1
      if (emptyClaims && time - windowStart >= intervalMs) {
        write(`[Worker idle] ${emptyClaims} successful empty claims in ${Math.round((time - windowStart) / 1000)}s`)
        emptyClaims = 0
        windowStart = time
      }
      if (!quiet) write(`[${new Date(time).toISOString()}] ${req.method} ${path} ${res.statusCode} actor=${logActor(req).username}`)
    })
    next()
  }
}
