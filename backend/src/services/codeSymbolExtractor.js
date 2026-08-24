import path from 'node:path'

export const CODE_SYMBOL_EXTRACTOR_VERSION = 'v1'

const MAX_SOURCE_CHARACTERS = 1024 * 1024
const IDENTIFIER = '[A-Za-z_$][A-Za-z0-9_$]*'
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])
const PYTHON_EXTENSIONS = new Set(['.py'])
const JS_METHOD_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function'])

function sourceLanguage(filePath) {
  const extension = path.extname(String(filePath || '')).toLowerCase()
  if (JS_EXTENSIONS.has(extension)) return extension.includes('ts') ? 'typescript' : 'javascript'
  if (PYTHON_EXTENSIONS.has(extension)) return 'python'
  return null
}

function validateInput(filePath, content) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    throw new TypeError('filePath is invalid')
  }
  if (typeof content !== 'string' || content.length > MAX_SOURCE_CHARACTERS) {
    throw new TypeError('content is invalid')
  }
}

function stripJavaScript(lines) {
  let blockComment = false
  let quote = null
  let escaped = false
  return lines.map((line) => {
    let output = ''
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]
      const next = line[index + 1]
      if (blockComment) {
        if (character === '*' && next === '/') {
          blockComment = false
          output += '  '
          index += 1
        } else output += ' '
        continue
      }
      if (quote !== null) {
        output += ' '
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === quote) quote = null
        continue
      }
      if (character === '/' && next === '*') {
        blockComment = true
        output += '  '
        index += 1
      } else if (character === '/' && next === '/') {
        output += ' '.repeat(line.length - index)
        break
      } else if (character === '\'' || character === '"' || character === '`') {
        quote = character
        output += ' '
      } else output += character
    }
    return output
  })
}

function braceDepths(lines) {
  const depths = []
  let depth = 0
  for (const line of lines) {
    depths.push(depth)
    for (const character of line) {
      if (character === '{') depth += 1
      else if (character === '}') depth = Math.max(0, depth - 1)
    }
  }
  return depths
}

function javascriptBlockEnd(lines, startIndex) {
  let opened = false
  let depth = 0
  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    for (const character of lines[lineIndex]) {
      if (character === '{') {
        opened = true
        depth += 1
      } else if (character === '}' && opened) {
        depth -= 1
        if (depth === 0) return lineIndex + 1
      }
    }
  }
  return startIndex + 1
}

function signature(line) {
  return line.trim().replace(/\s+/gu, ' ').slice(0, 512)
}

function symbol({ name, qualifiedName = name, kind, language, filePath, startLine, endLine, declaration }) {
  return Object.freeze({
    name,
    qualifiedName,
    kind,
    language,
    path: filePath.replaceAll('\\', '/'),
    startLine,
    endLine: Math.max(startLine, endLine),
    signature: signature(declaration)
  })
}

