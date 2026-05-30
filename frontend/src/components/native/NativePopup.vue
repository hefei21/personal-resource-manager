<template>
  <Teleport to="body" v-if="teleport">
    <Transition name="native-popup">
      <div v-if="modelValue" class="native-popup-wrapper">
        <div class="native-popup-overlay" @click="handleOverlayClick"></div>
        <div class="native-popup" :class="[`native-popup--${placement}`, popupClass]" :style="popupStyle">
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
  <Transition name="native-popup" v-else>
    <div v-if="modelValue" class="native-popup-wrapper native-popup--inline">
      <div class="native-popup-overlay" @click="handleOverlayClick"></div>
      <div class="native-popup" :class="[`native-popup--${placement}`, popupClass]" :style="popupStyle">
        <slot />
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  placement: { type: String, default: 'center' }, // center, top, bottom, left, right
  popupClass: { type: String, default: '' },
  popupStyle: { type: Object, default: () => ({}) },
  closeOnOverlayClick: { type: Boolean, default: true },
  teleport: { type: Boolean, default: true },
  overlay: { type: Boolean, default: true },
  zIndex: { type: Number, default: 5000 }
})

const emit = defineEmits(['update:modelValue', 'close'])

function handleOverlayClick() {
  if (props.closeOnOverlayClick) {
    emit('update:modelValue', false)
    emit('close')
  }
}
</script>

<style scoped>
.native-popup-wrapper {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: v-bind(zIndex);
}

.native-popup--inline {
  position: absolute;
}

.native-popup-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
}

.native-popup {
  position: relative;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  max-width: 90vw;
  max-height: 90vh;
  overflow: auto;
}

/* 位置变体 */
.native-popup--center {
  margin: auto;
}

.native-popup--top {
  position: absolute;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
}

.native-popup--bottom {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
}

.native-popup--left {
  position: absolute;
  left: 20px;
  top: 50%;
  transform: translateY(-50%);
}

.native-popup--right {
  position: absolute;
  right: 20px;
  top: 50%;
  transform: translateY(-50%);
}

/* 动画 */
.native-popup-enter-active,
.native-popup-leave-active {
  transition: opacity 0.3s ease;
}

.native-popup-enter-from,
.native-popup-leave-to {
  opacity: 0;
}

.native-popup-enter-active .native-popup,
.native-popup-leave-active .native-popup {
  transition: transform 0.3s ease;
}

.native-popup-enter-from .native-popup,
.native-popup-leave-to .native-popup {
  transform: scale(0.95);
}

.native-popup-enter-from .native-popup--top,
.native-popup-leave-to .native-popup--top {
  transform: translateX(-50%) translateY(-20px);
}

.native-popup-enter-from .native-popup--bottom,
.native-popup-leave-to .native-popup--bottom {
  transform: translateX(-50%) translateY(20px);
}

.native-popup-enter-from .native-popup--left,
.native-popup-leave-to .native-popup--left {
  transform: translateY(-50%) translateX(-20px);
}

.native-popup-enter-from .native-popup--right,
.native-popup-leave-to .native-popup--right {
  transform: translateY(-50%) translateX(20px);
}
</style>
