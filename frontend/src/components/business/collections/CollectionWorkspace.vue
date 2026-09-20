<template>
  <div class="collection-workspace">
    <form class="collection-toolbar" @submit.prevent="filterChanged">
      <label class="collection-search"
        ><NativeIcon name="magnifying-glass" /><input
          v-model="keyword"
          :aria-label="isGame ? '搜索 Steam 库' : '搜索我的动漫'"
          :placeholder="isGame ? '搜索 Steam 库' : '搜索我的动漫'"
        /><NativeButton type="submit" variant="text">搜索</NativeButton></label
      >
      <NativeButton v-if="!isMobile" @click="toolsOpen = true"
        ><NativeIcon :name="isGame ? 'refresh' : 'plus'" />{{
          isGame ? 'Steam 管理' : '从 Bangumi 添加'
        }}</NativeButton
      >
      <NativeButton
        variant="text"
        @click="router.push({ path: '/trash', query: { type: kind } })"
        aria-label="回收站"
        ><NativeIcon name="trash"
      /></NativeButton>
    </form>
    <div class="collection-filters">
      <div class="collection-tabs" aria-label="状态筛选">
        <button
          v-for="option in tabs"
          :key="option.value"
          :aria-pressed="status === option.value"
          @click="chooseStatus(option.value)"
        >
          {{ option.label }}<span>{{ countFor(option.value) }}</span>
        </button>
      </div>
      <div class="collection-controls">
        <NativeButton
          variant="text"
          :aria-pressed="favorite"
          @click="toggleFavorite"
          ><NativeIcon :name="'star'" />收藏</NativeButton
        >
        <div class="collection-sort">
          <NativeSelect
            v-model="sortBy"
            :options="collectionSorts[kind]"
            aria-label="排序"
            @change="filterChanged"
          /><NativeButton
            variant="text"
            :aria-label="sortOrder === 'ASC' ? '切换降序' : '切换升序'"
            @click="toggleOrder"
            ><NativeIcon
              :name="sortOrder === 'ASC' ? 'arrow-up' : 'arrow-down'"
          /></NativeButton>
        </div>
      </div>
    </div>
    <div class="collection-summary" aria-live="polite">
      {{ loading ? '正在加载…' : `${total} ${isGame ? '款游戏' : '部动漫'}`
      }}<span>{{
        isGame ? 'Steam 游玩记录与个人标记分开管理' : '收藏作品，记录观看状态'
      }}</span>
    </div>
    <div v-if="error" class="collection-notice" role="alert">
      {{ error }}<NativeButton @click="retryList">重试</NativeButton>
    </div>
    <div
      v-if="loading && !items.length"
      class="collection-grid"
      aria-label="加载中"
    >
      <div v-for="n in 12" :key="n" class="collection-skeleton">
        <div class="collection-cover" />
        <i /><i />
      </div>
    </div>
    <div
      v-else-if="!loading && !items.length && !error"
      class="collection-empty"
    >
      <NativeIcon
        :name="isGame ? 'game-controller' : 'film-strip'"
        :size="36"
      />
      <h2>
        {{
          filtered
            ? '没有符合条件的条目'
            : isGame
              ? '你的 Steam 书架还是空的'
              : '还没有收藏动漫'
        }}
      </h2>
      <p>
        {{
          filtered
            ? '试试其他状态，或清除搜索条件。'
            : isMobile
              ? '收藏加入后会在 PC 与移动端共享。'
              : isGame
              ? '在 PC 端主动连接 Steam，确认候选后加入本地库。'
              : '在 PC 端搜索 Bangumi，确认作品后加入收藏。'
        }}
      </p>
      <NativeButton v-if="filtered" @click="clearFilters">清除筛选</NativeButton
      ><NativeButton v-else-if="!isMobile" @click="toolsOpen = true">{{
        isGame ? '连接 Steam' : '查找作品'
      }}</NativeButton>
    </div>
    <div v-else class="collection-grid" :aria-busy="loading">
      <button
        v-for="item in items"
        :key="item.id"
        class="collection-card"
        @click="openDetails(item.id)"
      >
        <div class="collection-cover">
          <img
            v-if="collectionCover(item, kind) && !failedCovers[item.id]"
            :src="collectionCover(item, kind)"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
            @error="failedCovers[item.id] = true"
          />
          <div v-else class="collection-cover-fallback">
            <NativeIcon
              :name="isGame ? 'game-controller' : 'film-strip'"
              :size="32"
            /><span>{{ collectionTitle(item) }}</span>
          </div>
          <span v-if="item.is_favorite" class="collection-favorite"
            ><NativeIcon name="star" weight="fill" :size="14" /></span
          ><span class="collection-cover-action">查看详情</span>
        </div>
        <strong :title="collectionTitle(item)">{{
          collectionTitle(item)
        }}</strong
        ><span class="collection-card-meta"
          >{{ statusLabel(item.status)
          }}<span v-if="item.user_rating"
            >我的评分 {{ item.user_rating }}</span
          ></span
        ><small>{{
          isGame
            ? playtimeLabel(item.playtime_forever)
            : item.air_date || '放送日期待补充'
        }}</small>
      </button>
    </div>
    <div v-if="total" class="collection-pagination">
      <span>{{
        isMobile
          ? `已显示 ${items.length} / ${total}`
          : `第 ${page} / ${Math.max(1, Math.ceil(total / pageSize))} 页`
      }}</span
      ><template v-if="!isMobile"
        ><NativeButton
          :disabled="loading || page <= 1"
          @click="changePage(page - 1)"
          >上一页</NativeButton
        ><NativeButton
          :disabled="loading || page * pageSize >= total"
          @click="changePage(page + 1)"
          >下一页</NativeButton
        ></template
      ><NativeButton
        v-else-if="items.length < total"
        :loading="loading"
        @click="load(page + 1, true)"
        >加载下一批</NativeButton
      ><span v-else>已加载全部</span>
    </div>
    <NativeDrawer
      :model-value="detailOpen"
      :title="detail ? collectionTitle(detail) : '条目详情'"
      :placement="isMobile ? 'bottom' : 'right'"
      :size="isMobile ? '88dvh' : '520px'"
      :top-offset="isMobile ? 0 : 72"
      @update:model-value="requestClose"
    >
      <p v-if="detailLoading" role="status">正在加载详情…</p>
      <div v-if="detailError" class="collection-notice" role="alert">
        {{ detailError
        }}<NativeButton :disabled="saving" @click="reloadDetails"
          >重新载入</NativeButton
        >
      </div>
      <template v-if="detail && !detailLoading"
        ><div class="collection-detail-lead">
          <img
            v-if="collectionCover(detail, kind) && !failedCovers[detail.id]"
            :src="collectionCover(detail, kind)"
            @error="failedCovers[detail.id] = true"
            alt=""
            referrerpolicy="no-referrer"
          />
          <div>
            <p>
              {{ isGame ? 'Steam' : 'Bangumi' }} ·
              {{ isGame ? detail.steam_appid : detail.bangumi_id }}
            </p>
            <h2>{{ collectionTitle(detail) }}</h2>
            <p>
              {{
                isGame
                  ? playtimeLabel(detail.playtime_forever)
                  : detail.air_date || '放送日期未知'
              }}
            </p>
            <p v-if="isGame && detail.playtime_2weeks">
              近两周 {{ playtimeLabel(detail.playtime_2weeks) }}
            </p>
            <p v-if="!isGame && detail.rating">
              Bangumi {{ detail.rating }} 分 ·
              {{ detail.rating_count || 0 }} 人评分
            </p>
          </div>
        </div>
        <form class="collection-personal" @submit.prevent="save">
          <h3>我的记录</h3>
          <label
            >状态<NativeSelect
              v-model="form.status"
                :disabled="saving"
              :options="collectionStatuses[kind]"
              aria-label="更新个人状态" /></label
          ><label
            >我的评分<NativeSelect
              v-model="form.userRating"
                :disabled="saving"
              :options="ratings"
              aria-label="我的评分" /></label
          ><label class="collection-check"
            ><input type="checkbox" v-model="form.isFavorite" :disabled="saving" />加入收藏</label
          ><label v-if="isGame"
            >备注<textarea
              v-model="form.notes" :disabled="saving"
              rows="3"
              maxlength="5000"
              placeholder="只记你自己的想法"
            />
          </label>
          <div class="collection-save-row">
            <span>{{
              dirty ? '有未保存的修改' : '个人记录在 PC 与移动端共享'
            }}</span
            ><NativeButton
              type="submit"
              theme="primary"
              :loading="saving"
              :disabled="!dirty"
              >保存</NativeButton
            >
          </div>
        </form>
        <section
          v-if="detail.summary || detail.description"
          class="collection-detail-section"
        >
          <h3>简介</h3>
          <p class="collection-description">
            {{ detail.summary || detail.description }}
          </p>
        </section>
        <section v-if="!isGame" class="collection-detail-section">
          <h3>作品资料</h3>
          <dl>
            <template v-for="(value, label) in animeFacts" :key="label"
              ><dt>{{ label }}</dt>
              <dd>{{ value }}</dd></template
            >
          </dl>
          <details v-if="detail.infobox?.length">
            <summary>更多资料</summary>
            <dl>
              <template v-for="(field, index) in detail.infobox" :key="index"
                ><dt>{{ field.key }}</dt>
                <dd>{{ infoValue(field.value) }}</dd></template
              >
            </dl>
          </details>
          <details v-if="detail.characters?.length">
            <summary>角色与配音</summary>
            <p v-for="person in detail.characters" :key="person.id">
              {{ person.name }} <small>{{ person.relation }}</small>
            </p>
          </details>
          <details v-if="detail.staff?.length">
            <summary>制作人员</summary>
            <p v-for="person in detail.staff" :key="person.id">
              {{ person.name }} <small>{{ person.relation }}</small>
            </p>
          </details>
        </section>
        <section v-if="isGame" class="collection-detail-section">
          <h3>成就</h3>
          <p>
            {{ detail.achievements_completed || 0 }} /
            {{ detail.achievements_total || 0 }} 项 · 不代表通关进度
          </p>
          <NativeButton
            :loading="achievementsLoading"
            @click="loadAchievements(false)"
            >查看已保存成就</NativeButton
          ><NativeButton
            v-if="!isMobile"
            :loading="achievementsLoading"
            @click="loadAchievements(true)"
            >从 Steam 更新成就</NativeButton
          >
          <p v-if="achievementError" role="alert">{{ achievementError }}</p>
          <ul class="collection-achievements">
            <li v-for="item in achievements" :key="item.achievement_id">
              <span>{{ item.is_achieved ? '已解锁' : '未解锁' }}</span
              ><strong>{{ item.name }}</strong
              ><small>{{ item.description }}</small>
            </li>
          </ul>
        </section>
        <div class="collection-detail-actions">
          <NativeButton v-if="!isMobile && !isGame" @click="refreshOpen = true"
            >检查 Bangumi 资料更新</NativeButton
          ><NativeButton variant="text" :disabled="saving" @click="remove"
            >移入回收站</NativeButton
          >
        </div>
      </template>
    </NativeDrawer>
    <CollectionProviderPanel
      v-if="!isMobile && (toolsOpen || refreshOpen)"
      :kind="kind"
      :item-id="refreshOpen ? detail?.id : null"
      @close="closeProvider"
      @changed="providerChanged"
    />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import api from '@/api'
