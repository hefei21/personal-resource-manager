<template>
  <div class="layout-mobile">
    <!-- 全局路由切换Loading -->
    <div v-if="routeLoading || initialLoading" class="global-loading-overlay">
      <div class="native-loading">
        <div class="spinner"></div>
      </div>
    </div>

    <!-- 移动端：遮罩层 -->
    <div 
      v-if="mobileMenuOpen" 
      class="mobile-overlay"
      @click="mobileMenuOpen = false"
    ></div>

    <!-- 移动端：汉堡菜单按钮 -->
    <button class="hamburger-btn" :class="{ 'sidebar-open': mobileMenuOpen }" @click="mobileMenuOpen = !mobileMenuOpen" v-if="!mobileMenuOpen">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
        <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
      </svg>
    </button>

    <!-- 固定侧边栏 -->
    <aside class="fixed-aside" :class="{ 'mobile-open': mobileMenuOpen }">
      <!-- 移动端侧边栏头部 -->
      <div class="mobile-sidebar-header">
        <span class="mobile-logo">雨的空间</span>
      </div>
      
      <!-- 移动端：原生菜单 -->
      <nav class="mobile-native-menu">
        <div 
          v-for="item in menuItems" 
          :key="item.value"
          class="mobile-menu-item"
          :class="{ active: activeMenu === item.value }"
          @click="handleMobileMenuClick(item.value)"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" class="menu-icon">
            <path :d="item.iconPath" />
          </svg>
          <span class="menu-text">{{ item.label }}</span>
        </div>
        <!-- 访问日志在移动端已移除 -->
      </nav>
    </aside>

    <!-- 固定 Header -->
    <header class="fixed-header">
      <div class="header-content">
        <h2>{{ pageTitle }}</h2>
        <div class="user-info">
          <span 
            v-if="!authStore.isGuest()" 
            class="username-link" 
            @click="showPasswordDialog = true"
            title="修改密码"
          >
            {{ authStore.user?.username || '用户' }}
          </span>
          <span v-else class="username-text">
            {{ authStore.user?.username || '用户' }}
          </span>
          <button class="logout-btn" @click="handleLogout">
            退出
          </button>
        </div>
      </div>
    </header>

    <!-- 可滚动的内容区域 -->
    <main class="scrollable-content">
      <router-view />
    </main>

    <!-- 音乐播放器 -->
    <MediaPlayer />
    
    <!-- 移动端：原生对话框 -->
    <div v-if="showPasswordDialog" class="mobile-dialog-overlay" @click.self="closePasswordDialog">
      <div class="mobile-dialog">
        <div class="mobile-dialog-header">
          <h3>修改密码</h3>
          <button class="close-btn" @click="closePasswordDialog">&times;</button>
        </div>
        <div class="mobile-dialog-body">
          <div class="form-item">
            <label>旧密码</label>
            <input 
              v-model="passwordForm.oldPassword"
              type="password"
              placeholder="请输入旧密码"
              class="form-input"
            />
          </div>
          <div class="form-item">
            <label>新密码</label>
            <input 
              v-model="passwordForm.newPassword"
              type="password"
              placeholder="请输入新密码"
              class="form-input"
            />
          </div>
          <div class="form-item">
            <label>确认密码</label>
            <input 
              v-model="passwordForm.confirmPassword"
              type="password"
              placeholder="请再次输入新密码"
              class="form-input"
            />
          </div>
          <div v-if="passwordError" class="form-error">{{ passwordError }}</div>
        </div>
        <div class="mobile-dialog-footer">
          <button class="btn-cancel" @click="closePasswordDialog">取消</button>
          <button 
            class="btn-confirm" 
            :disabled="passwordLoading"
            @click="handleMobilePasswordChange"
          >
            {{ passwordLoading ? '修改中...' : '确认修改' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted, watch, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import MediaPlayer from '@/components/business/media-player/index.vue'
import api from '@/api'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()

const activeMenu = ref(route.name?.toLowerCase())
const routeLoading = ref(false)
const initialLoading = ref(true)
const mobileMenuOpen = ref(false)
let routeLoadingTimer = null

// 移动端菜单配置（原生实现，替代 t-menu）
const menuItems = [
  { value: 'dashboard', label: '仪表盘', iconPath: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z' },
  { value: 'documents', label: '文档管理', iconPath: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z' },
  { value: 'blog', label: '博客管理', iconPath: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z' },
  { value: 'music', label: '音乐管理', iconPath: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z' },
  { value: 'books', label: '书籍管理', iconPath: 'M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z' },
  { value: 'code', label: '代码管理', iconPath: 'M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z' },
  { value: 'bookmarks', label: '书签管理', iconPath: 'M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z' },
  { value: 'anime', label: '动漫管理', iconPath: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z' },
  { value: 'games', label: '游戏管理', iconPath: 'M15 7.5V2H9v5.5l3 3 3-3zM7.5 9H2v6h5.5l3-3-3-3zM9 16.5V22h6v-5.5l-3-3-3 3zM16.5 9l-3 3 3 3H22V9h-5.5z' }
]

// 组件挂载后关闭初始loading
onMounted(() => {
  setTimeout(() => {
    initialLoading.value = false
  }, 500)
  
  // 移动端：监听播放器高度变化
  adjustForPlayer()
  observePlayer()
  
  // 监听播放器出现事件
  window.addEventListener('player-appeared', () => {
    setTimeout(() => adjustForPlayer(), 100)
    setTimeout(() => adjustForPlayer(), 500)
  })
  
  // 监听播放器最小化事件
  window.addEventListener('player-minimized', () => {
    document.documentElement.style.setProperty('--player-height', '0px')
    document.body.style.paddingBottom = '20px'
    const mainContent = document.querySelector('.main-content')
    if (mainContent) {
      mainContent.style.paddingBottom = '20px'
    }
    const scrollContent = document.querySelector('.scrollable-content')
    if (scrollContent) {
      scrollContent.style.paddingBottom = '20px'
    }
  })
  
  // 监听播放器恢复事件
  window.addEventListener('player-restored', () => {
    setTimeout(() => adjustForPlayer(), 300)
  })
  
  // 监听播放器关闭事件
  window.addEventListener('player-closed', () => {
    document.documentElement.style.setProperty('--player-height', '0px')
    document.body.style.paddingBottom = '20px'
    const mainContent = document.querySelector('.main-content')
    if (mainContent) {
      mainContent.style.paddingBottom = '20px'
    }
    const scrollContent = document.querySelector('.scrollable-content')
    if (scrollContent) {
      scrollContent.style.paddingBottom = '20px'
    }
  })
})

// 播放器高度适配
const adjustForPlayer = () => {
  let mediaPlayer = document.querySelector('.media-player') || 
                    document.querySelector('[class*="media-player"]')
  
  if (mediaPlayer && mediaPlayer.offsetHeight > 0 && window.getComputedStyle(mediaPlayer).display !== 'none') {
    const playerHeight = mediaPlayer.offsetHeight
    document.documentElement.style.setProperty('--player-height', playerHeight + 'px')
    document.body.style.paddingBottom = playerHeight + 'px'
    const mainContent = document.querySelector('.main-content')
    if (mainContent) {
      mainContent.style.paddingBottom = playerHeight + 'px'
    }
    const scrollContent = document.querySelector('.scrollable-content')
    if (scrollContent) {
      scrollContent.style.paddingBottom = (playerHeight + 20) + 'px'
    }
    return playerHeight
  } else {
    document.documentElement.style.setProperty('--player-height', '0px')
    document.body.style.paddingBottom = '20px'
    const mainContent = document.querySelector('.main-content')
    if (mainContent) {
      mainContent.style.paddingBottom = '20px'
    }
    const scrollContent = document.querySelector('.scrollable-content')
    if (scrollContent) {
      scrollContent.style.paddingBottom = '20px'
    }
    return 0
  }
}

// 监听播放器变化
let playerObserver = null
const observePlayer = () => {
  let checkCount = 0
  const checkInterval = setInterval(() => {
    checkCount++
    const player = document.querySelector('.media-player')
    if (player) {
      clearInterval(checkInterval)
      
      if (!playerObserver) {
        playerObserver = new MutationObserver(() => {
          adjustForPlayer()
        })
        playerObserver.observe(player, { 
          attributes: true, 
          attributeFilter: ['class', 'style'],
          childList: true,
          subtree: true
        })
      }
      
      adjustForPlayer()
      setTimeout(adjustForPlayer, 500)
      setTimeout(adjustForPlayer, 1000)
    }
    
    if (checkCount > 30) {
      clearInterval(checkInterval)
    }
  }, 200)
}

// 监听路由变化，同步侧边栏状态
watch(() => route.name, (newName) => {
  if (newName) {
    activeMenu.value = newName.toLowerCase()
  }
})

// 路由切换前延迟显示全局loading
const beforeRouteChange = router.beforeEach((_to, _from, next) => {
  routeLoadingTimer = setTimeout(() => {
    routeLoading.value = true
  }, 300)
  next()
})

// 路由切换后隐藏全局loading
const afterRouteChange = router.afterEach(() => {
  if (routeLoadingTimer) {
    clearTimeout(routeLoadingTimer)
    routeLoadingTimer = null
  }
  setTimeout(() => {
    routeLoading.value = false
  }, 100)
})

onUnmounted(() => {
  beforeRouteChange()
  afterRouteChange()
  if (routeLoadingTimer) {
    clearTimeout(routeLoadingTimer)
  }
})

// 移动端菜单点击处理
function handleMobileMenuClick(value) {
  activeMenu.value = value
  router.push(`/${value}`)
  mobileMenuOpen.value = false
}

// 修改密码相关
const showPasswordDialog = ref(false)
const passwordLoading = ref(false)
const passwordForm = ref({
  oldPassword: '',
  newPassword: '',
  confirmPassword: ''
})
const passwordError = ref('')

const pageTitle = computed(() => {
  const titles = {
    Dashboard: '仪表盘',
    Documents: '文档管理',
    Music: '音乐管理',
    Books: '书籍管理',
    Code: '代码管理',
    Bookmarks: '书签管理',
    Anime: '动漫管理',
    Games: '游戏管理',
    Blog: '博客管理',
    Logs: '访问日志'
  }
  return titles[route.name] || '雨的空间'
})

function handleLogout() {
  authStore.logout()
  router.push('/login')
}

function resetPasswordForm() {
  passwordForm.value = {
    oldPassword: '',
    newPassword: '',
    confirmPassword: ''
  }
  passwordError.value = ''
}

function closePasswordDialog() {
  showPasswordDialog.value = false
  resetPasswordForm()
}

// 移动端密码修改处理（原生表单验证）
async function handleMobilePasswordChange() {
  passwordError.value = ''
  
  if (!passwordForm.value.oldPassword) {
    passwordError.value = '请输入旧密码'
    return
  }
  if (!passwordForm.value.newPassword) {
    passwordError.value = '请输入新密码'
    return
  }
  if (passwordForm.value.newPassword.length < 6) {
    passwordError.value = '密码长度至少6位'
    return
  }
  if (passwordForm.value.newPassword !== passwordForm.value.confirmPassword) {
    passwordError.value = '两次输入的密码不一致'
    return
  }
  
  passwordLoading.value = true
  try {
    const response = await api.auth.changePassword({
      oldPassword: passwordForm.value.oldPassword,
      newPassword: passwordForm.value.newPassword
    })

    if (response.data.message) {
      toast.success('密码修改成功，请重新登录')
      closePasswordDialog()
      setTimeout(() => {
        handleLogout()
      }, 1500)
    }
  } catch (error) {
    passwordError.value = error.response?.data?.message || '修改密码失败'
  } finally {
    passwordLoading.value = false
  }
}
</script>

<style scoped>
.layout-mobile {
  height: 100vh;
  width: 100%;
  overflow: hidden;
  background: #1a1a2e;
}

/* 遮罩层 */
.mobile-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 99;
  backdrop-filter: blur(2px);
}

/* 汉堡菜单按钮 */
.hamburger-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  position: fixed;
  top: 10px;
  left: 12px;
  width: 36px;
  height: 36px;
  background: rgba(102, 126, 234, 0.1);
  border: none;
  border-radius: 8px;
  color: #667eea;
  z-index: 101;
  cursor: pointer;
  transition: all 0.3s ease;
}

.hamburger-btn:active {
  background: rgba(102, 126, 234, 0.2);
}

.fixed-aside {
  position: fixed;
  left: -160px;
  top: 0;
  bottom: 0;
  width: 160px;
  background: #1a1a2e;
  z-index: 100;
  transition: left 0.3s ease;
  box-shadow: none !important;
  border: none !important;
  outline: none !important;
  overflow: hidden;
}

.fixed-aside.mobile-open {
  left: 0;
}

.mobile-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 8px;
  height: 60px;
  border-bottom: 1px solid rgba(232, 212, 184, 0.15);
  background: linear-gradient(135deg, rgba(232, 212, 184, 0.08) 0%, rgba(232, 212, 184, 0.04) 100%);
}

.mobile-logo {
  font-size: 16px;
  font-weight: 600;
  color: #e8d4b8;
  text-shadow: 0 0 8px rgba(232, 212, 184, 0.4);
}

/* 移动端原生菜单 */
.mobile-native-menu {
  padding: 8px 0;
  background: transparent;
}

.mobile-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 4px 8px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.3s ease;
  color: rgba(255, 255, 255, 0.75);
  font-size: 13px;
  font-weight: 500;
}

.mobile-menu-item:hover,
.mobile-menu-item.active {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.25) 0%, rgba(255, 255, 255, 0.1) 100%);
  color: white;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
}

.mobile-menu-item.active {
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.mobile-menu-item.active .menu-icon {
  color: #4ecdc4;
}

.menu-icon {
  flex-shrink: 0;
  opacity: 0.9;
}

.menu-text {
  line-height: 1;
}

.menu-divider {
  height: 1px;
  margin: 8px 12px;
  background: rgba(255, 255, 255, 0.1);
}

/* Header */
.fixed-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 60px;
  background: white;
  border-bottom: 1px solid #e0e0e0;
  padding: 0 16px 0 56px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
  z-index: 99;
}

.header-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 100%;
  width: 100%;
}

