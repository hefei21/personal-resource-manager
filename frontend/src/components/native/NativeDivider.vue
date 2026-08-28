<template>
  <div 
    class="native-divider" 
    :class="[`native-divider--${layout}`, { 'native-divider--dashed': dashed }]"
    :style="dividerStyle"
  >
    <div v-if="$slots.default" class="native-divider__content">
      <slot />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  layout: { type: String, default: 'horizontal' }, // horizontal, vertical
  align: { type: String, default: 'center' }, // left, center, right
  dashed: { type: Boolean, default: false },
  margin: { type: [String, Number], default: '16px' }
})

const dividerStyle = computed(() => {
  const marginValue = typeof props.margin === 'number' ? `${props.margin}px` : props.margin
  if (props.layout === 'vertical') {
    return {
      margin: `0 ${marginValue}`,
      height: '100%'
    }
  }
  return {
    margin: `${marginValue} 0`,
    '--divider-before-grow': props.align === 'left' ? 0 : 1,
    '--divider-after-grow': props.align === 'right' ? 0 : 1
  }
})
</script>

<style scoped>
.native-divider {
  display: flex;
  align-items: center;
}

/* 水平分割线 */
.native-divider--horizontal {
  width: 100%;
}

.native-divider--horizontal::before,
.native-divider--horizontal::after {
  content: '';
  flex: var(--divider-before-grow, 1);
  height: 1px;
  background: var(--color-border-subtle);
}

.native-divider--horizontal::after { flex-grow: var(--divider-after-grow, 1); }

.native-divider--horizontal.native-divider--dashed::before,
.native-divider--horizontal.native-divider--dashed::after {
  background: repeating-linear-gradient(
    to right,
    var(--color-border-default),
    var(--color-border-default) 4px,
    transparent 4px,
    transparent 8px
  );
}

.native-divider--horizontal .native-divider__content {
  padding: 0 16px;
  font-size: 14px;
  color: var(--color-text-muted);
  white-space: nowrap;
}

/* 垂直分割线 */
.native-divider--vertical {
  display: inline-flex;
  width: 1px;
  height: 1em;
  background: var(--color-border-subtle);
  vertical-align: middle;
}

.native-divider--vertical.native-divider--dashed {
  background: repeating-linear-gradient(
    to bottom,
    var(--color-border-default),
    var(--color-border-default) 4px,
    transparent 4px,
    transparent 8px
  );
}

.native-divider--vertical .native-divider__content {
  display: none;
}
</style>
