<template>
  <section class="task-focus" aria-label="指定任务详情" aria-live="polite">
    <header><strong>任务 #{{ taskId }}</strong><RouterLink :to="{ path: '/tasks' }">关闭详情</RouterLink></header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="loading && !task">正在读取任务…</p>
    <template v-if="task">
      <div class="task-focus-summary"><strong>{{ taskTypeLabel(task.taskType) }}</strong><NativeTag :theme="taskStatusTheme(task)">{{ taskStatusLabel(task) }}</NativeTag></div>
      <p>{{ taskStageLabel(task) }} · {{ taskSourcePresentation(task).title }}</p>
      <p v-if="task.errorCode" role="status">{{ taskErrorLabel(task.errorCode) }} <small>{{ task.errorCode }}</small></p>
      <RouterLink v-if="sourceRoute" :to="sourceRoute">打开来源</RouterLink>
    </template>
    <footer>
      <NativeButton size="small" variant="outline" :loading="loading" @click="load">刷新此任务</NativeButton>
      <NativeButton v-if="task && taskCanRetry(task)" size="small" :disabled="loading" @click="$emit('action', 'retry', task)">重试</NativeButton>
      <NativeButton v-else-if="task && ['pending', 'leased', 'running'].includes(task.status)" size="small" variant="text" :disabled="loading" @click="$emit('action', 'cancel', task)">取消任务</NativeButton>
      <small>仅在打开、操作后或主动刷新时更新</small>
    </footer>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import api from '@/api'
import { NativeButton, NativeTag } from '@/components/native'
import { taskCanRetry, taskErrorLabel, taskSourcePresentation, taskStageLabel, taskStatusLabel, taskStatusTheme, taskTypeLabel } from '@/domain/taskPresentation'
const props = defineProps({ taskId: { type: String, required: true } })
defineEmits(['action'])
const task = ref(null), error = ref(''), loading = ref(false)
let generation = 0
const sourceRoute = computed(() => {
  const route = taskSourcePresentation(task.value).route
  return typeof route === 'string' && /^\/(?!\/)/.test(route) ? route : null
})
async function load() {
  const token = ++generation
  loading.value = true; error.value = ''
  try {
    const response = await api.tasks.get(props.taskId)
    if (token === generation) {
      if (!response.data?.data) throw new Error('Missing task')
      task.value = response.data.data
    }
  } catch (failure) {
    if (token === generation) error.value = failure.response?.status === 404 ? '任务不存在或已按保留规则清理。' : '暂时无法读取任务，请重试。'
  } finally { if (token === generation) loading.value = false }
}
watch(() => props.taskId, () => { task.value = null; load() }, { immediate: true })
onBeforeUnmount(() => { generation += 1 })
defineExpose({ load })
</script>

<style scoped>
.task-focus{padding:20px;margin-bottom:18px;border:1px solid var(--color-border-subtle);border-radius:12px;background:var(--color-surface-raised);color:var(--color-text-primary)}
header,.task-focus-summary,footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header{justify-content:space-between;margin-bottom:16px}.task-focus p,small{color:var(--color-text-secondary)}.task-focus p{line-height:1.6}.task-focus a{color:var(--color-primary);font-size:14px}footer{margin-top:16px}small{font-size:12px}header a{min-height:36px;display:inline-flex;align-items:center}@media(max-width:768px){.task-focus{padding:16px}header a{min-height:44px}}
</style>
