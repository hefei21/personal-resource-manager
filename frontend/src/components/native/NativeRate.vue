<template>
  <div class="native-rate" :class="{ 'native-rate--disabled': disabled, 'native-rate--readonly': readonly }">
    <span
      v-for="index in count"
      :key="index"
      class="native-rate__star"
      :class="{ 'native-rate__star--active': isActive(index) }"
      @mousemove="handleMouseMove($event, index)"
      @mouseleave="handleMouseLeave"
      @click="handleClick($event, index)"
    >
      <!-- 默认星星图标 - 双层叠加实现半星 -->
      <template v-if="!$slots.character">
        <!-- 底层：空星（灰色背景） -->
        <svg viewBox="0 0 24 24" class="native-rate__icon native-rate__icon--empty">
          <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
        </svg>
        <!-- 上层：填充星（金色），通过 width 控制显示范围 -->
        <div 
          class="native-rate__icon-wrapper"
          :style="{ width: getStarFillWidth(index) }"
        >
          <svg viewBox="0 0 24 24" class="native-rate__icon native-rate__icon--full">
            <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
          </svg>
        </div>
      </template>
      
      <!-- 自定义字符 -->
      <slot v-else name="character" :index="index"></slot>
    </span>
    
    <!-- 辅助文字 -->
    <span v-if="showText && texts.length > 0" class="native-rate__text">
      {{ texts[Math.ceil(displayValue) - 1] || texts[texts.length - 1] }}
    </span>
    
    <!-- 评分值 -->
    <span v-if="showScore" class="native-rate__score">{{ displayValue }}</span>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  count: { type: Number, default: 5 },
  allowHalf: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false },
  showText: { type: Boolean, default: false },
  showScore: { type: Boolean, default: false },
  texts: { type: Array, default: () => ['极差', '失望', '一般', '满意', '惊喜'] },
  clearable: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue', 'change'])

// 当前显示的值（hover 时显示 hover 值，否则显示 modelValue）
const hoverValue = ref(0)
const isHovering = ref(false)

// 实际显示的值
const displayValue = computed(() => {
  return isHovering.value ? hoverValue.value : props.modelValue
})

// 判断是否为激活状态（用于样式）
function isActive(index) {
  const val = displayValue.value
  if (props.allowHalf) {
    return val >= index - 0.5
  }
  return val >= index
}

// 获取星星的填充宽度（TDesign 方式：通过 width 控制显示范围）
function getStarFillWidth(index) {
  const val = displayValue.value
  const integerPart = Math.floor(val)
  const decimalPart = val - integerPart
  
  if (index <= integerPart) {
    // 满星
    return '100%'
  } else if (index === integerPart + 1 && decimalPart >= 0.5 && props.allowHalf) {
    // 半星
    return '50%'
  } else {
    // 空星
    return '0%'
  }
}

// 根据鼠标位置计算值
function calculateValue(event, index) {
  const target = event.currentTarget
  const rect = target.getBoundingClientRect()
  const x = event.clientX - rect.left
  const width = rect.width
  
  if (props.allowHalf) {
    // 左半边为半星，右半边为整星
    return x < width / 2 ? index - 0.5 : index
  }
  return index
}

function handleMouseMove(event, index) {
  if (props.disabled || props.readonly) return
  isHovering.value = true
  hoverValue.value = calculateValue(event, index)
}

function handleMouseLeave() {
  if (props.disabled || props.readonly) return
  isHovering.value = false
  hoverValue.value = 0
}

function handleClick(event, index) {
  if (props.disabled || props.readonly) return
  
  const value = calculateValue(event, index)
  
  // 支持清除：点击相同的值时清除
  if (props.clearable && value === props.modelValue) {
    emit('update:modelValue', 0)
    emit('change', 0)
    return
  }
  
  emit('update:modelValue', value)
  emit('change', value)
}
</script>

<style scoped>
.native-rate {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.native-rate--disabled,
.native-rate--readonly {
  cursor: not-allowed;
}

.native-rate__star {
  position: relative;
  display: inline-flex;
  cursor: pointer;
  font-size: 20px;
  transition: transform 0.2s;
}

.native-rate__star:hover:not(.native-rate--disabled .native-rate__star):not(.native-rate--readonly .native-rate__star) {
  transform: scale(1.1);
}

.native-rate__star {
  position: relative;
  display: inline-flex;
  cursor: pointer;
  font-size: 20px;
  transition: transform 0.2s;
  width: 20px;
  height: 20px;
}

.native-rate__icon {
  width: 20px;
  height: 20px;
}

/* 底层空星（灰色） */
.native-rate__icon--empty {
  fill: #e8e8e8;
}

/* 上层填充星容器 - 通过 width 控制显示范围 */
.native-rate__icon-wrapper {
  position: absolute;
  left: 0;
  top: 0;
  width: 20px;
  height: 20px;
  overflow: hidden;
  transition: width 0.15s;
}

/* 上层填充星（金色） */
.native-rate__icon--full {
  fill: #fadb14;
  display: block;
}

/* hover 状态下的星星样式 */
.native-rate__star:hover {
  transform: scale(1.1);
}

.native-rate__text {
  margin-left: 8px;
  font-size: 14px;
  color: #666;
}

.native-rate__score {
  margin-left: 8px;
  font-size: 14px;
  color: #fadb14;
  font-weight: 600;
}
</style>
