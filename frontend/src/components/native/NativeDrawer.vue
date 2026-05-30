<template>
  <Teleport to="body">
    <Transition name="drawer-fade">
      <div 
        v-if="modelValue" 
        class="native-drawer" 
        :class="[`native-drawer--${placement}`]" 
        @click.self="handleMaskClick"
        role="dialog"
        :aria-modal="true"
        :aria-labelledby="titleId"
      >
        <!-- 遮罩层 -->
        <div v-if="showOverlay" class="native-drawer__mask" :style="maskStyle"></div>
        
        <!-- 抽屉内容 -->
        <Transition :name="`drawer-slide-${placement}`">
          <div v-show="modelValue" class="native-drawer__content" :style="contentStyle">
            <!-- 头部 -->
            <div v-if="showHeader" class="native-drawer__header">
              <slot name="header">
                <h3 :id="titleId" class="native-drawer__title">{{ title }}</h3>
                <button 
                  v-if="closeBtn" 
                  class="native-drawer__close" 
                  @click="close"
                  type="button"
                  aria-label="关闭"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                  </svg>
                </button>
              </slot>
            </div>
            
            <!-- 身体 -->
            <div class="native-drawer__body" :style="bodyStyle">
              <slot></slot>
            </div>
            
            <!-- 底部 -->
            <div v-if="$slots.footer" class="native-drawer__footer">
              <slot name="footer"></slot>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { computed, watch, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '' },
  placement: { type: String, default: 'right' }, // left, right, top, bottom
  size: { type: [String, Number], default: '300px' },
  showOverlay: { type: Boolean, default: true },
  closeOnOverlayClick: { type: Boolean, default: true },
  closeBtn: { type: Boolean, default: true },
  zIndex: { type: Number, default: 1500 },
  closeOnEsc: { type: Boolean, default: true }
})

const emit = defineEmits(['update:modelValue', 'open', 'close', 'closed'])

// 生成唯一标题ID
const titleId = computed(() => 'drawer-title-' + Math.random().toString(36).substr(2, 9))

// 是否显示头部（有标题时显示）
const showHeader = computed(() => Boolean(props.title))

// 保存原始的 body overflow 值
let originalBodyOverflow = ''

// 遮罩样式
const maskStyle = computed(() => ({
  zIndex: props.zIndex
}))

// 内容样式
const contentStyle = computed(() => {
  const style = { zIndex: props.zIndex + 1 }
  
  if (props.placement === 'left' || props.placement === 'right') {
    style.width = typeof props.size === 'number' ? `${props.size}px` : props.size
    style.height = '100%'
  } else {
    style.height = typeof props.size === 'number' ? `${props.size}px` : props.size
    style.width = '100%'
  }
  
  return style
})

// 身体样式
const bodyStyle = computed(() => {
  const style = {}
  // 有标题时减小顶部padding
  if (props.title) {
    style.paddingTop = '0'
  }
  return style
})

// 处理遮罩点击
function handleMaskClick() {
  if (props.closeOnOverlayClick) {
    close()
  }
}

// 关闭
function close() {
  emit('update:modelValue', false)
  emit('close')
}

// ESC 关闭
function handleEsc(e) {
  if (e.key === 'Escape' && props.modelValue && props.closeOnEsc) {
    close()
  }
}

// 监听显示状态
watch(() => props.modelValue, (val) => {
  if (val) {
    emit('open')
    originalBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  } else {
    document.body.style.overflow = originalBodyOverflow
    setTimeout(() => emit('closed'), 300)
  }
})

onMounted(() => {
  document.addEventListener('keydown', handleEsc)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleEsc)
  document.body.style.overflow = originalBodyOverflow
})
</script>

<style scoped>
.native-drawer {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
}

.native-drawer__mask {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  pointer-events: auto;
}

.native-drawer__content {
  position: absolute;
  background: #fff;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
  box-shadow: 0 0 20px rgba(0, 0, 0, 0.1);
}

/* 位置定位 */
.native-drawer--left .native-drawer__content {
  left: 0;
  top: 56px;
  bottom: 0;
  height: calc(100% - 56px);
}

.native-drawer--right .native-drawer__content {
  right: 0;
  top: 56px;
  bottom: 0;
  height: calc(100% - 56px);
}

.native-drawer--top .native-drawer__content {
  top: 0;
  left: 0;
  right: 0;
}

.native-drawer--bottom .native-drawer__content {
  bottom: 0;
  left: 0;
  right: 0;
}

.native-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #e8e8e8;
}

.native-drawer__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #333;
}

.native-drawer__close {
  background: #f5f5f5;
  border: 1px solid #e0e0e0;
  cursor: pointer;
  padding: 6px;
  color: #666;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  min-width: 32px;
  min-height: 32px;
}

.native-drawer__close:hover {
  background: #e8e8e8;
  color: #333;
  border-color: #ccc;
}

.native-drawer__close:focus-visible {
  outline: 2px solid #0052d9;
  outline-offset: 2px;
}

.native-drawer__body {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}

.native-drawer__footer {
  padding: 16px 20px;
  border-top: 1px solid #e8e8e8;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

/* 动画 */
.drawer-fade-enter-active,
.drawer-fade-leave-active {
  transition: opacity 0.3s;
}

.drawer-fade-enter-from,
.drawer-fade-leave-to {
  opacity: 0;
}

/* 左滑入 */
.drawer-slide-left-enter-active,
.drawer-slide-left-leave-active {
  transition: transform 0.3s ease;
}

.drawer-slide-left-enter-from,
.drawer-slide-left-leave-to {
  transform: translateX(-100%);
}

/* 右滑入 */
.drawer-slide-right-enter-active,
.drawer-slide-right-leave-active {
  transition: transform 0.3s ease;
}

.drawer-slide-right-enter-from,
.drawer-slide-right-leave-to {
  transform: translateX(100%);
}

/* 上滑入 */
.drawer-slide-top-enter-active,
.drawer-slide-top-leave-active {
  transition: transform 0.3s ease;
}

.drawer-slide-top-enter-from,
.drawer-slide-top-leave-to {
  transform: translateY(-100%);
}

/* 下滑入 */
.drawer-slide-bottom-enter-active,
.drawer-slide-bottom-leave-active {
  transition: transform 0.3s ease;
}

.drawer-slide-bottom-enter-from,
.drawer-slide-bottom-leave-to {
  transform: translateY(100%);
}
</style>
