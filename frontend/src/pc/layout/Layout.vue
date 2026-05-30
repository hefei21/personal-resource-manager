<template>
  <div class="layout-pc">
    <!-- 全局路由切换Loading -->
    <div v-if="routeLoading || initialLoading" class="global-loading-overlay">
      <div class="native-loading">
        <div class="spinner"></div>
      </div>
    </div>

    <!-- 固定侧边栏 -->
    <aside class="fixed-aside">
      <div class="logo">雨的空间</div>
      
      <!-- 原生菜单 -->
      <nav class="native-menu">
        <div 
          v-for="item in menuItems" 
          :key="item.value"
          class="menu-item"
          :class="{ active: activeMenu === item.value }"
          @click="handleMenuChange(item.value)"
        >
          <NativeIcon :name="item.icon" class="menu-icon" />
          <span class="menu-text">{{ item.label }}</span>
        </div>
        <div v-if="authStore.isAdmin()" class="menu-divider"></div>
        <div 
          v-if="authStore.isAdmin()"
          class="menu-item"
          :class="{ active: activeMenu === 'logs' }"
          @click="handleMenuChange('logs')"
        >
          <NativeIcon name="chart" class="menu-icon" />
          <span class="menu-text">访问日志</span>
        </div>
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

    <!-- 修改密码对话框 -->
    <div v-if="showPasswordDialog" class="pc-dialog-overlay" @click.self="closePasswordDialog">
      <div class="pc-dialog">
        <div class="pc-dialog-header">
          <h3>修改密码</h3>
          <button class="close-btn" @click="closePasswordDialog">&times;</button>
        </div>
        <div class="pc-dialog-body">
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
        <div class="pc-dialog-footer">
          <button class="btn-cancel" @click="closePasswordDialog">取消</button>
          <button 
            class="btn-confirm" 
            :disabled="passwordLoading"
            @click="handlePasswordChange"
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
let routeLoadingTimer = null

// 菜单配置
const menuItems = [
  { value: 'dashboard', label: '仪表盘', icon: 'dashboard' },
  { value: 'documents', label: '文档管理', icon: 'file' },
  { value: 'blog', label: '博客管理', icon: 'edit-1' },
  { value: 'music', label: '音乐管理', icon: 'music' },
  { value: 'books', label: '书籍管理', icon: 'book' },
  { value: 'code', label: '代码管理', icon: 'code' },
  { value: 'bookmarks', label: '书签管理', icon: 'bookmark' },
  { value: 'anime', label: '动漫管理', icon: 'video' },
  { value: 'games', label: '游戏管理', icon: 'gamepad' }
]

// 组件挂载后关闭初始loading
onMounted(() => {
  setTimeout(() => {
    initialLoading.value = false
  }, 500)
})

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

function handleMenuChange(value) {
  activeMenu.value = value
  router.push(`/${value}`)
}

function handleLogout() {
  authStore.logout()
  router.push('/login')
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

async function handlePasswordChange() {
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
.layout-pc {
  height: 100vh;
  width: 100%;
  overflow: hidden;
  background: #1a1a2e;
}

.fixed-aside {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  width: 240px;
  background: #1a1a2e;
  z-index: 100;
  animation: slideInLeft 0.5s ease-out;
  border-right: none !important;
  box-shadow: none !important;
  outline: none !important;
}

.fixed-header {
  position: fixed;
  top: 0;
  left: 240px;
  right: 0;
  height: 60px;
  background: white;
  border-bottom: 1px solid #e0e0e0;
  padding: 0 24px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
  z-index: 99;
  animation: slideInTop 0.5s ease-out;
}

.scrollable-content {
  margin-left: 240px;
  margin-top: 60px;
  height: calc(100vh - 60px);
  padding: 24px;
  overflow-y: auto;
  background: #f5f5f5;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 0, 0, 0.3) transparent;
}

.scrollable-content::-webkit-scrollbar {
  width: 8px;
}

.scrollable-content::-webkit-scrollbar-track {
  background: transparent;
}

.scrollable-content::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.3);
  border-radius: 4px;
}

