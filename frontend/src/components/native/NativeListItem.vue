<template>
  <div 
    class="native-list-item" 
    :class="{ 
      'native-list-item--active': active,
      'native-list-item--hover': hover,
      'native-list-item--disabled': disabled
    }"
    @click="handleClick"
  >
    <!-- 左侧内容 -->
    <div v-if="$slots.prefix?.() || avatar" class="native-list-item__prefix">
      <slot name="prefix">
        <img v-if="avatar" :src="avatar" class="native-list-item__avatar" />
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
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['click'])

function handleClick() {
  if (!props.disabled) {
    emit('click')
  }
}
</script>

<style scoped>
.native-list-item {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  cursor: pointer;
  transition: background 0.2s;
}

.native-list-item:hover:not(.native-list-item--disabled) {
  background: #f5f5f5;
}

.native-list-item--active {
  background: #e6f7ff;
}

.native-list-item--disabled {
  opacity: 0.5;
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
  color: #333;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.native-list-item__description {
  font-size: 13px;
  color: #666;
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
  color: #0052d9;
}
</style>
