<template>
  <div class="mobile-music" :class="{ 'batch-mode-active': batchMode }">
    <!-- 批量操作时的顶部占位 -->
    <div v-if="batchMode" class="batch-bar-placeholder"></div>
    
    <!-- 歌单标签栏 -->
    <div class="playlist-tabs">
      <div class="tab-scroll">
        <div class="tab-item" :class="{ active: !currentPlaylist }" @click="selectPlaylist(null)">
          <span>全部</span>
        </div>
        <div v-for="playlist in playlists" :key="playlist.id" 
             class="tab-item" :class="{ active: currentPlaylist?.id === playlist.id }"
             @click="selectPlaylist(playlist)">
          <span>{{ playlist.name }}</span>
        </div>
        <div v-if="!isGuest" class="tab-item add-btn" @click="showCreatePlaylist = true">
          <span>+</span>
        </div>
      </div>
    </div>

    <!-- 搜索栏 -->
    <div class="search-section">
      <div class="search-bar">
        <input v-model="searchKeyword" placeholder="搜索音乐..." @keyup.enter="handleSearch" />
        <NativeIcon name="search" class="search-icon" @click="handleSearch" />
      </div>
      <button class="filter-btn" @click="showFilterDrawer = true">
        <NativeIcon name="filter" />
      </button>
    </div>

    <!-- 批量操作栏（顶部固定） -->
    <div v-if="batchMode" class="batch-bar">
      <div class="batch-left">
        <label class="checkbox-wrap">
          <input type="checkbox" :checked="isAllSelected" @change="toggleSelectAll">
          <span class="checkmark"></span>
        </label>
        <span class="batch-count">已选择 {{ selectedSongs.length }} 首</span>
      </div>
      <div class="batch-actions">
        <button class="action-btn-icon" @click="addSelectedToPlaylist" title="添加到歌单">
          <NativeIcon name="add" size="18" />
          <span>添加</span>
        </button>
        <button class="action-btn-icon danger" @click="batchDelete" title="删除">
          <NativeIcon name="delete" size="18" />
          <span>删除</span>
        </button>
        <button class="action-btn-icon" @click="exitBatchMode" title="完成">
          <NativeIcon name="check" size="18" />
          <span>完成</span>
        </button>
      </div>
    </div>

    <!-- 音乐列表 -->
    <div class="music-container">
      <div v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <span>加载中...</span>
      </div>

      <div v-else-if="musicList.length === 0" class="empty-state">
        <NativeIcon name="music" size="48" />
        <p>暂无音乐</p>
      </div>

      <div v-else class="music-list">
        <div v-for="song in musicList" :key="song.id" 
             class="music-item" 
             :class="{ selected: batchMode && selectedSongs.includes(song.id) }"
             @click="handleSongClick(song)"
             @touchstart="!isGuest && handleTouchStart($event, song)"
             @touchend="handleTouchEnd"
             @touchmove="handleTouchMove">
          <!-- 封面 -->
          <div class="song-cover" :ref="el => observeCover(el, song)">
            <img v-if="coverCache[song.id]" :src="coverCache[song.id]" />
            <NativeIcon v-else name="music" size="24" />
          </div>

          <!-- 歌曲信息 -->
          <div class="song-info">
            <div class="song-title">{{ song.title }}</div>
            <div class="song-subtitle">{{ song.artist || '未知艺术家' }}{{ song.album ? ' - ' + song.album : '' }}</div>
          </div>

          <!-- 右侧操作 -->
          <div class="song-action" @click.stop>
            <!-- 批量模式：显示多选框 -->
            <label v-if="batchMode" class="checkbox-wrap">
              <input type="checkbox" :checked="selectedSongs.includes(song.id)" 
                     @change="toggleSelection(song.id)">
              <span class="checkmark"></span>
            </label>
            <!-- 普通模式：管理员显示更多按钮 -->
            <button v-else-if="!isGuest" class="more-btn" @click="showActionMenu(song)">
              <NativeIcon name="more" size="20" />
            </button>
          </div>
        </div>

        <!-- 滚动加载中提示 -->
        <div v-if="loadingMore" class="loading-more">
          <div class="spinner-small"></div>
          <span>加载中...</span>
        </div>
        
        <!-- 无限滚动触发器（IntersectionObserver 目标元素） -->
        <div ref="loadMoreTriggerRef" class="load-more-trigger"></div>
      </div>
    </div>

    <!-- 长按提示 -->
    <div v-if="showLongPressTip" class="longpress-tip">长按进入多选模式</div>

    <!-- 筛选抽屉 -->
    <div v-if="showFilterDrawer" class="drawer-overlay" @click.self="showFilterDrawer = false">
      <div class="filter-drawer">
        <div class="drawer-header">
          <span>筛选</span>
          <button class="close-btn" @click="showFilterDrawer = false">
            <NativeIcon name="close" />
          </button>
        </div>
        <div class="drawer-body">
          <!-- 艺术家筛选 -->
          <div class="filter-section">
            <span class="filter-label">艺术家</span>
            <div class="filter-select-btn" :class="{ active: artistFilter }" @click="openSelectList('artist')">
              <span>{{ artistFilter || '全部' }}</span>
              <NativeIcon name="chevron-right" size="16" />
            </div>
          </div>
          <!-- 专辑筛选 -->
          <div class="filter-section">
            <span class="filter-label">专辑</span>
            <div class="filter-select-btn" :class="{ active: albumFilter }" @click="openSelectList('album')">
              <span>{{ albumFilter || '全部' }}</span>
              <NativeIcon name="chevron-right" size="16" />
            </div>
          </div>
          <!-- 排序 -->
          <div class="filter-section">
            <span class="filter-label">排序</span>
            <div class="filter-options">
              <div class="filter-chip" :class="{ active: sortBy === 'created_at' }" @click="sortBy = 'created_at'">添加时间</div>
              <div class="filter-chip" :class="{ active: sortBy === 'title' }" @click="sortBy = 'title'">歌名</div>
              <div class="filter-chip" :class="{ active: sortBy === 'artist' }" @click="sortBy = 'artist'">艺术家</div>
              <div class="filter-chip" :class="{ active: sortBy === 'album' }" @click="sortBy = 'album'">专辑</div>
            </div>
          </div>
        </div>
        <div class="drawer-footer">
          <button class="btn-secondary" @click="resetFilter">重置</button>
          <button class="btn-primary" @click="applyFilter">确定</button>
        </div>
      </div>
    </div>

    <!-- 操作菜单 -->
    <div v-if="actionMenuVisible" class="drawer-overlay" @click.self="closeActionMenu">
      <div class="action-sheet">
        <div class="sheet-title">{{ currentSong?.title }}</div>
        <div class="sheet-list">
          <div class="sheet-item" @click="playSong(currentSong)">
            <NativeIcon name="play-circle" /> 播放
          </div>
          <div class="sheet-item" @click="startBatchFromSong(currentSong)">
            <NativeIcon name="check-rectangle" /> 多选
          </div>
          <div class="sheet-item" @click="showAddToPlaylist(currentSong)">
            <NativeIcon name="add-rectangle" /> 添加到歌单
          </div>
          <div class="sheet-item" @click="editSong(currentSong)">
            <NativeIcon name="edit" /> 编辑
          </div>
          <div class="sheet-item delete" @click="confirmDelete(currentSong)">
            <NativeIcon name="delete" /> {{ currentPlaylist ? '从歌单移除' : '删除' }}
          </div>
        </div>
        <div class="sheet-cancel" @click="closeActionMenu">取消</div>
      </div>
    </div>

    <!-- 添加到歌单弹窗 -->
    <div v-if="showPlaylistSelect" class="modal-overlay" @click.self="showPlaylistSelect = false">
      <div class="modal-container">
        <div class="modal-header">添加到歌单</div>
        <div class="modal-body">
          <div v-for="p in playlists" :key="p.id" class="sheet-item" @click="addToPlaylist(p.id)">
            {{ p.name }}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" @click="showPlaylistSelect = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 编辑歌曲弹窗 -->
    <div v-if="editDialogVisible" class="modal-overlay" @click.self="editDialogVisible = false">
      <div class="modal-container">
        <div class="modal-header">编辑歌曲信息</div>
        <div class="modal-body">
          <div class="form-item">
            <label>标题</label>
            <input v-model="editForm.title" class="native-input" placeholder="歌曲标题" />
          </div>
          <div class="form-item">
            <label>艺术家</label>
            <input v-model="editForm.artist" class="native-input" placeholder="艺术家" />
          </div>
          <div class="form-item">
            <label>专辑</label>
            <input v-model="editForm.album" class="native-input" placeholder="专辑名" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" @click="editDialogVisible = false">取消</button>
          <button class="btn-primary" @click="saveEdit">保存</button>
        </div>
      </div>
    </div>

    <!-- 删除确认弹窗 -->
    <div v-if="deleteConfirmVisible" class="modal-overlay" @click.self="deleteConfirmVisible = false">
      <div class="modal-container small">
        <div class="modal-header">{{ currentPlaylist ? '从歌单移除' : '确认删除' }}</div>
        <div class="modal-body">
          <p v-if="currentPlaylist">
            确定要从歌单「{{ currentPlaylist.name }}」中移除歌曲「{{ songToDelete?.title }}」吗？
          </p>
          <p v-else>确定要删除歌曲「{{ songToDelete?.title }}」吗？</p>
          <p :class="currentPlaylist ? 'info-text' : 'warning-text'">
            {{ currentPlaylist ? '歌曲文件不会被删除，仍可在"全部"中找到' : '删除后无法恢复' }}
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" @click="deleteConfirmVisible = false">取消</button>
          <button :class="currentPlaylist ? 'btn-primary' : 'btn-danger'" @click="doDelete">
            {{ currentPlaylist ? '移除' : '删除' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 创建歌单弹窗 -->
    <div v-if="showCreatePlaylist" class="modal-overlay" @click.self="showCreatePlaylist = false">
      <div class="modal-container small">
        <div class="modal-header">新建歌单</div>
        <div class="modal-body">
          <input v-model="newPlaylistName" class="native-input" placeholder="歌单名称" />
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" @click="showCreatePlaylist = false">取消</button>
          <button class="btn-primary" @click="createPlaylist">创建</button>
        </div>
      </div>
    </div>

    <!-- 选择列表弹窗 -->
    <div v-if="showSelectList" class="drawer-overlay" @click.self="showSelectList = false">
      <div class="select-list-drawer">
        <div class="drawer-header">
          <span>{{ selectListTitle }}</span>
          <button class="close-btn" @click="showSelectList = false">
            <NativeIcon name="close" />
          </button>
        </div>
        <div class="select-list-body">
          <div class="select-list-item" :class="{ active: !currentSelectValue }" @click="selectItem('')">
            <span>全部</span>
            <NativeIcon v-if="!currentSelectValue" name="check" class="check-icon" />
          </div>
          <div v-for="item in selectListData" :key="item" 
               class="select-list-item" 
               :class="{ active: currentSelectValue === item }"
               @click="selectItem(item)">
            <span>{{ item }}</span>
            <NativeIcon v-if="currentSelectValue === item" name="check" class="check-icon" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useAuthStore } from '@/stores/auth'
import api from '@/api'
import { NativeIcon } from '@/components/native'
import { useToast } from '@/composables/useToast'
const authStore = useAuthStore()
const toast = useToast()
const isGuest = computed(() => authStore.isGuest())

// 列表数据
const musicList = ref([])
const playlists = ref([])
const currentPlaylist = ref(null)
const loading = ref(false)
const loadingMore = ref(false)
const hasMore = ref(true)
const page = ref(1)
const pageSize = 50

// 搜索和筛选
const searchKeyword = ref('')
const artistFilter = ref('')
const albumFilter = ref('')
const sortBy = ref('created_at')
const showFilterDrawer = ref(false)
const filterOptions = ref({ artists: [], albums: [] })

// 选择列表弹窗
const showSelectList = ref(false)
const selectListType = ref('') // 'artist' | 'album'
const selectListTitle = computed(() => selectListType.value === 'artist' ? '选择艺术家' : '选择专辑')
const selectListData = computed(() => selectListType.value === 'artist' ? filterOptions.value.artists : filterOptions.value.albums)
const currentSelectValue = computed(() => selectListType.value === 'artist' ? artistFilter.value : albumFilter.value)

// 批量操作（仅管理员）
const batchMode = ref(false)
const selectedSongs = ref([])

// 长按相关（仅管理员）
let longPressTimer = null
const LONG_PRESS_DURATION = 600
const showLongPressTip = ref(false)

// 操作菜单
const actionMenuVisible = ref(false)
const currentSong = ref(null)

// 添加到歌单
const showPlaylistSelect = ref(false)
const songsToAdd = ref([])

// 编辑
const editDialogVisible = ref(false)
const editForm = ref({ id: null, title: '', artist: '', album: '' })

// 删除
const deleteConfirmVisible = ref(false)
const songToDelete = ref(null)

// 创建歌单
const showCreatePlaylist = ref(false)
const newPlaylistName = ref('')

// 封面缓存
const coverCache = ref({})
const coverLoadingSet = new Set()
let coverObserver = null

// 无限滚动触发器引用
const loadMoreTriggerRef = ref(null)
let loadMoreObserver = null

// 初始化封面观察器
const initCoverObserver = () => {
  coverObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const songId = entry.target.__songId__
        if (songId && !coverCache.value[songId] && !coverLoadingSet.has(songId)) {
          loadCover(songId)
        }
        coverObserver.unobserve(entry.target)
      }
    })
  }, { rootMargin: '50px' })
}

