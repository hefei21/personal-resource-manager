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
  let authChecked = false
  let authCheckPromise = null

  async function login(username, password, remember = true) {
    try {
      const response = await api.auth.login({ username, password, remember })
      user.value = response.data.user
      isAuthenticated.value = true
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
      user.value = response.data.user
      isAuthenticated.value = true

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
    user.value = null
    isAuthenticated.value = false
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
