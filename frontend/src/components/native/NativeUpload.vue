<template>
  <div class="native-upload" :class="{ 'native-upload--disabled': disabled, 'native-upload--drag': drag }">
    <!-- 拖拽上传 -->
    <div
      v-if="drag"
      class="native-upload__drag"
      :class="{ 'native-upload__drag--over': isDragOver }"
      role="button"
      :tabindex="disabled ? -1 : 0"
      :aria-disabled="disabled"
      :aria-label="buttonText"
      @click="handleClick"
      @keydown.enter.prevent="handleClick"
      @keydown.space.prevent="handleClick"
      @dragover.prevent="handleDragOver"
      @dragleave="handleDragLeave"
      @drop.prevent="handleDrop"
    >
      <slot name="dragContent">
        <div class="native-upload__drag-content">
          <NativeIcon name="cloud-upload" size="48" />
          <p class="native-upload__drag-text">点击或拖拽文件到此区域上传</p>
          <p v-if="tip" class="native-upload__drag-tip">{{ tip }}</p>
        </div>
      </slot>
    </div>
    
    <!-- 点击上传 -->
    <div v-else class="native-upload__trigger" @click="handleClick">
      <slot>
        <NativeButton :disabled="disabled">
          <NativeIcon name="upload" size="14" />
          {{ buttonText }}
        </NativeButton>
      </slot>
    </div>
    
    <!-- 文件列表 -->
    <div v-if="showFileList && fileList.length > 0" class="native-upload__list">
      <div
        v-for="file in fileList"
        :key="file.uid"
        class="native-upload__file"
        :class="{
          'native-upload__file--success': file.status === 'success',
          'native-upload__file--error': file.status === 'error',
          'native-upload__file--cancelled': file.status === 'cancelled'
        }"
      >
        <div class="native-upload__file-info">
          <NativeIcon :name="getFileIcon(file)" size="16" />
          <span class="native-upload__file-name">{{ file.name }}</span>
          <span class="native-upload__file-size">({{ formatFileSize(file.size) }})</span>
        </div>
        <div class="native-upload__file-actions">
          <span class="native-upload__status" role="status" aria-live="polite">
            {{ getStatusLabel(file.status) }}
          </span>
          <!-- 进度条 -->
          <div
            v-if="file.status === 'uploading'"
            class="native-upload__progress"
            role="progressbar"
            :aria-valuenow="getPercentage(file)"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="`正在上传 ${file.name}`"
          >
            <div class="native-upload__progress-bar" :style="{ width: getPercentage(file) + '%' }"></div>
          </div>
          <span v-if="file.status === 'uploading'" class="native-upload__percentage">{{ getPercentage(file) }}%</span>
          <!-- 状态图标 -->
          <NativeIcon v-else-if="file.status === 'success'" name="check-circle" size="16" class="native-upload__status-icon--success" />
          <NativeIcon v-else-if="file.status === 'error'" name="close-circle" size="16" class="native-upload__status-icon--error" />
          <NativeIcon v-else-if="file.status === 'cancelled'" name="close-circle" size="16" class="native-upload__status-icon--cancelled" />
          <!-- 取消/重试/删除按钮 -->
          <NativeButton
            v-if="!disabled && file.status === 'uploading'"
            class="native-upload__action"
            variant="text"
            size="small"
            :aria-label="`取消上传 ${file.name}`"
            @click.stop="cancelFile(file)"
          >
            取消
          </NativeButton>
          <NativeButton
            v-else-if="!disabled && (file.status === 'error' || file.status === 'cancelled')"
            class="native-upload__action"
            variant="text"
            size="small"
            :aria-label="`重试上传 ${file.name}`"
            @click.stop="retryFile(file)"
          >
            重试
          </NativeButton>
          <NativeButton
            v-if="!disabled"
            class="native-upload__remove"
            variant="text"
            size="small"
            :aria-label="`移除 ${file.name}`"
            @click.stop="removeFile(file)"
          >
            <NativeIcon name="close" size="14" />
          </NativeButton>
        </div>
      </div>
    </div>
    
    <!-- 隐藏的文件输入 -->
    <input
      ref="fileInput"
      type="file"
      :accept="accept"
      :multiple="multiple"
      :disabled="disabled"
      style="display: none"
      @change="handleFileChange"
    />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import NativeButton from './NativeButton.vue'