@keyframes slideInLeft {
  from {
    opacity: 0;
    transform: translateX(-20px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes slideInTop {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.logo {
  padding: 0 20px;
  text-align: center;
  font-size: 26px;
  font-weight: bold;
  color: #e8d4b8;
  border-bottom: 1px solid rgba(232, 212, 184, 0.2);
  text-shadow: 0 0 10px rgba(232, 212, 184, 0.5), 0 2px 4px rgba(0, 0, 0, 0.5);
  background: linear-gradient(135deg, rgba(232, 212, 184, 0.1) 0%, rgba(232, 212, 184, 0.05) 100%);
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  letter-spacing: 4px;
  backdrop-filter: blur(10px);
}

/* 原生菜单样式 */
.native-menu {
  padding: 8px 0;
  background: transparent;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 6px 16px;
  padding: 12px 16px;
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  color: rgba(255, 255, 255, 0.75);
  font-size: 14px;
  font-weight: 500;
}

.menu-item:hover {
  background: rgba(255, 255, 255, 0.15);
  color: white;
  transform: translateX(8px);
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
}

.menu-item.active {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.25) 0%, rgba(255, 255, 255, 0.1) 100%);
  color: white;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.menu-item.active .menu-icon {
  color: #4ecdc4;
}

.menu-icon {
  flex-shrink: 0;
  font-size: 20px;
}

.menu-text {
  line-height: 1;
}

.menu-divider {
  height: 1px;
  margin: 8px 16px;
  background: rgba(255, 255, 255, 0.1);
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
  font-size: 24px;
  color: #333;
  font-weight: 600;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 16px;
}

.username-link,
.username-text {
  font-weight: 500;
  color: #667eea;
  padding: 4px 12px;
}

.username-link {
  cursor: pointer;
  transition: all 0.3s ease;
  border-radius: 4px;
}

.username-link:hover {
  color: #764ba2;
  background: rgba(102, 126, 234, 0.1);
  transform: translateY(-1px);
}

/* 退出按钮 */
.logout-btn {
  padding: 6px 16px;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
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

/* 全局路由loading覆盖层 */
.global-loading-overlay {
  position: fixed;
  top: 0;
  left: 240px;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.95);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  backdrop-filter: blur(4px);
}

/* 原生 Loading */
.native-loading {
  display: flex;
  align-items: center;
  justify-content: center;
}

.native-loading .spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #e0e0e0;
  border-top-color: #667eea;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* PC端原生对话框 */
.pc-dialog-overlay {
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
  animation: fadeIn 0.2s ease;
}

.pc-dialog {
  background: white;
  border-radius: 12px;
  width: 100%;
  max-width: 400px;
  overflow: hidden;
  animation: scaleIn 0.2s ease;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.pc-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid #eee;
}

.pc-dialog-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #333;
}

.pc-dialog-header .close-btn {
  background: none;
  border: none;
  font-size: 28px;
  color: #999;
  cursor: pointer;
  padding: 0;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: all 0.2s;
}

.pc-dialog-header .close-btn:hover {
  background: #f5f5f5;
  color: #666;
}

.pc-dialog-body {
  padding: 24px;
}

.pc-dialog-footer {
  display: flex;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid #eee;
}

.pc-dialog-footer .btn-cancel,
.pc-dialog-footer .btn-confirm {
  flex: 1;
  padding: 10px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.pc-dialog-footer .btn-cancel {
  background: #f5f5f5;
  color: #666;
}

.pc-dialog-footer .btn-cancel:hover {
  background: #e8e8e8;
}

.pc-dialog-footer .btn-confirm {
  background: #0052d9;
  color: white;
}

.pc-dialog-footer .btn-confirm:hover:not(:disabled) {
  background: #366ef4;
}

.pc-dialog-footer .btn-confirm:disabled {
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
  border-color: #0052d9;
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
