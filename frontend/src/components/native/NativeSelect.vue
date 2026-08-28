<template>
  <SelectRoot
    v-if="useRekaSelect"
    :model-value="rekaModelValue"
    :disabled="disabled"
    @update:model-value="handleRekaValueChange"
    @update:open="rekaOpen = $event"
  >
    <div
      v-bind="attrs"
      class="native-select native-select--reka"
      :class="[
        attrs.class,
        {
          'native-select--open': rekaOpen,
          'native-select--clearable': clearable && hasSingleValue,
          [`native-select--${size}`]: true
        }
      ]"
    >
      <SelectTrigger
        class="native-select__trigger"
        :class="{ 'native-select--disabled': disabled }"
        :aria-label="attrs['aria-label'] || placeholder"
      >
        <span class="native-select__label">{{ selectedLabel }}</span>
        <span class="native-select__arrow">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </span>
      </SelectTrigger>
      <button
        v-if="clearable && hasSingleValue && !disabled"
        type="button"
        class="native-select__clear native-select__clear--reka"
        aria-label="清除选择"
        @pointerdown.prevent.stop
        @click.stop="clearSelection"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
      </button>
      <SelectPortal>
        <SelectContent
          class="native-select__dropdown native-select__dropdown--reka"
          position="popper"
          :side-offset="4"
          :collision-padding="8"
          :body-lock="false"
        >
          <SelectViewport class="native-select__options-list">
            <SelectItem
              v-for="(option, index) in options"
              :key="optionToken(index)"
              class="native-select__option"
              :class="{ 'native-select__option--selected': option.value === modelValue }"
              :value="optionToken(index)"
              :disabled="option.disabled"
            >
              <SelectItemText>{{ option.label }}</SelectItemText>
            </SelectItem>
            <div v-if="options.length === 0" class="native-select__empty">{{ emptyText }}</div>
          </SelectViewport>
        </SelectContent>
      </SelectPortal>
    </div>
  </SelectRoot>

  <div v-else ref="selectRef" v-bind="attrs" class="native-select" :class="[attrs.class, { 'native-select--open': isOpen, 'native-select--multiple': multiple, 'native-select--filterable': filterable, [`native-select--${size}`]: true }]">
    <div 
      ref="triggerRef"
      class="native-select__trigger" 
      :class="{ 'native-select--disabled': disabled }"
      :tabindex="disabled ? -1 : 0"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="isOpen ? 'true' : 'false'"
      :aria-controls="listboxId"
      :aria-activedescendant="activeDescendantId || undefined"
      :aria-disabled="disabled ? 'true' : undefined"
      :aria-label="attrs['aria-label'] || placeholder"
      @click="handleTriggerClick"
      @keydown="handleTriggerKeydown"
    >
      <template v-if="multiple">
        <div v-if="selectedValues.length > 0" class="native-select__tags">
          <span v-for="val in selectedValues.slice(0, maxTagCount)" :key="val" class="native-select__tag">
            {{ getOptionLabel(val) }}
            <button
              type="button"
              class="native-select__tag-close"
              :aria-label="`移除${getOptionLabel(val)}`"
              @click.stop="removeTag(val)"
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
            </button>
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
            :aria-controls="listboxId"
            :aria-autocomplete="'list'"
            :aria-activedescendant="activeDescendantId || undefined"
            @click.stop
            @keydown="handleFilterKeydown"
          >
        </span>
        <span v-else class="native-select__label">{{ selectedLabel }}</span>
      </template>
      <button
      v-if="clearable && !disabled && (multiple ? selectedValues.length > 0 : hasSingleValue)"
        type="button"
        class="native-select__clear"
        aria-label="清除选择"
        @click.stop="clearSelection"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      </button>
      <span class="native-select__arrow" :class="{ 'native-select__arrow--clearable': clearable && (multiple ? selectedValues.length > 0 : hasSingleValue) }">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M7 10l5 5 5-5z"/>
        </svg>
      </span>
    </div>
    <Teleport to="body">
      <div v-if="isOpen" ref="dropdownRef" class="native-select__dropdown" :style="dropdownStyle" @click.stop>
        <div v-if="filterable" class="native-select__filter-dropdown">
          <input 
            ref="dropdownFilterInput"
            v-model="filterText"
            type="text"
            class="native-select__filter-input-dropdown"
            :placeholder="filterPlaceholder"
            :aria-controls="listboxId"
            :aria-autocomplete="'list'"
            :aria-activedescendant="activeDescendantId || undefined"
            @keydown="handleFilterKeydown"
          >
        </div>
        <div
          :id="listboxId"
          class="native-select__options-list"
          role="listbox"
          :aria-label="placeholder"
          :aria-multiselectable="multiple ? 'true' : undefined"
        >
          <div
            v-for="(option, index) in filteredOptions"
            :key="option.value"
            :id="optionId(option, index)"
            :ref="element => setOptionRef(element, index)"
            class="native-select__option"
            :class="{ 
              'native-select__option--selected': isOptionSelected(option),
              'native-select__option--active': activeIndex === index,
              'native-select__option--multiple': multiple,
              'native-select__option--disabled': option.disabled
            }"
            role="option"
            :aria-selected="isOptionSelected(option) ? 'true' : 'false'"
            :aria-disabled="option.disabled ? 'true' : undefined"
            @mouseenter="handleOptionMouseEnter(index)"
            @click="selectOption(option, index)"
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
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onUnmounted, useAttrs } from 'vue'
import {
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectViewport
} from 'reka-ui'
import {
  findFirstEnabledIndex,
  moveListboxActiveIndex
} from '@/utils/listboxNavigation'

