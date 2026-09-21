import { ref } from 'vue'

export function useRagSections({ api }) {
  const options = ref([])
  const selected = ref('')
  const loading = ref(false)
  const error = ref('')
  let generation = 0
  let bookId = null
  async function load(id, { preserve = false } = {}) {
    const token = ++generation
    bookId = id
    options.value = []
    error.value = ''
    if (!preserve) selected.value = ''
    loading.value = !!id
    if (!id) return
    try {
      const response = await api.sections(id)
      if (token !== generation) return
      const items = response.data?.data?.sections
      if (!Array.isArray(items)) throw new Error('Invalid chapter catalog')
      options.value = items
      if (selected.value && !items.some(item => item.key === selected.value)) {
        error.value = '章节范围已失效，请重新选择章节或显式切回整本书。'
      }
    } catch {
      if (token === generation) error.value = '章节目录暂不可用，请重试；不会自动扩大已选范围。'
    } finally {
      if (token === generation) loading.value = false
    }
  }
  return { options, selected, loading, error, load,
    retry: () => load(bookId, { preserve: true }),
    dispose: () => { generation += 1 } }
}