// 加载封面
const loadCover = async (id) => {
  if (coverLoadingSet.has(id) || coverCache.value[id]) return
  coverLoadingSet.add(id)
  try {
    const response = await api.music.getCover(id)
    if (response.data.cover) {
      coverCache.value[id] = response.data.cover
    }
  } catch (e) {
    console.error('加载封面失败:', e)
  }
}

// 观察封面元素
const observeCover = (el, song) => {
  if (!el || !song.has_cover) return
  el.__songId__ = song.id
  coverObserver.observe(el)
}

// 计算属性
const isAllSelected = computed(() => {
  return musicList.value.length > 0 && selectedSongs.value.length === musicList.value.length
})

// 加载音乐列表
const loadMusic = async (isLoadMore = false) => {
  if (isLoadMore) {
    loadingMore.value = true
  } else {
    loading.value = true
    page.value = 1
  }

  try {
    let list = []
    
    if (currentPlaylist.value) {
      // 在歌单中，使用专门的歌单歌曲接口
      const res = await api.music.getPlaylistSongs(currentPlaylist.value.id)
      list = res.data.data || []
      // 歌单歌曲不支持分页，一次性返回所有
      hasMore.value = false
    } else {
      // 不在歌单中，使用普通列表接口
      const params = {
        page: page.value,
        pageSize,
        keyword: searchKeyword.value,
        artist: artistFilter.value,
        album: albumFilter.value,
        sortBy: sortBy.value
      }
      const res = await api.music.list(params)
      list = res.data.data || []
      hasMore.value = list.length === pageSize
    }
    
    if (isLoadMore) {
      musicList.value.push(...list)
    } else {
      musicList.value = list
    }
    console.log('[加载完成] hasMore:', hasMore.value, '列表长度:', list.length)
  } catch (error) {
    console.error('加载音乐失败:', error)
  } finally {
    loading.value = false
    loadingMore.value = false
    // 数据加载完成后，重新初始化滚动加载观察器
    nextTick(() => {
      setTimeout(() => {
        initLoadMoreObserver()
      }, 200)
    })
  }
}

