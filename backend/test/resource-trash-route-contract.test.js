import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.resolve(testDirectory, '..')
const routeSource = fs.readFileSync(path.join(backendRoot, 'src/routes/resourceTrash.js'), 'utf8')
const indexSource = fs.readFileSync(path.join(backendRoot, 'src/index.js'), 'utf8')

test('unified trash is mounted owner-only and keeps destructive writes explicit', () => {
  assert.match(indexSource, /app\.use\('\/api\/trash', \.\.\.ownerOnly, resourceTrashRoutes\)/u)
  assert.match(routeSource, /router\.get\('\/', authenticateToken,/u)
  assert.match(routeSource, /router\.post\('\/batch-restore', authenticateToken, requireWritePermission,/u)
  assert.match(routeSource, /router\.post\('\/:type\/:id\/restore', authenticateToken, requireWritePermission,/u)
  assert.match(routeSource, /router\.delete\('\/:type\/:id', authenticateToken, requireWritePermission,/u)
})

test('batch restore returns per-item outcomes instead of rolling back successful resources', () => {
  assert.match(routeSource, /for \(const item of selection\)/u)
  assert.match(routeSource, /success: true/u)
  assert.match(routeSource, /success: false/u)
  assert.match(routeSource, /summary: \{ requested: results\.length, succeeded, failed:/u)
})
