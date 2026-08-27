import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { routeNavigationMeta } from './navigation'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { requiresAuth: false }
  },
  {
    path: '/demo',
    name: 'DemoWorkspace',
    component: () => import('@/views/DemoWorkspace.vue'),
    meta: { requiresAuth: true, requiresDemo: true }
  },
  {
    path: '/',
    name: 'Layout',
    component: () => import('@/views/Layout.vue'),
    meta: { requiresAuth: true, requiresOwner: true },
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/Dashboard.vue'),
        meta: routeNavigationMeta('Dashboard')
      },
      ...[
        ['library', 'LibraryHub'],
        ['collection', 'CollectionHub'],
        ['workspace', 'WorkspaceHub'],
        ['system', 'SystemHub'],
        ['more', 'MoreHub']
      ].map(([path, name]) => ({
        path,
        name,
        component: () => import('@/views/GroupHub.vue'),
        meta: routeNavigationMeta(name)
      })),
      {
        path: 'search',
        name: 'Search',
        component: () => import('@/views/Search.vue'),
        meta: routeNavigationMeta('Search')
      },
      {
        path: 'documents',
        name: 'Documents',
        component: () => import('@/views/Documents.vue'),
        meta: routeNavigationMeta('Documents')
      },
      {
        path: 'music',
        name: 'Music',
        component: () => import('@/views/Music.vue'),
        meta: routeNavigationMeta('Music')
      },
      {
        path: 'books',
        name: 'Books',
        component: () => import('@/views/Books.vue'),
        meta: routeNavigationMeta('Books')
      },
      {
        path: 'code',
        name: 'Code',
        component: () => import('@/views/Code.vue'),
        meta: routeNavigationMeta('Code')
      },
      {
        path: 'bookmarks',
        name: 'Bookmarks',
        component: () => import('@/views/Bookmarks.vue'),
        meta: routeNavigationMeta('Bookmarks')
      },
      {
        path: 'anime',
        name: 'Anime',
        component: () => import('@/views/Anime.vue'),
        meta: routeNavigationMeta('Anime')
      },
      {
        path: 'games',
        name: 'Games',
        component: () => import('@/views/Games.vue'),
        meta: routeNavigationMeta('Games')
      },
      {
        path: 'blog',
        name: 'Blog',
        component: () => import('@/views/Blog.vue'),
        meta: routeNavigationMeta('Blog')
      },
      {
        path: 'logs',
        name: 'Logs',
        component: () => import('@/views/Logs.vue'),
        meta: { ...routeNavigationMeta('Logs'), requiresAdmin: true }
      },
      {
        path: 'tasks',
        name: 'Tasks',
        component: () => import('@/views/Tasks.vue'),
        meta: routeNavigationMeta('Tasks')
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach(async (to, from, next) => {
  const authStore = useAuthStore()
  const requiresAuth = to.matched.some(record => record.meta.requiresAuth)
  const requiresAdmin = to.matched.some(record => record.meta.requiresAdmin)
  const requiresOwner = to.matched.some(record => record.meta.requiresOwner)
  const requiresDemo = to.matched.some(record => record.meta.requiresDemo)
  await authStore.checkAuth()

  if (requiresAuth && !authStore.isAuthenticated) {
    next('/login')
  } else if (to.path === '/login' && authStore.isAuthenticated) {
    next(authStore.demoMode ? '/demo' : '/')
  } else if (requiresOwner && authStore.user?.principal !== 'owner') {
    next('/demo')
  } else if (requiresDemo && authStore.user?.principal !== 'demo') {
    next('/')
  } else if (requiresAdmin && authStore.user?.principal !== 'owner') {
    // 非管理员访问管理员页面，跳转到首页
    next('/')
  } else {
    next()
  }
})

export default router
