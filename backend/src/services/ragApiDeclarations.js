// Conservative original-RST provenance, never inferred from normalized chunks.
export const DECLARATION_VERSION = 1

export function declaredApiName(query) {
  if (typeof query !== 'string' || !/\p{Script=Han}/u.test(query)) return null
  const words = [...new Set(query.match(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}_-])+/gu) ?? [])]
    .filter(word => !/^\p{Script=Han}+$/u.test(word))
  return words.length === 1 && /^[a-z][a-z0-9]{2,31}$/u.test(words[0]) ? words[0] : null
}

export function sourceApiDeclarations(source) {
  // Multiple sections may represent different modules or extracted fragments.
  if (source.sections.length !== 1 || source.sections[0].format !== 'txt') return []
  const lines = source.sections[0].text.replace(/\r\n?/gu, '\n').split('\n')
  if (lines.some(line => /^\s*(?:```|~~~)/u.test(line))) return []
  const modules = lines.filter(line => /^\.\. (?:module|currentmodule):: [A-Za-z_][\w.]*[ \t]*$/u.test(line))
  if (modules.length !== 1) return []
  const module = modules[0].replace(/^\.\. (?:module|currentmodule):: /u, '').trim()
  let active = false
  const declarations = []
  const counts = new Map()
  for (const [index, line] of lines.entries()) {
    if (line === modules[0]) active = true
    const match = /^\.\. function:: ([a-z][a-z0-9]{2,31})(?:\(|[ \t]*$)/u.exec(line)
    if (active && match) {
      declarations.push({ name: match[1], module, line: index + 1 })
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
    }
  }
  return declarations.filter(item => counts.get(item.name) === 1)
}
