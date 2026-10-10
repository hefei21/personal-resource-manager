// Mirrored in pc-worker/src/ragQuestionPlan.js; contract parity is tested.
// Syntax-only segmentation never invents requirements or drops question text.
export function questionSpans(query) {
  if (typeof query !== 'string' || !query.trim()) throw new TypeError('Question required')
  const text = query.trim(), parts = [], stack = []
  const pairs = new Map([['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['（', '）'], ['(', ')'], ['[', ']'], ['{', '}']])
  let quote = null, code = 0, start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') { i++; continue }
    if (ch === '`') {
      let n = 1
      while (text[i + n] === '`') n++
      if (!code) code = n
      else if (code === n) code = 0
      i += n - 1
      continue
    }
    if (code) continue
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || (ch === "'" && !/[\p{L}\p{N}]/u.test(text[i - 1] ?? ''))) { quote = ch; continue }
    if (pairs.has(ch)) { stack.push(pairs.get(ch)); continue }
    if (stack.at(-1) === ch) { stack.pop(); continue }
    if (stack.length) continue
    if (ch === '?' || ch === '？') {
      if (ch === '?' && /https?:\/\/\S*$/iu.test(text.slice(0, i).split(/\s/u).at(-1))) continue
      parts.push(text.slice(start, i + 1)); start = i + 1
    }
  }
  if (quote || code || stack.length) return [text]
  if (start < text.length) parts.push(text.slice(start))
  const result = parts.map(s => s.trim()).filter(Boolean)
  return result.length > 8 ? [text] : result.length ? result : [text]
}

export function validateQuestionPlan(plan, evidence) {
  const invalid = () => { throw new TypeError('Invalid question plan') }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
      Object.keys(plan).sort().join(',') !== 'groups,question,spans') invalid()
  if (typeof plan.question !== 'string' || !plan.question.trim() || Buffer.byteLength(plan.question) > 16384 ||
      /[\u0000-\u001f\u007f]/u.test(plan.question)) invalid()
  if (!Array.isArray(plan.spans) || JSON.stringify(plan.spans) !== JSON.stringify(questionSpans(plan.question))) invalid()
  if (!Array.isArray(plan.groups) || plan.groups.length > 64 ||
      plan.groups.some(g => !Array.isArray(g) || !g.length || g.some(id => typeof id !== 'string'))) invalid()
  const ids = plan.groups.flat(), allowed = evidence.map(e => e.citationId)
  if (ids.length !== allowed.length || new Set(ids).size !== ids.length || ids.some(id => !allowed.includes(id))) invalid()
  return { question: plan.question, spans: [...plan.spans], groups: plan.groups.map(g => [...g]) }
}

// Called only after authorization and budgeting. Grouping changes presentation,
// never text, citation identity, source scope, or the selected evidence set.
export function createQuestionPlan(question, selected) {
  const scopes = new Map(), blocks = []
  for (const [position, item] of selected.entries()) {
    const c = item.candidate, loc = c?.locator ?? {}
    if (!Number.isSafeInteger(c?.ordinal) || !c?.sourceType || !c?.sourceId || !c?.snapshotId ||
        !c?.sourceVersionId || !c?.sourceContentSha256 ||
        !(loc.sectionPath?.length >= 2 || Number.isSafeInteger(loc.chapterIndex))) {
      blocks.push({ position, ids: [item.citationId] }); continue
    }
    const key = JSON.stringify([c.sourceType, c.sourceId, c.snapshotId, c.sourceVersionId, c.sourceContentSha256,
      loc.sectionPath ?? [], loc.chapterIndex, loc.path, loc.page])
    if (!scopes.has(key)) scopes.set(key, [])
    scopes.get(key).push({ item, position, ordinal: c.ordinal })
  }
  for (const entries of scopes.values()) {
    entries.sort((a, b) => a.ordinal - b.ordinal)
    let run = []
    const flush = () => {
      if (run.length) blocks.push({ position: Math.min(...run.map(x => x.position)), ids: run.map(x => x.item.citationId) })
      run = []
    }
    for (const entry of entries) {
      if (run.length && entry.ordinal !== run.at(-1).ordinal + 1) flush()
      run.push(entry)
    }
    flush()
  }
  return validateQuestionPlan({ question, spans: questionSpans(question), groups: blocks.sort((a, b) => a.position - b.position).map(x => x.ids) }, selected)
}

