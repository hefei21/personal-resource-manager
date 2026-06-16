<template>
  <NativeDialog
    v-model="visible"
    :title="anime?.name_cn || anime?.name || '动漫详情'"
    width="900px"
    :close-on-overlay-click="false"
    destroy-on-close
    class="anime-detail-dialog"
  >
    <div v-if="loading" class="loading-container">
      <NativeLoading size="40px" />
      <p>加载中...</p>
    </div>

    <div v-else-if="anime" class="anime-detail">
      <!-- 基本信息 -->
      <div class="basic-info">
        <div class="cover-section">
          <img :src="toHttps(anime.cover_image || anime.images?.large)" alt="封面" class="cover-image" @error="handleImageError" />
          <div class="rating-box" v-if="getRatingScore() > 0">
            <div class="rating-score">{{ getRatingScore().toFixed(1) }}</div>
            <div class="rating-count">{{ getRatingCount() }} 人评分</div>
          </div>
        </div>

        <div class="info-section">
          <h2 class="title">{{ anime.name_cn || anime.name }}</h2>
          <p class="original-name" v-if="anime.name && anime.name_cn !== anime.name">{{ anime.name }}</p>

          <div class="meta-info">
            <div class="meta-item" v-if="anime.air_date">
              <span class="label">上映日期:</span>
              <span class="value">{{ anime.air_date }}</span>
            </div>
            <div class="meta-item" v-if="anime.eps || anime.eps_total">
              <span class="label">集数:</span>
              <span class="value">{{ anime.eps || '?' }} / {{ anime.eps_total || '?' }}</span>
            </div>
            <div class="meta-item" v-if="anime.author">
              <span class="label">原作者:</span>
              <span class="value">{{ anime.author }}</span>
            </div>
            <div class="meta-item" v-if="anime.director">
              <span class="label">监督:</span>
              <span class="value">{{ anime.director }}</span>
            </div>
            <div class="meta-item" v-if="anime.studio">
              <span class="label">动画制作:</span>
              <span class="value">{{ anime.studio }}</span>
            </div>
          </div>

          <!-- 标签 -->
          <div class="tags-section" v-if="tags.length">
            <span class="label">标签:</span>
            <div class="tags-list">
              <NativeTag v-for="tag in tags.slice(0, 15)" :key="tag" size="small" theme="primary" variant="light">
                {{ tag }}
              </NativeTag>
            </div>
          </div>
        </div>
      </div>

      <!-- 简介 -->
      <div class="section" v-if="anime.summary">
        <h3 class="section-title">简介</h3>
        <p class="summary">{{ anime.summary }}</p>
      </div>

      <!-- 详细信息 -->
      <div class="section" v-if="infoboxList.length">
        <h3 class="section-title">详细信息</h3>
        <div class="infobox">
          <div class="info-row" v-for="(item, index) in infoboxList" :key="index">
            <span class="info-key">{{ item.key }}</span>
            <span class="info-value" v-html="formatInfoValue(item.value)"></span>
          </div>
        </div>
      </div>

      <!-- 角色 -->
      <div class="section" v-if="characters.length">
        <h3 class="section-title">角色 · 声优</h3>
        <div class="characters-grid">
          <div class="character-card" v-for="char in characters" :key="char.id">
            <div class="character-info">
              <img
                :src="toHttps(char.images?.small) || '/default-avatar.png'"
                :alt="char.name"
                class="character-avatar"
                @error="handleImageError"
              />
              <div class="character-details">
                <span class="character-name">{{ char.name }}</span>
                <span class="character-role" v-if="char.relation">{{ getRoleName(char.relation) }}</span>
              </div>
            </div>
            <div class="actor-info" v-if="char.actors?.length">
              <div class="actor" v-for="actor in char.actors" :key="actor.id">
                <img
                  :src="actor.images?.small || '/default-avatar.png'"
                  :alt="actor.name"
                  class="actor-avatar"
                  @error="handleImageError"
                />
                <span class="actor-name">{{ actor.name }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 制作人员 -->
      <div class="section" v-if="staff.length">
        <h3 class="section-title">制作人员</h3>
        <div class="staff-grid">
          <div class="staff-card" v-for="person in staff" :key="person.id">
            <img
              :src="toHttps(person.images?.small) || '/default-avatar.png'"
              :alt="person.name"
              class="staff-avatar"
              @error="handleImageError"
            />
            <div class="staff-details">
              <span class="staff-name">{{ person.name }}</span>
              <span class="staff-role">{{ person.positions?.join(' / ') || person.relation }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 关联作品 -->
      <div class="relations-section" v-if="relations.length > 0">
        <h3 class="section-title">关联作品</h3>
        <div class="relations-grid">
          <div v-for="rel in relations" :key="rel.id" class="relation-item" @click="openRelationDetail(rel)">
            <img :src="toHttps(rel.images?.small)" :alt="rel.name" class="relation-cover" @error="handleImageError" />
            <div class="relation-info">
              <span class="relation-type">{{ rel.relation }}</span>
              <span class="relation-name">{{ rel.name_cn || rel.name }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 资源搜索结果 -->
    <div class="resources-section" v-if="showResources && resources.length > 0">
      <h3 class="section-title">资源列表</h3>
      <div class="resources-list">
        <div v-for="(res, index) in resources" :key="index" class="resource-item">
          <div class="resource-info">
            <span class="resource-title">{{ res.title }}</span>
            <div class="resource-meta">
              <span v-if="res.size">大小: {{ res.size }}</span>
              <span v-if="res.seeders">种子: {{ res.seeders }}</span>
              <span v-if="res.downloads">下载: {{ res.downloads }}</span>
            </div>
          </div>
          <NativeButton size="small" theme="primary" variant="outline" @click="copyMagnet(res.magnetLink)">
            复制磁力
          </NativeButton>
        </div>
      </div>
    </div>
    <div class="resources-section" v-if="showResources && resources.length === 0 && !searchingResources">
      <p class="no-resources">未找到相关资源</p>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <!-- 查找资源按钮 -->
        <NativeButton variant="outline" @click="searchResources" :loading="searchingResources">
          <template #icon><NativeIcon name="magnifying-glass" /></template>
          查找资源
        </NativeButton>
        <!-- 已收藏状态下的操作 -->
        <template v-if="isImported && localAnime">
          <NativeButton variant="outline" @click="refreshAnime" :loading="refreshing" :disabled="isGuest">
            <template #icon><NativeIcon name="arrow-clockwise" /></template>
            刷新
          </NativeButton>
          <NativeSelect v-model="localAnime.status" style="width: 100px" @change="updateStatus" v-if="!isGuest" :options="[
            { value: 'none', label: '未标记' },
            { value: 'want_to_watch', label: '想看' },
            { value: 'watching', label: '在看' },
            { value: 'watched', label: '看过' }
          ]" />
          <NativeButton
            :theme="localAnime.is_favorite ? 'danger' : 'default'"
            variant="outline"
            @click="toggleFavorite"
            :disabled="isGuest"
          >
            <template #icon><NativeIcon :name="localAnime.is_favorite ? 'heart-fill' : 'heart'" /></template>
            {{ localAnime.is_favorite ? '取消收藏' : '收藏' }}
          </NativeButton>
          <NativePopconfirm content="确定删除吗？" @confirm="handleDelete" v-if="!isGuest">
            <NativeButton theme="danger" variant="outline">
              <template #icon><NativeIcon name="trash" /></template>
              删除
            </NativeButton>
          </NativePopconfirm>
        </template>
        <NativeButton variant="outline" @click="visible = false">关闭</NativeButton>
        <!-- 添加按钮：未收藏显示添加，已收藏显示已添加 -->
        <NativeButton theme="primary" @click="handleImport" v-if="!isImported" :disabled="importing || isGuest">
          <template #icon><NativeIcon name="plus" /></template>
          添加到收藏
        </NativeButton>
        <NativeButton v-else disabled>
          <template #icon><NativeIcon name="check" /></template>
          已添加
        </NativeButton>
      </div>
    </template>
  </NativeDialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import api from '../api'
import { usePermission } from '@/composables/usePermission'
import { NativeButton, NativeInput, NativeCard, NativeDialog, NativeRow, NativeCol, NativeCheckbox, NativeIcon, NativeTag, NativeSelect, NativePopconfirm } from '@/components/native'
import { useToast } from '@/composables/useToast'

const toast = useToast()
const { isGuest } = usePermission()

const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false
  },
  bangumiId: {
    type: [Number, String],
    default: null
  },
  animeData: {
    type: Object,
    default: null
  }
})

