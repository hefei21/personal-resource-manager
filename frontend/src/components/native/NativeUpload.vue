<template>
  <div class="native-upload" :class="{ 'native-upload--disabled': disabled, 'native-upload--drag': drag }">
    <!-- 拖拽上传 -->
    <div
      v-if="drag"
      class="native-upload__drag"
      :class="{ 'native-upload__drag--over': isDragOver }"
      @click="handleClick"
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
        :class="{ 'native-upload__file--success': file.status === 'success', 'native-upload__file--error': file.status === 'error' }"
      >
        <div class="native-upload__file-info">
          <NativeIcon :name="getFileIcon(file)" size="16" />
          <span class="native-upload__file-name">{{ file.name }}</span>
          <span class="native-upload__file-size">({{ formatFileSize(file.size) }})</span>
        </div>
        <div class="native-upload__file-actions">
          <!-- 进度条 -->
          <div v-if="file.status === 'uploading'" class="native-upload__progress">
            <div class="native-upload__progress-bar" :style="{ width: file.percentage + '%' }"></div>
          </div>
          <!-- 状态图标 -->
          <NativeIcon v-else-if="file.status === 'success'" name="check-circle" size="16" class="native-upload__status-icon--success" />
          <NativeIcon v-else-if="file.status === 'error'" name="close-circle" size="16" class="native-upload__status-icon--error" />
          <!-- 删除按钮 -->
          <span v-if="!disabled" class="native-upload__remove" @click.stop="removeFile(file)">
            <NativeIcon name="close" size="14" />
          </span>
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
import { ref, computed } from 'vue'
import NativeButton from './NativeButton.vue'
import NativeIcon from './NativeIcon.vue'

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

const emit = defineEmits(['update:modelValue', 'change', 'success', 'error', 'progress', 'remove', 'exceed'])

const fileInput = ref(null)
const isDragOver = ref(false)
const uidCounter = ref(0)

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
  if (props.disabled) return
  fileInput.value.click()
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
  // 检查数量限制
  if (props.maxCount > 0 && fileList.value.length + files.length > props.maxCount) {
    emit('exceed', files, fileList.value)
    return
  }
  
  for (const file of files) {
    // 检查大小限制
    if (props.maxSize > 0 && file.size > props.maxSize * 1024 * 1024) {
      continue
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
    
    // beforeUpload 钩子
    if (props.beforeUpload) {
      const result = await props.beforeUpload(file)
      if (result === false) continue
    }
    
    fileList.value.push(fileItem)
    emit('change', fileList.value)
    
    if (props.autoUpload) {
      uploadFile(fileItem)
    }
  }
}

// 上传文件
async function uploadFile(fileItem) {
  fileItem.status = 'uploading'
  
  const formData = new FormData()
  formData.append(props.name, fileItem.raw)
  
  // 附加额外数据
  Object.keys(props.data).forEach(key => {
    formData.append(key, props.data[key])
  })
  
  try {
    const xhr = new XMLHttpRequest()
    
    // 进度监听
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        fileItem.percentage = Math.round((e.loaded / e.total) * 100)
        emit('progress', { file: fileItem, percentage: fileItem.percentage })
      }
    })
    
    const response = await new Promise((resolve, reject) => {
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response)
        } else {
          reject(new Error(xhr.statusText))
        }
      })
      xhr.addEventListener('error', () => reject(new Error('上传失败')))
      xhr.open('POST', props.action)
      
      // 设置请求头
      Object.keys(props.headers).forEach(key => {
        xhr.setRequestHeader(key, props.headers[key])
      })
      
      xhr.send(formData)
    })
    
    fileItem.status = 'success'
    fileItem.response = JSON.parse(response)
    emit('success', { file: fileItem, response: fileItem.response })
    if (props.onSuccess) props.onSuccess(fileItem.response, fileItem)
  } catch (error) {
    fileItem.status = 'error'
    emit('error', { file: fileItem, error })
    if (props.onError) props.onError(error, fileItem)
  }
}

// 手动上传所有待上传文件
function submit() {
  fileList.value.forEach(file => {
    if (file.status === 'ready') {
      uploadFile(file)
    }
  })
}

// 移除文件
function removeFile(file) {
  const index = fileList.value.indexOf(file)
  if (index > -1) {
    fileList.value.splice(index, 1)
    emit('remove', file, fileList.value)
    emit('change', fileList.value)
  }
}

// 清空文件列表
function clearFiles() {
  fileList.value = []
  emit('change', fileList.value)
}

// 暴露方法
defineExpose({
  submit,
  clearFiles
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
  border: 2px dashed #dcdcdc;
  border-radius: 8px;
  padding: 40px 20px;
  text-align: center;
  cursor: pointer;
  transition: all 0.3s;
  background: #fafafa;
}

.native-upload__drag:hover {
  border-color: #0052d9;
}

.native-upload__drag--over {
  border-color: #0052d9;
  background: #e8f4ff;
}

.native-upload__drag-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: #666;
}

.native-upload__drag-text {
  font-size: 14px;
  margin: 0;
}

.native-upload__drag-tip {
  font-size: 12px;
  color: #999;
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
  background: #f5f5f5;
  border-radius: 4px;
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
  color: #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.native-upload__file-size {
  color: #999;
  flex-shrink: 0;
}

.native-upload__file-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.native-upload__progress {
  width: 80px;
  height: 4px;
  background: #e8e8e8;
  border-radius: 2px;
  overflow: hidden;
}

.native-upload__progress-bar {
  height: 100%;
  background: #0052d9;
  transition: width 0.3s;
}

.native-upload__status-icon--success {
  color: #52c41a;
}

.native-upload__status-icon--error {
  color: #ff4d4f;
}

.native-upload__remove {
  cursor: pointer;
  color: #999;
  transition: color 0.2s;
}

.native-upload__remove:hover {
  color: #ff4d4f;
}
</style>
