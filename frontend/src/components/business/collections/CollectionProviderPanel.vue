<template>
  <NativeDialog
    :model-value="true"
    :title="
      isGame ? 'Steam 管理' : itemId ? '检查作品资料更新' : '从 Bangumi 添加'
    "
    width="720px"
    :close-on-overlay-click="!busy"
    @update:model-value="close"
  >
    <div class="provider-panel">
      <p class="provider-help">
        {{
          isGame
            ? '只管理 Steam 库。获取的数据先作为候选，确认后才写入本地；不会修改个人状态与评分，也不会恢复回收站条目。'
            : itemId
              ? '先比较资料变化，再决定是否应用。你的观看状态、收藏和评分不会被覆盖。'
              : '先搜索并核对作品，再加入本地收藏。这里不提供播放或逐集进度。'
        }}
      </p>
      <div v-if="error" class="provider-error" role="alert">
        {{ error
        }}<NativeButton v-if="pollPaused" @click="resume"
          >重试查询</NativeButton
        >
      </div>
      <template v-if="isGame">
        <details :open="!config?.hasApiKey" class="provider-config">
          <summary>
            连接配置 {{ config?.hasApiKey ? '· 已保存密钥' : '' }}
          </summary>
          <form @submit.prevent="saveConfig">
            <label
              >Steam ID<input
                v-model="steamId"
                inputmode="numeric"
                maxlength="17"
                autocomplete="off"
                placeholder="17 位 Steam ID" /></label
            ><label
              >API Key<input
                v-model="apiKey"
                type="password"
                autocomplete="new-password"
                :placeholder="
                  config?.hasApiKey ? '留空保留当前密钥' : '仅保存在 NAS'
                "
            /></label>
            <div class="provider-actions">
              <NativeButton type="submit" :loading="busy">保存连接</NativeButton
              ><NativeButton
                v-if="config?.hasApiKey"
                variant="text"
                :disabled="busy"
                @click="disconnect"
                >移除连接配置</NativeButton
              >
            </div>
          </form>
        </details>
        <p class="provider-help">
          {{
            config?.last_sync
              ? `上次确认同步：${config.last_sync}`
              : '尚未确认过同步'
          }}
        </p>
      </template>
      <template v-if="isGame || itemId">
        <div class="provider-actions">
          <NativeButton
            theme="primary"
            :disabled="busy || running || (isGame && !config?.hasApiKey)"
            @click="start"
            >{{ running ? '正在获取候选…' : '获取新的候选' }}</NativeButton
          ><NativeButton variant="text" :disabled="busy" @click="resume"
            >刷新任务状态</NativeButton
          >
        </div>
        <p v-if="task" class="provider-help" role="status">
          {{ taskLabel
          }}<span v-if="running"> · {{ Math.round(task.progress || 0) }}%</span>
        </p>
        <template v-if="proposal"
          ><h3>{{ proposal.applied ? '这份候选已应用' : '待确认的差异' }}</h3>
          <p v-if="isGame" class="provider-help">
            新增 {{ proposal.counts.added }} · 更新
            {{ proposal.counts.updated }} · 保持
            {{ proposal.counts.unchanged }} · 跳过回收站
            {{ proposal.counts.skipped }}
          </p>
          <p v-if="!proposal.items.length" class="provider-help">
            没有差异。{{
              isGame
                ? '空结果可能与 Steam 隐私设置有关，本地库不会被清空。'
                : ''
            }}
          </p>
          <div class="provider-diff">
            <template v-if="isGame"
              ><div
                v-for="item in visibleChanges"
                :key="item.appid"
                class="provider-diff-row"
              >
                <strong>{{ item.title }}</strong
                ><span>{{ actionLabel[item.action] }}</span
                ><small
                  >{{
                    item.before === null
                      ? '本地暂无'
                      : playtimeLabel(item.before)
                  }}
                  → {{ playtimeLabel(item.after) }}</small
                >
              </div></template
            ><template v-else
              ><div
                v-for="item in visibleChanges"
                :key="item.field"
                class="provider-diff-row"
              >
                <strong>{{ fieldLabels[item.field] || item.field }}</strong>
                <div class="provider-comparison">
                  <div>
                    <small>当前</small>
                    <p>{{ compact(item.before) }}</p>
                  </div>
                  <div>
                    <small>候选</small>
                    <p>{{ compact(item.after) }}</p>
                  </div>
                </div>
              </div></template
            >
          </div>
          <div
            v-if="proposal.items.length > diffLimit"
            class="provider-actions"
          >
            <NativeButton @click="diffLimit += 50"
              >继续查看差异（{{ diffLimit }} /
              {{ proposal.items.length }}）</NativeButton
            >
          </div>
          <div class="provider-actions">
            <NativeButton
              theme="primary"
              :loading="busy"
              :disabled="proposal.applied || !proposal.items.length"
              @click="apply"
              >确认应用候选</NativeButton
            ><span class="provider-help">关闭窗口不会自动应用</span>
          </div>
        </template>
      </template>
      <template v-else>
        <form class="provider-search" @submit.prevent="search(1)">
          <input
            v-model="query"
            aria-label="搜索 Bangumi 作品"
            placeholder="作品名称"
          /><NativeButton type="submit" theme="primary" :loading="searching"
            >搜索 Bangumi</NativeButton
          >
        </form>
        <p v-if="searched && !searching && !results.length">
          没有找到作品，请更换关键词。
        </p>
        <div class="provider-results">
          <button
            v-for="item in results"
            :key="item.id"
            @click="selectResult(item)"
          >
            <strong>{{ item.name_cn || item.name }}</strong
            ><small
              >{{ item.name }} ·
              {{ item.air_date || item.date || '日期未知' }}</small
            >
          </button>
        </div>
        <div v-if="results.length" class="provider-actions">
          <NativeButton
            :disabled="searching || searchPage <= 1"
            @click="search(searchPage - 1)"
            >上一页</NativeButton
          ><span>{{ searchPage }}</span
          ><NativeButton
            :disabled="searching || !hasMore"
            @click="search(searchPage + 1)"
            >下一页</NativeButton
          >
        </div>
        <section v-if="selected" class="provider-preview">
          <h3>{{ selected.name_cn || selected.name }}</h3>
          <p>{{ selected.summary || '暂无简介' }}</p>
          <p class="provider-help">
            Bangumi #{{ selected.id }} · 请核对同名作品、剧场版或续作。
          </p>
          <NativeButton
            :loading="busy"
            :disabled="imported.has(selected.id)"
            @click="addSelected"
            >{{
              imported.has(selected.id) ? '已加入本地收藏' : '确认加入收藏'
            }}</NativeButton
          >
        </section>
      </template>
    </div>
    <template #footer
      ><NativeButton :disabled="busy" @click="close"
        >完成</NativeButton
      ></template
    >
  </NativeDialog>