function extractJavaScript(filePath, content, language) {
  const originalLines = content.replace(/\r\n?/gu, '\n').split('\n')
  const lines = stripJavaScript(originalLines)
  const depths = braceDepths(lines)
  const classes = []
  const symbols = []
  const classPattern = new RegExp(`^\\s*(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?class\\s+(${IDENTIFIER})\\b`, 'u')
  const functionPattern = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\*?\\s+(${IDENTIFIER})\\b`, 'u')
  const exportPattern = new RegExp(`^\\s*export\\s+(?:declare\\s+)?(?:const|let|var)\\s+(${IDENTIFIER})\\b`, 'u')
  const methodPattern = new RegExp(`^\\s*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\\s+)*(${IDENTIFIER})\\s*(?:<[^>]+>)?\\s*\\(`, 'u')

  for (let index = 0; index < lines.length; index += 1) {
    if (depths[index] !== 0) continue
    const match = lines[index].match(classPattern)
    if (!match) continue
    const endLine = javascriptBlockEnd(lines, index)
    const current = { name: match[1], startLine: index + 1, endLine, bodyDepth: depths[index] + 1 }
    classes.push(current)
    symbols.push(symbol({
      name: current.name,
      kind: 'class',
      language,
      filePath,
      startLine: current.startLine,
      endLine,
      declaration: originalLines[index]
    }))
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const containingClass = classes.find((item) => lineNumber > item.startLine && lineNumber < item.endLine)
    if (containingClass && depths[index] === containingClass.bodyDepth) {
      const match = lines[index].match(methodPattern)
      if (match && !JS_METHOD_KEYWORDS.has(match[1])) {
        symbols.push(symbol({
          name: match[1],
          qualifiedName: `${containingClass.name}.${match[1]}`,
          kind: match[1] === 'constructor' ? 'constructor' : 'method',
          language,
          filePath,
          startLine: lineNumber,
          endLine: javascriptBlockEnd(lines, index),
          declaration: originalLines[index]
        }))
      }
      continue
    }
    if (depths[index] !== 0 || classes.some((item) => item.startLine === lineNumber)) continue
    const functionMatch = lines[index].match(functionPattern)
    if (functionMatch) {
      symbols.push(symbol({
        name: functionMatch[1],
        kind: 'function',
        language,
        filePath,
        startLine: lineNumber,
        endLine: javascriptBlockEnd(lines, index),
        declaration: originalLines[index]
      }))
      continue
    }
    const exportMatch = lines[index].match(exportPattern)
    if (exportMatch) {
      symbols.push(symbol({
        name: exportMatch[1],
        kind: 'constant',
        language,
        filePath,
        startLine: lineNumber,
        endLine: lineNumber,
        declaration: originalLines[index]
      }))
    }
  }
  return symbols
}

function indentation(line) {
  let width = 0
  for (const character of line) {
    if (character === ' ') width += 1
    else if (character === '\t') width += 4
    else break
  }
  return width
}

function pythonBlockEnd(lines, startIndex, startIndent) {
  let endLine = startIndex + 1
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (indentation(lines[index]) <= startIndent) break
    endLine = index + 1
  }
  return endLine
}

function extractPython(filePath, content, language) {
  const lines = content.replace(/\r\n?/gu, '\n').split('\n')
  const definitions = []
  const classPattern = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/u
  const functionPattern = /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/u
  for (let index = 0; index < lines.length; index += 1) {
    const classMatch = lines[index].match(classPattern)
    const functionMatch = lines[index].match(functionPattern)
    if (!classMatch && !functionMatch) continue
    const indent = indentation(lines[index])
    definitions.push({
      name: (classMatch || functionMatch)[1],
      type: classMatch ? 'class' : 'function',
      indent,
      startLine: index + 1,
      endLine: pythonBlockEnd(lines, index, indent),
      declaration: lines[index]
    })
  }

  const symbols = []
  for (const definition of definitions) {
    const parents = definitions
      .filter((candidate) => candidate.startLine < definition.startLine &&
        candidate.endLine >= definition.startLine && candidate.indent < definition.indent)
      .sort((left, right) => right.indent - left.indent)
    const nearest = parents[0]
    if (nearest?.type === 'function') continue
    if (definition.type === 'class' && nearest) continue
    const isMethod = definition.type === 'function' && nearest?.type === 'class'
    symbols.push(symbol({
      name: definition.name,
      qualifiedName: isMethod ? `${nearest.name}.${definition.name}` : definition.name,
      kind: definition.type === 'class' ? 'class' : isMethod ? 'method' : 'function',
      language,
      filePath,
      startLine: definition.startLine,
      endLine: definition.endLine,
      declaration: definition.declaration
    }))
  }
  return symbols
}

export function extractCodeSymbols({ filePath, content } = {}) {
  validateInput(filePath, content)
  const language = sourceLanguage(filePath)
  if (language === null || content.length === 0) return Object.freeze([])
  const symbols = language === 'python'
    ? extractPython(filePath, content, language)
    : extractJavaScript(filePath, content, language)
  return Object.freeze(symbols.sort((left, right) =>
    left.startLine - right.startLine || left.qualifiedName.localeCompare(right.qualifiedName)))
}

export function codeSymbolLanguage(filePath) {
  return sourceLanguage(filePath)
}

export default extractCodeSymbols