import { useViewport } from '@/composables/useViewport'
import { useToast } from '@/composables/useToast'
import {
  NativeButton,
  NativeDrawer,
  NativeIcon,
  NativeSelect,
} from '@/components/native'
import CollectionProviderPanel from './CollectionProviderPanel.vue'
import {
  collectionStatuses,
  collectionSorts,
  collectionTitle,
  collectionCover,
  playtimeLabel,
} from '@/utils/collectionPresentation'
const props = defineProps({ kind: { type: String, required: true } })
const kind = props.kind,
  isGame = kind === 'game',
  client = isGame ? api.games : api.anime
const { isMobile } = useViewport(),
  route = useRoute(),
  router = useRouter(),
  toast = useToast()
const keyword = ref(''),
  status = ref(''),
  favorite = ref(false),
  sortBy = ref(collectionSorts[kind][0].value),
  sortOrder = ref('DESC')
const items = ref([]),
  total = ref(0),
  counts = ref([]),
  page = ref(1),
  pageSize = 24,
  loading = ref(false),
  error = ref(''),
  failedCovers = ref({})
const detailOpen = ref(false),
  detailLoading = ref(false),
  detail = ref(null),
  detailId = ref(null),
  detailError = ref(''),
  form = ref({}),
  savedForm = ref(''),
  saving = ref(false)
