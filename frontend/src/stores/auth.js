import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export const useAuthStore = defineStore('auth', () => {
  // Owner credentials live only in an HttpOnly cookie. Keep the transitional
  // demo bearer isolated in sessionStorage until the demo workspace replaces it.
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  sessionStorage.removeItem('token')
  sessionStorage.removeItem('user')

  const demoToken = ref(sessionStorage.getItem('demoToken') || '')
  const user = ref(null)
  const isAuthenticated = ref(false)
  let authChecked = false
  let authCheckPromise = null

  async function login(username, password, remember = true) {
    try {
      const response = await api.auth.login({ username, password, remember })
      user.value = response.data.user
      isAuthenticated.value = true
      demoToken.value = ''
      sessionStorage.removeItem('demoToken')
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
      const response = await api.auth.guestLogin()
      demoToken.value = response.data.token
      user.value = response.data.user
      isAuthenticated.value = true

      sessionStorage.setItem('demoToken', demoToken.value)
      authChecked = true

      return { success: true }
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || '游客登录失败'
      }
    }
  }

  async function logout() {
    try {
      if (isAuthenticated.value) {
        await api.auth.logout()
      }
    } catch {
      // Local state must still be cleared when the server is unavailable.
    }
    demoToken.value = ''
    user.value = null
    isAuthenticated.value = false
    sessionStorage.removeItem('demoToken')
    authChecked = true
  }

  async function checkAuth() {
    if (authChecked) return isAuthenticated.value
    if (authCheckPromise) return authCheckPromise

    authCheckPromise = api.auth.check()
      .then((response) => {
        user.value = response.data.user
        isAuthenticated.value = response.data.authenticated === true
        return isAuthenticated.value
      })
      .catch(() => {
        user.value = null
        isAuthenticated.value = false
        demoToken.value = ''
        sessionStorage.removeItem('demoToken')
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
    return user.value?.username === 'admin'
  }

  return {
    demoToken,
    user,
    isAuthenticated,
    login,
    guestLogin,
    logout,
    checkAuth,
    isGuest,
    isAdmin
  }
})
