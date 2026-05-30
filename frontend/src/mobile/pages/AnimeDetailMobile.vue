<template>
  <div v-if="visible" class="anime-detail-fullscreen">
    <div v-if="loading" class="loading-container">
      <div class="spinner"></div>
      <p>加载中...</p>
    </div>

    <div v-else-if="anime" class="detail-content">
      <!-- 刷新loading遮罩 -->
      <div v-if="refreshing" class="refresh-overlay">
        <div class="refresh-spinner">
          <div class="spinner"></div>
          <p>刷新中...</p>
        </div>
      </div>

      <!-- 顶部操作栏 -->
      <div class="top-bar">
        <button class="top-btn back-btn" @click="visible = false">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="top-actions">
          <!-- 收藏（在库中时显示） -->
          <button v-if="isImported" class="top-btn" @click="toggleFavorite" :class="{ active: localAnime?.is_favorite }">
            <svg v-if="localAnime?.is_favorite" width="20" height="20" viewBox="0 0 24 24" fill="#f5a623" stroke="#f5a623" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          </button>
          <!-- 隐藏（在库中+管理员） -->
          <button v-if="isImported && !isGuest" class="top-btn" @click="handleToggleHidden" :class="{ active: localAnime?.is_hidden }" title="隐藏">
            <svg v-if="localAnime?.is_hidden" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <!-- 状态编辑（在库中+管理员） -->
          <button v-if="isImported && !isGuest" class="top-btn" @click="showStatusEdit = true" title="状态">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <!-- 三点菜单（管理员） -->
          <button v-if="!isGuest" class="top-btn" @click="showMenu = true" title="更多">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
          </button>
        </div>
      </div>

      <!-- 第一栏：封面+信息 -->
      <div class="info-header">
        <div class="cover-section">
          <img :src="toHttps(anime.cover_image || anime.images?.large)" alt="封面" class="cover-image" @error="handleImageError" />
        </div>
        <div class="info-section">
          <!-- 顶部：标题块 -->
          <div class="title-block">
            <h2 class="title">{{ anime.name_cn || anime.name || anime.title }}</h2>
            <p class="original-name" v-if="anime.name && anime.name !== (anime.name_cn || anime.title)">{{ anime.name }}</p>
            <p class="original-name" v-else-if="anime.name_original && anime.name_original !== (anime.name_cn || anime.title)">{{ anime.name_original }}</p>
          </div>

          <!-- 中部：标签 -->
          <div class="tags-row" v-show="tags.length">
            <span v-for="tag in tags.slice(0, 8)" :key="tag" class="mini-tag">{{ tag }}</span>
          </div>

          <!-- 底部：评分+状态 -->
          <div class="header-bottom">
            <div class="rating-display" v-if="getRatingScore() > 0">
              <span class="rating-num">{{ getRatingScore().toFixed(1) }}</span>
            </div>
            <div class="header-actions" v-if="isImported">
              <span v-if="localAnime?.status && localAnime.status !== 'none'" class="status-badge" :class="localAnime.status">{{ statusText(localAnime.status) }}</span>
              <div v-if="localAnime?.user_rating" class="mini-stars">
                <span v-for="i in 5" :key="i" class="mini-star">
                  <svg width="12" height="12" viewBox="0 0 24 24" class="mini-star-empty">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                  </svg>
                  <div class="mini-star-fill" :style="{ width: getMiniStarWidth(localAnime.user_rating, i) }">
                    <svg width="12" height="12" viewBox="0 0 24 24" class="mini-star-full">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                  </div>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 简介 -->
      <div class="detail-section" v-if="anime.summary">
        <h3 class="section-title">简介</h3>
        <p class="summary-text">{{ anime.summary }}</p>
      </div>

      <!-- 详细信息 -->
      <div class="detail-section" v-if="infoboxList.length">
        <h3 class="section-title">详细信息</h3>
        <div class="infobox-list">
          <div class="infobox-item" v-for="(item, index) in infoboxList" :key="index">
            <span class="infobox-key">{{ item.key }}</span>
            <span class="infobox-value" v-html="formatInfoValue(item.value)"></span>
          </div>
        </div>
      </div>

      <!-- 角色 -->
      <div class="detail-section" v-if="characters.length">
        <h3 class="section-title">角色 · 声优</h3>
        <div class="char-list">
          <div class="char-item" v-for="char in characters" :key="char.id">
            <img :src="toHttps(char.images?.small)" class="char-avatar" @error="handleImageError" />
            <div class="char-info">
              <span class="char-name">{{ char.name }}</span>
              <span class="char-role" v-if="char.relation">{{ getRoleName(char.relation) }}</span>
            </div>
            <div class="char-actors" v-if="char.actors?.length">
              <div v-for="actor in char.actors.slice(0, 2)" :key="actor.id" class="actor-mini">
                <img :src="actor.images?.small || '/default-avatar.png'" class="actor-avatar" @error="handleImageError" />
                <span>{{ actor.name }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 制作人员 -->
      <div class="detail-section" v-if="staff.length">
        <h3 class="section-title">制作人员</h3>
        <div class="staff-list">
          <div class="staff-item" v-for="person in staff" :key="person.id">
            <img :src="toHttps(person.images?.small)" class="staff-avatar" @error="handleImageError" />
            <div class="staff-info">
              <span class="staff-name">{{ person.name }}</span>
              <span class="staff-role">{{ person.positions?.join(' / ') || person.relation }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 关联作品 -->
      <div class="detail-section" v-if="relations.length">
        <h3 class="section-title">关联作品</h3>
        <div class="relation-list">
          <div v-for="rel in relations" :key="rel.id" class="relation-card" @click="openRelationDetail(rel)">
            <img :src="toHttps(rel.images?.small)" class="relation-cover" @error="handleImageError" />
            <div class="relation-info">
              <span class="relation-type">{{ rel.relation }}</span>
              <span class="relation-name">{{ rel.name_cn || rel.name }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 资源列表 -->
      <div class="detail-section" v-if="showResources && resources.length > 0">
        <h3 class="section-title">资源列表</h3>
        <div class="resource-list">
          <div v-for="(res, index) in resources" :key="index" class="resource-card">
            <div class="resource-info">
              <span class="resource-title">{{ res.title }}</span>
              <div class="resource-meta">
                <span v-if="res.size">{{ res.size }}</span>
                <span v-if="res.seeders">种子 {{ res.seeders }}</span>
              </div>
            </div>
            <button class="copy-btn" @click="copyMagnet(res.magnetLink)">复制磁力</button>
          </div>
        </div>
      </div>
      <div class="detail-section" v-else-if="showResources && resources.length === 0 && !searchingResources">
        <p class="no-resources">未找到相关资源</p>
      </div>

      <!-- 底部操作栏 -->
      <div class="bottom-actions" v-if="!isImported && !isGuest">
        <button class="action-btn primary" :class="{ loading: importing }" @click="handleImport">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          添加到收藏
        </button>
      </div>
    </div>

    <!-- 状态编辑二级窗口 -->
    <div v-if="showStatusEdit" class="sub-overlay" @click="showStatusEdit = false">
      <div class="sub-panel" @click.stop>
        <div class="sub-header">
          <span>编辑状态</span>
          <button class="close-btn" @click="showStatusEdit = false">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="sub-body">
          <!-- 我的评分 -->
          <div class="edit-section">
            <label class="edit-label">我的评分</label>
            <div class="edit-stars">
              <span v-for="i in 5" :key="i" class="edit-star" @click="handleStarClick(i, $event)">
                <svg width="36" height="36" viewBox="0 0 24 24" :fill="getStarFill(i)" :stroke="getStarStroke(i)" stroke-width="1.5">
                  <defs>
                    <linearGradient :id="'halfGrad' + i">
                      <stop offset="50%" stop-color="#f5a623"/>
                      <stop offset="50%" stop-color="transparent"/>
                    </linearGradient>
                  </defs>
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </span>
            </div>
          </div>
          <!-- 状态选择 -->
          <div class="edit-section">
            <label class="edit-label">观看状态</label>
            <select v-model="editStatus" class="native-select full">
              <option value="none">未标记</option>
              <option value="want_to_watch">想看</option>
              <option value="watching">在看</option>
              <option value="watched">看过</option>
            </select>
          </div>
          <button class="save-btn" @click="saveStatusEdit">保存</button>
        </div>
      </div>
    </div>

    <!-- 三点菜单 -->
    <div v-if="showMenu" class="sub-overlay" @click="showMenu = false">
      <div class="menu-panel" @click.stop>
        <button v-if="!isImported" class="menu-item" @click="handleImportMenu">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          添加
        </button>
        <button v-if="isImported" class="menu-item danger" @click="confirmDelete">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          删除
        </button>
        <button class="menu-item" @click="refreshAnimeMenu">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          刷新
        </button>
        <button class="menu-item" @click="searchResourcesMenu">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          资源
        </button>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="showDeleteConfirm" class="sub-overlay">
      <div class="confirm-panel">
        <p>确定要删除这部动漫吗？</p>
        <div class="confirm-btns">
          <button class="btn-cancel" @click="showDeleteConfirm = false">取消</button>
          <button class="btn-danger" @click="doDelete">删除</button>
        </div>
      </div>
    </div>

    <!-- 资源窗口 -->
    <div v-if="showResourcePanel" class="sub-overlay" @click="showResourcePanel = false">
      <div class="resource-panel" @click.stop>
        <div class="sub-header">
          <span>资源列表</span>
          <button class="close-btn" @click="showResourcePanel = false">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="resource-body">
          <div v-if="searchingResources" class="loading-state">
            <div class="spinner-small"></div>
            <span>搜索中...</span>
          </div>
          <div v-else-if="resources.length === 0" class="empty-state">
            <p>未找到相关资源</p>
          </div>
          <div v-else class="resource-list">
            <div v-for="(res, index) in resources" :key="index" class="resource-card">
              <div class="resource-info">
                <span class="resource-title">{{ res.title }}</span>
                <div class="resource-meta">
                  <span v-if="res.size">{{ res.size }}</span>
                  <span v-if="res.seeders">种子 {{ res.seeders }}</span>
                </div>
              </div>
              <button class="copy-btn" @click="copyMagnet(res.magnetLink)">复制磁力</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import api from '@/api'
import { usePermission } from '@/composables/usePermission'
import { useToast } from '@/composables/useToast'
import { getAnimeCoverFromCache } from '@/utils/animeCoverCache'


const toast = useToast()
const { isGuest } = usePermission()

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  bangumiId: { type: [Number, String], default: null },
  animeData: { type: Object, default: null }
})

const emit = defineEmits(['update:modelValue', 'imported', 'updated', 'deleted', 'openRelation'])

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

// 弹窗控制
const showStatusEdit = ref(false)
const showMenu = ref(false)
const showDeleteConfirm = ref(false)
const showResourcePanel = ref(false)

// 编辑状态
const editRating = ref(0)
const editStatus = ref('none')

// 标签
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

// infobox
const infoboxList = computed(() => {
  if (!anime.value?.infobox) return []
  const infobox = anime.value.infobox
  if (Array.isArray(infobox)) return infobox
  if (typeof infobox === 'string') {
    try { return JSON.parse(infobox) } catch { return [] }
  }
  return []
})

function getRatingScore() {
  if (!anime.value) return 0
  if (typeof anime.value.rating === 'number') return anime.value.rating
  if (anime.value.rating?.score) return anime.value.rating.score
  return 0
}

function getRatingCount() {
  if (!anime.value) return 0
  return anime.value.rating_count || anime.value.rating?.total || 0
}

function getMiniStarWidth(userRating, index) {
  const starValue = userRating / 2
  if (index <= Math.floor(starValue)) return '100%'
  if (index === Math.ceil(starValue) && starValue % 1 >= 0.5) return '50%'
  return '0%'
}

function getRoleName(relation) {
  const roleMap = { '主角': '主角', '配角': '配角', '客串': '客串' }
  return roleMap[relation] || relation
}

function formatInfoValue(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(v => {
      if (typeof v === 'string') return v
      if (v.v) return v.v
      if (v.name) return v.name
      return String(v)
    }).join('、')
  }
  if (value?.v) return value.v
  return String(value)
}

