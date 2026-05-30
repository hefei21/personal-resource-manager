<template>
  <div class="native-tabs" :class="[`native-tabs--${type}`, `native-tabs--${size}`, { 'native-tabs--center': center }]">
    <!-- 标签头 -->
    <div class="native-tabs__header">
      <div class="native-tabs__nav">
        <div
          v-for="(tab, index) in tabs"
          :key="tab.name"
          class="native-tabs__tab"
          :class="{
            'native-tabs__tab--active': activeName === tab.name,
            'native-tabs__tab--disabled': tab.disabled
          }"
          @click="handleTabClick(tab, index)"
        >
          <slot name="label" :tab="tab" :index="index">
            <NativeIcon v-if="tab.icon" :name="tab.icon" size="14" />
            <span>{{ tab.label }}</span>
            <span v-if="tab.badge" class="native-tabs__badge">{{ tab.badge }}</span>
          </slot>
        </div>
        <!-- 激活下划线 -->
        <div v-if="type === 'line'" class="native-tabs__line" :style="lineStyle"></div>
      </div>
      
      <!-- 额外内容 -->
      <div v-if="$slots.extra" class="native-tabs__extra">
        <slot name="extra"></slot>
      </div>
    </div>
    
    <!-- 内容区域 -->
    <div class="native-tabs__content">
      <slot></slot>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, provide, onMounted, nextTick } from 'vue'
import NativeIcon from './NativeIcon.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  type: { type: String, default: 'line' }, // line, card
  size: { type: String, default: 'medium' }, // small, medium, large
  center: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'change', 'tabClick'])

const tabs = ref([])
const activeIndex = ref(0)
const lineStyle = ref({})

const activeName = computed({
  get: () => props.modelValue,
  set: (val) => {
    emit('update:modelValue', val)
  }
})

// 提供给子组件
provide('nativeTabs', {
  props,
  activeName,
  addTab,
  removeTab
})

// 添加标签
function addTab(tab) {
  tabs.value.push(tab)
  // 如果没有设置激活项，默认激活第一个
  if (!activeName.value && tabs.value.length === 1 && !tab.disabled) {
    activeName.value = tab.name
  }
}

// 移除标签
function removeTab(name) {
  const index = tabs.value.findIndex(t => t.name === name)
  if (index > -1) {
    tabs.value.splice(index, 1)
  }
}

// 点击标签
function handleTabClick(tab, index) {
  if (tab.disabled) return
  
  activeName.value = tab.name
  activeIndex.value = index
  emit('change', tab.name, index)
  emit('tabClick', tab, index)
  
  updateLineStyle()
}

// 更新下划线位置
function updateLineStyle() {
  if (props.type !== 'line') return
  
  nextTick(() => {
    const tabEl = document.querySelectorAll('.native-tabs__tab')[activeIndex.value]
    if (tabEl) {
      lineStyle.value = {
        width: `${tabEl.offsetWidth}px`,
        transform: `translateX(${tabEl.offsetLeft}px)`
      }
    }
  })
}

// 监听标签变化
watch(() => tabs.value.length, updateLineStyle)
watch(() => activeName.value, (val) => {
  const index = tabs.value.findIndex(t => t.name === val)
  if (index > -1) {
    activeIndex.value = index
    updateLineStyle()
  }
})

onMounted(() => {
  updateLineStyle()
})
</script>

<style scoped>
.native-tabs {
  width: 100%;
}

.native-tabs__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #e8e8e8;
  margin-bottom: 16px;
}

.native-tabs__nav {
  position: relative;
  display: flex;
  flex: 1;
}

.native-tabs__tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 16px;
  font-size: 14px;
  color: #666;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.native-tabs__tab:hover:not(.native-tabs__tab--disabled) {
  color: #0052d9;
}

.native-tabs__tab--active {
  color: #0052d9;
  font-weight: 500;
}

.native-tabs__tab--disabled {
  color: #ccc;
  cursor: not-allowed;
}

.native-tabs__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  font-size: 11px;
  color: #fff;
  background: #ff4d4f;
  border-radius: 9px;
}

/* 下划线 */
.native-tabs__line {
  position: absolute;
  bottom: -1px;
  left: 0;
  height: 2px;
  background: #0052d9;
  transition: all 0.3s;
}

/* card 类型 */
.native-tabs--card .native-tabs__header {
  border-bottom: none;
  margin-bottom: 0;
}

.native-tabs--card .native-tabs__nav {
  background: #f5f5f5;
  border-radius: 6px 6px 0 0;
  padding: 4px 4px 0;
}

.native-tabs--card .native-tabs__tab {
  background: transparent;
  border-radius: 4px 4px 0 0;
  margin-right: 4px;
}

.native-tabs--card .native-tabs__tab--active {
  background: #fff;
}

.native-tabs--card .native-tabs__content {
  background: #fff;
  border: 1px solid #e8e8e8;
  border-top: none;
  border-radius: 0 0 6px 6px;
  padding: 16px;
}

/* 尺寸 */
.native-tabs--small .native-tabs__tab {
  padding: 8px 12px;
  font-size: 13px;
}

.native-tabs--large .native-tabs__tab {
  padding: 16px 20px;
  font-size: 15px;
}

/* 居中 */
.native-tabs--center .native-tabs__nav {
  justify-content: center;
}
</style>
