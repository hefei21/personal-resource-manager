<template>
  <div class="native-table-wrapper">
    <table class="native-table" :class="{ 'native-table--striped': stripe, 'native-table--bordered': bordered }">
      <thead v-if="showHeader">
        <tr>
          <th v-if="selectable" class="native-table__checkbox">
            <NativeCheckbox
              :modelValue="isAllSelected"
              :indeterminate="isIndeterminate"
              @change="toggleSelectAll"
            />
          </th>
          <th
            v-for="col in columns"
            :key="col.key || col.dataIndex"
            :class="{
              'native-table__cell--sortable': col.sorter,
              'native-table__cell--sorted': sortKey === (col.key || col.dataIndex)
            }"
            :style="[{ textAlign: col.headerAlign || col.align || 'left' }, getCellStyle(col)]"
            @click="handleSort(col)"
          >
            <slot :name="`header-${col.key || col.dataIndex}`" :column="col">
              {{ col.title }}
            </slot>
            <!-- 排序图标：仅当前排序列显示，单个箭头 -->
            <span v-if="col.sorter && sortKey === (col.key || col.dataIndex)" class="sort-icon">
              <span v-if="sortOrder === 'desc'" class="sort-arrow sort-arrow--desc">▼</span>
              <span v-else-if="sortOrder === 'asc'" class="sort-arrow sort-arrow--asc">▲</span>
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-if="dataSource.length > 0">
          <tr
            v-for="(row, rowIndex) in dataSource"
            :key="getRowKey(row, rowIndex)"
            :class="{
              'native-table__row--selected': isRowSelected(row),
              'native-table__row--hover': hover
            }"
            @click="handleRowClick(row, rowIndex)"
          >
            <td v-if="selectable" class="native-table__checkbox" @click.stop>
              <NativeCheckbox 
                :modelValue="selectedKeys.includes(getRowKey(row, rowIndex))"
                @change="toggleSelectRow(row, rowIndex)"
              />
            </td>
            <td
              v-for="col in columns"
              :key="col.key || col.dataIndex"
              :class="`native-table__cell--${col.align || 'left'}`"
              :style="[{ textAlign: col.align || 'left' }, getCellStyle(col)]"
            >
              <slot 
                :name="`cell-${col.key || col.dataIndex}`" 
                :row="row" 
                :col="col"
                :value="getCellValue(row, col)"
                :index="rowIndex"
              >
                {{ getCellValue(row, col) }}
              </slot>
            </td>
          </tr>
        </template>
        <tr v-else>
          <td :colspan="totalColSpan" class="native-table__empty">
            <slot name="empty">
              <div class="empty-content">
                <!-- 更美观的空状态图标：打开的盒子/文件夹设计 -->
                <svg viewBox="0 0 64 64" width="64" height="64" fill="none" style="opacity: 0.5; margin-bottom: 12px;">
                  <!-- 外框 -->
                  <rect x="8" y="20" width="48" height="36" rx="3" fill="currentColor" fill-opacity="0.1" stroke="currentColor" stroke-width="2"/>
                  <!-- 盒盖 -->
                  <path d="M8 20L16 8H48L56 20" stroke="currentColor" stroke-width="2" fill="currentColor" fill-opacity="0.05"/>
                  <!-- 内部横线表示内容 -->
                  <line x1="18" y1="32" x2="46" y2="32" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.4"/>
                  <line x1="18" y1="40" x2="38" y2="40" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.4"/>
                  <!-- 小点装饰 -->
                  <circle cx="46" cy="48" r="3" fill="currentColor" opacity="0.3"/>
                </svg>
                <p>{{ emptyText }}</p>
              </div>
            </slot>
          </td>
        </tr>
      </tbody>
    </table>
    
    <!-- 加载状态 -->
    <div v-if="loading" class="native-table__loading">
      <NativeLoading />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import NativeCheckbox from './NativeCheckbox.vue'
import NativeIcon from './NativeIcon.vue'
import NativeLoading from './NativeLoading.vue'

const props = defineProps({
  dataSource: { type: Array, default: () => [] },
  columns: { type: Array, default: () => [] },
  rowKey: { type: [String, Function], default: 'id' },
  loading: { type: Boolean, default: false },
  stripe: { type: Boolean, default: false },
  bordered: { type: Boolean, default: false },
  hover: { type: Boolean, default: true },
  showHeader: { type: Boolean, default: true },
  emptyText: { type: String, default: '暂无数据' },
  selectable: { type: Boolean, default: false },
  selectedKeys: { type: Array, default: () => [] },
  defaultSelectedKeys: { type: Array, default: () => [] },
  // 所有数据的key数组（用于跨页全选）
  allRowKeys: { type: Array, default: null }
})

const emit = defineEmits(['update:selectedKeys', 'selectionChange', 'rowClick', 'sortChange'])

// 排序状态
const sortKey = defineModel('sortKey', { default: '' })
const sortOrder = defineModel('sortOrder', { default: '' })

// 内部选中状态
const selectedKeys = defineModel('selectedKeys', { default: [] })

// 获取行唯一键
function getRowKey(row, index) {
  if (typeof props.rowKey === 'function') {
    return props.rowKey(row)
  }
  return row[props.rowKey] || index
}

// 获取单元格值
function getCellValue(row, col) {
  const key = col.key || col.dataIndex
  if (typeof col.render === 'function') {
    return col.render(row[key], row)
  }
  return row[key]
}

