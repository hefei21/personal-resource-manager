<template>
  <div ref="selectRef" class="native-select" :class="{ 'native-select--open': isOpen, 'native-select--multiple': multiple, 'native-select--filterable': filterable, [`native-select--${size}`]: true }">
    <div 
      ref="triggerRef"
      class="native-select__trigger" 
      :class="{ 'native-select--disabled': disabled }"
      @click="handleTriggerClick"
    >
      <template v-if="multiple">
        <div v-if="selectedValues.length > 0" class="native-select__tags">
          <span v-for="val in selectedValues.slice(0, maxTagCount)" :key="val" class="native-select__tag">
            {{ getOptionLabel(val) }}
            <span class="native-select__tag-close" @click.stop="removeTag(val)">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
            </span>
          </span>
          <span v-if="selectedValues.length > maxTagCount" class="native-select__tag native-select__tag--more">
            +{{ selectedValues.length - maxTagCount }}
          </span>
        </div>
        <span v-else class="native-select__placeholder">{{ placeholder }}</span>
      </template>
      <template v-else>
        <span v-if="filterable && isOpen" class="native-select__filter-wrapper">
          <input 
            ref="filterInput"
            v-model="filterText"
            type="text"
            class="native-select__filter-input"
            :placeholder="selectedLabel"
            @click.stop
          >
        </span>
        <span v-else class="native-select__label">{{ selectedLabel }}</span>
      </template>
      <span v-if="clearable && (multiple ? modelValue.length > 0 : modelValue)" class="native-select__clear" @click.stop="clearSelection">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      </span>
      <span class="native-select__arrow" :class="{ 'native-select__arrow--clearable': clearable && (multiple ? modelValue.length > 0 : modelValue) }">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M7 10l5 5 5-5z"/>
        </svg>
      </span>
    </div>
    <div v-if="isOpen" ref="dropdownRef" class="native-select__dropdown" :style="dropdownStyle">
      <div v-if="filterable" class="native-select__filter-dropdown">
        <input 
          v-model="filterText"
          type="text"
          class="native-select__filter-input-dropdown"
          :placeholder="filterPlaceholder"
        >
      </div>
      <div class="native-select__options-list">
        <div
          v-for="option in filteredOptions"
          :key="option.value"
          class="native-select__option"
          :class="{ 
            'native-select__option--selected': isOptionSelected(option),
            'native-select__option--multiple': multiple,
            'native-select__option--disabled': option.disabled
          }"
          @click="selectOption(option)"
        >
          <span v-if="multiple" class="native-select__checkbox">
            <svg v-if="isOptionSelected(option)" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
          </span>
          <span class="native-select__option-label" v-html="highlightMatch(option.label)"></span>
        </div>
        <div v-if="filteredOptions.length === 0" class="native-select__empty">
          {{ emptyText }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'

// 获取所有可滚动的祖先元素
function getScrollParents(element) {
  const scrollParents = []
  let parent = element.parentElement
  
  while (parent) {
    const style = window.getComputedStyle(parent)
    const overflow = style.overflow + style.overflowX + style.overflowY
    if (/(auto|scroll|hidden)/.test(overflow)) {
      scrollParents.push(parent)
    }
    parent = parent.parentElement
  }
  
  scrollParents.push(window)
  return scrollParents
}

const props = defineProps({
  modelValue: { type: [String, Number, Array], default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '请选择' },
  disabled: { type: Boolean, default: false },
  multiple: { type: Boolean, default: false },
  clearable: { type: Boolean, default: false },
  filterable: { type: Boolean, default: false },
  maxTagCount: { type: Number, default: 3 },
  emptyText: { type: String, default: '无匹配数据' },
  filterPlaceholder: { type: String, default: '搜索...' },
  filterMethod: { type: Function, default: null },
  size: { type: String, default: 'medium' } // small, medium, large
})

const emit = defineEmits(['update:modelValue', 'change'])

const isOpen = ref(false)
const filterText = ref('')
const filterInput = ref(null)
const selectRef = ref(null)
const dropdownRef = ref(null)
const dropdownStyle = ref({})
const scrollParents = ref([])
const triggerRef = ref(null)
let resizeObserver = null

// 文档点击处理器 - 用于点击外部关闭
function documentClickHandler(event) {
  if (!isOpen.value) return
  
  const target = event.target
  
  // 如果点击的是 trigger 元素或其子元素，不处理（由 trigger 的点击事件处理）
  if (triggerRef.value && triggerRef.value.contains(target)) return
  
  // 如果点击的是 dropdown 元素或其子元素，不关闭
  if (dropdownRef.value && dropdownRef.value.contains(target)) return
  
  // 点击了外部，关闭下拉框
  close()
}

const selectedValues = computed(() => {
  if (props.multiple) {
    return Array.isArray(props.modelValue) ? props.modelValue : []
  }
  return props.modelValue ? [props.modelValue] : []
})

const selectedLabel = computed(() => {
  if (props.multiple) {
    const labels = selectedValues.value.map(v => getOptionLabel(v))
    return labels.join(', ') || props.placeholder
  }
  const option = props.options.find(o => o.value === props.modelValue)
  return option ? option.label : props.placeholder
})

const filteredOptions = computed(() => {
  if (!props.filterable || !filterText.value) {
    return props.options
  }
  
  if (props.filterMethod) {
    return props.options.filter(opt => props.filterMethod(filterText.value, opt))
  }
  
  const searchText = filterText.value.toLowerCase()
  return props.options.filter(opt => 
    String(opt.label).toLowerCase().includes(searchText) ||
    String(opt.value).toLowerCase().includes(searchText)
  )
})

function getOptionLabel(value) {
  const option = props.options.find(o => o.value === value)
  return option ? option.label : value
}

function isOptionSelected(option) {
  if (props.multiple) {
    return selectedValues.value.includes(option.value)
  }
  return props.modelValue === option.value
}

function highlightMatch(label) {
  if (!props.filterable || !filterText.value) return label
  const searchText = filterText.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${searchText})`, 'gi')
  return String(label).replace(regex, '<mark>$1</mark>')
}

// 开始监听位置变化（滚动、resize、元素大小变化）
function startPositionListeners() {
  if (!selectRef.value) return
  
  // 获取所有可滚动祖先
  scrollParents.value = getScrollParents(selectRef.value)
  
  // 监听滚动
  scrollParents.value.forEach(parent => {
    if (parent === window) {
      window.addEventListener('scroll', handlePositionChange, true)
    } else {
      parent.addEventListener('scroll', handlePositionChange)
    }
  })
  
  // 监听 resize
  window.addEventListener('resize', handlePositionChange)
  
  // 使用 ResizeObserver 监听元素大小变化
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (isOpen.value) {
        updateDropdownPosition()
      }
    })
    resizeObserver.observe(selectRef.value)
  }
}

// 停止监听
function stopPositionListeners() {
  scrollParents.value.forEach(parent => {
    if (parent === window) {
      window.removeEventListener('scroll', handlePositionChange, true)
    } else {
      parent.removeEventListener('scroll', handlePositionChange)
    }
  })
  
  window.removeEventListener('resize', handlePositionChange)
  
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  
  scrollParents.value = []
}

// 位置变化处理
function handlePositionChange() {
  if (isOpen.value) {
    updateDropdownPosition()
  }
}

// 计算 dropdown 位置（使用 fixed 定位突破父容器限制）
function updateDropdownPosition() {
  if (!selectRef.value) return
  
  const rect = selectRef.value.getBoundingClientRect()
  const viewportHeight = window.innerHeight
  const dropdownHeight = Math.min(250, viewportHeight * 0.4) // 最大高度为视口的 40%
  const spaceBelow = viewportHeight - rect.bottom
  const spaceAbove = rect.top
  
  let top, maxHeight, isUpward = false
  
  // 决定向上还是向下展开
  if (spaceBelow >= dropdownHeight) {
    // 下方空间足够，向下展开
    top = rect.bottom + 4
    maxHeight = Math.min(dropdownHeight, spaceBelow - 8)
  } else if (spaceAbove >= dropdownHeight) {
    // 上方空间足够，向上展开
    isUpward = true
    top = rect.top - 4 // 初始位置，等实际渲染后再调整
    maxHeight = Math.min(dropdownHeight, spaceAbove - 8)
  } else {
    // 两边都不够，选择空间较大的一边
    if (spaceBelow > spaceAbove) {
      top = rect.bottom + 4
      maxHeight = Math.max(100, spaceBelow - 8)
    } else {
      isUpward = true
      top = rect.top - 4
      maxHeight = Math.max(100, spaceAbove - 8)
    }
  }
  
  dropdownStyle.value = {
    position: 'fixed',
    left: `${rect.left}px`,
    top: isUpward ? undefined : `${top}px`,
    bottom: isUpward ? `${viewportHeight - rect.top + 4}px` : undefined,
    width: `${rect.width}px`,
    maxHeight: `${maxHeight}px`,
    zIndex: 10000
  }
}

function close() {
  isOpen.value = false
  filterText.value = ''
  stopPositionListeners()
  document.removeEventListener('click', documentClickHandler)
}

function handleTriggerClick(e) {
  if (props.disabled) return
  isOpen.value = !isOpen.value
  
  if (isOpen.value) {
    // 延迟添加 document 监听，避免当前点击事件立即触发关闭
    nextTick(() => {
      document.addEventListener('click', documentClickHandler)
    })
    startPositionListeners()
    nextTick(() => {
      updateDropdownPosition()
      if (props.filterable) {
        filterInput.value?.focus()
      }
    })
  } else {
    stopPositionListeners()
  }
}

function selectOption(option) {
  if (option.disabled) return
  
  if (props.multiple) {
    const currentValues = Array.isArray(props.modelValue) ? [...props.modelValue] : []
    const index = currentValues.indexOf(option.value)
    if (index > -1) {
      currentValues.splice(index, 1)
    } else {
      currentValues.push(option.value)
    }
    emit('update:modelValue', currentValues)
    emit('change', currentValues)
  } else {
    emit('update:modelValue', option.value)
    emit('change', option.value)
    isOpen.value = false
    filterText.value = ''
  }
}

function removeTag(value) {
  if (props.multiple) {
    const currentValues = Array.isArray(props.modelValue) ? [...props.modelValue] : []
    const index = currentValues.indexOf(value)
    if (index > -1) {
      currentValues.splice(index, 1)
      emit('update:modelValue', currentValues)
      emit('change', currentValues)
    }
  }
}

function clearSelection() {
  if (props.multiple) {
    emit('update:modelValue', [])
    emit('change', [])
  } else {
    emit('update:modelValue', '')
    emit('change', '')
  }
  filterText.value = ''
}

onUnmounted(() => {
  stopPositionListeners()
  document.removeEventListener('click', documentClickHandler)
})
</script>

<style scoped>
.native-select {
  position: relative;
  display: inline-block;
  width: 100%;
}

.native-select__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border: 1px solid #dcdcdc;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  transition: all 0.2s;
  min-height: 36px;
  box-sizing: border-box;
}

/* Size variants */
.native-select--small .native-select__trigger {
  height: 32px;
  min-height: 32px;
  padding: 4px 8px;
  font-size: 13px;
  box-sizing: border-box;
}

.native-select--medium .native-select__trigger {
  height: 36px;
  min-height: 36px;
  padding: 6px 12px;
  font-size: 14px;
  box-sizing: border-box;
}

.native-select--large .native-select__trigger {
  height: 40px;
  min-height: 40px;
  padding: 8px 16px;
  font-size: 15px;
  box-sizing: border-box;
}

.native-select__trigger:hover:not(.native-select--disabled) {
  border-color: #0052d9;
}

.native-select--open .native-select__trigger {
  border-color: #0052d9;
}

.native-select--disabled {
  background: #f5f5f5;
  cursor: not-allowed;
  opacity: 0.6;
}

.native-select__label {
  font-size: 14px;
  color: #333;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.native-select__placeholder {
  font-size: 14px;
  color: #999;
  flex: 1;
}

.native-select__arrow {
  color: #999;
  transition: transform 0.2s;
  flex-shrink: 0;
}

.native-select--open .native-select__arrow {
  transform: rotate(180deg);
}

.native-select__dropdown {
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  max-height: 200px;
  overflow-y: auto;
}

.native-select__option {
  padding: 8px 12px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s;
  display: flex;
  align-items: center;
  gap: 8px;
}

.native-select__option:hover {
  background: #f5f5f5;
}

.native-select__option--selected {
  background: #e8f4ff;
  color: #0052d9;
}

.native-select__checkbox {
  width: 16px;
  height: 16px;
  border: 2px solid #dcdcdc;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.native-select__option--selected .native-select__checkbox {
  background: #0052d9;
  border-color: #0052d9;
  color: #fff;
}

.native-select__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: 1;
}

.native-select__tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: #e8f4ff;
  color: #0052d9;
  border-radius: 4px;
  font-size: 12px;
}

.native-select__tag-close {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.2s;
}

.native-select__tag-close:hover {
  opacity: 1;
}

.native-select__tag--more {
  background: #f0f0f0;
  color: #666;
}

/* 过滤功能样式 */
.native-select__filter-wrapper {
  flex: 1;
  min-width: 0;
}

.native-select__filter-input {
  width: 100%;
  border: none;
  background: transparent;
  font-size: 14px;
  color: #333;
  outline: none;
  padding: 0;
}

.native-select__filter-dropdown {
  padding: 8px 12px;
  border-bottom: 1px solid #e8e8e8;
}

.native-select__filter-input-dropdown {
  width: 100%;
  padding: 6px 12px;
  border: 1px solid #dcdcdc;
  border-radius: 4px;
  font-size: 14px;
  outline: none;
}

.native-select__filter-input-dropdown:focus {
  border-color: #0052d9;
}

.native-select__options-list {
  max-height: 200px;
  overflow-y: auto;
}

.native-select__option--disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.native-select__option-label :deep(mark) {
  background: #ffeb3b;
  color: inherit;
  padding: 0 2px;
  border-radius: 2px;
}

.native-select__empty {
  padding: 16px;
  text-align: center;
  color: #999;
  font-size: 14px;
}

.native-select__clear {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  margin-right: 4px;
  color: #999;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.2s;
}

.native-select__clear:hover {
  opacity: 1;
  color: #666;
}

.native-select__arrow--clearable {
  margin-left: 0;
}
</style>