// 加载歌单
const loadPlaylists = async () => {
  try {
    const res = await api.music.getPlaylists()
    playlists.value = res.data.data || []
  } catch (error) {
    console.error('加载歌单失败:', error)
  }
}

// 加载筛选选项
const loadFilterOptions = async () => {
  try {
    const [artistsRes, albumsRes] = await Promise.all([
      api.music.artists(),
      api.music.albums()
    ])
    filterOptions.value = {
      artists: artistsRes.data.data || [],
      albums: albumsRes.data.data || []
    }
  } catch (error) {
    console.error('加载筛选选项失败:', error)
  }
}

// 打开选择列表
const openSelectList = (type) => {
  selectListType.value = type
  showSelectList.value = true
}

// 选择项目
const selectItem = (value) => {
  if (selectListType.value === 'artist') {
    artistFilter.value = value
  } else {
    albumFilter.value = value
  }
  showSelectList.value = false
}

// 选择歌单
const selectPlaylist = (playlist) => {
  currentPlaylist.value = playlist
  loadMusic()
}

// 搜索
const handleSearch = () => {
  loadMusic()
}

// 加载更多
const loadMore = () => {
  page.value++
  loadMusic(true)
}

// 应用筛选
const applyFilter = () => {
  showFilterDrawer.value = false
  loadMusic()
}

