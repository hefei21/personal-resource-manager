<template>
  <section class="rag-plan" aria-label="分步提问计划">
    <header><h2>分步提问</h2><button type="button" @click="$emit('close')">关闭计划</button></header>
    <p>原问题：{{ question }}</p>
    <p>将不同资料的要求拆成 2–4 个完整问题，并逐项选择来源。仅按明确分号或换行预填，请检查每项含义是否完整。确认前不会检索或调用回答模型。草稿仅留在本页。</p>
    <template v-if="state === 'draft'">
      <fieldset v-for="(row, index) in rows" :key="row.id">
        <legend>子问题 {{ index + 1 }}</legend>
        <label>问题<textarea v-model="row.q" maxlength="256" rows="2" /></label>
        <label>资料<select v-model="row.sourceKey"><option value="">请选择资料（不自动推断）</option><option v-for="source in sources" :key="source.key" :value="source.key">{{ source.title }} · {{ source.type }}</option></select></label>
        <button v-if="rows.length > 2" type="button" @click="rows.splice(index, 1)">移除此项</button>
      </fieldset>
      <p>列表来自当前已读取的资料目录；找不到来源时请关闭计划并刷新回答范围，不会自动扩大到全部资料。</p>
      <footer><button type="button" :disabled="rows.length >= 4" @click="addRow">添加子问题</button><button type="button" :disabled="!valid" @click="plan.confirm(rows, sources)">确认并依次提问</button></footer>
    </template>
    <template v-else>
      <p role="status">{{ stateLabel }} · {{ completed }} / {{ items.length }} 项已有结果。各项引用编号独立，不代表已形成跨资料综合结论。</p>
      <button v-if="state === 'running' || state === 'paused'" type="button" @click="plan.stop">停止后续提问</button>
      <button v-if="state === 'paused'" type="button" @click="plan.resume">继续查询当前任务</button>
      <article v-for="(item, index) in items" :key="index">
        <h3>{{ index + 1 }}. {{ item.q }}</h3><p>{{ item.title }} · {{ statusLabel(item.status) }}</p>
        <p v-if="item.feedback" role="alert">{{ item.feedback }}</p>
        <RagEvidenceResult v-if="item.result" :result="item.result" @open-citation="$emit('open-citation', $event)" />
      </article>
    </template>
  </section>
</template>
<script setup>
import { computed, onBeforeUnmount, onDeactivated, ref } from 'vue'
import { useRagPlan, validateRagPlan, draftRagQuestions } from '@/composables/useRagPlan'
import RagEvidenceResult from '@/components/RagEvidenceResult.vue'
const props = defineProps({ question: String, sources: { type: Array, required: true }, api: Object, normalizeResult: Function, errorLabel: Function })
defineEmits(['close', 'open-citation'])
let nextId = 0
const rows = ref(draftRagQuestions(props.question).map(q => ({ id: nextId++, q, sourceKey: '' })))
function addRow() { rows.value.push({ id: nextId++, q: '', sourceKey: '' }) }
const plan = useRagPlan({ api: props.api, normalizeResult: props.normalizeResult, errorLabel: props.errorLabel })
const { state, items } = plan
const valid = computed(() => Boolean(validateRagPlan(rows.value, props.sources)))
const completed = computed(() => items.value.filter(item => item.result).length)
const stateLabel = computed(() => ({ running: '正在逐项提问', complete: '分项结果已汇总', paused: '连接中断，后续提问已暂停', error: '当前项失败，后续提问未执行', stopped: '已停止继续执行' })[state.value])
function statusLabel(status) { return ({ waiting: '未执行', running: '正在提问', submitting: '正在检索并筛选证据…', polling: '等待结果', cancelling: '正在取消', answered: '已回答', partial: '部分回答 · 尚有缺证项', abstained: '证据不足', degraded: '降级结果', paused: '等待恢复连接', error: '失败', cancelled: '已取消' })[status] || status }
onBeforeUnmount(plan.dispose)
onDeactivated(() => {
  if (state.value === 'running' || state.value === 'paused') void plan.stop()
})
</script>
<style scoped>
.rag-plan { margin-top: 20px; padding: 18px; border: 1px solid var(--color-border-default); border-radius: 12px; background: var(--color-surface-raised); color: var(--color-text-primary); }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
h2 { margin: 0; font-size: 18px; } h3 { font-size: 16px; }
p { line-height: 1.6; overflow-wrap: anywhere; }
fieldset, article { min-width: 0; margin: 16px 0; padding: 14px; border: 1px solid var(--color-border-subtle); border-radius: 8px; }
label { display: grid; gap: 6px; margin-bottom: 12px; }
textarea, select, button { font: inherit; color: var(--color-text-primary); background: var(--color-surface-raised); border: 1px solid var(--color-border-default); border-radius: 7px; padding: 10px; min-height: 44px; }
textarea, select { width: 100%; box-sizing: border-box; } button { cursor: pointer; } button:disabled { opacity: .5; cursor: not-allowed; }
</style>
