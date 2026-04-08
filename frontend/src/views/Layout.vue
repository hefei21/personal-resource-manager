<template>
  <div class="layout-container">
    <!-- 全局路由切换Loading -->
    <div v-if="routeLoading || initialLoading" class="global-loading-overlay">
      <t-loading size="small" />
    </div>

    <!-- 固定侧边栏 -->
    <aside class="fixed-aside">
      <div class="logo">雨的空间</div>
      <t-menu
        v-model:value="activeMenu"
        theme="dark"
        class="menu"
        @change="handleMenuChange"
      >
        <t-menu-item value="dashboard">
          <template #icon>
            <t-icon name="dashboard" />
          </template>
          仪表盘
        </t-menu-item>
        <t-menu-item value="documents">
          <template #icon>
            <t-icon name="file" />
          </template>
          文档管理
        </t-menu-item>
        <t-menu-item value="blog">
          <template #icon>
            <t-icon name="edit-1" />
          </template>
          博客管理
        </t-menu-item>
        <t-menu-item value="music">
          <template #icon>
            <t-icon name="music" />
          </template>
          音乐管理
        </t-menu-item>
        <t-menu-item value="books">
          <template #icon>
            <t-icon name="book" />
          </template>
          书籍管理
        </t-menu-item>
        <t-menu-item value="code">
          <template #icon>
            <t-icon name="code" />
          </template>
          代码管理
        </t-menu-item>
        <t-menu-item value="bookmarks">
          <template #icon>
            <t-icon name="bookmark" />
          </template>
          书签管理
        </t-menu-item>
        <t-menu-item value="anime">
          <template #icon>
            <t-icon name="video" />
          </template>
          动漫管理
        </t-menu-item>
        <t-menu-item value="games">
          <template #icon>
            <t-icon name="gamepad" />
          </template>
          游戏管理
        </t-menu-item>
      </t-menu>
    </aside>

    <!-- 固定 Header -->
    <header class="fixed-header">
      <div class="header-content">
        <h2>{{ pageTitle }}</h2>
        <div class="user-info">
          <t-tooltip v-if="!authStore.isGuest()" content="修改密码" placement="bottom">
            <span class="username-link" @click="showPasswordDialog = true">
              {{ authStore.user?.username || '用户' }}
            </span>
          </t-tooltip>
          <span v-else class="username-text">
            {{ authStore.user?.username || '用户' }}
          </span>
          <t-button theme="default" size="small" @click="handleLogout">
            退出
          </t-button>
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
    <t-dialog
      v-model:visible="showPasswordDialog"
      header="修改密码"
      :confirm-btn="{ content: '确认修改', loading: passwordLoading }"
      @confirm="handlePasswordChange"
      @close="resetPasswordForm"
    >
      <t-form :data="passwordForm" :rules="passwordRules" ref="passwordFormRef">
        <t-form-item label="旧密码" name="oldPassword">
          <t-input
            v-model="passwordForm.oldPassword"
            type="password"
            placeholder="请输入旧密码"
            clearable
          />
        </t-form-item>
        <t-form-item label="新密码" name="newPassword">
          <t-input
            v-model="passwordForm.newPassword"
            type="password"
            placeholder="请输入新密码"
            clearable
          />
        </t-form-item>
        <t-form-item label="确认密码" name="confirmPassword">
          <t-input
            v-model="passwordForm.confirmPassword"
            type="password"
            placeholder="请再次输入新密码"
            clearable
          />
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted, watch, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { MessagePlugin } from 'tdesign-vue-next'
import MediaPlayer from '@/components/MediaPlayer.vue'
import api from '@/api'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()

const activeMenu = ref(route.name?.toLowerCase())
const routeLoading = ref(false)
const initialLoading = ref(true)  // 首次加载loading
let routeLoadingTimer = null

