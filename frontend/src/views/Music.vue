<template>
  <div 
    class="music" 
    :class="{ 'is-dragging': isDragging }"
    @dragover.prevent="handleDragOver"
    @dragleave.prevent="handleDragLeave"
    @drop.prevent="handleDrop"
  >
    <!-- 拖拽遮罩 -->
    <div class="drag-overlay" v-if="isDragging">
      <div class="drag-content">
        <t-icon name="upload" size="64px" />
        <p>释放鼠标上传音乐文件</p>
      </div>
    </div>

    <div class="page-header">
      <p>管理 MP3、FLAC、WAV 等音乐文件</p>
    </div>

    <!-- 工具栏 -->
    <t-card class="toolbar-card">
      <div class="toolbar">
        <div class="toolbar-left">
          <t-input
            v-model="searchKeyword"
            placeholder="搜索音乐..."
            style="width: 200px"
            @enter="searchMusic"
          >
            <template #suffix-icon>
              <t-icon name="search" />
            </template>
          </t-input>
          
          <t-select
            v-model="filterArtist"
            placeholder="艺术家"
            style="width: 150px"
            clearable
            filterable
            :max="100"
            @change="searchMusic"
          >
            <t-option v-for="artist in artists" :key="artist" :value="artist" :label="artist" />
          </t-select>

          <t-select
            v-model="filterAlbum"
            placeholder="专辑"
            style="width: 150px"
            clearable
            filterable
            :max="100"
            @change="searchMusic"
          >
            <t-option v-for="album in albums" :key="album" :value="album" :label="album" />
          </t-select>

          <t-select
            v-if="!currentPlaylist"
            v-model="sortBy"
            placeholder="排序"
            style="width: 120px"
            @change="searchMusic"
          >
            <t-option value="created_at" label="添加时间" />
            <t-option value="title" label="歌名" />
            <t-option value="artist" label="艺术家" />
            <t-option value="album" label="专辑" />
            <t-option value="duration" label="时长" />
          </t-select>
        </div>

        <div class="toolbar-right">
          <t-button theme="warning" variant="outline" @click="checkDuplicates" :loading="checkingDuplicates" :disabled="isGuest">
            <template #icon><t-icon name="filter" /></template>
            去重
          </t-button>
          <t-button theme="success" variant="outline" @click="batchDownloadLyrics" :loading="downloadingAllLyrics" :disabled="isGuest">
            <template #icon><t-icon name="download" /></template>
            批量获取歌词
          </t-button>
          <t-button theme="primary" @click="showUploadDialog = true" :disabled="isGuest">
            <template #icon><t-icon name="upload" /></template>
            上传音乐
          </t-button>
        </div>
      </div>
    </t-card>

    <!-- 主体内容 -->
    <div class="main-content">
      <!-- 歌单列表侧边栏 -->
      <div class="sidebar" v-if="currentPlaylist || playlists.length > 0">
        <div class="sidebar-header">
          <span>歌单</span>
          <div class="sidebar-actions">
            <t-button 
              size="small" 
              variant="text" 
              @click="showPlaylistManageDialog = true"
              title="编辑歌单"
              :disabled="isGuest"
            >
              <t-icon name="edit" />
            </t-button>
            <t-button size="small" variant="text" @click="showCreatePlaylistDialog = true" title="创建歌单" :disabled="isGuest">
              <t-icon name="add" />
            </t-button>
          </div>
        </div>
        <div class="playlist-list">
          <div 
            class="playlist-item"
            :class="{ active: !currentPlaylist }"
            @click="selectPlaylist(null)"
          >
            <t-icon name="music" />
            <span>全部音乐</span>
            <span class="count">{{ allMusicTotal }}</span>
            <t-button 
              class="playlist-play-btn"
              size="small"
              variant="text"
              @click.stop="playAllMusic"
              title="播放全部音乐"
            >
              <t-icon name="play-circle" />
            </t-button>
          </div>
          <div 
            v-for="playlist in playlists"
            :key="playlist.id"
            class="playlist-item"
            :class="{ active: currentPlaylist?.id === playlist.id }"
            @click="selectPlaylist(playlist)"
          >
            <t-icon name="folder" />
            <span>{{ playlist.name }}</span>
            <span class="count">{{ playlist.song_count }}</span>
            <t-button 
              class="playlist-play-btn"
              size="small"
              variant="text"
              @click.stop="playPlaylist(playlist)"
              title="播放歌单"
            >
              <t-icon name="play-circle" />
            </t-button>
          </div>
        </div>
      </div>

      <!-- 音乐列表 -->
      <div class="music-list-container">
        <!-- 批量操作栏 -->
        <div class="batch-actions" v-if="selectedSongs.length > 0">
          <span>已选择 {{ selectedSongs.length }} 首</span>
          <t-button size="small" @click="toggleSelectAll" :loading="selectAllLoading">
            {{ selectedSongs.length === total && total > 0 ? '取消全选' : '全选' }}
          </t-button>
          <t-button size="small" @click="addToPlaylist" :disabled="isGuest">
            添加到歌单 {{ selectedSongs.length > 0 ? `(${selectedSongs.length})` : '' }}
          </t-button>
          <t-button 
            size="small" 
            theme="danger" 
            @click="currentPlaylist ? batchDeleteFromPlaylist() : batchDelete()"
            :disabled="isGuest"
          >
            {{ currentPlaylist ? '从歌单移除' : '删除' }}
          </t-button>
          <t-button 
            size="small" 
            variant="outline"
            @click="batchDownloadLyricsForSelected"
            :loading="downloadingLyrics"
            :disabled="isGuest"
          >
            <template #icon><t-icon name="download" /></template>
            下载歌词
          </t-button>
          <t-button size="small" variant="text" @click="selectedSongs = []">取消选择</t-button>
        </div>

        <t-table
          :data="musicList"
          :columns="columns"
          :loading="loading"
          row-key="id"
          hover
          @row-click="handleRowClick"
          @row-dblclick="handleRowDblClick"
        >
          <template #headerCell="{ col }">
            <div v-if="col.colKey === 'title'" class="title-header">
              <span>标题</span>
            </div>
            <span v-else>{{ col.title }}</span>
          </template>
          <template #title="{ row }">
            <div class="song-title">
              <t-checkbox
                :checked="selectedSongs.includes(row.id)"
                @change="(val) => toggleSelect(row.id, val)"
                @click.stop
              />
              <div class="song-title-content">
                <div class="song-cover-small" :ref="el => { if (el) observeCover(el, row) }">
                  <t-icon name="music" v-if="!coverCache[row.id]" />
                  <img v-else :src="coverCache[row.id]" alt="cover" />
                </div>
                <span class="title-text" :title="row.title">{{ row.title }}</span>
              </div>
            </div>
          </template>
          <template #artist="{ row }">
            <span class="artist-text" :title="row.artist || '未知艺术家'">{{ row.artist || '未知艺术家' }}</span>
          </template>
          <template #album="{ row }">
            <span class="album-text" :title="row.album || '-'">{{ row.album || '-' }}</span>
          </template>
          <template #duration="{ row }">
            <span>{{ formatDuration(row.duration) }}</span>
          </template>
          <template #fileSize="{ row }">
            <span>{{ formatFileSize(row.file_size) }}</span>
          </template>
          <template #operation="{ row }">
            <t-space>
              <t-button theme="primary" variant="outline" size="small" @click.stop="playSong(row)">
                <t-icon name="play-circle" />
              </t-button>
              <t-button theme="default" size="small" @click.stop="editSong(row)" :disabled="isGuest">
                <t-icon name="edit" />
              </t-button>
              <t-popconfirm :content="currentPlaylist ? '确定从歌单移除吗？' : '确定删除吗？'" @confirm="deleteSong(row.id)">
                <t-button theme="danger" variant="outline" size="small" @click.stop :disabled="isGuest">
                  <t-icon name="delete" />
                </t-button>
              </t-popconfirm>
            </t-space>
          </template>
        </t-table>

        <div class="pagination-wrapper" v-if="!currentPlaylist && total > 0">
          <t-pagination
            v-model="pagination.current"
            v-model:page-size="pagination.pageSize"
            :total="total"
            show-page-number
            show-page-size
            :page-size-options="[30, 50, 100]"
            @change="handlePageChange"
            @page-size-change="handlePageSizeChange"
          />
        </div>
      </div>
    </div>

    <!-- 上传对话框 -->
    <t-dialog
      v-model:visible="showUploadDialog"
      header="上传音乐"
      width="600px"
      :footer="false"
      @close="handleUploadDialogClose"
    >
      <div class="upload-area">
        <div 
          class="upload-dropzone"
          :class="{ 'is-dragging': isUploadDragging }"
          @dragover.prevent="isUploadDragging = true"
          @dragleave.prevent="isUploadDragging = false"
          @drop.prevent="handleUploadDrop"
          @click="triggerFileInput"
        >
          <t-icon name="upload" size="48px" />
          <p>点击或拖拽文件到此区域上传</p>
          <p class="hint">支持 MP3, FLAC, WAV, APE, M4A, OGG, AAC 格式，单文件最大 500MB</p>
          <input
            ref="fileInput"
            type="file"
            multiple
            accept=".mp3,.flac,.wav,.ape,.m4a,.ogg,.aac"
            style="display: none"
            @change="handleFileSelect"
          />
        </div>

        <!-- 上传队列 -->
        <div class="upload-queue" v-if="uploadQueue.length > 0">
          <div class="queue-header">
            <span>上传队列 ({{ uploadQueue.length }} 个文件)</span>
            <t-button size="small" variant="text" @click="clearUploadQueue" :disabled="isUploading">清空</t-button>
          </div>
          <div class="queue-list">
            <div v-for="file in uploadQueue" :key="file.id" class="queue-item">
              <div class="file-info">
                <t-icon name="music" />
                <span class="file-name">{{ file.name }}</span>
                <span class="file-size" v-if="file.size">{{ formatFileSize(file.size) }}</span>
                <t-tag v-if="file.isRecovered" theme="primary" size="small" variant="outline">后台上传中</t-tag>
                <t-tag v-if="file.canResume" theme="success" size="small" variant="outline">可续传</t-tag>
                <t-tag v-if="file.status === 'pending'" theme="default" size="small">待上传</t-tag>
                <t-tag v-if="file.status === 'waiting_file'" theme="warning" size="small">需选择文件</t-tag>
                <t-tag v-if="file.status === 'duplicate'" theme="warning" size="small">重复</t-tag>
                <t-tag v-if="file.status === 'skipped'" theme="default" size="small">已跳过</t-tag>
                <t-tag v-if="file.status === 'cancelled'" theme="default" size="small">已取消</t-tag>
                <t-tag v-if="file.status === 'error'" theme="danger" size="small">失败</t-tag>
              </div>
              <!-- 重复信息 -->
              <div v-if="file.duplicateInfo && file.status === 'skipped'" class="duplicate-info">
                <t-icon name="info-circle" />
                <span>已有: {{ file.duplicateInfo.title }}{{ file.duplicateInfo.artist ? ' - ' + file.duplicateInfo.artist : '' }}</span>
              </div>
              <!-- 恢复任务的提示 -->
              <div v-if="file.isRecovered" class="recovered-info">
                <t-icon name="info-circle" />
                <span>后端正在上传中，保持页面打开可查看进度</span>
              </div>
              <!-- 断点续传提示 -->
              <div v-if="file.canResume && file.receivedChunks" class="resume-info">
                <t-icon name="info-circle" />
                <span>已上传 {{ file.progress }}%，可从断点续传</span>
              </div>
              <!-- 需要重新选择文件 -->
              <div v-if="file.needReselect" class="reselect-info">
                <t-icon name="info-circle" />
                <span>文件引用丢失，请点击"选择文件"按钮重新选择</span>
              </div>
              <div class="file-progress" v-if="file.status === 'uploading' || file.status === 'success'">
                <t-progress
                  :percentage="file.progress"
                  :status="file.status === 'error' ? 'error' : (file.status === 'success' ? 'success' : 'active')"
                  size="small"
                />
              </div>
              <div class="file-error" v-if="file.errorMsg" style="color: var(--td-error-color); font-size: 12px;">
                {{ file.errorMsg }}
              </div>
              <!-- 操作按钮 -->
              <div class="file-actions">
                <t-button
                  v-if="file.needReselect && file.status === 'waiting_file'"
                  size="small"
                  theme="primary"
                  variant="outline"
                  @click="handleReselectFile(file)"
                >
                  选择文件
                </t-button>
                <t-button
                  v-if="file.canResume && !file.needReselect && file.status === 'pending'"
                  size="small"
                  theme="success"
                  @click="resumeUpload(file)"
                  :disabled="isUploading"
                >
                  继续上传
                </t-button>
                <t-button
                  v-if="file.status !== 'uploading'"
                  size="small"
                  variant="text"
                  @click="removeFromQueue(file.id)"
                >
                  <t-icon name="close" />
                </t-button>
              </div>
            </div>
          </div>
          <div class="queue-actions">
            <t-button 
              v-if="isUploading" 
              theme="danger" 
              variant="outline" 
              @click="cancelUpload"
            >
              取消上传
            </t-button>
            <t-button 
              v-else 
              theme="primary" 
              @click="startUpload"
            >
              开始上传
            </t-button>
          </div>
        </div>
      </div>
    </t-dialog>

    <!-- 编辑歌曲对话框 -->
    <t-dialog
      v-model:visible="showEditDialog"
      header="编辑歌曲信息"
      width="500px"
      @confirm="saveSong"
    >
      <t-form :data="editForm" label-align="right">
        <t-form-item label="标题">
          <t-input v-model="editForm.title" />
        </t-form-item>
        <t-form-item label="艺术家">
          <t-input v-model="editForm.artist" />
        </t-form-item>
        <t-form-item label="专辑">
          <t-input v-model="editForm.album" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 歌单编辑对话框 -->
    <t-dialog
      v-model:visible="showPlaylistManageDialog"
      header="编辑歌单"
      width="500px"
      :footer="false"
      @close="resetPlaylistEdit"
    >
      <div class="playlist-edit-container">
        <!-- 歌单选择 -->
        <t-form-item label="选择歌单">
          <t-select
            v-model="editingPlaylistId"
            placeholder="选择要编辑的歌单"
            @change="onPlaylistSelect"
          >
            <t-option
              v-for="p in playlists"
              :key="p.id"
              :value="p.id"
              :label="p.name"
            />
          </t-select>
        </t-form-item>

        <!-- 编辑区域 -->
        <template v-if="editingPlaylistId">
          <t-divider />

          <!-- 名称 -->
          <t-form-item label="名称" required>
            <t-input v-model="playlistEditForm.name" placeholder="歌单名称" />
          </t-form-item>

          <!-- 描述 -->
          <t-form-item label="描述">
            <t-textarea
              v-model="playlistEditForm.description"
              placeholder="歌单描述"
              :maxlength="200"
            />
          </t-form-item>

          <!-- 操作按钮 -->
          <div class="playlist-edit-actions">
            <t-button theme="primary" @click="savePlaylistEdit" :disabled="isGuest">
              保存修改
            </t-button>
            <t-popconfirm content="确定删除该歌单吗？歌曲源文件不会被删除。" @confirm="deletePlaylistFromEdit">
              <t-button theme="danger" variant="outline" :disabled="isGuest">
                删除歌单
              </t-button>
            </t-popconfirm>
          </div>
        </template>

        <!-- 创建新歌单入口 -->
        <t-divider />
        <t-button theme="primary" variant="outline" block @click="showCreatePlaylistDialog = true" :disabled="isGuest">
          <template #icon><t-icon name="add" /></template>
          创建新歌单
        </t-button>
      </div>
    </t-dialog>

    <!-- 创建歌单对话框 -->
    <t-dialog
      v-model:visible="showCreatePlaylistDialog"
      header="创建歌单"
      width="400px"
      @confirm="createNewPlaylist"
      @close="resetCreatePlaylist"
    >
      <t-form :data="playlistForm" label-align="right">
        <t-form-item label="名称" required>
          <t-input v-model="playlistForm.name" placeholder="歌单名称" />
        </t-form-item>
        <t-form-item label="描述">
          <t-textarea v-model="playlistForm.description" placeholder="歌单描述" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 添加到歌单对话框 -->
    <t-dialog
      v-model:visible="showAddToPlaylistDialog"
      header="添加到歌单"
      width="400px"
      @confirm="confirmAddToPlaylist"
    >
      <t-radio-group v-model="selectedPlaylistId">
        <div class="playlist-options">
          <t-radio 
            v-for="playlist in playlists" 
            :key="playlist.id" 
            :value="playlist.id"
          >
            {{ playlist.name }} ({{ playlist.song_count }} 首)
          </t-radio>
        </div>
      </t-radio-group>
    </t-dialog>

    <!-- 去重对话框 -->
    <t-dialog
      v-model:visible="showDuplicatesDialog"
      header="音乐库去重"
      width="800px"
      :footer="false"
    >
      <div class="duplicates-container">
        <div class="duplicates-header" v-if="duplicates.length > 0">
          <span class="warning-text">发现 {{ duplicates.reduce((sum, d) => sum + d.count - 1, 0) }} 首重复歌曲</span>
          <t-popconfirm content="确定删除所有重复歌曲吗？将保留最早添加的版本。" @confirm="removeAllDuplicates">
            <t-button theme="danger" :loading="removingDuplicates">一键去重</t-button>
          </t-popconfirm>
        </div>
        <div class="duplicates-empty" v-else-if="!checkingDuplicates">
          <t-icon name="check-circle" size="48px" style="color: var(--td-success-color)" />
          <p>音乐库没有重复歌曲</p>
        </div>
        <div class="duplicates-list" v-if="duplicates.length > 0">
          <div v-for="group in duplicates" :key="group.key" class="duplicate-group">
            <div class="group-header">
              <span class="group-title">{{ group.title }} - {{ group.artist }}</span>
              <span class="group-count">{{ group.count }} 首重复</span>
            </div>
            <div class="group-songs">
              <div v-for="(song, idx) in group.songs" :key="song.id" class="song-row" :class="{ 'keep': idx === 0 }">
                <span class="song-index">{{ idx + 1 }}</span>
                <span class="song-title">{{ song.title }}</span>
                <span class="song-info">{{ song.album || '-' }} · {{ formatDuration(song.duration) }} · {{ formatFileSize(song.file_size) }}</span>
                <span class="song-date">{{ song.created_at }}</span>
                <t-tag v-if="idx === 0" theme="success" variant="light">保留</t-tag>
                <t-tag v-else theme="danger" variant="light">重复</t-tag>
              </div>
            </div>
          </div>
        </div>
      </div>
    </t-dialog>

    <!-- 歌词下载进度对话框 -->
    <t-dialog
      v-model:visible="showLyricsProgressDialog"
      header="批量获取歌词"
      width="600px"
      :footer="false"
      :close-on-overlay-click="false"
      :close-on-esc-keydown="false"
    >
      <div class="lyrics-progress-container">
        <div class="progress-header">
          <t-progress
            :percentage="lyricsProgress.total > 0 ? Math.round((lyricsProgress.progress / lyricsProgress.total) * 100) : 0"
            :theme="lyricsProgress.status === 'completed' ? 'success' : 'default'"
            size="large"
          />
          <div class="progress-stats">
            <span>总计: {{ lyricsProgress.total }} 首</span>
            <span class="success-text">成功: {{ lyricsProgress.success }}</span>
            <span class="failed-text">失败: {{ lyricsProgress.failed }}</span>
          </div>
        </div>

        <div class="progress-status" v-if="lyricsProgress.status === 'running'">
          <t-icon name="loading" size="20px" spin />
          <span>正在下载歌词... ({{ lyricsProgress.progress }} / {{ lyricsProgress.total }})</span>
        </div>

        <div class="progress-results" v-if="lyricsProgress.results.filter(r => !r.skipped).length > 0">
          <t-divider>下载结果</t-divider>
          <div class="results-list">
            <div
              v-for="(result, idx) in lyricsProgress.results.filter(r => !r.skipped)"
              :key="idx"
              class="result-item"
              :class="{ 'success': result.success, 'failed': !result.success }"
            >
              <div class="result-info">
                <t-icon :name="result.success ? 'check-circle' : 'close-circle'" size="16px" />
                <span class="result-title">{{ result.title || `歌曲 ${result.musicId}` }}</span>
                <span class="result-artist" v-if="result.artist">{{ result.artist }}</span>
              </div>
              <div class="result-meta">
                <t-tag v-if="result.success" theme="success" variant="light" size="small">{{ result.source }}</t-tag>
                <span v-else class="result-error">{{ result.error }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="progress-actions" v-if="lyricsProgress.status === 'completed'">
          <t-button theme="primary" @click="showLyricsProgressDialog = false">关闭</t-button>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import api from '@/api'
import { initCoverDB, getCoverFromCache, saveCoverToCache } from '@/utils/coverCache'
import { initUploadDB, saveUploadState, getAllPendingUploads, deleteUploadState, cleanExpiredUploads } from '@/utils/uploadState'
import { usePermission } from '@/composables/usePermission'

const { isGuest } = usePermission()

// 状态
const loading = ref(false)
const musicList = ref([])
const total = ref(0)
const allMusicTotal = ref(0) // 全部音乐总数（用于显示）
const pagination = ref({ current: 1, pageSize: 30 })

// 筛选和排序
const searchKeyword = ref('')
const filterArtist = ref('')
const filterAlbum = ref('')
const sortBy = ref('created_at')

// 排序方向映射（常量）
const sortOrderMap = {
  'created_at': 'DESC',
  'title': 'ASC',
  'artist': 'ASC',
  'album': 'ASC',
  'duration': 'DESC'
}

// 艺术家和专辑列表
const artists = ref([])
const albums = ref([])

// 歌单相关
const playlists = ref([])
const currentPlaylist = ref(null)

// 选择相关
const selectedSongs = ref([])

// 拖拽状态
const isDragging = ref(false)
const isUploadDragging = ref(false)

// 上传相关
const showUploadDialog = ref(false)
const fileInput = ref(null)
const uploadQueue = ref([])
const isUploading = ref(false)

// 编辑相关
const showEditDialog = ref(false)
const editForm = ref({ id: null, title: '', artist: '', album: '' })

// 歌单对话框
const showPlaylistManageDialog = ref(false)
const showCreatePlaylistDialog = ref(false)
const editingPlaylistId = ref(null)
const playlistEditForm = ref({
  name: '',
  description: ''
})
const playlistForm = ref({ name: '', description: '' })

// 添加到歌单
const showAddToPlaylistDialog = ref(false)
const selectedPlaylistId = ref(null)

// 去重相关
const showDuplicatesDialog = ref(false)
const checkingDuplicates = ref(false)
const removingDuplicates = ref(false)
const duplicates = ref([])

// 歌词下载相关
const downloadingLyrics = ref(false)
const downloadingAllLyrics = ref(false)
const showLyricsProgressDialog = ref(false)
const lyricsTaskId = ref(null)
const lyricsProgress = ref({
  status: 'pending',
  progress: 0,
  total: 0,
  success: 0,
  failed: 0,
  results: []
})

// 封面缓存（使用 IndexedDB 持久化）
const coverCache = ref({})
const coverLoadingSet = new Set()
let coverObserver = null

// 初始化封面缓存
async function initCoverCache() {
  try {
    await initCoverDB()
    console.log('[封面缓存] IndexedDB 初始化完成')
  } catch (e) {
    console.error('初始化封面缓存失败:', e)
  }
}

// 懒加载封面
function observeCover(el, song) {
  if (!coverObserver) {
    // 获取滚动容器作为 IntersectionObserver 的 root
    const scrollContainer = document.querySelector('.scrollable-content')
    coverObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const songData = entry.target.__song__
          if (songData && songData.has_cover && !coverCache.value[songData.id] && !coverLoadingSet.has(songData.id)) {
            loadCover(songData.id)
          }
          coverObserver.unobserve(entry.target)
        }
      })
    }, { 
      root: scrollContainer, // 使用正确的滚动容器
      rootMargin: '100px' 
    })
  }

  el.__song__ = song
  if (song.has_cover && !coverCache.value[song.id]) {
    coverObserver.observe(el)
  }
}

