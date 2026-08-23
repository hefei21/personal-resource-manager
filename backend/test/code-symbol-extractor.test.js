import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CODE_SYMBOL_EXTRACTOR_VERSION,
  codeSymbolLanguage,
  extractCodeSymbols
} from '../src/services/codeSymbolExtractor.js'

test('extracts stable JavaScript and TypeScript top-level symbols and class methods', () => {
  const content = `export async function fetchResource(id) {
  return id
}

export class SearchService {
  constructor(database) {
    this.database = database
  }

  async query(input) {
    return input
  }
}

export const SEARCH_VERSION = 'v1'
`
  assert.equal(CODE_SYMBOL_EXTRACTOR_VERSION, 'v1')
  assert.equal(codeSymbolLanguage('src/search.ts'), 'typescript')
  assert.deepEqual(extractCodeSymbols({ filePath: 'src/search.ts', content }), [
    {
      name: 'fetchResource', qualifiedName: 'fetchResource', kind: 'function', language: 'typescript',
      path: 'src/search.ts', startLine: 1, endLine: 3, signature: 'export async function fetchResource(id) {'
    },
    {
      name: 'SearchService', qualifiedName: 'SearchService', kind: 'class', language: 'typescript',
      path: 'src/search.ts', startLine: 5, endLine: 13, signature: 'export class SearchService {'
    },
    {
      name: 'constructor', qualifiedName: 'SearchService.constructor', kind: 'constructor', language: 'typescript',
      path: 'src/search.ts', startLine: 6, endLine: 8, signature: 'constructor(database) {'
    },
    {
      name: 'query', qualifiedName: 'SearchService.query', kind: 'method', language: 'typescript',
      path: 'src/search.ts', startLine: 10, endLine: 12, signature: 'async query(input) {'
    },
    {
      name: 'SEARCH_VERSION', qualifiedName: 'SEARCH_VERSION', kind: 'constant', language: 'typescript',
      path: 'src/search.ts', startLine: 15, endLine: 15, signature: "export const SEARCH_VERSION = 'v1'"
    }
  ])
})

test('extracts Python classes, methods and top-level functions while omitting nested functions', () => {
  const content = `class RepositoryIndexer:
    def __init__(self, repository):
        self.repository = repository

    async def index(self):
        return self.repository


def locate_symbol(name):
    def normalize(value):
        return value.strip()
    return normalize(name)
`
  assert.equal(codeSymbolLanguage('indexer.py'), 'python')
  assert.deepEqual(extractCodeSymbols({ filePath: 'lib/indexer.py', content }), [
    {
      name: 'RepositoryIndexer', qualifiedName: 'RepositoryIndexer', kind: 'class', language: 'python',
      path: 'lib/indexer.py', startLine: 1, endLine: 6, signature: 'class RepositoryIndexer:'
    },
    {
      name: '__init__', qualifiedName: 'RepositoryIndexer.__init__', kind: 'method', language: 'python',
      path: 'lib/indexer.py', startLine: 2, endLine: 3, signature: 'def __init__(self, repository):'
    },
    {
      name: 'index', qualifiedName: 'RepositoryIndexer.index', kind: 'method', language: 'python',
      path: 'lib/indexer.py', startLine: 5, endLine: 6, signature: 'async def index(self):'
    },
    {
      name: 'locate_symbol', qualifiedName: 'locate_symbol', kind: 'function', language: 'python',
      path: 'lib/indexer.py', startLine: 9, endLine: 12, signature: 'def locate_symbol(name):'
    }
  ])
})

test('ignores braces in JavaScript strings/comments and unsupported languages', () => {
  const content = `// fake() { }
export function real() {
  const text = "} not a block"
  return { ok: true }
}
`
  const [item] = extractCodeSymbols({ filePath: 'src/real.js', content })
  assert.equal(item.name, 'real')
  assert.equal(item.endLine, 5)
  assert.deepEqual(extractCodeSymbols({ filePath: 'main.go', content: 'func main() {}' }), [])
  assert.equal(codeSymbolLanguage('main.go'), null)
})

test('rejects invalid extractor input', () => {
  assert.throws(() => extractCodeSymbols({ filePath: '', content: '' }), /filePath/u)
  assert.throws(() => extractCodeSymbols({ filePath: 'file.js', content: null }), /content/u)
})
