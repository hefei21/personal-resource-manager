<template>
  <Teleport to="body">
    <Transition name="image-viewer-fade">
      <div v-if="visible" class="native-image-viewer" @click.self="close">
        <!-- 背景遮罩 -->
        <div class="native-image-viewer__mask"></div>
        
        <!-- 关闭按钮 -->
        <button class="native-image-viewer__close" @click="close">
          <NativeIcon name="close" size="24" />
        </button>
        
        <!-- 工具栏 -->
        <div class="native-image-viewer__toolbar">
          <button class="native-image-viewer__tool" @click="zoomOut" title="缩小">
            <NativeIcon name="zoom-out" size="20" />
          </button>
          <button class="native-image-viewer__tool" @click="zoomIn" title="放大">
            <NativeIcon name="zoom-in" size="20" />
          </button>
          <button class="native-image-viewer__tool" @click="rotateLeft" title="向左旋转">
            <NativeIcon name="rotate-left" size="20" />
          </button>
          <button class="native-image-viewer__tool" @click="rotateRight" title="向右旋转">
            <NativeIcon name="rotate-right" size="20" />
          </button>
          <button class="native-image-viewer__tool" @click="reset" title="重置">
            <NativeIcon name="refresh" size="20" />
          </button>
          <button v-if="images.length > 1" class="native-image-viewer__tool" @click="prev" title="上一张">
            <NativeIcon name="arrow-left" size="20" />
          </button>
          <button v-if="images.length > 1" class="native-image-viewer__tool" @click="next" title="下一张">
            <NativeIcon name="arrow-right" size="20" />
          </button>
        </div>
        
        <!-- 图片计数 -->
        <div v-if="images.length > 1" class="native-image-viewer__counter">
          {{ currentIndex + 1 }} / {{ images.length }}
        </div>
        
        <!-- 图片容器 -->
        <div 
          class="native-image-viewer__container"
          @mousedown="handleMouseDown"
          @mousemove="handleMouseMove"
          @mouseup="handleMouseUp"
          @mouseleave="handleMouseUp"
          @wheel.prevent="handleWheel"
        >
          <img
            :src="currentImage"
            class="native-image-viewer__image"
            :style="imageStyle"
            @load="handleImageLoad"
            @error="handleImageError"
            draggable="false"
          />
        </div>
        
        <!-- 缩略图导航 -->
        <div v-if="images.length > 1 && showThumbnails" class="native-image-viewer__thumbnails">
          <div
            v-for="(img, index) in images"
            :key="index"
            class="native-image-viewer__thumb"
            :class="{ 'native-image-viewer__thumb--active': index === currentIndex }"
            @click="goTo(index)"
          >
            <img :src="typeof img === 'string' ? img : img.thumbnail || img.src" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import NativeIcon from './NativeIcon.vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  images: { type: Array, default: () => [] },
  initialIndex: { type: Number, default: 0 },
  showThumbnails: { type: Boolean, default: true },
  loop: { type: Boolean, default: true },
  minScale: { type: Number, default: 0.1 },
  maxScale: { type: Number, default: 5 }
})

const emit = defineEmits(['update:modelValue', 'change', 'close'])

const visible = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

const currentIndex = ref(props.initialIndex)
const scale = ref(1)
const rotate = ref(0)
const translateX = ref(0)
const translateY = ref(0)
const isDragging = ref(false)
const dragStartX = ref(0)
const dragStartY = ref(0)

const currentImage = computed(() => {
  const img = props.images[currentIndex.value]
  return typeof img === 'string' ? img : img?.src || img?.url || ''
})

const imageStyle = computed(() => ({
  transform: `translate(${translateX.value}px, ${translateY.value}px) scale(${scale.value}) rotate(${rotate.value}deg)`,
  transition: isDragging.value ? 'none' : 'transform 0.3s'
}))

// 监听图片切换
watch(currentIndex, (val) => {
  emit('change', val)
  reset()
})

// 监听显示状态
watch(visible, (val) => {
  if (val) {
    currentIndex.value = props.initialIndex
    reset()
    document.body.style.overflow = 'hidden'
  } else {
    document.body.style.overflow = ''
  }
})