// 加载封面（使用 IndexedDB 缓存）
async function loadCover(id) {
  if (coverLoadingSet.has(id) || coverCache.value[id]) return

  coverLoadingSet.add(id)
  try {
    // 先从 IndexedDB 缓存读取
    const cached = await getCoverFromCache(id)
    if (cached) {
      coverCache.value[id] = cached
      return
    }
    
    // 缓存未命中，从服务器获取
    const response = await api.music.getCover(id)
    const cover = response.data.cover
    coverCache.value[id] = cover
    
    // 保存到 IndexedDB 缓存
    await saveCoverToCache(id, cover)
  } catch (e) {
    console.error('加载封面失败:', e)
  } finally {
    coverLoadingSet.delete(id)
  }
}

// 表格列定义
const columns = [
  { colKey: 'title', title: '标题', width: 350, align: 'left' },
  { colKey: 'artist', title: '艺术家', width: 120, align: 'left' },
  { colKey: 'album', title: '专辑', width: 120, align: 'left' },
  { colKey: 'duration', title: '时长', width: 70, align: 'left' },
  { colKey: 'fileSize', title: '大小', width: 80, align: 'left' },
  { colKey: 'operation', title: '操作', width: 130, align: 'left' }
]

// 计算是否全选
const isAllSelected = computed(() => {
  if (musicList.value.length === 0) return false
  return musicList.value.every(song => selectedSongs.value.includes(song.id))
})

