<template>
  <div class="layout-mobile">
    <!-- 全局路由切换Loading -->
    <div v-if="routeLoading || initialLoading" class="global-loading-overlay">
      <div class="native-loading">
        <div class="spinner"></div>
      </div>
    </div>

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

    <nav class="bottom-navigation" aria-label="主要导航">
      <button
        v-for="item in bottomItems"
        :key="item.value"
        type="button"
        class="bottom-navigation-item"
        :class="{ active: isBottomItemActive(item) }"
        :aria-current="isBottomItemActive(item) ? 'page' : undefined"
        @click="handleBottomNavigation(item)"
      >
        <svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor" aria-hidden="true">
          <path :d="item.mobileIconPath" />
        </svg>
        <span>{{ item.label }}</span>
      </button>
    </nav>

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
      @confirm="handleMobilePasswordChange"
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
import { ref, computed, onUnmounted, watch, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import MediaPlayer from '@/components/business/media-player/index.vue'
import { NativeDialog, NativeInput } from '@/components/native'
import api from '@/api'
import { useToast } from '@/composables/useToast'
import {
  MOBILE_BOTTOM_NAVIGATION,
  navigationForRoute,
  navigationItemsForGroup,
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

const bottomItems = MOBILE_BOTTOM_NAVIGATION
const activeNavigation = computed(() => navigationForRoute(route.name))
const rememberedRouteKey = group => `pr-manager:last-route:${group}`

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
      scrollContent.style.paddingBottom = '84px'
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
      scrollContent.style.paddingBottom = '84px'
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
      scrollContent.style.paddingBottom = (playerHeight + 84) + 'px'
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
      scrollContent.style.paddingBottom = '84px'
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

watch(activeNavigation, item => {
  if (!item || item.kind !== 'module' || !item.mobile || item.group === 'home') return
  try {
    localStorage.setItem(rememberedRouteKey(item.group), item.path)
  } catch {
    // 隐私模式或存储配额异常时只退化为分组入口，不影响导航。
  }
}, { immediate: true })

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

function isBottomItemActive(item) {
  if (!activeNavigation.value) return false
  if (item.group === 'home') return activeNavigation.value.group === 'home'
  return activeNavigation.value.group === item.group
}

function handleBottomNavigation(item) {
  if (item.group === 'home' || isBottomItemActive(item)) {
    router.push(item.path)
    return
  }

  const allowedPaths = new Set(
    navigationItemsForGroup(item.group, { mobile: true }).map(module => module.path)
  )
  let rememberedPath = null
  try {
    rememberedPath = localStorage.getItem(rememberedRouteKey(item.group))
  } catch {
    // 存储不可用时使用稳定的分组入口。
  }
  router.push(allowedPaths.has(rememberedPath) ? rememberedPath : item.path)
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

async function handleLogout() {
  await authStore.logout()
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
.layout-mobile {
  height: 100vh;
  width: 100%;
  overflow: hidden;
  background: #1a1a2e;
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
  padding: 0 16px;
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
  padding: 16px 16px calc(84px + var(--player-height, 0px));
  overflow-y: auto;
  background: #f5f5f5;
}

.bottom-navigation {
  position: fixed;
  z-index: 120;
  left: 0;
  right: 0;
  bottom: var(--player-height, 0px);
  height: 68px;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  padding: 5px max(4px, env(safe-area-inset-right)) max(5px, env(safe-area-inset-bottom)) max(4px, env(safe-area-inset-left));
  border-top: 1px solid #e2e8f0;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(16px);
  box-shadow: 0 -4px 16px rgba(15, 23, 42, 0.06);
}

.bottom-navigation-item {
  min-width: 0;
  min-height: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: #64748b;
  font-size: 11px;
  font-weight: 600;
}

.bottom-navigation-item.active {
  color: #4f46e5;
  background: #eef2ff;
}

.bottom-navigation-item:focus-visible {
  outline: 2px solid #818cf8;
  outline-offset: -2px;
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
