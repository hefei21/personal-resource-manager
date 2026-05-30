<template>
  <span 
    class="native-tag" 
    :class="[`native-tag--${theme}`, `native-tag--${variant}`, { 'native-tag--closable': closable }]"
  >
    <slot />
    <span v-if="closable" class="native-tag__close" @click.stop="$emit('close')">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
      </svg>
    </span>
  </span>
</template>

<script setup>
defineProps({
  theme: { type: String, default: 'default' }, // default, primary, success, warning, danger
  variant: { type: String, default: 'light' }, // light, solid, outline
  closable: { type: Boolean, default: false }
})

defineEmits(['close'])
</script>

<style scoped>
.native-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  cursor: default;
  transition: all 0.2s;
}

.native-tag--light.native-tag--default { background: #f5f5f5; color: #666; }
.native-tag--light.native-tag--primary { background: #e8f4ff; color: #0052d9; }
.native-tag--light.native-tag--success { background: #e8f8f0; color: #00a870; }
.native-tag--light.native-tag--warning { background: #fff4e6; color: #ed7b2f; }
.native-tag--light.native-tag--danger { background: #fff0f0; color: #e34d59; }

.native-tag--solid.native-tag--default { background: #f5f5f5; color: #666; }
.native-tag--solid.native-tag--primary { background: #0052d9; color: #fff; }
.native-tag--solid.native-tag--success { background: #00a870; color: #fff; }
.native-tag--solid.native-tag--warning { background: #ed7b2f; color: #fff; }
.native-tag--solid.native-tag--danger { background: #e34d59; color: #fff; }

.native-tag--outline.native-tag--default { background: transparent; border: 1px solid #dcdcdc; color: #666; }
.native-tag--outline.native-tag--primary { background: transparent; border: 1px solid #0052d9; color: #0052d9; }
.native-tag--outline.native-tag--success { background: transparent; border: 1px solid #00a870; color: #00a870; }
.native-tag--outline.native-tag--warning { background: transparent; border: 1px solid #ed7b2f; color: #ed7b2f; }
.native-tag--outline.native-tag--danger { background: transparent; border: 1px solid #e34d59; color: #e34d59; }

.native-tag__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.2s;
}

.native-tag__close:hover {
  opacity: 1;
}

.native-tag--closable {
  padding-right: 6px;
}
</style>