</template>
<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import api from '@/api'
import { NativeButton, NativeDialog } from '@/components/native'
import { playtimeLabel } from '@/utils/collectionPresentation'
const props = defineProps({ kind: String, itemId: Number }),
  emit = defineEmits(['close', 'changed'])
const isGame = props.kind === 'game',
  client = isGame ? api.games : api.anime
const config = ref(null),
  steamId = ref(''),
  apiKey = ref(''),
  error = ref(''),
  busy = ref(false),
  task = ref(null),
  proposal = ref(null),
  pollPaused = ref(false),
  diffLimit = ref(50)
const query = ref(''),
  results = ref([]),
  selected = ref(null),
  searching = ref(false),
  searched = ref(false),
  searchPage = ref(1),
  hasMore = ref(false),
  imported = ref(new Set())
let alive = true,
  timer,
  taskSeq = 0,
  searchSeq = 0
const running = computed(() =>
  ['pending', 'leased', 'running'].includes(task.value?.status),
)
const taskLabel = computed(
  () =>
    ({
      pending: '候选任务已排队',
      leased: '候选任务已领取',
      running: '正在读取外部资料',
      succeeded: task.value?.applied ? '已确认应用' : '获取完成，请核对候选',
      failed: task.value?.error || '任务失败，可重新获取',
      cancelled: '任务已取消',
    })[task.value?.status] || '',
)
const visibleChanges = computed(
  () => proposal.value?.items.slice(0, diffLimit.value) || [],
)
const actionLabel = {
  added: '新增',
  updated: '更新时长',
  skipped: '保留在回收站',
  unchanged: '不变',
}
const fieldLabels = {
  title: '名称',
  name_cn: '中文名',
  name_original: '原名',
  summary: '简介',
  cover_image: '封面地址',
  rating: '社区评分',
  rating_count: '评分人数',
  tags: '标签',
  air_date: '放送日期',
  eps: '条目集数',
  eps_total: '总集数',
  author: '原作',
  director: '导演',
  studio: '制作',
  infobox: '详细资料',
  characters: '角色',
  staff: '制作人员',
}
const compact = (value) => String(value || '—').slice(0, 3000)
const message = (e, fallback) => e.response?.data?.message || fallback
function close() {
  if (!busy.value) emit('close')
}
async function loadConfig() {
  const value = (await api.games.getSteamConfig()).data.data
  if (alive) {
    config.value = value
    steamId.value = value?.steam_id || ''
  }
}
async function saveConfig() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await api.games.saveSteamConfig({
      steamId: steamId.value,
      apiKey: apiKey.value,
    })
    apiKey.value = ''
    if (alive) {
      await loadConfig()
      proposal.value = null
    }
  } catch (e) {
    if (alive) error.value = message(e, '保存连接失败')
  } finally {
    if (alive) busy.value = false
  }
}
async function disconnect() {
  if (!window.confirm('仅移除 Steam 连接配置？本地游戏与个人记录将保留。'))
    return
  busy.value = true
  try {
    await api.games.deleteSteamConfig()
    if (alive) {
      config.value = null
      steamId.value = ''
      apiKey.value = ''
      proposal.value = null
    }
  } catch (e) {
    if (alive) error.value = message(e, '移除连接失败')
  } finally {
    if (alive) busy.value = false
  }
}
async function resume() {
  clearTimeout(timer)
  const seq = ++taskSeq
  pollPaused.value = false
  error.value = ''
  try {
    const value = (await client.latestProposal(props.itemId)).data.data
    if (!alive || seq !== taskSeq) return
    task.value = value
    if (!value || value.id !== proposal.value?.taskId) proposal.value = null
    if (value?.status === 'succeeded' && value.hasProposal) {
      const data = (await client.getProposal(value.id, props.itemId)).data.data
      if (alive && seq === taskSeq) proposal.value = data
    }
    if (alive && seq === taskSeq && running.value)
      timer = setTimeout(resume, 1800)
  } catch (e) {
    if (alive && seq === taskSeq) {
      pollPaused.value = true
      error.value = message(e, '查询失败，已暂停自动刷新。可手动重试')
    }
  }
}
async function start() {
  if (busy.value || running.value) return
  busy.value = true
  error.value = ''
  proposal.value = null
  try {
    await (isGame ? api.games.syncSteam() : api.anime.refresh(props.itemId))
    if (alive) await resume()
  } catch (e) {
    if (alive) error.value = message(e, '任务提交失败，请重试')
  } finally {
    if (alive) busy.value = false
  }
}
async function apply() {
  if (busy.value || !proposal.value || proposal.value.applied) return
  busy.value = true
  error.value = ''
  try {
    await client.applyProposal(proposal.value.taskId, props.itemId)
    if (alive) {
      proposal.value.applied = true
      emit('changed')
      if (isGame) await loadConfig()
    }
  } catch (e) {
    if (alive) error.value = message(e, '应用失败，本地数据未被覆盖')
  } finally {
    if (alive) busy.value = false
  }
}
async function search(target) {
  if (!query.value.trim()) return
  const seq = ++searchSeq
  searching.value = true
  error.value = ''
  selected.value = null
  try {
    const result = (await api.anime.search(query.value.trim(), '', target)).data
    if (!alive || seq !== searchSeq) return
    results.value = result.data || result.list || []
    searchPage.value = target
    searched.value = true
    hasMore.value = target * 20 < (result.total || result.results || 0)
  } catch (e) {
    if (alive && seq === searchSeq)
      error.value = message(e, '搜索失败，原结果保留')
  } finally {
    if (alive && seq === searchSeq) searching.value = false
  }
}
function selectResult(item) {
  selected.value = item
}
async function addSelected() {
  if (busy.value || !selected.value) return
  const item = selected.value
  busy.value = true
  error.value = ''
  try {
    await api.anime.import(item.id)
    if (alive) {
      imported.value.add(item.id)
      emit('changed')
    }
  } catch (e) {
    if (alive) error.value = message(e, '加入收藏失败')
  } finally {
    if (alive) busy.value = false
  }
}
onMounted(async () => {
  try {
    if (isGame) await loadConfig()
    if (isGame || props.itemId) await resume()
  } catch (e) {
    if (alive) error.value = message(e, '加载管理信息失败')
  }
})
onBeforeUnmount(() => {
  alive = false
  ++taskSeq
  ++searchSeq
  clearTimeout(timer)
  apiKey.value = ''
})
</script>
<style scoped>
.provider-panel {
  color: var(--color-text-primary);
  font-size: 14px;
}
.provider-help {
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.8;
}
.provider-config {
  padding: 16px 0;
  border-bottom: 1px solid var(--color-border-default);
  margin-bottom: 16px;
}
.provider-config summary {
  cursor: pointer;
  font-weight: 600;
}
.provider-config label {
  display: grid;
  grid-template-columns: 90px 1fr;
  align-items: center;
  gap: 12px;
  margin: 14px 0;
}
.provider-panel input {
  width: 100%;
  min-width: 0;
  padding: 9px 12px;
  font: inherit;
  color: inherit;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-default);
  border-radius: 6px;
}
.provider-actions,
.provider-search {
  display: flex;
  gap: 10px;
  align-items: center;
  margin: 16px 0;
}
.provider-search input {
  flex: 1;
}
.provider-error {
  padding: 12px;
  background: var(--color-surface-subtle);
  border-left: 2px solid var(--color-text-muted);
  margin-bottom: 16px;
  line-height: 1.8;
}
.provider-diff {
  max-height: 340px;
  overflow: auto;
  border-block: 1px solid var(--color-border-default);
}
.provider-diff-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 12px 0;
  border-bottom: 1px solid var(--color-border-default);
}
.provider-diff-row > strong {
  font-size: 13px;
}
.provider-diff-row > span,
.provider-diff-row > small {
  font-size: 12px;
  color: var(--color-text-secondary);
}
.provider-diff-row > small {
  grid-column: 1/-1;
}
.provider-comparison {
  grid-column: 1/-1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  overflow-wrap: anywhere;
}
.provider-comparison small {
  color: var(--color-text-muted);
}
.provider-comparison p {
  white-space: pre-wrap;
  font-size: 12px;
  max-height: 180px;
  overflow: auto;
  line-height: 1.7;
}
.provider-results {
  display: grid;
  gap: 8px;
  max-height: 300px;
  overflow: auto;
}
.provider-results button {
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
  padding: 14px;
  border: 1px solid var(--color-border-default);
  border-radius: 6px;
  background: var(--color-surface-raised);
  color: inherit;
  cursor: pointer;
}
.provider-results button:hover {
  border-color: var(--color-primary);
}
.provider-results small {
  color: var(--color-text-secondary);
}
.provider-preview {
  border-top: 1px solid var(--color-border-default);
  margin-top: 20px;
  padding-top: 14px;
}
.provider-preview > p {
  line-height: 1.8;
  white-space: pre-wrap;
  max-height: 200px;
  overflow: auto;
}
.provider-panel h3 {
  font-size: 15px;
  margin-top: 22px;
}
</style>
