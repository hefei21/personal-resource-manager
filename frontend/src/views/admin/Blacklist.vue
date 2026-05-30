<template>
  <div class="blacklist-page">
    <!-- 统计卡片 -->
    <div class="stats-cards">
      <div class="stat-card">
        <div class="stat-value">{{ stats.total }}</div>
        <div class="stat-label">累计拉黑</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.active }}</div>
        <div class="stat-label">生效中</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.permanent }}</div>
        <div class="stat-label">永久拉黑</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.todayBlocked }}</div>
        <div class="stat-label">今日新增</div>
      </div>
    </div>

    <!-- 操作栏 -->
    <div class="toolbar">
      <NativeInput
        v-model="keyword"
        placeholder="搜索IP地址或原因"
        clearable
        @enter="loadData"
        style="width: 300px"
      >
        <template #suffix>
          <NativeButton theme="primary" variant="text" @click="loadData">
            <template #icon><NativeIcon name="magnifying-glass" /></template>
          </NativeButton>
        </template>
      </NativeInput>
      <NativeButton theme="primary" size="medium" @click="showBlockDialog = true">
        <template #icon><NativeIcon name="plus" /></template>
        手动拉黑
      </NativeButton>
    </div>

    <!-- 黑名单列表 -->
    <NativeTable
      :dataSource="blacklist"
      :columns="columns"
      :loading="loading"
      rowKey="id"
    >
      <template #cell-is_permanent="{ row }">
        <NativeTag :theme="row.is_permanent ? 'danger' : 'warning'" variant="light">
          {{ row.is_permanent ? '永久' : '临时' }}
        </NativeTag>
      </template>
      <template #cell-expires_at="{ row }">
        <span v-if="row.is_permanent">-</span>
        <span v-else-if="isExpired(row.expires_at)" class="expired">已过期</span>
        <span v-else>{{ formatDate(row.expires_at) }}</span>
      </template>
      <template #cell-blocked_at="{ row }">
        {{ formatDate(row.blocked_at) }}
      </template>
      <template #cell-action="{ row }">
        <NativeButton theme="primary" variant="text" @click="unblock(row)">
          解除
        </NativeButton>
      </template>
    </NativeTable>

    <!-- 分页 -->
    <div class="pagination-wrapper" v-if="pagination.total > 0">
      <NativePagination
        :current="pagination.current"
        :page-size="pagination.pageSize"
        :total="pagination.total"
        :page-size-options="[10, 20, 50, 100]"
        @change="onPageChange"
      />
    </div>

    <!-- 手动拉黑对话框 -->
    <NativeDialog
      v-model="showBlockDialog"
      title="手动拉黑IP"
      width="500px"
      @confirm="confirmBlock"
    >
      <div class="block-form">
        <div class="form-item">
          <label class="form-label required">IP地址</label>
          <NativeInput v-model="blockForm.ipAddress" placeholder="请输入要拉黑的IP地址" />
        </div>
        <div class="form-item">
          <label class="form-label">拉黑原因</label>
          <NativeTextarea v-model="blockForm.reason" placeholder="请输入拉黑原因" />
        </div>
        <div class="form-item">
          <label class="form-label">拉黑时长</label>
          <NativeRadioGroup v-model="blockForm.durationType">
            <NativeRadio value="24">24小时</NativeRadio>
            <NativeRadio value="168">7天</NativeRadio>
            <NativeRadio value="720">30天</NativeRadio>
            <NativeRadio value="-1">永久</NativeRadio>
          </NativeRadioGroup>
        </div>
      </div>
    </NativeDialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import axios from 'axios'
import { NativeButton, NativeInput, NativeDialog, NativeTag, NativeTextarea, NativeRadio, NativeRadioGroup, NativeIcon, NativeTable, NativePagination } from '@/components/native'

// 创建带 token 的 axios 实例
const apiClient = axios.create({
  baseURL: '/api'
})

// 请求拦截器：自动添加 token
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token') || sessionStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

