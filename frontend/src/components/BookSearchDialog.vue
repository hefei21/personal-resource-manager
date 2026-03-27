<template>
  <t-dialog
    v-model:visible="dialogVisible"
    header="查找电子书资源"
    :width="800"
    :footer="false"
    placement="center"
    @close="handleClose"
  >
    <div class="book-search-dialog">
      <!-- 配置区域 -->
      <div class="config-section">
        <t-space align="center">
          <t-button size="small" variant="outline" @click="showConfigDialog = true">
            <template #icon><t-icon name="setting" /></template>
            域名配置
          </t-button>
          <span class="config-status" :class="{ active: configValid }">
            {{ configValid ? '✓ 配置正常' : '⚠ 域名可能失效' }}
          </span>
        </t-space>
      </div>

      <!-- 搜索区域 -->
      <div class="search-section">
        <t-input
          v-model="searchKeyword"
          placeholder="输入书名、作者或关键词..."
          clearable
          @enter="handleSearch"
          size="large"
        >
          <template #prefix-icon>
            <t-icon name="search" />
          </template>
        </t-input>
        
        <t-select
          v-model="searchSource"
          placeholder="选择搜索源"
          style="width: 160px"
        >
          <t-option value="all" label="全部来源" />
          <t-option value="anna-archive" label="安娜档案" />
          <t-option value="nyaa" label="Nyaa (轻小说/漫画)" />
        </t-select>
        
        <t-button 
          theme="primary" 
          size="large" 
          @click="handleSearch"
          :loading="searching"
        >
          搜索
        </t-button>
      </div>

      <!-- 搜索结果 -->
      <div class="results-section" v-if="hasResults">
        <!-- Anna's Archive 结果 -->
        <div v-if="results.annaArchive.length > 0" class="result-group">
          <h4 class="result-title">
            <t-icon name="book" /> 安娜档案 ({{ results.annaArchive.length }} 条)
          </h4>
          <div class="result-list">
            <div 
              v-for="(item, index) in results.annaArchive" 
              :key="index"
              class="result-item"
            >
              <div class="item-info">
                <div class="item-title">{{ item.title }}</div>
                <div class="item-meta">
                  <t-tag v-if="item.format" size="small" variant="outline">{{ item.format }}</t-tag>
                  <t-tag v-if="item.size" size="small" variant="outline">{{ item.size }}</t-tag>
                  <t-tag v-if="item.language" size="small" variant="outline">{{ item.language }}</t-tag>
                </div>
              </div>
              <div class="item-actions">
                <t-button 
                  size="small" 
                  variant="outline"
                  @click="openLink(item.link)"
                >
                  <template #icon><t-icon name="link" /></template>
                  打开详情
                </t-button>
              </div>
            </div>
          </div>
        </div>

        <!-- Nyaa 结果 -->
        <div v-if="results.nyaa.length > 0" class="result-group">
          <h4 class="result-title">
            <t-icon name="download" /> Nyaa ({{ results.nyaa.length }} 条)
          </h4>
          <div class="result-list">
            <div 
              v-for="(item, index) in results.nyaa" 
              :key="index"
              class="result-item"
            >
              <div class="item-info">
                <div class="item-title">{{ item.title }}</div>
                <div class="item-meta">
                  <t-tag size="small" variant="outline">{{ item.size }}</t-tag>
                  <t-tag size="small" variant="outline" theme="success">
                    <t-icon name="arrow-up" /> {{ item.seeders }}
                  </t-tag>
                  <t-tag size="small" variant="outline" theme="danger">
                    <t-icon name="arrow-down" /> {{ item.leechers }}
                  </t-tag>
                  <t-tag size="small" variant="outline">{{ item.downloads }} 下载</t-tag>
                </div>
              </div>
              <div class="item-actions">
                <t-button 
                  v-if="item.magnetLink"
                  size="small" 
                  theme="primary"
                  @click="copyMagnet(item.magnetLink)"
                >
                  <template #icon><t-icon name="link" /></template>
                  复制磁力
                </t-button>
                <t-button 
                  v-if="item.torrentLink"
                  size="small" 
                  variant="outline"
                  @click="openLink(item.torrentLink)"
                >
                  <template #icon><t-icon name="download" /></template>
                  种子
                </t-button>
                <t-button 
                  size="small" 
                  variant="outline"
                  @click="openLink(item.link)"
                >
                  <template #icon><t-icon name="view" /></template>
                  详情
                </t-button>
              </div>
            </div>
          </div>
        </div>

        <!-- 无结果提示 -->
        <div v-if="results.errors && results.errors.length > 0" class="error-section">
          <t-alert theme="warning" :message="results.errors.join('; ')" />
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else-if="!searching && searched" class="empty-state">
        <t-icon name="search-close" size="48px" />
        <p>没有找到相关资源</p>
        <p class="tip">尝试更换关键词或搜索源</p>
      </div>

      <div v-else-if="!searching && !searched" class="empty-state">
        <t-icon name="book" size="48px" />
        <p>输入关键词搜索电子书</p>
        <p class="tip">支持书名、作者或任意关键词</p>
      </div>
    </div>

    <!-- 配置弹窗 -->
    <t-dialog
      v-model:visible="showConfigDialog"
      header="域名配置"
      :width="500"
      :footer="false"
    >
      <div class="config-form">
        <t-form :data="configForm" @submit="handleSaveConfig">
          <t-form-item label="安娜档案域名" name="annaArchiveDomain">
            <t-input v-model="configForm.annaArchiveDomain" placeholder="例如: annas-archive.gl" />
          </t-form-item>
          <t-form-item label="Nyaa域名" name="nyaaDomain">
            <t-input v-model="configForm.nyaaDomain" placeholder="例如: nyaa.si" />
          </t-form-item>
          <t-form-item>
            <t-space>
              <t-button theme="primary" type="submit">保存配置</t-button>
              <t-button variant="outline" @click="testDomains">测试连通性</t-button>
            </t-space>
          </t-form-item>
        </t-form>
        
        <div v-if="testResults.length > 0" class="test-results">
          <t-divider />
          <h4>测试结果</h4>
          <div v-for="(result, index) in testResults" :key="index" class="test-result">
            <t-icon :name="result.available ? 'check-circle' : 'close-circle'" 
                    :style="{ color: result.available ? 'green' : 'red' }" />
            <span>{{ result.domain }}: {{ result.message }}</span>
          </div>
        </div>
      </div>
    </t-dialog>
  </t-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import api from '@/api'

