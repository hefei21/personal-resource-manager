<template>
  <section class="system-overview" aria-labelledby="system-overview-title">
    <div class="overview-heading">
      <div>
        <p class="eyebrow">运行概览</p>
        <h2 id="system-overview-title">服务与任务</h2>
      </div>
      <button type="button" class="refresh-button" :disabled="loading" @click="loadOverview">
        <NativeIcon name="refresh" size="16" />
        {{ loading ? '刷新中' : '刷新' }}
      </button>
    </div>

    <div v-if="loading && !hasLoaded" class="overview-feedback" aria-live="polite">
      <NativeIcon name="loading" class="spin" size="18" />
      正在读取系统状态…
    </div>

    <template v-else>
      <div class="status-grid">
        <article v-for="item in statusItems" :key="item.key" class="status-card">
          <span class="status-dot" :class="`status-dot--${item.tone}`" aria-hidden="true"></span>
          <div>
            <strong>{{ item.label }}</strong>
            <p>{{ item.detail }}</p>
          </div>
          <span class="status-label" :class="`status-label--${item.tone}`">{{ item.status }}</span>
        </article>
      </div>

      <div v-if="partialError" class="overview-feedback overview-feedback--warning" role="status">
        部分状态暂时无法读取；未受影响的 NAS 资源管理仍可继续使用。
      </div>

      <div class="recent-tasks">
        <div class="section-heading">
          <h3>最近任务</h3>
          <RouterLink to="/tasks">查看全部</RouterLink>
        </div>
        <div v-if="tasksError" class="overview-feedback overview-feedback--warning" role="alert">
          任务状态加载失败，可稍后刷新。
        </div>
        <div v-else-if="recentTasks.length === 0" class="tasks-empty">暂无后台任务</div>
        <ul v-else class="task-list">
          <li v-for="task in recentTasks" :key="task.id">
            <span class="task-copy">
              <strong>{{ taskTypeLabel(task.taskType) }}</strong>
              <small>{{ formatTime(task.timestamps?.createdAt) }}</small>
            </span>
            <span class="task-status" :class="`task-status--${task.status}`">{{ taskStatusLabel(task.status) }}</span>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import { NativeIcon } from '@/components/native'

const health = ref(null)
const rag = ref(null)
const recentTasks = ref([])
const loading = ref(false)
const hasLoaded = ref(false)
const healthError = ref(false)
const ragError = ref(false)
const tasksError = ref(false)

const TASK_TYPE_LABELS = {
  'code.repository.clone': '代码仓库克隆',
  'code.repository.sync': '代码仓库同步',
  'code.repository.reclone': '代码仓库安全重克隆',
  'music.lyrics.batch': '批量下载歌词',
  'games.steam.sync': 'Steam 游戏同步',
  'anime.bangumi.refresh': '动漫信息刷新',
  'ebook.cover.generate': '电子书封面生成',
  'ebook.metadata.reparse': '电子书元数据重解析',
  'music.metadata.reparse': '音频元数据重解析',
  'search.index.refresh': '统一搜索索引刷新',
  'content.inspect': '内容检查'
}

const STATUS_LABELS = {
  pending: '排队中', leased: '运行中', running: '运行中',
  succeeded: '已完成', failed: '失败', cancelled: '已取消'
}

function serviceItem(key, label, value, values) {
  return { key, label, ...(values[value] || values.unknown) }
}

const statusItems = computed(() => [
  serviceItem('nas', 'NAS 核心服务', healthError.value ? 'unknown' : health.value?.services?.database, {
    ok: { status: '正常', detail: '权威数据与基础资源管理可用', tone: 'ok' },
    error: { status: '异常', detail: '数据库健康检查失败', tone: 'error' },
    unknown: { status: '未知', detail: '暂时无法读取健康状态', tone: 'unknown' }
  }),
  serviceItem('redis', 'Redis 缓存', healthError.value ? 'unknown' : health.value?.services?.redis, {
    ok: { status: '正常', detail: '缓存加速可用', tone: 'ok' },
    not_connected: { status: '降级', detail: '缓存离线，不影响权威数据', tone: 'warning' },
    not_configured: { status: '未配置', detail: '当前使用无缓存模式', tone: 'neutral' },
    unknown: { status: '未知', detail: '暂时无法读取缓存状态', tone: 'unknown' }
  }),
  serviceItem('worker', 'PC GPU Worker', ragError.value ? 'unknown' : rag.value?.pcWorker?.status, {
    online: { status: '在线', detail: 'GPU 增强能力可用', tone: 'ok' },
    offline: { status: '离线', detail: 'NAS 基础检索与管理不受影响', tone: 'warning' },
    unknown: { status: '未知', detail: '暂时无法确认 Worker 状态', tone: 'unknown' }
  }),
  serviceItem('retrieval', '知识检索', ragError.value ? 'unknown' : rag.value?.text?.status, {
    ready: { status: '可用', detail: 'NAS 文本检索索引已就绪', tone: 'ok' },
    missing: { status: '待建立', detail: '尚未生成文本检索索引', tone: 'warning' },
    failed: { status: '异常', detail: '文本索引当前不可用', tone: 'error' },
    unknown: { status: '未知', detail: '暂时无法读取检索状态', tone: 'unknown' }
  })
])

