/**
 * 时间转换工具函数
 * UTC 转 UTC+8
 */

/**
 * 将 UTC 时间转换为 UTC+8
 * @param {string|Date} utcTime - UTC 时间字符串或 Date 对象
 * @returns {string} 格式化后的 UTC+8 时间字符串 (YYYY-MM-DD HH:mm:ss)
 */
export function convertToUTC8(utcTime) {
  if (!utcTime) return utcTime
  
  // 如果已经是 Date 对象，直接使用
  const date = utcTime instanceof Date ? utcTime : new Date(utcTime + 'Z')
  
  // 转换为 UTC+8
  const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  
  const year = utc8Date.getFullYear()
  const month = String(utc8Date.getMonth() + 1).padStart(2, '0')
  const day = String(utc8Date.getDate()).padStart(2, '0')
  const hours = String(utc8Date.getHours()).padStart(2, '0')
  const minutes = String(utc8Date.getMinutes()).padStart(2, '0')
  const seconds = String(utc8Date.getSeconds()).padStart(2, '0')
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

/**
 * 格式化日期（仅日期部分）
 * @param {string|Date} utcTime - UTC 时间
 * @returns {string} YYYY-MM-DD
 */
export function formatDate(utcTime) {
  if (!utcTime) return ''
  const date = utcTime instanceof Date ? utcTime : new Date(utcTime + 'Z')
  const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  
  const year = utc8Date.getFullYear()
  const month = String(utc8Date.getMonth() + 1).padStart(2, '0')
  const day = String(utc8Date.getDate()).padStart(2, '0')
  
  return `${year}-${month}-${day}`
}

/**
 * 格式化时间（仅时间部分）
 * @param {string|Date} utcTime - UTC 时间
 * @returns {string} HH:mm:ss
 */
export function formatTime(utcTime) {
  if (!utcTime) return ''
  const date = utcTime instanceof Date ? utcTime : new Date(utcTime + 'Z')
  const utc8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  
  const hours = String(utc8Date.getHours()).padStart(2, '0')
  const minutes = String(utc8Date.getMinutes()).padStart(2, '0')
  const seconds = String(utc8Date.getSeconds()).padStart(2, '0')
  
  return `${hours}:${minutes}:${seconds}`
}
