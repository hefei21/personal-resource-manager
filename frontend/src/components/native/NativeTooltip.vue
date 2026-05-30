<template>
  <div
    ref="triggerRef"
    class="native-tooltip"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
    @focus="handleFocus"
    @blur="handleBlur"
  >
    <slot></slot>
    
    <Teleport to="body">
      <Transition name="tooltip-fade">
        <div
          v-if="visible"
          ref="contentRef"
          class="native-tooltip__content"
          :class="[`native-tooltip--${actualPlacement}`, `native-tooltip--${theme}`]"
          :style="contentStyle"
          role="tooltip"
        >
          <div class="native-tooltip__arrow" aria-hidden="true"></div>
          <div class="native-tooltip__inner">
            <slot name="content">{{ content }}</slot>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  content: { type: String, default: '' },
  placement: { type: String, default: 'top' }, // top, bottom, left, right, top-left, top-right, bottom-left, bottom-right
  theme: { type: String, default: 'dark' }, // dark, light
  trigger: { type: String, default: 'hover' }, // hover, click, focus
  showArrow: { type: Boolean, default: true },
  delay: { type: Number, default: 100 },
  hideDelay: { type: Number, default: 100 },
  disabled: { type: Boolean, default: false },
  zIndex: { type: Number, default: 9999 }
})

const emit = defineEmits(['show', 'hide'])

const triggerRef = ref(null)
const contentRef = ref(null)
const visible = ref(false)
const contentStyle = ref({})
const actualPlacement = ref(props.placement)

let showTimer = null
let hideTimer = null

// 显示
function show() {
  if (props.disabled) return
  clearTimeout(hideTimer)
  showTimer = setTimeout(async () => {
    visible.value = true
    emit('show')
    await nextTick()
    updatePosition()
  }, props.delay)
}

// 隐藏
function hide() {
  clearTimeout(showTimer)
  hideTimer = setTimeout(() => {
    visible.value = false
    emit('hide')
  }, props.hideDelay)
}

// 检测边界并调整位置
function adjustPlacement(triggerRect, contentRect) {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const spacing = 8
  
  let placement = props.placement
  
  // 检测垂直方向
  if (placement.startsWith('top')) {
    if (triggerRect.top < contentRect.height + spacing) {
      placement = placement.replace('top', 'bottom')
    }
  } else if (placement.startsWith('bottom')) {
    if (viewportHeight - triggerRect.bottom < contentRect.height + spacing) {
      placement = placement.replace('bottom', 'top')
    }
  }
  
  // 检测水平方向
  if (placement.endsWith('left')) {
    if (triggerRect.left < contentRect.width / 2) {
      placement = placement.replace('-left', '')
    }
  } else if (placement.endsWith('right')) {
    if (viewportWidth - triggerRect.right < contentRect.width / 2) {
      placement = placement.replace('-right', '')
    }
  }
  
  // 检测整体边界
  if (placement === 'left' && triggerRect.left < contentRect.width + spacing) {
    placement = 'right'
  } else if (placement === 'right' && viewportWidth - triggerRect.right < contentRect.width + spacing) {
    placement = 'left'
  }
  
  return placement
}

// 更新位置
function updatePosition() {
  if (!triggerRef.value || !contentRef.value) return
  
  const triggerRect = triggerRef.value.getBoundingClientRect()
  const contentRect = contentRef.value.getBoundingClientRect()
  
  // 调整位置以避免超出视口
  actualPlacement.value = adjustPlacement(triggerRect, contentRect)
  
  let top = 0
  let left = 0
  const spacing = 8
  
  switch (actualPlacement.value) {
    case 'top':
      top = triggerRect.top - contentRect.height - spacing
      left = triggerRect.left + (triggerRect.width - contentRect.width) / 2
      break
    case 'top-left':
      top = triggerRect.top - contentRect.height - spacing
      left = triggerRect.left
      break
    case 'top-right':
      top = triggerRect.top - contentRect.height - spacing
      left = triggerRect.right - contentRect.width
      break
    case 'bottom':
      top = triggerRect.bottom + spacing
      left = triggerRect.left + (triggerRect.width - contentRect.width) / 2
      break
    case 'bottom-left':
      top = triggerRect.bottom + spacing
      left = triggerRect.left
      break
    case 'bottom-right':
      top = triggerRect.bottom + spacing
      left = triggerRect.right - contentRect.width
      break
    case 'left':
      top = triggerRect.top + (triggerRect.height - contentRect.height) / 2
      left = triggerRect.left - contentRect.width - spacing
      break
    case 'right':
      top = triggerRect.top + (triggerRect.height - contentRect.height) / 2
      left = triggerRect.right + spacing
      break
  }
  
  // 最终边界限制
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  
  if (left < 10) left = 10
  if (left + contentRect.width > viewportWidth - 10) {
    left = viewportWidth - contentRect.width - 10
  }
  if (top < 10) top = 10
  if (top + contentRect.height > viewportHeight - 10) {
    top = viewportHeight - contentRect.height - 10
  }
  
  contentStyle.value = {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
    zIndex: props.zIndex
  }
}

