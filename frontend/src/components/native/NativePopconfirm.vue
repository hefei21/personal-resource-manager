<template>
  <div ref="triggerRef" class="native-popconfirm">
    <div 
      class="native-popconfirm__trigger" 
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
      tabindex="0"
      role="button"
      :aria-expanded="visible"
    >
      <slot name="trigger" />
    </div>
    <Teleport to="body">
      <Transition name="native-popconfirm">
        <div 
          v-if="visible" 
          ref="popupRef"
          class="native-popconfirm__popup" 
          :class="`native-popconfirm--${placement}`"
          :style="popupStyle"
          v-click-outside="close"
        >
          <div class="native-popconfirm__content">
            <div class="native-popconfirm__icon" v-if="showIcon" aria-hidden="true">
              <svg v-if="theme === 'warning'" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
              </svg>
              <svg v-else-if="theme === 'danger'" viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
              </svg>
              <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
              </svg>
            </div>
            <div class="native-popconfirm__message" role="alert">
              <slot>
                {{ content }}
              </slot>
            </div>
          </div>
          <div class="native-popconfirm__actions">
            <button 
              class="native-popconfirm__btn native-popconfirm__btn--cancel" 
              @click="handleCancel"
              @keydown.esc="handleCancel"
              type="button"
            >
              {{ cancelText }}
            </button>
            <button 
              class="native-popconfirm__btn native-popconfirm__btn--confirm" 
              :class="`native-popconfirm__btn--${theme}`"
              @click="handleConfirm"
              type="button"
              ref="confirmBtnRef"
            >
              {{ confirmText }}
            </button>
          </div>
          <div class="native-popconfirm__arrow" aria-hidden="true"></div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { vClickOutside } from './directives/clickOutside'

const props = defineProps({
  content: { type: String, default: '确认执行此操作？' },
  theme: { type: String, default: 'default' }, // default, warning, danger
  confirmText: { type: String, default: '确认' },
  cancelText: { type: String, default: '取消' },
  placement: { type: String, default: 'top' }, // top, bottom, left, right
  showIcon: { type: Boolean, default: true },
  zIndex: { type: Number, default: 5500 }
})

const emit = defineEmits(['confirm', 'cancel', 'close'])

const triggerRef = ref(null)
const popupRef = ref(null)
const confirmBtnRef = ref(null)
const visible = ref(false)
const popupStyle = ref({})

// 计算弹出层位置
function updatePosition() {
  if (!triggerRef.value) return
  
  const triggerRect = triggerRef.value.getBoundingClientRect()
  const popupWidth = 200 // 最小宽度
  const popupHeight = 100 // 预估高度
  const spacing = 8
  
  let top = 0
  let left = 0
  
  switch (props.placement) {
    case 'top':
      top = triggerRect.top - popupHeight - spacing
      left = triggerRect.left + (triggerRect.width - popupWidth) / 2
      break
    case 'bottom':
      top = triggerRect.bottom + spacing
      left = triggerRect.left + (triggerRect.width - popupWidth) / 2
      break
    case 'left':
      top = triggerRect.top + (triggerRect.height - popupHeight) / 2
      left = triggerRect.left - popupWidth - spacing
      break
    case 'right':
      top = triggerRect.top + (triggerRect.height - popupHeight) / 2
      left = triggerRect.right + spacing
      break
  }
  
  // 边界检测
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  
  // 水平边界
  if (left < 10) left = 10
  if (left + popupWidth > viewportWidth - 10) {
    left = viewportWidth - popupWidth - 10
  }
  
  // 垂直边界 - 如果上方空间不足，自动切换到下方
  if (props.placement === 'top' && top < 10) {
    top = triggerRect.bottom + spacing
  }
  if (props.placement === 'bottom' && top + popupHeight > viewportHeight - 10) {
    top = triggerRect.top - popupHeight - spacing
  }
  
  popupStyle.value = {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
    zIndex: props.zIndex
  }
}

function toggle() {
  visible.value = !visible.value
  if (visible.value) {
    nextTick(() => {
      updatePosition()
      // 自动聚焦确认按钮
      confirmBtnRef.value?.focus()
    })
  }
}

function close() {
  visible.value = false
  emit('close')
}

function handleConfirm() {
  emit('confirm')
  close()
}

