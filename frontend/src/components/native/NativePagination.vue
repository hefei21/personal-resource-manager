<template>
  <div class="native-pagination">
    <!-- 每页条数选择器 -->
    <div v-if="showPageSize" class="native-pagination__size">
      <select v-model="localPageSize" @change="handlePageSizeChange" class="native-pagination__select">
        <option v-for="size in pageSizeOptions" :key="size" :value="size">{{ size }}条/页</option>
      </select>
    </div>
    
    <span class="native-pagination__total">共 {{ total }} 条</span>
    <div class="native-pagination__pages">
      <!-- 上一页 -->
      <button 
        class="native-pagination__btn" 
        :disabled="current <= 1"
        @click="goToPage(current - 1)"
        title="上一页"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/>
        </svg>
      </button>
      
      <!-- 页码 -->
      <button 
        v-for="page in visiblePages" 
        :key="page"
        class="native-pagination__btn"
        :class="{ 
          'native-pagination__btn--active': page === current,
          'native-pagination__btn--ellipsis': page === '...'
        }"
        :disabled="page === '...'"
        @click="page !== '...' && goToPage(page)"
      >
        {{ page }}
      </button>
      
      <!-- 下一页 -->
      <button 
        class="native-pagination__btn" 
        :disabled="current >= totalPages"
        @click="goToPage(current + 1)"
        title="下一页"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  current: { type: Number, default: 1 },
  pageSize: { type: Number, default: 10 },
  total: { type: Number, default: 0 },
  showPageSize: { type: Boolean, default: true },
  showFirstLast: { type: Boolean, default: true },
  pageSizeOptions: { type: Array, default: () => [15, 30, 50, 100] }
})

const emit = defineEmits(['change', 'pageSizeChange'])

const localPageSize = ref(props.pageSize)

watch(() => props.pageSize, (newVal) => {
  localPageSize.value = newVal
})

const totalPages = computed(() => Math.ceil(props.total / props.pageSize))

const visiblePages = computed(() => {
  const pages = []
  
  if (totalPages.value <= 7) {
    // 页数较少时全部显示
    for (let i = 1; i <= totalPages.value; i++) {
      pages.push(i)
    }
  } else {
    // 始终以当前页面为中心显示5页
    const start = Math.max(1, props.current - 2)
    const end = Math.min(totalPages.value, props.current + 2)
    
    // 调整边界确保显示5页
    let displayStart = start
    let displayEnd = end
    if (end - start + 1 < 5) {
      if (props.current <= 3) {
        displayStart = 1
        displayEnd = 5
      } else {
        displayStart = totalPages.value - 4
        displayEnd = totalPages.value
      }
    }
    
    // 如果首页不在5页中，前面加"1"和"..."
    if (displayStart > 1) {
      pages.push(1)
      if (displayStart > 2) {
        pages.push('...')
      }
    }
    
    // 显示中间的5页
    for (let i = displayStart; i <= displayEnd; i++) {
      pages.push(i)
    }
    
    // 如果尾页不在5页中，后面加"..."和尾页
    if (displayEnd < totalPages.value) {
      if (displayEnd < totalPages.value - 1) {
        pages.push('...')
      }
      pages.push(totalPages.value)
    }
  }
  
  return pages
})

function goToPage(page) {
  if (page < 1 || page > totalPages.value || page === props.current) return
  emit('change', { current: page, pageSize: props.pageSize })
}

function handlePageSizeChange() {
  emit('pageSizeChange', localPageSize.value)
  emit('change', { current: 1, pageSize: localPageSize.value })
}
</script>

<style scoped>
.native-pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  padding: 16px 0;
}

.native-pagination__total {
  font-size: 14px;
  color: #666;
}

.native-pagination__pages {
  display: flex;
  gap: 8px;
}

.native-pagination__btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  padding: 0 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: #fff;
  color: #666;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.native-pagination__btn:hover:not(:disabled) {
  border-color: #0052d9;
  color: #0052d9;
}

.native-pagination__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.native-pagination__btn--active {
  background: #0052d9;
  border-color: #0052d9;
  color: #fff;
}

.native-pagination__btn--ellipsis {
  border: none;
  background: transparent;
  cursor: default;
  padding: 0 4px;
}

.native-pagination__btn--ellipsis:hover {
  border-color: transparent;
  color: #666;
}

.native-pagination__size {
  margin-right: 16px;
}

.native-pagination__select {
  height: 32px;
  padding: 0 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: #fff;
  color: #666;
  font-size: 14px;
  cursor: pointer;
  outline: none;
}

.native-pagination__select:hover,
.native-pagination__select:focus {
  border-color: #0052d9;
}
</style>