// 事件处理
function handleMouseEnter() {
  if (props.trigger === 'hover') {
    show()
  }
}

function handleMouseLeave() {
  if (props.trigger === 'hover') {
    hide()
  }
}

function handleFocus() {
  if (props.trigger === 'focus') {
    show()
  }
}

function handleBlur() {
  if (props.trigger === 'focus') {
    hide()
  }
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
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
})
</script>

<style scoped>
.native-tooltip {
  display: inline-block;
}

.native-tooltip__content {
  position: fixed;
  pointer-events: none;
}

.native-tooltip__inner {
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.5;
  max-width: 300px;
  word-wrap: break-word;
}

/* 主题 */
.native-tooltip--dark .native-tooltip__inner {
  background: rgba(0, 0, 0, 0.85);
  color: #fff;
}

.native-tooltip--light .native-tooltip__inner {
  background: #fff;
  color: #333;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  border: 1px solid #e8e8e8;
}

/* 箭头 */
.native-tooltip__arrow {
  position: absolute;
  width: 0;
  height: 0;
  border: 6px solid transparent;
}

/* 上方箭头 */
.native-tooltip--top .native-tooltip__arrow,
.native-tooltip--top-left .native-tooltip__arrow,
.native-tooltip--top-right .native-tooltip__arrow {
  bottom: -4px;
  left: 50%;
  transform: translateX(-50%);
  border-top-color: rgba(0, 0, 0, 0.85);
  border-bottom: 0;
}

.native-tooltip--light.native-tooltip--top .native-tooltip__arrow,
.native-tooltip--light.native-tooltip--top-left .native-tooltip__arrow,
.native-tooltip--light.native-tooltip--top-right .native-tooltip__arrow {
  border-top-color: #fff;
}

/* 下方箭头 */
.native-tooltip--bottom .native-tooltip__arrow,
.native-tooltip--bottom-left .native-tooltip__arrow,
.native-tooltip--bottom-right .native-tooltip__arrow {
  top: -4px;
  left: 50%;
  transform: translateX(-50%);
  border-bottom-color: rgba(0, 0, 0, 0.85);
  border-top: 0;
}

.native-tooltip--light.native-tooltip--bottom .native-tooltip__arrow,
.native-tooltip--light.native-tooltip--bottom-left .native-tooltip__arrow,
.native-tooltip--light.native-tooltip--bottom-right .native-tooltip__arrow {
  border-bottom-color: #fff;
}

/* 左方箭头 */
.native-tooltip--left .native-tooltip__arrow {
  right: -4px;
  top: 50%;
  transform: translateY(-50%);
  border-left-color: rgba(0, 0, 0, 0.85);
  border-right: 0;
}

.native-tooltip--light.native-tooltip--left .native-tooltip__arrow {
  border-left-color: #fff;
}

/* 右方箭头 */
.native-tooltip--right .native-tooltip__arrow {
  left: -4px;
  top: 50%;
  transform: translateY(-50%);
  border-right-color: rgba(0, 0, 0, 0.85);
  border-left: 0;
}

.native-tooltip--light.native-tooltip--right .native-tooltip__arrow {
  border-right-color: #fff;
}

/* 动画 */
.tooltip-fade-enter-active,
.tooltip-fade-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.tooltip-fade-enter-from,
.tooltip-fade-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
