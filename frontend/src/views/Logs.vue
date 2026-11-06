<!--  --><template>
  <div class="logs-container">
    <div class="logs-header">
      <div class="header-btns">
        <NativeButton v-if="!isMobile" variant="outline" @click="showBlacklist = true">
          <template #icon><NativeIcon name="secured" /></template>
          IP黑名单
        </NativeButton>
        <NativeButton theme="primary" @click="refreshAll" :loading="loading">
          <template #icon><NativeIcon name="arrow-clockwise" /></template>
          刷新
        </NativeButton>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-cards">
      <NativeCard class="stat-card">
        <div class="stat-value">{{ stats.todayCount ?? '—' }}</div>
        <div class="stat-label">今日访问（UTC）</div>
      </NativeCard>
      <NativeCard class="stat-card">
        <div class="stat-value">{{ stats.totalCount ?? '—' }}</div>
        <div class="stat-label">总记录数</div>
      </NativeCard>
      <NativeCard class="stat-card">
        <div class="stat-value">{{ stats.todayActiveUsers ?? '—' }}</div>
        <div class="stat-label">今日活跃用户（UTC）</div>
      </NativeCard>
      <NativeCard class="stat-card">
        <div class="stat-value">{{ pagination.total }}</div>
        <div class="stat-label">筛选结果</div>
      </NativeCard>
    </div>

    <!-- 筛选栏 -->
    <NativeCard class="filter-card">
      <form class="filter-btns" @submit.prevent="searchLogs">
        <NativeSelect
          v-model="filters.action"
          placeholder="操作类型"
          aria-label="操作类型"
          :clearable="true"
          style="width: 120px"
          :options="[
            { value: 'login', label: '登录' },
            { value: 'logout', label: '登出' },
            { value: 'upload', label: '上传' },
            { value: 'delete', label: '删除' },
            { value: 'create', label: '创建' },
            { value: 'update', label: '更新' },
            { value: 'visit', label: '访问' },
            { value: 'worker', label: 'Worker 协议' }
          ]"
        />
        <NativeInput v-model="filters.keyword" aria-label="搜索用户/IP/路径" placeholder="搜索用户/IP/路径" style="width: 200px" clearable />
        <NativeDateRangePicker v-model="filters.dateRange" aria-label="访问日期（UTC+8）" :placeholder="['开始日期', '结束日期']" clearable style="width: 240px" />
        <NativeButton theme="primary" type="submit">查询</NativeButton>
        <NativeButton variant="outline" @click="resetFilters">重置</NativeButton>
      </form>
    </NativeCard>

    <!-- 日志表格 -->
    <NativeAlert v-if="statsError" theme="warning" role="status" title="访问统计暂时不可用">{{ statsError }}</NativeAlert>
    <NativeAlert v-if="loadError" theme="error" role="alert" title="日志加载失败">{{ loadError }}</NativeAlert>
    <NativeCard class="table-card">
      <NativeTable v-if="!loadError" :dataSource="logs" :columns="columns" :loading="loading" rowKey="id" stripe hover>
        <template #cell-created_at="{ row }">
          {{ formatToUTC8(row.created_at) }}
        </template>
        <template #cell-username="{ row }">
          <span :class="{ 'is-admin': row.username === 'admin' }">
            {{ row.username }}
          </span>
        </template>
        <template #cell-module="{ row }">
          <NativeTag :theme="getModuleTheme(row.module)" variant="light">
            {{ row.module || '-' }}
          </NativeTag>
        </template>
        <template #cell-action="{ row }">
          <NativeTag :theme="getActionTheme(row.action)" variant="light">
            {{ getActionLabel(row.action) }}
          </NativeTag>
        </template>
        <template #cell-method="{ row }">
          <NativeTag :theme="getMethodTheme(row.method)" variant="outline">
            {{ row.method }}
          </NativeTag>
        </template>
        <template #cell-path="{ row }">
          <NativeTooltip :content="row.path" placement="top">
            <span class="path-text">{{ row.path }}</span>
          </NativeTooltip>
        </template>
        <template #cell-status="{ row }">
          <NativeTag :theme="row.response_status >= 400 ? 'danger' : 'success'" variant="outline">
            {{ row.response_status }}
          </NativeTag>
        </template>
        <template #cell-duration="{ row }">
          <span :class="{ 'slow-query': row.duration > 3000 }">
            {{ row.duration }}ms
          </span>
        </template>
        <template #cell-ip_location="{ row }">
          <NativeTag :theme="getLocationTheme(row.ip_location)" variant="light">
            {{ row.ip_location || '-' }}
          </NativeTag>
        </template>
        <template #cell-details="{ row }">
          <NativeTooltip v-if="row.details" :content="row.details" placement="top">
            <NativeIcon name="info-circle" />
          </NativeTooltip>
          <span v-else>-</span>
        </template>
      </NativeTable>

      <!-- 分页 -->
      <div v-if="!loadError" class="pagination-wrapper">
        <NativePagination
          :current="pagination.current"
          :page-size="pagination.pageSize"
          :total="pagination.total"
          @change="handlePageChange"
        />
      </div>
    </NativeCard>

    <!-- IP黑名单抽屉 -->
    <NativeDrawer
      v-if="!isMobile"
      v-model="showBlacklist"
      title="IP黑名单管理"
      size="80%"
      placement="right"
      :close-btn="true"
      :close-on-overlay-click="true"
    >
      <BlacklistPanel @close="showBlacklist = false" />
    </NativeDrawer>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useViewport } from '@/composables/useViewport'
