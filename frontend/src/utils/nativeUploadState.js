// NativeUpload 的状态规则保持无副作用，组件可以在不暴露 XHR 的情况下复用。
export const UPLOAD_STATUSES = Object.freeze([
  'ready',
  'uploading',
  'success',
  'error',
  'cancelled'
])

export const UPLOAD_STATUS_LABELS = Object.freeze({
  ready: '待上传',
  uploading: '上传中',
  success: '上传成功',
  error: '上传失败',
  cancelled: '已取消'
})

const UPLOAD_STATUS_TRANSITIONS = Object.freeze({
  ready: Object.freeze(['uploading']),
  uploading: Object.freeze(['success', 'error', 'cancelled']),
  success: Object.freeze([]),
  error: Object.freeze(['uploading']),
  cancelled: Object.freeze(['uploading'])
})

/**
 * 判断上传项是否可以从当前状态进入目标状态。
 * 相同状态视为幂等操作，便于组件在重复事件下保持稳定。
 */
export function canTransitionUploadStatus(from, to) {
  if (!UPLOAD_STATUSES.includes(from) || !UPLOAD_STATUSES.includes(to)) return false
  if (from === to) return true
  return UPLOAD_STATUS_TRANSITIONS[from].includes(to)
}

/** 将状态写入上传项；非法转换不会静默改变状态。 */
export function transitionUploadStatus(file, to) {
  if (!file || !canTransitionUploadStatus(file.status, to)) return false
  file.status = to
  return true
}

export function getUploadStatusLabel(status) {
  return UPLOAD_STATUS_LABELS[status] || '未知状态'
}

export function isUploadCancellable(status) {
  return status === 'uploading'
}

export function isUploadRetryable(status) {
  return status === 'error' || status === 'cancelled'
}

/** 百分比统一为 0–100 的整数，避免异常响应污染 aria-valuenow。 */
export function clampUploadPercentage(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, Math.round(number)))
}

export function maxUploadSizeBytes(maxSizeMb) {
  const number = Number(maxSizeMb)
  if (!Number.isFinite(number) || number <= 0) return 0
  return number * 1024 * 1024
}

export function isFileSizeExceeded(fileSize, maxSizeMb) {
  const size = Number(fileSize)
  const limit = maxUploadSizeBytes(maxSizeMb)
  return Number.isFinite(size) && size >= 0 && limit > 0 && size > limit
}

/**
 * 成功 HTTP 响应优先解析 JSON；解析失败时保留原始响应，不抛出异常。
 */
export function parseUploadResponse(response) {
  if (typeof response !== 'string') return response
  if (response.trim() === '') return response
  try {
    return JSON.parse(response)
  } catch {
    return response
  }
}

export default {
  UPLOAD_STATUSES,
  UPLOAD_STATUS_LABELS,
  canTransitionUploadStatus,
  transitionUploadStatus,
  getUploadStatusLabel,
  isUploadCancellable,
  isUploadRetryable,
  clampUploadPercentage,
  maxUploadSizeBytes,
  isFileSizeExceeded,
  parseUploadResponse
}