import NativeIcon from './NativeIcon.vue'
import {
  clampUploadPercentage,
  getUploadStatusLabel,
  isFileSizeExceeded,
  isUploadCancellable,
  isUploadRetryable,
  maxUploadSizeBytes,
  parseUploadResponse,
  transitionUploadStatus
} from '@/utils/nativeUploadState'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  action: { type: String, required: true },
  headers: { type: Object, default: () => ({}) },
  data: { type: Object, default: () => ({}) },
  name: { type: String, default: 'file' },
  accept: { type: String, default: '' },
  multiple: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  drag: { type: Boolean, default: false },
  showFileList: { type: Boolean, default: true },
  autoUpload: { type: Boolean, default: true },
  buttonText: { type: String, default: '上传文件' },
  tip: { type: String, default: '' },
  maxSize: { type: Number, default: 0 }, // 单位：MB，0表示不限制
  maxCount: { type: Number, default: 0 }, // 0表示不限制
  beforeUpload: { type: Function, default: null },
  onSuccess: { type: Function, default: null },
  onError: { type: Function, default: null }
})

const emit = defineEmits([
  'update:modelValue',
  'change',
  'success',
  'error',
  'progress',
  'remove',
  'exceed',
  'cancel',
  'retry'
])

const fileInput = ref(null)
const isDragOver = ref(false)
const uidCounter = ref(0)
const activeRequests = new Map()
let isDisposed = false

// 内部文件列表
const fileList = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

// 生成唯一ID
function genUid() {
  return Date.now() + '_' + uidCounter.value++
}

// 获取文件图标
function getFileIcon(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']
  const videoExts = ['mp4', 'avi', 'mov', 'wmv', 'flv']
  const audioExts = ['mp3', 'wav', 'flac', 'aac', 'ogg']
  
  if (imageExts.includes(ext)) return 'image'
  if (videoExts.includes(ext)) return 'video'
  if (audioExts.includes(ext)) return 'music'
  return 'file'
}

// 格式化文件大小
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// 点击触发
function handleClick() {
  if (props.disabled || isDisposed) return
  fileInput.value?.click()
}

// 文件选择变化
async function handleFileChange(e) {
  const files = Array.from(e.target.files)
  if (files.length === 0) return
  
  await processFiles(files)
  fileInput.value.value = ''
}

// 拖拽悬停
function handleDragOver() {
  if (props.disabled) return
  isDragOver.value = true
}

// 拖拽离开
function handleDragLeave() {
  isDragOver.value = false
}

// 拖拽放下
async function handleDrop(e) {
  if (props.disabled) return
  isDragOver.value = false
  const files = Array.from(e.dataTransfer.files)
  await processFiles(files)
}

// 处理文件
async function processFiles(files) {
  if (props.disabled || isDisposed) return

  const incomingFiles = Array.from(files || [])
  if (incomingFiles.length === 0) return

  // 先逐个报告超限文件，合法文件继续走原有流程。
  const validFiles = []
  for (const file of incomingFiles) {
    if (isFileSizeExceeded(file.size, props.maxSize)) {
      const maxBytes = maxUploadSizeBytes(props.maxSize)
      emit('exceed', [file], fileList.value, {
        code: 'MAX_SIZE_EXCEEDED',
        reason: 'max-size',
        message: `文件大小超过 ${props.maxSize} MB 限制`,
        fileSize: file.size,
        maxSize: props.maxSize,
        maxBytes
      })
    } else {
      validFiles.push(file)
    }
  }

  // 检查数量限制；与原有契约一样，数量超限时不添加这一批合法文件。
  if (props.maxCount > 0 && fileList.value.length + validFiles.length > props.maxCount) {
    emit('exceed', validFiles, fileList.value, {
      code: 'MAX_COUNT_EXCEEDED',
      reason: 'max-count',
      maxCount: props.maxCount
    })
    return
  }
  
  for (const file of validFiles) {
    if (isDisposed) return

    // beforeUpload 钩子
    if (props.beforeUpload) {
      const result = await props.beforeUpload(file)
      if (isDisposed) return
      if (result === false) continue
    }

    const fileItem = {
      uid: genUid(),
      name: file.name,
      size: file.size,
      type: file.type,
      status: 'ready',
      percentage: 0,
      raw: file,
      response: null
    }
    
    fileList.value.push(fileItem)
    emit('change', fileList.value)
    
    if (props.autoUpload) {
      void uploadFile(fileItem)
    }
  }
}

