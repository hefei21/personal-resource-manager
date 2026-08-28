<template>
  <main class="demo-shell">
    <header class="demo-header">
      <div class="brand-block">
        <span class="eyebrow">DEMO-ONLY · SYNTHETIC DATA</span>
        <h1>个人资源管理器</h1>
        <p>四条可操作旅程，展示检索、证据约束、持久任务和资源保护。</p>
      </div>
      <div class="header-actions">
        <button class="button secondary" :disabled="busy" @click="resetWorkspace">重置会话</button>
        <button class="button ghost" @click="leaveDemo">退出演示</button>
      </div>
    </header>

    <section class="isolation-bar" aria-label="演示隔离边界">
      <strong>独立受限运行面</strong>
      <span>不连接 Owner 数据</span>
      <span>不调用 PC Worker 或实时模型</span>
      <span>30 分钟后自动丢弃</span>
    </section>

    <section class="journey-section" aria-labelledby="journey-heading">
      <div class="section-heading">
        <div><span class="section-index">01</span><h2 id="journey-heading">选择一条技术旅程</h2></div>
        <p>每条旅程同时说明当前交互、生产契约与历史验收证据。</p>
      </div>
      <nav class="journey-grid" aria-label="演示旅程">
        <button
          v-for="(journey, index) in journeys"
          :key="journey.id"
          class="journey-card"
          :class="{ active: activeJourneyId === journey.id }"
          :aria-current="activeJourneyId === journey.id ? 'step' : undefined"
          @click="startJourney(journey.id)"
        >
          <span class="journey-number">0{{ index + 1 }}</span>
          <strong>{{ journey.title }}</strong>
          <span>{{ journey.summary }}</span>
        </button>
      </nav>
    </section>

    <section v-if="activeJourney" class="journey-workspace">
      <div class="interaction-panel">
        <div class="panel-heading">
          <div><span class="status-chip">合成演示</span><h2>{{ activeJourney.title }}</h2></div>
          <span v-if="result?.retrievalMode" class="mode-chip">{{ result.retrievalMode }}</span>
        </div>
        <div v-if="error" class="message error" role="alert">{{ error }}</div>
        <div v-if="notice" class="message success" role="status">{{ notice }}</div>

        <template v-if="activeJourneyId === 'discovery'">
          <form class="query-form" @submit.prevent="runDiscovery">
            <label for="demo-query">搜索合成资源</label>
            <div class="input-row">
              <input id="demo-query" v-model.trim="query" maxlength="80" placeholder="例如：Worker 恢复架构">
              <button class="button primary" :disabled="busy || !query">解释命中</button>
            </div>
          </form>
          <div v-if="busy" class="loading" role="status">正在执行确定性检索…</div>
          <ol v-else class="result-list">
            <li v-for="item in result?.results || []" :key="`${item.type}-${item.id}`">
              <div class="result-topline"><span class="type-chip">{{ typeLabel(item.type) }}</span><span>{{ item.source }}</span></div>
              <strong>{{ item.title }}</strong><p>{{ item.locator }}</p><small>{{ item.why }}</small>
            </li>
          </ol>
        </template>

        <template v-else-if="activeJourneyId === 'answer'">
          <div class="scenario-switch" role="group" aria-label="问答场景">
            <button v-for="option in answerScenarios" :key="option.value" :class="{ active: answerScenario === option.value }" @click="runAnswer(option.value)">{{ option.label }}</button>
          </div>
          <article v-if="result" class="answer-card" :class="result.status">
            <span class="answer-state">{{ result.status === 'refused' ? '明确拒答' : '引用式回答' }}</span>
            <p>{{ result.answer }}</p>
            <ul v-if="result.citations?.length" class="citation-list"><li v-for="(citation, index) in result.citations" :key="citation">[{{ index + 1 }}] {{ citation }}</li></ul>
          </article>
          <div v-if="result" class="pipeline" aria-label="执行路径">
            <template v-for="(step, index) in result.pipeline" :key="step"><span>{{ step }}</span><b v-if="index < result.pipeline.length - 1" aria-hidden="true">→</b></template>
          </div>
        </template>

        <template v-else-if="activeJourneyId === 'task'">
          <div class="scenario-switch" role="group" aria-label="任务场景">
            <button :class="{ active: taskScenario === 'success' }" @click="runTask('success')">正常完成</button>
            <button :class="{ active: taskScenario === 'offline' }" @click="runTask('offline')">模拟 Worker 失联</button>
          </div>
          <ol v-if="result" class="timeline">
            <li v-for="(state, index) in result.states" :key="`${state}-${index}`"><span>{{ index + 1 }}</span><div><strong>{{ taskStateLabel(state) }}</strong><small>{{ taskStateHint(state) }}</small></div></li>
          </ol>
          <dl v-if="result?.task" class="metadata-grid">
            <div><dt>处理器</dt><dd>{{ result.task.processor }}</dd></div><div><dt>尝试</dt><dd>{{ result.task.attempt }} / {{ result.task.maxAttempts }}</dd></div>
            <div><dt>心跳</dt><dd>{{ result.task.heartbeatAge }}</dd></div><div><dt>输入指纹</dt><dd>{{ result.task.inputFingerprint }}</dd></div>
          </dl>
        </template>

        <template v-else>
          <form class="query-form" @submit.prevent="createLifecycleItem">
            <label for="lifecycle-title">写入当前会话覆盖层</label>
            <div class="input-row"><input id="lifecycle-title" v-model.trim="lifecycleTitle" maxlength="80" placeholder="临时个人笔记标题"><button class="button primary" :disabled="busy || !lifecycleTitle">新增临时条目</button></div>
          </form>
          <ul class="overlay-list">
            <li v-for="item in lifecycleItems" :key="item.id"><div><strong>{{ item.title }}</strong><small>{{ item.demoCreated ? '当前会话新增' : item.demoUpdated ? '当前会话修改' : '合成基线' }}</small></div><button class="text-danger" :disabled="busy" @click="removeLifecycleItem(item)">移入会话回收层</button></li>
          </ul>
          <div class="layer-list"><div v-for="(layer, index) in result?.layers || []" :key="layer"><span>0{{ index + 1 }}</span>{{ layer }}</div></div>
        </template>
      </div>

      <aside class="evidence-panel">
        <section><span class="aside-label">预期结果</span><p>{{ activeJourney.expected }}</p></section>
        <section><span class="aside-label">为什么重要</span><p>{{ activeJourney.value }}</p></section>
        <section v-if="result?.evidence"><span class="aside-label">生产契约</span><p>{{ result.evidence.productionContract }}</p></section>
        <section v-if="result?.evidence"><span class="aside-label">历史验收证据</span><ul><li v-for="item in result.evidence.verification" :key="item">{{ item }}</li></ul><small>{{ result.evidence.boundary }}</small></section>
      </aside>
    </section>

    <footer class="demo-footer"><span>当前会话共 {{ totalResources }} 条合成资源</span><span>确定性模板不是实时模型输出</span></footer>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const authStore = useAuthStore()
