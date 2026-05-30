<template>
  <div ref="pickerRef" class="native-date-range-picker" :class="{ 'native-date-range-picker--disabled': disabled }">
    <!-- 触发器 -->
    <div 
      class="native-date-range-picker__trigger" 
      @click="togglePicker"
      :class="{ 'native-date-range-picker__trigger--active': isOpen }"
    >
      <span v-if="displayValue" class="native-date-range-picker__value">{{ displayValue }}</span>
      <span v-else class="native-date-range-picker__placeholder">{{ placeholder }}</span>
      <NativeIcon name="calendar" size="16" class="native-date-range-picker__icon" />
    </div>
    
    <!-- 日期选择面板 -->
    <div v-if="isOpen" class="native-date-range-picker__dropdown" :style="dropdownStyle" v-click-outside="close">
      <div class="native-date-range-picker__header">
        <button class="native-date-range-picker__nav" @click="prevMonth">
          <NativeIcon name="chevron-left" size="16" />
        </button>
        <span class="native-date-range-picker__current">{{ currentYear }}年{{ currentMonth + 1 }}月</span>
        <button class="native-date-range-picker__nav" @click="nextMonth">
          <NativeIcon name="chevron-right" size="16" />
        </button>
      </div>
      
      <div class="native-date-range-picker__calendar">
        <!-- 星期标题 -->
        <div class="native-date-range-picker__weekdays">
          <span v-for="day in weekDays" :key="day" class="native-date-range-picker__weekday">{{ day }}</span>
        </div>
        
        <!-- 日期网格 -->
        <div class="native-date-range-picker__days">
          <button
            v-for="date in calendarDays"
            :key="date.date"
            class="native-date-range-picker__day"
            :class="{
              'native-date-range-picker__day--other-month': !date.isCurrentMonth,
              'native-date-range-picker__day--today': date.isToday,
              'native-date-range-picker__day--selected': isSelected(date),
              'native-date-range-picker__day--in-range': isInRange(date),
              'native-date-range-picker__day--start': isStartDate(date),
              'native-date-range-picker__day--end': isEndDate(date),
              'native-date-range-picker__day--disabled': isDisabled(date)
            }"
            @click="selectDate(date)"
            :disabled="isDisabled(date)"
          >
            {{ date.day }}
          </button>
        </div>
      </div>
      
      <!-- 快捷选项 -->
      <div v-if="presets.length > 0" class="native-date-range-picker__presets">
        <button
          v-for="preset in presets"
          :key="preset.label"
          class="native-date-range-picker__preset"
          @click="applyPreset(preset)"
        >
          {{ preset.label }}
        </button>
      </div>
      
      <!-- 底部按钮 -->
      <div class="native-date-range-picker__footer">
        <button class="native-date-range-picker__btn native-date-range-picker__btn--text" @click="clear">清空</button>
        <button class="native-date-range-picker__btn native-date-range-picker__btn--primary" @click="confirm">确定</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import NativeIcon from './NativeIcon.vue'
import { vClickOutside } from './directives/clickOutside'

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
  modelValue: { type: Array, default: () => [null, null] },
  disabled: { type: Boolean, default: false },
  placeholder: { type: String, default: '请选择日期范围' },
  format: { type: String, default: 'YYYY-MM-DD' },
  presets: { type: Array, default: () => [] },
  minDate: { type: Date, default: null },
  maxDate: { type: Date, default: null }
})

const emit = defineEmits(['update:modelValue', 'change'])

const isOpen = ref(false)
const currentDate = ref(new Date())
const selecting = ref(false) // 是否正在选择中（已选开始日期，未选结束日期）
const tempStart = ref(null) // 临时开始日期
const tempEnd = ref(null) // 临时结束日期
const pickerRef = ref(null)
const dropdownStyle = ref({})
const scrollParents = ref([])
let resizeObserver = null

const weekDays = ['日', '一', '二', '三', '四', '五', '六']

const currentYear = computed(() => currentDate.value.getFullYear())
const currentMonth = computed(() => currentDate.value.getMonth())

// 显示值
const displayValue = computed(() => {
  const [start, end] = props.modelValue
  if (!start && !end) return ''
  const startStr = start ? formatDate(new Date(start)) : ''
  const endStr = end ? formatDate(new Date(end)) : ''
  if (startStr && endStr) return `${startStr} 至 ${endStr}`
  return startStr || endStr
})