// 加载音乐列表
async function loadMusic() {
  loading.value = true
  try {
    // 根据排序字段智能选择排序方向
    const sortOrder = sortOrderMap[sortBy.value] || 'DESC'
    
    const response = await api.music.list({
      keyword: searchKeyword.value,
      artist: filterArtist.value,
      album: filterAlbum.value,
      sortBy: sortBy.value,
      sortOrder: sortOrder,
      page: pagination.value.current,
      pageSize: pagination.value.pageSize
    })
    musicList.value = response.data.data || []
    total.value = response.data.total || 0
    allMusicTotal.value = total.value // 保存全部音乐总数
  } catch (error) {
    MessagePlugin.error('加载音乐失败')
  } finally {
    loading.value = false
  }
}

// 搜索音乐（重置到第一页）
async function searchMusic() {
  pagination.value.current = 1
  await loadMusic()
}

// 加载艺术家和专辑列表
async function loadFilters() {
  try {
    const [artistsRes, albumsRes] = await Promise.all([
      api.music.artists(),
      api.music.albums()
    ])
    artists.value = artistsRes.data.data || []
    albums.value = albumsRes.data.data || []
    console.log('[艺术家列表] 加载成功，数量:', artists.value.length, artists.value.slice(0, 10))
    console.log('[专辑列表] 加载成功，数量:', albums.value.length, albums.value.slice(0, 10))
  } catch (error) {
    console.error('加载筛选列表失败:', error)
    MessagePlugin.error('加载筛选列表失败')
  }
}

