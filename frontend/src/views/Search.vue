<template>
  <div class="search">
    <div class="page-header">
      <p>在文档、音乐、代码、书签和动漫中搜索</p>
    </div>

    <t-card>
      <t-input
        v-model="keyword"
        placeholder="全局搜索..."
        size="large"
        @press-enter="handleSearch"
      >
        <template #suffix-icon>
          <t-icon name="search" />
        </template>
        <template #suffix>
          <t-button theme="primary" @click="handleSearch">搜索</t-button>
        </template>
      </t-input>
    </t-card>

    <div v-if="searchResults.length > 0" style="margin-top: 24px">
      <t-alert theme="info" :message="`找到 ${searchResults.length} 条结果`" />

      <t-tabs v-model="activeTab" style="margin-top: 16px">
        <t-tab-panel value="all" label="全部">
          <div v-for="(group, type) in groupedResults" :key="type" style="margin-bottom: 24px">
            <h3>{{ typeLabels[type] }} ({{ group.length }})</h3>
            <t-card>
              <t-list :split="true">
                <t-list-item v-for="item in group" :key="item.id">
                  <t-list-item-meta :title="item.title || item.name">
                    <template #description>
                      <t-space>
                        <t-tag size="small">{{ typeLabels[item.type] }}</t-tag>
                        <span v-if="item.category">{{ item.category }}</span>
                        <span v-if="item.artist">{{ item.artist }}</span>
                      </t-space>
                    </template>
                  </t-list-item-meta>
                  <template #action>
                    <t-button size="small" @click="goToItem(item, item.type)">查看</t-button>
                  </template>
                </t-list-item>
              </t-list>
            </t-card>
          </div>
        </t-tab-panel>

        <t-tab-panel value="documents" label="文档">
          <result-list :data="resultsByType.document" type="document" @view="goToItem" />
        </t-tab-panel>

        <t-tab-panel value="music" label="音乐">
          <result-list :data="resultsByType.music" type="music" @view="goToItem" />
        </t-tab-panel>

        <t-tab-panel value="code" label="代码">
          <result-list :data="resultsByType.code" type="code" @view="goToItem" />
        </t-tab-panel>

        <t-tab-panel value="bookmarks" label="书签">
          <result-list :data="resultsByType.bookmark" type="bookmark" @view="goToItem" />
        </t-tab-panel>

        <t-tab-panel value="anime" label="动漫">
          <result-list :data="resultsByType.anime" type="anime" @view="goToItem" />
        </t-tab-panel>
      </t-tabs>
    </div>

    <t-empty v-else-if="hasSearched" description="没有找到结果" />
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { MessagePlugin } from 'tdesign-vue-next'
import api from '@/api'

const router = useRouter()
const keyword = ref('')
const searchResults = ref([])
const hasSearched = ref(false)
const activeTab = ref('all')

const typeLabels = {
  document: '文档',
  music: '音乐',
  code: '代码',
  bookmark: '书签',
  anime: '动漫'
}

const groupedResults = computed(() => {
  const groups = {}
  searchResults.value.forEach(item => {
    if (!groups[item.type]) {
      groups[item.type] = []
    }
    groups[item.type].push(item)
  })
  return groups
})

const resultsByType = computed(() => ({
  document: groupedResults.value.document || [],
  music: groupedResults.value.music || [],
  code: groupedResults.value.code || [],
  bookmark: groupedResults.value.bookmark || [],
  anime: groupedResults.value.anime || []
}))

async function handleSearch() {
  if (!keyword.value.trim()) {
    return
  }

  try {
    const response = await api.search.global(keyword.value)
    searchResults.value = response.data.data || []
    hasSearched.value = true
  } catch (error) {
    MessagePlugin.error('搜索失败')
  }
}

function goToItem(item, type) {
  const routeMap = {
    document: '/documents',
    music: '/music',
    code: '/code',
    bookmark: '/bookmarks',
    anime: '/anime'
  }
  router.push(routeMap[type])
}
</script>

<style scoped>
.search {
  padding: 0;
}

.page-header {
  margin-bottom: 20px;
}

.page-header p {
  font-size: 16px;
  color: #333;
  margin: 0;
  font-weight: 500;
}

h3 {
  margin-bottom: 12px;
  font-size: 16px;
  color: #333;
}

.t-list-item {
  padding: 16px;
}

.t-button {
  margin-left: 8px;
}
</style>