// 日历天数
const calendarDays = computed(() => {
  const days = []
  const year = currentYear.value
  const month = currentMonth.value
  
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)
  const startWeekday = firstDay.getDay()
  
  // 上月日期
  const prevMonthLastDay = new Date(year, month, 0).getDate()
  for (let i = startWeekday - 1; i >= 0; i--) {
    days.push({
      date: new Date(year, month - 1, prevMonthLastDay - i),
      day: prevMonthLastDay - i,
      isCurrentMonth: false,
      isToday: isSameDay(new Date(year, month - 1, prevMonthLastDay - i), new Date())
    })
  }
  
  // 当月日期
  for (let i = 1; i <= lastDay.getDate(); i++) {
    const date = new Date(year, month, i)
    days.push({
      date,
      day: i,
      isCurrentMonth: true,
      isToday: isSameDay(date, new Date())
    })
  }
  
  // 下月日期
  const remaining = 42 - days.length
  for (let i = 1; i <= remaining; i++) {
    days.push({
      date: new Date(year, month + 1, i),
      day: i,
      isCurrentMonth: false,
      isToday: isSameDay(new Date(year, month + 1, i), new Date())
    })
  }
  
  return days
})

// 判断是否同一天
function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate()
}

// 格式化日期
function formatDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// 是否选中
function isSelected(dateInfo) {
  const date = dateInfo.date
  // 始终优先使用临时值（选择过程中或已选择但未确认）
  const start = tempStart.value || props.modelValue[0]
  const end = tempEnd.value || props.modelValue[1]
  
  if (start && isSameDay(date, new Date(start))) return true
  if (end && isSameDay(date, new Date(end))) return true
  return false
}

// 是否在范围内
function isInRange(dateInfo) {
  const date = dateInfo.date
  const start = selecting.value ? tempStart.value : props.modelValue[0]
  const end = selecting.value ? tempEnd.value : props.modelValue[1]
  
  if (!start || !end) return false
  const d = date.getTime()
  const s = new Date(start).getTime()
  const e = new Date(end).getTime()
  return d > Math.min(s, e) && d < Math.max(s, e)
}

// 是否开始日期
function isStartDate(dateInfo) {
  const start = selecting.value ? tempStart.value : props.modelValue[0]
  return start && isSameDay(dateInfo.date, new Date(start))
}

// 是否结束日期
function isEndDate(dateInfo) {
  const end = selecting.value ? tempEnd.value : props.modelValue[1]
  return end && isSameDay(dateInfo.date, new Date(end))
}

// 是否禁用
function isDisabled(dateInfo) {
  const date = dateInfo.date
  if (props.minDate && date < props.minDate) return true
  if (props.maxDate && date > props.maxDate) return true
  return false
}

// 选择日期
function selectDate(dateInfo) {
  if (isDisabled(dateInfo)) return

  const date = dateInfo.date

  if (!selecting.value) {
    // 开始新选择
    tempStart.value = date
    tempEnd.value = null
    selecting.value = true
  } else {
    // 完成选择，但不自动关闭，等待用户点击确认
    if (date < tempStart.value) {
      tempEnd.value = tempStart.value
      tempStart.value = date
    } else {
      tempEnd.value = date
    }
    selecting.value = false
    // 不再自动调用 confirm()，等待用户点击确定按钮
  }
}

// 应用预设
function applyPreset(preset) {
  const [start, end] = preset.value()
  emit('update:modelValue', [start, end])
  emit('change', [start, end])
  close()
}

// 开始监听位置变化
function startPositionListeners() {
  if (!pickerRef.value) return
  
  scrollParents.value = getScrollParents(pickerRef.value)
  
  scrollParents.value.forEach(parent => {
    if (parent === window) {
      window.addEventListener('scroll', handlePositionChange, true)
    } else {
      parent.addEventListener('scroll', handlePositionChange)
    }
  })
  
  window.addEventListener('resize', handlePositionChange)
  
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (isOpen.value) updateDropdownPosition()
    })
    resizeObserver.observe(pickerRef.value)
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
  if (isOpen.value) updateDropdownPosition()
}

