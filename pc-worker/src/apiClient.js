export class WorkerApiError extends Error {
  constructor(code, message, status, options = {}) {
    super(message, options)
    this.name = 'WorkerApiError'
    this.code = code
    this.status = status
  }
}

async function parseError(response) {
  try {
    const body = await response.json()
    return typeof body?.code === 'string' ? body.code : `HTTP_${response.status}`
  } catch {
    return `HTTP_${response.status}`
  }
}

export class WorkerApiClient {
  constructor({ baseUrl, requestTimeoutMs = 30_000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl
    this.requestTimeoutMs = requestTimeoutMs
    this.fetch = fetchImpl
  }

  async request(path, { method = 'GET', token, leaseToken, body, raw = false } = {}) {
    const headers = { accept: raw ? 'application/octet-stream' : 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    if (leaseToken) headers['x-worker-lease'] = leaseToken
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response
    try {
      response = await this.fetch(`${this.baseUrl}/api/pc-worker-agent${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      })
    } catch (error) {
      throw new WorkerApiError('WORKER_NETWORK_UNAVAILABLE', 'NAS request failed.', 0, { cause: error })
    }
    if (!response.ok) {
      throw new WorkerApiError(await parseError(response), 'NAS rejected the Worker request.', response.status)
    }
    if (raw) return response
    if (response.status === 204) return null
    const payload = await response.json()
    return payload.data
  }

  enroll(enrollmentToken, profile) {
    return this.request('/enroll', { method: 'POST', body: { enrollmentToken, profile } })
  }

  refresh(refreshToken) {
    return this.request('/refresh', { method: 'POST', body: { refreshToken } })
  }

  updateProfile(accessToken, profile) {
    return this.request('/profile', { method: 'PUT', token: accessToken, body: profile })
  }

  claim(accessToken) {
    return this.request('/tasks/claim', { method: 'POST', token: accessToken, body: {} })
  }

  start(accessToken, task) {
    return this.request(`/tasks/${task.id}/start`, {
      method: 'POST', token: accessToken, body: { leaseToken: task.leaseToken }
    })
  }

  heartbeat(accessToken, task, progress) {
    return this.request(`/tasks/${task.id}/heartbeat`, {
      method: 'POST', token: accessToken,
      body: { leaseToken: task.leaseToken, ...(progress === undefined ? {} : { progress }) }
    })
  }

  input(accessToken, task) {
    return this.request(`/tasks/${task.id}/input`, {
      token: accessToken, leaseToken: task.leaseToken, raw: true
    })
  }

  complete(accessToken, task, result) {
    return this.request(`/tasks/${task.id}/complete`, {
      method: 'POST', token: accessToken, body: { leaseToken: task.leaseToken, result }
    })
  }

  async uploadArtifact(accessToken, task, { artifact, metadata } = {}) {
    if (!artifact || !metadata) throw new WorkerApiError('WORKER_ARTIFACT_UPLOAD_FAILED', 'Artifact metadata is missing.', 0)
    let serialized
    try { serialized = JSON.stringify(artifact) } catch (error) {
      throw new WorkerApiError('WORKER_ARTIFACT_UPLOAD_FAILED', 'Artifact cannot be serialized.', 0, { cause: error })
    }
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/octet-stream',
      'x-worker-lease': task.leaseToken,
      'x-artifact-sha256': metadata.artifactSha256,
      'x-artifact-bytes': String(metadata.artifactBytes),
      'x-artifact-section-count': String(metadata.sectionCount),
      'x-artifact-format': metadata.format
    }
    let response
    try {
      response = await this.fetch(`${this.baseUrl}/api/pc-worker-agent/tasks/${task.id}/artifact`, {
        method: 'POST', headers, body: serialized, signal: AbortSignal.timeout(this.requestTimeoutMs)
      })
    } catch (error) {
      throw new WorkerApiError('WORKER_ARTIFACT_UPLOAD_FAILED', 'Artifact upload failed.', 0, { cause: error })
    }
    if (!response.ok) throw new WorkerApiError(await parseError(response), 'NAS rejected the artifact upload.', response.status)
    if (response.status === 204) return null
    const payload = await response.json()
    return payload.data
  }

  fail(accessToken, task, errorCode, errorSummary, retryable) {
    return this.request(`/tasks/${task.id}/fail`, {
      method: 'POST', token: accessToken,
      body: { leaseToken: task.leaseToken, errorCode, errorSummary, retryable }
    })
  }
}