// 上一张
function prev() {
  if (currentIndex.value > 0) {
    currentIndex.value--
  } else if (props.loop) {
    currentIndex.value = props.images.length - 1
  }
}

// 下一张
function next() {
  if (currentIndex.value < props.images.length - 1) {
    currentIndex.value++
  } else if (props.loop) {
    currentIndex.value = 0
  }
}

// 跳转到指定图片
function goTo(index) {
  currentIndex.value = index
}

// 放大
function zoomIn() {
  scale.value = Math.min(scale.value * 1.2, props.maxScale)
}

// 缩小
function zoomOut() {
  scale.value = Math.max(scale.value / 1.2, props.minScale)
}

// 向左旋转
function rotateLeft() {
  rotate.value -= 90
}

// 向右旋转
function rotateRight() {
  rotate.value += 90
}

// 重置
function reset() {
  scale.value = 1
  rotate.value = 0
  translateX.value = 0
  translateY.value = 0
}

// 关闭
function close() {
  visible.value = false
  emit('close')
}

// 鼠标滚轮缩放
function handleWheel(e) {
  if (e.deltaY < 0) {
    zoomIn()
  } else {
    zoomOut()
  }
}

// 鼠标拖拽
function handleMouseDown(e) {
  if (scale.value <= 1) return
  isDragging.value = true
  dragStartX.value = e.clientX - translateX.value
  dragStartY.value = e.clientY - translateY.value
}

function handleMouseMove(e) {
  if (!isDragging.value) return
  translateX.value = e.clientX - dragStartX.value
  translateY.value = e.clientY - dragStartY.value
}

function handleMouseUp() {
  isDragging.value = false
}

// 键盘导航
function handleKeydown(e) {
  if (!visible.value) return
  switch (e.key) {
    case 'Escape':
      close()
      break
    case 'ArrowLeft':
      prev()
      break
    case 'ArrowRight':
      next()
      break
    case 'ArrowUp':
      zoomIn()
      break
    case 'ArrowDown':
      zoomOut()
      break
  }
}

// 图片加载
function handleImageLoad() {
  // 可以在这里添加加载完成的逻辑
}

// 图片加载失败
function handleImageError() {
  // 可以在这里添加错误处理的逻辑
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  document.body.style.overflow = ''
})
</script>

<style scoped>
.native-image-viewer {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.native-image-viewer__mask {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.9);
}

.native-image-viewer__close {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 44px;
  height: 44px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
  z-index: 1;
}

.native-image-viewer__close:hover {
  background: rgba(255, 255, 255, 0.2);
}

.native-image-viewer__toolbar {
  position: absolute;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  z-index: 1;
}

.native-image-viewer__tool {
  width: 40px;
  height: 40px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 8px;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}

.native-image-viewer__tool:hover {
  background: rgba(255, 255, 255, 0.2);
}

.native-image-viewer__counter {
  position: absolute;
  top: 24px;
  left: 24px;
  color: #fff;
  font-size: 14px;
  z-index: 1;
}

.native-image-viewer__container {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: grab;
}

.native-image-viewer__container:active {
  cursor: grabbing;
}

.native-image-viewer__image {
  max-width: 90%;
  max-height: 90%;
  object-fit: contain;
  user-select: none;
}

.native-image-viewer__thumbnails {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 8px;
  max-width: 80%;
  overflow-x: auto;
  z-index: 1;
}

.native-image-viewer__thumb {
  width: 60px;
  height: 60px;
  border-radius: 4px;
  overflow: hidden;
  cursor: pointer;
  border: 2px solid transparent;
  transition: border-color 0.2s;
  flex-shrink: 0;
}

.native-image-viewer__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.native-image-viewer__thumb--active {
  border-color: #0052d9;
}

/* 过渡动画 */
.image-viewer-fade-enter-active,
.image-viewer-fade-leave-active {
  transition: opacity 0.3s;
}

.image-viewer-fade-enter-from,
.image-viewer-fade-leave-to {
  opacity: 0;
}
</style>
