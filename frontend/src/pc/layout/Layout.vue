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
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true">雨</span>
        <span class="brand-copy">
          <small>PERSONAL ARCHIVE</small>
          <strong>雨的空间</strong>
        </span>
      </div>
      
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
            <span class="menu-group-copy">
              <NativeIcon :name="section.icon" size="15" weight="duotone" />
              {{ section.label }}
            </span>
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
            <span class="menu-icon-shell">
              <NativeIcon
                :name="item.pcIcon"
                :weight="activeNavigation?.routeName === item.routeName ? 'fill' : 'regular'"
                class="menu-icon"
                size="18"
              />
            </span>
            <span class="menu-text">{{ item.label }}</span>
            <span v-if="activeNavigation?.routeName === item.routeName" class="active-indicator" aria-hidden="true"></span>
          </button>
        </section>
      </nav>
    </aside>

    <!-- 固定 Header -->
    <header class="fixed-header">
      <div class="header-content">
        <div class="page-heading">
          <span>{{ activeGroupLabel }}</span>
          <h2>{{ pageTitle }}</h2>
        </div>
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
            <NativeIcon name="logout" size="16" />
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
import { NativeDialog, NativeIcon, NativeInput } from '@/components/native'
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
    icon: group.key === 'home' ? 'home' : navigationLandingForGroup(group.key)?.pcIcon ?? 'folder',
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
const activeGroupLabel = computed(() => NAVIGATION_GROUPS[activeNavigation.value?.group]?.label || '个人空间')

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
  background: var(--color-sidebar);
}

.fixed-aside {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  width: 256px;
  background: var(--color-sidebar);
  z-index: 100;
  animation: slideInLeft 0.5s ease-out;
  border-right: none !important;
  box-shadow: none !important;
  outline: none !important;
}

.fixed-header {
  position: fixed;
  top: 0;
  left: 256px;
  right: 0;
  height: 72px;
  background: color-mix(in srgb, var(--color-surface-raised) 94%, transparent);
  border-bottom: 1px solid var(--color-border-subtle);
  padding: 0 28px;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(14px);
  z-index: 99;
  animation: slideInTop 0.5s ease-out;
}

.scrollable-content {
  margin-left: 256px;
  margin-top: 72px;
  height: calc(100vh - 72px);
  padding: 28px;
  overflow-y: auto;
  background: var(--color-surface-subtle);
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

.brand-lockup {
  height: 72px;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 18px;
  border-bottom: 1px solid rgba(228, 233, 243, 0.09);
}

.brand-mark {
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  place-items: center;
  color: #f8fafc;
  border: 1px solid rgba(165, 180, 252, 0.45);
  border-radius: 11px;
  background: rgba(89, 103, 217, 0.24);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.12);
  font-size: 18px;
  font-weight: 700;
}

.brand-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.brand-copy small {
  color: var(--color-sidebar-text-muted);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.15em;
}

.brand-copy strong {
  color: var(--color-sidebar-text);
  font-size: 18px;
  font-weight: 650;
  letter-spacing: 0.04em;
}

/* 原生菜单样式 */
.native-menu {
  padding: 16px 12px 24px;
  background: transparent;
  height: calc(100vh - 72px);
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

.menu-group-copy {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.menu-group:hover,
.menu-group.active {
  color: #a5b4fc;
}

.menu-item {
  display: flex;
  align-items: center;
  position: relative;
  gap: 10px;
  width: 100%;
  margin: 2px 0;
  min-height: 42px;
  padding: 5px 10px 5px 7px;
  border: 0;
  border-radius: 10px;
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
  background: rgba(89, 103, 217, 0.22);
  color: white;
  box-shadow: inset 0 0 0 1px rgba(165, 180, 252, 0.12);
}

.menu-item.active .menu-icon-shell {
  color: #c7d2fe;
  background: rgba(199, 210, 254, 0.12);
}

.menu-icon-shell {
  display: grid;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  place-items: center;
  color: var(--color-sidebar-text-muted);
  border-radius: 8px;
  transition: color 0.16s ease, background-color 0.16s ease;
}

.menu-text {
  flex: 1;
  line-height: 1;
}

.active-indicator {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #5eead4;
  box-shadow: 0 0 0 3px rgba(94, 234, 212, 0.1);
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

.page-heading {
  display: grid;
  gap: 2px;
}

.page-heading > span {
  color: var(--color-text-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.header-content h2 {
  margin: 0;
  font-size: 21px;
  color: var(--color-text-primary);
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
  color: var(--color-primary);
  padding: 4px 12px;
}

.username-link {
  cursor: pointer;
  transition: all 0.3s ease;
  border-radius: 4px;
}

.username-link:hover {
  color: var(--color-primary-active);
  background: var(--color-primary-alpha-10);
}

/* 退出按钮 */
.logout-btn {
  padding: 6px 16px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.logout-btn:hover {
  box-shadow: var(--shadow-sm);
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.logout-btn:active {
  transform: translateY(0);
}

/* 全局路由loading覆盖层 */
.global-loading-overlay {
  position: fixed;
  top: 0;
  left: 256px;
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
  border-top-color: var(--color-primary);
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
  color: var(--color-text-primary);
  margin-bottom: 6px;
  font-weight: 500;
}

.form-error {
  color: var(--color-danger);
  font-size: 13px;
  margin-top: 8px;
  padding: 8px 12px;
  background: #fff2f0;
  border-radius: 4px;
}

</style>
