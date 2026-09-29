import { computed, ref } from 'vue'

const ACTIVE = new Set(['pending', 'queued', 'leased', 'running', 'active'])
const FINISHED = new Set(['complete', 'partial', 'answered', 'succeeded', 'completed', 'abstained', 'degraded'])
const idOf = data => String(data?.runId ?? data?.queryId ?? data?.id ?? '').trim()

// A pending response includes empty answer/citations too. Status always wins.
export function classifyRagResponse(response) {
  const data = response?.data?.data
  if (!data || typeof data !== 'object') throw new Error('Missing query state')
  const status = String(data.status || '').toLowerCase()
  if (['cancelled', 'canceled'].includes(status)) return { kind: 'cancelled', data }
  if (['failed', 'error'].includes(status)) {
    throw Object.assign(new Error('Query failed'), {
      terminal: true, response: { data: { code: data.errorCode || 'RAG_QUERY_FAILED' } }
    })
  }
  if (ACTIVE.has(status) || response.status === 202) return { kind: 'active', data }
  if (FINISHED.has(status)) return { kind: 'finished', data }
  throw new Error('Unknown query state')
}

export function useRagQuery({ api, errorLabel, normalizeResult, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const state = ref('idle')
  const result = ref(null)
  const feedback = ref('')
  const queryId = ref('')
  const cancellable = ref(false)
  const phase = ref('')
  const loading = computed(() => ['submitting', 'enhancing', 'polling', 'cancelling'].includes(state.value))
  let submission = null
  let generation = 0
  let timer = null
  let disposed = false
  const current = token => !disposed && token === generation
  function stop() { if (timer !== null) clearTimer(timer); timer = null }
  function abandon(id) { if (id) Promise.resolve().then(() => api.cancelQuery(id)).catch(() => {}) }
  function reset() {
    generation += 1
    submission?.abort()
    submission = null
    stop()
    abandon(queryId.value)
    queryId.value = ''
    state.value = 'idle'
    result.value = null
    feedback.value = ''
    cancellable.value = false
    phase.value = ''
  }
  function receive(response, token) {
    const { kind, data } = classifyRagResponse(response)
    if (kind === 'active') {
      if (Array.isArray(data.evidence)) result.value = normalizeResult(data)
      queryId.value = idOf(data) || queryId.value
      if (!queryId.value) throw new Error('Missing query id')
      phase.value = ['pending', 'queued'].includes(data.status) ? 'queued' : 'running'
      cancellable.value = data.cancellable === true
      state.value = 'polling'
      stop()
      timer = setTimer(() => poll(token), 1200)
      return
    }
    stop()
    queryId.value = ''
    cancellable.value = false
    if (kind === 'cancelled') { state.value = 'cancelled'; return }
    result.value = normalizeResult(data)
    state.value = result.value.degraded ? 'degraded' : result.value.abstained ? 'abstained' :
      result.value.partial || data.status === 'partial' ? 'partial' : 'answered'
  }
  function fail(error) {
    stop()
    if (error.terminal || [401, 403, 404].includes(error.response?.status)) queryId.value = ''
    if (!queryId.value) cancellable.value = false
    state.value = queryId.value ? 'paused' : 'error'
    feedback.value = queryId.value
      ? '暂时无法读取回答状态，后台任务可能仍在进行。恢复连接后可继续查询，不会重复提问。'
      : errorLabel(error)
  }
  async function poll(token = generation) {
    if (!current(token) || !queryId.value) return
    try {
      const response = await api.getQuery(queryId.value)
      if (current(token)) receive(response, token)
    } catch (error) { if (current(token)) fail(error) }
  }
  async function submit(payload) {
    if (disposed || loading.value) return
    reset()
    const token = generation
    const controller = new AbortController()
    submission = controller
    state.value = 'submitting'
    try {
      let response = await api.createQuery({ ...payload, phase: 'evidence' }, { signal: controller.signal })
      if (current(token) && response?.data?.data?.status === 'evidence' && response.data.data.enhancementRequired === true) {
        result.value = normalizeResult(response.data.data)
        state.value = 'enhancing'
        phase.value = 'enhancing'
        cancellable.value = true
        response = await api.createQuery({ ...payload, phase: 'enhanced' }, { signal: controller.signal, timeout: 240000 })
      }
      if (!current(token)) {
        if (ACTIVE.has(response?.data?.data?.status) || response.status === 202) abandon(idOf(response.data?.data))
        return
      }
      receive(response, token)
    } catch (error) { if (current(token)) fail(error) }
    finally { if (submission === controller) submission = null }
  }
  async function resume() {
    if (disposed || state.value !== 'paused' || !queryId.value) return
    feedback.value = ''
    state.value = 'polling'
    await poll(generation)
  }
  async function cancel() {
    if (disposed || state.value === 'cancelling') return
    const token = ++generation
    submission?.abort()
    submission = null
    stop()
    const id = queryId.value
    if (!id) { state.value = 'cancelled'; cancellable.value = false; return }
    state.value = 'cancelling'
    feedback.value = ''
    try {
      const response = await api.cancelQuery(id)
      if (current(token)) receive(response, token)
    } catch (error) {
      if (!current(token)) return
      if (error.response?.status === 409) {
        // Completion may have won the race with cancellation; read its true state.
        state.value = 'polling'
        await poll(token)
      } else {
        fail(error)
        if (queryId.value) feedback.value = '尚未确认取消，后台任务可能仍在进行。请继续查询状态或重试取消。'
      }
    }
  }
  function dispose() { reset(); disposed = true }
  return { state, result, feedback, queryId, cancellable, phase, loading, submit, resume, cancel, reset, dispose }
}
