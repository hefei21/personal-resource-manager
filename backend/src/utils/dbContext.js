/**
 * 数据库上下文管理
 * 用于在请求链中传递当前用户名，实现多数据库切换
 */
import { AsyncLocalStorage } from 'async_hooks'

const dbContext = new AsyncLocalStorage()

/**
 * 在当前请求上下文中运行函数
 * @param {Object} context - 上下文对象，包含 username 等信息
 * @param {Function} callback - 要执行的函数
 * @returns {any} callback 的返回值
 */
export function runWithContext(context, callback) {
  return dbContext.run(context, callback)
}

/**
 * 获取当前上下文
 * @returns {Object|null} 当前上下文
 */
export function getContext() {
  return dbContext.getStore()
}

/**
 * 获取当前用户名
 * @returns {string|null} 用户名
 */
export function getCurrentUsername() {
  const context = getContext()
  return context?.username || null
}

/**
 * Express 中间件：设置数据库上下文
 * 应该在认证中间件之后使用
 */
export function dbContextMiddleware(req, res, next) {
  const context = {
    username: req.user?.username || null,
    userId: req.user?.id || null,
    isGuest: req.user?.isGuest || false
  }
  
  runWithContext(context, () => {
    next()
  })
}

export default {
  runWithContext,
  getContext,
  getCurrentUsername,
  dbContextMiddleware
}
