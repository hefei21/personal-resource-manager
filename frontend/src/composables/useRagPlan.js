import { ref, watch } from 'vue'
import { useRagQuery } from './useRagQuery.js'

export function draftRagQuestions(question) {
  const original = String(question || '').trim()
  const parts = original.split(/[；;\n]+/).map(x => x.trim()).filter(Boolean)
  // Only explicit separators are drafts, not semantic/source inference.
  return parts.length >= 2 && parts.length <= 4 ? parts : [original, '']
}

export function validateRagPlan(rows, sources) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 4) return null
  const plan = rows.map(row => {
    const source = sources.find(item => item.key === row.sourceKey)
    const q = String(row.q || '').trim()
    return source && q && q.length <= 256
      ? { q, source: { type: source.type, id: source.id }, title: source.title } : null
  })
  return plan.every(Boolean) ? plan : null
}

// A plan is only executable after explicit confirmation. Every child still uses
// the server's normal authorization, snapshot validation and cancellation path.
export function useRagPlan(options) {
  const query = useRagQuery(options)
  const state = ref('draft')
  const items = ref([])
  let index = 0
  let stopped = false
  const unwatchResult = watch(query.result, value => {
    if (items.value[index] && state.value !== 'draft') items.value[index].result = value
  }, { flush: 'sync' })
  function run() {
    const item = items.value[index]
    item.status = 'running'
    void query.submit({ q: item.q, source: { ...item.source }, limit: 10 })
  }
  const unwatch = watch(query.state, value => {
    if (!items.value[index] || state.value === 'draft') return
    const item = items.value[index]
    item.status = value
    item.feedback = query.feedback.value
    if (['answered', 'partial', 'abstained', 'degraded'].includes(value)) {
      item.result = query.result.value
      if (stopped) { state.value = 'stopped'; return }
      index += 1
      if (index === items.value.length) state.value = 'complete'
      else run()
    } else if (['paused', 'error', 'cancelled'].includes(value)) {
      state.value = value === 'cancelled' ? 'stopped' : value
    }
  })
  function confirm(rows, sources) {
    if (state.value !== 'draft') return false
    const plan = validateRagPlan(rows, sources)
    if (!plan) return false
    items.value = plan.map(item => ({ ...item, status: 'waiting', result: null }))
    index = 0
    stopped = false
    state.value = 'running'
    run()
    return true
  }
  async function stop() {
    stopped = true
    state.value = 'stopped'
    await query.cancel()
  }
  async function resume() {
    if (state.value !== 'paused') return
    state.value = stopped ? 'stopped' : 'running'
    await query.resume()
  }
  function dispose() { unwatchResult(); unwatch(); query.dispose() }
  return { state, items, query, confirm, stop, resume, dispose }
}
