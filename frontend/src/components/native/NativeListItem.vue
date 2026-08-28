<template>
  <div 
    class="native-list-item" 
    :class="{ 
      'native-list-item--active': active,
      'native-list-item--hover': hover,
      'native-list-item--disabled': disabled
    }"
    :role="interactive ? 'button' : undefined"
    :tabindex="interactive && !disabled ? 0 : undefined"
    :aria-disabled="interactive ? disabled : undefined"
    @click="handleClick"
    @keydown.enter.prevent="handleKeyboardActivate"
    @keydown.space.prevent="handleKeyboardActivate"
  >
    <!-- 左侧内容 -->
    <div v-if="$slots.prefix?.() || avatar" class="native-list-item__prefix">
      <slot name="prefix">
        <img v-if="avatar" :src="avatar" :alt="avatarAlt" class="native-list-item__avatar" />
      </slot>
    </div>
    
    <!-- 主要内容 -->
    <div class="native-list-item__content">
      <!-- 如果使用了默认插槽，直接渲染默认插槽内容 -->
      <slot v-if="$slots.default"></slot>
      <!-- 否则使用 title/description 模式 -->
      <template v-else>
        <div v-if="title || $slots.title" class="native-list-item__title">
          <slot name="title">{{ title }}</slot>
        </div>
        <div v-if="description || $slots.description" class="native-list-item__description">
          <slot name="description">{{ description }}</slot>
        </div>
      </template>
    </div>
    
    <!-- 右侧内容 -->
    <div v-if="$slots.suffix?.() || action" class="native-list-item__suffix">
      <slot name="suffix">
        <span v-if="action" class="native-list-item__action">{{ action }}</span>
      </slot>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  avatar: { type: String, default: '' },
  action: { type: String, default: '' },
  active: { type: Boolean, default: false },
  hover: { type: Boolean, default: true },
  disabled: { type: Boolean, default: false },
  interactive: { type: Boolean, default: false },
  avatarAlt: { type: String, default: '' }
})

const emit = defineEmits(['click'])

function handleClick() {
  if (!props.disabled) {
    emit('click')
  }
}

function handleKeyboardActivate() {
  if (props.interactive) handleClick()
}
</script>

<style scoped>
.native-list-item {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  cursor: default;
  transition: background-color var(--motion-duration-fast) var(--motion-easing-standard);
}

.native-list-item[role='button'] { cursor: pointer; }
.native-list-item[role='button']:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: -2px; }

.native-list-item:hover:not(.native-list-item--disabled) {
  background: var(--color-surface-subtle);
}

.native-list-item--active {
  background: var(--color-primary-surface);
}

.native-list-item--disabled {
  opacity: var(--opacity-disabled);
  cursor: not-allowed;
}

.native-list-item__prefix {
  margin-right: 12px;
  flex-shrink: 0;
}

.native-list-item__avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
}

.native-list-item__content {
  flex: 1;
  min-width: 0;
}

.native-list-item__title {
  font-size: 14px;
  color: var(--color-text-primary);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.native-list-item__description {
  font-size: 13px;
  color: var(--color-text-secondary);
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.native-list-item__suffix {
  margin-left: 12px;
  flex-shrink: 0;
}

.native-list-item__action {
  font-size: 13px;
  color: var(--color-primary);
}
</style>