const partialError = computed(() => healthError.value || ragError.value)

function taskTypeLabel(type) {
  return TASK_TYPE_LABELS[type] || '后台任务'
}

function taskStatusLabel(status) {
  return STATUS_LABELS[status] || '未知状态'
}

function formatTime(value) {
  if (!value) return '时间未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false })
}

async function loadOverview() {
  if (loading.value) return
  loading.value = true
  healthError.value = false
  ragError.value = false
  tasksError.value = false

  const [healthResult, ragResult, tasksResult] = await Promise.allSettled([
    api.system.health(),
    api.rag.status(),
    api.tasks.list({ limit: 4, order: 'desc' })
  ])

  if (healthResult.status === 'fulfilled') health.value = healthResult.value.data
  else healthError.value = true
  if (ragResult.status === 'fulfilled') rag.value = ragResult.value.data?.data ?? ragResult.value.data
  else ragError.value = true
  if (tasksResult.status === 'fulfilled') recentTasks.value = tasksResult.value.data?.data ?? []
  else tasksError.value = true

  hasLoaded.value = true
  loading.value = false
}

onMounted(loadOverview)
</script>

<style scoped>
.system-overview {
  margin-bottom: 18px;
  padding: 20px;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 8px 28px rgba(15, 23, 42, 0.05);
}

.overview-heading,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.eyebrow {
  margin: 0 0 4px;
  color: #4f46e5;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

h2, h3 { margin: 0; color: #172033; }
h2 { font-size: 20px; }
h3 { font-size: 15px; }

.refresh-button {
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #fff;
  color: #475569;
  cursor: pointer;
}

.refresh-button:disabled { opacity: 0.55; cursor: wait; }

.status-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-top: 18px;
}

.status-card {
  min-width: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  padding: 14px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #f8fafc;
}

.status-dot {
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: #94a3b8;
}
.status-dot--ok { background: #10b981; }
.status-dot--warning { background: #f59e0b; }
.status-dot--error { background: #ef4444; }

.status-card strong { color: #334155; font-size: 13px; }
.status-card p { margin: 5px 0 0; color: #64748b; font-size: 12px; line-height: 1.45; }
.status-label { grid-column: 2; width: max-content; margin-top: 7px; color: #64748b; font-size: 11px; font-weight: 700; }
.status-label--ok { color: #047857; }
.status-label--warning { color: #b45309; }
.status-label--error { color: #b91c1c; }

.recent-tasks { margin-top: 20px; }
.section-heading a { color: #4f46e5; font-size: 13px; text-decoration: none; }
.task-list { margin: 10px 0 0; padding: 0; list-style: none; border-top: 1px solid #e2e8f0; }
.task-list li { min-height: 50px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid #f1f5f9; }
.task-copy { min-width: 0; display: grid; gap: 3px; }
.task-copy strong { overflow: hidden; color: #334155; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.task-copy small { color: #94a3b8; font-size: 11px; }
.task-status { flex: 0 0 auto; padding: 3px 7px; border-radius: 999px; background: #f1f5f9; color: #64748b; font-size: 11px; font-weight: 700; }
.task-status--running, .task-status--leased { background: #eef2ff; color: #4f46e5; }
.task-status--pending { background: #fffbeb; color: #b45309; }
.task-status--succeeded { background: #ecfdf5; color: #047857; }
.task-status--failed { background: #fef2f2; color: #b91c1c; }
.tasks-empty, .overview-feedback { margin-top: 12px; padding: 12px; border-radius: 8px; background: #f8fafc; color: #64748b; font-size: 13px; }
.overview-feedback { display: flex; align-items: center; gap: 8px; }
.overview-feedback--warning { background: #fffbeb; color: #92400e; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 900px) {
  .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 520px) {
  .system-overview { padding: 16px; }
  .status-grid { grid-template-columns: 1fr; }
}
</style>