const journeys = ref([])
const activeJourneyId = ref('discovery')
const result = ref(null)
const summary = ref({})
const lifecycleItems = ref([])
const query = ref('Worker 恢复架构')
const lifecycleTitle = ref('演示会话中的恢复笔记')
const answerScenario = ref('answer')
const taskScenario = ref('success')
const busy = ref(false)
const error = ref('')
const notice = ref('')
const answerScenarios = [{ value: 'answer', label: '正常回答' }, { value: 'unknown', label: '证据不足' }, { value: 'injection', label: '提示注入' }, { value: 'offline', label: 'Worker 离线' }]
const activeJourney = computed(() => journeys.value.find((journey) => journey.id === activeJourneyId.value))
const totalResources = computed(() => Object.values(summary.value).reduce((sum, count) => sum + Number(count || 0), 0))

function typeLabel(type) { return ({ documents: '文档', books: '电子书', code: '代码', notes: '个人笔记' })[type] || type }
function taskStateLabel(state) { return ({ pending: '等待领取', leased: '已租约', running: '处理中', heartbeat_lost: '心跳中断', lease_expired: '租约到期', re_leased: '重新领取', late_result_rejected: '拒绝迟到结果', succeeded: '完成' })[state] || state }
function taskStateHint(state) { return ({ heartbeat_lost: '模拟 Worker 失联', lease_expired: '任务安全回到队列', late_result_rejected: '旧 token 无权覆盖新状态', succeeded: '结果只提交一次' })[state] || '有限状态机计算结果' }
function flash(message) { notice.value = message; window.setTimeout(() => { if (notice.value === message) notice.value = '' }, 2200) }
async function loadSummary() { summary.value = (await api.demo.summary()).data.summary }
async function loadLifecycleItems() { lifecycleItems.value = (await api.demo.list('notes', { pageSize: 20 })).data.items }

