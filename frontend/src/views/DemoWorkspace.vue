<template>
  <main class="demo-shell">
    <header class="demo-header">
      <div>
        <span class="eyebrow">ISOLATED DEMO WORKSPACE</span>
        <h1>个人资源管理器 · 演示空间</h1>
        <p>全部为合成数据；操作只在当前会话生效，会话结束后自动丢弃。</p>
      </div>
      <div class="header-actions">
        <button class="secondary" :disabled="busy" @click="resetWorkspace">恢复初始数据</button>
        <button class="ghost" @click="leaveDemo">退出演示</button>
      </div>
    </header>

    <section class="trust-strip">
      <span>✓ 不连接生产数据库</span>
      <span>✓ 不写入 NAS 资源目录</span>
      <span>✓ 30 分钟自动过期</span>
    </section>

    <nav class="resource-tabs" aria-label="演示资源类型">
      <button
        v-for="item in resourceTypes"
        :key="item.key"
        :class="{ active: selectedType === item.key }"
        @click="selectType(item.key)"
      >
        <span>{{ item.icon }}</span>
        {{ item.label }}
        <b>{{ summary[item.key] ?? '–' }}</b>
      </button>
    </nav>

    <section class="workspace-card">
      <div class="workspace-toolbar">
        <div>
          <h2>{{ currentType.label }}</h2>
          <p>新增、重命名和删除均写入当前会话的临时覆盖层。</p>
        </div>
        <form class="create-form" @submit.prevent="createItem">
          <input v-model.trim="newTitle" :placeholder="`新增${currentType.label}标题`" maxlength="80">
          <button class="primary" :disabled="busy || !newTitle">添加临时条目</button>
        </form>
      </div>

      <div v-if="error" class="message error">{{ error }}</div>
      <div v-if="notice" class="message success">{{ notice }}</div>
      <div v-if="loading" class="loading">正在加载合成数据…</div>

      <div v-else class="resource-grid">
        <article v-for="item in items" :key="item.id" class="resource-item">
          <div class="item-topline">
            <span class="type-icon">{{ currentType.icon }}</span>
            <span v-if="item.demoCreated" class="badge created">本会话新增</span>
            <span v-else-if="item.demoUpdated" class="badge updated">本会话修改</span>
            <span v-else class="badge">合成基线</span>
          </div>
          <h3>{{ item.title || item.name }}</h3>
          <p>{{ describe(item) }}</p>
          <div class="item-actions">
            <button class="text-button" :disabled="busy" @click="renameItem(item)">重命名</button>
            <button class="text-button danger" :disabled="busy" @click="removeItem(item)">临时删除</button>
          </div>
        </article>
      </div>
    </section>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import api from '@/api'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const authStore = useAuthStore()
const resourceTypes = [
  { key: 'documents', label: '文档', icon: '📄' },
  { key: 'books', label: '电子书', icon: '📚' },
  { key: 'music', label: '音乐', icon: '🎧' },
  { key: 'code', label: '代码', icon: '⌘' },
  { key: 'bookmarks', label: '书签', icon: '🔖' },
  { key: 'anime', label: '动漫', icon: '✦' },
  { key: 'games', label: '游戏', icon: '🎮' },
  { key: 'notes', label: '临时事项', icon: '✓' }
]

const selectedType = ref('documents')
const items = ref([])
const summary = ref({})
const newTitle = ref('')
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const currentType = computed(
  () => resourceTypes.find((item) => item.key === selectedType.value)
)

function describe(item) {
  return item.description || item.content || item.author || item.artist ||
    item.category || item.language || item.status || item.url || '合成演示数据'
}

function flash(message) {
  notice.value = message
  window.setTimeout(() => {
    if (notice.value === message) notice.value = ''
  }, 2200)
}

async function loadSummary() {
  const response = await api.demo.summary()
  summary.value = response.data.summary
}

async function loadItems() {
  loading.value = true
  error.value = ''
  try {
    const response = await api.demo.list(selectedType.value, { pageSize: 50 })
    items.value = response.data.items
  } catch (requestError) {
    error.value = requestError.response?.data?.message || '加载演示数据失败'
  } finally {
    loading.value = false
  }
}

async function selectType(type) {
  selectedType.value = type
  await loadItems()
}

async function createItem() {
  if (!newTitle.value) return
  busy.value = true
  error.value = ''
  try {
    await api.demo.create(selectedType.value, {
      title: newTitle.value,
      description: '当前演示会话创建的临时条目'
    })
    newTitle.value = ''
    await Promise.all([loadItems(), loadSummary()])
    flash('已写入当前会话的临时覆盖层')
  } catch (requestError) {
    error.value = requestError.response?.data?.message || '新增失败'
  } finally {
    busy.value = false
  }
}

async function renameItem(item) {
  const nextTitle = window.prompt('输入新的演示标题', item.title || item.name)
  if (!nextTitle?.trim()) return
  busy.value = true
  try {
    await api.demo.update(selectedType.value, item.id, { title: nextTitle.trim() })
    await loadItems()
    flash('修改仅对当前会话可见')
  } catch (requestError) {
    error.value = requestError.response?.data?.message || '修改失败'
  } finally {
    busy.value = false
  }
}

async function removeItem(item) {
  busy.value = true
  try {
    await api.demo.delete(selectedType.value, item.id)
    await Promise.all([loadItems(), loadSummary()])
    flash('条目已从当前会话隐藏')
  } catch (requestError) {
    error.value = requestError.response?.data?.message || '删除失败'
  } finally {
    busy.value = false
  }
}

