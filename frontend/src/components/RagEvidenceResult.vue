<template>
  <section class="rag-evidence-result" aria-label="资料检索结果">
    <p v-if="result.degraded" class="notice" role="status">{{ result.degradedLabel }}</p>
    <template v-if="result.structured">
      <h3>资料记录</h3>
      <p class="explanation">直接查询资料记录，未调用 AI 生成。</p>
      <p class="answer">{{ result.answer }}</p>
      <button v-for="item in result.citations.filter(item => item.openUrl)" :key="item.label" type="button" @click="$emit('open-citation', item)">打开 {{ item.title }}</button>
    </template>
    <template v-else>
    <h3>原文证据 <span>{{ result.evidence.length }} 条片段</span></h3>
    <p class="explanation">检索到相关片段，不代表证据已足以回答。请结合上下文核对；E 编号标记原文片段，与 AI 引用编号独立。</p>
    <ol v-if="result.evidence.length" class="evidence-list">
      <li v-for="item in result.evidence" :key="item.label">
        <header><span class="label">{{ item.label }}</span><strong>{{ item.title }}</strong></header>
        <p v-if="item.section || item.version" class="metadata">{{ item.section }} {{ item.version }}</p>
        <blockquote v-if="item.excerpt">{{ item.excerpt }}</blockquote>
        <p v-else class="metadata">原文摘录暂不可展示，请核对来源。</p>
        <p v-if="item.excerptTruncated" class="metadata">此处仅显示部分原文，不代表完整上下文。</p>
        <button v-if="item.openUrl" type="button" @click="$emit('open-citation', item)">打开来源</button>
      </li>
    </ol>
    <p v-else class="notice">本次未返回可展示的原文片段。不能据此确认问题已有充分依据。</p>
    <p v-if="result.abstained" class="notice" role="status">{{ result.reasonLabel || '当前证据不足，未生成总结。' }}</p>
    <details v-if="result.answer && !result.abstained" class="ai-summary">
      <summary><strong>AI 总结</strong><span>尚未经逐项核验</span></summary>
      <p class="explanation">以下为模型生成内容，可能遗漏条件、弱化约束或错误判断证据是否充分，不作为已验证结论。</p>
      <p class="answer">{{ result.answer }}</p>
      <ul v-if="result.citations.length" class="ai-citations" aria-label="AI 返回的引用">
        <li v-for="citation in result.citations" :key="citation.label">{{ citation.label }} · {{ citation.title }} <span>{{ citation.section }}</span></li>
      </ul>
    </details>
    </template>
  </section>
</template>
<script setup>
defineProps({ result: { type: Object, required: true } })
defineEmits(['open-citation'])
</script>
<style scoped>
.rag-evidence-result { color: var(--color-text-primary); min-width: 0; }
h3 { margin: 0; font-size: 16px; } h3 span, .metadata, .explanation { color: var(--color-text-secondary); font-size: 13px; font-weight: 400; }
p { line-height: 1.65; overflow-wrap: anywhere; }
.evidence-list { list-style: none; padding: 0; margin: 16px 0; }
.evidence-list > li { padding: 16px 0; border-top: 1px solid var(--color-border-subtle); }
header { display: flex; align-items: baseline; gap: 10px; overflow-wrap: anywhere; }
header strong { min-width: 0; font-size: 14px; } .label { flex: none; color: var(--color-text-secondary); font-size: 12px; }
blockquote { margin: 12px 0; padding-left: 14px; border-left: 2px solid var(--color-border-default); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; font-size: 14px; }
.metadata { margin: 6px 0; } .notice { padding: 12px; background: var(--color-surface-subtle); border-radius: 6px; font-size: 14px; }
.ai-summary { border-top: 1px solid var(--color-border-default); margin-top: 20px; }
summary { cursor: pointer; padding: 14px 0; min-height: 44px; box-sizing: border-box; }
summary span { margin-left: 12px; color: var(--color-text-secondary); font-size: 13px; }
.answer { white-space: pre-wrap; font-size: 14px; } .ai-citations { padding-left: 20px; color: var(--color-text-secondary); font-size: 13px; }
button { min-height: 44px; background: transparent; border: 0; color: var(--color-primary); font: inherit; cursor: pointer; }
summary:focus-visible, button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
</style>
