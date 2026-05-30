<template>
  <NativeDialog
    v-model="dialogVisible"
    title="查找电子书资源"
    :width="800"
    :footer="false"
    placement="center"
    @close="handleClose"
  >
    <div class="book-search-dialog">
      <!-- 配置区域 -->
      <div class="config-section">
        <div class="config-row">
          <NativeButton size="small" variant="outline" @click="showConfigDialog = true" :disabled="isGuest">
            <template #icon><NativeIcon name="gear" /></template>
            域名配置
          </NativeButton>
          <span class="config-status" :class="{ active: configValid }">
            {{ configValid ? '✓ 配置正常' : '⚠ 域名可能失效' }}
          </span>
        </div>
      </div>

      <!-- 搜索区域 -->
      <div class="search-section">
        <NativeInput
          v-model="searchKeyword"
          placeholder="输入书名、作者或关键词..."
          clearable
          @enter="handleSearch"
          size="large"
        >
          <template #prefix-icon>
            <NativeIcon name="magnifying-glass" />
          </template>
        </NativeInput>
        
        <NativeSelect
          v-model="searchSource"
          placeholder="选择搜索源"
          style="width: 160px"
          :options="[
            { value: 'all', label: '全部来源' },
            { value: 'anna-archive', label: '安娜档案' },
            { value: 'nyaa', label: 'Nyaa (轻小说/漫画)' }
          ]"
        />
        
        <NativeButton 
          theme="primary" 
          size="large" 
          @click="handleSearch"
          :loading="searching"
        >
          搜索
        </NativeButton>
      </div>

      <!-- 搜索结果 -->
      <div class="results-section" v-if="hasResults">
        <!-- Anna's Archive 结果 -->
        <div v-if="results.annaArchive.length > 0" class="result-group">
          <h4 class="result-title">
            <NativeIcon name="book" /> 安娜档案 ({{ results.annaArchive.length }} 条)
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
                  <NativeTag v-if="item.format" theme="primary" variant="outline" size="small">{{ item.format }}</NativeTag>
                  <NativeTag v-if="item.size" theme="default" variant="outline" size="small">{{ item.size }}</NativeTag>
                  <NativeTag v-if="item.language" theme="success" variant="outline" size="small">{{ item.language }}</NativeTag>
                </div>
              </div>
              <div class="item-actions">
                <NativeButton 
                  size="small" 
                  variant="outline"
                  @click="openLink(item.link)"
                >
                  <template #icon><NativeIcon name="link" /></template>
                  打开详情
                </NativeButton>
              </div>
            </div>
          </div>
        </div>

        <!-- Nyaa 结果 -->
        <div v-if="results.nyaa.length > 0" class="result-group">
          <h4 class="result-title">
            <NativeIcon name="download" /> Nyaa ({{ results.nyaa.length }} 条)
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
                  <NativeTag v-if="item.format" variant="outline" theme="primary">{{ item.format }}</NativeTag>
                  <NativeTag variant="outline">{{ item.size }}</NativeTag>
                  <NativeTag variant="outline" theme="success">
                    ↑ {{ item.seeders }}
                  </NativeTag>
                  <NativeTag variant="outline" theme="danger">
                    ↓ {{ item.leechers }}
                  </NativeTag>
                  <NativeTag variant="outline">{{ item.downloads }} 下载</NativeTag>
                </div>
              </div>
              <div class="item-actions">
                <NativeButton 
                  v-if="item.magnetLink"
                  size="small" 
                  theme="primary"
                  @click="copyMagnet(item.magnetLink)"
                >
                  <template #icon><NativeIcon name="link" /></template>
                  复制磁力
                </NativeButton>
                <NativeButton 
                  v-if="item.torrentLink"
                  size="small" 
                  variant="outline"
                  @click="openLink(item.torrentLink)"
                >
                  <template #icon><NativeIcon name="download" /></template>
                  种子
                </NativeButton>
                <NativeButton 
                  size="small" 
                  variant="outline"
                  @click="openLink(item.link)"
                >
                  <template #icon><NativeIcon name="globe" /></template>
                  详情
                </NativeButton>
              </div>
            </div>
          </div>
        </div>

        <!-- 无结果提示 -->
        <div v-if="results.errors && results.errors.length > 0" class="error-section">
          <NativeAlert theme="warning" :message="results.errors.join('; ')" />
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else-if="!searching && searched" class="empty-state">
        <NativeIcon name="magnifying-glass-slash" size="48" />
        <p>没有找到相关资源</p>
        <p class="tip">尝试更换关键词或搜索源</p>
      </div>

      <div v-else-if="!searching && !searched" class="empty-state">
        <NativeIcon name="book" size="48" />
        <p>输入关键词搜索电子书</p>
        <p class="tip">支持书名、作者或任意关键词</p>
      </div>
    </div>

    <!-- 配置弹窗 -->
    <NativeDialog
      v-model="showConfigDialog"
      title="域名配置"
      :width="500"
      :footer="false"
      @close="showConfigDialog = false"
    >
      <div class="config-form">
        <NativeForm :modelValue="configForm" @submit="handleSaveConfig">
          <NativeFormItem label="安娜档案域名" prop="annaArchiveDomain">
            <NativeInput v-model="configForm.annaArchiveDomain" placeholder="例如: annas-archive.gl" />
          </NativeFormItem>
          <NativeFormItem label="Nyaa域名" prop="nyaaDomain">
            <NativeInput v-model="configForm.nyaaDomain" placeholder="例如: nyaa.si" />
          </NativeFormItem>
          <NativeFormItem>
            <div class="config-btns">
              <NativeButton theme="primary" type="submit">保存配置</NativeButton>
              <NativeButton variant="outline" @click="testDomains" :loading="testingDomains">测试连通性</NativeButton>
            </div>
          </NativeFormItem>
        </NativeForm>
        
        <div v-if="testResults.length > 0" class="test-results">
          <div class="divider-line" />
          <h4>测试结果</h4>
          <div v-for="(result, index) in testResults" :key="index" class="test-result">
            <NativeIcon :name="result.available ? 'check-circle' : 'close-circle'" 
                    :style="{ color: result.available ? 'green' : 'red' }" />
            <span>{{ result.domain }}: {{ result.message }}</span>
          </div>
        </div>
      </div>
    </NativeDialog>
  </NativeDialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import api from '@/api'