const toolsOpen = ref(false),
  refreshOpen = ref(false),
  achievements = ref([]),
  achievementsLoading = ref(false),
  achievementError = ref('')
let lastListRequest = { target: 1, append: false }
let alive = true,
  listSequence = 0,
  detailSequence = 0,
  achievementSequence = 0
const tabs = [{ value: '', label: '全部' }, ...collectionStatuses[kind]]
const ratings = [
  { value: 0, label: '未评分' },
  ...Array.from({ length: 20 }, (_, index) => ({
    value: (index + 1) / 2,
    label: `${(index + 1) / 2} / 10`,
  })),
]
const dirty = computed(
  () => detail.value && JSON.stringify(form.value) !== savedForm.value,
)
const filtered = computed(() => keyword.value || status.value || favorite.value)
const animeFacts = computed(() =>
  Object.fromEntries(
    Object.entries({
      原名: detail.value?.name_original,
      原作: detail.value?.author,
      导演: detail.value?.director,
      制作: detail.value?.studio,
    }).filter(([, value]) => value),
  ),
)
const message = (error, fallback) => error.response?.data?.message || fallback
const statusLabel = (value) =>
  collectionStatuses[kind].find((option) => option.value === value)?.label ||
  '未标记'
const countFor = (value) =>
  value
    ? counts.value.find((row) => row.status === value)?.count || 0
    : counts.value.reduce((sum, row) => sum + row.count, 0)