// 重置筛选
const resetFilter = () => {
  artistFilter.value = ''
  albumFilter.value = ''
  sortBy.value = 'created_at'
  showFilterDrawer.value = false
  loadMusic()
}

// 播放歌曲
const playSong = async (song) => {
  let songsToPlay = []
  
  if (currentPlaylist.value) {
    // 如果在歌单中，使用当前歌单的歌曲
    songsToPlay = [...musicList.value]
  } else {
    // 不在歌单中，获取当前筛选条件下的所有音乐
    try {
      const params = {
        page: 1,
        pageSize: 10000, // 获取所有音乐
        sortBy: sortBy.value,
        keyword: searchKeyword.value,
        artist: artistFilter.value,
        album: albumFilter.value
      }
      
      const response = await api.music.list(params)
      songsToPlay = response.data.data || []
    } catch (e) {
      // 如果获取失败，使用当前页面的音乐
      songsToPlay = [...musicList.value]
    }
  }
  
  window.dispatchEvent(new CustomEvent('play-music', { 
    detail: { song, list: songsToPlay }
  }))
  closeActionMenu()
}

// 处理歌曲点击
const handleSongClick = async (song) => {
  if (batchMode.value) {
    toggleSelection(song.id)
  } else {
    await playSong(song)
  }
}

// 长按处理（仅管理员）
const handleTouchStart = (e, song) => {
  if (batchMode.value || isGuest.value) return
  
  longPressTimer = setTimeout(() => {
    batchMode.value = true
    selectedSongs.value = [song.id]
    showLongPressTip.value = true
    setTimeout(() => showLongPressTip.value = false, 1500)
  }, LONG_PRESS_DURATION)
}

