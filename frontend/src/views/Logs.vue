<!--  --><template>
  <div class="logs-container">
    <div class="logs-header">
      <div></div>
      <div class="header-btns">
        <NativeButton theme="warning" @click="showBlacklist = true">
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
        <div class="stat-value">{{ stats.todayCount }}</div>
        <div class="stat-label">今日访问</div>
      </NativeCard>
      <NativeCard class="stat-card">
        <div class="stat-value">{{ stats.totalCount }}</div>
        <div class="stat-label">总记录数</div>
      </NativeCard>
      <NativeCard class="stat-card">
        <div class="stat-value">{{ stats.todayActiveUsers }}</div>
        <div class="stat-label">今日活跃用户</div>
      </NativeCard>
      <NativeCard class="stat-card">
        <div class="stat-value">{{ pagination.total }}</div>
        <div class="stat-label">筛选结果</div>
      </NativeCard>
    </div>

    <!-- 筛选栏 -->
    <NativeCard class="filter-card">
      <div class="filter-btns">
        <NativeSelect
          v-model="filters.action"
          placeholder="操作类型"
          :clearable="true"
          style="width: 120px"
          :options="[
            { value: 'login', label: '登录' },
            { value: 'logout', label: '登出' },
            { value: 'upload', label: '上传' },
            { value: 'delete', label: '删除' },
            { value: 'create', label: '创建' },
            { value: 'update', label: '更新' },
            { value: 'visit', label: '访问' }
          ]"
        />
        <NativeInput v-model="filters.keyword" placeholder="搜索用户/IP/路径" style="width: 200px" />
        <NativeDateRangePicker v-model="filters.dateRange" :placeholder="['开始日期', '结束日期']" clearable style="width: 240px" />
        <NativeButton theme="primary" @click="searchLogs">查询</NativeButton>
        <NativeButton variant="outline" @click="resetFilters">重置</NativeButton>
      </div>
    </NativeCard>

    <!-- 日志表格 -->
    <NativeCard class="table-card">
      <NativeTable :dataSource="logs" :columns="columns" :loading="loading" rowKey="id" stripe hover>
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
      <div class="pagination-wrapper">
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
import { ref, onMounted } from 'vue'
import api from '@/api'
import BlacklistPanel from '@/views/admin/Blacklist.vue'
import { NativeButton, NativeInput, NativeCard, NativeSelect, NativeTag, NativePagination, NativeIcon, NativeDateRangePicker, NativeTable, NativeTooltip, NativeDrawer } from '@/components/native'

const logs = ref([])
const loading = ref(false)
const showBlacklist = ref(false)
const stats = ref({
  todayCount: 0,
  totalCount: 0,
  todayActiveUsers: 0,
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
  const date = new Date(utcTime)
  const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return utc8Date.toLocaleString('zh-CN', {
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
    visit: '访问'
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

async function loadStats() {
  try {
    const response = await api.logs.stats()
    stats.value = response.data.data
  } catch (error) {
    console.error('加载统计失败:', error)
  }
}

async function loadLogs() {
  loading.value = true
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
      params.startDate = filters.value.dateRange[0]
      params.endDate = filters.value.dateRange[1]
    }
    
    const response = await api.logs.list(params)
    logs.value = response.data.data || []
    pagination.value.total = response.data.total || 0
  } catch (error) {
    console.error('加载日志失败:', error)
    if (error.response?.status === 403) {
      toast.error('只有管理员可以查看日志')
    } else {
      toast.error('加载日志失败')
    }
  } finally {
    loading.value = false
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
  padding: 24px;
}

.logs-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.logs-header h2 {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
}

.stats-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}

.stat-card {
  text-align: center;
}

.stat-card :deep(.t-card__body) {
  padding: 24px 16px;
}

.stat-value {
  font-size: 28px;
  font-weight: bold;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  line-height: 1.2;
  transition: all 0.3s ease;
}

.stat-card:hover .stat-value {
  transform: scale(1.1);
}

.stat-label {
  font-size: 14px;
  color: #666;
  margin-top: 8px;
  transition: all 0.3s ease;
}

.stat-card:hover .stat-label {
  color: #667eea;
  transform: translateY(-2px);
}

.filter-card {
  margin-bottom: 16px;
}

.table-card {
  min-height: 400px;
}

.path-text {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
}

.slow-query {
  color: #e34d59;
  font-weight: 600;
}

.is-admin {
  font-weight: 600;
  color: var(--td-brand-color, #0052d9);
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
  gap: 12px;
  align-items: center;
}
</style>
