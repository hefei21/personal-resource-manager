<template>
  <NativeDialog
    :model-value="modelValue"
    title="上传书籍"
    width="720px"
    :confirm-text="uploading ? '上传中…' : parsing ? '解析中…' : '上传书籍'"
    :confirm-loading="uploading"
    :confirm-disabled="uploading || parsing"
    :close-on-overlay-click="!uploading && !parsing"
    :close-btn="!uploading && !parsing"
    @update:model-value="emit('update:modelValue', $event)"
    @confirm="submit"
  >
    <div class="ebook-upload__intro"><span><NativeIcon name="book-open" size="22" /></span><div><strong>上传一本新书</strong><p>支持 EPUB、PDF、TXT、MOBI、AZW、AZW3 和 FB2；书籍原件保持不可变，更换文件时请作为新书上传。</p></div></div>
    <NativeForm class="ebook-upload__form" label-width="96px">
      <NativeFormItem label="书籍文件" required>
        <NativeUpload v-model="form.file" drag accept=".txt,.epub,.pdf,.mobi,.azw,.azw3,.fb2,.html,.htm" :multiple="false" :auto-upload="false" :disabled="uploading || parsing" @change="onFileChange" />
        <div v-if="parsing" class="ebook-upload__parsing"><NativeIcon name="arrow-clockwise" />正在读取 EPUB 元数据…</div>
      </NativeFormItem>
      <div class="ebook-upload__grid">
        <NativeFormItem label="书名" required><NativeInput v-model="form.title" placeholder="书籍名称" /></NativeFormItem>
        <NativeFormItem label="作者"><NativeInput v-model="form.author" placeholder="作者未知时可留空" /></NativeFormItem>
        <NativeFormItem label="分类"><NativeSelect v-model="form.categoryId" clearable placeholder="未分类" :options="categoryOptions" /></NativeFormItem>
        <NativeFormItem label="出版年份"><NativeInput v-model="form.year" placeholder="例如 2026" /></NativeFormItem>
        <NativeFormItem label="出版社"><NativeInput v-model="form.publisher" placeholder="出版社" /></NativeFormItem>
        <NativeFormItem label="ISBN"><NativeInput v-model="form.isbn" placeholder="ISBN" /></NativeFormItem>
      </div>
      <NativeFormItem label="内容简介"><NativeTextarea v-model="form.description" :rows="4" :maxlength="1000" placeholder="可选；EPUB 会尝试自动读取" /></NativeFormItem>
    </NativeForm>
    <div v-if="uploading" class="ebook-upload__progress"><div><strong>{{ uploadPhase }}</strong><span>{{ uploadProgress }}%</span></div><NativeProgress :percentage="uploadProgress" :label="false" /><small>上传期间请勿关闭窗口；失败不会创建残缺书籍记录。</small></div>
  </NativeDialog>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import api from '@/api'
import { NativeDialog, NativeForm, NativeFormItem, NativeIcon, NativeInput, NativeProgress, NativeSelect, NativeTextarea, NativeUpload } from '@/components/native'
import { useToast } from '@/composables/useToast'

const props = defineProps({ modelValue: Boolean, categories: { type: Array, default: () => [] }, initialCategoryId: { type: [String, Number], default: null } })
const emit = defineEmits(['update:modelValue', 'uploaded'])
const toast = useToast()
const form = reactive(emptyForm())
const parsing = ref(false)
const uploading = ref(false)
const uploadProgress = ref(0)
const uploadPhase = ref('准备上传')
let stagedUpload = null
let stagedMetadata = null
const categoryOptions = computed(() => props.categories.map(category => ({ value: category.id, label: category.name })))

function emptyForm() { return { file: [], title: '', author: '', year: '', publisher: '', isbn: '', description: '', categoryId: props.initialCategoryId || null } }
function reset() { Object.assign(form, emptyForm()); stagedUpload = null; stagedMetadata = null; uploadProgress.value = 0; uploadPhase.value = '准备上传' }
function actualFile() { const selected = form.file?.[0]; return selected?.raw || selected?.originFileObj || selected || null }
function extension(file) { return String(file?.name || '').split('.').pop()?.toLowerCase() || '' }
function stagedContract(result) {
  const contract = { stagingToken: result?.stagingToken, contentSha256: String(result?.contentSha256 || '').toLowerCase(), contentBytes: Number(result?.contentBytes), originalName: result?.originalName }
  if (!contract.stagingToken || !/^[a-f0-9]{64}$/.test(contract.contentSha256) || !Number.isSafeInteger(contract.contentBytes) || contract.contentBytes < 0 || !contract.originalName) throw new Error('服务端未返回完整的暂存文件凭据')
  return contract
}
function applyMetadata(metadata = {}) { for (const key of ['title','author','year','publisher','isbn','description']) if (metadata[key]) form[key] = metadata[key] }