// 计算 dropdown 位置
function updateDropdownPosition() {
  if (!pickerRef.value) return
  
  const rect = pickerRef.value.getBoundingClientRect()
  const viewportHeight = window.innerHeight
  const dropdownHeight = Math.min(380, viewportHeight * 0.5)
  const spaceBelow = viewportHeight - rect.bottom
  const spaceAbove = rect.top
  
  let top, maxHeight
  
  if (spaceBelow >= dropdownHeight) {
    top = rect.bottom + 4
    maxHeight = Math.min(dropdownHeight, spaceBelow - 8)
  } else if (spaceAbove >= dropdownHeight) {
    top = rect.top - Math.min(dropdownHeight, spaceAbove) - 4
    maxHeight = Math.min(dropdownHeight, spaceAbove - 8)
  } else {
    if (spaceBelow > spaceAbove) {
      top = rect.bottom + 4
      maxHeight = Math.max(200, spaceBelow - 8)
    } else {
      top = Math.max(4, rect.top - spaceAbove + 4)
      maxHeight = Math.max(200, spaceAbove - 8)
    }
  }
  
  dropdownStyle.value = {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${top}px`,
    width: `${rect.width}px`,
    maxHeight: `${maxHeight}px`,
    zIndex: 10000
  }
}

// 切换面板
function togglePicker() {
  if (props.disabled) return
  const wasOpen = isOpen.value
  isOpen.value = !isOpen.value
  
  if (isOpen.value && !wasOpen) {
    selecting.value = false
    tempStart.value = props.modelValue[0] ? new Date(props.modelValue[0]) : null
    tempEnd.value = props.modelValue[1] ? new Date(props.modelValue[1]) : null
    startPositionListeners()
    nextTick(() => updateDropdownPosition())
  } else if (!isOpen.value) {
    stopPositionListeners()
  }
}

// 关闭面板
function close() {
  isOpen.value = false
  selecting.value = false
  stopPositionListeners()
}

// 确认选择
function confirm() {
  const start = tempStart.value ? formatDate(tempStart.value) : null
  const end = tempEnd.value ? formatDate(tempEnd.value) : null
  emit('update:modelValue', [start, end])
  emit('change', [start, end])
  close()
}

// 清空
function clear() {
  tempStart.value = null
  tempEnd.value = null
  emit('update:modelValue', [null, null])
  emit('change', [null, null])
  close()
}

// 上月
function prevMonth() {
  currentDate.value = new Date(currentYear.value, currentMonth.value - 1, 1)
}

// 下月
function nextMonth() {
  currentDate.value = new Date(currentYear.value, currentMonth.value + 1, 1)
}

onUnmounted(() => {
  stopPositionListeners()
})
</script>

<style scoped>
.native-date-range-picker {
  position: relative;
  display: inline-block;
  width: 100%;
}

.native-date-range-picker--disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.native-date-range-picker__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border: 1px solid #dcdcdc;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  transition: all 0.2s;
  min-height: 36px;
}

.native-date-range-picker__trigger:hover:not(.native-date-range-picker--disabled) {
  border-color: #0052d9;
}

.native-date-range-picker__trigger--active {
  border-color: #0052d9;
}

.native-date-range-picker__value {
  font-size: 14px;
  color: #333;
}

.native-date-range-picker__placeholder {
  font-size: 14px;
  color: #999;
}

.native-date-range-picker__icon {
  color: #999;
}

.native-date-range-picker__dropdown {
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 16px;
  min-width: 280px;
}

.native-date-range-picker__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.native-date-range-picker__nav {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  color: #666;
  transition: color 0.2s;
}

.native-date-range-picker__nav:hover {
  color: #0052d9;
}

.native-date-range-picker__current {
  font-weight: 600;
  font-size: 14px;
  color: #333;
}

.native-date-range-picker__weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
  margin-bottom: 8px;
}

.native-date-range-picker__weekday {
  text-align: center;
  font-size: 12px;
  color: #999;
  padding: 4px;
}

.native-date-range-picker__days {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.native-date-range-picker__day {
  aspect-ratio: 1;
  border: none;
  background: none;
  cursor: pointer;
  border-radius: 4px;
  font-size: 13px;
  color: #333;
  transition: all 0.2s;
}

.native-date-range-picker__day:hover:not(:disabled) {
  background: #f0f0f0;
}

.native-date-range-picker__day--other-month {
  color: #ccc;
}

.native-date-range-picker__day--today {
  color: #0052d9;
  font-weight: 600;
}

.native-date-range-picker__day--selected {
  background: #0052d9;
  color: #fff;
  font-weight: 500;
}

.native-date-range-picker__day--selected:hover {
  background: #0043b5;
}

/* 开始日期 - 蓝色背景白字 */
.native-date-range-picker__day--start {
  background: #0052d9;
  color: #fff;
  font-weight: 500;
}

.native-date-range-picker__day--start:hover {
  background: #0043b5;
}

/* 结束日期 - 蓝色背景白字 */
.native-date-range-picker__day--end {
  background: #0052d9;
  color: #fff;
  font-weight: 500;
}

.native-date-range-picker__day--end:hover {
  background: #0043b5;
}

/* 范围内日期 - 浅蓝色背景，深色文字 */
.native-date-range-picker__day--in-range {
  background: #e8f4ff;
  color: #333;
}

.native-date-range-picker__day--disabled {
  color: #ccc;
  cursor: not-allowed;
}

.native-date-range-picker__presets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #e8e8e8;
}

.native-date-range-picker__preset {
  padding: 4px 12px;
  font-size: 12px;
  border: 1px solid #dcdcdc;
  background: #fff;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.native-date-range-picker__preset:hover {
  border-color: #0052d9;
  color: #0052d9;
}

.native-date-range-picker__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #e8e8e8;
}

.native-date-range-picker__btn {
  padding: 6px 16px;
  font-size: 13px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.native-date-range-picker__btn--text {
  background: none;
  border: none;
  color: #666;
}

.native-date-range-picker__btn--text:hover {
  color: #333;
}

.native-date-range-picker__btn--primary {
  background: #0052d9;
  border: none;
  color: #fff;
}

.native-date-range-picker__btn--primary:hover {
  background: #0043b5;
}
</style>