function createCancelledError() {
  const error = new Error('上传已取消')
  error.code = 'UPLOAD_CANCELLED'
  error.cancelled = true
  return error
}

function createHttpError(xhr) {
  const status = Number(xhr?.status) || 0
  const error = new Error(xhr?.statusText || `上传失败（HTTP ${status}）`)
  error.code = 'UPLOAD_HTTP_ERROR'
  error.status = status
  return error
}

function getRawResponse(xhr) {
  let response
  try {
    response = xhr.response
  } catch {
    response = undefined
  }

  if (response !== undefined && response !== null && response !== '') return response

  try {
    return xhr.responseText ?? response ?? ''
  } catch {
    return response ?? ''
  }
}

function updateProgress(fileItem, loaded, total) {
  const percentage = total > 0
    ? clampUploadPercentage((loaded / total) * 100)
    : clampUploadPercentage(fileItem.percentage)
  fileItem.percentage = percentage
  if (!isDisposed) emit('progress', { file: fileItem, percentage })
}

// 上传文件
async function uploadFile(fileItem) {
  if (!fileItem || isDisposed || fileItem.status === 'uploading') return false
  if (!transitionUploadStatus(fileItem, 'uploading')) return false

  fileItem.percentage = 0
  fileItem.response = null

  // XHR 只保存在组件私有 Map 中，不进入 modelValue 或事件数据。
  const control = {
    xhr: null,
    settled: false,
    cancelled: false,
    reject: null
  }
  activeRequests.set(fileItem.uid, control)

  try {
    const formData = new FormData()
    formData.append(props.name, fileItem.raw)

    // 附加额外数据
    Object.keys(props.data).forEach(key => {
      formData.append(key, props.data[key])
    })

    const xhr = new XMLHttpRequest()
    control.xhr = xhr
    
    // 进度监听
    xhr.upload?.addEventListener('progress', (e) => {
      if (e.lengthComputable) updateProgress(fileItem, e.loaded, e.total)
    })
    
    const response = await new Promise((resolve, reject) => {
      control.reject = (error) => {
        if (control.settled) return
        control.settled = true
        reject(error)
      }
      const settle = (handler, value) => {
        if (control.settled) return
        control.settled = true
        handler(value)
      }

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          settle(resolve, getRawResponse(xhr))
        } else {
          settle(reject, createHttpError(xhr))
        }
      })
      xhr.addEventListener('error', () => settle(reject, new Error('上传失败')))
      xhr.addEventListener('abort', () => settle(reject, createCancelledError()))
      xhr.addEventListener('timeout', () => settle(reject, new Error('上传超时')))
      xhr.open('POST', props.action)
      
      // 设置请求头
      Object.keys(props.headers).forEach(key => {
        xhr.setRequestHeader(key, props.headers[key])
      })
      
      xhr.send(formData)
    })

    if (isDisposed || control.cancelled) return false

    transitionUploadStatus(fileItem, 'success')
    fileItem.percentage = clampUploadPercentage(100)
    fileItem.response = parseUploadResponse(response)
    emit('success', { file: fileItem, response: fileItem.response })
    if (props.onSuccess) {
      try {
        props.onSuccess(fileItem.response, fileItem)
      } catch (callbackError) {
        // 回调异常不改变已经成功的 HTTP 上传状态。
        console.error('[上传] onSuccess 回调失败:', callbackError)
      }
    }
    return true
  } catch (error) {
    if (isDisposed) return false

    if (control.cancelled || error?.code === 'UPLOAD_CANCELLED' || error?.name === 'AbortError') {
      transitionUploadStatus(fileItem, 'cancelled')
      emit('cancel', { file: fileItem, error })
      return false
    }

    transitionUploadStatus(fileItem, 'error')
    emit('error', { file: fileItem, error })
    if (props.onError) {
      try {
        props.onError(error, fileItem)
      } catch (callbackError) {
        console.error('[上传] onError 回调失败:', callbackError)
      }
    }
    return false
  } finally {
    if (activeRequests.get(fileItem.uid) === control) {
      activeRequests.delete(fileItem.uid)
    }
  }
}

function resolveFileItem(fileOrUid) {
  if (fileOrUid && typeof fileOrUid === 'object') return fileOrUid
  return fileList.value.find(file => String(file.uid) === String(fileOrUid)) || null
}

function getPercentage(file) {
  return clampUploadPercentage(file?.percentage)
}