async function runJourney(id, input = {}) {
  busy.value = true; error.value = ''
  try { result.value = (await api.demo.runJourney(id, input)).data }
  catch (requestError) { error.value = requestError.response?.data?.message || '演示旅程执行失败' }
  finally { busy.value = false }
}

async function startJourney(id) {
  activeJourneyId.value = id
  if (id === 'discovery') return runDiscovery()
  if (id === 'answer') return runAnswer(answerScenario.value)
  if (id === 'task') return runTask(taskScenario.value)
  await loadLifecycleItems(); await runJourney('lifecycle')
}
function runDiscovery() { return runJourney('discovery', { query: query.value }) }
function runAnswer(scenario) { answerScenario.value = scenario; return runJourney('answer', { scenario }) }
function runTask(scenario) { taskScenario.value = scenario; return runJourney('task', { scenario }) }

async function createLifecycleItem() {
  if (!lifecycleTitle.value) return
  busy.value = true; error.value = ''
  try { await api.demo.create('notes', { title: lifecycleTitle.value, content: '仅当前会话可见的合成笔记' }); lifecycleTitle.value = ''; await Promise.all([loadLifecycleItems(), loadSummary()]); await runJourney('lifecycle'); flash('已写入当前会话覆盖层') }
  catch (requestError) { error.value = requestError.response?.data?.message || '新增失败'; busy.value = false }
}

async function removeLifecycleItem(item) {
  busy.value = true; error.value = ''
  try { await api.demo.delete('notes', item.id); await Promise.all([loadLifecycleItems(), loadSummary()]); await runJourney('lifecycle'); flash('条目已移入当前会话回收层') }
  catch (requestError) { error.value = requestError.response?.data?.message || '操作失败'; busy.value = false }
}

async function resetWorkspace() {
  busy.value = true; error.value = ''
  try { await api.demo.reset(); await Promise.all([loadSummary(), loadLifecycleItems()]); await startJourney(activeJourneyId.value); flash('会话覆盖层已清空，合成基线已恢复') }
  catch (requestError) { error.value = requestError.response?.data?.message || '重置失败'; busy.value = false }
}
async function leaveDemo() { await authStore.logout(); await router.push('/login') }

onMounted(async () => {
  try { const [journeyResponse] = await Promise.all([api.demo.journeys(), loadSummary(), loadLifecycleItems()]); journeys.value = journeyResponse.data.journeys; await runDiscovery() }
  catch (requestError) { error.value = requestError.response?.data?.message || '演示空间初始化失败' }
})
</script>

