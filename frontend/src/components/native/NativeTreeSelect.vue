<template>
  <div class="native-tree-select" :class="{ 'native-tree-select--disabled': disabled }">
    <!-- 触发器 -->
    <div 
      ref="triggerRef"
      class="native-tree-select__trigger" 
      @click="toggleOpen"
      :class="{ 'native-tree-select__trigger--active': isOpen }"
    >
      <template v-if="multiple && selectedLabels.length > 0">
        <div class="native-tree-select__tags">
          <span v-for="(label, index) in selectedLabels.slice(0, maxTagCount)" :key="index" class="native-tree-select__tag">
            {{ label }}
            <span class="native-tree-select__tag-close" @click.stop="removeTag(index)">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
              </svg>
            </span>
          </span>
          <span v-if="selectedLabels.length > maxTagCount" class="native-tree-select__tag native-tree-select__tag--more">
            +{{ selectedLabels.length - maxTagCount }}
          </span>
        </div>
      </template>
      <span v-else-if="!multiple && selectedLabel" class="native-tree-select__value">{{ selectedLabel }}</span>
      <span v-else class="native-tree-select__placeholder">{{ placeholder }}</span>
      <NativeIcon name="chevron-down" size="16" class="native-tree-select__arrow" :class="{ 'native-tree-select__arrow--open': isOpen }" />
    </div>
    
    <!-- 下拉面板 -->
    <div v-if="isOpen" ref="dropdownRef" class="native-tree-select__dropdown" v-click-outside="close" :style="dropdownStyle">
      <!-- 搜索框 -->
      <div v-if="filterable" class="native-tree-select__search">
        <NativeIcon name="search" size="14" />
        <input
          v-model="filterText"
          type="text"
          :placeholder="filterPlaceholder"
          @click.stop
        />
      </div>
      
      <!-- 树形列表 -->
      <div class="native-tree-select__tree">
        <TreeNode
          v-for="node in filteredTreeData"
          :key="node[valueKey]"
          :node="node"
          :value-key="valueKey"
          :label-key="labelKey"
          :children-key="childrenKey"
          :multiple="multiple"
          :selected-values="selectedValues"
          :expanded-keys="expandedKeys"
          :level="0"
          @toggle="toggleExpand"
          @select="selectNode"
        />
      </div>
      
      <!-- 空状态 -->
      <div v-if="filteredTreeData.length === 0" class="native-tree-select__empty">
        {{ emptyText }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import NativeIcon from './NativeIcon.vue'
import TreeNode from './NativeTreeNode.vue'

const props = defineProps({
  modelValue: { type: [String, Number, Array], default: '' },
  data: { type: Array, default: () => [] },
  valueKey: { type: String, default: 'value' },
  labelKey: { type: String, default: 'label' },
  childrenKey: { type: String, default: 'children' },
  placeholder: { type: String, default: '请选择' },
  disabled: { type: Boolean, default: false },
  multiple: { type: Boolean, default: false },
  filterable: { type: Boolean, default: false },
  filterPlaceholder: { type: String, default: '搜索...' },
  emptyText: { type: String, default: '暂无数据' },
  maxTagCount: { type: Number, default: 3 },
  defaultExpandedKeys: { type: Array, default: () => [] },
  checkStrictly: { type: Boolean, default: false } // 是否父子节点选中状态不关联
})

const emit = defineEmits(['update:modelValue', 'change'])

const isOpen = ref(false)
const triggerRef = ref(null)
const dropdownRef = ref(null)
const dropdownStyle = ref({})
const filterText = ref('')
const expandedKeys = ref([...props.defaultExpandedKeys])

// 选中的值
const selectedValues = computed(() => {
  if (props.multiple) {
    return Array.isArray(props.modelValue) ? props.modelValue : []
  }
  return props.modelValue ? [props.modelValue] : []
})

// 选中的标签
const selectedLabel = computed(() => {
  const node = findNodeByValue(props.modelValue)
  return node ? node[props.labelKey] : ''
})

const selectedLabels = computed(() => {
  if (!props.multiple) return selectedLabel.value ? [selectedLabel.value] : []
  return selectedValues.value.map(v => {
    const node = findNodeByValue(v)
    return node ? node[props.labelKey] : v
  })
})

// 过滤后的树数据
const filteredTreeData = computed(() => {
  if (!props.filterable || !filterText.value) return props.data
  return filterTree(props.data, filterText.value)
})

// 查找节点
function findNodeByValue(value, nodes = props.data) {
  for (const node of nodes) {
    if (node[props.valueKey] === value) return node
    if (node[props.childrenKey]?.length) {
      const found = findNodeByValue(value, node[props.childrenKey])
      if (found) return found
    }
  }
  return null
}

// 过滤树
function filterTree(nodes, keyword) {
  const result = []
  for (const node of nodes) {
    const children = node[props.childrenKey] || []
    const filteredChildren = filterTree(children, keyword)
    const match = node[props.labelKey].toLowerCase().includes(keyword.toLowerCase())
    
    if (match || filteredChildren.length > 0) {
      result.push({
        ...node,
        [props.childrenKey]: filteredChildren
      })
    }
  }
  return result
}

// 切换展开
function toggleExpand(node) {
  const key = node[props.valueKey]
  const index = expandedKeys.value.indexOf(key)
  if (index > -1) {
    expandedKeys.value.splice(index, 1)
  } else {
    expandedKeys.value.push(key)
  }
}

// 选择节点
function selectNode(node) {
  const value = node[props.valueKey]
  
  if (props.multiple) {
    const values = [...selectedValues.value]
    const index = values.indexOf(value)
    if (index > -1) {
      values.splice(index, 1)
    } else {
      values.push(value)
    }
    emit('update:modelValue', values)
    emit('change', values)
  } else {
    emit('update:modelValue', value)
    emit('change', value)
    close()
  }
}

// 移除标签
function removeTag(index) {
  const values = [...selectedValues.value]
  values.splice(index, 1)
  emit('update:modelValue', values)
  emit('change', values)
}

// 切换下拉
function toggleOpen() {
  if (props.disabled) return
  isOpen.value = !isOpen.value
  if (isOpen.value) {
    nextTick(() => {
      updateDropdownPosition()
    })
  }
}

// 关闭下拉
function close() {
  isOpen.value = false
  filterText.value = ''
}

// 计算下拉位置（使用 fixed 定位）
function updateDropdownPosition() {
  if (!triggerRef.value || !dropdownRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  const dropdownHeight = 300
  const spaceBelow = window.innerHeight - rect.bottom
  const spaceAbove = rect.top
  
  if (spaceBelow < dropdownHeight && spaceAbove > dropdownHeight) {
    dropdownStyle.value = {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.top - Math.min(dropdownHeight, spaceAbove) - 4}px`,
      width: `${rect.width}px`,
      zIndex: 10000
    }
  } else {
    dropdownStyle.value = {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.bottom + 4}px`,
      width: `${rect.width}px`,
      zIndex: 10000
    }
  }
}

// 窗口变化时更新位置
function handleWindowChange() {
  if (isOpen.value) {
    updateDropdownPosition()
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

// 点击外部关闭指令
const vClickOutside = {
  mounted(el, binding) {
    el._clickOutside = (e) => {
      if (!el.contains(e.target)) {
        binding.value()
      }
    }
    document.addEventListener('click', el._clickOutside)
  },
  unmounted(el) {
    document.removeEventListener('click', el._clickOutside)
  }
}
</script>

<style scoped>
.native-tree-select {
  position: relative;
  display: inline-block;
  width: 100%;
}

.native-tree-select--disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.native-tree-select__trigger {
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

.native-tree-select__trigger:hover:not(.native-tree-select--disabled) {
  border-color: #0052d9;
}

.native-tree-select__trigger--active {
  border-color: #0052d9;
}

.native-tree-select__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: 1;
}

.native-tree-select__tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: #e8f4ff;
  color: #0052d9;
  border-radius: 4px;
  font-size: 12px;
}

.native-tree-select__tag-close {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.2s;
}

.native-tree-select__tag-close:hover {
  opacity: 1;
}

.native-tree-select__tag--more {
  background: #f0f0f0;
  color: #666;
}

.native-tree-select__value {
  font-size: 14px;
  color: #333;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.native-tree-select__placeholder {
  font-size: 14px;
  color: #999;
  flex: 1;
}

.native-tree-select__arrow {
  color: #999;
  transition: transform 0.2s;
  flex-shrink: 0;
}

.native-tree-select__arrow--open {
  transform: rotate(180deg);
}

.native-tree-select__dropdown {
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  max-height: 300px;
  overflow-y: auto;
}

.native-tree-select__search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #e8e8e8;
  color: #999;
}

.native-tree-select__search input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 14px;
  color: #333;
}

.native-tree-select__tree {
  padding: 8px 0;
}

.native-tree-select__empty {
  padding: 24px;
  text-align: center;
  color: #999;
  font-size: 14px;
}
</style>