import { usePermission } from '@/composables/usePermission'
import { NativeButton, NativeInput, NativeCard, NativeDialog, NativeRow, NativeCol, NativeCheckbox, NativeIcon, NativeForm, NativeFormItem } from '@/components/native'
import { useToast } from '@/composables/useToast'

const toast = useToast()
const { isGuest } = usePermission()

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
const testingDomains = ref(false)

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
    toast.warning('请输入搜索关键词')
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
        toast.info('没有找到相关资源')
      } else {
        toast.success(`找到 ${res.data.total} 条结果`)
      }
    } else {
      toast.error(res.data.message || '搜索失败')
    }
  } catch (error) {
    console.error('搜索失败:', error)
    toast.error('搜索失败，请检查网络或域名配置')
  } finally {
    searching.value = false
  }
}

// 复制磁力链接
async function copyMagnet(link) {
  try {
    await navigator.clipboard.writeText(link)
    toast.success('磁力链接已复制')
  } catch (error) {
    // 降级方案
    const textArea = document.createElement('textarea')
    textArea.value = link
    document.body.appendChild(textArea)
    textArea.select()
    document.execCommand('copy')
    document.body.removeChild(textArea)
    toast.success('磁力链接已复制')
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
      toast.success('配置保存成功')
      showConfigDialog.value = false
    } else {
      toast.error(res.data.message || '保存失败')
    }
  } catch (error) {
    console.error('保存配置失败:', error)
    toast.error('保存失败')
  }
}

// 测试域名
async function testDomains() {
  testingDomains.value = true
  testResults.value = []
  
  try {
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
  } finally {
    testingDomains.value = false
  }
}

// 确定按钮保存配置
async function handleConfirmConfig() {
  await handleSaveConfig()
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

.config-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.divider-line {
  height: 1px;
  background: var(--td-component-border);
  margin: 16px 0;
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

.config-btns {
  display: flex;
  gap: 12px;
}
</style>