import api from '@/api'
import BlacklistPanel from '@/views/admin/Blacklist.vue'
import { NativeAlert, NativeButton, NativeInput, NativeCard, NativeSelect, NativeTag, NativePagination, NativeIcon, NativeDateRangePicker, NativeTable, NativeTooltip, NativeDrawer } from '@/components/native'

const { isMobile } = useViewport()
const logs = ref([])
const loadError = ref('')
const statsError = ref('')
const loading = ref(false)
const showBlacklist = ref(false)
const stats = ref({
  todayCount: null,
  totalCount: null,
  todayActiveUsers: null,
  topActions: []
})

const filters = ref({
  action: null,
  keyword: '',
  dateRange: []
})

const pagination = ref({
  current: 1,
  pageSize: 50,
  total: 0
})

// 将 UTC 时间转换为 UTC+8
function formatToUTC8(utcTime) {
  if (!utcTime) return ''
  // SQLite CURRENT_TIMESTAMP is UTC without an offset; ISO responses already carry one.
  const value = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(utcTime) ? utcTime.replace(' ', 'T') + 'Z' : utcTime
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/\//g, '-')
}

const columns = [
  { key: 'created_at', title: '时间', width: 170 },
  { key: 'username', title: '用户', width: 90 },
  { key: 'module', title: '模块', width: 80 },
  { key: 'action', title: '操作', width: 80 },
  { key: 'method', title: '方法', width: 70 },
  { key: 'path', title: '路径', minWidth: 160 },
  { key: 'status', title: '状态', width: 60 },
  { key: 'duration', title: '耗时', width: 90 },
  { key: 'ip_address', title: 'IP', width: 130 },
  { key: 'ip_location', title: '属地', width: 120 },
  { key: 'details', title: '详情', width: 60 }
]

function getActionLabel(action) {
  const labels = {
    login: '登录',
    logout: '登出',
    upload: '上传',
    delete: '删除',
    create: '创建',
    update: '更新',
    visit: '访问',
    worker: 'Worker 协议'
  }
  return labels[action] || action
}

function getActionTheme(action) {
  const themes = {
    login: 'primary',
    logout: 'default',
    upload: 'warning',
    delete: 'danger',
    create: 'success',
    update: 'warning',
    visit: 'default'
  }
  return themes[action] || 'default'
}

function getMethodTheme(method) {
  const themes = {
    GET: 'success',
    POST: 'primary',
    PUT: 'warning',
    DELETE: 'danger',
    PATCH: 'info'
  }
  return themes[method] || 'default'
}

function getModuleTheme(module) {
  const themes = {
    '认证': 'default',
    '文档': 'primary',
    '书籍': 'warning',
    '音乐': 'success',
    '书签': 'info',
    '代码': 'default',
    '动漫': 'danger',
    '游戏': 'warning',
    '待办': 'success',
    '博客': 'primary',
    '搜索': 'info',
    '日志': 'default',
    '统计': 'success',
    '书籍搜索': 'warning',
    '其他': 'default'
  }
  return themes[module] || 'default'
}

