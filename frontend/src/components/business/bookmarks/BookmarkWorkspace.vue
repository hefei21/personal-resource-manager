<template>
  <div class="bookmark-workspace">
    <form class="bookmark-toolbar" @submit.prevent="filterChanged">
      <label class="bookmark-search"
        ><NativeIcon name="magnifying-glass" /><input
          v-model="keyword"
          aria-label="搜索书签"
          placeholder="搜索网站、链接或备注"
        /><button type="submit" aria-label="搜索">搜索</button></label
      >
      <NativeButton theme="primary" @click="edit()"
        ><NativeIcon name="plus" /><span>{{
          isMobile ? '添加' : '添加书签'
        }}</span></NativeButton
      >
      <NativeButton
        v-if="!isMobile"
        variant="text"
        @click="toolsOpen = !toolsOpen"
        >整理与迁移<NativeIcon name="caret-down"
      /></NativeButton>
    </form>
    <div v-if="toolsOpen && !isMobile" class="bookmark-tools">
      <NativeButton variant="text" size="small" @click="enterSelection"
        >多选整理</NativeButton
      ><NativeButton variant="text" size="small" @click="openImport"
        >导入书签</NativeButton
      ><NativeButton
        variant="text"
        size="small"
        :loading="exporting"
        @click="downloadExport('html')"
        >导出 HTML</NativeButton
      ><NativeButton
        variant="text"
        size="small"
        :disabled="exporting"
        @click="downloadExport('json')"
        >导出 JSON</NativeButton
      >
    </div>
    <div class="bookmark-filters">
      <NativeSelect
        v-model="category"
        :options="categoryOptions"
        aria-label="分类"
        @change="filterChanged"
      />
      <NativeSelect
        v-model="tag"
        :options="[
          { value: '', label: '全部标签' },
          ...metadata.tags.map((t) => ({ value: t.name, label: t.name })),
        ]"
        aria-label="标签"
        @change="filterChanged"
      />
      <div v-if="!isMobile" class="bookmark-sort">
        <NativeSelect
          v-model="sortBy"
          :options="[
            { value: 'title', label: '网站名称' },
            { value: 'updated_at', label: '最近更新' },
            { value: 'created_at', label: '添加时间' },
          ]"
          aria-label="排序"
          @change="filterChanged"
        /><NativeButton
          variant="text"
          :aria-label="direction === 'asc' ? '切换降序' : '切换升序'"
          @click="toggleDirection"
          ><NativeIcon :name="direction === 'asc' ? 'arrow-up' : 'arrow-down'"
        /></NativeButton>
      </div>
      <NativeButton
        variant="text"
        size="small"
        @click="router.push({ path: '/trash', query: { type: 'bookmark' } })"
        >回收站</NativeButton
      >
    </div>
    <div class="bookmark-section-heading">
      <span
        >{{
          category
            ? category === '__unfiled'
              ? '未分类'
              : category
            : '全部网站'
        }}<small>{{ total }}</small></span
      ><span v-if="selecting && !isMobile" class="bookmark-batch"
        ><NativeCheckbox
          :model-value="allSelected"
          @update:model-value="selectAll"
          >全选本页</NativeCheckbox
        ><small>已选 {{ selectedIds.length }} 项</small
        ><NativeButton
          size="small"
          variant="text"
          :disabled="!selectedIds.length || deleting"
          @click="removeSelected"
          >移入回收站</NativeButton
        ><NativeButton
          size="small"
          variant="text"
          @click="leaveSelection"
          >取消</NativeButton
        ></span
      >
    </div>
    <div v-if="loadError" class="bookmark-feedback" role="alert">
      {{ loadError
      }}<NativeButton variant="text" size="small" @click="load(page)"
        >重试</NativeButton
      >
    </div>
    <div
      v-if="loading && !items.length"
      class="bookmark-grid"
      aria-label="正在加载"
    >
      <div v-for="n in 12" :key="n" class="bookmark-card bookmark-skeleton">
        <i />
        <div><i /><i /></div>
      </div>
    </div>
    <div v-else-if="!items.length && !loadError" class="bookmark-empty">
      <NativeIcon name="bookmark" size="32" />
      <h2>
        {{
          keyword || category || tag ? '没有匹配的网站' : '把常用入口放在一起'
        }}
      </h2>
      <p>网站与工具，随时直达。</p>
      <NativeButton
        variant="text"
        @click="keyword || category || tag ? resetFilters() : edit()"
        >{{
          keyword || category || tag ? '清除筛选' : '添加第一个书签'
        }}</NativeButton
      >
    </div>
    <div v-else class="bookmark-grid" :aria-busy="loading">
      <article
        v-for="item in items"
        :key="item.id"
        class="bookmark-card"
        :class="{ selected: selectedIds.includes(item.id) }"
      >
        <button
          v-if="selecting && !isMobile"
          class="bookmark-card-link selection-link"
          :aria-pressed="selectedIds.includes(item.id)"
          @click="toggleSelection(item.id)"
        >
          <span class="selection-indicator"
            ><NativeIcon
              v-if="selectedIds.includes(item.id)"
              name="check" /></span
          ><span class="bookmark-card-text"
            ><strong>{{ item.title }}</strong
            ><small>{{ bookmarkDomain(item.url) }}</small></span
          >
        </button>
        <a
          v-else
          class="bookmark-card-link"
          :href="bookmarkHref(item.url) || undefined"
          target="_blank"
          rel="noopener noreferrer"
          :aria-label="'打开 ' + item.title"
          @click="!bookmarkHref(item.url) && $event.preventDefault()"
        >
          <span class="bookmark-favicon"
            ><img
              v-if="item.icon_data && !brokenIcons[item.id]"
              :src="item.icon_data"
              alt=""
              @error="brokenIcons[item.id] = true"
            /><span v-else>{{
              (item.title || bookmarkDomain(item.url)).slice(0, 1).toUpperCase()
            }}</span></span
          >
          <span class="bookmark-card-text"
            ><strong :title="item.title">{{ item.title }}</strong
            ><small>{{ bookmarkDomain(item.url) }}</small
            ><span v-if="item.tags.length" class="bookmark-tags">{{
              item.tags.slice(0, 2).join(' · ')
            }}</span></span
          >
        </a>
        <button
          v-if="!selecting || isMobile"
          class="bookmark-more"
          :aria-label="'查看 ' + item.title + ' 的详情'"
          @click="showDetails(item)"
        >
          <NativeIcon name="more" />
        </button>
      </article>
    </div>
    <nav
      v-if="total > pageSize"
      class="bookmark-pagination"
      aria-label="书签分页"
    >
      <template v-if="!isMobile"
        ><NativeButton
          variant="text"
          :disabled="page <= 1 || loading"
          @click="load(page - 1)"
          >上一页</NativeButton
        ><span>{{ page }} / {{ Math.ceil(total / pageSize) }}</span
        ><NativeButton
          variant="text"
          :disabled="page * pageSize >= total || loading"
          @click="load(page + 1)"
          >下一页</NativeButton
        ></template
      ><template v-else
        ><span>已显示 {{ items.length }} / {{ total }}</span
        ><NativeButton
          v-if="items.length < total"
          variant="text"
          :loading="loading"
          @click="load(page + 1, true)"
          >加载下一批</NativeButton
        ></template
      >
    </nav>

    <NativeDrawer
      :model-value="!!detail"
      :placement="isMobile ? 'bottom' : 'right'"
      :size="isMobile ? 'min(60dvh, 440px)' : '420px'"
      :top-offset="isMobile ? 0 : 72"
      title="书签详情"
      @update:model-value="!$event && closeDetails()"
    >
      <div v-if="detail" class="bookmark-detail">
        <h2>{{ detail.title }}</h2>
        <a
          :href="bookmarkHref(detail.url) || undefined"
          target="_blank"
          rel="noopener noreferrer"
          class="bookmark-url"
          >{{ detail.url }}</a
        >
        <p class="bookmark-description">
          {{ detail.description || '暂无备注' }}
        </p>
        <div class="bookmark-detail-tags">
          <span>{{ detail.category || '未分类' }}</span
          ><span v-for="t in detail.tags" :key="t">{{ t }}</span>
        </div>
        <div class="bookmark-detail-actions">
          <NativeButton @click="edit(detail)"
            ><NativeIcon name="pencil" />编辑</NativeButton
          ><NativeButton
            variant="text"
            :loading="deleting"
            @click="removeOne(detail)"
            ><NativeIcon name="trash" />移入回收站</NativeButton
          >
        </div>
        <section v-if="!isMobile" class="bookmark-inspection">
          <h3>网站信息</h3>
          <p>
            主动检测可访问性并获取名称、图标建议，不会覆盖已保存的信息。内网地址不探测。
          </p>
          <div class="bookmark-detail-actions">
            <NativeButton size="small" :loading="inspecting" @click="inspect"
              >获取网站信息</NativeButton
            ><NativeButton
              v-if="inspection"
              size="small"
              variant="text"
              @click="refreshInspection"
              >刷新状态</NativeButton
            >
          </div>
          <p v-if="inspectionError" role="alert">{{ inspectionError }}</p>
          <template v-if="inspection"
            ><p>{{ inspectionText }}</p>
            <small v-if="inspection.result"
              >{{ inspection.result.checkedAt }} · 仅代表检测时的结果</small
            >
            <div
              v-if="inspection.result?.title || inspection.result?.iconData"
              class="bookmark-suggestion"
            >
              <span
                >建议名称：{{ inspection.result.title || detail.title }}</span
              ><NativeButton
                size="small"
                variant="text"
                @click="applySuggestion"
                >带入编辑，确认后保存</NativeButton
              >
            </div></template
          >
        </section>
      </div>
    </NativeDrawer>

    <NativeDialog
      :model-value="editing"
      :title="form.id ? '编辑书签' : '添加书签'"
      :show-footer="false"
      width="520px"
      @update:model-value="!$event && closeEditor()"
    >
      <form class="bookmark-editor" @submit.prevent="save(false)">
        <label
          >链接<input
            v-model="form.url"
            placeholder="https://… 或局域网地址"
            maxlength="4096"
            :disabled="saving"
            required /></label
        ><label
          >名称<input
            v-model="form.title"
            placeholder="留空时使用域名"
            maxlength="300"
            :disabled="saving" /></label
        ><label
          >分类<input
            v-model="form.category"
            list="bookmark-category-names"
            placeholder="选择已有分类，或输入新名称"
            maxlength="120"
            :disabled="saving" /></label
        ><datalist id="bookmark-category-names">
          <option
            v-for="c in metadata.categories"
            :key="c.name"
            :value="c.name"
          /></datalist
        ><label
          >标签<NativeTagInput
            v-model="form.tags"
            :max-tags="30"
            :max-length="80"
            :disabled="saving"
            :create-tag-on-blur="true"
            placeholder="输入后回车确认"
        /></label>
        <div class="bookmark-tag-suggestions">
          <button
            v-for="t in metadata.tags
              .filter((t) => !form.tags.includes(t.name))
              .slice(0, 6)"
            :key="t.name"
            type="button"
            :disabled="saving"
            @click="form.tags.push(t.name)"
          >
            + {{ t.name }}
          </button>
        </div>
        <label
          >备注<textarea
            v-model="form.description"
            rows="3"
            maxlength="5000"
            :disabled="saving"
            placeholder="这个网站有什么用"
          />
        </label>
        <div v-if="saveError" class="bookmark-feedback" role="alert">
          {{ saveError
          }}<span v-if="duplicates.length">{{
            duplicates.map((d) => d.title).join('、')
          }}</span
          ><NativeButton
            v-if="duplicates.length"
            type="button"
            size="small"
            variant="text"
            :disabled="saving"
            @click="save(true)"
            >仍保存为独立书签</NativeButton
          ><NativeButton
            v-if="conflict"
            type="button"
            size="small"
            variant="text"
            @click="saveCopy"
            >本机修改另存书签</NativeButton
          >
        </div>
        <div class="bookmark-editor-footer">
          <small>保存不会自动访问网站</small
          ><NativeButton
            type="button"
            variant="text"
            :disabled="saving"
            @click="closeEditor"
            >取消</NativeButton
          ><NativeButton type="submit" theme="primary" :loading="saving"
            >保存</NativeButton
          >
        </div>
      </form>
    </NativeDialog>
    <NativeDialog
      v-if="!isMobile"
      v-model="importOpen"
      title="导入书签"
      :show-footer="false"
      width="680px"
      :close-on-overlay-click="!importing"
    >
      <div class="bookmark-import">
        <p>
          选择浏览器书签 HTML 或本项目导出的 JSON（最多 2 MB / 500
          条）。不会抓取网站；重复链接默认跳过，不修改已有书签。
        </p>
        <input
          type="file"
          accept=".html,.htm,.json"
          aria-label="选择书签文件"
          :disabled="importing"
          @change="previewFile"
        />
        <p v-if="importError" role="alert">{{ importError }}</p>
        <template v-if="importRows.length"
          ><p>
            共 {{ importRows.length }} 条 · 可导入
            {{ importSelection.length }} 条 · 重复或无效
            {{ importRows.filter((r) => r.duplicate || r.error).length }} 条
          </p>
          <div class="bookmark-import-list">
            <label v-for="r in importRows" :key="r.index"
              ><input
                type="checkbox"
                :value="r.index"
                v-model="importSelection"
                :disabled="!!r.error || r.duplicate || importing"
              /><span
                >{{ r.form?.title || '无效条目'
                }}<small>{{
                  r.error ||
                  (r.duplicate ? '重复，跳过' : bookmarkDomain(r.form.url))
                }}</small></span
              ></label
            >
          </div>
          <NativeButton
            theme="primary"
            :disabled="!importSelection.length"
            :loading="importing"
            @click="confirmImport"
            >确认导入 {{ importSelection.length }} 条</NativeButton
          ></template
        >
      </div>
    </NativeDialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import {
  NativeButton,
  NativeIcon,
  NativeSelect,
  NativeCheckbox,
  NativeDialog,
  NativeDrawer,
  NativeTagInput,
} from '@/components/native'
import { useViewport } from '@/composables/useViewport'
import { useToast } from '@/composables/useToast'
import {
  bookmarkHref,
  bookmarkDomain,
  bookmarkHtmlExport,
} from '@/utils/bookmarkPresentation'
import api from '@/api'

