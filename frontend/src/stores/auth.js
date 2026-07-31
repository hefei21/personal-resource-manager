import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export const useAuthStore = defineStore('auth', () => {
  // Authentication credentials live only in HttpOnly cookies.
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  sessionStorage.removeItem('token')
  sessionStorage.removeItem('user')

  const user = ref(null)
  const isAuthenticated = ref(false)
  const demoMode = ref(sessionStorage.getItem('pr_demo_mode') === 'true')
  let authChecked = false
  let authCheckPromise = null

  async function login(username, password, remember = true) {
    try {
      const response = await api.auth.login({ username, password, remember })
      user.value = response.data.user
      isAuthenticated.value = true
      demoMode.value = false
      sessionStorage.removeItem('pr_demo_mode')
      authChecked = true

      return { success: true }
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || '登录失败'
      }
    }
  }

  async function guestLogin() {
    try {
      const response = await api.demo.createSession()
      user.value = response.data.user
      isAuthenticated.value = true
      demoMode.value = true
      sessionStorage.setItem('pr_demo_mode', 'true')
      authChecked = true

      return { success: true }
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || '无法创建演示会话'
      }
    }
  }

  async function logout() {
    try {
      if (isAuthenticated.value) {
        if (demoMode.value) {
          await api.demo.closeSession()
        } else {
          await api.auth.logout()
        }
      }
    } catch {
      // Local state must still be cleared when the server is unavailable.
    }
    user.value = null
    isAuthenticated.value = false
    demoMode.value = false
    sessionStorage.removeItem('pr_demo_mode')
    authChecked = true
  }

  async function checkAuth() {
    if (authChecked) return isAuthenticated.value
    if (authCheckPromise) return authCheckPromise

    async function resolveSession() {
      const checks = demoMode.value
        ? [
            { demo: true, request: () => api.demo.checkSession() },
            { demo: false, request: () => api.auth.check() }
          ]
        : [
            { demo: false, request: () => api.auth.check() },
            { demo: true, request: () => api.demo.checkSession() }
          ]

      for (const check of checks) {
        try {
          return {
            response: await check.request(),
            demo: check.demo
          }
        } catch {
          // The other session type may still be valid, especially in a new tab.
        }
      }

      throw new Error('No active session')
    }

    authCheckPromise = resolveSession()
      .then(({ response, demo }) => {
        user.value = response.data.user
        isAuthenticated.value = response.data.authenticated === true
        demoMode.value = demo
        if (demo) {
          sessionStorage.setItem('pr_demo_mode', 'true')
        } else {
          sessionStorage.removeItem('pr_demo_mode')
        }
        return isAuthenticated.value
      })
      .catch(() => {
        user.value = null
        isAuthenticated.value = false
        demoMode.value = false
        sessionStorage.removeItem('pr_demo_mode')
        return false
      })
      .finally(() => {
        authChecked = true
        authCheckPromise = null
      })

    return authCheckPromise
  }

  function isGuest() {
    return user.value?.isGuest === true
  }

  function isAdmin() {
    return user.value?.principal === 'owner'
  }

  return {
    user,
    isAuthenticated,
    demoMode,
    login,
    guestLogin,
    logout,
    checkAuth,
    isGuest,
    isAdmin
  }
})
