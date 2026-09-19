import { ref, onBeforeUnmount } from 'vue'
import api from '@/api'

// Each repository owns a serial request loop. Only known active tasks are polled;
// a transport failure stops that loop until an explicit refresh.
export function useRepositoryTasks(onCompleted = () => {}, client = api.code) {
  const cloneStatuses = ref(new Map()), syncStatuses = ref(new Map()), errors = ref(new Map())
  const timers = new Map(), pending = new Map(), rerun = new Set()
  let disposed = false
  const active = (value) => ['cloning', 'syncing'].includes(value?.status)
  async function refresh(repoId) {
    const key = String(repoId)
    if (disposed) return
    clearTimeout(timers.get(key)); timers.delete(key)
    if (pending.has(key)) { rerun.add(key); return pending.get(key) }
    const request = (async () => {
      const wasActive = active(cloneStatuses.value.get(key)) || active(syncStatuses.value.get(key))
      try {
        const [clone, sync] = await Promise.all([client.getCloneStatus(repoId), client.getSyncStatus(repoId)])
        if (disposed) return
        const valid = (response) => ['cloning', 'syncing', 'completed', 'failed'].includes(response.data?.data?.status) ? response.data.data : null
        cloneStatuses.value.set(key, valid(clone)); syncStatuses.value.set(key, valid(sync)); errors.value.delete(key)
        const values = [cloneStatuses.value.get(key), syncStatuses.value.get(key)]
        if (values.some(active)) timers.set(key, setTimeout(() => refresh(repoId), 1500))
        else if (wasActive && values.some((value) => value?.status === 'completed')) onCompleted(repoId)
      } catch {
        if (!disposed) errors.value.set(key, '任务状态暂不可用，已暂停刷新')
      } finally {
        pending.delete(key)
        if (!disposed && rerun.delete(key)) refresh(repoId)
      }
    })()
    pending.set(key, request)
    return request
  }
  function track(repoId, kind = 'sync') {
    const statuses = kind === 'clone' ? cloneStatuses : syncStatuses
    statuses.value.set(String(repoId), { status: kind === 'clone' ? 'cloning' : 'syncing', progress: 0 })
    return refresh(repoId)
  }
  function latest(repoId) {
    const values = [cloneStatuses.value.get(String(repoId)), syncStatuses.value.get(String(repoId))].filter(Boolean)
    return values.find(active) || values.sort((a, b) => (b.startTime || 0) - (a.startTime || 0))[0]
  }
  onBeforeUnmount(() => { disposed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); rerun.clear() })
  return { cloneStatuses, syncStatuses, errors, refresh, track, latest }
}