.header-content h2 {
  margin: 0;
  font-size: 16px;
  color: #333;
  font-weight: 600;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.username-link,
.username-text {
  font-size: 13px;
  font-weight: 500;
  color: #667eea;
  padding: 4px 8px;
}

.username-link {
  cursor: pointer;
  transition: all 0.3s ease;
  border-radius: 4px;
}

.username-link:hover {
  color: #764ba2;
  background: rgba(102, 126, 234, 0.1);
}

/* 退出按钮 */
.logout-btn {
  padding: 6px 12px;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  background: white;
  color: #666;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.logout-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
  border-color: #667eea;
  color: #667eea;
}

.logout-btn:active {
  transform: translateY(0);
}

/* 内容区 */
.scrollable-content {
  margin-left: 0;
  margin-top: 60px;
  height: calc(100vh - 60px);
  padding: 16px;
  overflow-y: auto;
  background: #f5f5f5;
}

/* 全局loading覆盖层 */
.global-loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.95);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  backdrop-filter: blur(4px);
}

/* 移动端原生 Loading */
.native-loading {
  display: flex;
  align-items: center;
  justify-content: center;
}

.native-loading .spinner {
  width: 24px;
  height: 24px;
  border: 2px solid #e0e0e0;
  border-top-color: #667eea;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 移动端原生对话框 */
.mobile-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: 20px;
  animation: fadeIn 0.2s ease;
}

