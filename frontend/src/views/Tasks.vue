<template>
  <div class="tasks-page">
    <div class="tasks-heading">
      <div>
        <h1>任务中心</h1>
        <p class="tasks-subtitle">查看后台任务进度，管理仍在运行或失败的任务。</p>
      </div>
      <NativeButton theme="primary" :loading="store.loading" @click="handleRefresh">
        <template #icon><NativeIcon name="arrow-clockwise" /></template>
        刷新
      </NativeButton>
    </div>

    <NativeCard class="tasks-filter-card">
      <div class="tasks-filter-grid">
        <label class="tasks-filter-item">
          <span>状态</span>
          <NativeSelect
            :model-value="store.filter.status"
            placeholder="全部状态"
            :options="statusOptions"
            clearable
            @update:model-value="handleStatusChange"
          />
        </label>
        <label class="tasks-filter-item">
          <span>任务类型</span>
          <NativeSelect
            :model-value="store.filter.taskType"
            placeholder="全部类型"
            :options="taskTypeOptions"
            clearable
            @update:model-value="handleTaskTypeChange"
          />
        </label>
        <label class="tasks-filter-item">
          <span>排序</span>
          <NativeSelect
            :model-value="store.filter.order"
            :options="orderOptions"
            @update:model-value="handleOrderChange"
          />
        </label>
      </div>
    </NativeCard>

    <div v-if="store.error" class="tasks-feedback" role="alert">
      <span>{{ loadErrorMessage }}</span>
      <NativeButton size="small" variant="outline" @click="handleRefresh">重新加载</NativeButton>
    </div>

    <NativeCard class="tasks-list-card">
      <NativeLoading v-if="store.loading && store.tasks.length === 0" center text="加载任务中..." />
      <NativeEmpty
        v-else-if="store.tasks.length === 0"
        :description="store.error ? '暂时无法加载任务' : '暂无符合条件的任务'"
      >
        <template #action>
          <NativeButton v-if="store.error" size="small" @click="handleRefresh">重新加载</NativeButton>
        </template>
      </NativeEmpty>
      <template v-else>
        <div class="tasks-table" role="table" aria-label="任务列表">
          <div class="tasks-table-head" role="row">
            <div role="columnheader">任务</div>
            <div role="columnheader">来源资源</div>
            <div role="columnheader">进度</div>
            <div role="columnheader">尝试次数</div>
            <div role="columnheader">时间</div>
            <div role="columnheader">错误信息</div>
            <div role="columnheader">操作</div>
          </div>

          <article v-for="task in store.tasks" :key="task.id" class="task-row" role="row">
            <div class="task-cell task-cell--main" data-label="任务" role="cell">
              <strong>{{ taskTypeLabel(task.taskType) }}</strong>
              <NativeTag :theme="statusTheme(task.status)" variant="light">
                {{ statusLabel(task.status) }}
              </NativeTag>
            </div>
            <div class="task-cell task-cell--subject" data-label="来源资源" role="cell">
              {{ subjectLabel(task.subject) }}
            </div>
            <div class="task-cell task-cell--progress" data-label="进度" role="cell">
              <NativeProgress
                v-if="hasProgress(task)"
                :percentage="progressValue(task)"
                size="small"
                :status="task.status === 'failed' ? 'error' : task.status === 'succeeded' ? 'success' : 'primary'"
              />
              <span v-else class="tasks-muted">等待进度</span>
            </div>
            <div class="task-cell" data-label="尝试次数" role="cell">
              {{ attemptLabel(task) }}
            </div>
            <div class="task-cell task-cell--time" data-label="时间" role="cell">
              <span>{{ timestampLabel(task) }}</span>
              <small>创建于 {{ formatTime(task.timestamps?.createdAt) }}</small>
            </div>
            <div class="task-cell task-cell--error" data-label="错误信息" role="cell">
              <span v-if="task.errorCode" class="task-error-text">
                {{ taskErrorLabel(task.errorCode) }}
              </span>
              <span v-else class="tasks-muted">—</span>
            </div>
            <div class="task-cell task-cell--actions" data-label="操作" role="cell">
              <NativeButton
                v-if="canCancel(task)"
                theme="danger"
                variant="outline"
                size="small"
                :loading="isActionLoading(task.id)"
                @click="handleAction('cancel', task)"
              >
                取消
              </NativeButton>
              <NativeButton
                v-else-if="task.status === 'failed'"
                theme="primary"
                variant="outline"
                size="small"
                :loading="isActionLoading(task.id)"
                @click="handleAction('retry', task)"
              >
                重试
              </NativeButton>
              <span v-else class="tasks-muted">—</span>
            </div>
          </article>
        </div>

        <div v-if="store.pagination.total > 0" class="tasks-pagination">
          <NativePagination
            :current="store.pagination.page"
            :page-size="store.pagination.pageSize"
            :total="store.pagination.total"
            :page-size-options="[10, 20, 50]"
            @change="handlePageChange"
          />
        </div>
      </template>
    </NativeCard>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { TASK_ACTIVE_STATUSES, useTasksStore } from '@/stores/tasks'
