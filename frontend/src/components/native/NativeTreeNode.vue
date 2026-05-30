<template>
  <div class="native-tree-node">
    <div 
      class="native-tree-node__content"
      :class="{ 
        'native-tree-node__content--selected': isSelected,
        'native-tree-node__content--disabled': node.disabled
      }"
      :style="{ paddingLeft: level * 20 + 12 + 'px' }"
      @click="handleClick"
    >
      <!-- 展开/折叠图标 -->
      <span 
        v-if="hasChildren"
        class="native-tree-node__expand"
        :class="{ 'native-tree-node__expand--expanded': isExpanded }"
        @click.stop="toggleExpand"
      >
        <NativeIcon name="chevron-right" size="14" />
      </span>
      <span v-else class="native-tree-node__expand native-tree-node__expand--placeholder"></span>
      
      <!-- 多选框 -->
      <span v-if="multiple" class="native-tree-node__checkbox" @click.stop="toggleSelect">
        <span 
          class="native-tree-node__checkbox-inner"
          :class="{ 
            'native-tree-node__checkbox--checked': isSelected,
            'native-tree-node__checkbox--indeterminate': isIndeterminate
          }"
        >
          <svg v-if="isSelected" viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
          </svg>
        </span>
      </span>
      
      <!-- 节点标签 -->
      <span class="native-tree-node__label">{{ node[labelKey] }}</span>
    </div>
    
    <!-- 子节点 -->
    <div v-if="hasChildren && isExpanded" class="native-tree-node__children">
      <TreeNode
        v-for="child in node[childrenKey]"
        :key="child[valueKey]"
        :node="child"
        :value-key="valueKey"
        :label-key="labelKey"
        :children-key="childrenKey"
        :multiple="multiple"
        :selected-values="selectedValues"
        :expanded-keys="expandedKeys"
        :level="level + 1"
        @toggle="$emit('toggle', $event)"
        @select="$emit('select', $event)"
      />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import NativeIcon from './NativeIcon.vue'

const props = defineProps({
  node: { type: Object, required: true },
  valueKey: { type: String, default: 'value' },
  labelKey: { type: String, default: 'label' },
  childrenKey: { type: String, default: 'children' },
  multiple: { type: Boolean, default: false },
  selectedValues: { type: Array, default: () => [] },
  expandedKeys: { type: Array, default: () => [] },
  level: { type: Number, default: 0 }
})

const emit = defineEmits(['toggle', 'select'])

const nodeValue = computed(() => props.node[props.valueKey])
const hasChildren = computed(() => {
  const children = props.node[props.childrenKey]
  return children && children.length > 0
})
const isExpanded = computed(() => props.expandedKeys.includes(nodeValue.value))
const isSelected = computed(() => props.selectedValues.includes(nodeValue.value))

// 是否半选（用于多选时父节点显示状态）
const isIndeterminate = computed(() => {
  if (!hasChildren.value || !props.multiple) return false
  const children = props.node[props.childrenKey]
  const selectedChildren = children.filter(child => 
    props.selectedValues.includes(child[props.valueKey])
  )
  return selectedChildren.length > 0 && selectedChildren.length < children.length
})

function toggleExpand() {
  emit('toggle', props.node)
}

function handleClick() {
  if (props.node.disabled) return
  emit('select', props.node)
}

function toggleSelect() {
  if (props.node.disabled) return
  emit('select', props.node)
}
</script>

<style scoped>
.native-tree-node__content {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.2s;
  font-size: 14px;
}

.native-tree-node__content:hover {
  background: #f5f5f5;
}

.native-tree-node__content--selected {
  background: #e8f4ff;
  color: #0052d9;
}

.native-tree-node__content--disabled {
  color: #ccc;
  cursor: not-allowed;
}

.native-tree-node__content--disabled:hover {
  background: transparent;
}

.native-tree-node__expand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-right: 4px;
  color: #999;
  cursor: pointer;
  transition: transform 0.2s;
}

.native-tree-node__expand--expanded {
  transform: rotate(90deg);
}

.native-tree-node__expand--placeholder {
  cursor: default;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