.mobile-dialog {
  background: white;
  border-radius: 12px;
  width: 100%;
  max-width: 320px;
  max-height: 80vh;
  overflow: hidden;
  animation: scaleIn 0.2s ease;
}

.mobile-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid #eee;
}

.mobile-dialog-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #333;
}

.mobile-dialog-header .close-btn {
  background: none;
  border: none;
  font-size: 24px;
  color: #999;
  cursor: pointer;
  padding: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.2s;
}

.mobile-dialog-header .close-btn:hover {
  background: #f5f5f5;
  color: #666;
}

.mobile-dialog-body {
  padding: 16px;
  max-height: 50vh;
  overflow-y: auto;
}

.mobile-dialog-footer {
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  border-top: 1px solid #eee;
}

.mobile-dialog-footer .btn-cancel,
.mobile-dialog-footer .btn-confirm {
  flex: 1;
  padding: 10px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.mobile-dialog-footer .btn-cancel {
  background: #f5f5f5;
  color: #666;
}

.mobile-dialog-footer .btn-cancel:hover {
  background: #e8e8e8;
}

.mobile-dialog-footer .btn-confirm {
  background: #667eea;
  color: white;
}

.mobile-dialog-footer .btn-confirm:hover:not(:disabled) {
  background: #5a6fd6;
}

.mobile-dialog-footer .btn-confirm:disabled {
  background: #ccc;
  cursor: not-allowed;
}

.form-item {
  margin-bottom: 16px;
}

.form-item label {
  display: block;
  font-size: 14px;
  color: #333;
  margin-bottom: 6px;
  font-weight: 500;
}

.form-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
  box-sizing: border-box;
  transition: border-color 0.2s;
}

.form-input:focus {
  outline: none;
  border-color: #667eea;
}

.form-error {
  color: #e34d59;
  font-size: 13px;
  margin-top: 8px;
  padding: 8px 12px;
  background: #fff2f0;
  border-radius: 4px;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes scaleIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
</style>