// 加载歌单列表
async function loadPlaylists() {
  try {
    const response = await api.music.getPlaylists()
    playlists.value = response.data.data || []
    console.log('[歌单列表] 加载成功，数量:', playlists.value.length, playlists.value)
  } catch (error) {
    console.error('加载歌单失败:', error)
    MessagePlugin.error('加载歌单失败')
  }
}

// 选择歌单
async function selectPlaylist(playlist) {
  currentPlaylist.value = playlist
  selectedSongs.value = [] // 清空选择
  
  // 切换歌单时重置分页和筛选条件
  pagination.value.current = 1
  searchKeyword.value = ''
  filterArtist.value = ''
  filterAlbum.value = ''
  
  if (playlist) {
    loading.value = true
    try {
      const response = await api.music.getPlaylistSongs(playlist.id)
      musicList.value = response.data.data || []
      // 不修改 total，保持全部音乐总数
    } catch (error) {
      MessagePlugin.error('加载歌单歌曲失败')
    } finally {
      loading.value = false
    }
  } else {
    loadMusic()
  }
}

// 播放整个歌单
async function playPlaylist(playlist) {
  try {
    const response = await api.music.getPlaylistSongs(playlist.id)
    const songs = response.data.data || []
    if (songs.length > 0) {
      // 发送事件给播放器，播放整个歌单
      window.dispatchEvent(new CustomEvent('play-music', { 
        detail: { song: songs[0], list: songs }
      }))
    } else {
      MessagePlugin.warning('歌单为空')
    }
  } catch (error) {
    MessagePlugin.error('播放歌单失败')
  }
}

// 播放全部音乐
async function playAllMusic() {
  try {
    // 获取所有音乐（设置很大的 pageSize）
    const response = await api.music.list({ page: 1, pageSize: 10000 })
    const songs = response.data.data || []
    if (songs.length > 0) {
      // 发送事件给播放器
      window.dispatchEvent(new CustomEvent('play-music', { 
        detail: { song: songs[0], list: songs }
      }))
    } else {
      MessagePlugin.warning('音乐库为空')
    }
  } catch (error) {
    MessagePlugin.error('播放失败')
  }
}

