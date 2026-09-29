import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { TRANSLATION_TASK_TYPE, projectTranslationInput, normalizeTranslationResult } from './ragQueryTranslationContract.js'

// Optional request-scoped enhancement. Uses the synchronous authoritative SQLite
// TaskStore; it deliberately does not deduplicate tasks between request lifetimes.
export function createQueryTranslationService({ enabled = false, taskStore, model,
  workerAvailable = () => false, timeoutMs = 2000, pollMs = 25, onCleanupError = () => {} } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000 ||
      !Number.isInteger(pollMs) || pollMs < 1 || pollMs > 100) throw new TypeError('Invalid translation budget')
  return {
    async translate({ query, signal } = {}) {
      if (typeof query !== 'string' || !query.trim() || query.length > 1024) throw new TypeError('Invalid query')
      signal?.throwIfAborted()
      const fallback = status => ({ status, queries: [query] })
      if (!enabled) return fallback('disabled')
      if (!/\p{Script=Han}/u.test(query)) return fallback('not_applicable')
      const deadline = performance.now() + timeoutMs
      const expiresAt = Date.now() + timeoutMs
      const controller = new AbortController()
      const abort = () => controller.abort(signal.reason)
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(new Error('Translation deadline')), timeoutMs)
      let task, input, rejectOnAbort
      const stopped = new Promise((_, reject) => {
        rejectOnAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
      })
      // A stopped promise remains observed while polling, even after availability resolved.
      stopped.catch(() => {})
      try {
        if (!taskStore || !model) return fallback('unavailable')
        input = projectTranslationInput({ schemaVersion: 1, requestId: randomUUID(), query,
          querySha256: createHash('sha256').update(query).digest('hex'),
          modelId: model.modelId, modelRevision: model.modelRevision, expiresAt })
        const available = await Promise.race([stopped, Promise.resolve().then(() => workerAvailable({
          taskType: TRANSLATION_TASK_TYPE, model, signal: controller.signal
        }))])
        controller.signal.throwIfAborted()
        if (performance.now() >= deadline) return fallback('timeout')
        if (available !== true) return fallback('unavailable')
        task = taskStore.enqueue({ taskType: TRANSLATION_TASK_TYPE, processorVersion: 'v1', executionClass: 'gpu',
          subjectType: 'rag-query-translation', subjectId: input.requestId, subjectVersionId: 'v1',
          subjectContentSha256: input.querySha256, priority: 100, maxAttempts: 1, input }).task
        while (performance.now() < deadline) {
          controller.signal.throwIfAborted()
          const current = taskStore.getById(task.id)
          if (!current) return fallback('unavailable')
          if (current.status === 'succeeded') {
            const output = normalizeTranslationResult(current.result, { input }).output
            return { status: output.status, queries: output.queries }
          }
          if (['failed', 'cancelled'].includes(current.status)) return fallback('unavailable')
          await delay(Math.min(pollMs, Math.max(1, deadline - performance.now())), undefined, { signal: controller.signal })
        }
        return fallback('timeout')
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error
        return fallback(controller.signal.aborted || performance.now() >= deadline ? 'timeout' : 'unavailable')
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        controller.signal.removeEventListener('abort', rejectOnAbort)
        // Read current lease credentials from the authority, never from a client.
        // Retry a bounded read/cancel race; terminal states and other requests stay untouched.
        if (task) for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const current = taskStore.getById(task.id)
            if (!current || !['pending', 'leased', 'running'].includes(current.status)) break
            taskStore.cancel({ id: task.id, ...(current.status === 'pending' ? {} : { owner: current.leaseOwner, token: current.leaseToken }) })
            break
          } catch {
            if (attempt === 1) {
              try { onCleanupError({ code: 'TRANSLATION_CLEANUP_DEFERRED', taskId: task.id }) } catch { /* diagnostics must not break fail-open */ }
            }
          }
        }
      }
    }
  }
}