async function resetWorkspace() {
  busy.value = true
  error.value = ''
  try {
    await api.demo.reset()
    await Promise.all([loadItems(), loadSummary()])
    flash('已恢复合成基线数据')
  } catch (requestError) {
    error.value = requestError.response?.data?.message || '重置失败'
  } finally {
    busy.value = false
  }
}

async function leaveDemo() {
  await authStore.logout()
  await router.push('/login')
}

onMounted(async () => {
  try {
    await Promise.all([loadItems(), loadSummary()])
  } catch (requestError) {
    error.value = requestError.response?.data?.message || '演示空间初始化失败'
  }
})
</script>

<style scoped>
.demo-shell {
  min-height: 100vh;
  padding: 40px clamp(18px, 5vw, 72px) 72px;
  color: #172033;
  background:
    radial-gradient(circle at 8% 2%, rgba(92, 120, 255, .18), transparent 34%),
    radial-gradient(circle at 92% 18%, rgba(31, 197, 163, .16), transparent 28%),
    #f5f7fb;
}

.demo-header,
.workspace-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 28px;
  max-width: 1440px;
  margin: 0 auto 24px;
}

.eyebrow {
  color: #5269db;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .16em;
}

h1 {
  margin: 10px 0 8px;
  font-size: clamp(28px, 4vw, 48px);
  line-height: 1.1;
}

.demo-header p,
.workspace-toolbar p {
  margin: 0;
  color: #687086;
}

.header-actions,
.create-form,
.item-actions {
  display: flex;
  gap: 10px;
}

button,
input {
  border-radius: 10px;
  font: inherit;
}

button {
  cursor: pointer;
}

button:disabled {
  cursor: wait;
  opacity: .55;
}

.primary,
.secondary,
.ghost {
  min-height: 42px;
  padding: 0 16px;
  border: 1px solid transparent;
  font-weight: 700;
}

.primary {
  color: white;
  background: #4058d8;
}

.secondary {
  color: #3146b9;
  border-color: #ccd3f7;
  background: white;
}

.ghost {
  color: #5e6578;
  border-color: #dce0e9;
  background: transparent;
}

.trust-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 28px;
  max-width: 1400px;
  margin: 0 auto 24px;
  padding: 15px 20px;
  color: #21715f;
  border: 1px solid #c8eadf;
  border-radius: 14px;
  background: rgba(237, 252, 247, .9);
  font-size: 14px;
  font-weight: 650;
}

.resource-tabs {
  display: grid;
  grid-template-columns: repeat(8, minmax(96px, 1fr));
  gap: 10px;
  max-width: 1440px;
  margin: 0 auto 18px;
}

.resource-tabs button {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 7px;
  padding: 13px 12px;
  color: #5c6478;
  border: 1px solid #e2e5ed;
  background: rgba(255, 255, 255, .76);
}

.resource-tabs button.active {
  color: #3047be;
  border-color: #8f9fea;
  box-shadow: 0 8px 24px rgba(67, 86, 179, .12);
  background: white;
}

.workspace-card {
  max-width: 1380px;
  min-height: 420px;
  margin: 0 auto;
  padding: clamp(18px, 3vw, 30px);
  border: 1px solid #e3e6ee;
  border-radius: 20px;
  box-shadow: 0 18px 50px rgba(34, 47, 82, .08);
  background: rgba(255, 255, 255, .94);
}

.workspace-toolbar {
  align-items: flex-end;
  margin-bottom: 24px;
}

.workspace-toolbar h2 {
  margin: 0 0 5px;
}

.create-form input {
  width: min(330px, 42vw);
  min-height: 42px;
  padding: 0 13px;
  border: 1px solid #d7dbe6;
  outline: none;
}

.resource-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 14px;
}

.resource-item {
  min-height: 180px;
  padding: 18px;
  border: 1px solid #e5e8ef;
  border-radius: 15px;
  background: #fbfcff;
}

.item-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.type-icon {
  font-size: 24px;
}

.badge {
  padding: 4px 8px;
  color: #667086;
  border-radius: 99px;
  background: #eef1f6;
  font-size: 11px;
  font-weight: 700;
}

.badge.created {
  color: #14705b;
  background: #dff8ef;
}

.badge.updated {
  color: #8a5c08;
  background: #fff1cc;
}

.resource-item h3 {
  margin: 18px 0 8px;
  font-size: 17px;
}

.resource-item p {
  min-height: 42px;
  margin: 0 0 16px;
  color: #6b7285;
  font-size: 14px;
}

.text-button {
  padding: 5px 0;
  color: #4259cf;
  border: 0;
  background: transparent;
}

.text-button.danger {
  color: #c14f55;
}

.message {
  margin-bottom: 16px;
  padding: 10px 13px;
  border-radius: 10px;
}

.message.error {
  color: #a2393f;
  background: #fff0f1;
}

.message.success {
  color: #196b58;
  background: #e8faf4;
}

.loading {
  padding: 80px 0;
  color: #737b8e;
  text-align: center;
}

@media (max-width: 960px) {
  .demo-header,
  .workspace-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .resource-tabs {
    display: flex;
    padding-bottom: 5px;
    overflow-x: auto;
  }

  .resource-tabs button {
    min-width: 128px;
  }

  .create-form input {
    width: 100%;
  }
}

@media (max-width: 560px) {
  .demo-shell {
    padding-top: 24px;
  }

  .header-actions,
  .create-form {
    flex-direction: column;
  }

  .resource-grid {
    grid-template-columns: 1fr;
  }
}
</style>