const handleTouchEnd = () => {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

const handleTouchMove = () => {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

// 从操作菜单进入批量模式
const startBatchFromSong = (song) => {
  batchMode.value = true
  selectedSongs.value = [song.id]
  closeActionMenu()
}

// 退出批量模式
const exitBatchMode = () => {
  batchMode.value = false
  selectedSongs.value = []
}

// 切换选择
const toggleSelection = (songId) => {
  const index = selectedSongs.value.indexOf(songId)
  if (index > -1) {
    selectedSongs.value.splice(index, 1)
  } else {
    selectedSongs.value.push(songId)
  }
}

// 全选/取消全选（支持加载所有后全选）
const toggleSelectAll = async () => {
  if (isAllSelected.value) {
    selectedSongs.value = []
    return
  }
  
  // 如果有更多未加载的数据，先加载所有
  if (hasMore.value && !currentPlaylist.value) {
    toast.info('正在加载所有音乐...')
    try {
      // 循环加载所有分页数据
      while (hasMore.value) {
        page.value++
        const params = {
          page: page.value,
          pageSize,
          keyword: searchKeyword.value,
          artist: artistFilter.value,
          album: albumFilter.value,
          sortBy: sortBy.value
        }
        const res = await api.music.list(params)
        const list = res.data.data || []
        musicList.value.push(...list)
        hasMore.value = list.length === pageSize
      }
      toast.success('加载完成，已全选')
    } catch (error) {
      console.error('加载更多音乐失败:', error)
      toast.error('加载失败')
    }
  }
  
  // 全选所有已加载的歌曲
  selectedSongs.value = musicList.value.map(s => s.id)
}

// 批量删除
const batchDelete = async () => {
  if (selectedSongs.value.length === 0) return
  
  // 根据是否在歌单中显示不同的提示
  const isInPlaylist = !!currentPlaylist.value
  const confirmMsg = isInPlaylist 
    ? `确定要从歌单「${currentPlaylist.value.name}」中移除选中的 ${selectedSongs.value.length} 首歌曲吗？\n（歌曲文件不会被删除）`
    : `确定要彻底删除选中的 ${selectedSongs.value.length} 首歌曲吗？\n（此操作不可恢复）`
  
  if (!confirm(confirmMsg)) return

  try {
    const idsToDelete = [...selectedSongs.value]
    
    // 保存当前滚动位置
    const scrollPos = saveScrollPosition()
    
    if (isInPlaylist) {
      // 从歌单中移除
      await api.music.batchRemoveSongsFromPlaylist(currentPlaylist.value.id, idsToDelete)
      toast.success('已从歌单中移除')
    } else {
      // 彻底删除歌曲
      await api.music.batchDelete({ ids: idsToDelete })
      toast.success('删除成功')
    }
    
    // 立即从本地列表移除被删除的项，实现即时刷新
    musicList.value = musicList.value.filter(song => !idsToDelete.includes(song.id))
    
    exitBatchMode()
    await loadPlaylists()
    
    // 恢复滚动位置
    restoreScrollPosition(scrollPos)
  } catch (error) {
    console.error('批量删除失败:', error)
    toast.error(isInPlaylist ? '从歌单移除失败' : '删除失败')
  }
}

// 显示添加到歌单选择
const showAddToPlaylist = (song) => {
  songsToAdd.value = song ? [song.id] : selectedSongs.value
  showPlaylistSelect.value = true
  closeActionMenu()
}

// 添加到歌单
const addToPlaylist = async (playlistId) => {
  try {
    await api.music.addSongsToPlaylist(playlistId, songsToAdd.value)
    toast.success('添加成功')
    showPlaylistSelect.value = false
    exitBatchMode()
  } catch (error) {
    console.error('添加到歌单失败:', error)
    toast.error('添加失败')
  }
}

// 添加选中歌曲到歌单
const addSelectedToPlaylist = () => {
  if (selectedSongs.value.length === 0) {
    toast.warning('请先选择歌曲')
    return
  }
  showAddToPlaylist()
}

// 操作菜单
const showActionMenu = (song) => {
  currentSong.value = song
  actionMenuVisible.value = true
}

const closeActionMenu = () => {
  actionMenuVisible.value = false
  currentSong.value = null
}

// 编辑
const editSong = (song) => {
  editForm.value = { ...song }
  editDialogVisible.value = true
  closeActionMenu()
}

const saveEdit = async () => {
  try {
    await api.music.update(editForm.value.id, editForm.value)
    toast.success('保存成功')
    editDialogVisible.value = false
    loadMusic()
  } catch (error) {
    console.error('保存失败:', error)
    toast.error('保存失败')
  }
}

// 获取滚动容器
const getScrollContainer = () => document.querySelector('.scrollable-content')

// 保存滚动位置
const saveScrollPosition = () => {
  const container = getScrollContainer()
  return container ? container.scrollTop : 0
}

// 恢复滚动位置
const restoreScrollPosition = (position) => {
  nextTick(() => {
    const container = getScrollContainer()
    if (container) {
      container.scrollTop = position
    }
  })
}

// 删除
const confirmDelete = (song) => {
  songToDelete.value = song
  deleteConfirmVisible.value = true
  closeActionMenu()
}

const doDelete = async () => {
  try {
    const isInPlaylist = !!currentPlaylist.value
    const deletedId = songToDelete.value.id
    
    // 保存当前滚动位置
    const scrollPos = saveScrollPosition()
    
    if (isInPlaylist) {
      // 从歌单中移除
      await api.music.removeSongFromPlaylist(currentPlaylist.value.id, deletedId)
      toast.success('已从歌单中移除')
    } else {
      // 彻底删除歌曲
      await api.music.delete(deletedId)
      toast.success('删除成功')
    }
    
    // 立即从本地列表移除被删除的项，实现即时刷新
    musicList.value = musicList.value.filter(song => song.id !== deletedId)
    
    deleteConfirmVisible.value = false
    await loadPlaylists()
    
    // 恢复滚动位置
    restoreScrollPosition(scrollPos)
  } catch (error) {
    console.error('删除失败:', error)
    toast.error(error.message || '删除失败')
  }
}

// 创建歌单
const createPlaylist = async () => {
  if (!newPlaylistName.value.trim()) {
    toast.warning('请输入歌单名称')
    return
  }
  try {
    await api.music.createPlaylist({ name: newPlaylistName.value })
    toast.success('创建成功')
    showCreatePlaylist.value = false
    newPlaylistName.value = ''
    loadPlaylists()
  } catch (error) {
    console.error('创建歌单失败:', error)
    toast.error('创建失败')
  }
}

// 无限滚动：使用 IntersectionObserver，以 scrollable-content 为 root
const initLoadMoreObserver = () => {
  // 先断开旧的观察器
  if (loadMoreObserver) {
    loadMoreObserver.disconnect()
    loadMoreObserver = null
  }
  
  // 如果没有更多数据，不创建观察器
  if (!hasMore.value) {
    console.log('[无限滚动] 无更多数据')
    return
  }
  
  // 延迟确保DOM已渲染
  setTimeout(() => {
    const triggerEl = loadMoreTriggerRef.value
    const scrollContainer = document.querySelector('.scrollable-content')
    
    if (!triggerEl) {
      console.log('[无限滚动] 触发器元素不存在')
      return
    }
    
    if (!scrollContainer) {
      console.log('[无限滚动] 滚动容器不存在')
      return
    }
    
    console.log('[无限滚动] 初始化观察器，滚动容器:', scrollContainer)
    
    // 创建观察器，以 scrollable-content 为 root
    loadMoreObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        console.log('[无限滚动] 交叉状态:', entry.isIntersecting)
        if (entry.isIntersecting && !loadingMore.value && hasMore.value) {
          console.log('[无限滚动] 触发加载')
          loadMore()
        }
      })
    }, {
      root: scrollContainer, // 使用 scrollable-content 作为滚动容器
      rootMargin: '0px 0px 100px 0px',
      threshold: 0
    })
    
    loadMoreObserver.observe(triggerEl)
    console.log('[无限滚动] 开始观察')
  }, 300)
}

