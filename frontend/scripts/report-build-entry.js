import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const distRoot = resolve(process.argv[2] || fileURLToPath(new URL('../dist', import.meta.url)))
const indexHtml = readFileSync(join(distRoot, 'index.html'), 'utf8')
const initialPaths = [...indexHtml.matchAll(/(?:src|href)="\/?([^"?#]+\.(?:js|css))"/g)]
  .map(([, path]) => path)
  .filter((path, index, values) => values.indexOf(path) === index)

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })
}

const initial = initialPaths.map((path) => ({ path, bytes: statSync(join(distRoot, path)).size }))
const files = listFiles(distRoot)
const report = {
  initial,
  initialBytes: initial.reduce((sum, item) => sum + item.bytes, 0),
  javascriptCssBytes: files.filter((path) => /\.(?:js|css)$/i.test(path)).reduce((sum, path) => sum + statSync(path).size, 0),
  totalBytes: files.reduce((sum, path) => sum + statSync(path).size, 0),
  fileCount: files.length,
  distRoot: relative(process.cwd(), distRoot) || '.'
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
