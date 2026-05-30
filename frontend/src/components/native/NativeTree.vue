<template>
  <div class="native-tree" :class="{ 'native-tree--checkable': checkable }">
    <div
      v-for="node in visibleNodes"
      :key="node._key"
      class="native-tree-node"
      :class="{
        'native-tree-node--selected': isSelected(node),
        'native-tree-node--disabled': node.disabled
      }"
      :style="{ paddingLeft: node._level * 20 + 'px' }"
    >
      <div class="native-tree-node__content" @click="handleContentClick(node)">
        <!-- 展开图标 - 点击也能展开 -->
        <span 
          class="native-tree-node__expand-icon"
          :class="{ 
            'native-tree-node__expand-icon--expanded': isExpanded(node),
            'native-tree-node__expand-icon--loading': isLoading(node),
            'native-tree-node__expand-icon--leaf': !canExpand(node)
          }"
        >
          <NativeIcon v-if="isLoading(node)" name="loading" size="14" class="loading-icon" />
          <NativeIcon v-else-if="canExpand(node)" name="chevron-right" size="14" />
          <span v-else class="native-tree-node__placeholder"></span>
        </span>
        
        <!-- 复选框 -->
        <span v-if="checkable" class="native-tree-node__checkbox" @click.stop="toggleCheck(node)">
          <span 
            class="native-tree-node__checkbox-inner"
            :class="{
              'native-tree-node__checkbox--checked': isChecked(node),
              'native-tree-node__checkbox--indeterminate': isIndeterminate(node)
            }"
          >
            <svg v-if="isChecked(node)" viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
          </span>
        </span>
        
        <!-- 节点内容 -->
        <div class="native-tree-node__label">
          <slot name="node" :node="node" :selected="isSelected(node)">
            {{ node[labelField] }}
          </slot>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import NativeIcon from './NativeIcon.vue'

const props = defineProps({
  data: { type: Array, default: () => [] },
  keyField: { type: String, default: 'id' },
  labelField: { type: String, default: 'label' },
  childrenField: { type: String, default: 'children' },
  checkable: { type: Boolean, default: false },
  selectable: { type: Boolean, default: true },
  multiple: { type: Boolean, default: false },
  defaultExpandAll: { type: Boolean, default: false },
  defaultExpandedKeys: { type: Array, default: () => [] },
  defaultSelectedKeys: { type: Array, default: () => [] },
  defaultCheckedKeys: { type: Array, default: () => [] },
  checkStrictly: { type: Boolean, default: false },
  lazy: { type: Boolean, default: false },
  load: { type: Function, default: null },
  // 点击节点时是否展开/折叠（文件夹）
  expandOnClickNode: { type: Boolean, default: true }
})

const emit = defineEmits(['expand', 'select', 'check', 'load'])

// 内部数据副本
const internalData = ref([])

// 状态 Map
const expandedKeysSet = ref(new Set(props.defaultExpandedKeys))
const selectedKeysSet = ref(new Set(props.defaultSelectedKeys))
const checkedKeysSet = ref(new Set(props.defaultCheckedKeys))
const loadingKeysSet = ref(new Set())

// 存储节点层级关系，避免在节点上添加 _parent 导致循环引用
const nodePathMap = new Map()

// 同步外部数据到内部
watch(() => props.data, (newData) => {
  internalData.value = (newData || []).map(item => ({ ...item }))
  buildNodePathMap()
  if (props.defaultExpandAll) {
    expandAll()
  }
}, { immediate: true, deep: true })

// 构建节点路径映射，用于快速查找父节点
function buildNodePathMap() {
  nodePathMap.clear()
  const traverse = (nodes, parentKey = null, level = 0) => {
    for (const node of nodes) {
      const key = node[props.keyField]
      nodePathMap.set(key, { parentKey, level })
      const children = node[props.childrenField]
      if (Array.isArray(children)) {
        traverse(children, key, level + 1)
      }
    }
  }
  traverse(internalData.value)
}

// 将树形数据转换为扁平数组
function flattenTree(nodes, level = 0) {
  const result = []
  
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const key = node[props.keyField]
    const children = node[props.childrenField]
    const hasChildren = Array.isArray(children) ? children.length > 0 : children === true
    
    // 添加内部属性（不添加 _parent 避免循环引用）
    node._key = key
    node._level = level
    node._index = i
    node._hasChildren = hasChildren
    
    result.push(node)
    
    // 如果已展开且有子节点，递归处理
    if (expandedKeysSet.value.has(key) && hasChildren && Array.isArray(children)) {
      result.push(...flattenTree(children, level + 1))
    }
  }
  
  return result
}

// 计算可见节点
const visibleNodes = computed(() => {
  return flattenTree(internalData.value)
})

// 检查节点是否可展开
function canExpand(node) {
  return node._hasChildren
}

// 检查是否展开
function isExpanded(node) {
  return expandedKeysSet.value.has(node._key)
}

// 检查是否选中
function isSelected(node) {
  return selectedKeysSet.value.has(node._key)
}

// 检查是否勾选
function isChecked(node) {
  return checkedKeysSet.value.has(node._key)
}