onMounted(() => {
  initCoverObserver()
  loadMusic()
  loadPlaylists()
  loadFilterOptions()
  
  // 延迟初始化滚动加载观察器，确保DOM已渲染
  setTimeout(() => {
    initLoadMoreObserver()
  }, 500)
})

onUnmounted(() => {
  if (coverObserver) coverObserver.disconnect()
  if (loadMoreObserver) loadMoreObserver.disconnect()
})
</script>

<style scoped>
/* ========== 基础布局 ========== */
.mobile-music {
  min-height: 100vh;
  background: #f5f7fa;
}

/* ========== 歌单标签栏 ========== */
.playlist-tabs {
  background: #fff;
  border-bottom: 1px solid #f0f0f0;
  padding: 12px 0;
}

.tab-scroll {
  display: flex;
  gap: 8px;
  padding: 0 12px;
  overflow-x: auto;
  scrollbar-width: none;
}

.tab-scroll::-webkit-scrollbar {
  display: none;
}

.tab-item {
  flex-shrink: 0;
  padding: 8px 16px;
  background: #f5f7fa;
  border-radius: 16px;
  font-size: 13px;
  color: #666;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

.tab-item.active {
  background: #0052d9;
  color: #fff;
}

.tab-item.add-btn {
  padding: 8px 12px;
  background: #e6f7ff;
  color: #0052d9;
}

/* ========== 搜索栏 ========== */
.search-section {
  display: flex;
  gap: 8px;
  padding: 12px;
  background: #fff;
  border-bottom: 1px solid #f0f0f0;
}

.search-bar {
  flex: 1;
  display: flex;
  align-items: center;
  background: #f5f7fa;
  border-radius: 20px;
  padding: 0 14px;
}

.search-bar input {
  flex: 1;
  border: none;
  background: none;
  padding: 10px 8px;
  font-size: 14px;
  outline: none;
}

.search-icon {
  color: #999;
  cursor: pointer;
}

.filter-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: #f5f7fa;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
  cursor: pointer;
}