function getStatusLabel(status) {
  return getUploadStatusLabel(status)
}

function cancelFile(fileOrUid) {
  const fileItem = resolveFileItem(fileOrUid)
  const control = fileItem ? activeRequests.get(fileItem.uid) : null
  if (!fileItem || !control || control.settled || !isUploadCancellable(fileItem.status)) return false

  control.cancelled = true
  try {
    control.xhr?.abort()
  } catch {
    // 即使浏览器在 abort 时抛错，也通过 reject 结束 Promise，避免悬挂请求。
  }
  control.reject?.(createCancelledError())
  return true
}

function retryFile(fileOrUid) {
  const fileItem = resolveFileItem(fileOrUid)
  if (!fileItem || isDisposed || !isUploadRetryable(fileItem.status)) return false

  emit('retry', { file: fileItem })
  return uploadFile(fileItem)
}

// 手动上传所有待上传文件
function submit() {
  fileList.value.forEach(file => {
    if (file.status === 'ready') {
      void uploadFile(file)
    }
  })
}

// 移除文件
function removeFile(file) {
  if (file?.status === 'uploading') cancelFile(file)
  const index = fileList.value.indexOf(file)
  if (index > -1) {
    fileList.value.splice(index, 1)
    emit('remove', file, fileList.value)
    emit('change', fileList.value)
  }
}

// 清空文件列表
function clearFiles() {
  fileList.value.forEach(file => {
    if (file.status === 'uploading') cancelFile(file)
  })
  fileList.value = []
  emit('change', fileList.value)
}

onBeforeUnmount(() => {
  isDisposed = true
  for (const control of activeRequests.values()) {
    control.cancelled = true
    try {
      control.xhr?.abort()
    } catch {
      // 请求已经结束时部分实现会抛错，Promise 仍需被收敛。
    }
    control.reject?.(createCancelledError())
  }
  activeRequests.clear()
})

// 暴露方法
defineExpose({
  submit,
  clearFiles,
  cancelFile,
  retryFile
})
</script>

<style scoped>
.native-upload {
  display: inline-block;
  width: 100%;
}

.native-upload--disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.native-upload__drag {
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  padding: 30px 20px;
  text-align: center;
  cursor: pointer;
  transition: border-color var(--motion-duration-fast) var(--motion-easing-standard), background-color var(--motion-duration-fast) var(--motion-easing-standard);
  background: color-mix(in srgb, var(--color-surface-subtle) 56%, var(--color-surface-raised));
}

.native-upload__drag:hover {
  border-color: var(--color-primary);
  background: var(--color-primary-surface);
}

.native-upload__drag--over {
  border-color: var(--color-primary);
  background: var(--color-primary-surface);
  box-shadow: inset 0 0 0 1px var(--color-primary-border);
}

.native-upload__drag-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--color-text-secondary);
}

.native-upload__drag-text {
  font-size: 14px;
  margin: 0;
}

.native-upload__drag-tip {
  font-size: 12px;
  color: var(--color-text-muted);
  margin: 0;
}

.native-upload__list {
  margin-top: 12px;
}

.native-upload__file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--color-surface-subtle);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  margin-bottom: 8px;
  font-size: 13px;
}

.native-upload__file-info {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}

.native-upload__file-name {
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.native-upload__file-size {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.native-upload__file-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.native-upload__status {
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.native-upload__file--success .native-upload__status {
  color: var(--color-success-text);
}

.native-upload__file--error .native-upload__status {
  color: var(--color-danger-text);
}

.native-upload__file--cancelled .native-upload__status {
  color: var(--color-text-muted);
}

.native-upload__progress {
  width: 80px;
  height: 4px;
  background: var(--color-border-subtle);
  border-radius: 2px;
  overflow: hidden;
}

.native-upload__progress-bar {
  height: 100%;
  background: var(--color-primary);
  transition: width 0.3s;
}

.native-upload__percentage {
  min-width: 34px;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.native-upload__status-icon--success {
  color: var(--color-success);
}

.native-upload__status-icon--error {
  color: var(--color-danger);
}

.native-upload__status-icon--cancelled {
  color: #8c8c8c;
}

.native-upload__remove {
  cursor: pointer;
  color: var(--color-text-muted);
  transition: color 0.2s;
}

.native-upload__action {
  flex-shrink: 0;
}

.native-upload__remove:hover {
  color: #ff4d4f;
}
</style>