// 检查是否半选
function isIndeterminate(node) {
  if (!props.checkable) return false
  const children = node[props.childrenField]
  if (!Array.isArray(children) || children.length === 0) return false
  
  let checkedCount = 0
  for (const child of children) {
    if (isChecked(child) || isIndeterminate(child)) {
      checkedCount++
    }
  }
  
  return checkedCount > 0 && checkedCount < children.length
}

// 检查是否加载中
function isLoading(node) {
  return loadingKeysSet.value.has(node._key)
}

// 递归查找并更新节点
function findAndUpdateNode(nodes, targetKey, updater) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node[props.keyField] === targetKey) {
      updater(node)
      return true
    }
    const children = node[props.childrenField]
    if (Array.isArray(children) && children.length > 0) {
      if (findAndUpdateNode(children, targetKey, updater)) {
        return true
      }
    }
  }
  return false
}

// 切换展开状态
async function toggleExpand(node) {
  if (!canExpand(node)) return
  
  const key = node._key
  const isExpanding = !expandedKeysSet.value.has(key)
  
  // 如果是懒加载节点且未加载，先加载
  if (isExpanding && props.lazy && node[props.childrenField] === true) {
    if (isLoading(node)) return
    
    loadingKeysSet.value.add(key)
    
    try {
      const children = await props.load(node)
      const childrenArray = Array.isArray(children) ? children.map(c => ({ ...c })) : []
      
      // 更新内部数据
      findAndUpdateNode(internalData.value, key, (n) => {
        n[props.childrenField] = childrenArray
      })
      
      // 重建路径映射
      buildNodePathMap()
      
      emit('load', node, childrenArray)
    } catch (error) {
      console.error('懒加载失败:', error)
      loadingKeysSet.value.delete(key)
      return
    } finally {
      loadingKeysSet.value.delete(key)
    }
  }
  
  if (isExpanding) {
    expandedKeysSet.value.add(key)
  } else {
    expandedKeysSet.value.delete(key)
  }
  
  emit('expand', Array.from(expandedKeysSet.value))
}

// 处理内容区域点击 - 支持整行点击展开
function handleContentClick(node) {
  // 如果是文件夹且配置了点击展开
  if (props.expandOnClickNode && canExpand(node)) {
    toggleExpand(node)
  }
  
  // 触发选择
  if (!props.selectable || node.disabled) return
  
  const key = node._key
  
  if (props.multiple) {
    if (selectedKeysSet.value.has(key)) {
      selectedKeysSet.value.delete(key)
    } else {
      selectedKeysSet.value.add(key)
    }
  } else {
    selectedKeysSet.value.clear()
    selectedKeysSet.value.add(key)
  }
  
  emit('select', Array.from(selectedKeysSet.value), node)
}

// 切换勾选
function toggleCheck(node) {
  if (node.disabled) return
  
  const key = node._key
  
  if (checkedKeysSet.value.has(key)) {
    checkedKeysSet.value.delete(key)
  } else {
    checkedKeysSet.value.add(key)
  }
  
  emit('check', Array.from(checkedKeysSet.value), node)
}

// 展开所有
function expandAll() {
  const keys = new Set()
  const traverse = (nodes) => {
    for (const node of nodes) {
      const key = node[props.keyField]
      const children = node[props.childrenField]
      const hasChildren = Array.isArray(children) ? children.length > 0 : children === true
      if (hasChildren) {
        keys.add(key)
        if (Array.isArray(children)) {
          traverse(children)
        }
      }
    }
  }
  traverse(internalData.value)
  expandedKeysSet.value = keys
}

// 折叠所有
function collapseAll() {
  expandedKeysSet.value.clear()
}

defineExpose({
  expandAll,
  collapseAll,
  expandedKeys: expandedKeysSet,
  selectedKeys: selectedKeysSet,
  checkedKeys: checkedKeysSet
})
</script>

<style scoped>
.native-tree {
  font-size: 14px;
}

.native-tree-node {
  cursor: pointer;
}

.native-tree-node__content {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  transition: background 0.2s;
  border-radius: 4px;
}

.native-tree-node__content:hover:not(.native-tree-node--disabled) {
  background: #f5f5f5;
}

.native-tree-node--selected {
  background: #e6f7ff;
}

.native-tree-node--disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.native-tree-node__expand-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-right: 4px;
  cursor: pointer;
  transition: transform 0.2s;
  flex-shrink: 0;
}

.native-tree-node__expand-icon--expanded {
  transform: rotate(90deg);
}

.native-tree-node__expand-icon--loading {
  cursor: default;
}

.native-tree-node__expand-icon--leaf {
  cursor: default;
}

.loading-icon {
  animation: rotate 1s linear infinite;
}

@keyframes rotate {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.native-tree-node__placeholder {
  width: 14px;
}

.native-tree-node__checkbox {
  display: inline-flex;
  align-items: center;
  margin-right: 8px;
  cursor: pointer;
  flex-shrink: 0;
}

.native-tree-node__checkbox-inner {
  width: 16px;
  height: 16px;
  border: 2px solid #dcdcdc;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.native-tree-node__checkbox--checked {
  background: #0052d9;
  border-color: #0052d9;
  color: #fff;
}

.native-tree-node__checkbox--indeterminate {
  background: #0052d9;
  border-color: #0052d9;
}

.native-tree-node__checkbox--indeterminate::after {
  content: '';
  width: 8px;
  height: 2px;
  background: #fff;
}

.native-tree-node__label {
  flex: 1;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