let selectInstanceSeed = 0

defineOptions({ inheritAttrs: false })

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
const attrs = useAttrs()

const hasSingleValue = computed(() => (
  props.modelValue !== '' && props.modelValue !== null && props.modelValue !== undefined
))
const useRekaSelect = computed(() => !props.filterable && !props.multiple)
const rekaOpen = ref(false)
const optionToken = index => `native-select-option-${index}`
const rekaModelValue = computed(() => {
  if (!hasSingleValue.value) return undefined
  const index = props.options.findIndex(option => option.value === props.modelValue)
  return index >= 0 ? optionToken(index) : undefined
})

function handleRekaValueChange(token) {
  const index = Number.parseInt(String(token).replace('native-select-option-', ''), 10)
  const option = props.options[index]
  if (!option || option.disabled) return
  emit('update:modelValue', option.value)
  emit('change', option.value)
}

const isOpen = ref(false)
const filterText = ref('')
const filterInput = ref(null)
const selectRef = ref(null)
const dropdownRef = ref(null)
const dropdownStyle = ref({})
const scrollParents = ref([])
const triggerRef = ref(null)
const dropdownFilterInput = ref(null)
const activeIndex = ref(-1)
const optionRefs = ref([])
const selectInstanceId = ++selectInstanceSeed
const listboxId = `native-select-listbox-${selectInstanceId}`
let resizeObserver = null

// 文档点击处理器 - 用于点击外部关闭
function documentClickHandler(event) {
  if (!isOpen.value) return
  
  const target = event.target
  
  // 如果点击的是 trigger 元素或其子元素，不处理（由 trigger 的点击事件处理）
  if (triggerRef.value && triggerRef.value.contains(target)) return
  
  // 如果点击的是 dropdown 元素或其子元素，不关闭
  // 由于 dropdown 被 Teleport 到 body，需要通过 ref 检查
  if (dropdownRef.value && dropdownRef.value.contains(target)) return
  
  // 点击了外部，关闭下拉框
  close()
}

