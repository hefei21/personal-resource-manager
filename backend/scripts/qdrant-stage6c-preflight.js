const baseUrl = (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/+$/u, '')
const collection = process.env.QDRANT_COLLECTION || 'stage6c_preflight'
const mode = process.argv[2] || 'all'

async function request(path, { method = 'GET', body, expected = [200] } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  })
  const payload = await response.json().catch(() => null)
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${path} failed with ${response.status}: ${JSON.stringify(payload)}`)
  }
  return payload
}

async function seed() {
  await request(`/collections/${collection}`, { method: 'DELETE', expected: [200, 404] })
  await request(`/collections/${collection}`, {
    method: 'PUT',
    body: { vectors: { size: 4, distance: 'Cosine' }, on_disk_payload: true }
  })
  for (const field of ['owner_scope', 'snapshot_id', 'lifecycle']) {
    await request(`/collections/${collection}/index?wait=true`, {
      method: 'PUT',
      body: { field_name: field, field_schema: 'keyword' }
    })
  }
  await request(`/collections/${collection}/points?wait=true`, {
    method: 'PUT',
    body: {
      points: [
        { id: 1, vector: [1, 0, 0, 0], payload: { owner_scope: 'owner', snapshot_id: 'active-1', lifecycle: 'active' } },
        { id: 2, vector: [0.99, 0.01, 0, 0], payload: { owner_scope: 'owner', snapshot_id: 'stale-1', lifecycle: 'stale' } },
        { id: 3, vector: [0.98, 0.02, 0, 0], payload: { owner_scope: 'other', snapshot_id: 'active-2', lifecycle: 'active' } }
      ]
    }
  })
}

async function verify(targetCollection = collection) {
  const health = await request('/healthz')
  const count = await request(`/collections/${targetCollection}`)
  if (count?.result?.points_count !== 3) throw new Error(`expected 3 persisted points, got ${count?.result?.points_count}`)
  const query = await request(`/collections/${targetCollection}/points/query`, {
    method: 'POST',
    body: {
      query: [1, 0, 0, 0],
      limit: 10,
      with_payload: true,
      filter: {
        must: [
          { key: 'owner_scope', match: { value: 'owner' } },
          { key: 'snapshot_id', match: { value: 'active-1' } },
          { key: 'lifecycle', match: { value: 'active' } }
        ]
      }
    }
  })
  const points = query?.result?.points ?? []
  if (points.length !== 1 || points[0].id !== 1) {
    throw new Error(`payload filter leaked stale or unauthorized points: ${JSON.stringify(points)}`)
  }
  return { health: health?.title ?? 'ok', pointsCount: count.result.points_count, filteredPointIds: points.map((point) => point.id) }
}

async function recover() {
  const snapshots = await request(`/collections/${collection}/snapshots`)
  const latest = snapshots?.result?.toSorted((left, right) => String(right.creation_time).localeCompare(String(left.creation_time)))[0]
  if (typeof latest?.name !== 'string' || !latest.name) throw new Error('snapshot to recover is missing')
  const recoveredCollection = `${collection}_recovered`
  await request(`/collections/${recoveredCollection}`, { method: 'DELETE', expected: [200, 404] })
  await request(`/collections/${recoveredCollection}/snapshots/recover?wait=true`, {
    method: 'PUT',
    body: {
      location: `file:///qdrant/snapshots/${collection}/${latest.name}`,
      priority: 'snapshot'
    }
  })
  return Object.freeze({ snapshotName: latest.name, recoveredCollection, verification: await verify(recoveredCollection) })
}

async function snapshot() {
  const created = await request(`/collections/${collection}/snapshots?wait=true`, { method: 'POST' })
  const name = created?.result?.name
  if (typeof name !== 'string' || !name) throw new Error('snapshot name is missing')
  const listed = await request(`/collections/${collection}/snapshots`)
  if (!listed?.result?.some((item) => item.name === name)) throw new Error('created snapshot was not listed')
  return { name, size: created.result.size, checksum: created.result.checksum }
}

try {
  const output = { baseUrl, collection, mode }
  if (mode === 'seed' || mode === 'all') await seed()
  if (mode === 'verify' || mode === 'all') output.verification = await verify()
  if (mode === 'snapshot' || mode === 'all') output.snapshot = await snapshot()
  if (mode === 'recover') output.recovery = await recover()
  if (!['seed', 'verify', 'snapshot', 'recover', 'all'].includes(mode)) throw new Error(`unsupported mode: ${mode}`)
  console.log(`QDRANT_STAGE6C_PREFLIGHT ${JSON.stringify(output)}`)
} catch (error) {
  console.error(`QDRANT_STAGE6C_PREFLIGHT_FAILED ${error?.stack || error}`)
  process.exitCode = 1
}