// Props
const props = defineProps({
  visible: {
    type: Boolean,
    default: false
  }
})

// Emits
const emit = defineEmits(['update:visible'])

// 状态
const dialogVisible = computed({
  get: () => props.visible,
  set: (val) => emit('update:visible', val)
})

const searchKeyword = ref('')
const searchSource = ref('all')
const searching = ref(false)
const searched = ref(false)
const results = ref({
  annaArchive: [],
  nyaa: [],
  errors: []
})

// 配置相关
const showConfigDialog = ref(false)
const configValid = ref(true)
const configForm = ref({
  annaArchiveDomain: 'annas-archive.gl',
  nyaaDomain: 'nyaa.si'
})
const testResults = ref([])

// 计算属性
const hasResults = computed(() => {
  return results.value.annaArchive.length > 0 || results.value.nyaa.length > 0
})

// 加载配置
async function loadConfig() {
  try {
    const res = await api.bookSearch.getConfig()
    if (res.data.success && res.data.data) {
      configForm.value = {
        annaArchiveDomain: res.data.data.annaArchiveDomain || 'annas-archive.gl',
        nyaaDomain: res.data.data.nyaaDomain || 'nyaa.si'
      }
    }
  } catch (error) {
    console.error('加载配置失败:', error)
  }
}

