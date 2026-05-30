<template>
  <div class="native-dropdown" :class="{ 'native-dropdown--disabled': disabled }">
    <!-- 触发元素 -->
    <div 
      ref="triggerRef"
      class="native-dropdown__trigger"
      @click="handleClick"
      @mouseenter="handleMouseEnter"
      @mouseleave="handleMouseLeave"
    >
      <slot></slot>
    </div>
    
    <!-- 下拉菜单 -->
    <Teleport to="body">
      <Transition name="dropdown-fade">
        <div
          v-if="visible"
          ref="menuRef"
          class="native-dropdown__menu"
          :class="[`native-dropdown--${placement}`, { 'native-dropdown--arrow': arrow }]"
          :style="menuStyle"
          @mouseenter="handleMenuEnter"
          @mouseleave="handleMenuLeave"
        >
          <div class="native-dropdown__content">
            <slot name="dropdown">
              <div
                v-for="(item, index) in options"
                :key="index"
                class="native-dropdown__item"
                :class="{
                  'native-dropdown__item--disabled': item.disabled,
                  'native-dropdown__item--divided': item.divided,
                  'native-dropdown__item--active': activeIndex === index
                }"
                @click="handleItemClick(item, index)"
              >
                <NativeIcon v-if="item.icon" :name="item.icon" size="14" />
                <span>{{ item.label }}</span>
              </div>
            </slot>
          </div>
          <div v-if="arrow" class="native-dropdown__arrow"></div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import NativeIcon from './NativeIcon.vue'

const props = defineProps({
  options: { type: Array, default: () => [] },
  placement: { type: String, default: 'bottom' }, // top, bottom, left, right
  trigger: { type: String, default: 'click' }, // click, hover
  disabled: { type: Boolean, default: false },
  arrow: { type: Boolean, default: true },
  hideOnClick: { type: Boolean, default: true },
  maxHeight: { type: [String, Number], default: '300px' }
})

const emit = defineEmits(['click', 'command', 'visibleChange'])

const triggerRef = ref(null)
const menuRef = ref(null)
const visible = ref(false)
const menuStyle = ref({})
const activeIndex = ref(-1)

let hideTimer = null

// 显示菜单
function show() {
  if (props.disabled) return
  clearTimeout(hideTimer)
  visible.value = true
  emit('visibleChange', true)
  // 使用 requestAnimationFrame 确保 DOM 已渲染
  requestAnimationFrame(() => {
    updatePosition()
    // 再次更新以确保位置正确
    requestAnimationFrame(() => {
      updatePosition()
    })
  })
}

// 隐藏菜单
function hide() {
  hideTimer = setTimeout(() => {
    visible.value = false
    emit('visibleChange', false)
    activeIndex.value = -1
  }, 100)
}

// 切换显示
function toggle() {
  if (visible.value) {
    hide()
  } else {
    show()
  }
}

// 更新菜单位置
function updatePosition() {
  if (!triggerRef.value || !menuRef.value) return

  const triggerRect = triggerRef.value.getBoundingClientRect()
  const menuRect = menuRef.value.getBoundingClientRect()

  // 如果菜单尺寸为0，使用最小宽度（首次渲染时）
  const menuWidth = menuRect.width > 0 ? menuRect.width : 120
  const menuHeight = menuRect.height > 0 ? menuRect.height : 100

  let top = 0
  let left = 0

  switch (props.placement) {
    case 'bottom':
      top = triggerRect.bottom + 8
      left = triggerRect.left + (triggerRect.width - menuWidth) / 2
      break
    case 'top':
      top = triggerRect.top - menuHeight - 8
      left = triggerRect.left + (triggerRect.width - menuWidth) / 2
      break
    case 'left':
      top = triggerRect.top + (triggerRect.height - menuHeight) / 2
      left = triggerRect.left - menuWidth - 8
      break
    case 'right':
      top = triggerRect.top + (triggerRect.height - menuHeight) / 2
      left = triggerRect.right + 8
      break
  }

  menuStyle.value = {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
    zIndex: 9999,
    maxHeight: typeof props.maxHeight === 'number' ? `${props.maxHeight}px` : props.maxHeight
  }
}

// 事件处理
function handleClick() {
  if (props.trigger === 'click') {
    toggle()
  }
}

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

function handleMenuEnter() {
  clearTimeout(hideTimer)
}

function handleMenuLeave() {
  if (props.trigger === 'hover') {
    hide()
  }
}

function handleItemClick(item, index) {
  if (item.disabled) return
  
  activeIndex.value = index
  emit('click', item, index)
  emit('command', item.command || item.value || item.label)
  
  if (props.hideOnClick) {
    hide()
  }
}

// 点击外部关闭
function handleDocumentClick(e) {
  if (!triggerRef.value?.contains(e.target) && !menuRef.value?.contains(e.target)) {
    hide()
  }
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
})

onUnmounted(() => {
  document.removeEventListener('click', handleDocumentClick)
})

defineExpose({
  show,
  hide,
  toggle
})
</script>

<style scoped>
.native-dropdown {
  display: inline-block;
  position: relative;
}

.native-dropdown__trigger {
  display: inline-flex;
  cursor: pointer;
}

.native-dropdown--disabled .native-dropdown__trigger {
  cursor: not-allowed;
  opacity: 0.6;
}

.native-dropdown__menu {
  background: #fff;
  border-radius: 6px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  overflow: hidden;
  min-width: 120px;
}

.native-dropdown__content {
  padding: 4px 0;
  overflow-y: auto;
}

.native-dropdown__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 14px;
  color: #333;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.native-dropdown__item:hover:not(.native-dropdown__item--disabled) {
  background: #f5f5f5;
  color: #0052d9;
}

.native-dropdown__item--disabled {
  color: #ccc;
  cursor: not-allowed;
}

.native-dropdown__item--divided {
  border-top: 1px solid #e8e8e8;
  margin-top: 4px;
  padding-top: 8px;
}

.native-dropdown__item--active {
  background: #e6f7ff;
  color: #0052d9;
}

/* 箭头 */
.native-dropdown__arrow {
  position: absolute;
  width: 0;
  height: 0;
  border: 6px solid transparent;
}

.native-dropdown--bottom .native-dropdown__arrow {
  top: -12px;
  left: 50%;
  transform: translateX(-50%);
  border-bottom-color: #fff;
  border-top: 0;
}

.native-dropdown--top .native-dropdown__arrow {
  bottom: -12px;
  left: 50%;
  transform: translateX(-50%);
  border-top-color: #fff;
  border-bottom: 0;
}

.native-dropdown--left .native-dropdown__arrow {
  right: -12px;
  top: 50%;
  transform: translateY(-50%);
  border-left-color: #fff;
  border-right: 0;
}

.native-dropdown--right .native-dropdown__arrow {
  left: -12px;
  top: 50%;
  transform: translateY(-50%);
  border-right-color: #fff;
  border-left: 0;
}

/* 动画 */
.dropdown-fade-enter-active,
.dropdown-fade-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}

.dropdown-fade-enter-from,
.dropdown-fade-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
