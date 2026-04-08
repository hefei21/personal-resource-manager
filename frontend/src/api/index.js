import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 30000
})

api.interceptors.request.use(
  (config) => {
    // 优先从 localStorage 获取，其次从 sessionStorage（游客模式）
    const token = localStorage.getItem('token') || sessionStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // 清除 localStorage 和 sessionStorage
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      sessionStorage.removeItem('token')
      sessionStorage.removeItem('user')
      window.location.href = '/login'
    } else if (error.response?.status === 403) {
      // 处理权限错误
      const errorCode = error.response?.data?.code
      if (errorCode === 'GUEST_NO_PERMISSION') {
        // 游客权限错误，显示友好提示
        console.warn('游客无权执行此操作')
      }
    }
    return Promise.reject(error)
  }
)

export default {
  auth: {
    login: (data) => api.post('/auth/login', data),
    guestLogin: () => api.post('/auth/guest-login'),
    logout: () => api.post('/auth/logout'),
    check: () => api.get('/auth/check'),
    changePassword: (data) => api.post('/auth/change-password', data)
  },
  documents: {
    list: (params) => api.get('/documents', { params }),
    categories: () => api.get('/documents/categories'),
    categoryTree: () => api.get('/documents/categories/tree'),
    createCategory: (data) => api.post('/documents/categories', data),
    updateCategory: (id, data) => api.put(`/documents/categories/${id}`, data),
    deleteCategory: (id, deleteFiles = false) => api.delete(`/documents/categories/${id}`, { params: { deleteFiles } }),
    reorderCategories: (data) => api.put('/documents/categories/reorder', data),
    checkDuplicate: (params) => api.get('/documents/check-duplicate', { params }),
    tags: () => api.get('/documents/tags'),
    getTags: () => api.get('/documents/tags'),
    create: (data) => api.post('/documents', data),
    update: (id, data) => api.put(`/documents/${id}`, data),
    batchUpdate: (data) => api.put('/documents/batch/update', data),
    delete: (id) => api.delete(`/documents/${id}`),
    upload: (formData) => api.post('/documents/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    }),
    versions: (id) => api.get(`/documents/${id}/versions`),
    getContent: (id) => {
      const token = localStorage.getItem('token') || sessionStorage.getItem('token')
      return api.get(`/documents/${id}/content`, { params: { token } })
    },
    updateContent: (id, data) => api.put(`/documents/${id}/content`, data),
    // 私密空间 API
    verifyPrivatePassword: (data) => api.post('/documents/private/verify-password', data),
    changePrivatePassword: (data) => api.post('/documents/private/change-password', data),
    listPrivate: (params) => api.get('/documents/private/list', { params }),
    uploadPrivate: (formData) => api.post('/documents/private/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    }),
    deletePrivate: (id) => api.delete(`/documents/private/${id}`),
    getPrivateContent: (id) => {
      const token = localStorage.getItem('token') || sessionStorage.getItem('token')
      return api.get(`/documents/private/${id}/content`, { params: { token } })
    }
  },
  music: {
    list: (params) => api.get('/music', { params }),
    getAllIds: (params) => api.get('/music/all-ids', { params }),
    getCover: (id) => api.get(`/music/${id}/cover`),
    artists: () => api.get('/music/artists'),
    albums: () => api.get('/music/albums'),
    update: (id, data) => api.put(`/music/${id}`, data),
    delete: (id) => api.delete(`/music/${id}`),
    batchDelete: (data) => api.post('/music/batch-delete', data),
    // 去重
    getDuplicates: () => api.get('/music/duplicates'),
    removeDuplicates: () => api.post('/music/remove-duplicates'),
    // 上传相关
    checkDuplicate: (data) => api.post('/music/check-duplicate', data),
    // 分片上传
    uploadChunk: (formData) => api.post('/music/upload-chunk', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000
    }),
    mergeChunks: (data) => api.post('/music/merge-chunks', data),
    cancelUpload: (fileId) => api.delete('/music/cancel-upload', { data: { fileId } }),
    cancelAllUploads: () => api.delete('/music/cancel-all-uploads'),
    getUploadProgress: () => api.get('/music/upload-progress'),
    startUpload: (data) => api.post('/music/start-upload', data),
    getUploadStatus: (fileId) => api.get(`/music/upload-status/${fileId}`),
    // 歌单管理
    getPlaylists: () => api.get('/music/playlists'),
    createPlaylist: (data) => api.post('/music/playlists', data),
    updatePlaylist: (id, data) => api.put(`/music/playlists/${id}`, data),
    deletePlaylist: (id) => api.delete(`/music/playlists/${id}`),
    getPlaylistSongs: (id) => api.get(`/music/playlists/${id}/songs`),
    addSongsToPlaylist: (id, songIds) => api.post(`/music/playlists/${id}/songs`, { songIds }),
    removeSongFromPlaylist: (playlistId, songId) => api.delete(`/music/playlists/${playlistId}/songs/${songId}`),
    batchRemoveSongsFromPlaylist: (playlistId, songIds) => api.post(`/music/playlists/${playlistId}/songs/batch-remove`, { songIds }),
    reorderPlaylistSongs: (playlistId, songOrders) => api.put(`/music/playlists/${playlistId}/songs/reorder`, { songOrders }),
    // 歌词管理
    searchLyrics: (title, artist) => api.get('/music/lyrics/search', { params: { title, artist } }),
    downloadLyrics: (musicIds, force = false) => api.post('/music/lyrics/batch-download', { musicIds, force }),
    getLyricsTask: (taskId) => api.get(`/music/lyrics/task/${taskId}`),
    getLyrics: (id) => api.get(`/music/${id}/lyrics`),
    updateLyrics: (id, lyrics, source) => api.put(`/music/${id}/lyrics`, { lyrics, source }),
    cleanSampleLyrics: () => api.post('/music/clean-sample-lyrics')
  },
  books: {
    list: (params) => api.get('/ebooks', { params }),
    getCategories: () => api.get('/ebooks/categories'),
    createCategory: (data) => api.post('/ebooks/categories', data),
    updateCategory: (id, data) => api.put(`/ebooks/categories/${id}`, data),
    deleteCategory: (id) => api.delete(`/ebooks/categories/${id}`),
    reorderCategories: (data) => api.put('/ebooks/categories/reorder', data),
    // 解析书籍元数据
    parseMetadata: (formData) => api.post('/ebooks/parse-metadata', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000 // 60秒超时
    }),
    // 分片上传
    uploadChunk: (formData) => api.post('/ebooks/upload-chunk', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000
    }),
    mergeChunks: (data) => api.post('/ebooks/merge-chunks', data),
    cancelUpload: (fileId) => api.delete('/ebooks/cancel-upload', { data: { fileId } }),
    upload: (formData, onUploadProgress) => api.post('/ebooks/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 300000, // 5分钟超时，支持大文件
      onUploadProgress: onUploadProgress
    }),
    uploadWithPath: (data) => api.post('/ebooks/upload-with-path', data),
    update: (id, data) => api.put(`/ebooks/${id}`, data),
    delete: (id) => api.delete(`/ebooks/${id}`),
    batchDelete: (data) => api.post('/ebooks/batch-delete', data),
    getContent: (id) => {
      const token = localStorage.getItem('token') || sessionStorage.getItem('token')
      return api.get(`/ebooks/${id}/content`, { params: { token } })
    },
    getProgress: (id) => api.get(`/ebooks/${id}/progress`),
    saveProgress: (id, data) => api.post(`/ebooks/${id}/progress`, data),
    clearCache: (id) => api.delete(`/ebooks/${id}/cache`)
  },
  code: {
    list: (params) => api.get('/code', { params }),
    create: (data) => api.post('/code', data),
    update: (id, data) => api.put(`/code/${id}`, data),
    delete: (id) => api.delete(`/code/${id}`),
    get: (id) => api.get(`/code/${id}`),
    getTree: (id, path) => api.get(`/code/${id}/tree`, { params: { path } }),
    getFile: (id, path) => api.get(`/code/${id}/file`, { params: { path } }),
    getReadme: (id) => api.get(`/code/${id}/readme`),
    getCommits: (id, limit) => api.get(`/code/${id}/commits`, { params: { limit } }),
    getCommitDetail: (id, hash) => api.get(`/code/${id}/commit/${hash}`),
    sync: (id) => api.post(`/code/${id}/sync`),
    getSyncStatus: (id) => api.get(`/code/${id}/sync-status`),
    getCloneStatus: (id) => api.get(`/code/${id}/clone-status`),
    getGithubInfo: (url) => api.get('/code/github-info', { params: { url } })
  },
  bookmarks: {
    list: (params) => api.get('/bookmarks', { params }),
    create: (data) => api.post('/bookmarks', data),
    update: (id, data) => api.put(`/bookmarks/${id}`, data),
    delete: (id) => api.delete(`/bookmarks/${id}`),
    batchDelete: (data) => api.post('/bookmarks/batch-delete', data),
    fetchTitle: (url) => api.get('/bookmarks/fetch-title', { params: { url } }),
    getTags: () => api.get('/bookmarks/tags'),
    batchDownloadIcons: () => api.post('/bookmarks/batch-download-icons')
  },
  anime: {
    search: (keyword, tag, page = 1) => api.get('/anime/search', { params: { keyword, tag, page } }),
    import: (bangumiId, animeData) => api.post('/anime/import', { bangumiId, animeData }),
    list: (params) => api.get('/anime', { params }),
    get: (id) => api.get(`/anime/${id}`),
    getByBangumiId: (bangumiId) => api.get(`/anime/bangumi/${bangumiId}`),
    getCover: (id) => api.get(`/anime/${id}/cover`),
    getDetail: (bangumiId) => api.get(`/anime/detail/${bangumiId}`),
    getRelations: (bangumiId) => api.get(`/anime/relations/${bangumiId}`),
    update: (id, data) => api.put(`/anime/${id}`, data),
    delete: (id) => api.delete(`/anime/${id}`),
    toggleFavorite: (id) => api.post(`/anime/${id}/favorite`),
    updateStatus: (id, status) => api.post(`/anime/${id}/status`, { status }),
    updateRating: (id, rating) => api.post(`/anime/${id}/rating`, { rating }),
    refresh: (id) => api.post(`/anime/${id}/refresh`),
    searchResources: (keyword, mode = 'parallel') => api.get('/anime/resources/search', { params: { keyword, mode } }),
    testResources: () => api.get('/anime/resources/test'),
    batchDownloadCovers: () => api.post('/anime/batch-download-covers'),
    getTokenStatus: () => api.get('/anime/token-status'),
    toggleHidden: (id) => api.put(`/anime/${id}/toggle-hidden`)
  },
  search: {
    global: (keyword) => api.get('/search', { params: { keyword } })
  },
  bookSearch: {
    getConfig: () => api.get('/book-search/config'),
    saveConfig: (data) => api.put('/book-search/config', data),
    testDomain: (domain) => api.get('/book-search/test-domain', { params: { domain } }),
    search: (keyword, source = 'all') => api.get('/book-search/search', { params: { keyword, source } })
  },
  games: {
    getSteamConfig: () => api.get('/games/steam/config'),
    saveSteamConfig: (data) => api.post('/games/steam/config', data),
    deleteSteamConfig: () => api.delete('/games/steam/config'),
    syncSteam: () => api.post('/games/steam/sync'), // 同步游戏列表（成就按需获取）
    fetchAchievements: (id) => api.post(`/games/${id}/fetch-achievements`, {}, { timeout: 60000 }), // 按需获取成就（延长超时）
    getSyncStatus: (taskId) => api.get(`/games/steam/sync/${taskId}`), // 查询同步状态
    list: (params) => api.get('/games', { params }),
    get: (id) => api.get(`/games/${id}`),
    getAchievements: (id) => api.get(`/games/${id}/achievements`),
    update: (id, data) => api.put(`/games/${id}`, data),
    delete: (id) => api.delete(`/games/${id}`),
    toggleFavorite: (id) => api.post(`/games/${id}/favorite`),
    updateStatus: (id, status) => api.post(`/games/${id}/status`, { status }),
    updateRating: (id, rating) => api.post(`/games/${id}/rating`, { rating }),
    batchDownloadCovers: () => api.post('/games/batch-download-covers', {}, { timeout: 300000 }),
    clearCovers: () => api.post('/games/clear-covers'),
    refreshCover: (id) => api.post(`/games/${id}/refresh-cover`),
    getStats: () => api.get('/games/stats')
  },
  todos: {
    list: (date) => api.get('/todos', { params: { date } }),
    listMonth: (startDate, endDate) => api.get('/todos/month', { params: { startDate, endDate } }),
    create: (data) => api.post('/todos', data),
    update: (id, data) => api.put(`/todos/${id}`, data),
    delete: (id) => api.delete(`/todos/${id}`)
  },
  blog: {
    // 文章
    getPosts: (params) => api.get('/blog/posts', { params }),
    getPost: (id) => api.get(`/blog/posts/${id}`),
    createPost: (data) => api.post('/blog/posts', data),
    updatePost: (id, data) => api.put(`/blog/posts/${id}`, data),
    deletePost: (id) => api.delete(`/blog/posts/${id}`),
    // 分类
    getCategories: () => api.get('/blog/categories'),
    getAllCategories: () => api.get('/blog/categories/all'),
    createCategory: (data) => api.post('/blog/categories', data),
    updateCategory: (id, data) => api.put(`/blog/categories/${id}`, data),
    deleteCategory: (id) => api.delete(`/blog/categories/${id}`),
    // 标签
    getTags: () => api.get('/blog/tags'),
    createTag: (data) => api.post('/blog/tags', data),
    updateTag: (id, data) => api.put(`/blog/tags/${id}`, data),
    deleteTag: (id) => api.delete(`/blog/tags/${id}`)
  },
  stats: {
    get: () => api.get('/stats')
  }
}