// 搜索
async function handleSearch() {
  if (!searchKeyword.value.trim()) {
    MessagePlugin.warning('请输入搜索关键词')
    return
  }

  searching.value = true
  searched.value = false
  results.value = { annaArchive: [], nyaa: [], errors: [] }

  try {
    const res = await api.bookSearch.search(searchKeyword.value.trim(), searchSource.value)

    if (res.data.success) {
      results.value = res.data.data
      searched.value = true
      
      if (res.data.total === 0) {
        MessagePlugin.info('没有找到相关资源')
      } else {
        MessagePlugin.success(`找到 ${res.data.total} 条结果`)
      }
    } else {
      MessagePlugin.error(res.data.message || '搜索失败')
    }
  } catch (error) {
    console.error('搜索失败:', error)
    MessagePlugin.error('搜索失败，请检查网络或域名配置')
  } finally {
    searching.value = false
  }
}

// 复制磁力链接
async function copyMagnet(link) {
  try {
    await navigator.clipboard.writeText(link)
    MessagePlugin.success('磁力链接已复制')
  } catch (error) {
    // 降级方案
    const textArea = document.createElement('textarea')
    textArea.value = link
    document.body.appendChild(textArea)
    textArea.select()
    document.execCommand('copy')
    document.body.removeChild(textArea)
    MessagePlugin.success('磁力链接已复制')
  }
}

// 打开链接
function openLink(link) {
  if (link) {
    window.open(link, '_blank')
  }
}

// 保存配置
async function handleSaveConfig() {
  try {
    const res = await api.bookSearch.saveConfig(configForm.value)
    if (res.data.success) {
      MessagePlugin.success('配置保存成功')
      showConfigDialog.value = false
    } else {
      MessagePlugin.error(res.data.message || '保存失败')
    }
  } catch (error) {
    console.error('保存配置失败:', error)
    MessagePlugin.error('保存失败')
  }
}

// 测试域名
async function testDomains() {
  testResults.value = []
  
  for (const domain of [configForm.value.annaArchiveDomain, configForm.value.nyaaDomain]) {
    try {
      const res = await api.bookSearch.testDomain(domain)
      testResults.value.push({
        domain,
        available: res.data.available,
        message: res.data.message
      })
    } catch (error) {
      testResults.value.push({
        domain,
        available: false,
        message: '测试失败'
      })
    }
  }
  
  configValid.value = testResults.value.every(r => r.available)
}

// 关闭
function handleClose() {
  searchKeyword.value = ''
  searched.value = false
  results.value = { annaArchive: [], nyaa: [], errors: [] }
}

// 监听弹窗打开
watch(dialogVisible, (val) => {
  if (val) {
    loadConfig()
  }
})
</script>

<style scoped>
.book-search-dialog {
  min-height: 300px;
}

.config-section {
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--td-component-border);
}

.config-status {
  font-size: 12px;
  color: var(--td-text-color-secondary);
}

.config-status.active {
  color: var(--td-success-color);
}

.search-section {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}

.results-section {
  max-height: 500px;
  overflow-y: auto;
}

.result-group {
  margin-bottom: 24px;
}

.result-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 14px;
  color: var(--td-text-color-primary);
}

.result-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.result-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 12px;
  background: var(--td-bg-color-container);
  border-radius: 6px;
  border: 1px solid var(--td-component-border);
}

.result-item:hover {
  border-color: var(--td-brand-color);
}

.item-info {
  flex: 1;
  min-width: 0;
}

.item-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--td-text-color-primary);
  margin-bottom: 8px;
  word-break: break-all;
}

.item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.item-actions {
  display: flex;
  gap: 8px;
  margin-left: 16px;
  flex-shrink: 0;
}

.error-section {
  margin-top: 16px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  color: var(--td-text-color-secondary);
}

.empty-state p {
  margin: 8px 0 0;
}

.empty-state .tip {
  font-size: 12px;
  color: var(--td-text-color-placeholder);
}

.config-form {
  padding: 16px 0;
}

.test-results {
  margin-top: 16px;
}

.test-result {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  font-size: 13px;
}
</style>
