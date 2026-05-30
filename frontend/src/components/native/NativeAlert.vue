<template>
  <Transition name="native-alert">
    <div 
      v-if="!closed" 
      class="native-alert" 
      :class="[`native-alert--${theme}`, { 'native-alert--closable': closable }]"
    >
      <div class="native-alert__icon" v-if="showIcon">
        <svg v-if="theme === 'success'" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        <svg v-else-if="theme === 'warning'" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
        </svg>
        <svg v-else-if="theme === 'error'" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
        </svg>
        <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
        </svg>
      </div>
      <div class="native-alert__content">
        <div v-if="title" class="native-alert__title">{{ title }}</div>
        <div class="native-alert__message">
          <slot />
        </div>
      </div>
      <button v-if="closable" class="native-alert__close" @click="handleClose">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      </button>
    </div>
  </Transition>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  theme: { type: String, default: 'info' }, // info, success, warning, error
  title: { type: String, default: '' },
  closable: { type: Boolean, default: false },
  showIcon: { type: Boolean, default: true }
})

const emit = defineEmits(['close'])

const closed = ref(false)

function handleClose() {
  closed.value = true
  emit('close')
}
</script>

<style scoped>
.native-alert {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 6px;
  position: relative;
}

.native-alert__icon {
  flex-shrink: 0;
  margin-top: 2px;
}

.native-alert__content {
  flex: 1;
  min-width: 0;
}

.native-alert__title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 4px;
}

.native-alert__message {
  font-size: 14px;
  line-height: 1.5;
}

.native-alert__close {
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 4px;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.2s;
  color: inherit;
}

.native-alert__close:hover {
  opacity: 1;
}

/* 主题样式 */
.native-alert--info {
  background: linear-gradient(135deg, #e8f4ff 0%, #f0f7ff 100%);
  color: #0052d9;
  border: 1px solid rgba(0, 82, 217, 0.15);
  box-shadow: 0 2px 8px rgba(0, 82, 217, 0.08);
}

.native-alert--success {
  background: #e8f8f0;
  color: #00a870;
}

.native-alert--warning {
  background: #fff4e6;
  color: #ed7b2f;
}

.native-alert--error {
  background: #fff0f0;
  color: #e34d59;
}

/* 动画 */
.native-alert-enter-active,
.native-alert-leave-active {
  transition: all 0.3s ease;
}

.native-alert-enter-from,
.native-alert-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
</style>