/* ========== 批量操作栏（顶部固定） ========== */
.batch-bar-placeholder {
  height: 56px;
}

.batch-bar {
  position: fixed;
  top: 0;
  left: 56px;
  right: 0;
  z-index: 100;
  background: #fff;
  padding: 10px 12px 10px 8px;
  border-bottom: 1px solid #f0f0f0;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-radius: 0 0 8px 0;
}

.batch-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.batch-count {
  font-size: 14px;
  color: #333;
  font-weight: 500;
}

.batch-actions {
  display: flex;
  gap: 16px;
}

.action-btn-icon {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  background: none;
  border: none;
  color: #666;
  font-size: 11px;
  cursor: pointer;
  padding: 4px 8px;
}

.action-btn-icon:active {
  opacity: 0.7;
}

.action-btn-icon.danger {
  color: #e34d59;
}

.action-btn-icon span {
  font-size: 11px;
}

/* ========== 音乐列表 ========== */
.music-container {
  min-height: 300px;
}

.loading-state, .empty-state {
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

.spinner-small {
  width: 20px;
  height: 20px;
  border: 2px solid #f0f0f0;
  border-top-color: #0052d9;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.music-list {
  background: #fff;
}

.music-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid #f8f8f8;
  cursor: pointer;
  transition: background 0.15s;
  -webkit-tap-highlight-color: transparent;
}

.music-item:active {
  background: #f5f7fa;
}

.music-item.selected {
  background: #e6f7ff;
}

/* 封面 */
.song-cover {
  width: 48px;
  height: 48px;
  border-radius: 6px;
  background: #f5f7fa;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
}

.song-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.song-cover :deep(.t-icon) {
  color: #ccc;
}

/* 歌曲信息 */
.song-info {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.song-title {
  font-size: 15px;
  font-weight: 500;
  color: #333;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song-subtitle {
  font-size: 12px;
  color: #999;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 右侧操作 */
.song-action {
  flex-shrink: 0;
}

.more-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #999;
  cursor: pointer;
}

.more-btn:active {
  color: #666;
}

/* 多选框 */
.checkbox-wrap {
  display: block;
  position: relative;
  width: 22px;
  height: 22px;
  cursor: pointer;
}

.checkbox-wrap input {
  position: absolute;
  opacity: 0;
  cursor: pointer;
}

.checkmark {
  position: absolute;
  top: 0;
  left: 0;
  width: 22px;
  height: 22px;
  background: #fff;
  border: 2px solid #d9d9d9;
  border-radius: 50%;
  transition: all 0.2s;
}

.checkbox-wrap input:checked ~ .checkmark {
  background: #0052d9;
  border-color: #0052d9;
}

.checkmark:after {
  content: '';
  position: absolute;
  display: none;
  left: 6px;
  top: 2px;
  width: 5px;
  height: 10px;
  border: solid white;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.checkbox-wrap input:checked ~ .checkmark:after {
  display: block;
}

/* 加载更多 */
.load-more {
  text-align: center;
  padding: 20px;
}

.load-btn {
  padding: 10px 32px;
  background: transparent;
  border: none;
  color: #999;
  font-size: 14px;
  cursor: pointer;
}

.loading-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #999;
  font-size: 14px;
}

/* 无限滚动触发器 */
.load-more-trigger {
  height: 50px;
  margin-top: 20px;
  background: transparent;
}

/* 长按提示 */
.longpress-tip {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  padding: 12px 24px;
  border-radius: 20px;
  font-size: 14px;
  z-index: 400;
  animation: fadeInOut 2s ease;
}

@keyframes fadeInOut {
  0% { opacity: 0; }
  20% { opacity: 1; }
  80% { opacity: 1; }
  100% { opacity: 0; }
}

/* ========== 抽屉遮罩 ========== */
.drawer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 200;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  /* 底部抬高，避开播放器 */
  padding-bottom: var(--player-height, 0px);
}