function getLocationTheme(location) {
  if (!location || location === '未知' || location === '-') return 'default'
  if (location === '本地') return 'success'
  // 如果是中国境内（包含省份/城市信息）
  if (location.includes('中国') || location.includes('省') || location.includes('市') || 
      location.includes('北京') || location.includes('上海') || location.includes('天津') || location.includes('重庆') ||
      location.includes('内蒙古') || location.includes('广西') || location.includes('西藏') || location.includes('宁夏') || location.includes('新疆') ||
      location.includes('香港') || location.includes('澳门') || location.includes('台湾')) {
    return 'primary'
  }
  // 境外IP
  return 'warning'
}

let listRequest = 0, statsRequest = 0
onBeforeUnmount(() => { listRequest++; statsRequest++ })
watch(isMobile, mobile => { if (mobile) showBlacklist.value = false })
async function loadStats() {
  const request = ++statsRequest
  statsError.value = ''
  try {
    const response = await api.logs.stats()
    if (request !== statsRequest) return
    stats.value = response.data.data
  } catch (error) {
    if (request !== statsRequest) return
    statsError.value = '请点击刷新重试；已有统计可能不是最新结果。'
  }
}

async function loadLogs() {
  const request = ++listRequest
  loading.value = true
  loadError.value = ''
  try {
    const params = {
      page: pagination.value.current,
      pageSize: pagination.value.pageSize
    }
    
    if (filters.value.action) {
      params.action = filters.value.action
    }
    if (filters.value.keyword) {
      params.keyword = filters.value.keyword
    }
    if (filters.value.dateRange && filters.value.dateRange.length === 2) {
      // Match the displayed UTC+8 calendar days to SQLite's UTC timestamp format.
      params.startDate = new Date(`${filters.value.dateRange[0]}T00:00:00+08:00`).toISOString().slice(0, 19).replace('T', ' ')
      params.endDate = new Date(`${filters.value.dateRange[1]}T23:59:59+08:00`).toISOString().slice(0, 19).replace('T', ' ')
    }
    
    const response = await api.logs.list(params)
    if (request !== listRequest) return
    logs.value = response.data.data || []
    pagination.value.total = response.data.total || 0
  } catch (error) {
    if (request !== listRequest) return
    logs.value = []
    pagination.value.total = 0
    loadError.value = error.response?.status === 403 ? '当前会话无权查看访问日志。' : '请检查网络后点击刷新重试。'
  } finally {
    if (request === listRequest) loading.value = false
  }
}

function searchLogs() {
  pagination.value.current = 1
  loadLogs()
}

function resetFilters() {
  filters.value = {
    action: null,
    keyword: '',
    dateRange: []
  }
  pagination.value.current = 1
  loadLogs()
}

function handlePageChange(pageInfo) {
  pagination.value.current = pageInfo.current
  pagination.value.pageSize = pageInfo.pageSize
  loadLogs()
}

async function refreshAll() {
  await Promise.all([loadStats(), loadLogs()])
}

onMounted(() => {
  loadStats()
  loadLogs()
})
</script>

<style scoped>
.logs-container {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}

.logs-header {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: var(--space-3);
}

.stats-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.stat-card {
  text-align: center;
}

.stat-card :deep(.native-card__body) {
  padding: 24px 16px;
}

.stat-value {
  font-size: 28px;
  font-weight: bold;
  color: var(--color-text-primary);
  line-height: 1.2;
}

.stat-label {
  font-size: 14px;
  color: var(--color-text-secondary);
  margin-top: 8px;
}

.table-card {
  min-width: 0;
}

.path-text {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
}

.slow-query {
  color: var(--color-danger);
  font-weight: 600;
}

.is-admin {
  font-weight: 600;
  color: var(--color-primary);
}

.pagination-wrapper {
  display: flex;
  justify-content: center;
  margin-top: 24px;
}

.header-btns {
  display: flex;
  gap: 12px;
}

.filter-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

@media (max-width: 768px) {
  .stats-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
  .filter-btns > * { width: 100% !important; min-width: 0; }
  .stat-value { font-size: 24px; }
}
</style>
