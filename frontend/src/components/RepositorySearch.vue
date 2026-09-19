<template>
  <section class="repository-search" aria-label="仓库内搜索">
    <form class="search-controls" @submit.prevent="submit">
      <label class="query-field"><NativeIcon name="magnifying-glass" /><input v-model="keyword" aria-label="仓库内关键词" placeholder="搜索当前仓库的正文或符号" maxlength="200" /></label>
      <div class="search-mode"><NativeSelect v-model="mode" aria-label="检索类型" :options="[{ value: 'fts', label: '文件正文' }, { value: 'symbol', label: '代码符号' }]" /></div>
      <NativeButton type="submit" size="small" :disabled="!keyword.trim()" :loading="loading">搜索</NativeButton>
    </form>
    <p class="search-hint">正文检索覆盖已索引文件；符号结果绑定提交与行号。不依赖 PC 在线。</p>
    <div v-if="error" class="search-feedback" role="alert">{{ error }} <NativeButton size="small" variant="text" @click="search">重试搜索</NativeButton></div>
    <div v-else-if="loading" class="search-feedback" role="status">正在检索当前仓库…</div>
    <template v-else-if="searched">
      <p class="search-hint" role="status">{{ total ? `找到 ${total} 条结果` : '没有匹配结果，可换一个关键词或检索类型。' }}</p>
      <p v-if="indexMissing" class="search-hint">尚未建立符号索引，文件浏览和正文检索不受影响。</p>
      <button v-for="item in results" :key="item.entryKey" class="search-result" @click="emit('open', item.locator)">
        <span class="result-title">{{ item.title }}</span>
        <span class="result-location">{{ item.locator.path }}<template v-if="item.locator.line"> · 第 {{ item.locator.line }} 行</template><template v-if="item.locator.commit"> · {{ item.locator.commit.slice(0, 8) }}</template></span>
        <span class="result-snippet">{{ item.snippet }}</span>
      </button>
      <nav v-if="total > limit" class="search-pagination" aria-label="搜索结果分页">
        <NativeButton size="small" variant="text" :disabled="page === 1" @click="navigate(page - 1)">上一页</NativeButton><span>{{ page }} / {{ Math.ceil(total / limit) }}</span><NativeButton size="small" variant="text" :disabled="page * limit >= total" @click="navigate(page + 1)">下一页</NativeButton>
      </nav>
    </template>
  </section>
</template>

<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import { NativeButton, NativeIcon, NativeSelect } from '@/components/native'
const props = defineProps({ repositoryId: { type: [Number, String], required: true } })
const emit = defineEmits(['open'])
const route = useRoute(), router = useRouter()
const keyword = ref(''), mode = ref('fts'), page = ref(1), results = ref([]), total = ref(0)
const loading = ref(false), error = ref(''), searched = ref(false), indexMissing = ref(false)
const limit = 20
let sequence = 0
function navigate(nextPage) {
  const query = { ...route.query, codeQ: keyword.value.trim(), codeMode: mode.value, codePage: String(nextPage) }
  if (query.codeQ === route.query.codeQ && query.codeMode === route.query.codeMode && query.codePage === route.query.codePage) return search()
  return router.push({ query })
}
function submit() { return navigate(1) }
async function search() {
  const request = ++sequence
  results.value = []; total.value = 0; error.value = ''; indexMissing.value = false
  searched.value = Boolean(keyword.value.trim())
  if (!searched.value) { loading.value = false; return }
  loading.value = true
  try {
    const response = await api.search.global({ q: keyword.value.trim(), mode: mode.value, repositoryId: props.repositoryId, type: 'code_file', scope: 'owned', limit, offset: (page.value - 1) * limit })
    if (request !== sequence) return
    results.value = response.data.data || []; total.value = response.data.total || 0
    indexMissing.value = mode.value === 'symbol' && response.data.index?.symbols?.status === 'missing'
  } catch (failure) {
    if (request === sequence) error.value = failure.response?.data?.code === 'SEARCH_INDEX_MISSING' ? '尚未建立正文索引，仍可从目录浏览文件。' : '搜索未完成，请重试。'
  } finally { if (request === sequence) loading.value = false }
}
watch(() => [props.repositoryId, route.query.codeQ, route.query.codeMode, route.query.codePage], () => {
  keyword.value = typeof route.query.codeQ === 'string' ? route.query.codeQ : ''
  mode.value = route.query.codeMode === 'symbol' ? 'symbol' : 'fts'
  const value = Number(route.query.codePage)
  page.value = Number.isSafeInteger(value) && value > 0 ? value : 1
  search()
}, { immediate: true })
onBeforeUnmount(() => { sequence++ })
</script>

<style scoped>
.repository-search{padding:20px;overflow:auto;height:100%;box-sizing:border-box;color:var(--color-text-primary)}
.search-controls{display:flex;align-items:center;gap:8px}.query-field{display:flex;align-items:center;gap:8px;flex:1;min-width:0;border:1px solid var(--color-border-default);border-radius:8px;padding:0 10px}
input,select{font:inherit;color:inherit;background:var(--color-surface-raised);font-size:14px;min-height:40px}input{border:0;outline:none;min-width:0;width:100%;background:transparent}.query-field:focus-within{outline:2px solid var(--color-primary);outline-offset:2px}select{border:1px solid var(--color-border-default);border-radius:8px;padding:0 8px}
.search-hint,.result-location,.search-feedback{font-size:13px;line-height:1.65;color:var(--color-text-secondary)}.search-result{display:flex;flex-direction:column;gap:5px;text-align:left;width:100%;padding:16px 4px;border:0;border-bottom:1px solid var(--color-border-subtle);background:transparent;color:inherit;cursor:pointer}.search-result:hover{background:var(--color-surface-subtle)}.search-result:focus-visible{outline:2px solid var(--color-primary);outline-offset:-2px}.result-title{font-weight:600;font-size:15px}.result-location{overflow-wrap:anywhere}.result-snippet{font-size:13px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.search-pagination{display:flex;align-items:center;justify-content:center;gap:16px;font-size:13px;padding:16px}
.search-mode{width:124px;flex-shrink:0}.search-mode :deep(.native-select__trigger){min-height:40px}
@media(max-width:767px){.repository-search{padding:12px}.search-controls{flex-wrap:wrap}.query-field{flex-basis:100%}.search-controls :deep(button){min-height:44px}.search-result{min-height:44px}}
</style>