const { isMobile } = useViewport(),
  route = useRoute(),
  router = useRouter(),
  toast = useToast()
const keyword = ref(String(route.query.q || '')),
  category = ref(String(route.query.category || '')),
  tag = ref(String(route.query.tag || '')),
  sortBy = ref(String(route.query.sort || 'title')),
  direction = ref(String(route.query.direction || 'asc'))
const items = ref([]),
  total = ref(0),
  page = ref(1),
  pageSize = 24,
  loading = ref(false),
  loadError = ref(''),
  metadata = ref({ categories: [], tags: [] }),
  brokenIcons = ref({}),
  toolsOpen = ref(false),
  selecting = ref(false),
  selectedIds = ref([])
const detail = ref(null),
  editing = ref(false),
  form = ref({}),
  base = ref(''),
  saving = ref(false),
  saveError = ref(''),
  duplicates = ref([]),
  conflict = ref(null),
  deleting = ref(false)
const importing = ref(false),
  importOpen = ref(false),
  importRows = ref([]),
  importSelection = ref([]),
  importError = ref(''),
  exporting = ref(false),
  inspecting = ref(false),
  inspection = ref(null),
  inspectionError = ref('')
let listSequence = 0,
  detailSequence = 0,
  inspectionSequence = 0,
  alive = true