const emit = defineEmits(['update:modelValue', 'imported', 'openRelation'])

const visible = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

const loading = ref(false)
const anime = ref(null)
const characters = ref([])
const staff = ref([])
const relations = ref([])
const isImported = ref(false)
const localAnime = ref(null)
const importing = ref(false)
const searchingResources = ref(false)
const showResources = ref(false)
const resources = ref([])
const refreshing = ref(false)

// 标签列表
const tags = computed(() => {
  if (!anime.value?.tags) return []
  if (Array.isArray(anime.value.tags)) {
    return anime.value.tags.map(t => typeof t === 'string' ? t : t.name)
  }
  if (typeof anime.value.tags === 'string') {
    return anime.value.tags.split(',').filter(Boolean)
  }
  return []
})

// infobox 列表
const infoboxList = computed(() => {
  if (!anime.value?.infobox) return []
  const infobox = anime.value.infobox
  if (Array.isArray(infobox)) return infobox
  if (typeof infobox === 'string') {
    try {
      return JSON.parse(infobox)
    } catch {
      return []
    }
  }
  return []
})

// 获取角色名称
function getRoleName(relation) {
  const roleMap = {
    '主角': '主角',
    '配角': '配角',
    '客串': '客串'
  }
  return roleMap[relation] || relation
}