import { useToast } from '@/composables/useToast'
import {
  NativeButton,
  NativeCard,
  NativeEmpty,
  NativeIcon,
  NativeLoading,
  NativePagination,
  NativeProgress,
  NativeSelect,
  NativeTag
} from '@/components/native'

const POLL_INTERVAL_MS = 2000
const SAFE_TASK_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_.-]{0,63}$/u
const ACTIVE_STATUS_SET = new Set(TASK_ACTIVE_STATUSES)
const ACTION_CONFLICT_CODES = new Set(['TASK_CANCEL_CONFLICT', 'TASK_RETRY_CONFLICT', 'TASK_ACTION_CONFLICT'])

const store = useTasksStore()
const toast = useToast()

const statusOptions = [
  { value: 'pending', label: '排队中' },
  { value: 'leased', label: '运行中' },
  { value: 'running', label: '运行中' },
  { value: 'succeeded', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' }
]

const taskTypeOptions = [
  { value: 'code.repository.clone', label: '代码仓库克隆' },
  { value: 'code.repository.sync', label: '代码仓库同步' },
  { value: 'code.repository.reclone', label: '代码仓库安全重克隆' },
  { value: 'music.lyrics.batch', label: '批量下载歌词' },
  { value: 'games.steam.sync', label: 'Steam 游戏同步' },
  { value: 'anime.bangumi.refresh', label: '动漫信息刷新' },
  { value: 'ebook.cover.generate', label: '电子书封面生成' }
]

const orderOptions = [
  { value: 'desc', label: '最新优先' },
  { value: 'asc', label: '最早优先' }
]

const TASK_TYPE_LABELS = Object.freeze(Object.fromEntries(taskTypeOptions.map(({ value, label }) => [value, label])))
const STATUS_LABELS = Object.freeze({
  pending: '排队中',
  leased: '运行中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消'
})
const STATUS_THEMES = Object.freeze({
  pending: 'warning',
  leased: 'primary',
  running: 'primary',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'default'
})
const SUBJECT_LABELS = Object.freeze({
  'code-repository': '代码仓库',
  anime: '动漫',
  ebook: '电子书',
  'music-library': '音乐库',
  'game-library': 'Steam游戏库'
})
const TASK_ERROR_MESSAGES = Object.freeze({
  TASK_PROCESSOR_FAILED: '任务处理失败，请稍后重试',
  TASK_HEARTBEAT_FAILED: '任务运行状态异常，请稍后重试',
  TASK_LEASE_EXPIRED: '任务运行超时，请稍后重试',
  TASK_PROGRESS_REJECTED: '任务进度更新失败',
  TASK_INPUT_INVALID: '任务输入无效',
  TASK_ID_INVALID: '来源资源标识无效',
  TASK_TYPE_UNSUPPORTED: '任务类型暂不支持',
  TASK_CANCELLED: '任务已取消',
  EBOOK_COVER_TASK_TIMEOUT: '封面生成超时，请稍后重试',
  EBOOK_COVER_TASK_MISSING: '封面任务不存在',
  EBOOK_COVER_TASK_FAILED: '封面生成失败，请稍后重试'
})
const LOAD_ERROR_MESSAGES = Object.freeze({
  TASK_QUERY_INVALID: '筛选条件无效，请重试',
  TASK_QUERY_FAILED: '任务列表加载失败，请稍后重试',
  TASK_NETWORK_ERROR: '网络暂时不可用，请检查连接后重试',
  TASK_REQUEST_FAILED: '任务列表加载失败，请稍后重试',
  SESSION_REQUIRED: '登录状态已失效，请重新登录',
  OWNER_REQUIRED: '当前账号无权查看任务'
})

let pollTimer = null
let mounted = false

const loadErrorMessage = computed(() => LOAD_ERROR_MESSAGES[store.error] || '任务列表加载失败，请稍后重试')

function statusLabel(status) {
  return STATUS_LABELS[status] || '未知状态'
}

function statusTheme(status) {
  return STATUS_THEMES[status] || 'default'
}

function taskTypeLabel(taskType) {
  return TASK_TYPE_LABELS[taskType] || '其他任务'
}

function subjectLabel(subject) {
  if (!subject || typeof subject !== 'object') return '未关联资源'
  const label = SUBJECT_LABELS[subject.type]
  if (!label) return '未关联资源'
  if (subject.type === 'music-library' || subject.type === 'game-library') return label
  const id = typeof subject.id === 'string' && /^[1-9]\d*$/u.test(subject.id) ? subject.id : null
  return id ? `${label}#${id}` : label
}

function hasProgress(taskItem) {
  return typeof taskItem?.progress === 'number' && Number.isFinite(taskItem.progress) &&
    taskItem.progress >= 0 && taskItem.progress <= 100
}

function progressValue(taskItem) {
  return hasProgress(taskItem) ? taskItem.progress : 0
}

function attemptLabel(taskItem) {
  const attemptCount = Number.isSafeInteger(taskItem?.attemptCount) ? taskItem.attemptCount : null
  const maxAttempts = Number.isSafeInteger(taskItem?.maxAttempts) ? taskItem.maxAttempts : null
  return attemptCount === null || maxAttempts === null ? '—' : `${attemptCount}/${maxAttempts}`
}

function formatTime(timestamp) {
  if (typeof timestamp !== 'string') return '时间未知'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', { hour12: false })
}

function timestampLabel(taskItem) {
  return formatTime(taskItem?.timestamps?.updatedAt || taskItem?.timestamps?.createdAt)
}

function taskErrorLabel(errorCode) {
  const safeCode = typeof errorCode === 'string' && SAFE_TASK_ERROR_CODE_PATTERN.test(errorCode)
    ? errorCode
    : null
  if (!safeCode) return '任务失败（代码：未知）'
  return TASK_ERROR_MESSAGES[safeCode] || `任务失败（代码：${safeCode}）`
}

function canCancel(taskItem) {
  return ACTIVE_STATUS_SET.has(taskItem?.status)
}

function isActionLoading(id) {
  return store.isActionLoading(id)
}

function handleStatusChange(value) {
  void store.setFilters({ status: value })
}

function handleTaskTypeChange(value) {
  void store.setFilters({ taskType: value })
}

function handleOrderChange(value) {
  void store.setFilters({ order: value })
}

function handlePageChange({ current, pageSize }) {
  void store.setFilters({ page: current, pageSize })
}

async function handleRefresh() {
  await store.refresh()
  syncPolling()
}

async function handleAction(action, taskItem) {
  const result = await store[action](taskItem.id)
  if (result.success) {
    toast.success(action === 'cancel' ? '任务已取消' : '任务已重新提交')
    return
  }
  if (result.code === 'TASK_ACTION_IN_PROGRESS') return
  if (ACTION_CONFLICT_CODES.has(result.code)) {
    toast.warning('状态已变化，请刷新')
    return
  }
  toast.error(action === 'cancel' ? '取消任务失败，请稍后重试' : '重试任务失败，请稍后重试')
}

function isPageVisible() {
  return typeof document !== 'undefined' && document.visibilityState === 'visible'
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function syncPolling() {
  if (!mounted || !isPageVisible() || !store.hasActiveTasks) {
    stopPolling()
    return
  }
  if (pollTimer !== null) return
  pollTimer = setInterval(() => {
    if (!isPageVisible() || !store.hasActiveTasks) {
      stopPolling()
      return
    }
    void store.refresh().finally(syncPolling)
  }, POLL_INTERVAL_MS)
}

function handleVisibilityChange() {
  if (!isPageVisible()) {
    stopPolling()
    return
  }
  void store.refresh().finally(syncPolling)
}

async function loadTasks() {
  await store.fetch()
  if (mounted) syncPolling()
}

watch(() => store.hasActiveTasks, () => {
  if (mounted) syncPolling()
})

onMounted(() => {
  mounted = true
  document.addEventListener('visibilitychange', handleVisibilityChange)
  void loadTasks()
})

onBeforeUnmount(() => {
  mounted = false
  stopPolling()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

<style scoped>
.tasks-page {
  width: 100%;
  max-width: 1500px;
  margin: 0 auto;
}

.tasks-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.tasks-heading h1 {
  margin: 0;
  color: #333;
  font-size: 24px;
  font-weight: 600;
}

.tasks-subtitle {
  margin: 8px 0 0;
  color: #777;
  font-size: 14px;
}

.tasks-filter-card {
  margin-bottom: 16px;
}

.tasks-filter-card :deep(.native-card__body) {
  padding: 16px 20px;
}

.tasks-filter-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(160px, 1fr));
  gap: 16px;
}

.tasks-filter-item {
  display: grid;
  gap: 6px;
  color: #555;
  font-size: 13px;
}

.tasks-feedback {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  padding: 12px 16px;
  border: 1px solid #f2c7c7;
  border-radius: 6px;
  background: #fff7f7;
  color: #b42318;
  font-size: 14px;
}

.tasks-list-card :deep(.native-card__body) {
  padding: 0;
}

.tasks-list-card > :deep(.native-loading),
.tasks-list-card > :deep(.native-empty) {
  min-height: 240px;
  padding: 48px 20px;
}

.tasks-table {
  overflow-x: auto;
}

.tasks-table-head,
.task-row {
  display: grid;
  grid-template-columns: minmax(210px, 1.5fr) minmax(120px, 1fr) minmax(150px, 1.35fr) 90px minmax(155px, 1.15fr) minmax(190px, 1.5fr) 90px;
  gap: 16px;
  align-items: center;
  min-width: 1020px;
  padding: 14px 20px;
}

.tasks-table-head {
  border-bottom: 1px solid #e8e8e8;
  background: #fafafa;
  color: #777;
  font-size: 13px;
}

.task-row {
  min-height: 82px;
  border-bottom: 1px solid #f0f0f0;
  color: #333;
  font-size: 14px;
}

.task-row:last-child {
  border-bottom: 0;
}

.task-cell {
  min-width: 0;
}

.task-cell--main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.task-cell--subject,
.task-cell--time,
.task-cell--error {
  overflow-wrap: anywhere;
}

.task-cell--time {
  display: grid;
  gap: 4px;
}

.task-cell--time small {
  color: #999;
  font-size: 12px;
}

.task-cell--progress :deep(.native-progress__text) {
  min-width: 42px;
}

.task-cell--actions {
  display: flex;
  justify-content: flex-start;
}

.task-error-text {
  color: #b42318;
  line-height: 1.5;
}

.tasks-muted {
  color: #999;
}

.tasks-pagination {
  padding: 0 20px;
  border-top: 1px solid #f0f0f0;
}

@media (max-width: 768px) {
  .tasks-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .tasks-heading h1 {
    font-size: 20px;
  }

  .tasks-heading .native-btn {
    align-self: flex-start;
  }

  .tasks-filter-grid {
    grid-template-columns: 1fr;
  }

  .tasks-feedback {
    align-items: flex-start;
    flex-direction: column;
  }

  .tasks-table {
    overflow: visible;
  }

  .tasks-table-head {
    display: none;
  }

  .task-row {
    display: flex;
    min-width: 0;
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    margin: 12px;
    padding: 16px;
    border: 1px solid #e8e8e8;
    border-radius: 8px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
  }

  .task-row:last-child {
    border-bottom: 1px solid #e8e8e8;
  }

  .task-cell {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr);
    gap: 8px;
    align-items: center;
  }

  .task-cell::before {
    content: attr(data-label);
    color: #888;
    font-size: 12px;
  }

  .task-cell--main {
    display: flex;
  }

  .task-cell--main::before {
    margin-right: 0;
  }

  .task-cell--progress :deep(.native-progress) {
    min-width: 0;
  }

  .task-cell--actions {
    display: flex;
    justify-content: flex-end;
    padding-top: 4px;
  }

  .task-cell--actions::before {
    margin-right: auto;
  }

  .tasks-pagination {
    padding: 0 12px;
    overflow-x: auto;
  }

  .tasks-pagination :deep(.native-pagination) {
    justify-content: flex-start;
    min-width: max-content;
  }
}
</style>
