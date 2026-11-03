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
        <div class="mobile-page-heading">
          <button
            v-if="parentNavigation"
            type="button"
            class="group-back-button"
            :aria-label="`返回${parentNavigation.label}`"
            @click="navigateToGroupLanding"
          >
            <NativeIcon name="arrow-left" size="20" />
          </button>
          <div class="mobile-title-copy">
            <span v-if="parentNavigation">{{ parentNavigation.label }}</span>
            <h2>{{ pageTitle }}</h2>
          </div>
        </div>
        <div class="user-info">
          <span class="username-text" :title="authStore.user?.username || '用户'">
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
      <WorkspaceRouteView />
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
    
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted, watch, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import MediaPlayer from '@/components/business/media-player/index.vue'
import WorkspaceRouteView from '@/components/WorkspaceRouteView.vue'
import { NativeIcon } from '@/components/native'
import {
  MOBILE_BOTTOM_NAVIGATION,
  mobileGroupParentForRoute,
  navigationForRoute,
  navigationItemsForGroup,
  pageTitleForRoute
} from '@/router/navigation'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()

const routeLoading = ref(false)
const initialLoading = ref(true)
let routeLoadingTimer = null

const bottomItems = MOBILE_BOTTOM_NAVIGATION
const activeNavigation = computed(() => navigationForRoute(route.name))
const parentNavigation = computed(() => mobileGroupParentForRoute(route.name) ?? null)
const rememberedRouteKey = group => `pr-manager:last-route:${group}`

// 组件挂载后关闭初始loading
onMounted(() => {
  setTimeout(() => {
    initialLoading.value = false
  }, 500)
  
})

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

function navigateToGroupLanding() {
  if (parentNavigation.value) router.push(parentNavigation.value.path)
}

const pageTitle = computed(() => pageTitleForRoute(route.name) || '雨的空间')

async function handleLogout() {
  await authStore.logout()
  router.push('/login')
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
  background: color-mix(in srgb, var(--color-surface-raised) 96%, transparent);
  border-bottom: 1px solid var(--color-border-subtle);
  padding: 0 16px;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(12px);
  z-index: 99;
}

.header-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 100%;
  width: 100%;
}

.mobile-page-heading {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
}

.group-back-button {
  display: grid;
  width: var(--control-height-touch);
  height: var(--control-height-touch);
  flex: 0 0 auto;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: var(--radius-md);
  color: var(--color-primary);
  background: var(--color-primary-surface);
  cursor: pointer;
}

.group-back-button:focus-visible {
  outline: 1px solid var(--color-border-strong);
  outline-offset: 1px;
}

.mobile-title-copy {
  min-width: 0;
  display: grid;
  gap: 1px;
}

.mobile-title-copy > span {
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.header-content h2 {
  margin: 0;
  font-size: 18px;
  color: var(--color-text-primary);
  font-weight: 600;
}

.user-info {
  display: flex;
  min-width: 0;
  max-width: 45%;
  align-items: center;
  gap: 8px;
}

.username-text {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-primary);
  padding: 4px 8px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 退出按钮 */
.logout-btn {
  flex-shrink: 0;
  min-width: var(--control-height-touch);
  min-height: var(--control-height-touch);
  padding: 6px 12px;
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
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

/* 内容区 */
.scrollable-content {
  margin-left: 0;
  margin-top: 60px;
  height: calc(100vh - 60px);
  padding: 16px 16px calc(84px + var(--player-height, 0px));
  overflow-y: auto;
  background: var(--color-surface-subtle);
}

.bottom-navigation {
  position: fixed;
  z-index: 120;
  left: 0;
  right: 0;
  bottom: 0;
  height: calc(68px + env(safe-area-inset-bottom, 0px));
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  padding: 5px max(4px, env(safe-area-inset-right)) max(5px, env(safe-area-inset-bottom)) max(4px, env(safe-area-inset-left));
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-surface-raised);
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
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bottom-navigation-item.active {
  color: var(--color-primary);
  background: var(--color-primary-surface);
}

.bottom-navigation-item:focus-visible {
  outline: 1px solid var(--color-border-strong);
  outline-offset: -1px;
}

@media (hover: none) and (pointer: coarse) {
  .logout-btn:hover { border-color: var(--color-border-default); color: var(--color-text-secondary); box-shadow: none; }
}

/* 全局loading覆盖层 */
.global-loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--color-surface-raised);
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
  border: 2px solid var(--color-border-default);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

</style>