// 格式化信息值
function formatInfoValue(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(v => {
      if (typeof v === 'string') return v
      // 只返回文本，不添加链接
      if (v.v) return v.v
      if (v.name) return v.name
      return String(v)
    }).join('、')
  }
  if (value?.v) return value.v
  return String(value)
}

// 图片加载失败处理
function handleImageError(e) {
  e.target.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDUwIDUwIj48cmVjdCB3aWR0aD0iNTAiIGhlaWdodD0iNTAiIGZpbGw9IiNlZWUiLz48dGV4dCB4PSIyNSIgeT0iMjUiIGZpbGw9IiM5OTkiIGZvbnQtc2l6ZT0iMTIiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj7ml6Dlm77niYc8L3RleHQ+PC9zdmc+'
}

// HTTP 转 HTTPS
function toHttps(url) {
  if (!url) return url
  return url.replace(/^http:\/\//, 'https://')
}

// 获取评分（兼容数据库数字和 API 对象）
function getRatingScore() {
  if (!anime.value) return 0
  // 如果 rating 是数字（本地数据库）
  if (typeof anime.value.rating === 'number') {
    return anime.value.rating
  }
  // 如果 rating 是对象（Bangumi API）
  if (anime.value.rating?.score) {
    return anime.value.rating.score
  }
  return 0
}

// 获取评分人数
function getRatingCount() {
  if (!anime.value) return 0
  return anime.value.rating_count || anime.value.rating?.total || 0
}

// 加载详情
async function loadDetail() {
  // 如果没有数据，直接返回
  if (!props.bangumiId && !props.animeData) return

  loading.value = true
  isImported.value = false
  localAnime.value = null
  relations.value = []

  // 重置资源搜索状态
  showResources.value = false
  resources.value = []
  searchingResources.value = false

  try {
    // 如果传入的是本地数据（有 bangumi_id 字段），直接使用
    // 注意：搜索结果数据只有 id（Bangumi ID），没有 bangumi_id 字段
    if (props.animeData?.bangumi_id) {
      anime.value = props.animeData
      characters.value = props.animeData.characters || []
      staff.value = props.animeData.staff || []
      isImported.value = true
      localAnime.value = props.animeData

      // 获取关联作品
      try {
        const relRes = await api.anime.getRelations(props.animeData.bangumi_id)
        relations.value = relRes.data.data || []
      } catch {
        relations.value = []
      }
      loading.value = false
      return
    }

    // 确定要使用的 Bangumi ID
    const bangumiId = props.bangumiId || props.animeData?.id
    
    if (!bangumiId && props.animeData) {
      // 只有 animeData 没有 bangumiId 和 id 的情况（不应该发生，但作为兜底）
      anime.value = props.animeData
      isImported.value = false
      loading.value = false
      return
    }

    // 尝试从数据库获取（只调用一次）
    try {
      const dbRes = await api.anime.getByBangumiId(bangumiId)
      if (dbRes.data.data) {
        anime.value = dbRes.data.data
        characters.value = dbRes.data.data.characters || []
        staff.value = dbRes.data.data.staff || []
        isImported.value = true
        localAnime.value = dbRes.data.data

        // 获取关联作品
        try {
          const relRes = await api.anime.getRelations(bangumiId)
          relations.value = relRes.data.data || []
        } catch {
          relations.value = []
        }
        loading.value = false
        return
      }
    } catch {
      // 数据库中没有，继续从 API 获取
    }

    // 数据库没有，从 Bangumi API 获取
    if (bangumiId) {
      const res = await api.anime.getDetail(bangumiId)
      const data = res.data.data

      anime.value = data.subject
      characters.value = data.characters || []
      staff.value = data.persons || []

      // 数据库中没有，所以 isImported 保持 false
      isImported.value = false
      localAnime.value = null

      // 获取关联作品
      try {
        const relRes = await api.anime.getRelations(bangumiId)
        relations.value = relRes.data.data || []
      } catch {
        relations.value = []
      }
    }
  } catch (error) {
    console.error('加载详情失败:', error)
    const errorMsg = error.response?.data?.message || error.message || '加载详情失败'
    toast.error(errorMsg)
  } finally {
    loading.value = false
  }
}

// 导入动漫
async function handleImport() {
  importing.value = true
  try {
    // 使用 bangumiId 或 animeData 中的 id/bangumi_id（搜索结果用 id，本地数据用 bangumi_id）
    const targetId = props.bangumiId || props.animeData?.id || anime.value?.bangumi_id || props.animeData?.bangumi_id
    if (!targetId) {
      toast.error('无法获取动漫ID')
      return
    }
    await api.anime.import(targetId)
    toast.success('添加成功')
    isImported.value = true
    emit('imported')
  } catch (error) {
    toast.error(error.response?.data?.message || '添加失败')
  } finally {
    importing.value = false
  }
}

// 打开关联作品详情
function openRelationDetail(rel) {
  emit('openRelation', {
    bangumiId: rel.id,
    animeData: {
      id: rel.id,  // 使用 id 而不是 bangumi_id，表示这是搜索结果
      name: rel.name,
      name_cn: rel.name_cn,
      cover_image: rel.images?.large || rel.images?.small,
      images: rel.images,
      rating: rel.rating?.score || rel.rating,
      rating_count: rel.rating?.total || 0,
      summary: rel.summary
    }
  })
  visible.value = false
}

// 搜索资源
async function searchResources() {
  const keyword = anime.value?.name_cn || anime.value?.title || anime.value?.name
  if (!keyword) {
    toast.warning('无法获取动漫名称')
    return
  }

  searchingResources.value = true
  showResources.value = true
  resources.value = []

  // 从 localStorage 获取搜索模式配置
  const searchMode = localStorage.getItem('resourceSearchMode') || 'parallel'

  try {
    const response = await api.anime.searchResources(keyword, searchMode)
    resources.value = response.data.data || []
    if (resources.value.length === 0) {
      toast.info('未找到相关资源')
    } else {
      const modeText = searchMode === 'sequential' ? '顺序优先' : '同时多源'
      toast.success(`找到 ${resources.value.length} 条资源 (${modeText}模式)`)
    }
  } catch (error) {
    toast.error('搜索资源失败')
  } finally {
    searchingResources.value = false
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

// 更新状态
async function updateStatus(status) {
  if (!localAnime.value) return
  try {
    await api.anime.updateStatus(localAnime.value.id, status)
    toast.success('状态已更新')
    emit('updated')
  } catch (error) {
    toast.error('更新失败')
  }
}

// 切换收藏
async function toggleFavorite() {
  if (!localAnime.value) return
  try {
    await api.anime.toggleFavorite(localAnime.value.id)
    localAnime.value.is_favorite = !localAnime.value.is_favorite
    toast.success(localAnime.value.is_favorite ? '已收藏' : '已取消收藏')
    emit('updated')
  } catch (error) {
    toast.error('操作失败')
  }
}

// 删除
async function handleDelete() {
  if (!localAnime.value) return
  try {
    await api.anime.delete(localAnime.value.id)
    toast.success('删除成功')
    visible.value = false
    emit('deleted')
  } catch (error) {
    toast.error('删除失败')
  }
}

// 刷新动漫信息
async function refreshAnime() {
  if (!localAnime.value) return
  
  refreshing.value = true
  try {
    const response = await api.anime.refresh(localAnime.value.id)
    toast.success('刷新成功')
    
    // 更新本地数据
    anime.value = response.data.data
    localAnime.value = response.data.data
    characters.value = response.data.data.characters || []
    staff.value = response.data.data.staff || []
    
    emit('updated')
  } catch (error) {
    toast.error(error.response?.data?.message || '刷新失败')
  } finally {
    refreshing.value = false
  }
}

// 监听打开
watch(visible, (val) => {
  if (val) {
    loadDetail()
  }
})

// 监听 bangumiId 变化
watch(() => props.bangumiId, () => {
  if (visible.value) {
    loadDetail()
  }
})
</script>

<style scoped>
.anime-detail-dialog :deep(.native-dialog__body) {
  max-height: 70vh;
  overflow-y: auto;
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px;
  color: #909399;
}

.anime-detail {
  padding: 0 10px;
}

.basic-info {
  display: flex;
  gap: 24px;
  margin-bottom: 24px;
}

.cover-section {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cover-image {
  width: 200px;
  height: 280px;
  object-fit: cover;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
}

.rating-box {
  text-align: center;
  padding: 12px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 8px;
  color: white;
}

.rating-score {
  font-size: 28px;
  font-weight: bold;
}

.rating-count {
  font-size: 12px;
  opacity: 0.9;
}

.info-section {
  flex: 1;
}

.title {
  font-size: 24px;
  margin: 0 0 8px;
  color: #303133;
}

.original-name {
  color: #909399;
  font-size: 14px;
  margin: 0 0 16px;
}

.meta-info {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 16px;
}

.meta-item {
  display: flex;
  gap: 8px;
}

.meta-item .label {
  color: #909399;
  font-size: 14px;
}

.meta-item .value {
  color: #606266;
  font-size: 14px;
}

.tags-section {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.tags-section .label {
  color: #909399;
  font-size: 14px;
  flex-shrink: 0;
  line-height: 24px;
}

.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 16px;
  color: #303133;
  margin: 0 0 12px;
  padding-bottom: 8px;
  border-bottom: 2px solid #0052d9;
}

.summary {
  color: #606266;
  line-height: 1.8;
  margin: 0;
  text-indent: 2em;
}

.infobox {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 8px;
}

.info-row {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  background: #f5f7fa;
  border-radius: 4px;
}

.info-key {
  color: #909399;
  flex-shrink: 0;
  min-width: 60px;
}

.info-value {
  color: #606266;
}

.info-value :deep(a) {
  color: #0052d9;
  text-decoration: none;
}

.info-value :deep(a:hover) {
  text-decoration: underline;
}

.characters-grid, .staff-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.character-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background: #f5f7fa;
  border-radius: 8px;
}

.character-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.character-avatar, .actor-avatar, .staff-avatar {
  width: 50px;
  height: 50px;
  border-radius: 50%;
  object-fit: cover;
}

.character-details, .staff-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.character-name, .staff-name {
  font-weight: 500;
  color: #303133;
}

.character-role, .staff-role {
  font-size: 12px;
  color: #909399;
}

.actor-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.actor {
  display: flex;
  align-items: center;
  gap: 8px;
}

.actor-avatar {
  width: 36px;
  height: 36px;
}

.actor-name {
  font-size: 13px;
  color: #606266;
}

.staff-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: #f5f7fa;
  border-radius: 8px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.dialog-footer :deep(.native-select) {
  width: 100px;
}

.dialog-footer :deep(.native-select__trigger) {
  height: 32px !important;
  min-height: 32px !important;
  padding: 0 12px !important;
  box-sizing: border-box;
  font-size: 14px;
}

/* 确保下拉框在对话框中正确显示 */
.dialog-footer :deep(.native-select) {
  position: relative;
}

.dialog-footer :deep(.native-select__dropdown) {
  z-index: 99999 !important;
}

.dialog-footer :deep(.native-select__dropdown) {
  z-index: 99999 !important;
}

@media (max-width: 768px) {
  .basic-info {
    flex-direction: column;
    align-items: center;
  }

  .cover-section {
    align-items: center;
  }

  .info-section {
    text-align: center;
  }

  .meta-info {
    justify-content: center;
  }

  .tags-section {
    flex-direction: column;
    align-items: center;
  }

  .characters-grid, .staff-grid {
    grid-template-columns: 1fr;
  }
}

/* 关联作品样式 */
.relations-section {
  margin-top: 24px;
}

.relations-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.relation-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  background: #f5f7fa;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
}

.relation-item:hover {
  background: #e9ecf0;
}

.relation-cover {
  width: 50px;
  height: 70px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}

.relation-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.relation-type {
  font-size: 12px;
  color: #909399;
}

.relation-name {
  font-size: 13px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 资源列表样式 */
.resources-section {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid #e5e5e5;
}



.resources-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 300px;
  overflow-y: auto;
}

.resource-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background: #f5f7fa;
  border-radius: 8px;
  gap: 12px;
}

.resource-info {
  flex: 1;
  min-width: 0;
}

.resource-title {
  display: block;
  font-size: 14px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 4px;
}

.resource-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #909399;
}

.no-resources {
  text-align: center;
  color: #909399;
  padding: 20px;
}
</style>