// 分页
function handlePageChange(pageInfo) {
  pagination.value.current = pageInfo.current
  loadMusic()
  // 滚动到顶部（滚动容器是 .scrollable-content）
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

function handlePageSizeChange(pageSize) {
  pagination.value.pageSize = pageSize
  pagination.value.current = 1
  loadMusic()
  // 滚动到顶部
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

// 拖拽上传
function handleDragOver(e) {
  if (!showUploadDialog.value) {
    isDragging.value = true
  }
}

function handleDragLeave(e) {
  isDragging.value = false
}

function handleDrop(e) {
  isDragging.value = false
  const files = Array.from(e.dataTransfer.files).filter(f => 
    ['.mp3', '.flac', '.wav', '.ape', '.m4a', '.ogg', '.aac'].some(ext => 
      f.name.toLowerCase().endsWith(ext)
    )
  )
  if (files.length > 0) {
    addFilesToQueue(files)
    showUploadDialog.value = true
  }
}

// 上传区域
function triggerFileInput() {
  fileInput.value?.click()
}

function handleFileSelect(e) {
  const files = Array.from(e.target.files)
  addFilesToQueue(files)
  e.target.value = ''
}

function handleUploadDrop(e) {
  e.stopPropagation()
  isUploadDragging.value = false
  const files = Array.from(e.dataTransfer.files)
  addFilesToQueue(files)
}

function addFilesToQueue(files) {
  for (const file of files) {
    uploadQueue.value.push({
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: file.name,
      size: file.size,
      file: file,
      progress: 0,
      status: 'pending'
    })
  }
}

function removeFromQueue(id) {
  uploadQueue.value = uploadQueue.value.filter(f => f.id !== id)
  // 同时删除 IndexedDB 中的状态
  deleteUploadState(id)
}

function clearUploadQueue() {
  uploadQueue.value = []
}

// 上传对话框关闭
function handleUploadDialogClose() {
  // 停止进度轮询
  stopProgressPolling()
  
  // 如果还有正在上传的恢复任务，提示用户
  const recoveringTasks = uploadQueue.value.filter(f => f.isRecovered && f.status === 'uploading')
  if (recoveringTasks.length > 0) {
    MessagePlugin.info('后台上传任务将在后台继续进行')
  }
}

// 开始上传
let uploadAbortController = null

async function startUpload() {
  if (uploadQueue.value.length === 0) return
  if (isUploading.value) {
    console.log('[上传] 已在上传中，跳过')
    return
  }
  
  isUploading.value = true
  uploadAbortController = new AbortController()
  
  console.log('[上传] 开始上传，文件数:', uploadQueue.value.length)
  
  // 先检查所有待上传文件是否重复
  const pendingFiles = uploadQueue.value.filter(f => f.status === 'pending')
  for (const file of pendingFiles) {
    try {
      const checkRes = await api.music.checkDuplicate({
        fileName: file.name,
        fileSize: file.size
      })
      if (checkRes.data?.duplicate) {
        file.status = 'skipped'
        file.duplicateInfo = checkRes.data.matches?.[0]
        console.log(`[上传] 跳过重复文件: ${file.name}`)
      }
    } catch (e) {
      console.log(`[上传] 检查重复失败: ${file.name}`, e)
    }
  }
  
  for (const file of uploadQueue.value) {
    if (file.status === 'success' || file.status === 'skipped') continue
    
    file.status = 'uploading'
    file.progress = 0
    
    try {
      const CHUNK_SIZE = 10 * 1024 * 1024
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
      
      // 开始上传会话
      await api.music.startUpload({
        fileId: file.id,
        fileName: file.name,
        fileSize: file.size,
        totalChunks
      })
      
      // 保存文件到 IndexedDB（用于断点续传）
      await saveUploadState(file.id, file.file, totalChunks)
      
      console.log(`[上传] 文件: ${file.name}, 大小: ${file.size}, 分片数: ${totalChunks}`)
      
      // 上传分片
      for (let i = 0; i < totalChunks; i++) {
        // 检查是否被取消
        if (uploadAbortController.signal.aborted) {
          file.status = 'cancelled'
          throw new Error('上传已取消')
        }
        
        const start = i * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, file.size)
        const chunk = file.file.slice(start, end)
        
        const formData = new FormData()
        formData.append('fileId', file.id)
        formData.append('chunkIndex', i)
        formData.append('totalChunks', totalChunks)
        formData.append('fileName', file.name)
        formData.append('chunk', chunk)
        
        await api.music.uploadChunk(formData)
        
        file.progress = Math.round(((i + 1) / totalChunks) * 100)
        console.log(`[上传进度] ${file.name}: ${file.progress}% (${i + 1}/${totalChunks})`)
      }
      
      // 合并分片，强制跳过重复检测（因为已经在上传前检查过了）
      await api.music.mergeChunks({
        fileId: file.id,
        fileName: file.name,
        totalChunks,
        skipDuplicate: true
      })
      file.status = 'success'
      
      // 上传成功，删除保存的状态
      await deleteUploadState(file.id)
    } catch (error) {
      console.error('上传失败:', error)
      if (file.status !== 'cancelled' && file.status !== 'skipped') {
        file.status = 'error'
        file.errorMsg = error.message || '上传失败'
      }
    }
  }
  
  isUploading.value = false
  uploadAbortController = null
  
  // 停止进度轮询
  stopProgressPolling()
  
  // 清除保存的进度
  localStorage.removeItem('musicUploadQueue')
  
  loadMusic()
  loadFilters()
  
  const successCount = uploadQueue.value.filter(f => f.status === 'success').length
  const skippedCount = uploadQueue.value.filter(f => f.status === 'skipped').length
  
  if (successCount > 0) {
    MessagePlugin.success(`上传完成，${successCount} 首音乐已添加`)
  }
  if (skippedCount > 0) {
    MessagePlugin.info(`${skippedCount} 首重复音乐已跳过`)
  }
  
  uploadQueue.value = uploadQueue.value.filter(f => f.status !== 'success' && f.status !== 'skipped')
  
  if (uploadQueue.value.every(f => f.status === 'success' || f.status === 'skipped')) {
    showUploadDialog.value = false
  }
}

// 保存上传进度到 localStorage
// 恢复上传进度（从后端同步和 IndexedDB 恢复）
async function restoreUploadProgress() {
  try {
    // 清理过期的上传状态
    await cleanExpiredUploads()
    
    // 从 IndexedDB 获取所有未完成的上传
    const pendingUploads = await getAllPendingUploads()
    
    if (pendingUploads.length > 0) {
      console.log('[上传恢复] 发现', pendingUploads.length, '个未完成的上传（IndexedDB）')
      
      // 检查每个上传的状态
      const resumedUploads = []
      
      for (const upload of pendingUploads) {
        try {
          // 从后端获取上传状态
          const statusRes = await api.music.getUploadStatus(upload.fileId)
          const status = statusRes.data
          
          if (status && status.status === 'uploading') {
            // 后端还有这个上传任务
            const receivedChunks = status.receivedChunks || []
            const totalChunks = status.totalChunks
            const percent = Math.round((receivedChunks.length / totalChunks) * 100)
            
            // 检查文件是否还有效（File 对象还在）
            if (upload.file && upload.file instanceof File) {
              // 页面刷新后恢复，文件对象有效，显示为"后台上传中"
              // 因为后端任务正在进行，前端只需要显示进度
              resumedUploads.push({
                id: upload.fileId,
                name: upload.fileName,
                size: upload.fileSize,
                file: upload.file,
                totalChunks,
                receivedChunks,
                progress: percent,
                status: 'uploading', // 后端正在上传
                isRecovered: true, // 标记为后台恢复任务
                canResume: false // 不是可续传，是正在上传
              })
              console.log(`[上传恢复] ${upload.fileName} 后台正在上传，已接收 ${receivedChunks.length}/${totalChunks} 分片`)
            } else {
              // File 对象丢失，需要重新选择文件才能续传
              resumedUploads.push({
                id: upload.fileId,
                name: upload.fileName,
                size: upload.fileSize,
                totalChunks,
                receivedChunks,
                progress: percent,
                status: 'waiting_file', // 等待重新选择文件
                canResume: true,
                needReselect: true // 需要重新选择
              })
              console.log(`[上传恢复] ${upload.fileName} 需要重新选择文件`)
            }
          }
        } catch (e) {
          // 后端没有这个上传任务，删除本地状态
          console.log(`[上传恢复] ${upload.fileId} 后端任务不存在，清理本地状态`)
          await deleteUploadState(upload.fileId)
        }
      }
      
      if (resumedUploads.length > 0) {
        uploadQueue.value = resumedUploads
        showUploadDialog.value = true
        
        // 如果有正在上传的任务，启动进度轮询
        const uploadingTasks = resumedUploads.filter(f => f.status === 'uploading')
        if (uploadingTasks.length > 0) {
          isUploading.value = true
          startProgressPolling()
          MessagePlugin.info(`检测到 ${uploadingTasks.length} 个后台正在上传的任务`)
        } else {
          MessagePlugin.info(`检测到 ${resumedUploads.length} 个未完成的上传任务`)
        }
      }
      
      return
    }
    
    // 如果 IndexedDB 没有，尝试从后端获取进度
    const response = await api.music.getUploadProgress()
    const progress = response.data.data || []
    
    if (progress.length > 0) {
      console.log('[上传恢复] 发现', progress.length, '个正在上传的任务（后端）')
      
      // 显示上传进度（只读模式，因为文件对象已丢失）
      uploadQueue.value = progress.map(p => ({
        id: p.fileId,
        name: p.fileName,
        size: 0,
        progress: p.percent,
        status: 'uploading',
        file: null,
        isRecovered: true
      }))
      
      isUploading.value = true
      showUploadDialog.value = true
      
      startProgressPolling()
      
      MessagePlugin.info(`检测到 ${progress.length} 个上传任务正在进行中`)
    }
  } catch (e) {
    console.error('[上传恢复] 获取上传进度失败:', e)
  }
}

// 续传上传（从断点继续）
async function resumeUpload(fileItem) {
  if (!fileItem.file && !fileItem.needReselect) {
    MessagePlugin.error('文件不可用，请重新选择')
    return
  }
  
  fileItem.status = 'uploading'
  isUploading.value = true
  uploadAbortController = new AbortController()
  
  try {
    const CHUNK_SIZE = 10 * 1024 * 1024
    const totalChunks = fileItem.totalChunks
    const receivedChunks = new Set(fileItem.receivedChunks || [])
    
    console.log(`[续传] ${fileItem.name}, 已接收分片: ${receivedChunks.size}/${totalChunks}`)
    
    // 上传未接收的分片
    for (let i = 0; i < totalChunks; i++) {
      if (receivedChunks.has(i)) {
        // 已接收，跳过
        continue
      }
      
      if (uploadAbortController.signal.aborted) {
        fileItem.status = 'cancelled'
        throw new Error('上传已取消')
      }
      
      const start = i * CHUNK_SIZE
      const end = Math.min(start + CHUNK_SIZE, fileItem.size)
      const chunk = fileItem.file.slice(start, end)
      
      const formData = new FormData()
      formData.append('fileId', fileItem.id)
      formData.append('chunkIndex', i)
      formData.append('totalChunks', totalChunks)
      formData.append('fileName', fileItem.name)
      formData.append('chunk', chunk)
      
      await api.music.uploadChunk(formData)
      
      receivedChunks.add(i)
      fileItem.progress = Math.round((receivedChunks.size / totalChunks) * 100)
    }
    
    // 合并分片
    await api.music.mergeChunks({
      fileId: fileItem.id,
      fileName: fileItem.name,
      totalChunks,
      skipDuplicate: true
    })
    
    fileItem.status = 'success'
    await deleteUploadState(fileItem.id)
    
    MessagePlugin.success(`${fileItem.name} 上传完成`)
    loadMusic()
    loadFilters()
  } catch (error) {
    console.error('续传失败:', error)
    if (fileItem.status !== 'cancelled') {
      fileItem.status = 'error'
      fileItem.errorMsg = error.message || '上传失败'
    }
  } finally {
    // 检查是否所有文件都完成
    const allDone = uploadQueue.value.every(f => 
      f.status === 'success' || f.status === 'skipped' || f.status === 'error' || f.status === 'cancelled'
    )
    
    if (allDone) {
      isUploading.value = false
      uploadAbortController = null
      stopProgressPolling()
      
      // 清除完成的任务
      uploadQueue.value = uploadQueue.value.filter(f => 
        f.status !== 'success' && f.status !== 'skipped'
      )
    }
  }
}

// 重新选择文件并续传
function handleReselectFile(fileItem) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.mp3,.flac,.wav,.ape,.m4a,.ogg,.aac'
  
  input.onchange = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    
    // 检查文件名和大小是否匹配
    if (file.name !== fileItem.name || file.size !== fileItem.size) {
      MessagePlugin.warning(`请选择相同的文件: ${fileItem.name} (${formatFileSize(fileItem.size)})`)
      return
    }
    
    // 更新文件对象
    fileItem.file = file
    fileItem.needReselect = false
    fileItem.status = 'pending'
    
    // 保存到 IndexedDB
    await saveUploadState(fileItem.id, file, fileItem.totalChunks)
    
    MessagePlugin.success('文件已选择，点击"继续上传"按钮')
  }
  
  input.click()
}