// 获取单元格样式
function getCellStyle(col) {
  const style = {}
  if (col.width) {
    style.width = typeof col.width === 'number' ? `${col.width}px` : col.width
    style.minWidth = style.width
  }
  if (col.minWidth) {
    style.minWidth = typeof col.minWidth === 'number' ? `${col.minWidth}px` : col.minWidth
    style.width = 'auto'
  }
  if (col.fixed === 'left') {
    style.position = 'sticky'
    style.left = '0'
    style.zIndex = '1'
  }
  if (col.fixed === 'right') {
    style.position = 'sticky'
    style.right = '0'
    style.zIndex = '1'
  }
  return style
}

// 计算总列数
const totalColSpan = computed(() => {
  return props.columns.length + (props.selectable ? 1 : 0)
})

// 是否全选（根据所有数据或当前页数据判断）
const isAllSelected = computed(() => {
  const keysToCheck = props.allRowKeys
  if (keysToCheck) {
    // 跨页模式：检查是否选中了所有数据
    if (keysToCheck.length === 0) return false
    return keysToCheck.every(key => selectedKeys.value.includes(key))
  }
  // 当前页模式
  if (props.dataSource.length === 0) return false
  return props.dataSource.every((row, index) => {
    return selectedKeys.value.includes(getRowKey(row, index))
  })
})

// 是否半选
const isIndeterminate = computed(() => {
  const keysToCheck = props.allRowKeys
  if (keysToCheck) {
    // 跨页模式：根据所有数据判断
    if (keysToCheck.length === 0) return false
    const selectedCount = keysToCheck.filter(key => selectedKeys.value.includes(key)).length
    return selectedCount > 0 && selectedCount < keysToCheck.length
  }
  // 当前页模式
  if (props.dataSource.length === 0) return false
  const selectedCount = props.dataSource.filter((row, index) => {
    return selectedKeys.value.includes(getRowKey(row, index))
  }).length
  return selectedCount > 0 && selectedCount < props.dataSource.length
})

// 行是否被选中
function isRowSelected(row) {
  return selectedKeys.value.includes(getRowKey(row))
}

// 切换全选
function toggleSelectAll(value) {
  // 从 NativeCheckbox 传来的 value 可能是布尔值或事件对象
  // 这里我们只需要根据当前状态取反即可
  if (isAllSelected.value) {
    selectedKeys.value = []
  } else {
    // 如果提供了allRowKeys，则选中所有数据（跨页），否则只选中当前页
    selectedKeys.value = [...(props.allRowKeys || props.dataSource.map((row, index) => getRowKey(row, index)))]
  }
  emit('selectionChange', [...selectedKeys.value])
}

// 切换行选择
function toggleSelectRow(row, index) {
  const key = getRowKey(row, index)
  const idx = selectedKeys.value.indexOf(key)
  const newKeys = [...selectedKeys.value]
  if (idx > -1) {
    newKeys.splice(idx, 1)
  } else {
    newKeys.push(key)
  }
  selectedKeys.value = newKeys
  emit('selectionChange', [...selectedKeys.value])
}

// 行点击
function handleRowClick(row, index) {
  emit('rowClick', { row, index })
}

// 排序
function handleSort(col) {
  if (!col.sorter) return
  const key = col.key || col.dataIndex
  let newSortKey = sortKey.value
  let newSortOrder = sortOrder.value

  if (sortKey.value === key) {
    // 当前已排序：desc -> asc -> desc（循环切换，不取消）
    newSortOrder = sortOrder.value === 'desc' ? 'asc' : 'desc'
  } else {
    // 点击新列：默认倒序开始
    newSortKey = key
    newSortOrder = 'desc'
  }

  // 更新状态
  sortKey.value = newSortKey
  sortOrder.value = newSortOrder

  // 触发 sortChange 事件，由外部组件处理排序逻辑
  emit('sortChange', { sortBy: newSortKey, descending: newSortOrder === 'desc' })
}
</script>

<style scoped>
.native-table-wrapper {
  position: relative;
  overflow-x: auto;
}

.native-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  background: #fff;
}

.native-table th,
.native-table td {
  padding: 12px 16px;
  text-align: left;
  border-bottom: 1px solid #e8e8e8;
}

.native-table th {
  font-weight: 600;
  color: #333;
  background: #fafafa;
  white-space: nowrap;
}

.native-table tbody tr:hover {
  background: #f5f7fa;
}

.native-table tbody tr.native-table__row--selected {
  background: #e6f7ff;
}

.native-table--striped tbody tr:nth-child(even) {
  background: #fafafa;
}

.native-table--striped tbody tr:nth-child(even):hover {
  background: #f5f7fa;
}

.native-table--bordered th,
.native-table--bordered td {
  border: 1px solid #e8e8e8;
}

.native-table__checkbox {
  width: 50px;
  text-align: center;
}

.native-table__cell--center {
  text-align: center;
}

.native-table__cell--right {
  text-align: right;
}

.native-table__cell--sortable {
  cursor: pointer;
  user-select: none;
}

.sort-icon {
  display: inline-flex;
  margin-left: 4px;
  font-size: 12px;
  color: #0052d9;
  line-height: 1;
}

.sort-arrow {
  display: inline-block;
}

.native-table__empty {
  text-align: center;
  padding: 48px 16px;
  color: #999;
}

.empty-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.native-table__loading {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}

/* 响应式：小屏幕减小padding */
@media (max-width: 768px) {
  .native-table th,
  .native-table td {
    padding: 8px 12px;
    font-size: 13px;
  }
}
</style>
