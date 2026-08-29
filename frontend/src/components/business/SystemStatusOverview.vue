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
        <article v-for="item in statusItems" :key="item.key" class="status-card" :class="`status-card--${item.tone}`">
          <span class="status-icon" aria-hidden="true">
            <NativeIcon :name="item.icon" size="18" weight="duotone" />
          </span>
          <div class="status-copy">
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

function workerDetail(reason) {
  if (reason === 'not_registered') return '尚无已登记的 Worker，请先完成配对并启动进程'
  if (reason === 'heartbeat_stale') return '两分钟内未收到心跳；只加载本地模型不会启动 Worker'
  if (reason === 'registry_unavailable') return 'Worker 登记状态暂时无法读取'
  return 'Worker 已连接 NAS，并持续上报能力快照'
}

function modelItem(key, label, icon, value, { optional = false } = {}) {
  return serviceItem(key, label, value, {
    ready: { icon, status: '就绪', detail: 'Worker 已确认模型身份并上报对应能力', tone: 'ok' },
    worker_offline: { icon, status: '等待 Worker', detail: '本地模型可能已加载，但 Worker 尚未连接 NAS', tone: 'warning' },
    unavailable: { icon, status: '未就绪', detail: 'Worker 在线，但模型未加载、端点不可用或身份不匹配', tone: 'warning' },
    not_configured: {
      icon,
      status: optional ? '可选未启用' : '未配置',
      detail: optional ? '不影响 Hybrid 检索，将保留原始排序' : 'NAS 尚未启用此模型能力',
      tone: 'neutral'
    },
    unknown: { icon, status: '未知', detail: '暂时无法读取该能力状态', tone: 'unknown' }
  })
}

const statusItems = computed(() => [
  serviceItem('nas', 'NAS 核心服务', healthError.value ? 'unknown' : health.value?.services?.database, {
    ok: { icon: 'shield', status: '正常', detail: '权威数据与基础资源管理可用', tone: 'ok' },
    error: { icon: 'shield', status: '异常', detail: '数据库健康检查失败', tone: 'error' },
    unknown: { icon: 'shield', status: '未知', detail: '暂时无法读取健康状态', tone: 'unknown' }
  }),
  serviceItem('redis', 'Redis 缓存', healthError.value ? 'unknown' : health.value?.services?.redis, {
    ok: { icon: 'list-dashes', status: '正常', detail: '缓存加速可用', tone: 'ok' },
    not_connected: { icon: 'list-dashes', status: '降级', detail: '缓存离线，不影响权威数据', tone: 'warning' },
    not_configured: { icon: 'list-dashes', status: '未配置', detail: '当前使用无缓存模式', tone: 'neutral' },
    unknown: { icon: 'list-dashes', status: '未知', detail: '暂时无法读取缓存状态', tone: 'unknown' }
  }),
  serviceItem('worker', 'PC GPU Worker', ragError.value ? 'unknown' : rag.value?.pcWorker?.status, {
    online: { icon: 'cpu', status: '已连接', detail: workerDetail(rag.value?.pcWorker?.reason), tone: 'ok' },
    offline: { icon: 'cpu', status: '未连接', detail: workerDetail(rag.value?.pcWorker?.reason), tone: 'warning' },
    unknown: { icon: 'cpu', status: '未知', detail: workerDetail('registry_unavailable'), tone: 'unknown' }
  }),
  modelItem('answer', 'Qwen 回答模型', 'message', ragError.value ? 'unknown' : rag.value?.capabilities?.answer?.status),
  modelItem('embedding', 'Nomic 向量化', 'magnifying-glass', ragError.value ? 'unknown' : rag.value?.capabilities?.embedding?.status),
  serviceItem('vector', 'Qdrant 向量库', ragError.value ? 'unknown' : rag.value?.vector?.status, {
    available: { icon: 'database', status: '可用', detail: '向量服务与当前集合结构均已通过检查', tone: 'ok' },
    unavailable: { icon: 'database', status: '不可用', detail: 'Qdrant、集合或模型绑定当前未通过检查', tone: 'warning' },
    unknown: { icon: 'database', status: '未知', detail: '暂时无法读取向量库状态', tone: 'unknown' }
  }),
  modelItem('reranker', 'BGE 结果重排', 'sort-desc', ragError.value ? 'unknown' : rag.value?.capabilities?.reranker?.status, { optional: true }),
  serviceItem('retrieval', '知识检索', ragError.value ? 'unknown' : rag.value?.text?.status, {
    ready: { icon: 'file-text', status: '可用', detail: 'NAS FTS 文本索引已就绪，不依赖 PC', tone: 'ok' },
    missing: { icon: 'file-text', status: '待建立', detail: '尚未生成文本检索索引', tone: 'warning' },
    failed: { icon: 'file-text', status: '异常', detail: '文本索引当前不可用', tone: 'error' },
    unknown: { icon: 'file-text', status: '未知', detail: '暂时无法读取检索状态', tone: 'unknown' }
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
  padding: 22px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-xl);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-sm);
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
  grid-template-columns: 36px 1fr;
  gap: 3px 11px;
  padding: 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-page);
}

.status-icon {
  display: grid;
  width: 36px;
  height: 36px;
  grid-row: 1 / span 2;
  place-items: center;
  color: var(--color-text-muted);
  border-radius: var(--radius-md);
  background: var(--color-surface-subtle);
}
.status-card--ok .status-icon { color: var(--color-success-text); background: var(--color-success-surface); }
.status-card--warning .status-icon { color: var(--color-warning-text); background: var(--color-warning-surface); }
.status-card--error .status-icon { color: var(--color-danger-text); background: var(--color-danger-surface); }

.status-copy { min-width: 0; }
.status-card strong { color: var(--color-text-primary); font-size: 13px; }
.status-card p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: 12px; line-height: 1.5; }
.status-label { grid-column: 2; width: max-content; margin-top: 7px; color: var(--color-text-muted); font-size: 11px; font-weight: 700; }
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