function handleCancel() {
  emit('cancel')
  close()
}

// 监听窗口变化
function handleWindowChange() {
  if (visible.value) {
    updatePosition()
  }
}

onMounted(() => {
  window.addEventListener('resize', handleWindowChange)
  window.addEventListener('scroll', handleWindowChange, true)
})

onUnmounted(() => {
  window.removeEventListener('resize', handleWindowChange)
  window.removeEventListener('scroll', handleWindowChange, true)
})
</script>

<style scoped>
.native-popconfirm {
  position: relative;
  display: inline-block;
}

.native-popconfirm__trigger {
  display: inline-block;
  outline: none;
}

.native-popconfirm__trigger:focus-visible {
  outline: 2px solid #0052d9;
  outline-offset: 2px;
}

.native-popconfirm__popup {
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  padding: 12px 16px;
  min-width: 200px;
}

.native-popconfirm__content {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 12px;
}

.native-popconfirm__icon {
  flex-shrink: 0;
  color: #ed7b2f;
}

.native-popconfirm__message {
  font-size: 14px;
  color: #333;
  line-height: 1.5;
}

.native-popconfirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.native-popconfirm__btn {
  padding: 6px 16px;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid #dcdcdc;
  background: #fff;
  outline: none;
}

.native-popconfirm__btn:focus-visible {
  outline: 2px solid #0052d9;
  outline-offset: 2px;
}

.native-popconfirm__btn--cancel {
  color: #666;
}

.native-popconfirm__btn--cancel:hover {
  border-color: #0052d9;
  color: #0052d9;
}

.native-popconfirm__btn--confirm {
  background: #0052d9;
  border-color: #0052d9;
  color: #fff;
}

.native-popconfirm__btn--confirm:hover {
  background: #003bb3;
  border-color: #003bb3;
}

.native-popconfirm__btn--warning {
  background: #ed7b2f;
  border-color: #ed7b2f;
}

.native-popconfirm__btn--warning:hover {
  background: #d9661a;
  border-color: #d9661a;
}

.native-popconfirm__btn--danger {
  background: #e34d59;
  border-color: #e34d59;
}

.native-popconfirm__btn--danger:hover {
  background: #d13b47;
  border-color: #d13b47;
}

/* 箭头 */
.native-popconfirm__arrow {
  position: absolute;
  width: 8px;
  height: 8px;
  background: #fff;
  transform: rotate(45deg);
}

.native-popconfirm--top .native-popconfirm__arrow {
  bottom: -4px;
  left: 50%;
  margin-left: -4px;
  box-shadow: 2px 2px 4px rgba(0, 0, 0, 0.05);
}

.native-popconfirm--bottom .native-popconfirm__arrow {
  top: -4px;
  left: 50%;
  margin-left: -4px;
  box-shadow: -2px -2px 4px rgba(0, 0, 0, 0.05);
}

.native-popconfirm--left .native-popconfirm__arrow {
  right: -4px;
  top: 50%;
  margin-top: -4px;
  box-shadow: 2px -2px 4px rgba(0, 0, 0, 0.05);
}

.native-popconfirm--right .native-popconfirm__arrow {
  left: -4px;
  top: 50%;
  margin-top: -4px;
  box-shadow: -2px 2px 4px rgba(0, 0, 0, 0.05);
}

/* 动画 */
.native-popconfirm-enter-active,
.native-popconfirm-leave-active {
  transition: all 0.2s ease;
}

.native-popconfirm-enter-from,
.native-popconfirm-leave-to {
  opacity: 0;
  transform: scale(0.9);
}

.native-popconfirm-enter-active.native-popconfirm--top,
.native-popconfirm-leave-active.native-popconfirm--top {
  transform-origin: bottom center;
}

.native-popconfirm-enter-active.native-popconfirm--bottom,
.native-popconfirm-leave-active.native-popconfirm--bottom {
  transform-origin: top center;
}

.native-popconfirm-enter-active.native-popconfirm--left,
.native-popconfirm-leave-active.native-popconfirm--left {
  transform-origin: right center;
}

.native-popconfirm-enter-active.native-popconfirm--right,
.native-popconfirm-leave-active.native-popconfirm--right {
  transform-origin: left center;
}
</style>