const categoryOptions = computed(() => [
  { value: '', label: '全部分类' },
  { value: '__unfiled', label: '未分类' },
  ...metadata.value.categories.map((c) => ({
    value: c.name,
    label: c.name + ' · ' + c.count,
  })),
])
const allSelected = computed(
  () =>
    items.value.length > 0 &&
    items.value.every((i) => selectedIds.value.includes(i.id)),
)
const dirty = computed(
  () => editing.value && JSON.stringify(form.value) !== base.value,
)
const message = (error, fallback) => error.response?.data?.message || fallback
const inspectionText = computed(() =>
  inspection.value?.status === 'succeeded'
    ? {
        reachable: '可以访问',
        unavailable: '返回 404/410，可能已失效',
        restricted: '访问受限或需登录，不代表失效',
        blocked: '安全策略阻止探测，可手动打开',
        unknown: '暂时无法判断，请稍后重试',
      }[inspection.value.result?.status]
    : ['pending', 'leased', 'running'].includes(inspection.value?.status)
      ? '任务处理中，可稍后刷新状态'
      : '任务未完成，请重新检测；原书签不受影响',
)
async function load(target = 1, append = false) {
  const seq = ++listSequence
  loading.value = true
  loadError.value = ''
  try {
    const result = (
      await api.bookmarks.list({
        keyword: keyword.value,
        category: category.value,
        tag: tag.value,
        sortBy: sortBy.value,
        direction: direction.value,
        page: target,
        pageSize,
      })
    ).data
    if (!alive || seq !== listSequence) return
    items.value = append
      ? [
          ...items.value,
          ...result.data.filter((n) => !items.value.some((i) => i.id === n.id)),
        ]
      : result.data
    total.value = result.total
    page.value = target
    selectedIds.value = []
    if (!isMobile.value) writeQuery()
  } catch (error) {
    if (seq === listSequence)
      loadError.value = message(error, '加载失败，已显示的网站仍保留')
  } finally {
    if (seq === listSequence) loading.value = false
  }
}
async function loadMetadata() {
  try {
    const result = (await api.bookmarks.metadata()).data.data
    if (alive) metadata.value = result
  } catch {
    toast.error('分类与标签加载失败')
  }
}
function writeQuery() {
  router.replace({
    query: {
      q: keyword.value || undefined,
      category: category.value || undefined,
      tag: tag.value || undefined,
      sort: sortBy.value,
      direction: direction.value,
      page: !isMobile.value && page.value > 1 ? String(page.value) : undefined,
    },
  })
}
function filterChanged() {
  page.value = 1
  writeQuery()
  load(1)
}
function resetFilters() {
  keyword.value = ''
  category.value = ''
  tag.value = ''
  filterChanged()
}
function enterSelection() {
  selecting.value = true
  toolsOpen.value = false
  selectedIds.value = []
}
function leaveSelection() {
  selecting.value = false
  selectedIds.value = []
}
function toggleDirection() {
  direction.value = direction.value === 'asc' ? 'desc' : 'asc'
  filterChanged()
}
function toggleSelection(id) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((v) => v !== id)
    : [...selectedIds.value, id]
}
function selectAll(value) {
  selectedIds.value = value ? items.value.map((i) => i.id) : []
}
async function showDetails(item) {
  const seq = ++detailSequence
  detail.value = item
  inspection.value = null
  inspectionError.value = ''
  try {
    const latest = (await api.bookmarks.get(item.id)).data.data
    if (alive && seq === detailSequence) {
      detail.value = latest
      if (!isMobile.value) refreshInspection()
    }
  } catch (error) {
    if (seq === detailSequence)
      toast.error(message(error, '无法刷新详情，显示列表中的信息'))
  }
}
function closeDetails() {
  ++detailSequence
  ++inspectionSequence
  detail.value = null
  inspection.value = null
  inspecting.value = false
}
function edit(item = null) {
  form.value = {
    id: item?.id || null,
    url: item?.url || '',
    title: item?.title || '',
    category: item?.category || '',
    tags: [...(item?.tags || [])],
    description: item?.description || '',
    iconData: item?.icon_data || null,
    baseVersion: item?.version,
  }
  base.value = JSON.stringify(form.value)
  saveError.value = ''
  duplicates.value = []
  conflict.value = null
  closeDetails()
  editing.value = true
}
function closeEditor() {
  if (saving.value) return
  if (dirty.value && !window.confirm('尚未保存，确认放弃本次修改？')) return
  editing.value = false
}
async function save(allowDuplicate = false) {
  if (saving.value) return
  saving.value = true
  saveError.value = ''
  duplicates.value = []
  conflict.value = null
  try {
    const response = form.value.id
      ? await api.bookmarks.update(form.value.id, {
          ...form.value,
          allowDuplicate,
        })
      : await api.bookmarks.create({ ...form.value, allowDuplicate })
    if (!alive) return
    editing.value = false
    toast.success('书签已保存')
    await load(1)
    loadMetadata()
    return response.data.data
  } catch (error) {
    saveError.value = message(error, '保存失败，输入已保留')
    duplicates.value = error.response?.data?.duplicates || []
    conflict.value = error.response?.data?.current || null
  } finally {
    saving.value = false
  }
}
function saveCopy() {
  form.value.id = null
  form.value.baseVersion = undefined
  conflict.value = null
  save(true)
}
async function removeOne(item) {
  if (deleting.value || !window.confirm('将此书签移入回收站？可以恢复。'))
    return
  deleting.value = true
  try {
    await api.bookmarks.delete(item.id)
    closeDetails()
    await load(1)
    loadMetadata()
    toast.success('已移入回收站')
  } catch (error) {
    toast.error(message(error, '回收失败，请重试'))
  } finally {
    deleting.value = false
  }
}
async function removeSelected() {
  if (
    isMobile.value ||
    deleting.value ||
    !window.confirm(
      '将已选 ' + selectedIds.value.length + ' 个书签移入回收站？',
    )
  )
    return
  deleting.value = true
  try {
    await api.bookmarks.batchDelete({ ids: selectedIds.value })
    await load(1)
    loadMetadata()
    toast.success('已移入回收站')
  } catch (error) {
    toast.error(message(error, '回收失败，选择已保留'))
  } finally {
    deleting.value = false
  }
}
function openImport() {
  importRows.value = []
  importError.value = ''
  importSelection.value = []
  importOpen.value = true
  toolsOpen.value = false
}
async function previewFile(event) {
  const file = event.target.files?.[0]
  if (!file) return
  importRows.value = []
  importSelection.value = []
  importError.value = ''
  if (file.size > 2 * 1024 * 1024) {
    importError.value = '文件不能超过 2 MB'
    return
  }
  importing.value = true
  try {
    const result = (
      await api.bookmarks.previewImport({
        content: await file.text(),
        format: file.name.toLowerCase().endsWith('.json') ? 'json' : 'html',
      })
    ).data.data
    importRows.value = result
    importSelection.value = result
      .filter((r) => !r.error && !r.duplicate)
      .map((r) => r.index)
  } catch (error) {
    importError.value = message(error, '解析失败，请检查文件格式')
  } finally {
    importing.value = false
  }
}
async function confirmImport() {
  if (importing.value || isMobile.value) return
  importing.value = true
  try {
    const result = (
      await api.bookmarks.import(
        importRows.value
          .filter((r) => importSelection.value.includes(r.index))
          .map((r) => r.form),
      )
    ).data.data
    importOpen.value = false
    toast.success(
      '导入 ' + result.imported + ' 条，跳过重复 ' + result.skipped + ' 条',
    )
    await load(1)
    loadMetadata()
  } catch (error) {
    importError.value = message(error, '导入失败，可重试；已有书签不会被覆盖')
  } finally {
    importing.value = false
  }
}
async function downloadExport(format) {
  if (exporting.value || isMobile.value) return
  exporting.value = true
  try {
    const result = (await api.bookmarks.export()).data.data
    const text =
        format === 'html'
          ? bookmarkHtmlExport(result.bookmarks)
          : JSON.stringify(result, null, 2),
      url = URL.createObjectURL(
        new Blob([text], {
          type:
            format === 'html' ? 'text/html;charset=utf-8' : 'application/json',
        }),
      )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'bookmarks.' + format
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (error) {
    toast.error(message(error, '导出失败'))
  } finally {
    exporting.value = false
  }
}
async function inspect() {
  if (isMobile.value || !detail.value || inspecting.value) return
  const id = detail.value.id,
    seq = ++inspectionSequence
  inspecting.value = true
  inspectionError.value = ''
  try {
    const data = (await api.bookmarks.inspect(id)).data.data
    if (alive && seq === inspectionSequence && detail.value?.id === id)
      inspection.value = data
  } catch (error) {
    if (seq === inspectionSequence)
      inspectionError.value = message(error, '未能创建任务，请重试')
  } finally {
    if (seq === inspectionSequence) inspecting.value = false
  }
}
async function refreshInspection() {
  if (!detail.value || isMobile.value) return
  const id = detail.value.id,
    seq = ++inspectionSequence
  try {
    const data = (await api.bookmarks.inspection(id)).data.data
    if (alive && seq === inspectionSequence && detail.value?.id === id) {
      inspection.value = data
      inspectionError.value = ''
    }
  } catch (error) {
    if (seq === inspectionSequence)
      inspectionError.value = message(error, '状态读取失败，请重试')
  }
}
function applySuggestion() {
  const item = detail.value,
    result = inspection.value?.result
  if (!item || !result) return
  edit(item)
  form.value.title = result.title || form.value.title
  form.value.iconData = result.iconData || form.value.iconData
  if (!form.value.description) form.value.description = result.description || ''
}
function beforeUnload(event) {
  if (dirty.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}
onBeforeRouteLeave(
  () =>
    !saving.value &&
    (!dirty.value || window.confirm('尚未保存，确认离开书签编辑？')),
)
watch(isMobile, () => {
  selecting.value = false
  selectedIds.value = []
  toolsOpen.value = false
  importOpen.value = false
  load(1)
})
watch(
  () => route.query,
  (query) => {
    const changed =
      keyword.value !== String(query.q || '') ||
      category.value !== String(query.category || '') ||
      tag.value !== String(query.tag || '') ||
      sortBy.value !== String(query.sort || 'title') ||
      direction.value !== String(query.direction || 'asc')
    const next = isMobile.value ? 1 : Number(query.page) || 1
    if (!changed && next === page.value) return
    keyword.value = String(query.q || '')
    category.value = String(query.category || '')
    tag.value = String(query.tag || '')
    sortBy.value = String(query.sort || 'title')
    direction.value = String(query.direction || 'asc')
    load(next)
  },
)
onMounted(() => {
  load(isMobile.value ? 1 : Number(route.query.page) || 1)
  loadMetadata()
  window.addEventListener('beforeunload', beforeUnload)
})
onBeforeUnmount(() => {
  alive = false
  ++listSequence
  ++detailSequence
  ++inspectionSequence
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<style scoped>
.bookmark-workspace {
  padding: 24px 28px;
  max-width: 1800px;
  margin: auto;
  color: var(--color-text-primary);
}
.bookmark-toolbar,
.bookmark-filters,
.bookmark-tools,
.bookmark-sort,
.bookmark-section-heading,
.bookmark-batch,
.bookmark-detail-actions,
.bookmark-editor-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.bookmark-toolbar {
  margin-bottom: 18px;
}
.bookmark-search {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-default);
  border-radius: 9px;
  padding: 0 12px;
  max-width: 560px;
  flex: 1;
  min-width: 220px;
  height: 42px;
}
.bookmark-search input {
  min-width: 0;
  flex: 1;
  border: 0;
  background: transparent;
  outline: 0;
  color: inherit;
  font: inherit;
}
.bookmark-search button {
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 12px;
}
.bookmark-filters {
  padding-bottom: 20px;
  border-bottom: 1px solid var(--color-border-default);
}
.bookmark-filters > :deep(.native-select) {
  width: 170px;
}
.bookmark-sort {
  margin-left: auto;
  gap: 4px;
}
.bookmark-sort :deep(.native-select) {
  width: 150px;
}
.bookmark-tools {
  padding: 8px 0 16px;
}
.bookmark-section-heading {
  justify-content: space-between;
  margin: 22px 0 16px;
  font-size: 15px;
  font-weight: 600;
  min-height: 32px;
}
.bookmark-section-heading small {
  font-size: 12px;
  font-weight: 400;
  color: var(--color-text-secondary);
  margin-left: 10px;
}
.bookmark-batch {
  font-weight: 400;
  font-size: 13px;
}
.bookmark-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(245px, 1fr));
  gap: 12px;
}
.bookmark-card {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 96px;
  border: 1px solid var(--color-border-default);
  background: var(--color-surface-raised);
  border-radius: 10px;
  transition:
    border-color 0.16s,
    background-color 0.16s;
}
.bookmark-card:hover {
  border-color: var(--color-text-muted);
}
.bookmark-card.selected {
  border-color: var(--color-primary);
  background: var(--color-primary-surface);
}
.bookmark-card-link {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 18px 40px 18px 16px;
  text-decoration: none;
  color: inherit;
  flex: 1;
  min-width: 0;
}
.bookmark-card-link:focus-visible,
.bookmark-more:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.bookmark-favicon {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  background: var(--color-surface-subtle);
  color: var(--color-text-secondary);
  font-size: 18px;
  font-weight: 600;
}
.bookmark-favicon img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}
.bookmark-card-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 5px;
}
.bookmark-card-text strong {
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
}
.bookmark-card-text small {
  font-size: 12px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bookmark-tags {
  font-size: 11px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bookmark-more {
  position: absolute;
  right: 6px;
  top: 12px;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.bookmark-more:hover {
  background: var(--color-surface-subtle);
}
.selection-link {
  border: 0;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.selection-indicator {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border: 1px solid var(--color-border-default);
  border-radius: 5px;
  display: grid;
  place-items: center;
  background: var(--color-surface-raised);
  color: var(--color-primary);
}
.bookmark-pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  padding: 22px 0;
  color: var(--color-text-secondary);
  font-size: 13px;
}
.bookmark-empty {
  padding: 70px 15px;
  text-align: center;
  color: var(--color-text-secondary);
}
.bookmark-empty h2 {
  font-size: 18px;
  color: var(--color-text-primary);
}
.bookmark-empty p {
  font-size: 14px;
}
.bookmark-feedback {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  background: var(--color-surface-subtle);
  border-radius: 8px;
  padding: 12px;
  font-size: 13px;
  margin-bottom: 12px;
}
.bookmark-skeleton {
  padding: 18px;
  gap: 13px;
  align-items: center;
}
.bookmark-skeleton > i {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: var(--color-surface-subtle);
}
.bookmark-skeleton > div {
  flex: 1;
}
.bookmark-skeleton > div i {
  display: block;
  height: 12px;
  width: 70%;
  margin: 8px 0;
  background: var(--color-surface-subtle);
  border-radius: 4px;
}
.bookmark-skeleton > div i:last-child {
  width: 45%;
}
.bookmark-detail {
  padding: 4px 4px 20px;
  overflow-wrap: anywhere;
}
.bookmark-detail h2 {
  font-size: 20px;
  line-height: 1.5;
  margin: 0 0 12px;
}
.bookmark-url {
  font-size: 13px;
  color: var(--color-primary);
}
.bookmark-description {
  white-space: pre-wrap;
  font-size: 14px;
  line-height: 1.7;
  margin: 24px 0;
}
.bookmark-detail-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 20px 0;
}
.bookmark-detail-tags span {
  font-size: 12px;
  background: var(--color-surface-subtle);
  border-radius: 5px;
  padding: 4px 8px;
}
.bookmark-inspection {
  border-top: 1px solid var(--color-border-default);
  margin-top: 28px;
  padding-top: 16px;
}
.bookmark-inspection h3 {
  font-size: 14px;
}
.bookmark-inspection p,
.bookmark-inspection small {
  font-size: 12px;
  line-height: 1.7;
  color: var(--color-text-secondary);
}
.bookmark-suggestion {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 15px;
  font-size: 13px;
}
.bookmark-editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.bookmark-editor > label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 13px;
  color: var(--color-text-secondary);
}
.bookmark-editor input,
.bookmark-editor textarea {
  font: inherit;
  color: var(--color-text-primary);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border-default);
  border-radius: 7px;
  padding: 10px 12px;
  width: 100%;
  box-sizing: border-box;
}
.bookmark-editor textarea {
  resize: vertical;
}
.bookmark-editor input:focus,
.bookmark-editor textarea:focus {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}
.bookmark-editor-footer {
  justify-content: flex-end;
  border-top: 1px solid var(--color-border-default);
  padding-top: 14px;
}
.bookmark-editor-footer small {
  margin-right: auto;
  font-size: 11px;
  color: var(--color-text-muted);
}
.bookmark-tag-suggestions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.bookmark-tag-suggestions button {
  border: 0;
  background: var(--color-surface-subtle);
  color: var(--color-text-secondary);
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.bookmark-import p {
  font-size: 13px;
  line-height: 1.7;
  color: var(--color-text-secondary);
}
.bookmark-import-list {
  max-height: 330px;
  overflow: auto;
  margin: 16px 0;
}
.bookmark-import-list label {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px;
  border-bottom: 1px solid var(--color-border-default);
  font-size: 13px;
}
.bookmark-import-list label span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.bookmark-import-list small {
  display: block;
  color: var(--color-text-secondary);
  font-size: 12px;
}
@media (max-width: 768px) {
  .bookmark-workspace {
    padding: 16px;
  }
  .bookmark-toolbar {
    gap: 8px;
    margin-bottom: 14px;
  }
  .bookmark-search {
    min-width: 0;
    height: 44px;
    padding: 0 10px;
  }
  .bookmark-search input {
    font-size: 14px;
  }
  .bookmark-search button {
    display: none;
  }
  .bookmark-toolbar :deep(.native-btn) {
    min-height: 44px;
  }
  .bookmark-filters {
    gap: 8px;
    padding-bottom: 14px;
  }
  .bookmark-filters > :deep(.native-select) {
    width: calc((100% - 16px) / 2);
    min-width: 0;
  }
  .bookmark-filters > :deep(.native-btn) {
    margin-left: auto;
  }
  .bookmark-section-heading {
    font-size: 15px;
    margin: 16px 0 12px;
  }
  .bookmark-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .bookmark-card {
    min-height: 118px;
  }
  .bookmark-card-link {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
    padding: 14px 12px;
  }
  .bookmark-card-text {
    width: 100%;
  }
  .bookmark-card-text strong {
    font-size: 14px;
  }
  .bookmark-more {
    width: 44px;
    height: 44px;
    right: 0;
    top: 0;
  }
  .bookmark-tags {
    display: none;
  }
  .bookmark-favicon {
    width: 32px;
    height: 32px;
    font-size: 16px;
  }
  .bookmark-favicon img {
    width: 22px;
    height: 22px;
  }
  .bookmark-pagination {
    justify-content: space-between;
    font-size: 12px;
  }
  .bookmark-editor input,
  .bookmark-editor textarea {
    font-size: 16px;
  }
  .bookmark-editor-footer small {
    width: 100%;
  }
  .bookmark-detail-actions :deep(.native-btn) {
    min-height: 44px;
  }
  .bookmark-detail {
    padding-bottom: env(safe-area-inset-bottom, 16px);
  }
  .bookmark-skeleton {
    min-height: 118px;
    box-sizing: border-box;
    flex-direction: column;
    align-items: flex-start;
  }
  .bookmark-skeleton > div {
    width: 100%;
  }
  .bookmark-skeleton > div i {
    margin: 4px 0;
  }
}
@media (max-width: 768px) {
  .bookmark-editor-footer :deep(.native-btn),
  .bookmark-tag-suggestions button,
  .bookmark-filters :deep(.native-select__trigger),
  .bookmark-filters :deep(.native-btn),
  .bookmark-pagination :deep(.native-btn) {
    min-height: 44px;
    min-width: 44px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bookmark-card {
    transition: none;
  }
}
</style>
