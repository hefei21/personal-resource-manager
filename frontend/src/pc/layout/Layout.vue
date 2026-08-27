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
        <section v-for="section in menuSections" :key="section.group" class="menu-section">
          <button
            v-if="section.landing"
            type="button"
            class="menu-group"
            :class="{ active: activeNavigation?.group === section.group }"
            @click="navigateTo(section.landing)"
          >
            <span>{{ section.label }}</span>
            <NativeIcon name="chevron-right" size="14" />
          </button>
          <span v-else class="menu-group-label">{{ section.label }}</span>
          <button
            v-for="item in section.items"
            :key="item.value"
            type="button"
            class="menu-item"
            :class="{ active: activeNavigation?.routeName === item.routeName }"
            @click="navigateTo(item)"
          >
            <NativeIcon :name="item.pcIcon" class="menu-icon" />
            <span class="menu-text">{{ item.label }}</span>
          </button>
        </section>
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

    <NativeDialog
      v-model="showPasswordDialog"
      title="修改密码"
      width="400px"
      confirm-text="确认修改"
      :confirm-loading="passwordLoading"
      :confirm-disabled="passwordLoading"
      :close-on-overlay-click="!passwordLoading"
      :close-on-esc="!passwordLoading"
      @confirm="handlePasswordChange"
      @closed="resetPasswordForm"
    >
      <div class="form-item">
        <label>旧密码</label>
        <NativeInput v-model="passwordForm.oldPassword" type="password" placeholder="请输入旧密码" />
      </div>
      <div class="form-item">
        <label>新密码</label>
        <NativeInput v-model="passwordForm.newPassword" type="password" placeholder="请输入新密码" />
      </div>
      <div class="form-item">
        <label>确认密码</label>
        <NativeInput v-model="passwordForm.confirmPassword" type="password" placeholder="请再次输入新密码" />
      </div>
      <div v-if="passwordError" class="form-error" role="alert">{{ passwordError }}</div>
    </NativeDialog>
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import MediaPlayer from '@/components/business/media-player/index.vue'
import { NativeDialog, NativeInput } from '@/components/native'
import api from '@/api'
import { useToast } from '@/composables/useToast'
import {
  NAVIGATION_GROUPS,
  navigationForRoute,
  navigationItemsForGroup,
  navigationLandingForGroup,
  pageTitleForRoute
} from '@/router/navigation'
import { validateOwnerPasswordChange } from '@/utils/passwordPolicy'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const toast = useToast()

const routeLoading = ref(false)
const initialLoading = ref(true)
let routeLoadingTimer = null

const activeNavigation = computed(() => navigationForRoute(route.name))
const menuSections = computed(() => Object.values(NAVIGATION_GROUPS)
  .sort((a, b) => a.order - b.order)
  .map(group => ({
    group: group.key,
    label: group.label,
    landing: group.key === 'home' ? null : navigationLandingForGroup(group.key),
    items: navigationItemsForGroup(group.key, { includeOwner: authStore.isAdmin() })
  })))

// 组件挂载后关闭初始loading
onMounted(() => {
  setTimeout(() => {
    initialLoading.value = false
  }, 500)
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

function navigateTo(item) {
  if (!item) return
  router.push(item.path)
}

async function handleLogout() {
  await authStore.logout()
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

const pageTitle = computed(() => pageTitleForRoute(route.name) || '雨的空间')

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
  const passwordPolicyError = validateOwnerPasswordChange(
    passwordForm.value.oldPassword,
    passwordForm.value.newPassword
  )
  if (passwordPolicyError) {
    passwordError.value = passwordPolicyError
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
  padding: 14px 12px 24px;
  background: transparent;
  height: calc(100vh - 60px);
  overflow-y: auto;
}

.menu-section + .menu-section {
  margin-top: 14px;
}

.menu-group,
.menu-group-label {
  width: 100%;
  min-height: 28px;
  padding: 4px 10px;
  color: rgba(226, 232, 240, 0.55);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-align: left;
}

.menu-group {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.menu-group:hover,
.menu-group.active {
  color: #a5b4fc;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin: 2px 0;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;
  color: rgba(255, 255, 255, 0.75);
  font-size: 14px;
  font-weight: 500;
}

.menu-item:hover {
  background: rgba(148, 163, 184, 0.12);
  color: white;
}

.menu-item.active {
  background: rgba(99, 102, 241, 0.2);
  color: white;
  box-shadow: inset 2px 0 #818cf8;
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

.form-error {
  color: #e34d59;
  font-size: 13px;
  margin-top: 8px;
  padding: 8px 12px;
  background: #fff2f0;
  border-radius: 4px;
}

</style>