/* ========== 筛选抽屉 ========== */
.filter-drawer {
  background: #fff;
  border-radius: 16px 16px 0 0;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  animation: slideUp 0.3s ease;
}

@keyframes slideUp {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #f0f0f0;
}

.drawer-header span {
  font-size: 16px;
  font-weight: 600;
}

.close-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: #f5f7fa;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
  cursor: pointer;
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.drawer-footer {
  display: flex;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid #f0f0f0;
}

.drawer-footer button {
  flex: 1;
  padding: 12px;
  border-radius: 8px;
  font-size: 15px;
  border: none;
  cursor: pointer;
}

.btn-secondary {
  background: #f5f7fa;
  color: #666;
}

.btn-primary {
  background: #0052d9;
  color: #fff;
}

.btn-danger {
  background: #e34d59;
  color: #fff;
}

/* 筛选选项 */
.filter-section {
  margin-bottom: 20px;
}

.filter-label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: #333;
  margin-bottom: 12px;
}

.filter-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.filter-chip {
  padding: 8px 14px;
  background: #f5f7fa;
  border-radius: 16px;
  font-size: 13px;
  color: #666;
  cursor: pointer;
  transition: all 0.2s;
}

.filter-chip.active {
  background: #0052d9;
  color: #fff;
}

/* 筛选选择按钮 */
.filter-select-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #f5f7fa;
  border-radius: 8px;
  font-size: 14px;
  color: #333;
  cursor: pointer;
  transition: all 0.2s;
}

.filter-select-btn.active {
  background: #e6f7ff;
  color: #0052d9;
}

.filter-select-btn:active {
  background: #e8e8e8;
}

/* 选择列表抽屉 */
.select-list-drawer {
  background: #fff;
  border-radius: 16px 16px 0 0;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  animation: slideUp 0.3s ease;
}

.select-list-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.select-list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  font-size: 15px;
  color: #333;
  cursor: pointer;
  border-bottom: 1px solid #f8f8f8;
  transition: background 0.15s;
}

.select-list-item:active {
  background: #f5f7fa;
}

.select-list-item.active {
  color: #0052d9;
  font-weight: 500;
}

.select-list-item .check-icon {
  color: #0052d9;
}

/* ========== 底部操作菜单 ========== */
.action-sheet {
  background: #fff;
  border-radius: 16px 16px 0 0;
  animation: slideUp 0.3s ease;
}

.sheet-title {
  text-align: center;
  padding: 16px;
  font-size: 13px;
  color: #999;
  border-bottom: 1px solid #f0f0f0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet-list {
  max-height: 300px;
  overflow-y: auto;
}

.sheet-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  font-size: 15px;
  color: #333;
  cursor: pointer;
  border-bottom: 1px solid #f8f8f8;
}

.sheet-item:active {
  background: #f5f7fa;
}

.sheet-item.delete {
  color: #e34d59;
}

.sheet-cancel {
  text-align: center;
  padding: 16px;
  font-size: 15px;
  color: #666;
  border-top: 8px solid #f5f7fa;
  cursor: pointer;
}

.sheet-cancel:active {
  background: #f5f7fa;
}

/* ========== 弹窗 ========== */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  /* 底部抬高，避开播放器 */
  padding-bottom: var(--player-height, 0px);
  background: rgba(0, 0, 0, 0.6);
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.modal-container {
  background: #fff;
  border-radius: 12px;
  width: 100%;
  max-width: 400px;
  max-height: 90vh;
  overflow: hidden;
  animation: scaleIn 0.2s ease;
}

.modal-container.small {
  max-width: 320px;
}

@keyframes scaleIn {
  from { transform: scale(0.9); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

.modal-header {
  padding: 16px 20px;
  font-size: 16px;
  font-weight: 600;
  border-bottom: 1px solid #f0f0f0;
}

.modal-body {
  padding: 20px;
}

.modal-footer {
  display: flex;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid #f0f0f0;
}

.modal-footer button {
  flex: 1;
  padding: 12px;
  border-radius: 8px;
  font-size: 15px;
  border: none;
  cursor: pointer;
}

.warning-text {
  color: #e34d59;
  font-size: 13px;
  margin-top: 8px;
}

.info-text {
  color: #0052d9;
  font-size: 13px;
  margin-top: 8px;
}

/* 表单 */
.form-item {
  margin-bottom: 16px;
}

.form-item label {
  display: block;
  font-size: 14px;
  color: #666;
  margin-bottom: 8px;
}

.native-input {
  width: 100%;
  padding: 12px;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  font-size: 14px;
  outline: none;
}
</style>