async function onFileChange(files) {
  stagedUpload = null
  stagedMetadata = null
  const file = files?.[0]?.raw || files?.[0]?.originFileObj || files?.[0]
  if (!file) return
  form.title = file.name.replace(/\.[^/.]+$/u, '')
  if (extension(file) !== 'epub' || file.size > 100 * 1024 * 1024) return
  parsing.value = true
  try {
    const payload = new FormData(); payload.append('file', file)
    applyMetadata((await api.books.parseMetadata(payload)).data?.data)
    toast.success('已读取 EPUB 元数据，请确认后上传')
  } catch { toast.warning('未能自动读取元数据，可继续手动填写') } finally { parsing.value = false }
}

async function uploadChunks(file) {
  const chunkBytes = 5 * 1024 * 1024
  const totalChunks = Math.ceil(file.size / chunkBytes)
  const fileId = `${Date.now()}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`
  try {
    for (let index = 0; index < totalChunks; index += 1) {
      uploadPhase.value = `上传分片 ${index + 1} / ${totalChunks}`
      const payload = new FormData()
      payload.append('chunk', file.slice(index * chunkBytes, Math.min(file.size, (index + 1) * chunkBytes)))
      payload.append('index', String(index)); payload.append('totalChunks', String(totalChunks)); payload.append('fileId', fileId); payload.append('fileName', file.name)
      await api.books.uploadChunk(payload)
      uploadProgress.value = Math.round(((index + 1) / totalChunks) * 85)
    }
    uploadPhase.value = '校验并合并文件'
    const result = (await api.books.mergeChunks({ fileId, fileName: file.name, totalChunks })).data?.data
    return { contract: stagedContract(result), metadata: result || {} }
  } catch (error) {
    try { await api.books.cancelUpload(fileId) } catch {}
    throw error
  }
}

function metadataPayload() { return { title: form.title.trim(), author: form.author || '', year: form.year || '', publisher: form.publisher || '', isbn: form.isbn || '', description: form.description || '', categoryId: form.categoryId || null } }
function metadataPayloadWithParsed(file) {
  const payload = metadataPayload()
  if (!stagedMetadata) return payload
  const defaultTitle = String(file?.name || '').replace(/\.[^/.]+$/u, '')
  for (const key of ['author', 'year', 'publisher', 'isbn', 'description']) {
    if (!payload[key] && stagedMetadata[key]) payload[key] = stagedMetadata[key]
  }
  if ((!payload.title || payload.title === defaultTitle) && stagedMetadata.title) payload.title = stagedMetadata.title
  return payload
}
async function submit() {
  const file = actualFile()
  if (!file) return toast.error('请选择书籍文件')
  if (!form.title.trim()) return toast.error('请输入书名')
  uploading.value = true; uploadProgress.value = 0
  try {
    let response
    if (file.size > 100 * 1024 * 1024) {
      if (!stagedUpload) {
        const merged = await uploadChunks(file)
        stagedUpload = merged.contract
        stagedMetadata = merged.metadata
      }
      uploadPhase.value = '创建书籍记录'; uploadProgress.value = 92
      response = await api.books.uploadWithPath({ ...stagedUpload, ...metadataPayloadWithParsed(file) })
    } else {
      uploadPhase.value = '上传并校验文件'
      const payload = new FormData(); payload.append('file', file)
      for (const [key, value] of Object.entries(metadataPayload())) if (value !== null && value !== '') payload.append(key, value)
      response = await api.books.upload(payload, event => { if (event.total) uploadProgress.value = Math.round(event.loaded / event.total * 92) })
    }
    uploadProgress.value = 100; uploadPhase.value = '上传完成'
    const status = response.data?.metadataStatus
    toast[status === 'pending' || status === 'failed' ? 'warning' : 'success'](status === 'pending' ? '上传成功，元数据将在后台继续解析' : status === 'failed' ? '上传成功，元数据解析失败，可稍后重试' : '上传成功')
    emit('update:modelValue', false); emit('uploaded', response.data); reset()
  } catch (error) { toast.error(error.response?.data?.message || error.message || '上传失败') } finally { uploading.value = false }
}

watch(() => props.modelValue, visible => { if (visible) reset() })
</script>

<style scoped>
.ebook-upload__intro{display:flex;gap:12px;margin-bottom:18px;padding:14px;border:1px solid var(--color-primary-border);border-radius:var(--radius-md);background:var(--color-primary-surface)}.ebook-upload__intro>span{width:42px;height:42px;flex:0 0 auto;display:grid;place-items:center;border-radius:10px;background:var(--color-surface-raised);color:var(--color-primary)}.ebook-upload__intro strong,.ebook-upload__intro p{margin:0}.ebook-upload__intro p{margin-top:3px;font-size:12px;line-height:1.55;color:var(--color-text-secondary)}.ebook-upload__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}.ebook-upload__parsing{display:flex;align-items:center;gap:6px;margin-top:7px;font-size:12px;color:var(--color-primary)}.ebook-upload__parsing :deep(svg){animation:ebook-spin 1s linear infinite}.ebook-upload__progress{display:grid;gap:8px;margin-top:16px;padding:14px;border-radius:var(--radius-md);background:var(--color-surface-subtle)}.ebook-upload__progress>div{display:flex;justify-content:space-between}.ebook-upload__progress small{color:var(--color-text-muted)}@keyframes ebook-spin{to{transform:rotate(360deg)}}
</style>
