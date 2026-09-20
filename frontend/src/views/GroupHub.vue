<template>
  <section class="group-hub">
    <header class="group-hub-header">
      <p class="eyebrow">{{ mobile ? '快速入口' : '分组概览' }}</p>
      <h1 v-if="mobile">{{ heading }}</h1>
      <p>{{ description }}</p>
    </header>

    <ThemeControl v-if="group === 'system'" />
    <SystemStatusOverview v-if="['system', 'workspace'].includes(group)" />

    <div v-if="items.length" class="module-grid">
      <RouterLink v-for="item in items" :key="item.routeName" :to="item.path" class="module-card">
        <span class="module-icon" aria-hidden="true">
          <NativeIcon :name="item.pcIcon" size="22" />
        </span>
        <span class="module-copy">
          <strong>{{ item.label }}</strong>
          <small>{{ moduleDescriptions[item.routeName] }}</small>
        </span>
        <NativeIcon name="chevron-right" size="16" class="module-arrow" aria-hidden="true" />
      </RouterLink>
    </div>

    <div v-else class="empty-panel">
      <NativeIcon name="info" size="22" />
      <div>
        <strong>暂无可在移动端操作的系统模块</strong>
        <p>这里仅展示只读系统摘要和低频入口，高风险操作保持隐藏。</p>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useViewport } from '@/composables/useViewport'
import { navigationItemsForGroup, pageTitleForRoute } from '@/router/navigation'
import ThemeControl from '@/components/business/ThemeControl.vue'
import SystemStatusOverview from '@/components/business/SystemStatusOverview.vue'
import { NativeIcon } from '@/components/native'

const route = useRoute()
const authStore = useAuthStore()
const { isMobile: mobile } = useViewport()

const descriptions = {
  library: '集中浏览与管理文档、个人笔记、音频、电子书和代码知识库。',
  collection: '管理书签、动漫和游戏等长期收藏内容。',
  workspace: '从统一搜索进入知识内容，并跟踪后台任务。',
  system: '查看服务健康、运行状态和低频管理入口。'
}

const moduleDescriptions = {
  Documents: '文件、元数据、版本与全文内容',
  Blog: '长期沉淀的个人笔记',
  Music: '音频资源与播放入口',
  Books: '电子书资源与阅读信息',
  Code: '仓库、符号和 commit 绑定的代码知识',
  Bookmarks: '网页链接与分类收藏',
  Anime: '动漫收藏、观看状态与评分',
  Games: '游戏条目与游玩记录',
  Search: '跨资源全文与语义检索',
  Tasks: '导入、索引等持久任务状态',
  Logs: 'Owner 访问与审计记录'
}

const group = computed(() => route.meta.group)
const heading = computed(() => pageTitleForRoute(route.name))
const description = computed(() => descriptions[group.value] || '')
const items = computed(() => navigationItemsForGroup(group.value, {
  mobile: mobile.value,
  includeOwner: authStore.isAdmin()
}))
</script>

<style scoped>
.group-hub {
  width: min(1040px, 100%);
  margin: 0 auto;
}

.group-hub-header {
  padding: 8px 0 24px;
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

h1 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: clamp(24px, 4vw, 32px);
  letter-spacing: -0.03em;
}

.group-hub-header > p:last-child {
  max-width: 680px;
  margin: 10px 0 0;
  color: var(--color-text-secondary);
  line-height: 1.7;
}

.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}

.module-card {
  min-height: 88px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 12px;
  background: var(--color-surface-raised);
  color: var(--color-text-primary);
  text-decoration: none;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}

.module-card:hover,
.module-card:focus-visible {
  border-color: var(--color-primary-border);
  box-shadow: 0 8px 24px rgba(30, 41, 59, 0.08);
  outline: none;
}

.module-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  border-radius: 10px;
  background: var(--color-primary-surface);
  color: var(--color-primary);
}

.module-copy {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.module-copy strong {
  font-size: 15px;
}

.module-copy small {
  color: var(--color-text-secondary);
  line-height: 1.45;
}

.module-arrow {
  margin-left: auto;
  color: var(--color-text-muted);
}

.empty-panel {
  display: flex;
  gap: 12px;
  padding: 18px;
  border: 1px solid var(--color-primary-border);
  border-radius: 12px;
  background: var(--color-surface-subtle);
  color: var(--color-text-secondary);
}

.empty-panel strong {
  color: var(--color-text-primary);
}

.empty-panel p {
  margin: 5px 0 0;
  line-height: 1.55;
}

@media (max-width: 600px) {
  .group-hub-header {
    padding-top: 2px;
  }

  .module-grid {
    grid-template-columns: 1fr;
  }
}
</style>