<style scoped>
.demo-shell{min-height:100vh;padding:32px clamp(18px,4vw,64px) 48px;color:var(--color-text-primary);background:var(--color-surface-page)}
.demo-header,.journey-section,.journey-workspace,.isolation-bar,.demo-footer{max-width:1320px;margin-inline:auto}.demo-header{display:flex;align-items:flex-start;justify-content:space-between;gap:32px;margin-bottom:20px}
.eyebrow,.section-index,.aside-label{color:var(--color-primary);font-size:var(--font-size-xs);font-weight:700;letter-spacing:.12em}h1{margin:8px 0 4px;font-size:clamp(28px,4vw,42px);line-height:1.12;letter-spacing:-.035em}.brand-block p,.section-heading p{color:var(--color-text-secondary)}
.header-actions,.input-row,.scenario-switch{display:flex;gap:8px}.button,.scenario-switch button{min-height:var(--control-height-lg);padding:0 14px;border:1px solid var(--color-border-default);border-radius:var(--radius-sm);color:var(--color-text-primary);background:var(--color-surface-raised);font:inherit;font-weight:600;cursor:pointer;transition:border-color var(--motion-duration-fast),background-color var(--motion-duration-fast),color var(--motion-duration-fast)}
.button:focus-visible,.scenario-switch button:focus-visible,.journey-card:focus-visible,.text-danger:focus-visible,input:focus-visible{outline:2px solid var(--color-focus-ring);outline-offset:2px}.button.primary{color:var(--color-text-inverse);border-color:var(--color-primary);background:var(--color-primary)}.button.secondary{color:var(--color-primary);border-color:var(--color-primary-border)}.button.ghost{color:var(--color-text-secondary);background:transparent}.button:disabled,button:disabled{cursor:not-allowed;opacity:var(--opacity-disabled)}
.isolation-bar{display:flex;flex-wrap:wrap;gap:10px 24px;padding:12px 16px;color:var(--color-success-text);border:1px solid var(--color-success-border);border-radius:var(--radius-md);background:var(--color-success-surface);font-size:var(--font-size-sm)}.isolation-bar strong{margin-right:auto}.journey-section{margin-top:36px}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:16px}.section-heading>div{display:flex;align-items:baseline;gap:10px}.section-heading h2,.panel-heading h2{margin:0;font-size:20px;letter-spacing:-.015em}.section-heading p{max-width:520px;font-size:var(--font-size-sm);text-align:right}
.journey-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.journey-card{display:flex;min-height:148px;padding:16px;flex-direction:column;align-items:flex-start;gap:8px;text-align:left;border:1px solid var(--color-border-subtle);border-radius:var(--radius-lg);color:var(--color-text-secondary);background:var(--color-surface-raised);cursor:pointer;box-shadow:var(--shadow-sm)}.journey-card:hover{border-color:var(--color-border-default)}.journey-card.active{border-color:var(--color-primary-border);box-shadow:inset 0 0 0 1px var(--color-primary-border)}.journey-card strong{color:var(--color-text-primary);font-size:var(--font-size-lg)}.journey-card>span:last-child{font-size:var(--font-size-sm);line-height:1.5}.journey-number{color:var(--color-primary);font-size:var(--font-size-xs);font-weight:700}
.journey-workspace{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:12px;margin-top:12px}.interaction-panel,.evidence-panel{border:1px solid var(--color-border-subtle);border-radius:var(--radius-lg);background:var(--color-surface-raised);box-shadow:var(--shadow-sm)}.interaction-panel{min-height:480px;padding:clamp(18px,3vw,28px)}.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:18px;border-bottom:1px solid var(--color-border-subtle)}.panel-heading h2{margin-top:8px}.status-chip,.mode-chip,.type-chip,.answer-state{display:inline-flex;padding:3px 8px;border-radius:var(--radius-pill);font-size:var(--font-size-xs);font-weight:650}.status-chip{color:var(--color-success-text);background:var(--color-success-surface)}.mode-chip,.type-chip{color:var(--color-info-text);background:var(--color-info-surface)}
.query-form{margin:22px 0 18px}.query-form label{display:block;margin-bottom:7px;color:var(--color-text-secondary);font-size:var(--font-size-sm);font-weight:600}.query-form input{width:100%;min-height:var(--control-height-lg);padding:0 12px;border:1px solid var(--color-border-default);border-radius:var(--radius-sm);color:var(--color-text-primary);background:var(--color-surface-raised);font:inherit}.input-row input{flex:1}.result-list,.timeline,.overlay-list,.citation-list,.evidence-panel ul{list-style:none;padding:0}.result-list{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.result-list li{padding:14px;border:1px solid var(--color-border-subtle);border-radius:var(--radius-md);background:var(--color-surface-page)}.result-topline{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;color:var(--color-text-muted);font-size:var(--font-size-xs)}.result-list p{margin:4px 0;color:var(--color-text-secondary)}.result-list small,.overlay-list small,.timeline small,.evidence-panel small{display:block;color:var(--color-text-muted)}
.scenario-switch{flex-wrap:wrap;margin:22px 0}.scenario-switch button.active{color:var(--color-primary);border-color:var(--color-primary-border);background:var(--color-primary-surface)}.answer-card{padding:18px;border:1px solid var(--color-success-border);border-radius:var(--radius-md);background:var(--color-success-surface)}.answer-card.refused{border-color:var(--color-warning-border);background:var(--color-warning-surface)}.answer-card p{margin:10px 0 0;font-size:15px;line-height:1.7}.answer-state{color:var(--color-success-text);background:var(--color-surface-raised)}.refused .answer-state{color:var(--color-warning-text)}.citation-list{margin-top:14px;color:var(--color-text-secondary);font-size:var(--font-size-sm)}.pipeline{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:18px;color:var(--color-text-secondary);font-size:var(--font-size-sm)}.pipeline span{padding:6px 9px;border-radius:var(--radius-sm);background:var(--color-surface-subtle)}.pipeline b{color:var(--color-text-muted)}
.timeline{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:8px}.timeline li{display:flex;gap:9px;padding:12px;border:1px solid var(--color-border-subtle);border-radius:var(--radius-md)}.timeline li>span{display:grid;width:24px;height:24px;place-items:center;flex:0 0 auto;color:var(--color-primary);border-radius:50%;background:var(--color-primary-surface);font-size:11px;font-weight:700}.metadata-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-top:16px}.metadata-grid div{padding:10px 12px;border-radius:var(--radius-sm);background:var(--color-surface-page)}.metadata-grid dt{color:var(--color-text-muted);font-size:var(--font-size-xs)}.metadata-grid dd{margin:4px 0 0;overflow-wrap:anywhere}
.overlay-list{border-top:1px solid var(--color-border-subtle)}.overlay-list li{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 2px;border-bottom:1px solid var(--color-border-subtle)}.text-danger{padding:6px;color:var(--color-danger-text);border:0;background:transparent;cursor:pointer}.layer-list{display:grid;gap:8px;margin-top:18px}.layer-list div{display:flex;gap:10px;padding:10px 12px;border-radius:var(--radius-sm);color:var(--color-text-secondary);background:var(--color-surface-page)}.layer-list span{color:var(--color-primary);font-weight:700}
.evidence-panel{align-self:start;overflow:hidden}.evidence-panel section{padding:18px;border-bottom:1px solid var(--color-border-subtle)}.evidence-panel section:last-child{border-bottom:0}.evidence-panel p{margin:8px 0 0;color:var(--color-text-secondary)}.evidence-panel li{position:relative;margin-top:8px;padding-left:14px;color:var(--color-text-secondary);font-size:var(--font-size-sm)}.evidence-panel li::before{position:absolute;left:0;content:'·';color:var(--color-success);font-weight:800}.evidence-panel small{margin-top:12px}.message{margin-top:16px;padding:10px 12px;border-radius:var(--radius-sm)}.message.error{color:var(--color-danger-text);background:var(--color-danger-surface)}.message.success{color:var(--color-success-text);background:var(--color-success-surface)}.loading{padding:48px 0;color:var(--color-text-muted);text-align:center}.demo-footer{display:flex;justify-content:space-between;gap:16px;margin-top:18px;color:var(--color-text-muted);font-size:var(--font-size-xs)}
@media(max-width:900px){.journey-grid{grid-template-columns:repeat(2,1fr)}.journey-workspace{grid-template-columns:1fr}.evidence-panel{display:grid;grid-template-columns:repeat(2,1fr)}}
@media(max-width:600px){.demo-shell{padding:20px 14px 88px}.demo-header,.section-heading{align-items:stretch;flex-direction:column}.header-actions .button,.input-row .button{min-height:var(--control-height-touch)}.section-heading p{text-align:left}.journey-grid,.result-list,.metadata-grid,.evidence-panel{grid-template-columns:1fr}.journey-card{min-height:132px}.input-row{flex-direction:column}.query-form input{min-height:var(--control-height-touch);font-size:16px}.scenario-switch button{min-height:var(--control-height-touch);flex:1 1 calc(50% - 8px)}.demo-footer{flex-direction:column}}
</style>
