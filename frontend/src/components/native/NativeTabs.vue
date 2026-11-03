<template>
  <div class="native-tabs" :class="[`native-tabs--${type}`, `native-tabs--${size}`, { 'native-tabs--center': center }]">
    <!-- 标签头 -->
    <div class="native-tabs__header">
      <div ref="navRef" class="native-tabs__nav" role="tablist" aria-label="内容视图">
        <button
          v-for="(tab, index) in tabs"
          :key="tab.name"
          class="native-tabs__tab"
          type="button"
          role="tab"
          :id="tabId(tab.name)"
          :aria-controls="panelId(tab.name)"
          :aria-selected="activeName === tab.name"
          :disabled="tab.disabled"
          :tabindex="activeName === tab.name ? 0 : -1"
          :class="{
            'native-tabs__tab--active': activeName === tab.name,
            'native-tabs__tab--disabled': tab.disabled
          }"
          @click="handleTabClick(tab, index)"
          @keydown="handleTabKeydown($event, index)"
        >
          <slot name="label" :tab="tab" :index="index">
            <NativeIcon v-if="tab.icon" :name="tab.icon" size="14" />
            <span>{{ tab.label }}</span>
            <span v-if="tab.badge" class="native-tabs__badge">{{ tab.badge }}</span>
          </slot>
        </button>
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
import { ref, computed, watch, provide, onMounted, nextTick, useId } from 'vue'
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
const navRef = ref(null)
const instanceId = `native-tabs-${useId()}`
const tabId = name => `${instanceId}-tab-${encodeURIComponent(name)}`
const panelId = name => `${instanceId}-panel-${encodeURIComponent(name)}`

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
  removeTab,
  tabId,
  panelId
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

function handleTabKeydown(event, index) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const enabled = tabs.value.map((tab, i) => tab.disabled ? -1 : i).filter(i => i >= 0)
  if (!enabled.length) return
  const position = enabled.indexOf(index)
  const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1)
    : enabled[(position + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length]
  handleTabClick(tabs.value[next], next)
  navRef.value?.querySelectorAll('[role="tab"]')[next]?.focus()
}

// 更新下划线位置
function updateLineStyle() {
  if (props.type !== 'line') return
  
  nextTick(() => {
    const selectedIndex = tabs.value.findIndex(tab => tab.name === activeName.value)
    const tabEl = navRef.value?.querySelectorAll('.native-tabs__tab')[selectedIndex]
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
  border-bottom: 1px solid var(--color-border-subtle);
  margin-bottom: 16px;
}

.native-tabs__nav {
  position: relative;
  display: flex;
  flex: 1;
}

.native-tabs__tab {
  border: 0;
  background: transparent;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 16px;
  font-size: 14px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.native-tabs__tab:hover:not(.native-tabs__tab--disabled) {
  color: var(--color-primary);
}

.native-tabs__tab--active {
  color: var(--color-primary);
  font-weight: 500;
}

.native-tabs__tab--disabled {
  color: var(--color-text-muted);
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
  color: var(--color-text-inverse);
  background: var(--color-danger-solid);
  border-radius: 9px;
}

/* 下划线 */
.native-tabs__line {
  position: absolute;
  bottom: -1px;
  left: 0;
  height: 2px;
  background: var(--color-primary-solid);
  transition: all 0.3s;
}

/* card 类型 */
.native-tabs--card .native-tabs__header {
  border-bottom: none;
  margin-bottom: 0;
}

.native-tabs--card .native-tabs__nav {
  background: var(--color-surface-subtle);
  border-radius: 6px 6px 0 0;
  padding: 4px 4px 0;
}

.native-tabs--card .native-tabs__tab {
  background: transparent;
  border-radius: 4px 4px 0 0;
  margin-right: 4px;
}

.native-tabs--card .native-tabs__tab--active {
  background: var(--color-surface-raised);
}

.native-tabs--card .native-tabs__content {
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-subtle);
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
