<template>
  <t-dialog
    v-model:visible="visible"
    :header="anime?.name_cn || anime?.name || '动漫详情'"
    width="900px"
    :close-on-overlay-click="false"
    destroy-on-close
    class="anime-detail-dialog"
  >
    <div v-if="loading" class="loading-container">
      <t-loading size="40px" />
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
              <t-tag v-for="tag in tags.slice(0, 15)" :key="tag" size="small" theme="primary" variant="light">
                {{ tag }}
              </t-tag>
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
          <t-button size="small" theme="primary" variant="outline" @click="copyMagnet(res.magnetLink)">
            复制磁力
          </t-button>
        </div>
      </div>
    </div>
    <div class="resources-section" v-if="showResources && resources.length === 0 && !searchingResources">
      <p class="no-resources">未找到相关资源</p>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <!-- 查找资源按钮 -->
        <t-button variant="outline" @click="searchResources" :loading="searchingResources">
          <template #icon><t-icon name="search" /></template>
          查找资源
        </t-button>
        <!-- 已收藏状态下的操作 -->
        <template v-if="isImported && localAnime">
          <t-select v-model="localAnime.status" style="width: 100px" @change="updateStatus">
            <t-option value="none" label="未标记" />
            <t-option value="watching" label="想看" />
            <t-option value="watched" label="看过" />
          </t-select>
          <t-button
            :theme="localAnime.is_favorite ? 'danger' : 'default'"
            variant="outline"
            @click="toggleFavorite"
          >
            <template #icon><t-icon :name="localAnime.is_favorite ? 'heart-filled' : 'heart'" /></template>
            {{ localAnime.is_favorite ? '取消收藏' : '收藏' }}
          </t-button>
          <t-popconfirm content="确定删除吗？" @confirm="handleDelete">
            <t-button theme="danger" variant="outline">
              <template #icon><t-icon name="delete" /></template>
              删除
            </t-button>
          </t-popconfirm>
        </template>
        <t-button variant="outline" @click="visible = false">关闭</t-button>
        <!-- 添加按钮：未收藏显示添加，已收藏显示已添加 -->
        <t-button theme="primary" @click="handleImport" v-if="!isImported && !localAnime" :disabled="importing">
          <template #icon><t-icon name="add" /></template>
          添加到收藏
        </t-button>
        <t-button v-else-if="isImported && localAnime" disabled>
          <template #icon><t-icon name="check" /></template>
          已添加
        </t-button>
      </div>
    </template>
  </t-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import api from '../api'

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

  try {
    // 如果传入的是本地数据，直接使用（不再调用 API）
    if (props.animeData) {
      anime.value = props.animeData

      // 解析 JSON 字段
      if (typeof props.animeData.characters === 'string') {
        try {
          characters.value = JSON.parse(props.animeData.characters)
        } catch {
          characters.value = []
        }
      } else {
        characters.value = props.animeData.characters || []
      }

      if (typeof props.animeData.staff === 'string') {
        try {
          staff.value = JSON.parse(props.animeData.staff)
        } catch {
          staff.value = []
        }
      } else {
        staff.value = props.animeData.staff || []
      }

      // 检查是否已导入
      // 如果有 bangumi_id，检查该 bangumi_id 是否在库中
      if (props.animeData.bangumi_id) {
        try {
          const listRes = await api.anime.list()
          const existing = listRes.data.data.find(a => a.bangumi_id === props.animeData.bangumi_id)
          if (existing) {
            isImported.value = true
            localAnime.value = existing
          } else {
            isImported.value = false
            localAnime.value = null
          }
        } catch {
          isImported.value = false
          localAnime.value = null
        }
      } else if (props.animeData.id) {
        // 有本地 id 表示已存在于数据库
        isImported.value = true
        localAnime.value = props.animeData
      } else {
        isImported.value = false
        localAnime.value = null
      }

      // 如果有 bangumi_id，尝试获取关联作品
      if (props.animeData.bangumi_id) {
        try {
          const relRes = await api.anime.getRelations(props.animeData.bangumi_id)
          relations.value = relRes.data.data || []
        } catch {
          relations.value = []
        }
      }

      loading.value = false
      return
    }

    // 如果没有 bangumiId，无法获取远程数据
    if (!props.bangumiId) {
      loading.value = false
      return
    }

    // 从 API 获取详情
    const res = await api.anime.getDetail(props.bangumiId)
    const data = res.data.data

    anime.value = data.subject
    characters.value = data.characters || []
    staff.value = data.persons || []

    // 获取关联作品
    try {
      const relRes = await api.anime.getRelations(props.bangumiId)
      relations.value = relRes.data.data || []
    } catch {
      relations.value = []
    }

    // 检查是否已导入
    const listRes = await api.anime.list()
    const existing = listRes.data.data.find(a => a.bangumi_id === props.bangumiId)
    if (existing) {
      isImported.value = true
      localAnime.value = existing
    }
  } catch (error) {
    console.error('加载详情失败:', error)
    MessagePlugin.error('加载详情失败')
  } finally {
    loading.value = false
  }
}

// 导入动漫
async function handleImport() {
  importing.value = true
  try {
    // 使用 bangumiId 或 animeData 中的 bangumi_id
    const targetId = props.bangumiId || anime.value?.bangumi_id || props.animeData?.bangumi_id
    if (!targetId) {
      MessagePlugin.error('无法获取动漫ID')
      return
    }
    await api.anime.import(targetId)
    MessagePlugin.success('添加成功')
    isImported.value = true
    emit('imported')
  } catch (error) {
    MessagePlugin.error(error.response?.data?.message || '添加失败')
  } finally {
    importing.value = false
  }
}

// 打开关联作品详情
function openRelationDetail(rel) {
  emit('openRelation', {
    bangumiId: rel.id,
    animeData: {
      bangumi_id: rel.id,
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
    MessagePlugin.warning('无法获取动漫名称')
    return
  }

  searchingResources.value = true
  showResources.value = true
  resources.value = []

  try {
    const response = await api.anime.searchResources(keyword)
    resources.value = response.data.data || []
    if (resources.value.length === 0) {
      MessagePlugin.info('未找到相关资源')
    }
  } catch (error) {
    MessagePlugin.error('搜索资源失败')
  } finally {
    searchingResources.value = false
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

// 更新状态
async function updateStatus(status) {
  if (!localAnime.value) return
  try {
    await api.anime.updateStatus(localAnime.value.id, status)
    MessagePlugin.success('状态已更新')
    emit('updated')
  } catch (error) {
    MessagePlugin.error('更新失败')
  }
}

// 切换收藏
async function toggleFavorite() {
  if (!localAnime.value) return
  try {
    await api.anime.toggleFavorite(localAnime.value.id)
    localAnime.value.is_favorite = !localAnime.value.is_favorite
    MessagePlugin.success(localAnime.value.is_favorite ? '已收藏' : '已取消收藏')
    emit('updated')
  } catch (error) {
    MessagePlugin.error('操作失败')
  }
}

// 删除
async function handleDelete() {
  if (!localAnime.value) return
  try {
    await api.anime.delete(localAnime.value.id)
    MessagePlugin.success('删除成功')
    visible.value = false
    emit('deleted')
  } catch (error) {
    MessagePlugin.error('删除失败')
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
.anime-detail-dialog :deep(.t-dialog__body) {
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