function statusText(status) {
  const map = { 'want_to_watch': '想看', 'watching': '在看', 'watched': '看过', 'none': '未标记' }
  return map[status] || status
}

function handleImageError(e) {
  e.target.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDUwIDUwIj48cmVjdCB3aWR0aD0iNTAiIGhlaWdodD0iNTAiIGZpbGw9IiNlZWUiLz48dGV4dCB4PSIyNSIgeT0iMjUiIGZpbGw9IiM5OTkiIGZvbnQtc2l6ZT0iMTIiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGR5PSIuM2VtIj7ml6Dlm77niYc8L3RleHQ+PC9zdmc+'
}

function toHttps(url) {
  if (!url) return url
  return url.replace(/^http:\/\//, 'https://')
}

// 加载详情

async function loadDetail() {
  if (!props.bangumiId && !props.animeData) return

  loading.value = true
  isImported.value = false
  localAnime.value = null
  relations.value = []
  showResources.value = false
  resources.value = []
  searchingResources.value = false

  try {
      if (props.animeData?.bangumi_id) {
      anime.value = props.animeData
      characters.value = props.animeData.characters || []
      staff.value = props.animeData.staff || []
      isImported.value = true
      localAnime.value = props.animeData
      loadDetailCover(localAnime.value.id)
      try {
        const relRes = await api.anime.getRelations(props.animeData.bangumi_id)
        relations.value = relRes.data.data || []
      } catch { relations.value = [] }
      loading.value = false
      syncEditValues()
      return
    }

    const bangumiId = props.bangumiId || props.animeData?.id
    if (!bangumiId && props.animeData) {
      anime.value = props.animeData
      isImported.value = false
      loading.value = false
      return
    }

    try {
      const dbRes = await api.anime.getByBangumiId(bangumiId)
      if (dbRes.data.data) {
        anime.value = dbRes.data.data
        characters.value = dbRes.data.data.characters || []
        staff.value = dbRes.data.data.staff || []
        isImported.value = true
        localAnime.value = dbRes.data.data
        loadDetailCover(localAnime.value.id)
        try {
          const relRes = await api.anime.getRelations(bangumiId)
          relations.value = relRes.data.data || []
        } catch { relations.value = [] }
        loading.value = false
        syncEditValues()
        return
      }
    } catch { /* 数据库没有，继续从 API 获取 */ }

    if (bangumiId) {
      const res = await api.anime.getDetail(bangumiId)
      const data = res.data.data
      anime.value = data.subject
      characters.value = data.characters || []
      staff.value = data.persons || []
      isImported.value = false
      localAnime.value = null
      try {
        const relRes = await api.anime.getRelations(bangumiId)
        relations.value = relRes.data.data || []
      } catch { relations.value = [] }
    }
  } catch (error) {
    console.error('加载详情失败:', error)
    toast.error(error.response?.data?.message || '加载详情失败')
  } finally {
    loading.value = false
  }
}

function syncEditValues() {
  if (localAnime.value) {
    editRating.value = localAnime.value.user_rating || 0
    editStatus.value = localAnime.value.status || 'none'
  }
}

// 操作

async function handleImport() {
  importing.value = true
  try {
    const targetId = props.bangumiId || props.animeData?.id || anime.value?.bangumi_id || props.animeData?.bangumi_id
    if (!targetId) {
      toast.error('无法获取动漫ID')
      return
    }
    await api.anime.import(targetId)
    toast.success('添加成功')
    isImported.value = true
    emit('imported')
    // 重新加载详情以刷新状态
    loadDetail()
  } catch (error) {
    toast.error(error.response?.data?.message || '添加失败')
  } finally {
    importing.value = false
  }
}

async function handleImportMenu() {
  showMenu.value = false
  await handleImport()
}

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

async function handleToggleHidden() {
  if (!localAnime.value) return
  try {
    const response = await api.anime.toggleHidden(localAnime.value.id)
    toast.success(response.data.message)
    localAnime.value.is_hidden = response.data.is_hidden
    emit('updated')
  } catch (error) {
    toast.error('操作失败')
  }
}

async function saveStatusEdit() {
  if (!localAnime.value) return
  try {
    await api.anime.updateRating(localAnime.value.id, editRating.value)
    await api.anime.updateStatus(localAnime.value.id, editStatus.value)
    localAnime.value.user_rating = editRating.value
    localAnime.value.status = editStatus.value
    toast.success('更新成功')
    emit('updated')
    showStatusEdit.value = false
  } catch (error) {
    toast.error('更新失败')
  }
}

function getStarFill(i) {
  if (editRating.value >= i * 2) return '#f5a623'
  if (editRating.value === i * 2 - 1) return `url(#halfGrad${i})`
  return 'none'
}

function getStarStroke(i) {
  if (editRating.value >= i * 2 - 1) return '#f5a623'
  return '#ddd'
}

function handleStarClick(i, e) {
  const rect = e.currentTarget.getBoundingClientRect()
  const x = e.clientX - rect.left
  const isLeft = x < rect.width / 2
  const newRating = isLeft ? i * 2 - 1 : i * 2
  if (editRating.value === newRating) {
    editRating.value = 0
  } else {
    editRating.value = newRating
  }
}

async function refreshAnimeMenu() {
  showMenu.value = false
  if (!localAnime.value) return
  refreshing.value = true
  try {
    const response = await api.anime.refresh(localAnime.value.id)
    toast.success('刷新成功')
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

function confirmDelete() {
  showMenu.value = false
  showDeleteConfirm.value = true
}

async function doDelete() {
  if (!localAnime.value) return
  try {
    await api.anime.delete(localAnime.value.id)
    toast.success('删除成功')
    visible.value = false
    emit('deleted')
  } catch (error) {
    toast.error('删除失败')
  } finally {
    showDeleteConfirm.value = false
  }
}

async function loadDetailCover(id) {
  try {
    const cached = await getAnimeCoverFromCache(id)
    if (cached) {
      if (anime.value) anime.value.cover_image = cached
      return
    }
    const response = await api.anime.getCover(id)
    const cover = response.data.cover || response.data.coverUrl
    if (cover && anime.value) {
      anime.value.cover_image = cover
    }
  } catch (error) {
    console.error('[详情封面] 加载失败:', error)
  }
}

async function searchResourcesMenu() {
  showMenu.value = false
  showResourcePanel.value = true
  const keyword = anime.value?.name_cn || anime.value?.title || anime.value?.name
  if (!keyword) {
    toast.warning('无法获取动漫名称')
    return
  }
  searchingResources.value = true
  resources.value = []
  try {
    const searchMode = localStorage.getItem('resourceSearchMode') || 'sequential'
    const response = await api.anime.searchResources(keyword, searchMode)
    resources.value = response.data.data || []
    if (resources.value.length === 0) {
      toast.info('未找到相关资源')
    }
  } catch (error) {
    toast.error('搜索资源失败')
  } finally {
    searchingResources.value = false
  }
}

async function copyMagnet(link) {
  try {
    await navigator.clipboard.writeText(link)
    toast.success('磁力链接已复制')
  } catch {
    const textArea = document.createElement('textarea')
    textArea.value = link
    document.body.appendChild(textArea)
    textArea.select()
    document.execCommand('copy')
    document.body.removeChild(textArea)
    toast.success('磁力链接已复制')
  }
}

function openRelationDetail(rel) {
  emit('openRelation', {
    bangumiId: rel.id,
    animeData: {
      id: rel.id,
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

// 监听

watch(visible, (val) => {
  if (val) {
    loadDetail()
  }
})

watch(() => props.bangumiId, () => {
  if (visible.value) {
    loadDetail()
  }
})
</script>

<style scoped>
/* 全屏详情页 */
.anime-detail-fullscreen {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: #fff;
  z-index: 300;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  -webkit-tap-highlight-color: transparent;
}

.detail-content {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 80px;
  position: relative;
}

.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  color: #999;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #f0f0f0;
  border-top-color: #0052d9;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 12px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 顶部操作栏 */
.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #2c3e50;
  color: #fff;
  position: sticky;
  top: 0;
  z-index: 10;
  flex-shrink: 0;
}

.top-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.top-btn.back-btn {
  background: transparent;
}

.top-btn.active {
  background: rgba(255, 255, 255, 0.3);
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 信息头部 */
.info-header {
  display: flex;
  gap: 16px;
  padding: 16px;
  background: #34495e;
  color: #fff;
}

.cover-section {
  flex-shrink: 0;
  width: 120px;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.cover-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.info-section {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 0;
}

.title-block {
  flex-shrink: 0;
}

.title {
  font-size: 17px;
  font-weight: 600;
  margin: 0 0 2px;
  color: #fff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.original-name {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.8);
  margin: 2px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.info-section .spacer {
  display: none;
}

.tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex-shrink: 0;
}

.mini-tag {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(255, 255, 255, 0.15);
  padding: 2px 6px;
  border-radius: 3px;
}

.header-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.rating-display {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.rating-num {
  font-size: 22px;
  font-weight: bold;
  color: #fbbf24;
}

.rating-count {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.2);
}

.status-badge.want_to_watch { background: rgba(250, 173, 20, 0.3); }
.status-badge.watching { background: rgba(0, 82, 217, 0.3); }
.status-badge.watched { background: rgba(82, 196, 26, 0.3); }

.mini-stars {
  display: flex;
  gap: 1px;
}

.mini-star {
  position: relative;
  display: inline-block;
  width: 12px;
  height: 12px;
}

.mini-star-empty {
  position: absolute;
  left: 0;
  top: 0;
  fill: none;
  stroke: #ddd;
  stroke-width: 1.5;
}

.mini-star-fill {
  position: absolute;
  left: 0;
  top: 0;
  height: 12px;
  overflow: hidden;
  display: flex;
  align-items: flex-start;
}

.mini-star-full {
  fill: #f5a623;
  stroke: #f5a623;
  stroke-width: 1.5;
  display: block;
  flex-shrink: 0;
}

/* 详情栏目 */
.detail-section {
  padding: 16px;
  border-bottom: 1px solid #f0f0f0;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: #333;
  margin: 0 0 12px;
  padding-left: 12px;
}

.summary-text {
  font-size: 14px;
  color: #666;
  line-height: 1.7;
  margin: 0;
}

/* 详细信息 */
.infobox-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.infobox-item {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  background: #f9f9f9;
  border-radius: 6px;
}

.infobox-key {
  color: #999;
  font-size: 13px;
  flex-shrink: 0;
  min-width: 60px;
}

.infobox-value {
  color: #333;
  font-size: 13px;
  flex: 1;
}

/* 角色 */
.char-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.char-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  background: #f9f9f9;
  border-radius: 8px;
}

.char-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.char-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.char-name {
  font-size: 14px;
  font-weight: 500;
  color: #333;
}

.char-role {
  font-size: 12px;
  color: #999;
}

.char-actors {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.actor-mini {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #666;
}

.actor-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}

/* 制作人员 */
.staff-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.staff-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  background: #f9f9f9;
  border-radius: 8px;
}

.staff-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.staff-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.staff-name {
  font-size: 14px;
  font-weight: 500;
  color: #333;
}

.staff-role {
  font-size: 12px;
  color: #999;
}

/* 关联作品 */
.relation-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.relation-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  background: #f9f9f9;
  border-radius: 8px;
  cursor: pointer;
}

.relation-cover {
  width: 40px;
  height: 56px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}

.relation-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.relation-type {
  font-size: 11px;
  color: #999;
}

.relation-name {
  font-size: 13px;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 资源列表 */
.resource-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.resource-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  background: #f9f9f9;
  border-radius: 8px;
  gap: 10px;
}

.resource-card > .resource-info:first-child {
  flex: 1;
  min-width: 0;
}

.resource-title {
  font-size: 13px;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
  margin-bottom: 2px;
}

.resource-meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: #999;
}

.copy-btn {
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid #0052d9;
  background: #fff;
  color: #0052d9;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}

.no-resources {
  text-align: center;
  color: #999;
  padding: 20px;
}

/* 底部操作 */
.bottom-actions {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 12px 16px;
  background: #fff;
  border-top: 1px solid #eee;
  z-index: 5;
}

.action-btn {
  width: 100%;
  padding: 12px;
  border-radius: 8px;
  border: none;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.action-btn.primary {
  background: #0052d9;
  color: #fff;
}

/* 二级窗口遮罩 */
.sub-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 200;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.sub-panel {
  background: #fff;
  border-radius: 16px 16px 0 0;
  width: 100%;
  max-height: 70vh;
  overflow-y: auto;
  padding: 20px;
}

.sub-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
  font-size: 16px;
  font-weight: 600;
}

.resource-panel .sub-header {
  padding: 16px 16px 0;
  margin-bottom: 16px;
}

.close-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: #f5f5f5;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

/* 状态编辑 */
.edit-section {
  margin-bottom: 20px;
}

.edit-label {
  display: block;
  font-size: 14px;
  color: #333;
  margin-bottom: 10px;
}

.edit-stars {
  display: flex;
  gap: 4px;
  justify-content: center;
}

.edit-star {
  cursor: pointer;
}

.native-select.full {
  width: 100%;
  padding: 10px 28px 10px 10px;
  border: 1px solid #dcdcdc;
  border-radius: 6px;
  font-size: 14px;
  appearance: auto;
}

.save-btn {
  width: 100%;
  padding: 12px;
  border-radius: 8px;
  border: none;
  background: #0052d9;
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

/* 菜单 */
.menu-panel {
  background: #fff;
  border-radius: 16px 16px 0 0;
  width: 100%;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 12px;
  border: none;
  background: transparent;
  font-size: 15px;
  color: #333;
  cursor: pointer;
  border-radius: 8px;
}

.menu-item:active {
  background: #f5f5f5;
}

.menu-item.danger {
  color: #e34d59;
}

/* 刷新loading遮罩 */
.refresh-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(2px);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}

.refresh-spinner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: #666;
  font-size: 14px;
}

/* 确认弹窗 */
.confirm-panel {
  background: #fff;
  border-radius: 12px;
  padding: 24px;
  width: 100%;
  max-width: 280px;
  margin: auto 20px;
  text-align: center;
}

.confirm-panel p {
  margin: 0 0 20px;
  font-size: 15px;
  color: #333;
}

.confirm-btns {
  display: flex;
  gap: 12px;
}

.confirm-btns button {
  flex: 1;
  padding: 10px;
  border-radius: 6px;
  border: none;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.btn-cancel {
  background: #f5f5f5;
  color: #333;
}

.btn-danger {
  background: #e34d59;
  color: #fff;
}

/* 资源窗口 */
.resource-panel {
  background: #fff;
  border-radius: 16px 16px 0 0;
  width: 100%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.resource-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  color: #999;
  font-size: 14px;
}

.spinner-small {
  width: 16px;
  height: 16px;
  border: 2px solid #f0f0f0;
  border-top-color: #0052d9;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 8px;
}
</style>