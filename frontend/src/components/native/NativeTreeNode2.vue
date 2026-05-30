<template>
  <div class="native-tree-node">
    <div 
      class="native-tree-node__content"
      :class="{
        'native-tree-node__content--selected': isSelected,
        'native-tree-node__content--disabled': node.disabled
      }"
      :style="{ paddingLeft: level * 20 + 'px' }"
    >
      <!-- 展开图标 -->
      <span 
        class="native-tree-node__expand-icon"
        :class="{ 
          'native-tree-node__expand-icon--expanded': isExpanded,
          'native-tree-node__expand-icon--loading': isLoading
        }"
        @click.stop="toggleExpand"
      >
        <NativeIcon v-if="isLoading" name="loading" size="14" class="loading-icon" />
        <NativeIcon v-else-if="showExpandIcon" name="chevron-right" size="14" />
        <span v-else class="native-tree-node__placeholder"></span>
      </span>
      
      <!-- 复选框 -->
      <span v-if="checkable" class="native-tree-node__checkbox" @click.stop="toggleCheck">
        <span 
          class="native-tree-node__checkbox-inner"
          :class="{
            'native-tree-node__checkbox--checked': isChecked,
            'native-tree-node__checkbox--indeterminate': isIndeterminate
          }"
        >
          <svg v-if="isChecked" viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
        </span>
      </span>
      
      <!-- 节点内容 -->
      <div 
        class="native-tree-node__label"
        :class="{ 'native-tree-node__label--selected': isSelected }"
        @click="handleSelect"
      >
        <slot name="node" :node="node" :selected="isSelected">
          {{ node[labelField] }}
        </slot>
      </div>
    </div>
    
    <!-- 子节点 -->
    <div v-show="hasLoadedChildren && isExpanded" class="native-tree-node__children">
      <TreeNode
        v-for="(child, childIndex) in node[childrenField]"
        :key="child[keyField] ?? `child-${childIndex}`"
        :node="child"
        :key-field="keyField"
        :label-field="labelField"
        :children-field="childrenField"
        :checkable="checkable"
        :selectable="selectable"
        :expanded-keys="expandedKeys"
        :selected-keys="selectedKeys"
        :checked-keys="checkedKeys"
        :loading-keys="loadingKeys"
        :lazy="lazy"
        :load="load"
        :level="level + 1"
        @toggle="handleChildToggle"
        @select="(key, node) => $emit('select', key, node)"
        @check="(key, checked, node) => $emit('check', key, checked, node)"
        @load="(node, children) => $emit('load', node, children)"
      >
        <template #node="slotProps">
          <slot name="node" v-bind="slotProps"></slot>
        </template>
      </TreeNode>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import NativeIcon from './NativeIcon.vue'

const props = defineProps({
  node: { type: Object, required: true },
  keyField: { type: String, default: 'id' },
  labelField: { type: String, default: 'label' },
  childrenField: { type: String, default: 'children' },
  checkable: { type: Boolean, default: false },
  selectable: { type: Boolean, default: true },
  expandedKeys: { type: Array, default: () => [] },
  selectedKeys: { type: Array, default: () => [] },
  checkedKeys: { type: Array, default: () => [] },
  loadingKeys: { type: Array, default: () => [] },
  lazy: { type: Boolean, default: false },
  load: { type: Function, default: null },
  level: { type: Number, default: 0 }
})

const emit = defineEmits(['toggle', 'select', 'check', 'load'])

const nodeKey = computed(() => props.node[props.keyField])

// 是否有已加载的子节点
const hasLoadedChildren = computed(() => {
  const children = props.node[props.childrenField]
  return Array.isArray(children) && children.length > 0
})

// 是否是懒加载节点（children 为 true 表示需要懒加载）
const isLazyNode = computed(() => {
  const children = props.node[props.childrenField]
  return props.lazy && children === true
})

// 是否显示展开图标
const showExpandIcon = computed(() => {
  // 有已加载的子节点，或者是需要懒加载的节点
  return hasLoadedChildren.value || isLazyNode.value
})

// 是否正在加载
const isLoading = computed(() => {
  return props.loadingKeys.includes(nodeKey.value)
})

const isExpanded = computed(() => props.expandedKeys.includes(nodeKey.value))
const isSelected = computed(() => props.selectedKeys.includes(nodeKey.value))
const isChecked = computed(() => props.checkedKeys.includes(nodeKey.value))

const isIndeterminate = computed(() => {
  if (!hasLoadedChildren.value) return false
  const children = props.node[props.childrenField]
  const checkedChildren = children.filter(child => 
    props.checkedKeys.includes(child[props.keyField])
  )
  return checkedChildren.length > 0 && checkedChildren.length < children.length
})

async function toggleExpand() {
  // 如果是懒加载节点且未加载，先加载
  if (isLazyNode.value && !isLoading.value) {
    emit('load', props.node)
    return
  }
  
  // 如果没有子节点，不展开
  if (!hasLoadedChildren.value && !isLazyNode.value) return
  
  emit('toggle', nodeKey.value)
}

function handleChildToggle(childKey) {
  emit('toggle', childKey)
}

function handleSelect() {
  if (props.node.disabled) return
  emit('select', nodeKey.value, props.node)
}

function toggleCheck() {
  if (props.node.disabled) return
  emit('check', nodeKey.value, !isChecked.value, props.node)
}
</script>

<style scoped>
.native-tree-node__content {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  cursor: pointer;
  transition: background 0.2s;
  border-radius: 4px;
}

.native-tree-node__content:hover:not(.native-tree-node__content--disabled) {
  background: #f5f5f5;
}

.native-tree-node__content--selected {
  background: #e6f7ff;
}

.native-tree-node__content--disabled {
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
}

.native-tree-node__expand-icon--expanded {
  transform: rotate(90deg);
}

.native-tree-node__expand-icon--loading {
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
}

.native-tree-node__label--selected {
  color: #0052d9;
  font-weight: 500;
}

.native-tree-node__children {
  margin-left: 0;
}
</style>
