import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

/**
 * 权限管理 composable
 * 用于检查当前用户是否为游客模式（从 JWT token 中判断）
 */
export function usePermission() {
  const authStore = useAuthStore()
  
  const isGuest = computed(() => {
    return authStore.isGuest()
  })

  const isAdmin = computed(() => {
    return !isGuest.value && authStore.isAuthenticated
  })

  /**
   * 检查是否有写权限
   */
  const canWrite = computed(() => {
    return !isGuest.value
  })

  /**
   * 检查是否有权限执行操作
   * @param {string} action - 操作名称
   * @returns {boolean}
   */
  function canPerformAction(action) {
    // 游客模式下，所有写操作都被禁止
    const guestForbiddenActions = [
      'create',
      'update',
      'delete',
      'upload',
      'batchEdit',
      'batchDelete',
      'editCategory',
      'deleteCategory',
      'createCategory',
      'reorderCategory',
      'changePassword',
      'privateSpace'
    ]

    if (isGuest.value && guestForbiddenActions.some(act => action.includes(act))) {
      return false
    }

    return true
  }

  return {
    isGuest,
    isAdmin,
    canPerformAction,
    canWrite
  }
}
