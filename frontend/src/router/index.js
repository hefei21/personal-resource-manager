import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { requiresAuth: false }
  },
  {
    path: '/',
    name: 'Layout',
    component: () => import('@/views/Layout.vue'),
    meta: { requiresAuth: true },
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/Dashboard.vue')
      },
      {
        path: 'documents',
        name: 'Documents',
        component: () => import('@/views/Documents.vue')
      },
      {
        path: 'music',
        name: 'Music',
        component: () => import('@/views/Music.vue')
      },
      {
        path: 'books',
        name: 'Books',
        component: () => import('@/views/Books.vue')
      },
      {
        path: 'code',
        name: 'Code',
        component: () => import('@/views/Code.vue')
      },
      {
        path: 'bookmarks',
        name: 'Bookmarks',
        component: () => import('@/views/Bookmarks.vue')
      },
      {
        path: 'anime',
        name: 'Anime',
        component: () => import('@/views/Anime.vue')
      },
      {
        path: 'games',
        name: 'Games',
        component: () => import('@/views/Games.vue')
      },
      {
        path: 'blog',
        name: 'Blog',
        component: () => import('@/views/Blog.vue')
      },
      {
        path: 'logs',
        name: 'Logs',
        component: () => import('@/views/Logs.vue'),
        meta: { requiresAdmin: true }
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach((to, from, next) => {
  const authStore = useAuthStore()
  const requiresAuth = to.matched.some(record => record.meta.requiresAuth)
  const requiresAdmin = to.matched.some(record => record.meta.requiresAdmin)

  if (requiresAuth && !authStore.isAuthenticated) {
    next('/login')
  } else if (to.path === '/login' && authStore.isAuthenticated) {
    next('/')
  } else if (requiresAdmin && authStore.user?.username !== 'admin') {
    // 非管理员访问管理员页面，跳转到首页
    next('/')
  } else {
    next()
  }
})

export default router