// 进度轮询
let progressPollingTimer = null

function startProgressPolling() {
  if (progressPollingTimer) {
    clearInterval(progressPollingTimer)
  }
  
  progressPollingTimer = setInterval(async () => {
    try {
      const response = await api.music.getUploadProgress()
      const progress = response.data.data || []
      
      if (progress.length === 0) {
        // 所有上传完成
        stopProgressPolling()
        isUploading.value = false
        uploadQueue.value = uploadQueue.value.map(f => ({
          ...f,
          status: 'success'
        }))
        loadMusic()
        loadFilters()
        return
      }
      
      // 更新进度
      for (const p of progress) {
        const file = uploadQueue.value.find(f => f.id === p.fileId)
        if (file) {
          file.progress = p.percent
        }
      }
    } catch (e) {
      console.error('[进度轮询] 获取进度失败:', e)
    }
  }, 2000) // 每 2 秒轮询一次
}

function stopProgressPolling() {
  if (progressPollingTimer) {
    clearInterval(progressPollingTimer)
    progressPollingTimer = null
  }
}

// 取消上传
async function cancelUpload() {
  console.log('[取消上传] 开始取消上传...')
  
  // 停止进度轮询
  stopProgressPolling()
  
  // 1. 中断所有正在进行的 HTTP 请求
  if (uploadAbortController) {
    uploadAbortController.abort()
    console.log('[取消上传] 已发送中断信号')
  }
  
  // 2. 调用后端取消所有上传
  try {
    await api.music.cancelAllUploads()
    console.log('[取消上传] 后端已取消所有上传')
  } catch (e) {
    console.log('[取消上传] 取消请求失败:', e.message)
  }
  
  // 3. 更新前端状态
  const uploadingFiles = uploadQueue.value.filter(f => f.status === 'uploading')
  for (const file of uploadingFiles) {
    file.status = 'cancelled'
  }
  
  // 4. 重置上传状态
  isUploading.value = false
  uploadAbortController = null
  
  // 5. 清除保存的进度
  localStorage.removeItem('musicUploadQueue')
  
  // 6. 提示用户
  if (uploadingFiles.length > 0) {
    MessagePlugin.info(`已取消 ${uploadingFiles.length} 个文件的上传`)
  }
}

