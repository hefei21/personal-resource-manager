<template>
  <div class="notes-workspace" :class="{ 'has-note': pane !== 'list', 'is-mobile': isMobile }">
    <section v-if="pane === 'list' || !isMobile" class="note-library" aria-label="笔记列表">
      <form class="note-search" @submit.prevent="filterNotes">
        <NativeInput v-model="keyword" placeholder="搜索标题与正文" aria-label="搜索标题与正文" clearable @clear="filterNotes" />
        <NativeButton type="submit" variant="text" aria-label="搜索"><NativeIcon name="magnifying-glass" /></NativeButton>
        <NativeButton theme="primary" aria-label="新建笔记" @click="startNew"><NativeIcon name="plus" /><span v-if="!isMobile">新建</span></NativeButton>
      </form>
      <div class="note-filters">
        <NativeSelect v-model="category" :options="filterCategories" aria-label="笔记分类" @change="filterNotes" />
        <NativeSelect v-model="tag" :options="[{value:'',label:'全部标签'}, ...tags.map(t => ({value:String(t.id),label:t.name}))]" aria-label="筛选标签" @change="filterNotes" />
      </div>
      <div class="note-library-tools"><span>{{ total }} 篇笔记</span><div><NativeButton v-if="!isMobile" variant="text" size="small" @click="categoryManager = true">分类管理</NativeButton><NativeButton variant="text" size="small" @click="goTrash">回收站</NativeButton></div></div>
      <section v-if="drafts.length" class="note-drafts" aria-label="本机草稿">
        <strong>本机未保存 · {{ drafts.length }}</strong><small>尚未同步到 NAS · 退出登录会清除</small>
        <div v-for="draft in drafts" :key="draft.key"><button class="draft-open" @click="resumeDraft(draft)">{{ draft.form.title || '未命名笔记' }}</button><button class="icon-button" aria-label="丢弃草稿" @click="discardDraft(draft)"><NativeIcon name="x" /></button></div>
      </section>
      <div v-if="listError" class="note-message" role="alert">{{ listError }}<NativeButton size="small" variant="text" @click="loadNotes(page)">重试</NativeButton></div>
      <div v-if="loading && !notes.length" class="note-skeleton" aria-label="正在加载笔记"><div v-for="n in 5" :key="n"><i /><i /></div></div>
      <div v-else-if="!notes.length && !listError" class="note-empty"><NativeIcon name="notebook" size="32" /><p>{{ keyword || category || tag ? '没有匹配的笔记' : '写下值得留存的想法' }}</p><NativeButton variant="text" @click="keyword || category || tag ? resetFilters() : startNew()">{{ keyword || category || tag ? '清除筛选' : '新建笔记' }}</NativeButton></div>
      <div v-else class="note-rows" :aria-busy="loading">
        <button v-for="note in notes" :key="note.id" class="note-row" :class="{ selected: selected?.id === note.id }" @click="openNote(note.id)">
          <div class="note-row-heading"><span v-if="note.is_top" class="note-pin">置顶</span><strong>{{ note.title }}</strong></div>
          <p>{{ note.excerpt || '暂无正文' }}</p><div class="note-row-meta"><span>{{ note.category_name || '未分类' }}</span><time>{{ dateLabel(note.updated_at) }}</time></div>
          <div v-if="note.tags.length" class="note-row-tags"><span v-for="name in note.tags.slice(0,3)" :key="name">{{ name }}</span><span v-if="note.tags.length > 3">+{{ note.tags.length-3 }}</span></div>
        </button>
      </div>
      <nav v-if="total > pageSize" class="note-pages" aria-label="笔记分页"><NativeButton size="small" variant="text" :disabled="page <= 1 || loading" @click="loadNotes(page-1)">上一页</NativeButton><span>{{ page }} / {{ Math.ceil(total/pageSize) }}</span><NativeButton size="small" variant="text" :disabled="page * pageSize >= total || loading" @click="loadNotes(page+1)">下一页</NativeButton></nav>
    </section>

    <section v-if="pane !== 'list' || !isMobile" class="note-content" :class="{ 'note-content-edit': pane === 'edit' }" aria-label="笔记内容">
      <div v-if="pane === 'list'" class="note-empty note-welcome"><NativeIcon name="notebook" size="36" /><h2>留一点空间给思考</h2><p>选择一篇笔记阅读，或开始新的记录。</p></div>
      <template v-else>
        <header class="note-content-header"><NativeButton variant="text" aria-label="返回笔记列表" @click="closePane"><NativeIcon name="arrow-left" /></NativeButton><span class="note-save-state" role="status">{{ pane === 'edit' ? saveState : '阅读' }}</span><div class="note-header-actions">
          <template v-if="pane === 'read'"><NativeButton variant="text" @click="editSelected"><NativeIcon name="pencil" />编辑</NativeButton><NativeButton variant="text" aria-label="移入回收站" @click="deleteSelected"><NativeIcon name="trash" /></NativeButton></template>
          <template v-else><NativeButton variant="text" :disabled="saving" @click="preview = !preview">{{ preview ? '继续编辑' : '预览' }}</NativeButton><NativeButton theme="primary" :loading="saving" :disabled="!dirty || !!conflict || !!pendingDraft" @click="saveNote">保存</NativeButton></template>
        </div></header>
        <div v-if="detailLoading" class="note-empty" role="status">正在打开笔记…</div>
        <div v-else-if="detailError" class="note-message" role="alert">{{ detailError }}<NativeButton variant="text" @click="openNote(requestedId, true)">重试</NativeButton></div>
        <template v-else>
          <div v-if="pendingDraft" class="note-message">这篇笔记有本机草稿，是否继续？<NativeButton size="small" @click="resumeDraft(pendingDraft)">继续草稿</NativeButton><NativeButton size="small" variant="text" @click="discardDraft(pendingDraft)">丢弃草稿</NativeButton></div>
          <div v-if="saveError" class="note-message" role="alert">{{ saveError }}<NativeButton v-if="!conflict" size="small" variant="text" @click="saveNote">重试保存</NativeButton></div>
          <section v-if="conflict" class="note-conflict" role="alert"><strong>检测到另一份修改 · 本机内容已保留</strong><p>下方是 NAS 最新内容。可以保留本机内容另存副本，或确认后用 NAS 版本继续。</p><details><summary>比较 NAS 最新版本：{{ conflict.title }}</summary><pre>{{ conflict.content }}</pre></details><div><NativeButton size="small" @click="saveCopy">本机内容另存副本</NativeButton><NativeButton size="small" variant="text" @click="useServerVersion">使用 NAS 版本</NativeButton></div></section>
          <article v-if="pane === 'read'" class="note-article"><div class="note-article-meta">{{ selected?.category_name || '未分类' }} · {{ dateLabel(selected?.updated_at) }}</div><h1>{{ selected?.title }}</h1><div class="note-read-tags"><span v-for="name in selected?.tags" :key="name">{{ name }}</span></div><MdPreview :theme="appTheme" :model-value="selected?.content || ''" :sanitize="sanitizeRichHtml" /></article>
          <div v-else class="note-editor">
            <label class="sr-only" for="note-title">笔记标题</label><input id="note-title" v-model="form.title" class="note-title-input" placeholder="笔记标题" maxlength="300" :disabled="saving" />
            <div class="note-editor-meta"><NativeSelect v-model="form.category_id" :options="editorCategories" aria-label="笔记所属分类" :disabled="saving" /><button class="note-meta-toggle" @click="showMeta = !showMeta">标签与置顶 <NativeIcon name="caret-down" /></button></div>
            <div v-if="showMeta" class="note-editor-options"><NativeTagInput v-model="form.tags" placeholder="输入标签，回车确认" :max-tags="40" :max-length="80" :create-tag-on-blur="true" :disabled="saving" /><div class="note-tag-suggestions" aria-label="已有标签建议"><button v-for="name in suggestions" :key="name" :disabled="saving" @click="form.tags.push(name)">+ {{ name }}</button></div><NativeCheckbox v-model="form.is_top" :disabled="saving">置顶笔记</NativeCheckbox></div>
            <MdPreview :theme="appTheme" v-if="preview" :model-value="form.content" :sanitize="sanitizeRichHtml" class="note-edit-preview" />
            <MdEditor :theme="appTheme" v-else v-model="form.content" :sanitize="sanitizeRichHtml" :toolbars="toolbars" :footers="[]" :preview="false" :read-only="saving" :auto-detect-code="false" :no-upload-img="true" @on-save="saveNote" class="note-md-editor" />
            <footer class="note-editor-footer"><span>Markdown · {{ form.content.length.toLocaleString() }} 字</span><span>保存后双端可见</span></footer>
          </div>
        </template>
      </template>
    </section>

    <NativeDialog v-if="!isMobile" v-model="categoryManager" title="分类管理" :show-footer="false" width="480px">
      <form class="note-category-create" @submit.prevent="saveCategory"><NativeInput v-model="categoryName" placeholder="分类名称" aria-label="分类名称" maxlength="80" /><NativeButton type="submit" theme="primary" :loading="categorySaving">{{ editingCategory ? '保存' : '添加' }}</NativeButton><NativeButton v-if="editingCategory" variant="text" @click="editingCategory=null; categoryName=''">取消</NativeButton></form>
      <p class="note-help">删除分类不会删除笔记；原笔记将归入未分类。</p>
      <div v-for="cat in categories" :key="cat.id" class="note-category-row"><span>{{ categoryPath(cat.id) }}</span><small>{{ cat.post_count }}</small><NativeButton size="small" variant="text" :aria-label="'编辑分类 '+cat.name" @click="editingCategory=cat; categoryName=cat.name"><NativeIcon name="pencil" /></NativeButton><NativeButton size="small" variant="text" :aria-label="'删除分类 '+cat.name" @click="deleteCategory(cat)"><NativeIcon name="trash" /></NativeButton></div>
    </NativeDialog>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { MdEditor, MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import { NativeInput, NativeButton, NativeIcon, NativeSelect, NativeTagInput, NativeCheckbox, NativeDialog } from '@/components/native'
import { sanitizeRichHtml } from '@/utils/sanitizeHtml'
import { useViewport } from '@/composables/useViewport'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { NOTE_DRAFT_PREFIX, newNoteMutation, noteForm, sameNote, readNoteDrafts, writeNoteDraft } from '@/utils/noteDrafts'
import api from '@/api'
import { useAppTheme } from '@/composables/useAppTheme'
const { resolved: appTheme } = useAppTheme()

const { isMobile } = useViewport(), route = useRoute(), router = useRouter(), auth = useAuthStore(), toast = useToast()
const notes=ref([]), total=ref(0), page=ref(1), pageSize=30, loading=ref(false), listError=ref('')
const keyword=ref(String(route.query.q || '')), category=ref(String(route.query.category || '')), tag=ref(String(route.query.tag || ''))
const categories=ref([]), tags=ref([]), selected=ref(null), pane=ref('list'), detailLoading=ref(false), detailError=ref(''), requestedId=ref(null)
const form=ref(noteForm()), base=ref(noteForm()), baseRevision=ref(0), editingId=ref(null), saving=ref(false), preview=ref(false), showMeta=ref(false), saveError=ref(''), conflict=ref(null)
const drafts=ref([]), pendingDraft=ref(null), draftKey=ref(null), draftStatus=ref(''), mutation=ref(newNoteMutation()), pendingSave=ref(null)
const categoryManager=ref(false), categoryName=ref(''), editingCategory=ref(null), categorySaving=ref(false)
let listSequence=0, detailSequence=0, timer=null, mounted=true
const owner = computed(() => auth.isAuthenticated && !auth.isGuest() ? auth.user?.id ?? auth.user?.username : null)
const dirty = computed(() => pane.value === 'edit' && !sameNote(form.value, base.value))
const visibleNoteId = computed(() => pane.value === 'list' ? null : pane.value === 'edit' ? editingId.value : selected.value?.id || requestedId.value)
const saveState = computed(() => saving.value ? '正在保存到 NAS…' : dirty.value ? draftStatus.value || '未保存' : editingId.value ? '已保存到 NAS' : '新建笔记 · 尚未保存')
const toolbars=['bold','italic','title','quote','unorderedList','orderedList','codeRow','code','link','table','revoke','next']
const suggestions=computed(() => tags.value.map(t=>t.name).filter(t=>!form.value.tags.includes(t)).slice(0,8))
function categoryPath(id) { const result=[], seen=new Set(); let cat=categories.value.find(c=>c.id===Number(id)); while(cat && !seen.has(cat.id)) { seen.add(cat.id); result.unshift(cat.name); cat=categories.value.find(c=>c.id===cat.parent_id) } return result.join(' / ') }
const editorCategories=computed(()=>[{value:null,label:'未分类'},...categories.value.map(c=>({value:c.id,label:categoryPath(c.id)}))])
const filterCategories=computed(()=>[{value:'',label:'全部分类'},{value:'unfiled',label:'未分类'},...categories.value.map(c=>({value:String(c.id),label:categoryPath(c.id)}))])
const dateLabel=value=>value ? String(value).replace('T',' ').slice(0,16) : ''
const errorMessage=(error,fallback)=>error.response?.data?.message || fallback
function refreshDrafts() { try { drafts.value=owner.value == null ? [] : readNoteDrafts(localStorage,owner.value) } catch { drafts.value=[] } }
function persistDraft() {
  clearTimeout(timer)
  if (!dirty.value || owner.value == null || !draftKey.value) return
  try { writeNoteDraft(localStorage,draftKey.value,{ noteId:editingId.value, baseRevision:baseRevision.value, base:base.value, form:form.value, mutationId:mutation.value, pendingSave:pendingSave.value }); draftStatus.value='本机草稿已保留'; refreshDrafts() }
  catch { draftStatus.value='草稿保存失败，请勿关闭页面'; saveError.value='本机存储不可用或已满，请保存到 NAS，或复制正文备份。' }
}
function forgetDraft(key=draftKey.value) { try { if(key) localStorage.removeItem(key) } catch {} refreshDrafts() }
function canLeave() { if(saving.value) return false; persistDraft(); return !dirty.value || window.confirm(draftStatus.value.startsWith('草稿保存失败') ? '本机草稿保存失败，离开将丢失修改。建议取消并复制正文备份，仍要离开吗？' : '笔记尚未保存到 NAS。离开后可在本机草稿中继续，确定离开？') }
function newDraftKey() { return NOTE_DRAFT_PREFIX+encodeURIComponent(owner.value)+':'+newNoteMutation() }
watch(form,()=>{ if(dirty.value) { draftStatus.value='正在保留本机草稿…'; clearTimeout(timer); timer=setTimeout(persistDraft,300) } },{deep:true})
async function loadNotes(target=1) {
  const seq=++listSequence; loading.value=true; listError.value=''
  try { const result=(await api.blog.getPosts({keyword:keyword.value,category_id:category.value,tag_id:tag.value,page:target,pageSize})).data; if(seq!==listSequence || !mounted) return; notes.value=result.data; total.value=result.total; page.value=target }
  catch(error) { if(seq===listSequence) listError.value=errorMessage(error,'加载失败，已有列表已保留') }
  finally { if(seq===listSequence) loading.value=false }
}
async function loadMetadata() { try { const [c,t]=await Promise.all([api.blog.getAllCategories(),api.blog.getTags()]); if(!mounted) return; categories.value=c.data.data; tags.value=t.data.data } catch { toast.error('分类或标签加载失败，可稍后重试') } }
function filterNotes() { router.replace({query:{...route.query,q:keyword.value||undefined,category:category.value||undefined,tag:tag.value||undefined}}); loadNotes(1) }
function resetFilters() { keyword.value=''; category.value=''; tag.value=''; filterNotes() }
async function openNote(id, retry=false) {
  if(!retry && !canLeave()) return
  const seq=++detailSequence; pane.value='read'; detailLoading.value=true; detailError.value=''; selected.value=null; pendingDraft.value=null; requestedId.value=id; conflict.value=null; saveError.value=''
  router.replace({query:{...route.query,note:String(id)}})
  try { const result=(await api.blog.getPost(id)).data.data; if(seq!==detailSequence || !mounted) return; selected.value=result; pendingDraft.value=drafts.value.find(d=>d.noteId===result.id)||null }
  catch(error) { if(seq===detailSequence) detailError.value=errorMessage(error,'打开失败，请重试') }
  finally { if(seq===detailSequence) detailLoading.value=false }
}
function startNew() { if(!canLeave()) return; ++detailSequence; detailLoading.value=false; detailError.value=''; editingId.value=null; selected.value=null; form.value=noteForm(); base.value=noteForm(); baseRevision.value=0; initEditor(); router.replace({query:{...route.query,note:undefined,postId:undefined}}) }
function initEditor() { pane.value='edit'; preview.value=false; showMeta.value=false; conflict.value=null; pendingDraft.value=null; saveError.value=''; draftKey.value=newDraftKey(); mutation.value=newNoteMutation(); pendingSave.value=null; draftStatus.value='未保存' }
function editSelected() { if(!selected.value) return; if(pendingDraft.value) { resumeDraft(pendingDraft.value); return } editingId.value=selected.value.id; form.value=noteForm(selected.value); base.value=noteForm(selected.value); baseRevision.value=selected.value.revision; initEditor() }
function resumeDraft(draft) { if(!canLeave()) return; ++detailSequence; detailLoading.value=false; detailError.value=''; editingId.value=draft.noteId; form.value=noteForm(draft.form); base.value=noteForm(draft.base); baseRevision.value=draft.baseRevision; pane.value='edit'; draftKey.value=draft.key; mutation.value=draft.mutationId; pendingSave.value=draft.pendingSave||null; draftStatus.value='本机草稿已恢复'; pendingDraft.value=null; conflict.value=null; saveError.value=''; preview.value=false; showMeta.value=false; router.replace({query:{...route.query,note:draft.noteId ? String(draft.noteId) : undefined}}) }
function discardDraft(draft) { if(!window.confirm('仅丢弃这份本机草稿，不影响 NAS 上已保存的笔记，确定吗？')) return; forgetDraft(draft.key); pendingDraft.value=null }
async function saveNote() {
  if(saving.value || pane.value!=='edit' || conflict.value || pendingDraft.value) return
  if(!form.value.title.trim()) { saveError.value='请填写笔记标题'; return }
  saving.value=true; saveError.value=''
  const submitted=noteForm(form.value)
  if(!pendingSave.value || !sameNote(pendingSave.value,submitted)) pendingSave.value={...submitted,baseRevision:baseRevision.value,mutationId: editingId.value ? newNoteMutation() : mutation.value}
  persistDraft()
  const request=pendingSave.value, ownKey=draftKey.value
  try {
    const response=editingId.value ? await api.blog.updatePost(editingId.value,request) : await api.blog.createPost(request)
    if(!mounted || owner.value==null) return
    const saved=response.data.data; selected.value=saved; editingId.value=saved.id; baseRevision.value=saved.revision; base.value=noteForm(saved)
    if(sameNote(form.value,submitted)) { form.value=noteForm(saved); forgetDraft(ownKey) }
    pendingSave.value=null; draftStatus.value='已保存到 NAS'; toast.success('笔记已保存'); loadNotes(page.value); loadMetadata(); router.replace({query:{...route.query,note:String(saved.id)}})
  } catch(error) { if(!mounted || owner.value==null) return; saveError.value=errorMessage(error,'保存失败，本机内容已保留，请重试'); if(error.response?.status===409) conflict.value=error.response.data.current; persistDraft() }
  finally { saving.value=false }
}
function saveCopy() { editingId.value=null; baseRevision.value=0; mutation.value=newNoteMutation(); pendingSave.value=null; conflict.value=null; form.value.title += '（副本）'; saveNote() }
function useServerVersion() { if(!window.confirm('使用 NAS 最新版本会丢弃当前本机修改，确定吗？')) return; const server=conflict.value; forgetDraft(); selected.value=server; editingId.value=server.id; form.value=noteForm(server); base.value=noteForm(server); baseRevision.value=server.revision; initEditor() }
function closePane() { if(!canLeave()) return; ++detailSequence; pane.value='list'; selected.value=null; router.replace({query:{...route.query,note:undefined,postId:undefined}}) }
async function deleteSelected() { if(!selected.value || !window.confirm('将这篇笔记移入回收站？正文与标签可恢复。')) return; try { await api.blog.deletePost(selected.value.id); pane.value='list'; selected.value=null; router.replace({query:{...route.query,note:undefined,postId:undefined}}); await loadNotes(1); loadMetadata(); toast.success('已移入回收站') } catch(error) { toast.error(errorMessage(error,'删除失败')) } }
function goTrash() { if(canLeave()) { pane.value='list'; router.push({path:'/trash',query:{type:'note'}}) } }
async function saveCategory() { if(categorySaving.value) return; categorySaving.value=true; try { editingCategory.value ? await api.blog.updateCategory(editingCategory.value.id,{name:categoryName.value}) : await api.blog.createCategory({name:categoryName.value}); categoryName.value=''; editingCategory.value=null; await loadMetadata(); loadNotes(page.value) } catch(error) { toast.error(errorMessage(error,'分类保存失败')) } finally {categorySaving.value=false} }
async function deleteCategory(cat) { if(!window.confirm('删除分类“'+cat.name+'”？笔记将归入未分类，正文不会删除。')) return; try { await api.blog.deleteCategory(cat.id); if(category.value===String(cat.id)) category.value=''; await loadMetadata(); loadNotes(1) } catch(error) { toast.error(errorMessage(error,'分类删除失败')) } }
function beforeUnload(event) { persistDraft(); if(dirty.value) { event.preventDefault(); event.returnValue='' } }
onBeforeRouteLeave(()=>canLeave())
onBeforeRouteUpdate(to => {
  const id=to.query.note || to.query.postId
  if (String(id || '')!==String(visibleNoteId.value || '')) return canLeave()
  return true
})
watch(() => [route.query.note, route.query.postId], ([note, post]) => {
  const id=note || post
  if(id && String(id)!==String(visibleNoteId.value)) openNote(id,true)
  else if(!id && visibleNoteId.value!=null) { ++detailSequence; pane.value='list'; selected.value=null }
})
watch(() => [route.query.q,route.query.category,route.query.tag], ([q,c,t]) => {
  if(keyword.value===String(q||'') && category.value===String(c||'') && tag.value===String(t||'')) return
  keyword.value=String(q||''); category.value=String(c||''); tag.value=String(t||''); loadNotes(1)
})
onMounted(()=>{ refreshDrafts(); loadNotes(); loadMetadata(); const id=route.query.note || route.query.postId; if(id) openNote(id,true); window.addEventListener('beforeunload',beforeUnload); window.addEventListener('pagehide',persistDraft); window.addEventListener('storage',refreshDrafts) })
watch(owner,value=>{ if(value==null) { clearTimeout(timer); ++detailSequence; ++listSequence; form.value=noteForm(); base.value=noteForm(); selected.value=null; pane.value='list'; drafts.value=[] } })
onBeforeUnmount(()=>{ persistDraft(); mounted=false; ++listSequence; ++detailSequence; clearTimeout(timer); window.removeEventListener('beforeunload',beforeUnload); window.removeEventListener('pagehide',persistDraft); window.removeEventListener('storage',refreshDrafts) })
</script>

<style scoped>
.notes-workspace{display:grid;grid-template-columns:minmax(280px,340px) minmax(0,1fr);min-height:calc(100dvh - 130px);gap:24px;color:var(--color-text-primary)}
.note-library,.note-content{min-width:0}.note-library{border-right:1px solid var(--color-border-subtle);padding-right:20px}.note-search,.note-filters,.note-library-tools,.note-header-actions,.note-content-header,.note-editor-meta,.note-category-create,.note-category-row{display:flex;align-items:center;gap:8px}.note-search .native-input-wrapper{flex:1;min-width:0}.note-filters{margin:12px 0}.note-filters>*{flex:1;min-width:0}.note-library-tools{justify-content:space-between;margin:16px 0;color:var(--color-text-secondary);font-size:12px}.note-library-tools>div{display:flex}.note-rows{display:flex;flex-direction:column;gap:3px}.note-row{border:0;background:transparent;text-align:left;padding:16px 12px;width:100%;border-radius:8px;color:inherit;cursor:pointer;transition:background .15s}.note-row:hover{background:var(--color-surface-subtle)}.note-row.selected{background:var(--color-primary-surface);box-shadow:inset 3px 0 var(--color-primary)}.note-row-heading{display:flex;gap:6px;align-items:center}.note-row-heading strong{font-size:15px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.note-pin{font-size:11px;color:var(--color-primary);white-space:nowrap}.note-row p{font-size:13px;line-height:1.65;color:var(--color-text-secondary);margin:7px 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.note-row-meta{display:flex;justify-content:space-between;font-size:11px;color:var(--color-text-secondary);gap:8px}.note-row-tags,.note-read-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.note-row-tags span,.note-read-tags span{font-size:11px;color:var(--color-text-secondary);background:var(--color-surface-subtle);padding:2px 6px;border-radius:4px;overflow-wrap:anywhere}.note-pages{display:flex;align-items:center;justify-content:center;font-size:12px;gap:10px;padding:16px 0}.note-empty{text-align:center;color:var(--color-text-secondary);padding:48px 12px;font-size:14px}.note-welcome{padding-top:22vh}.note-welcome h2{font-size:20px;color:var(--color-text-primary);font-weight:600}.note-content{background:var(--color-surface-raised);border-radius:10px;overflow:hidden}.note-content-header{padding:12px 16px;border-bottom:1px solid var(--color-border-subtle);min-height:60px}.note-header-actions{margin-left:auto}.note-save-state{font-size:12px;color:var(--color-text-secondary)}.note-article{max-width:840px;margin:auto;padding:36px 48px 64px;overflow-wrap:anywhere}.note-article h1{font-size:28px;line-height:1.4;margin:14px 0;font-weight:650}.note-article-meta{font-size:12px;color:var(--color-text-secondary)}.note-read-tags{margin-bottom:24px}.note-editor{padding:24px;display:flex;flex-direction:column}.note-title-input{border:0;background:transparent;color:inherit;font-size:26px;font-weight:600;width:100%;padding:8px 0;outline-offset:3px}.note-editor-meta{margin:12px 0}.note-editor-meta>.native-select{width:200px;max-width:60%}.note-meta-toggle{background:none;border:0;color:var(--color-text-secondary);cursor:pointer;font-size:13px;display:flex;align-items:center;gap:6px}.note-editor-options{display:grid;gap:10px;margin-bottom:16px}.note-tag-suggestions{display:flex;gap:6px;flex-wrap:wrap}.note-tag-suggestions button{font-size:12px;background:var(--color-surface-subtle);color:var(--color-text-secondary);border:0;border-radius:4px;padding:5px 8px;cursor:pointer}.note-md-editor{height:calc(100dvh - 340px);min-height:330px;--md-bk-color:var(--color-surface-raised);--md-color:var(--color-text-primary);border-color:var(--color-border-subtle)}.note-editor-footer{display:flex;justify-content:space-between;color:var(--color-text-secondary);font-size:11px;margin-top:10px}.note-edit-preview{min-height:330px}.note-message,.note-conflict{margin:12px;padding:12px;background:var(--color-surface-subtle);border:1px solid var(--color-border-subtle);border-radius:6px;font-size:13px;line-height:1.7;overflow-wrap:anywhere}.note-conflict pre{white-space:pre-wrap;max-height:180px;overflow:auto;background:var(--color-surface-raised);padding:12px}.note-conflict>div{display:flex;gap:8px;margin-top:8px}.note-drafts{padding:12px;border:1px dashed var(--color-border-subtle);border-radius:6px;margin-bottom:12px;font-size:12px}.note-drafts small{display:block;color:var(--color-text-secondary);margin:5px 0}.note-drafts>div{display:flex;align-items:center;gap:6px}.draft-open{flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;background:transparent;color:var(--color-primary);padding:8px 0;cursor:pointer}.icon-button{display:grid;place-items:center;width:32px;height:32px;background:none;border:0;color:var(--color-text-secondary);cursor:pointer}.note-category-create{margin:12px 0}.note-category-create>.native-input-wrapper{flex:1}.note-category-row{border-bottom:1px solid var(--color-border-subtle);padding:10px 0}.note-category-row>span{flex:1;overflow-wrap:anywhere}.note-category-row small,.note-help{font-size:12px;color:var(--color-text-secondary)}.note-skeleton>div{padding:20px 12px}.note-skeleton i{display:block;height:14px;background:var(--color-surface-subtle);margin-bottom:10px;border-radius:4px}.note-skeleton i:last-child{width:70%;height:32px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
@media(min-width:1600px){.notes-workspace{grid-template-columns:380px minmax(0,1fr)}}
@media(max-width:768px){.notes-workspace{display:block;min-height:0}.note-library{padding:0;border:0}.note-row{padding:16px 4px;border-bottom:1px solid var(--color-border-subtle);border-radius:0}.note-row-heading strong{font-size:16px}.note-row-meta{font-size:12px}.note-search button{min-height:44px;min-width:44px}.note-content{position:fixed;inset:0;z-index:450;display:flex;flex-direction:column;border-radius:0;height:100dvh;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);overflow:auto}.note-content-header{position:sticky;top:0;background:var(--color-surface-raised);z-index:2;padding:6px 8px;flex-shrink:0;gap:4px}.note-content-header button{min-height:44px}.note-save-state{font-size:11px;max-width:30%;line-height:1.5}.note-header-actions{gap:2px}.note-header-actions button{padding:6px 10px}.note-article{padding:24px 20px 56px;margin:0}.note-article h1{font-size:23px}.note-editor{padding:12px;flex:1;min-height:0}.note-title-input{font-size:22px}.note-md-editor{height:auto;min-height:200px;flex:1}.note-editor-footer{padding-bottom:6px}.note-content-edit>.note-message,.note-content-edit>.note-conflict{flex-shrink:0}.note-drafts .icon-button{width:44px;height:44px}.note-tag-suggestions button{min-height:36px}.note-message{margin:8px;font-size:12px}.note-library-tools{margin:12px 0}}
@media(prefers-reduced-motion:reduce){.note-row{transition:none}}
.note-meta-toggle{white-space:nowrap;flex-shrink:0}.note-editor-meta :deep(.native-select){max-width:260px;width:100%}
.note-article :deep(.md-editor){--md-bk-color:transparent;--md-color:var(--color-text-primary)}.note-article :deep(.md-editor-preview-wrapper){padding:0}.note-content button:focus-visible,.note-row:focus-visible,.draft-open:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}
@media(min-width:769px){.notes-workspace{height:calc(100dvh - 130px);min-height:0}.note-library{overflow:auto;scrollbar-width:thin}.note-content{overflow:auto;scrollbar-width:thin}.note-content-header{position:sticky;top:0;background:var(--color-surface-raised);z-index:2}}
</style>