const loading = ref(false)
const blacklist = ref([])
const stats = reactive({
  total: 0,
  active: 0,
  permanent: 0,
  todayBlocked: 0
})
const keyword = ref('')
const pagination = reactive({
  current: 1,
  pageSize: 20,
  total: 0
})

const columns = [
  { key: 'ip_address', title: 'IP地址', width: 140 },
  { key: 'reason', title: '拉黑原因' },
  { key: 'is_permanent', title: '类型', width: 100, align: 'center' },
  { key: 'triggered_count', title: '触发次数', width: 100, align: 'center' },
  { key: 'blocked_at', title: '拉黑时间', width: 160 },
  { key: 'expires_at', title: '过期时间', width: 160 },
  { key: 'action', title: '操作', width: 80 }
]

const showBlockDialog = ref(false)
const blockForm = reactive({
  ipAddress: '',
  reason: '',
  durationType: '24'
})

onMounted(() => {
  loadData()
  loadStats()
})

async function loadData() {
  loading.value = true
  try {
    const res = await apiClient.get('/admin/blacklist', {
      params: {
        page: pagination.current,
        pageSize: pagination.pageSize,
        keyword: keyword.value
      }
    })
    if (res.data) {
      blacklist.value = res.data.data
      pagination.total = res.data.total
    }
  } catch (error) {
    toast.error('加载黑名单失败: ' + error.message)
  } finally {
    loading.value = false
  }
}

async function loadStats() {
  try {
    const res = await apiClient.get('/admin/blacklist/stats')
    if (res.data) {
      Object.assign(stats, res.data.data)
    }
  } catch (error) {
    console.error('加载统计失败:', error)
  }
}

function onPageChange(pageInfo) {
  pagination.current = pageInfo.current
  pagination.pageSize = pageInfo.pageSize
  loadData()
}

async function unblock(row) {
  try {
    await apiClient.post('/admin/blacklist/unblock', {
      ipAddress: row.ip_address
    })
    toast.success(`已解除 ${row.ip_address} 的拉黑状态`)
    loadData()
    loadStats()
  } catch (error) {
    toast.error('解除拉黑失败: ' + error.message)
  }
}

async function confirmBlock() {
  if (!blockForm.ipAddress) {
    toast.warning('请输入IP地址')
    return
  }

  try {
    await apiClient.post('/admin/blacklist/block', {
      ipAddress: blockForm.ipAddress,
      reason: blockForm.reason || '手动拉黑',
      durationHours: parseInt(blockForm.durationType)
    })
    toast.success(`已拉黑 ${blockForm.ipAddress}`)
    showBlockDialog.value = false
    blockForm.ipAddress = ''
    blockForm.reason = ''
    blockForm.durationType = '24'
    loadData()
    loadStats()
  } catch (error) {
    toast.error('拉黑失败: ' + error.message)
  }
}

function formatDate(dateStr) {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN')
}

function isExpired(expiresAt) {
  if (!expiresAt) return false
  return new Date(expiresAt) < new Date()
}
</script>

<style scoped>
.blacklist-page {
  padding: 0;
}

.stats-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}

.stat-card {
  background: var(--td-bg-color-container);
  border-radius: 8px;
  padding: 20px;
  text-align: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.stat-value {
  font-size: 32px;
  font-weight: 700;
  color: var(--td-brand-color);
  margin-bottom: 8px;
}

.stat-label {
  font-size: 14px;
  color: var(--td-text-color-secondary);
}

.toolbar {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.expired {
  color: var(--td-text-color-secondary);
  font-style: italic;
}

.pagination-wrapper {
  display: flex;
  justify-content: center;
  margin-top: 24px;
}

.block-form {
  padding: 16px 0;
}

.form-item {
  margin-bottom: 20px;
}

.form-label {
  display: block;
  margin-bottom: 8px;
  font-size: 14px;
  color: #333;
  font-weight: 500;
}

.form-label.required::before {
  content: '*';
  color: #e34d59;
  margin-right: 4px;
}
</style>
