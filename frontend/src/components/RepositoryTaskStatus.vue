<template>
  <div v-if="error || task" class="repository-task" :class="{ failed: error || task?.status === 'failed' }" role="status">
    <span>{{ error || label }}</span>
    <span v-if="!error && active" class="task-progress">{{ Math.round(Math.min(100, Math.max(0, task.progress || 0))) }}%</span>
    <RouterLink v-if="task?.status === 'failed' && task?.taskId" class="task-link" to="/tasks">查看任务 #{{ task.taskId }}</RouterLink>
    <NativeButton v-if="error" size="small" variant="text" @click="emit('refresh')">刷新状态</NativeButton>
    <NativePopconfirm v-if="allowReclone && !error && task?.status === 'failed' && task?.code === 'REPOSITORY_DIRTY'" content="安全重克隆将保留旧文件为独立备份仓库，再获取远端内容。是否继续？" @confirm="emit('reclone')"><template #trigger><NativeButton size="small" variant="outline">安全重克隆</NativeButton></template></NativePopconfirm>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { NativeButton, NativePopconfirm } from '@/components/native'
import { taskErrorLabel } from '@/domain/taskPresentation'
const props = defineProps({ task: Object, error: String, allowReclone: Boolean })
const emit = defineEmits(['refresh', 'reclone'])
const active = computed(() => ['cloning', 'syncing'].includes(props.task?.status))
const label = computed(() => {
  if (props.task?.status === 'failed') return props.task.code === 'REPOSITORY_DIRTY' ? '同步暂停：仓库存在本地修改，原文件已保留。' : taskErrorLabel(props.task.code) || '任务未完成'
  return props.task?.status === 'cloning' ? '正在克隆' : props.task?.status === 'syncing' ? '正在同步' : '最近任务已完成'
})
</script>
<style scoped>
.repository-task{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;font-size:12px;line-height:1.6;color:var(--color-text-secondary)}.repository-task.failed{color:var(--color-danger)}.task-progress{font-variant-numeric:tabular-nums}
.task-link{color:var(--color-primary);text-decoration:none}.task-link:hover{text-decoration:underline}@media(max-width:767px){.task-link{display:inline-flex;align-items:center;min-height:44px}.repository-task :deep(button){min-height:44px}}
</style>