// 播放歌曲（将当前显示的所有音乐加入临时歌单）
async function playSong(song) {
  // 获取当前显示的所有音乐（可能跨页）
  let songsToPlay = []
  
  if (currentPlaylist.value) {
    // 如果在歌单中，使用当前歌单的歌曲
    songsToPlay = [...musicList.value]
  } else {
    // 不在歌单中，获取当前筛选条件下的所有音乐
    try {
      // 使用相同的筛选条件，获取所有音乐
      const params = {
        page: 1,
        pageSize: 10000, // 获取所有音乐
        sortBy: sortBy.value,
        sortOrder: sortOrderMap[sortBy.value] || 'DESC'
      }
      
      if (searchKeyword.value) params.keyword = searchKeyword.value
      if (filterArtist.value) params.artist = filterArtist.value
      if (filterAlbum.value) params.album = filterAlbum.value
      
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
}

function handleRowClick({ row }) {
  // 单击播放
}

function handleRowDblClick({ row }) {
  playSong(row)
}

// 编辑歌曲
function editSong(song) {
  editForm.value = { id: song.id, title: song.title, artist: song.artist, album: song.album }
  showEditDialog.value = true
}

async function saveSong() {
  try {
    await api.music.update(editForm.value.id, editForm.value)
    MessagePlugin.success('保存成功')
    showEditDialog.value = false
    loadMusic()
  } catch (error) {
    MessagePlugin.error('保存失败')
  }
}

// 删除歌曲
async function deleteSong(id) {
  try {
    if (currentPlaylist.value) {
      // 从歌单移除，不删除源文件
      await api.music.removePlaylistSong(currentPlaylist.value.id, id)
      MessagePlugin.success('已从歌单移除')
    } else {
      // 删除源文件
      await api.music.delete(id)
      MessagePlugin.success('删除成功')
      
      // 通知播放器从播放列表中移除
      window.dispatchEvent(new CustomEvent('remove-music', { 
        detail: { songId: id }
      }))
    }
    
    if (currentPlaylist.value) {
      selectPlaylist(currentPlaylist.value)
    } else {
      loadMusic()
    }
    loadPlaylists()
  } catch (error) {
    MessagePlugin.error('删除失败')
  }
}

// 批量操作
function toggleSelect(id, checked) {
  if (checked) {
    if (!selectedSongs.value.includes(id)) {
      selectedSongs.value.push(id)
    }
  } else {
    selectedSongs.value = selectedSongs.value.filter(s => s !== id)
  }
}

// 全选/取消全选
// 全选所有音乐（不仅是当前页）
const selectAllLoading = ref(false)

async function toggleSelectAll() {
  // 如果在歌单模式，只选择当前歌单的歌曲
  if (currentPlaylist.value) {
    if (isAllSelected.value) {
      selectedSongs.value = []
    } else {
      selectedSongs.value = musicList.value.map(s => s.id)
    }
    return
  }

  // 全选所有音乐
  if (selectedSongs.value.length === total.value && total.value > 0) {
    // 已全选，取消全选
    selectedSongs.value = []
    return
  }

  // 开始全选
  selectAllLoading.value = true
  try {
    const response = await api.music.getAllIds({
      keyword: searchKeyword.value,
      artist: filterArtist.value,
      album: filterAlbum.value
    })
    selectedSongs.value = response.data.data || []
    MessagePlugin.success(`已选择 ${selectedSongs.value.length} 首歌曲`)
  } catch (error) {
    MessagePlugin.error('全选失败')
    // 降级为当前页全选
    selectedSongs.value = musicList.value.map(s => s.id)
  } finally {
    selectAllLoading.value = false
  }
}

function addToPlaylist() {
  if (selectedSongs.value.length === 0) {
    MessagePlugin.warning('请先选择歌曲')
    return
  }
  showAddToPlaylistDialog.value = true
}

async function confirmAddToPlaylist() {
  if (!selectedPlaylistId.value) {
    MessagePlugin.warning('请选择歌单')
    return
  }
  
  try {
    await api.music.addSongsToPlaylist(selectedPlaylistId.value, selectedSongs.value)
    MessagePlugin.success('添加成功')
    showAddToPlaylistDialog.value = false
    selectedSongs.value = []
    loadPlaylists()
  } catch (error) {
    console.error('添加到歌单失败:', error)
    MessagePlugin.error('添加失败')
  }
}

// 批量删除（删除源文件）
async function batchDelete() {
  try {
    const idsToDelete = [...selectedSongs.value]
    await api.music.batchDelete({ ids: idsToDelete })
    MessagePlugin.success('删除成功')
    
    // 通知播放器从播放列表中批量移除
    window.dispatchEvent(new CustomEvent('remove-music', { 
      detail: { songIds: idsToDelete }
    }))
    
    selectedSongs.value = []
    loadMusic()
    loadPlaylists()
  } catch (error) {
    MessagePlugin.error('删除失败')
  }
}

// 从歌单批量移除（不删除源文件）
async function batchDeleteFromPlaylist() {
  if (!currentPlaylist.value) return
  
  try {
    const idsToDelete = [...selectedSongs.value]
    await api.music.batchRemoveFromPlaylist(currentPlaylist.value.id, idsToDelete)
    MessagePlugin.success('已从歌单移除')
    
    selectedSongs.value = []
    selectPlaylist(currentPlaylist.value)
    loadPlaylists()
  } catch (error) {
    MessagePlugin.error('移除失败')
  }
}

// 批量下载选中歌曲的歌词
async function batchDownloadLyricsForSelected() {
  if (selectedSongs.value.length === 0) {
    MessagePlugin.warning('请先选择音乐')
    return
  }
  
  const confirmed = await DialogPlugin.confirm({
    header: '批量下载歌词',
    body: `将为 ${selectedSongs.value.length} 首音乐搜索并下载歌词，是否继续？`,
    confirmBtn: '开始下载',
    cancelBtn: '取消'
  })
  
  if (!confirmed) return
  
  downloadingLyrics.value = true
  
  try {
    const response = await api.music.downloadLyrics(selectedSongs.value)
    
    if (response.data.success) {
      // 异步任务，显示进度对话框
      lyricsTaskId.value = response.data.taskId
      showLyricsProgressDialog.value = true
      
      // 重置进度
      lyricsProgress.value = {
        status: 'pending',
        progress: 0,
        total: selectedSongs.value.length,
        success: 0,
        failed: 0,
        results: []
      }
      
      // 开始轮询进度
      pollLyricsProgress()
    } else {
      MessagePlugin.error('启动下载任务失败')
    }
  } catch (error) {
    console.error('批量下载歌词失败:', error)
    MessagePlugin.error('批量下载歌词失败')
  } finally {
    downloadingLyrics.value = false
  }
}

// 歌单编辑管理
function onPlaylistSelect(playlistId) {
  if (!playlistId) {
    resetPlaylistEdit()
    return
  }
  const playlist = playlists.value.find(p => p.id === playlistId)
  if (playlist) {
    playlistEditForm.value = {
      name: playlist.name,
      description: playlist.description || ''
    }
  }
}

async function savePlaylistEdit() {
  if (!editingPlaylistId.value) {
    MessagePlugin.warning('请先选择歌单')
    return
  }

  if (!playlistEditForm.value.name.trim()) {
    MessagePlugin.warning('歌单名称不能为空')
    return
  }

  try {
    await api.music.updatePlaylist(editingPlaylistId.value, {
      name: playlistEditForm.value.name,
      description: playlistEditForm.value.description
    })

    MessagePlugin.success('保存成功')
    showPlaylistManageDialog.value = false
    resetPlaylistEdit()
    loadPlaylists()
  } catch (error) {
    if (error.response?.data?.message?.includes('UNIQUE constraint failed')) {
      MessagePlugin.error('歌单名称已存在')
    } else {
      MessagePlugin.error('保存失败')
    }
  }
}

async function deletePlaylistFromEdit() {
  if (!editingPlaylistId.value) return
  
  try {
    await api.music.deletePlaylist(editingPlaylistId.value)
    MessagePlugin.success('歌单已删除')
    showPlaylistManageDialog.value = false
    resetPlaylistEdit()
    
    // 如果删除的是当前选中的歌单，切回全部音乐
    if (currentPlaylist.value?.id === editingPlaylistId.value) {
      currentPlaylist.value = null
      loadMusic()
    }
    loadPlaylists()
  } catch (error) {
    MessagePlugin.error('删除失败')
  }
}

function resetPlaylistEdit() {
  editingPlaylistId.value = null
  playlistEditForm.value = {
    name: '',
    description: ''
  }
}

async function createNewPlaylist() {
  if (!playlistForm.value.name.trim()) {
    MessagePlugin.warning('歌单名称不能为空')
    return
  }

  try {
    await api.music.createPlaylist(playlistForm.value)
    MessagePlugin.success('创建成功')
    showCreatePlaylistDialog.value = false
    resetCreatePlaylist()
    loadPlaylists()
  } catch (error) {
    if (error.response?.data?.message?.includes('UNIQUE constraint failed')) {
      MessagePlugin.error('歌单名称已存在')
    } else {
      MessagePlugin.error('创建失败')
    }
  }
}

function resetCreatePlaylist() {
  playlistForm.value = { name: '', description: '' }
}

async function deletePlaylist(id) {
  try {
    await api.music.deletePlaylist(id)
    MessagePlugin.success('删除成功')
    if (currentPlaylist.value?.id === id) {
      currentPlaylist.value = null
      loadMusic()
    }
    loadPlaylists()
  } catch (error) {
    MessagePlugin.error('删除失败')
  }
}

// 格式化
function formatDuration(seconds) {
  if (!seconds) return '--:--'
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function formatFileSize(bytes) {
  if (!bytes) return '-'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// 去重功能
async function checkDuplicates() {
  checkingDuplicates.value = true
  showDuplicatesDialog.value = true
  try {
    const response = await api.music.getDuplicates()
    duplicates.value = response.data.data || []
  } catch (error) {
    MessagePlugin.error('检查重复失败')
    console.error(error)
  } finally {
    checkingDuplicates.value = false
  }
}

// 批量获取歌词
async function batchDownloadLyrics() {
  try {
    // 获取所有没有歌词的音乐
    const response = await api.music.list({ pageSize: 1000 })
    const allMusic = response.data.data || []

    // 筛选没有歌词的音乐
    const musicWithoutLyrics = allMusic.filter(m => !m.has_lyrics)

    if (musicWithoutLyrics.length === 0) {
      MessagePlugin.success('所有音乐都已有歌词')
      return
    }

    downloadingAllLyrics.value = true
    showLyricsProgressDialog.value = true

    // 重置进度
    lyricsProgress.value = {
      status: 'pending',
      progress: 0,
      total: musicWithoutLyrics.length,
      success: 0,
      failed: 0,
      results: []
    }

    // 启动批量下载任务
    const musicIds = musicWithoutLyrics.map(m => m.id)
    const taskResponse = await api.music.downloadLyrics(musicIds)

    if (taskResponse.data.success) {
      lyricsTaskId.value = taskResponse.data.taskId

      // 开始轮询进度
      pollLyricsProgress()
    } else {
      MessagePlugin.error('启动下载任务失败')
      downloadingAllLyrics.value = false
      showLyricsProgressDialog.value = false
    }
  } catch (error) {
    MessagePlugin.error('批量获取歌词失败')
    console.error(error)
    downloadingAllLyrics.value = false
    showLyricsProgressDialog.value = false
  }
}

// 轮询歌词下载进度
async function pollLyricsProgress() {
  if (!lyricsTaskId.value) return

  try {
    const response = await api.music.getLyricsTask(lyricsTaskId.value)
    const task = response.data.task

    lyricsProgress.value = {
      status: task.status,
      progress: task.progress,
      total: task.total,
      success: task.success,
      failed: task.failed,
      results: task.results
    }

    // 如果任务还在进行中，继续轮询
    if (task.status === 'pending' || task.status === 'running') {
      setTimeout(pollLyricsProgress, 1000)
    } else if (task.status === 'completed') {
      downloadingAllLyrics.value = false
      MessagePlugin.success(`歌词下载完成：成功 ${task.success}，失败 ${task.failed}`)

      // 刷新音乐列表
      searchMusic()
    } else {
      downloadingAllLyrics.value = false
      MessagePlugin.error('歌词下载失败')
    }
  } catch (error) {
    console.error('查询进度失败:', error)
    downloadingAllLyrics.value = false
    MessagePlugin.error('查询进度失败')
  }
}

async function removeAllDuplicates() {
  removingDuplicates.value = true
  try {
    const response = await api.music.removeDuplicates()
    MessagePlugin.success(`去重完成，删除了 ${response.data.deletedCount} 首重复歌曲`)
    showDuplicatesDialog.value = false
    duplicates.value = []
    loadMusic()
    loadPlaylists()
  } catch (error) {
    MessagePlugin.error('去重失败')
    console.error(error)
  } finally {
    removingDuplicates.value = false
  }
}

// 页面可见性变化处理（切换标签页时同步上传状态）
async function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    console.log('[可见性] 页面恢复可见，同步上传状态')
    
    // 查询后端上传进度
    try {
      const response = await api.music.getUploadProgress()
      const progress = response.data.data || []
      
      console.log('[可见性] 后端上传任务数:', progress.length, progress)
      
      if (progress.length > 0) {
        // 后端还有正在上传的任务
        // 如果上传队列中没有这些任务，添加进来
        for (const p of progress) {
          let file = uploadQueue.value.find(f => f.id === p.fileId)
          if (!file) {
            // 队列中没有，添加
            uploadQueue.value.push({
              id: p.fileId,
              name: p.fileName,
              size: p.fileSize || 0,
              progress: p.percent,
              status: 'uploading',
              file: null,
              isRecovered: true,
              canResume: false // 后端正在上传，不是可续传状态
            })
          } else {
            // 更新进度和状态
            file.status = 'uploading'
            file.isRecovered = true
            file.canResume = false // 清除可续传状态
            file.progress = p.percent
          }
        }
        
        // 确保对话框打开
        if (!showUploadDialog.value) {
          showUploadDialog.value = true
        }
        
        // 确保轮询正在进行
        if (!progressPollingTimer) {
          startProgressPolling()
        }
        
        isUploading.value = true
      } else if (uploadQueue.value.some(f => f.status === 'uploading' || f.isRecovered)) {
        // 后端没有正在上传的任务，但前端有上传中的任务
        // 可能是上传已完成
        stopProgressPolling()
        isUploading.value = false
        uploadQueue.value = uploadQueue.value.map(f => ({
          ...f,
          status: f.status === 'uploading' ? 'success' : f.status,
          isRecovered: false,
          canResume: false
        }))
        loadMusic()
        loadFilters()
      }
    } catch (e) {
      console.error('[可见性] 同步上传状态失败:', e)
    }
  }
}

// 初始化
onMounted(async () => {
  await initCoverCache() // 初始化封面缓存（IndexedDB）
  await initUploadDB() // 初始化上传状态（IndexedDB）
  loadMusic()
  loadFilters()
  loadPlaylists()
  restoreUploadProgress() // 恢复上传进度
  
  // 监听页面可见性变化
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

// 清理
onUnmounted(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  stopProgressPolling()
})
</script>

<style scoped>
.music {
  padding: 0;
  padding-bottom: 100px; /* 为播放栏留出空间 */
  position: relative;
  min-height: calc(100vh - 120px);
}

.music.is-dragging {
  pointer-events: none;
}

.drag-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(24, 144, 255, 0.9);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.drag-content {
  text-align: center;
  color: white;
}

.drag-content p {
  margin-top: 16px;
  font-size: 18px;
}

.page-header {
  margin-bottom: 20px;
}

.page-header p {
  font-size: 16px;
  color: #333;
  margin: 0;
  font-weight: 500;
}

/* 表格列样式优化 */
::deep(.t-table) {
  table-layout: auto;
}

::deep(.t-table td) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toolbar-card {
  margin-bottom: 16px;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.toolbar-left {
  display: flex;
  gap: 12px;
}

.toolbar-right {
  display: flex;
  gap: 12px;
}

.main-content {
  display: flex;
  gap: 16px;
}

.sidebar {
  width: 200px;
  flex-shrink: 0;
}

.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  font-weight: 500;
  border-bottom: 1px solid #eee;
}

.sidebar-actions {
  display: flex;
  gap: 4px;
}

.playlist-list {
  background: white;
  border-radius: 6px;
}

.playlist-item {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  cursor: pointer;
  border-radius: 4px;
  margin: 4px;
  gap: 8px;
  position: relative;
}

.playlist-item:hover {
  background: #f5f5f5;
}

.playlist-item.active {
  background: #e6f7ff;
  color: #1890ff;
}

.playlist-item .count {
  margin-left: auto;
  font-size: 12px;
  color: #999;
}

.playlist-play-btn {
  display: none;
  margin-left: 8px;
}

.playlist-item:hover .playlist-play-btn {
  display: inline-flex;
}

.music-list-container {
  flex: 1;
  min-width: 0;
  padding-right: 16px;
}

.batch-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: #e6f7ff;
  border-radius: 4px;
  margin-bottom: 12px;
}

/* 标题表头对齐封面 */
.title-header {
  display: inline-block;
  margin-left: 32px; /* 选择框宽度(24px) + 间隙(8px)，与封面左对齐 */
}

.song-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.song-title-content {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  overflow: hidden;
}

.song-cover-small {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f5f5;
}

.song-cover-small img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.song-cover-small .t-icon {
  color: #999;
}

.title-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artist-text, .album-text {
  color: #666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 110px;
  display: inline-block;
}

/* 音乐表格右侧留白 */
:deep(.t-table .t-table__body) {
  padding-right: 24px;
}

/* 艺术家和专辑列deep选择器样式 */
:deep(.t-table .artist-text),
:deep(.t-table .album-text) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  max-width: 110px;
}

.pagination-wrapper {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

/* 上传区域 */
.upload-area {
  padding: 16px;
}

.upload-dropzone {
  border: 2px dashed #d9d9d9;
  border-radius: 8px;
  padding: 40px;
  text-align: center;
  cursor: pointer;
  transition: all 0.3s;
}

.upload-dropzone:hover,
.upload-dropzone.is-dragging {
  border-color: #1890ff;
  background: #f0f7ff;
}

.upload-dropzone p {
  margin: 8px 0 0;
  color: #666;
}

.upload-dropzone .hint {
  font-size: 12px;
  color: #999;
}

.upload-queue {
  margin-top: 16px;
  border-top: 1px solid #eee;
  padding-top: 16px;
}

.queue-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
}

.queue-list {
  max-height: 200px;
  overflow-y: auto;
}

.queue-item {
  display: flex;
  flex-direction: column;
  padding: 8px 0;
  gap: 4px;
  border-bottom: 1px solid #f0f0f0;
}

.file-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.duplicate-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--td-warning-color);
  padding-left: 24px;
}

