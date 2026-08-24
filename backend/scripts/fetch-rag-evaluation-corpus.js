import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const fixtureUrl = new URL('../test/fixtures/rag-evaluation-corpus.json', import.meta.url)
const outputDirectory = path.resolve(process.argv[2] || '.rag-evaluation-corpus')
const maxBytes = 5 * 1024 * 1024

const fixture = JSON.parse(await fs.readFile(fixtureUrl, 'utf8'))
await fs.mkdir(outputDirectory, { recursive: true })
const manifest = []

for (const source of fixture.publicSources) {
  if (typeof source.downloadUrl !== 'string' || !source.downloadUrl.startsWith('https://')) {
    throw new TypeError(`downloadUrl is invalid for ${source.id}`)
  }
  const response = await fetch(source.downloadUrl, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`download failed for ${source.id}: ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0 || buffer.length > maxBytes || buffer.includes(0)) {
    throw new Error(`downloaded content is invalid for ${source.id}`)
  }
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
  if (sha256 !== source.sourceSha256) {
    throw new Error(`source hash mismatch for ${source.id}: ${sha256}`)
  }
  const target = path.join(outputDirectory, `${source.id}.txt`)
  await fs.writeFile(target, buffer, { flag: 'w', mode: 0o600 })
  manifest.push(Object.freeze({ id: source.id, bytes: buffer.length, sha256, file: path.basename(target) }))
}

await fs.writeFile(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, sources: manifest }, null, 2)}\n`, {
  flag: 'w',
  mode: 0o600
})
console.log(`RAG_CORPUS_FETCH ${JSON.stringify({ outputDirectory, sources: manifest })}`)
