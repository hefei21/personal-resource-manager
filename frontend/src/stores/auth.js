import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export const useAuthStore = defineStore('auth', () => {
  // 优先从 localStorage 读取，其次从 sessionStorage
  const token = ref(
    localStorage.getItem('token') || sessionStorage.getItem('token') || ''
  )
  const user = ref(
    JSON.parse(localStorage.getItem('user') || sessionStorage.getItem('user') || 'null')
  )
  const isAuthenticated = ref(!!token.value)

  async function login(username, password, remember = true) {
    try {
      const response = await api.auth.login({ username, password, remember })
      token.value = response.data.token
      user.value = response.data.user
      isAuthenticated.value = true

      if (remember) {
        localStorage.setItem('token', token.value)
        localStorage.setItem('user', JSON.stringify(user.value))
      } else {
        sessionStorage.setItem('token', token.value)
        sessionStorage.setItem('user', JSON.stringify(user.value))
      }

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
      token.value = response.data.token
      user.value = response.data.user
      isAuthenticated.value = true

      // 游客模式使用 sessionStorage（关闭浏览器后自动清除）
      sessionStorage.setItem('token', token.value)
      sessionStorage.setItem('user', JSON.stringify(user.value))

      return { success: true }
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || '游客登录失败'
      }
    }
  }

  function logout() {
    token.value = ''
    user.value = null
    isAuthenticated.value = false
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    sessionStorage.removeItem('token')
    sessionStorage.removeItem('user')
  }

  function checkAuth() {
    return !!token.value
  }

  function isGuest() {
    return user.value?.isGuest === true
  }

  function isAdmin() {
    return user.value?.username === 'admin'
  }

  return {
    token,
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