const selectedValues = computed(() => {
  if (props.multiple) {
    return Array.isArray(props.modelValue) ? props.modelValue : []
  }
  return hasSingleValue.value ? [props.modelValue] : []
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

const activeDescendantId = computed(() => {
  if (!isOpen.value || activeIndex.value < 0) return ''

  const option = filteredOptions.value[activeIndex.value]
  return option && !option.disabled ? optionId(option, activeIndex.value) : ''
})

function getOptionLabel(value) {
  const option = props.options.find(o => o.value === value)
  return option ? option.label : value
}

function optionId(option, filteredIndex = 0) {
  const sourceIndex = props.options.findIndex(item => item === option)
  const identity = option?.value !== undefined
    ? `value-${String(option.value)}`
    : `index-${sourceIndex >= 0 ? sourceIndex : filteredIndex}`
  return `${listboxId}-option-${encodeURIComponent(identity)}`
}

function setOptionRef(element, index) {
  if (element) {
    optionRefs.value[index] = element
  } else {
    optionRefs.value[index] = null
  }
}

function isOptionSelected(option) {
  if (props.multiple) {
    return selectedValues.value.includes(option.value)
  }
  return props.modelValue === option.value
}

function highlightMatch(label) {
  const escapedLabel = String(label)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
  if (!props.filterable || !filterText.value) return escapedLabel
  const searchText = filterText.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${searchText})`, 'gi')
  return escapedLabel.replace(regex, '<mark>$1</mark>')
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

function initialActiveIndex() {
  const selectedIndex = filteredOptions.value.findIndex(option => (
    isOptionSelected(option) && !option.disabled
  ))
  return selectedIndex >= 0 ? selectedIndex : findFirstEnabledIndex(filteredOptions.value)
}

function scrollActiveOption() {
  const element = optionRefs.value[activeIndex.value]
  if (!element || typeof element.scrollIntoView !== 'function') return

  try {
    element.scrollIntoView({ block: 'nearest' })
  } catch {
    // Some embedded browsers expose scrollIntoView without accepting options.
    element.scrollIntoView()
  }
}

function open() {
  if (props.disabled || isOpen.value) return

  isOpen.value = true
  filterText.value = ''
  activeIndex.value = initialActiveIndex()
  optionRefs.value = []

  // 延迟添加 document 监听，避免当前点击事件立即触发关闭
  nextTick(() => {
    document.addEventListener('click', documentClickHandler)
    updateDropdownPosition()

    if (props.filterable) {
      const input = props.multiple ? dropdownFilterInput.value : filterInput.value
      input?.focus()
    } else {
      triggerRef.value?.focus({ preventScroll: true })
    }
  })
  startPositionListeners()
}

function close({ focusTrigger = false } = {}) {
  isOpen.value = false
  filterText.value = ''
  activeIndex.value = -1
  optionRefs.value = []
  stopPositionListeners()
  document.removeEventListener('click', documentClickHandler)

  if (focusTrigger) {
    nextTick(() => triggerRef.value?.focus({ preventScroll: true }))
  }
}

function handleTriggerClick() {
  if (props.disabled) return
  if (isOpen.value) {
    close()
  } else {
    open()
  }
}

function isFilterInputTarget(event) {
  return event.target === filterInput.value || event.target === dropdownFilterInput.value
}

function selectActiveOption() {
  const option = filteredOptions.value[activeIndex.value]
  if (option && !option.disabled) {
    selectOption(option, activeIndex.value)
  }
}

function handleKeyboardEvent(event) {
  if (props.disabled) return

  const { key } = event
  const isFilterInput = isFilterInputTarget(event)

  // Filter inputs keep regular text entry semantics. Space/Home/End are
  // characters/caret navigation there, while the trigger owns list navigation.
  if (isFilterInput && isOpen.value && (key === ' ' || key === 'Space' || key === 'Spacebar' || key === 'Home' || key === 'End')) {
    return
  }

  if (key === 'Tab') {
    if (isOpen.value) close()
    return
  }

  if (key === 'Escape' || key === 'Esc') {
    if (isOpen.value) {
      event.preventDefault()
      close({ focusTrigger: true })
    }
    return
  }

  if (key === 'Enter' || key === ' ' || key === 'Space' || key === 'Spacebar') {
    event.preventDefault()
    if (!isOpen.value) {
      open()
    } else {
      selectActiveOption()
    }
    return
  }

  if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
    event.preventDefault()
    if (!isOpen.value) {
      open()

      // Opening already chooses the selected option or the first enabled
      // option. Do not advance again for ArrowDown; ArrowUp has an explicit
      // closed-state boundary and starts at the last enabled option.
      if (key === 'ArrowUp' || key === 'Home' || key === 'End') {
        activeIndex.value = moveListboxActiveIndex(filteredOptions.value, -1, key)
      }
      return
    }

    activeIndex.value = moveListboxActiveIndex(filteredOptions.value, activeIndex.value, key)
  }
}

function handleTriggerKeydown(event) {
  handleKeyboardEvent(event)
}

function handleFilterKeydown(event) {
  handleKeyboardEvent(event)
}

function handleOptionMouseEnter(index) {
  const option = filteredOptions.value[index]
  if (option && !option.disabled) activeIndex.value = index
}

function selectOption(option, index = -1) {
  if (option.disabled) return

  if (index >= 0) activeIndex.value = index
  
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
    close({ focusTrigger: true })
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

watch(filteredOptions, (options, previousOptions = []) => {
  optionRefs.value = []
  if (!isOpen.value) {
    activeIndex.value = -1
    return
  }

  const previousActive = previousOptions[activeIndex.value]
  const retainedIndex = previousActive
    ? options.findIndex(option => option.value === previousActive.value)
    : -1

  if (retainedIndex >= 0 && !options[retainedIndex].disabled) {
    activeIndex.value = retainedIndex
    return
  }

  activeIndex.value = initialActiveIndex()
})

watch(activeIndex, () => {
  if (isOpen.value) nextTick(scrollActiveOption)
})

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
  width: 100%;
  padding: 6px 12px;
  border: 1px solid var(--color-border-default);
  border-radius: 6px;
  background: var(--color-surface-raised);
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
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
  border-color: var(--color-primary);
}

.native-select__trigger:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.native-select--open .native-select__trigger {
  border-color: var(--color-primary);
}

.native-select--disabled {
  background: var(--color-surface-subtle);
  cursor: not-allowed;
  opacity: 0.6;
}

.native-select__label {
  font-size: 14px;
  color: var(--color-text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.native-select__placeholder {
  font-size: 14px;
  color: var(--color-text-muted);
  flex: 1;
}

.native-select__arrow {
  color: var(--color-text-muted);
  transition: transform 0.2s;
  flex-shrink: 0;
}

.native-select--open .native-select__arrow {
  transform: rotate(180deg);
}

.native-select__dropdown {
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-default);
  border-radius: 6px;
  box-shadow: var(--shadow-md);
  max-height: 200px;
  overflow-y: auto;
  z-index: 10000;
}

.native-select__dropdown--reka {
  width: var(--reka-select-trigger-width);
  max-height: var(--reka-select-content-available-height);
}

.native-select--reka.native-select--clearable .native-select__trigger {
  padding-right: 56px;
}

.native-select__clear--reka {
  position: absolute;
  top: 50%;
  right: 28px;
  z-index: 1;
  transform: translateY(-50%);
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
  background: var(--color-surface-subtle);
}

.native-select__option[data-highlighted] {
  background: var(--color-primary-surface);
  outline: none;
}

.native-select__option--active {
  background: var(--color-primary-surface);
}

.native-select__option--selected {
  background: var(--color-primary-surface);
  color: var(--color-primary);
}

.native-select__checkbox {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border-default);
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.native-select__option--selected .native-select__checkbox {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-text-inverse);
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
  background: var(--color-primary-surface);
  color: var(--color-primary);
  border-radius: 4px;
  font-size: 12px;
}

.native-select__tag-close {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  transition: opacity 0.2s;
}

.native-select__tag-close:focus-visible,
.native-select__clear:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 1px;
}

.native-select__tag-close:hover {
  opacity: 1;
}

.native-select__tag--more {
  background: var(--color-surface-subtle);
  color: var(--color-text-secondary);
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
  color: var(--color-text-primary);
  outline: none;
  padding: 0;
}

.native-select__filter-dropdown {
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.native-select__filter-input-dropdown {
  width: 100%;
  padding: 6px 12px;
  border: 1px solid var(--color-border-default);
  border-radius: 4px;
  font-size: 14px;
  outline: none;
}

.native-select__filter-input-dropdown:focus {
  border-color: var(--color-primary);
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
  background: var(--color-warning-surface);
  color: var(--color-warning-text);
  padding: 0 2px;
  border-radius: 2px;
}

.native-select__empty {
  padding: 16px;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 14px;
}

.native-select__clear {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  margin-right: 4px;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font: inherit;
  opacity: 0.6;
  transition: opacity 0.2s;
}

.native-select__clear:hover {
  opacity: 1;
  color: var(--color-text-secondary);
}

.native-select__arrow--clearable {
  margin-left: 0;
}
</style>