.recovered-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--td-brand-color);
  padding-left: 24px;
}

.resume-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--td-success-color);
  padding-left: 24px;
}

.reselect-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--td-warning-color);
  padding-left: 24px;
}

.file-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  color: #999;
  font-size: 12px;
}

.file-progress {
  width: 150px;
}

.queue-actions {
  margin-top: 16px;
  text-align: right;
}

/* 歌单管理 */
.playlist-edit-container {
  padding: 8px 0;
}

.playlist-edit-actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
  padding-top: 16px;
}

.playlist-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 去重对话框样式 */
.duplicates-container {
  max-height: 60vh;
  overflow-y: auto;
}

.duplicates-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--td-component-border);
}

.duplicates-header .warning-text {
  color: var(--td-warning-color);
  font-weight: 500;
}

.duplicates-empty {
  text-align: center;
  padding: 40px 0;
  color: var(--td-text-color-secondary);
}

.duplicates-empty p {
  margin-top: 16px;
}

.duplicates-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.duplicate-group {
  border: 1px solid var(--td-component-border);
  border-radius: 8px;
  overflow: hidden;
}

.group-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: var(--td-bg-color-container-hover);
}

.group-title {
  font-weight: 500;
}

.group-count {
  color: var(--td-warning-color);
  font-size: 12px;
}

.group-songs {
  padding: 8px 0;
}

.song-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
}

.song-row:hover {
  background: var(--td-bg-color-container-hover);
}

.song-row.keep {
  background: rgba(0, 168, 112, 0.05);
}

.song-index {
  width: 24px;
  text-align: center;
  color: var(--td-text-color-secondary);
  font-size: 12px;
}

.song-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song-info {
  color: var(--td-text-color-secondary);
  font-size: 12px;
}

.song-date {
  color: var(--td-text-color-placeholder);
  font-size: 11px;
  width: 140px;
  text-align: right;
}

/* 第10项：条目不换行 */
::deep(.t-table td) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

::deep(.t-table .title-text) {
  max-width: 300px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
}

/* 第12项：音乐库列位置调整 */
::deep(.t-table) {
  table-layout: fixed;
}

::deep(.t-table .col-key-album),
::deep(.t-table .col-key-artist) {
  padding-left: 20px;
}
</style>