// 组件挂载后关闭初始loading（等待路由组件渲染完成）
onMounted(() => {
  // 延长等待时间，确保路由组件内容已渲染
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

// 路由切换前延迟显示全局loading，让播放栏动画先执行
const beforeRouteChange = router.beforeEach((_to, _from, next) => {
  // 延迟300ms显示全局loading，给播放栏动画留出时间
  routeLoadingTimer = setTimeout(() => {
    routeLoading.value = true
  }, 300)
  next()
})

// 路由切换后隐藏全局loading
const afterRouteChange = router.afterEach(() => {
  // 清除未完成的定时器
  if (routeLoadingTimer) {
    clearTimeout(routeLoadingTimer)
    routeLoadingTimer = null
  }
  // 延迟一点关闭，确保页面已经开始渲染
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

// 修改密码相关
const showPasswordDialog = ref(false)
const passwordLoading = ref(false)
const passwordFormRef = ref(null)
const passwordForm = ref({
  oldPassword: '',
  newPassword: '',
  confirmPassword: ''
})

const passwordRules = {
  oldPassword: [{ required: true, message: '请输入旧密码', trigger: 'blur' }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少6位', trigger: 'blur' }
  ],
  confirmPassword: [
    { required: true, message: '请确认新密码', trigger: 'blur' },
    {
      validator: (val) => val === passwordForm.value.newPassword,
      message: '两次输入的密码不一致',
      trigger: 'blur'
    }
  ]
}

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
    Blog: '博客管理'
  }
  return titles[route.name] || '雨的空间'
})

function handleMenuChange(value) {
  router.push(`/${value}`)
}

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
  passwordFormRef.value?.reset()
}

async function handlePasswordChange() {
  const valid = await passwordFormRef.value?.validate()
  if (valid !== true) {
    return false
  }

  passwordLoading.value = true
  try {
    const response = await api.auth.changePassword({
      oldPassword: passwordForm.value.oldPassword,
      newPassword: passwordForm.value.newPassword
    })

    if (response.data.message) {
      MessagePlugin.success('密码修改成功，请重新登录')
      showPasswordDialog.value = false
      resetPasswordForm()
      // 修改成功后自动退出登录
      setTimeout(() => {
        handleLogout()
      }, 1500)
    }
  } catch (error) {
    MessagePlugin.error(error.response?.data?.message || '修改密码失败')
    return false
  } finally {
    passwordLoading.value = false
  }
}
</script>

<style scoped>
.layout-container {
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
  animation: fadeInUp 0.6s ease-out;
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

.menu {
  border-right: none !important;
  padding-top: 8px;
  box-shadow: none !important;
}

/* 强制移除 TDesign Menu 组件的右侧边框 */
.menu :deep(.t-menu) {
  border-right: none !important;
  box-shadow: none !important;
}

.menu :deep(.t-menu__inner) {
  border-right: none !important;
  box-shadow: none !important;
}

.fixed-aside {
  border-right: none !important;
  box-shadow: none !important;
}

.menu :deep(.t-menu-item) {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  border-radius: 12px;
  margin: 6px 16px;
  color: rgba(255, 255, 255, 0.75);
  font-weight: 500;
  padding: 12px 16px;
}

.menu :deep(.t-menu-item:hover) {
  background: rgba(255, 255, 255, 0.15);
  color: white;
  transform: translateX(8px);
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
}

.menu :deep(.t-menu-item.t-is-active) {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.25) 0%, rgba(255, 255, 255, 0.1) 100%);
  color: white;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.menu :deep(.t-menu-item.t-is-active .t-icon) {
  color: #ffd700;
}

.menu :deep(.t-icon) {
  font-size: 20px;
  margin-right: 12px;
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

.user-info span {
  font-weight: 500;
  color: #667eea;
}

.username-link {
  cursor: pointer;
  transition: all 0.3s ease;
  padding: 4px 12px;
  border-radius: 4px;
}

.username-link:hover {
  color: #764ba2;
  background: rgba(102, 126, 234, 0.1);
  transform: translateY(-1px);
}

.username-text {
  font-weight: 500;
  color: #667eea;
  padding: 4px 12px;
}

.user-info :deep(.t-button) {
  transition: all 0.3s ease;
}

.user-info :deep(.t-button:hover) {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
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

.global-loading-overlay :deep(.t-loading) {
  color: #667eea;
}

.global-loading-overlay :deep(.t-loading__text) {
  color: #667eea;
  font-size: 16px;
  font-weight: 500;
  margin-top: 12px;
}
</style>
