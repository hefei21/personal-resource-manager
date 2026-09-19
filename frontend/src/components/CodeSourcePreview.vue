<template>
  <div ref="scroller" class="code-source" tabindex="0" aria-label="源码内容">
    <p v-if="line && !targetLine" class="code-source__notice" role="status">引用行超出当前文件范围，请重新搜索确认位置。</p>
    <div class="code-source__body" :style="targetLine ? { '--target-top': `${(targetLine - 1) * 22 + 16}px` } : {}">
      <div class="code-source__gutter" aria-hidden="true"><span v-for="number in lineCount" :key="number" :data-source-line="number" :class="{ active: number === targetLine }">{{ number }}</span></div>
      <pre class="code-source__text" :class="{ 'has-target': targetLine }"><code v-html="html || ' '" /></pre>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'

// html is produced by the caller's sanitizeHighlightHtml / escapeHtml boundary.
const props = defineProps({ content: { type: String, default: '' }, html: { type: String, default: '' }, line: { type: Number, default: null } })
const scroller = ref(null)
const lineCount = computed(() => props.content.split('\n').length)
const targetLine = computed(() => Number.isSafeInteger(props.line) && props.line > 0 && props.line <= lineCount.value ? props.line : null)
watch(() => [props.content, props.line], async () => {
  await nextTick()
  if (!scroller.value) return
  scroller.value.scrollTop = targetLine.value ? Math.max(0, (targetLine.value - 1) * 22 + 16 - scroller.value.clientHeight / 2) : 0
  scroller.value.scrollLeft = 0
}, { immediate: true })
</script>

<style scoped>
.code-source{height:100%;min-height:0;overflow:auto;background:var(--color-surface-raised);color:var(--color-text-primary);outline-offset:-3px}
.code-source__body{display:grid;grid-template-columns:auto minmax(0,1fr);min-width:100%;width:max-content;align-items:start}
.code-source__gutter{position:sticky;left:0;z-index:1;display:grid;padding:16px 0;background:var(--color-surface-subtle);border-right:1px solid var(--color-border-subtle);user-select:none}
.code-source__gutter span{height:22px;line-height:22px;padding:0 12px;min-width:40px;box-sizing:border-box;text-align:right;font:12px/22px ui-monospace,monospace;color:var(--color-text-muted)}
.code-source__gutter span.active{background:var(--color-primary-surface);color:var(--color-primary);font-weight:700}
.code-source__text{margin:0;padding:16px;min-width:0;font:13px/22px ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:4;white-space:pre}
.code-source__text code{font:inherit;line-height:inherit}
.code-source__text.has-target{background:linear-gradient(to bottom,transparent var(--target-top),var(--color-primary-surface) var(--target-top),var(--color-primary-surface) calc(var(--target-top) + 22px),transparent calc(var(--target-top) + 22px))}
.code-source__notice{margin:0;padding:10px 16px;font-size:13px;background:var(--color-surface-subtle);color:var(--color-text-secondary)}
</style>