const infoValue = (value) =>
  Array.isArray(value)
    ? value.map((row) => row.v || row.name || '').join('、')
    : String(value || '')
function retryList() { return load(lastListRequest.target, lastListRequest.append) }
async function load(target = 1, append = false) {
  lastListRequest = { target, append }
  const seq = ++listSequence
  loading.value = true
  error.value = ''
  try {
    const result = (
      await client.list({
        keyword: keyword.value,
        status: status.value,
        favorite: String(favorite.value),
        sortBy: sortBy.value,
        sortOrder: sortOrder.value,
        page: target,
        pageSize,
      })
    ).data
    if (!alive || seq !== listSequence) return
    if (target > 1 && !append && !result.data.length && result.total)
      return changePage(Math.ceil(result.total / pageSize))
    items.value = append
      ? [
          ...new Map(
            [...items.value, ...result.data].map((row) => [row.id, row]),
          ).values(),
        ]
      : result.data
    total.value = result.total
    counts.value = result.counts || []
    page.value = target
  } catch (e) {
    if (alive && seq === listSequence)
      error.value = message(e, '加载失败，已显示内容保持不变')
  } finally {
    if (alive && seq === listSequence) loading.value = false
  }
}
function syncQuery(target = 1) {
  const query = {
    ...route.query,
    q: keyword.value || undefined,
    status: status.value || undefined,
    favorite: favorite.value ? '1' : undefined,
    sort: sortBy.value,
    order: sortOrder.value,
    page: target > 1 ? String(target) : undefined,
  }
  return router.replace({ query })
}
async function filterChanged() {
  const before = route.fullPath
  await syncQuery()
  if (route.fullPath === before) load(1)
}
function chooseStatus(value) {
  status.value = value
  filterChanged()
}
function toggleFavorite() {
  favorite.value = !favorite.value
  filterChanged()
}
function toggleOrder() {
  sortOrder.value = sortOrder.value === 'ASC' ? 'DESC' : 'ASC'
  filterChanged()
}
function clearFilters() {
  keyword.value = ''
  status.value = ''
  favorite.value = false
  filterChanged()
}
function changePage(value) {
  syncQuery(value)
}
function setDetail(value) {
  detail.value = value
  form.value = {
    status: value.status,
    userRating: value.user_rating || 0,
    isFavorite: Boolean(value.is_favorite),
    ...(isGame ? { notes: value.notes || '' } : {}),
  }
  savedForm.value = JSON.stringify(form.value)
}
async function openDetails(id) {
  if (dirty.value && !window.confirm('放弃未保存的个人记录？')) return
  const seq = ++detailSequence
  detailId.value = id
  detail.value = null
  detailOpen.value = true
  detailLoading.value = true
  detailError.value = ''
  achievements.value = []
  achievementError.value = ''
  achievementsLoading.value = false
  ++achievementSequence
  try {
    const result = (await client.get(id)).data.data
    if (alive && seq === detailSequence) setDetail(result)
  } catch (e) {
    if (alive && seq === detailSequence)
      detailError.value = message(e, '详情加载失败')
  } finally {
    if (alive && seq === detailSequence) detailLoading.value = false
  }
}
function reloadDetails() {
  openDetails(detailId.value)
}
function requestClose(value) {
  if (
    value ||
    saving.value ||
    (dirty.value && !window.confirm('放弃未保存的个人记录？'))
  )
    return
  ++detailSequence
  ++achievementSequence
  detailOpen.value = false
  detail.value = null
}
async function save() {
  if (saving.value) return
  saving.value = true
  detailError.value = ''
  const id = detail.value.id,
    seq = detailSequence
  try {
    const result = (
      await client.update(id, {
        ...form.value,
        baseVersion: detail.value.version,
      })
    ).data.data
    if (!alive || seq !== detailSequence) return
    setDetail(result)
    toast.success('个人记录已保存')
    await refreshList()
  } catch (e) {
    if (alive && seq === detailSequence)
      detailError.value = message(e, '保存失败，修改已保留')
  } finally {
    if (alive) saving.value = false
  }
}
async function remove() {
  if (
    saving.value ||
    !window.confirm('移入统一回收站？条目及个人记录可以恢复。')
  )
    return
  saving.value = true
  try {
    await client.delete(detail.value.id, detail.value.version)
    if (!alive) return
    ++detailSequence
    detailOpen.value = false
    detail.value = null
    await refreshList()
    toast.success('已移入回收站')
  } catch (e) {
    if (alive) detailError.value = message(e, '移入回收站失败')
  } finally {
    if (alive) saving.value = false
  }
}
async function loadAchievements(refresh) {
  if (achievementsLoading.value || (refresh && isMobile.value)) return
  const seq = ++achievementSequence,
    id = detail.value.id
  achievementsLoading.value = true
  achievementError.value = ''
  try {
    const result = (
      await (refresh
        ? api.games.fetchAchievements(id)
        : api.games.getAchievements(id))
    ).data.data
    if (alive && seq === achievementSequence && detail.value?.id === id) {
      achievements.value = result?.achievements || []
      if (result?.game) {
        detail.value.achievements_total = result.game.achievements_total
        detail.value.achievements_completed = result.game.achievements_completed
      }
    }
  } catch (e) {
    if (alive && seq === achievementSequence)
      achievementError.value = message(e, '成就加载失败')
  } finally {
    if (alive && seq === achievementSequence) achievementsLoading.value = false
  }
}
function closeProvider() {
  toolsOpen.value = false
  refreshOpen.value = false
}
async function refreshList() {
  if (!isMobile.value && route.query.page) await syncQuery(1)
  else await load(1)
}
function providerChanged() {
  refreshList()
  if (detail.value && !dirty.value) openDetails(detail.value.id)
}
watch(
  () => route.query,
  (query) => {
    keyword.value = String(query.q || '')
    status.value = collectionStatuses[kind].some(
      (row) => row.value === query.status,
    )
      ? query.status
      : ''
    favorite.value = query.favorite === '1'
    sortBy.value = collectionSorts[kind].some((row) => row.value === query.sort)
      ? query.sort
      : collectionSorts[kind][0].value
    sortOrder.value = query.order === 'ASC' ? 'ASC' : 'DESC'
    const target = isMobile.value ? 1 : Number(query.page || 1)
    load(Number.isSafeInteger(target) && target > 0 ? target : 1)
  },
  { immediate: true },
)
watch(isMobile, () => {
  closeProvider()
  load(1)
})
onBeforeRouteLeave(
  () =>
    !saving.value &&
    (!dirty.value || window.confirm('放弃未保存的个人记录并离开？')),
)
onBeforeUnmount(() => {
  alive = false
  ++listSequence
  ++detailSequence
  ++achievementSequence
})
</script>

<style scoped src="./collection-workspace.css"></style>