export function slotSchema(plan, evidence) {
  const keys = plan.spans.map((_, i) => `Q${i + 1}`)
  return { name: 'rag_question_slots_v1', strict: true, schema: {
    type: 'object', additionalProperties: false,
    properties: Object.fromEntries(keys.map(key => [key, { type: 'object', additionalProperties: false,
      properties: { status: { type: 'string', enum: ['supported', 'partial', 'unsupported'] }, answer: { type: 'string' },
        citations: { type: 'array', items: { type: 'string', enum: evidence.map(e => e.citationId) }, uniqueItems: true },
        missing: { type: 'array', items: { type: 'string' } } }, required: ['status', 'answer', 'citations', 'missing'] }])), required: keys
  } }
}

export function mapQuestionSlots(value, plan, evidence) {
  const invalid = () => { throw new TypeError('Invalid slot result') }
  const keys = plan.spans.map((_, i) => `Q${i + 1}`), allowed = evidence.map(e => e.citationId)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.slice().sort().join(',')) invalid()
  const entries = keys.map((key, i) => {
    const x = value[key]
    if (!x || Object.keys(x).sort().join(',') !== 'answer,citations,missing,status' ||
        !['supported', 'partial', 'unsupported'].includes(x.status) || typeof x.answer !== 'string' ||
        !Array.isArray(x.citations) || x.citations.some(id => !allowed.includes(id)) || new Set(x.citations).size !== x.citations.length ||
        !Array.isArray(x.missing) || x.missing.some(s => typeof s !== 'string' || !s.trim())) invalid()
    let status = x.status
    if (status === 'partial' && !x.answer.trim() && !x.citations.length && x.missing.length) status = 'unsupported'
    if (status === 'unsupported' ? x.answer.trim() || x.citations.length : !x.answer.trim() || !x.citations.length) invalid()
    if (status === 'supported' && x.missing.length || status === 'partial' && !x.missing.length) invalid()
    return { ...x, status, question: plan.spans[i] }
  })
  const supported = entries.filter(x => x.status !== 'unsupported')
  const missing = entries.flatMap(x => x.status === 'unsupported' ? [x.question] : x.missing)
  return { abstained: !supported.length, reasonCode: !supported.length ? 'EVIDENCE_INSUFFICIENT' : missing.length ? 'PARTIAL' : 'GROUNDED',
    missingRequirements: supported.length ? missing : [], answer: supported.map(x => x.answer).join('\n\n'), citations: [...new Set(supported.flatMap(x => x.citations))] }
}

export function slotSystemPrompt(original) {
  const prefix = original.indexOf('If multiple requirements are asked')
  const start = original.indexOf('Cite only evidence that directly supports')
  const end = original.indexOf('If the evidence supports no answer')
  if (prefix < 0 || start < prefix || end < start) throw new TypeError('Answer policy changed')
  return original.slice(0, prefix) + 'Answer the user question using the fixed question slots below. Every slot is a literal span of the original question, not a separate new question; interpret pronouns and qualifiers using the entire original question. Return exactly the required slot object, with no final-answer wrapper. For each slot: supported means all its requested facts are directly supported; partial means some are supported and others missing; unsupported means none are supported. Answer only the directly supported requested facts, without additional examples or topic commentary. List missing requested facts in missing; use empty answer/citations for unsupported and empty missing for supported. Citations must identify evidence directly supporting this slot. Do not turn absence from supplied evidence into a claim about an entire source. ' +
    'JSON serialization requirement: Finish the complete answer before closing its JSON string. Any ASCII double quotation mark within answer text must be escaped as ' + String.fromCharCode(92, 34) + ' in the JSON output; do not close the answer string when quoting evidence or code. ' +
    original.slice(start, end) + ' Unresolved conflicting evidence does not support a definite answer: mark the affected slot unsupported and do not choose a fact arbitrarily.'
}
