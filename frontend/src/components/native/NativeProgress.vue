<template>
  <div class="native-progress" :class="{ 'native-progress--inline': inline }">
    <div 
      v-if="theme === 'line'" 
      class="native-progress__line"
      :class="[`native-progress--${size}`, { 'native-progress--striped': striped }]"
    >
      <div class="native-progress__track">
        <div 
          class="native-progress__bar" 
          :class="`native-progress__bar--${status}`"
          :style="{ width: `${percentage}%` }"
        >
          <div v-if="striped" class="native-progress__stripes"></div>
        </div>
      </div>
      <span v-if="!hideText" class="native-progress__text">
        <slot :percentage="percentage">
          {{ text || `${percentage}%` }}
        </slot>
      </span>
    </div>
    
    <div 
      v-else-if="theme === 'circle'" 
      class="native-progress__circle"
      :style="{ width: `${circleSize}px`, height: `${circleSize}px` }"
    >
      <svg viewBox="0 0 100 100">
        <circle 
          class="native-progress__circle-track" 
          cx="50" cy="50" :r="radius"
        />
        <circle 
          class="native-progress__circle-bar" 
          :class="`native-progress__circle-bar--${status}`"
          cx="50" cy="50" :r="radius"
          :style="circleStyle"
        />
      </svg>
      <span v-if="!hideText" class="native-progress__circle-text">
        <slot :percentage="percentage">
          {{ text || `${percentage}%` }}
        </slot>
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  percentage: { type: Number, default: 0 },
  theme: { type: String, default: 'line' }, // line, circle
  size: { type: String, default: 'medium' }, // small, medium, large
  status: { type: String, default: 'primary' }, // primary, success, warning, error
  striped: { type: Boolean, default: false },
  hideText: { type: Boolean, default: false },
  inline: { type: Boolean, default: false },
  text: { type: String, default: '' },
  circleSize: { type: Number, default: 80 },
  strokeWidth: { type: Number, default: 6 }
})

const radius = computed(() => 50 - props.strokeWidth / 2)

const circumference = computed(() => 2 * Math.PI * radius.value)

const circleStyle = computed(() => {
  const offset = circumference.value - (props.percentage / 100) * circumference.value
  return {
    strokeDasharray: circumference.value,
    strokeDashoffset: offset,
    strokeWidth: props.strokeWidth
  }
})
</script>

<style scoped>
.native-progress {
  width: 100%;
}

.native-progress--inline {
  display: inline-block;
  width: auto;
}

/* 线型进度条 */
.native-progress__line {
  display: flex;
  align-items: center;
  gap: 12px;
}

.native-progress__track {
  flex: 1;
  height: 8px;
  background: #e8e8e8;
  border-radius: 4px;
  overflow: hidden;
}

.native-progress--small .native-progress__track {
  height: 4px;
}

.native-progress--large .native-progress__track {
  height: 12px;
}

.native-progress__bar {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s ease;
  position: relative;
  overflow: hidden;
}

.native-progress__bar--primary { background: #0052d9; }
.native-progress__bar--success { background: #00a870; }
.native-progress__bar--warning { background: #ed7b2f; }
.native-progress__bar--error { background: #e34d59; }

.native-progress__stripes {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: linear-gradient(
    45deg,
    rgba(255, 255, 255, 0.2) 25%,
    transparent 25%,
    transparent 50%,
    rgba(255, 255, 255, 0.2) 50%,
    rgba(255, 255, 255, 0.2) 75%,
    transparent 75%,
    transparent
  );
  background-size: 20px 20px;
  animation: native-progress-stripes 1s linear infinite;
}

@keyframes native-progress-stripes {
  0% { background-position: 0 0; }
  100% { background-position: 20px 20px; }
}

.native-progress__text {
  font-size: 14px;
  color: #666;
  min-width: 40px;
  text-align: right;
}

/* 环形进度条 */
.native-progress__circle {
  position: relative;
  display: inline-block;
}

.native-progress__circle svg {
  transform: rotate(-90deg);
}

.native-progress__circle-track {
  fill: none;
  stroke: #e8e8e8;
  stroke-width: 6;
}

.native-progress__circle-bar {
  fill: none;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.3s ease;
}

.native-progress__circle-bar--primary { stroke: #0052d9; }
.native-progress__circle-bar--success { stroke: #00a870; }
.native-progress__circle-bar--warning { stroke: #ed7b2f; }
.native-progress__circle-bar--error { stroke: #e34d59; }

.native-progress__circle-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 14px;
  color: #333;
}
</style>
