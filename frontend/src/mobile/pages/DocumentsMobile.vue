<template>
  <div id="mobile-documents-host" class="mobile-documents">
    <!-- 顶部导航栏（标题由Layout统一提供，此处不再重复） -->

    <div class="mobile-search-actions">
      <NativeInput
        v-model="searchKeyword"
        class="search-bar"
        placeholder="搜索标题或标签"
        clearable
        @clear="handleSearch"
        @enter="handleSearch"
      >
        <template #suffix>
          <NativeIcon name="magnifying-glass" />
        </template>
      </NativeInput>
      <NativeButton class="mobile-upload-button" theme="primary" @click="openUploadDialog" :disabled="!canWrite">
        <template #icon><NativeIcon name="plus" /></template>
        上传文档
      </NativeButton>
      <input
        ref="uploadInput"
        type="file"
        class="mobile-upload-input"
        accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.xls,.xlsx,.csv,.jpg,.jpeg,.png,.gif,.bmp"
        @change="handleMobileFileChange"
      />
    </div>

    <div class="mobile-browse-toolbar">
      <button
        type="button"
        class="mobile-category-filter"
        aria-haspopup="dialog"
        :aria-expanded="categoryPickerVisible"
        @click="openCategoryPicker"
      >
        <span class="mobile-category-filter__icon"><NativeIcon :name="currentCategoryId ? 'folder-open' : 'folder'" size="20" /></span>
        <span class="mobile-category-filter__copy">
          <strong>{{ currentCategoryName || '全部文档' }}</strong>
          <small>{{ currentCategoryPathLabel || '选择分类筛选文档' }}</small>
        </span>
        <NativeIcon name="chevron-down" size="16" />
      </button>
      <NativeButton
        class="mobile-trash-button"
        variant="outline"
        shape="circle"
        title="文档回收站"
        aria-label="打开文档回收站"
        @click="openTrashPage"
      >
        <template #icon><NativeIcon name="trash" /></template>
      </NativeButton>
    </div>

    <!-- 移动端最小上传对话框 -->
    <NativeDialog
      v-model="uploadDialogVisible"
      title="上传文档"
      @confirm="handleUpload"
      :show-close="true"
      :confirm-loading="uploading"
      :confirm-disabled="uploading || !canWrite"
      class="centered-dialog"
    >
      <NativeForm class="mobile-upload-form">
        <NativeFormItem label="文件" required>
          <NativeButton class="mobile-file-picker" variant="outline" @click="openFilePicker" :disabled="uploading">
            <template #icon><NativeIcon name="upload" /></template>
            {{ uploadFiles[0]?.name || '选择文件' }}
          </NativeButton>
        </NativeFormItem>
        <NativeFormItem label="标题" required><NativeInput v-model="uploadForm.title" placeholder="文档标题" :disabled="uploading" /></NativeFormItem>
        <NativeFormItem label="分类">
          <NativeSelect
            v-model="uploadForm.categoryId"
            placeholder="选择分类"
            filter-placeholder="搜索分类"
            :options="categoryOptions"
            clearable
            filterable
            :disabled="uploading"
          />
        </NativeFormItem>
        <NativeFormItem label="标签"><NativeInput v-model="uploadForm.tags" placeholder="用逗号分隔" :disabled="uploading" /></NativeFormItem>
        <NativeFormItem label="版本说明"><NativeInput v-model="uploadForm.versionNote" placeholder="可选" :disabled="uploading" /></NativeFormItem>
      </NativeForm>
    </NativeDialog>

    <!-- 上传冲突对话框：两端使用同一组显式决策 -->
    <NativeDialog
      v-model="uploadConflictDialogVisible"
      title="上传冲突"
      :show-footer="false"
      class="centered-dialog"
    >
      <NativeAlert theme="warning" title="检测到同名文档">
        {{ uploadConflict?.message || '请选择处理方式，系统不会自动改名或合并。' }}
      </NativeAlert>
      <p class="upload-conflict-suggestion">
        建议标题：<strong>{{ uploadConflict?.suggestedTitle || '-' }}</strong>
      </p>
      <div class="upload-conflict-candidates">
        <label
          v-for="candidate in uploadConflict?.candidates || []"
          :key="candidate.id"
          class="upload-conflict-candidate"
          :class="{ 'hash-match': candidate.hashMatches }"
        >
          <input
            v-model="selectedUploadConflictCandidateId"
            type="radio"
            name="mobile-upload-conflict-candidate"
            :value="candidate.id"
            :disabled="candidate.hashMatches || uploading"
          />
          <span class="upload-conflict-candidate-body">
            <strong>{{ candidate.title }}</strong>
            <span>分类：{{ candidate.categoryPath || '未分类' }}</span>
            <span>当前版本：{{ candidate.currentVersion ?? '-' }}</span>
            <span>更新时间：{{ formatDateTime(candidate.updatedAt) }}</span>
            <span>内容大小：{{ formatFileSize(candidate.contentBytes) }}</span>
            <span v-if="candidate.hashMatches" class="upload-conflict-hash-match">
              hashMatches：是；内容相同，不能作为新版本
            </span>
            <span v-else>hashMatches：否</span>
          </span>
        </label>
      </div>
      <div class="upload-conflict-actions">
        <NativeButton variant="outline" @click="cancelUploadConflict" :disabled="uploading">取消</NativeButton>
        <NativeButton theme="primary" @click="retryUploadAsNewDocument" :disabled="!canWrite || uploading || !uploadConflict?.suggestedTitle">
          使用建议标题另建
        </NativeButton>
        <NativeButton
          theme="primary"
          variant="outline"
          @click="retryUploadAsCandidateVersion"
          :disabled="!canWrite || uploading || !selectedUploadConflictCandidate || selectedUploadConflictCandidate.hashMatches"
        >
          选择候选作为新版本
        </NativeButton>
      </div>
    </NativeDialog>

    <!-- 分类选择器：分类树留在底部弹层中，不占用文档列表的纵向空间。 -->
    <div v-if="categoryPickerVisible" class="native-action-overlay" @click.self="closeCategoryPicker">
      <section class="native-action-sheet category-picker-sheet" role="dialog" aria-modal="true" aria-label="选择文档分类">
        <div class="action-sheet-handle" aria-hidden="true"></div>
        <header class="category-picker-header">
          <span><strong>选择分类</strong><small>父分类与子分类按层级统一显示</small></span>
          <button type="button" aria-label="关闭分类选择器" @click="closeCategoryPicker"><NativeIcon name="x" size="20" /></button>
        </header>
        <NativeAlert v-if="categoriesError" theme="error" title="分类加载失败" class="category-picker-error">
          <NativeButton size="small" variant="outline" @click="loadCategories">重试</NativeButton>
        </NativeAlert>
        <div v-else class="category-picker-list">
          <button
            type="button"
            class="category-picker-all"
            :class="{ selected: !currentCategoryId }"
            @click="clearCategoryFilter"
          >
            <span class="category-picker-row-icon"><NativeIcon name="files" size="19" /></span>
            <span><strong>全部文档</strong><small>不限制分类</small></span>
            <NativeIcon v-if="!currentCategoryId" name="check" size="18" />
          </button>
          <div v-if="categories.length === 0" class="category-picker-empty">还没有分类</div>
          <div
            v-for="row in categoryPickerRows"
            :key="row.category.id"
            class="category-picker-row"
            :class="{ selected: String(row.category.id) === String(currentCategoryId) }"
            :style="{ '--category-depth': row.depth }"
          >
            <button
              v-if="row.hasChildren"
              type="button"
              class="category-picker-disclosure"
              :aria-label="`${row.expanded ? '收起' : '展开'} ${row.category.name}`"
              :aria-expanded="row.expanded"
              @click="toggleCategoryPickerRow(row.category.id)"
            >
              <NativeIcon :name="row.expanded ? 'chevron-down' : 'chevron-right'" size="15" />
            </button>
            <span v-else class="category-picker-disclosure-spacer" aria-hidden="true"></span>
            <button type="button" class="category-picker-option" @click="selectCategoryFromPicker(row.category)">
              <span class="category-picker-row-icon"><NativeIcon :name="row.expanded ? 'folder-open' : 'folder'" size="19" /></span>
              <span><strong>{{ row.category.name }}</strong><small>{{ Number(row.category.fileCount) || 0 }} 个文档</small></span>
              <NativeIcon v-if="String(row.category.id) === String(currentCategoryId)" name="check" size="18" />
            </button>
          </div>
        </div>
      </section>
    </div>

    <div class="documents-section" v-if="!loading || documents.length > 0">
      <NativeAlert v-if="documentsError" theme="error" title="文档加载失败" class="mobile-document-error">
        <span>{{ documentsError }}</span>
        <NativeButton size="small" variant="outline" @click="loadDocuments">重试</NativeButton>
      </NativeAlert>

      <div class="section-title" v-if="documents.length > 0">
        {{ viewMode === 'category' && currentCategoryName ? currentCategoryName : '所有文件' }}
        <span class="count">({{ total }})</span>
      </div>
      
       <div class="document-list">
         <div
           v-for="doc in documents"
           :key="doc.id"
           class="document-item"
           :class="{ 'guest-mode': isGuest, 'previewing': isPreviewing(doc.id) }"
         >
           <button
             type="button"
             class="document-open-target"
             :aria-label="`预览 ${getFileNameWithExt(doc)}`"
             @click="previewDocument(doc)"
           >
             <!-- 文件图标 -->
             <div class="file-icon" :class="`document-type-icon--${documentFileTone(doc.filePath)}`">
               <NativeIcon :name="documentFileIcon(doc.filePath)" size="24" />
             </div>

             <!-- 文件信息 -->
             <div class="file-info">
               <div class="file-name">{{ getFileNameWithExt(doc) }}</div>
               <div class="file-meta">
                 <span class="file-size">{{ formatFileSize(doc.size) }}</span>
                 <span class="divider">|</span>
                 <span class="file-date">{{ formatDate(doc.updatedAt) }}</span>
                 <NativeTag :theme="ragStatusTheme(doc.indexStatus)" size="small" variant="light">
                   {{ ragStatusLabel(doc.indexStatus) }}
                 </NativeTag>
               </div>
               <div class="file-tags-row" v-if="doc.tags">
                 <NativeTag v-for="tag in visibleTags(doc.tags)" :key="tag" size="small" variant="light" theme="primary">
                   {{ tag }}
                 </NativeTag>
                 <span v-if="hiddenTagCount(doc.tags)" class="file-tags-more">+{{ hiddenTagCount(doc.tags) }}</span>
               </div>
             </div>
           </button>
          
          <!-- 预览loading转圈 -->
          <div v-if="isPreviewing(doc.id)" class="item-loading-spinner">
            <NativeLoading size="small" />
          </div>
          
          <button v-if="!isGuest && !isPreviewing(doc.id)" type="button" class="action-menu"
            :aria-label="`打开 ${getFileNameWithExt(doc)} 的操作菜单`"
            @click.stop.prevent="showActionMenu(doc)"
          >
            <NativeIcon name="ellipsis" size="22" />
          </button>
        </div>
      </div>
      
      <!-- 移动端使用连续列表分页，保留阅读位置且不产生数字分页跳转。 -->
      <div v-if="documents.length > 0" class="mobile-list-pagination" :class="{ 'mobile-list-pagination--complete': !hasMore }" aria-live="polite">
        <span v-if="!hasMore" class="mobile-list-pagination__complete">
          <NativeIcon name="check" size="14" />
          已显示全部 {{ total }} 项
        </span>
        <div v-else class="mobile-list-pagination__status">
          <span>已显示 {{ documents.length }} / {{ total }}</span>
          <span>还剩 {{ Math.max(0, total - documents.length) }} 项</span>
        </div>
        <NativeButton v-if="hasMore" variant="outline" size="small" @click="loadMore" :loading="loading">
          加载下一批
        </NativeButton>
      </div>
      
      <!-- 空状态 -->
      <div v-if="documents.length === 0 && !loading" class="empty-state">
        <NativeIcon name="file" size="48" />
        <p>暂无文档</p>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading && documents.length === 0" class="loading-state">
      <NativeLoading size="medium" />
    </div>

    <!-- 操作菜单弹窗（底部弹出菜单） -->
    <div v-if="actionMenuVisible" class="native-action-overlay" @click.self="closeActionMenu">
      <div class="native-action-sheet" role="dialog" aria-modal="true" aria-label="文档操作">
        <div class="action-sheet-handle" aria-hidden="true"></div>
        <div class="action-sheet-title">
          <span class="action-sheet-file-icon" :class="`document-type-icon--${documentFileTone(currentDoc?.filePath)}`">
            <NativeIcon :name="documentFileIcon(currentDoc?.filePath)" size="20" />
          </span>
          <span><strong>{{ currentDoc ? getFileNameWithExt(currentDoc) : '文档操作' }}</strong><small>{{ formatFileSize(currentDoc?.size) }}</small></span>
        </div>
        <div class="action-sheet-list">
          <button type="button" class="action-sheet-item" @click="handleActionSelect({ value: 'download' })">
            <NativeIcon name="download" size="20" />
            <span><strong>下载原件</strong><small>保存当前版本</small></span>
          </button>
          <button type="button" class="action-sheet-item" @click="handleActionSelect({ value: 'versions' })">
            <NativeIcon name="history" size="20" />
            <span><strong>版本历史</strong><small>查看并下载旧版本</small></span>
          </button>
          <button type="button" class="action-sheet-item" @click="handleActionSelect({ value: 'edit' })">
            <NativeIcon name="pencil" size="20" />
            <span><strong>编辑信息</strong><small>修改分类与标签</small></span>
          </button>
          <button type="button" class="action-sheet-item delete" @click="handleDeleteClick">
            <NativeIcon name="trash" size="20" />
            <span><strong>移入回收站</strong><small>保护期内可以恢复</small></span>
          </button>
        </div>
        <button type="button" class="action-sheet-cancel" @click="closeActionMenu">
          <span>取消</span>
        </button>
      </div>
    </div>

    <!-- 单项信息编辑弹窗 -->
    <NativeDialog
      v-model="batchEditDialogVisible"
      title="编辑文档信息"
      :show-close="true"
      :close-on-overlay-click="true"
      class="centered-dialog"
    >
      <NativeForm class="edit-form">
        <NativeFormItem label="分类">
          <NativeSelect
            v-model="batchEditForm.categoryId"
            placeholder="选择分类"
            filter-placeholder="搜索分类"
            :options="categoryOptions"
            clearable
            filterable
          />
        </NativeFormItem>
        <NativeFormItem label="标签"><NativeInput v-model="batchEditForm.tags" placeholder="用逗号分隔" /></NativeFormItem>
      </NativeForm>
      <template #footer>
        <div class="dialog-footer-btns">
          <NativeButton variant="outline" @click="batchEditDialogVisible = false">取消</NativeButton>
          <NativeButton theme="primary" @click="handleSingleEditConfirm">确认</NativeButton>
        </div>
      </template>
    </NativeDialog>

    <!-- 版本历史弹窗 -->
    <NativeDialog v-model="versionsDialogVisible" title="版本历史" :show-footer="false" class="centered-dialog mobile-version-dialog">
      <div class="mobile-version-summary">
        <span class="mobile-version-summary__icon" :class="`document-type-icon--${documentFileTone(currentDoc?.filePath)}`">
          <NativeIcon :name="documentFileIcon(currentDoc?.filePath)" size="22" />
        </span>
        <span><strong>{{ currentDoc ? getFileNameWithExt(currentDoc) : '文档' }}</strong><small>共 {{ versions.length }} 个可下载版本</small></span>
      </div>
      <div class="versions-list">
        <article v-for="ver in versions" :key="ver.id" class="version-item" :class="{ 'version-item--current': ver.isCurrent }">
          <span class="version-timeline-marker" aria-hidden="true"><NativeIcon :name="ver.isCurrent ? 'check' : 'history'" size="15" /></span>
          <div class="version-info">
            <div class="version-header">
              <span class="version-num">v{{ ver.version }}</span>
              <NativeTag :theme="ver.isCurrent ? 'success' : 'default'" size="small" variant="light">
                {{ ver.isCurrent ? '当前版本' : '历史版本' }}
              </NativeTag>
            </div>
            <div class="version-meta">
              <span>{{ formatDateTime(ver.createdAt) }}</span>
              <span>{{ formatFileSize(ver.contentBytes) }}</span>
            </div>
            <p class="version-note">{{ ver.note || '未填写版本说明' }}</p>
          </div>
          <NativeButton class="version-download-button" variant="outline" shape="circle" :aria-label="`下载版本 v${ver.version}`" @click.stop="handleDownloadVersion(ver)">
            <template #icon><NativeIcon name="download" size="18" /></template>
          </NativeButton>
        </article>
        <div v-if="versions.length === 0" class="version-empty-state">
          <span><NativeIcon name="archive" size="28" /></span>
          <strong>暂无历史版本</strong>
          <small>上传新版本后，可在这里查看并下载旧版本。</small>
        </div>
      </div>
    </NativeDialog>

    <!-- 删除确认弹窗 -->
    <NativeDialog
      v-model="deleteConfirmVisible"
      title="移入回收站"
      :confirm-btn="{ content: '移入回收站', theme: 'danger' }"
      @confirm="confirmDelete"
      class="centered-dialog"
    >
        <div class="delete-confirm-content">
          <p>确定要将「{{ currentDoc?.title }}」移入回收站吗？</p>
          <p class="delete-warning">保护期内可以恢复，原件不会立即永久删除。</p>
        </div>
    </NativeDialog>

    <!-- 文件预览弹窗（原生全屏方案，最大化显示面积） -->
    <div v-if="previewDialogVisible" class="native-preview-overlay" @click.self="closePreview">
      <div class="native-preview-container" role="dialog" aria-modal="true" :aria-label="`预览 ${previewFileName}`">
        <!-- 头部标题栏 -->
        <div class="native-preview-header">
          <span class="preview-title">{{ previewFileName }}</span>
          <div class="preview-header-actions">
            <button v-if="!isGuest" type="button" class="preview-header-button" aria-label="下载原件" @click="handleDownloadFile">
              <NativeIcon name="download" size="20" />
            </button>
            <button type="button" class="preview-header-button preview-close" aria-label="关闭预览" @click="closePreview">
              <NativeIcon name="x" size="20" />
            </button>
          </div>
        </div>
        <!-- 内容区 -->
        <div
          v-if="!previewLoading"
          ref="previewScrollSurface"
          class="native-preview-body"
          :class="{ 'native-preview-body--pdf': previewType === 'pdf' }"
        >
        <div v-if="previewError" class="mobile-preview-error">
          <NativeIcon name="warning" size="36" />
          <strong>暂时无法预览</strong>
          <p>{{ previewError }}</p>
          <div>
            <NativeButton variant="outline" @click="previewDocument(currentDoc)">重新加载</NativeButton>
            <NativeButton v-if="!isGuest" theme="primary" @click="handleDownloadFile">下载原件</NativeButton>
          </div>
        </div>
        <!-- PDF预览 -->
        <div v-else-if="previewType === 'pdf'" class="pdf-preview">
          <div ref="pdfCanvasStage" class="pdf-canvas-stage"><canvas ref="pdfCanvas"></canvas></div>
          <div class="pdf-controls" aria-label="PDF 页面导航">
            <NativeButton class="pdf-page-button" size="small" variant="outline" @click="prevPage" :disabled="currentPage <= 1">
              <NativeIcon name="chevron-left" size="15" />
            </NativeButton>
            <span>第 {{ currentPage }} / {{ totalPages }} 页</span>
            <NativeButton class="pdf-page-button" size="small" variant="outline" @click="nextPage" :disabled="currentPage >= totalPages">
              <NativeIcon name="chevron-right" size="15" />
            </NativeButton>
          </div>
        </div>

        <!-- Markdown预览 -->
        <MdPreview
          v-else-if="previewType === 'markdown'"
          :modelValue="previewContent"
          :sanitize="sanitizeRichHtml"
          :previewTheme="'default'"
          class="mobile-md-preview"
        />

        <!-- 代码预览 -->
        <div v-else-if="previewType === 'code'" class="code-preview">
          <pre><code v-html="highlightedCode" :class="`language-${previewLanguage}`"></code></pre>
        </div>

        <!-- 文本预览 -->
        <div v-else-if="previewType === 'text'" class="text-preview"><pre>{{ previewContent }}</pre></div>

        <!-- 图片预览 -->
        <img
          v-else-if="previewType === 'image'"
          :src="previewIsBase64 ? 'data:image/' + getImageMimeType(previewFileName) + ';base64,' + previewContent : previewImageUrl"
          class="image-preview-content"
          :alt="previewFileName"
        />

        <!-- Word HTML预览 -->
        <div v-else-if="previewType === 'word-html'" class="word-html-preview">
          <div class="office-content" v-html="sanitizedPreviewContent"></div>
        </div>

        <!-- Office文档不支持预览提示 -->
        <div v-else-if="previewType === 'office'" class="office-preview">
          <NativeIcon :name="getOfficeIconName(previewLanguage)" size="48" />
          <h3>{{ getOfficeTypeLabel(previewLanguage) }}文档</h3>
          <p>此文件格式不支持在线预览</p>
          <NativeButton v-if="!isGuest" theme="primary" size="small" @click="handleDownloadFile">下载文件</NativeButton>
        </div>

        <!-- 不支持预览 -->
        <div v-else class="unsupported-preview">
          <p>此文件格式不支持在线预览</p>
        </div>
      </div>
      <!-- 加载中状态 -->
      <div v-if="previewLoading" class="loading-state preview-loading-state"><NativeLoading text="加载中..." /></div>
    </div>
    </div>

  </div>
</template>

<script setup>
import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import hljs from 'highlight.js'
import 'highlight.js/styles/atom-one-dark.css'
import mammoth from 'mammoth'
import api from '@/api'
import { authenticatedAssetUrl } from '@/utils/authentication'
import { normalizeDocumentTags } from '@/utils/documentTags'
import {
  documentDisplayFileName,
  documentFileIcon,
  documentFileTone,
  pruneDocumentPreviewPositions,
  updateDocumentPreviewPosition
} from '@/utils/documentWorkbench'
import { disposePdfDocument, openAuthenticatedPdfDocument } from '@/utils/pdfPreview'
import { usePermission } from '@/composables/usePermission'
import { acquireBodyScrollLock } from '@/composables/useModalFocus'
import { NativeAlert, NativeButton, NativeDialog, NativeForm, NativeFormItem, NativeIcon, NativeInput, NativeLoading, NativeSelect, NativeTag } from '@/components/native'
import { useToast } from '@/composables/useToast'
import {
  escapeHtml,
  sanitizeHighlightHtml,
  sanitizeRichHtml
} from '@/utils/sanitizeHtml'

const toast = useToast()
const route = useRoute()
const router = useRouter()
const { isGuest, canWrite } = usePermission()

// 状态定义
const loading = ref(false)
const documents = ref([])
const documentsError = ref('')
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const hasMore = computed(() => documents.value.length < total.value)

// 视图模式
const viewMode = ref('category') // category, list
const categories = ref([])
const categoriesError = ref('')
const ragStatusById = ref(new Map())
const ragCoverageComplete = ref(false)
const currentCategoryId = ref(null)
const categoryPath = ref([])
const categoryPickerVisible = ref(false)
const categoryPickerExpandedIds = ref(new Set())
const currentCategoryName = computed(() => {
  if (categoryPath.value.length === 0) return ''
  return categoryPath.value[categoryPath.value.length - 1].name
})
const currentCategoryPathLabel = computed(() => categoryPath.value.map(category => category.name).join(' / '))
const categoryPickerRows = computed(() => {
  const rows = []
  const append = (items, depth = 0) => {
    for (const category of items || []) {
      const hasChildren = Array.isArray(category.subcategories) && category.subcategories.length > 0
      const expanded = hasChildren && categoryPickerExpandedIds.value.has(String(category.id))
      rows.push({ category, depth, hasChildren, expanded })
      if (expanded) append(category.subcategories, depth + 1)
    }
  }
  append(categories.value)
  return rows
})

// 搜索
const searchKeyword = ref('')

// 当前操作文档
const currentDoc = ref(null)

// 操作菜单
const actionMenuVisible = ref(false)

// 上传
const uploadDialogVisible = ref(false)
const uploadFiles = ref([])
const uploading = ref(false)
const uploadInput = ref(null)
const uploadConflictDialogVisible = ref(false)
const uploadConflict = ref(null)
const selectedUploadConflictCandidateId = ref(null)
const uploadForm = ref({
  title: '',
  tags: '',
  categoryId: null,
  versionNote: ''
})
// 单项信息编辑
const batchEditDialogVisible = ref(false)
const batchEditForm = ref({
  categoryId: null,
  tags: ''
})

// 版本
const versions = ref([])
const versionsDialogVisible = ref(false)

// 预览
const previewDialogVisible = ref(false)
const previewLoading = ref(false)
const previewError = ref('')
const previewContent = ref('')
const previewIsBase64 = ref(false)
const previewType = ref('text')
const previewLanguage = ref('plaintext')
const previewFileName = ref('')
const previewImageUrl = ref('')
const previewScrollSurface = ref(null)

// 预览中的文档ID（用于条目loading效果）
const previewingDocIds = ref(new Set())

function isPreviewing(docId) {
  return previewingDocIds.value.has(docId)
}

// PDF预览状态
const pdfCanvas = ref(null)
const pdfCanvasStage = ref(null)
const pdfDoc = shallowRef(null)
const currentPage = ref(1)
const totalPages = ref(0)
let pdfRenderTask = null
let pdfRenderSequence = 0
let resizeTimer = null

const PREVIEW_POSITION_STORAGE_KEY = 'pr-manager:document-preview-position:v1'

// 代码高亮结果
const highlightedCode = computed(() => {
  if (!previewContent.value || previewType.value !== 'code') return ''
  try {
    if (previewLanguage.value && hljs.getLanguage(previewLanguage.value)) {
      return sanitizeHighlightHtml(
        hljs.highlight(previewContent.value, {
          language: previewLanguage.value
        }).value
      )
    }
    return sanitizeHighlightHtml(hljs.highlightAuto(previewContent.value).value)
  } catch (e) {
    return escapeHtml(previewContent.value)
  }
})

const sanitizedPreviewContent = computed(() =>
  sanitizeRichHtml(previewContent.value)
)

const selectedUploadConflictCandidate = computed(() => {
  const candidates = uploadConflict.value?.candidates || []
  return candidates.find(candidate => String(candidate.id) === String(selectedUploadConflictCandidateId.value)) || null
})

function previewPositionKey() {
  const document = currentDoc.value
  return document?.id ? `${document.id}:${document.version || 1}` : ''
}

function readPreviewPositionStore() {
  try {
    return pruneDocumentPreviewPositions(JSON.parse(localStorage.getItem(PREVIEW_POSITION_STORAGE_KEY) || '{}'))
  } catch {
    return {}
  }
}

function currentPreviewScrollElement() {
  return previewType.value === 'pdf' ? pdfCanvasStage.value : previewScrollSurface.value
}

function savedPreviewPosition() {
  const key = previewPositionKey()
  return key ? readPreviewPositionStore()[key] || null : null
}

function savePreviewPosition() {
  const key = previewPositionKey()
  if (!key || previewLoading.value) return
  const surface = currentPreviewScrollElement()
  try {
    localStorage.setItem(PREVIEW_POSITION_STORAGE_KEY, JSON.stringify(updateDocumentPreviewPosition(
      readPreviewPositionStore(),
      key,
      {
        type: previewType.value,
        page: currentPage.value,
        scrollTop: surface?.scrollTop || 0,
        scrollLeft: surface?.scrollLeft || 0
      }
    )))
  } catch {
    // 本地阅读位置属于增强能力，存储失败不阻断预览。
  }
}

async function restorePreviewPosition(position = savedPreviewPosition()) {
  if (!position) return
  await nextTick()
  currentPreviewScrollElement()?.scrollTo?.({
    top: Math.max(0, Number(position.scrollTop) || 0),
    left: Math.max(0, Number(position.scrollLeft) || 0),
    behavior: 'auto'
  })
}

// 方法定义

function openCategoryPicker() {
  const expanded = new Set(categoryPickerExpandedIds.value)
  for (const category of categoryPath.value.slice(0, -1)) expanded.add(String(category.id))
  categoryPickerExpandedIds.value = expanded
  categoryPickerVisible.value = true
}

function closeCategoryPicker() {
  categoryPickerVisible.value = false
}

function toggleCategoryPickerRow(categoryId) {
  const next = new Set(categoryPickerExpandedIds.value)
  const key = String(categoryId)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  categoryPickerExpandedIds.value = next
}

function selectCategoryFromPicker(category) {
  const trail = findCategoryTrail(categories.value, category.id)
  if (!trail?.length) return
  viewMode.value = 'category'
  categoryPath.value = trail
  currentCategoryId.value = category.id
  page.value = 1
  documents.value = []
  categoryPickerVisible.value = false
  syncMobileListRoute()
  void loadDocuments()
}

function clearCategoryFilter() {
  viewMode.value = 'list'
  currentCategoryId.value = null
  categoryPath.value = []
  page.value = 1
  documents.value = []
  categoryPickerVisible.value = false
  syncMobileListRoute()
  void loadDocuments()
}

function openTrashPage() {
  void router.push({ name: 'Trash', query: { type: 'document' } })
}

// 加载文档
async function loadDocuments() {
  loading.value = true
  documentsError.value = ''
  try {
    const params = {
      keyword: searchKeyword.value,
      page: page.value,
      pageSize: pageSize.value
    }
    
    if (currentCategoryId.value) {
      params.categoryId = currentCategoryId.value
      params.includeSubcategories = 'true'
    }
    
    const response = await api.documents.list(params)
    const data = (response.data?.data || []).map(document => ({
      ...document,
      indexStatus: ragStatusById.value.get(Number(document.id)) || (ragCoverageComplete.value ? 'missing' : 'unknown')
    }))
    total.value = response.data?.total || 0
    
    if (page.value === 1) {
      documents.value = data
    } else {
      documents.value.push(...data)
    }
    return true
  } catch (error) {
    console.error('加载文档失败:', error)
    documentsError.value = documentErrorMessage(error, '暂时无法加载文档，请稍后重试。')
    if (page.value === 1) documents.value = []
    return false
  } finally {
    loading.value = false
  }
}

// 加载分类
async function loadCategories() {
  categoriesError.value = ''
  try {
    const response = await api.documents.categories()
    categories.value = response.data?.data || []
  } catch (error) {
    console.error('加载分类失败:', error)
    categoriesError.value = documentErrorMessage(error, '暂时无法加载分类。')
    categories.value = []
  }
}

async function loadDocumentCoverage() {
  try {
    const response = await api.rag.coverage({ type: 'document', limit: 200 })
    const items = response.data?.data?.data || []
    ragStatusById.value = new Map(
      (Array.isArray(items) ? items : []).map(item => [Number(item.source?.id), item.status || 'missing'])
    )
    ragCoverageComplete.value = Number(response.data?.data?.total || items.length) <= items.length
  } catch {
    ragCoverageComplete.value = false
  }
}

// 搜索
function handleSearch() {
  page.value = 1
  documents.value = []
  syncMobileListRoute()
  void loadDocuments()
}

// 加载更多
async function loadMore() {
  if (loading.value || !hasMore.value) return
  const previousPage = page.value
  page.value = previousPage + 1
  const succeeded = await loadDocuments()
  if (!succeeded) page.value = previousPage
}

// 查找分类
function findCategoryById(categories, id) {
  for (const cat of categories) {
    if (String(cat.id) === String(id)) return cat
    if (cat.subcategories?.length) {
      const found = findCategoryById(cat.subcategories, id)
      if (found) return found
    }
  }
  return null
}

function findCategoryTrail(categoryItems, id, ancestors = []) {
  for (const category of categoryItems) {
    const trail = [...ancestors, category]
    if (String(category.id) === String(id)) return trail
    if (category.subcategories?.length) {
      const found = findCategoryTrail(category.subcategories, id, trail)
      if (found) return found
    }
  }
  return null
}

function routeQueryText(value) {
  if (Array.isArray(value)) return value[0] || ''
  return typeof value === 'string' ? value : ''
}

function syncMobileListRoute() {
  const nextQuery = { ...route.query }
  const keyword = searchKeyword.value.trim()
  if (keyword) nextQuery.q = keyword
  else delete nextQuery.q

  if (viewMode.value === 'list') nextQuery.view = 'all'
  else delete nextQuery.view

  if (viewMode.value === 'category' && currentCategoryId.value != null) {
    nextQuery.categoryId = String(currentCategoryId.value)
  } else {
    delete nextQuery.categoryId
  }
  void router.replace({ query: nextQuery })
}

// 预览类型判断函数
function getPreviewType(ext) {
  const markdownFiles = ['md', 'markdown', 'mdown', 'mkd']
  const codeFiles = {
    'js': 'javascript', 'ts': 'typescript', 'jsx': 'javascript', 'tsx': 'typescript',
    'py': 'python', 'java': 'java', 'c': 'c', 'cpp': 'cpp', 'h': 'c', 'hpp': 'cpp',
    'cs': 'csharp', 'go': 'go', 'rs': 'rust', 'rb': 'ruby', 'php': 'php',
    'swift': 'swift', 'kt': 'kotlin', 'scala': 'scala', 'sql': 'sql',
    'sh': 'bash', 'bash': 'bash', 'zsh': 'bash', 'fish': 'bash',
    'xml': 'xml', 'html': 'html', 'htm': 'html', 'css': 'css',
    'scss': 'scss', 'sass': 'sass', 'less': 'less',
    'json': 'json', 'yaml': 'yaml', 'yml': 'yaml', 'toml': 'toml',
    'ini': 'ini', 'conf': 'ini', 'cfg': 'ini'
  }

  if (ext === 'pdf') return { type: 'pdf', language: 'pdf' }
  else if (markdownFiles.includes(ext)) return { type: 'markdown', language: 'markdown' }
  else if (codeFiles[ext]) return { type: 'code', language: codeFiles[ext] }
  else if (['txt', 'log', 'csv', 'tsv'].includes(ext)) return { type: 'text', language: 'plaintext' }
  else if (['doc', 'docx'].includes(ext)) return { type: 'office', language: 'word' }
  else if (['ppt', 'pptx'].includes(ext)) return { type: 'office', language: 'ppt' }
  else if (['xls', 'xlsx'].includes(ext)) return { type: 'office', language: 'excel' }
  else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) return { type: 'image', language: 'image' }
  else return { type: 'unsupported', language: 'plaintext' }
}

// Office图标/标签工具函数
function getOfficeIconName(type) {
  const icons = { 'word': 'file-word', 'ppt': 'file-ppt', 'excel': 'file-excel' }
  return icons[type] || 'file'
}
function getOfficeTypeLabel(type) {
  const labels = { 'word': 'Word', 'ppt': 'PowerPoint', 'excel': 'Excel' }
  return labels[type] || 'Office'
}

// 加载Office文档内容
async function loadOfficeContent(base64Content, ext) {
  if (ext !== 'docx') {
    previewType.value = 'office'
    previewLoading.value = false
    return
  }

  try {
    const binaryString = atob(base64Content)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i)
    const arrayBuffer = bytes.buffer

    const result = await mammoth.convertToHtml({ arrayBuffer })
    previewContent.value = result.value
    previewType.value = 'word-html'
    previewLoading.value = false
  } catch (error) {
    console.error('加载Office文档失败:', error)
    previewType.value = 'office'
    previewLoading.value = false
  }
}

// PDF渲染相关函数
async function teardownPDFDocument() {
  pdfRenderSequence += 1
  pdfRenderTask?.cancel?.()
  pdfRenderTask = null
  const document = pdfDoc.value
  pdfDoc.value = null
  if (document) {
    try { await disposePdfDocument(document) } catch { /* Closing can race with a cancelled render. */ }
  }
}

async function loadPDFDocument(pdfData) {
  try {
    await teardownPDFDocument()
    pdfDoc.value = await openAuthenticatedPdfDocument(pdfData)
    totalPages.value = pdfDoc.value.numPages
  } catch (error) {
    console.error('PDF加载失败:', error)
    toast.error('PDF加载失败')
    previewLoading.value = false
    throw error
  }
}

async function renderPage(pageNum) {
  if (!pdfDoc.value || !pdfCanvas.value) return
  const sequence = ++pdfRenderSequence
  try {
    pdfRenderTask?.cancel?.()
    const page = await pdfDoc.value.getPage(pageNum)
    if (sequence !== pdfRenderSequence) return
    const canvas = pdfCanvas.value
    const ctx = canvas.getContext('2d')
    const baseViewport = page.getViewport({ scale: 1 })
    const stageWidth = pdfCanvasStage.value?.clientWidth || window.innerWidth
    const cssScale = Math.max(0.4, Math.min(2, (stageWidth - 24) / baseViewport.width))
    const viewport = page.getViewport({ scale: cssScale })
    const outputScale = Math.max(1, window.devicePixelRatio || 1)
    canvas.width = Math.floor(viewport.width * outputScale)
    canvas.height = Math.floor(viewport.height * outputScale)
    canvas.style.width = `${Math.floor(viewport.width)}px`
    canvas.style.height = `${Math.floor(viewport.height)}px`
    pdfRenderTask = page.render({
      canvasContext: ctx,
      viewport,
      transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
    })
    await pdfRenderTask.promise
  } catch (e) {
    if (e?.name === 'RenderingCancelledException') return
    console.error('渲染页面失败:', e)
  } finally {
    if (sequence === pdfRenderSequence) pdfRenderTask = null
  }
}

async function changePdfPage(nextPage) {
  if (!pdfDoc.value) return
  currentPage.value = Math.min(totalPages.value, Math.max(1, nextPage))
  await nextTick()
  await renderPage(currentPage.value)
  pdfCanvasStage.value?.scrollTo?.({ top: 0, left: 0, behavior: 'auto' })
}

function prevPage() {
  if (currentPage.value > 1) void changePdfPage(currentPage.value - 1)
}
function nextPage() {
  if (currentPage.value < totalPages.value) void changePdfPage(currentPage.value + 1)
}

function handlePreviewResize() {
  if (!previewDialogVisible.value || previewType.value !== 'pdf' || !pdfDoc.value) return
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => { void renderPage(currentPage.value) }, 120)
}

// 下载文件
function handleDownloadFile() {
  const doc = currentDoc.value
  if (!doc) return
  const downloadUrl = authenticatedAssetUrl(`/api/documents/download/${doc.id}`)
  window.open(downloadUrl, '_blank')
}

// 预览文档（与PC端逻辑完全对齐）
async function previewDocument(doc) {
  if (!doc?.id) return
  try {
    // 标记该条目为loading状态
    previewingDocIds.value.add(doc.id)
    currentDoc.value = { ...doc }
    previewFileName.value = documentDisplayFileName(doc.title, doc.filePath)
    previewIsBase64.value = false
    previewError.value = ''
    void router.replace({ query: { ...route.query, documentId: String(doc.id) } })

    const ext = getFileExtension(doc.filePath).toLowerCase()

    // 图片文件走 t-image-viewer 弹窗
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) {
      try {
        const response = await api.documents.getContent(doc.id)
        const data = response.data || {}
        if (data.isBase64 && data.content) {
          previewContent.value = data.content
          previewIsBase64.value = true; previewType.value = 'image'
          previewLoading.value = false; previewDialogVisible.value = true
          previewingDocIds.value.delete(doc.id)
          await restorePreviewPosition()
          return
        }
      } catch (e) { console.warn('图片base64获取失败，回退URL模式') }
      previewImageUrl.value = authenticatedAssetUrl(`/api/documents/${doc.id}/content`)
      previewType.value = 'image'
      previewLoading.value = false
      previewDialogVisible.value = true
      previewingDocIds.value.delete(doc.id)
      await restorePreviewPosition()
      return
    }

    if (ext === 'xls' || ext === 'xlsx') {
      previewingDocIds.value.delete(doc.id)
      previewDialogVisible.value = true
      previewLoading.value = false
      previewContent.value = ''
      previewType.value = 'office'
      previewLanguage.value = 'excel'
      return
    }

    if (ext === 'pdf') {
      previewDialogVisible.value = true
      previewLoading.value = true
      previewContent.value = ''
      previewType.value = 'pdf'
      previewLanguage.value = 'pdf'
      currentPage.value = 1
      totalPages.value = 0
      const position = savedPreviewPosition()
      await loadPDFDocument(authenticatedAssetUrl(`/api/documents/preview/${doc.id}`))
      currentPage.value = Math.min(totalPages.value, Math.max(1, Number(position?.page) || 1))
      previewLoading.value = false
      previewingDocIds.value.delete(doc.id)
      await nextTick()
      await renderPage(currentPage.value)
      await restorePreviewPosition(position)
      return
    }

    // 获取内容
    const response = await api.documents.getContent(doc.id)
    const data = response.data || {}
    const content = data.content || ''
    const isBase64 = data.isBase64 || false
    const sourceName = data.fileName || doc.filePath
    const sourceExtension = getFileExtension(sourceName).toLowerCase()
    if (data.title) currentDoc.value = { ...currentDoc.value, title: data.title }

    // 数据到达，打开弹窗并显示内部loading
    previewingDocIds.value.delete(doc.id)
    previewDialogVisible.value = true; previewLoading.value = true
    previewContent.value = ''
    previewFileName.value = documentDisplayFileName(data.title || doc.title, sourceName)
    pdfDoc.value = null; currentPage.value = 1; totalPages.value = 0

    // 根据扩展名确定预览类型
    const previewInfo = getPreviewType(sourceExtension)
    previewType.value = previewInfo.type
    previewLanguage.value = previewInfo.language

    if (isBase64) {
      if (previewType.value === 'image') {
        previewContent.value = content; previewIsBase64.value = true; previewLoading.value = false
      } else if (previewType.value === 'office') {
        await loadOfficeContent(content, sourceExtension)
      } else {
        previewType.value = 'unsupported'; previewLoading.value = false
      }
    } else {
      previewContent.value = content; previewLoading.value = false
    }
    await restorePreviewPosition()
  } catch (error) {
    previewingDocIds.value.clear()
    console.error('预览失败:', error)
    previewDialogVisible.value = true
    previewLoading.value = false
    previewError.value = error.response?.status === 400
      ? '此文件暂不支持在线预览，你仍可以下载原件。'
      : '内容加载失败，请检查网络后重试；原件下载不受影响。'
  }
}

// 显示操作菜单
function showActionMenu(doc) {
  currentDoc.value = doc
  actionMenuVisible.value = true
}

function closeActionMenu() {
  actionMenuVisible.value = false
}

// 关闭预览
function closePreview() {
  savePreviewPosition()
  previewDialogVisible.value = false
  previewContent.value = ''
  previewImageUrl.value = ''
  previewType.value = ''
  previewError.value = ''
  void teardownPDFDocument()
  const nextQuery = { ...route.query }
  delete nextQuery.documentId
  void router.replace({ query: nextQuery })
}

// 处理操作选择
function handleActionSelect(item) {
  const doc = currentDoc.value
  if (!doc) return
  
  // 关闭菜单
  actionMenuVisible.value = false
  
  switch (item.value) {
    case 'versions':
      handleViewVersions(doc)
      break
    case 'edit':
      handleChangeSingle(doc)
      break
    case 'download':
      handleDownloadFile()
      break
  }
}

// 删除确认弹窗状态
const deleteConfirmVisible = ref(false)

// 点击删除按钮
function handleDeleteClick() {
  actionMenuVisible.value = false
  deleteConfirmVisible.value = true
}

// 确认删除
async function confirmDelete() {
  const doc = currentDoc.value
  if (!doc) return
  
  deleteConfirmVisible.value = false
  await handleDelete(doc.id)
}

// 查看版本
async function handleViewVersions(doc) {
  try {
    currentDoc.value = doc
    const response = await api.documents.versions(doc.id)
    versions.value = response.data?.data || []
    versionsDialogVisible.value = true
  } catch (error) {
    toast.error(documentErrorMessage(error, '加载版本失败'))
  }
}

// 单条编辑
function handleChangeSingle(doc) {
  currentDoc.value = doc
  batchEditForm.value = {
    categoryId: doc.categoryId || null,
    tags: normalizeDocumentTags(doc.tags).join(', ')
  }
  batchEditDialogVisible.value = true
}

async function handleSingleEditConfirm() {
  const documentId = currentDoc.value?.id
  if (!documentId) {
    toast.warning('当前文档不可用')
    return
  }
  try {
    const updateData = {
      title: currentDoc.value.title,
      tags: batchEditForm.value.tags || '',
      categoryId: batchEditForm.value.categoryId ? Number(batchEditForm.value.categoryId) : null
    }
    const response = await api.documents.update(documentId, updateData)
    toast.success(response.data?.message || '更改成功')
    batchEditDialogVisible.value = false
    await loadDocumentCoverage()
    await Promise.all([loadDocuments(), loadCategories()])
  } catch (error) {
    toast.error(documentErrorMessage(error, '更改失败'))
  }
}

// 单条删除
async function handleDelete(id) {
  try {
    const response = await api.documents.delete(id)
    toast.success(response.data?.message || '文档已移入回收站')
    await loadDocumentCoverage()
    await Promise.all([loadDocuments(), loadCategories()])
  } catch (error) {
    toast.error(documentErrorMessage(error, '移入回收站失败'))
  }
}

// 上传
function documentErrorMessage(error, fallback) {
  const message = error?.response?.data?.message
  return typeof message === 'string' && message.trim() ? message : fallback
}

function ragStatusLabel(status) {
  return ({
    ready: '可问', partial: '部分可问', pending: '索引中', stale: '待刷新',
    failed: '索引失败', missing: '未索引', unknown: '状态未知'
  })[status] || '状态未知'
}

function ragStatusTheme(status) {
  if (status === 'ready') return 'success'
  if (status === 'partial' || status === 'pending') return 'primary'
  if (status === 'failed') return 'danger'
  if (status === 'stale' || status === 'missing') return 'warning'
  return 'default'
}

function openUploadDialog() {
  if (!canWrite.value) return
  uploadConflictDialogVisible.value = false
  uploadConflict.value = null
  selectedUploadConflictCandidateId.value = null
  uploadFiles.value = []
  if (uploadInput.value) uploadInput.value.value = ''
  const currentCategory = currentCategoryId.value
    ? findCategoryById(categories.value, currentCategoryId.value)
    : null
  uploadForm.value = {
    title: '',
    tags: '',
    categoryId: currentCategory?.id || null,
    versionNote: ''
  }
  uploadDialogVisible.value = true
}

function openFilePicker() {
  uploadInput.value?.click()
}

function handleMobileFileChange(event) {
  const file = event.target.files?.[0]
  if (!file) return
  uploadFiles.value = [{ name: file.name, raw: file }]
  if (!uploadForm.value.title) uploadForm.value.title = file.name.replace(/\.[^/.]+$/, '')
}

function openUploadConflict(error) {
  const data = error?.response?.data || {}
  const candidates = Array.isArray(data.candidates) ? data.candidates : []
  uploadConflict.value = {
    message: data.message || '请选择处理方式，系统不会自动改名或合并。',
    suggestedTitle: data.suggestedTitle || '',
    candidates
  }
  const firstEligible = candidates.find(candidate => !candidate.hashMatches)
  selectedUploadConflictCandidateId.value = (firstEligible || candidates[0])?.id ?? null
  uploadConflictDialogVisible.value = true
}

async function submitUpload({ resolution = null, title = uploadForm.value.title, targetDocumentId = null } = {}) {
  if (uploading.value) return false
  if (!canWrite.value || uploadFiles.value.length === 0) {
    if (uploadFiles.value.length === 0) toast.warning('请选择文件')
    return false
  }

  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('file', uploadFiles.value[0].raw)
    formData.append('title', title || uploadFiles.value[0].name)
    if (uploadForm.value.categoryId) formData.append('categoryId', String(uploadForm.value.categoryId))
    if (uploadForm.value.tags) formData.append('tags', uploadForm.value.tags)
    if (uploadForm.value.versionNote) formData.append('versionNote', uploadForm.value.versionNote)
    if (resolution === 'create') formData.append('resolution', 'create')
    if (resolution === 'new_version') {
      formData.append('resolution', 'new_version')
      formData.append('targetDocumentId', String(targetDocumentId))
    }

    const response = await api.documents.upload(formData)
    toast.success(response.data?.message || '上传成功')
    uploadDialogVisible.value = false
    uploadConflictDialogVisible.value = false
    uploadConflict.value = null
    selectedUploadConflictCandidateId.value = null
    uploadFiles.value = []
    uploadForm.value = { title: '', tags: '', categoryId: null, versionNote: '' }
    await loadDocumentCoverage()
    await Promise.all([loadDocuments(), loadCategories()])
    return true
  } catch (error) {
    if (!resolution && error?.response?.data?.code === 'DOCUMENT_UPLOAD_CONFLICT') {
      openUploadConflict(error)
    } else {
      toast.error(documentErrorMessage(error, '上传失败'))
    }
    return false
  } finally {
    uploading.value = false
  }
}

async function handleUpload() {
  return submitUpload()
}

async function retryUploadAsNewDocument() {
  const suggestedTitle = uploadConflict.value?.suggestedTitle
  if (!suggestedTitle) return
  return submitUpload({ resolution: 'create', title: suggestedTitle })
}

async function retryUploadAsCandidateVersion() {
  const candidate = selectedUploadConflictCandidate.value
  if (!candidate || candidate.hashMatches) {
    toast.warning('内容 hash 相同，不能作为新版本；可使用建议标题另建。')
    return false
  }
  return submitUpload({ resolution: 'new_version', targetDocumentId: candidate.id })
}

function cancelUploadConflict() {
  uploadConflictDialogVisible.value = false
  uploadConflict.value = null
  selectedUploadConflictCandidateId.value = null
}

function handleDownloadVersion(ver) {
  window.open(authenticatedAssetUrl(`/api/documents/download/version/${ver.id}`), '_blank')
}

// 工具函数

function getFileExtension(fileName) {
  if (!fileName) return ''
  const parts = fileName.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
}

function getFileNameWithExt(doc) {
  return documentDisplayFileName(doc?.title, doc?.filePath)
}

function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return '大小未知'
  const numericBytes = Number(bytes)
  if (!Number.isFinite(numericBytes) || numericBytes < 0) return '大小未知'
  if (numericBytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(numericBytes) / Math.log(k))
  return Math.round(numericBytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function formatDateTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function parseTags(tagsStr) {
  return normalizeDocumentTags(tagsStr)
}

function visibleTags(tags) {
  return parseTags(tags).slice(0, 2)
}

function hiddenTagCount(tags) {
  return Math.max(0, parseTags(tags).length - 2)
}

function getImageMimeType(fileName) {
  if (!fileName) return 'png'
  const ext = fileName.split('.').pop().toLowerCase()
  const mimeMap = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' }
  return mimeMap[ext] || 'png'
}

// 计算属性

const categoryOptions = computed(() => {
  const options = []
  const buildOptions = (categories, prefix = '') => {
    for (const cat of categories) {
      const path = prefix ? `${prefix}/${cat.name}` : cat.name
      options.push({ label: path, value: cat.id })
      if (cat.subcategories?.length) {
        buildOptions(cat.subcategories, path)
      }
    }
  }
  buildOptions(categories.value)
  return options
})

// 生命周期

onMounted(async () => {
  window.addEventListener('resize', handlePreviewResize)
  await Promise.all([loadCategories(), loadDocumentCoverage()])

  searchKeyword.value = routeQueryText(route.query.q)
  viewMode.value = routeQueryText(route.query.view) === 'all' ? 'list' : 'category'
  if (viewMode.value === 'category') {
    const requestedCategoryId = routeQueryText(route.query.categoryId)
    const requestedTrail = requestedCategoryId
      ? findCategoryTrail(categories.value, requestedCategoryId)
      : null
    if (requestedTrail?.length) {
      categoryPath.value = requestedTrail
      currentCategoryId.value = requestedTrail[requestedTrail.length - 1].id
    }
  }

  await loadDocuments()
  const documentId = Number(route.query.documentId)
  if (Number.isSafeInteger(documentId) && documentId > 0) {
    const document = documents.value.find((item) => Number(item.id) === documentId) || {
      id: documentId,
      title: `文档 ${documentId}`,
      filePath: ''
    }
    await previewDocument(document)
  }
})

const customOverlayVisible = computed(() => (
  actionMenuVisible.value || previewDialogVisible.value || categoryPickerVisible.value
))
let releaseOverlayScrollLock = null

watch(customOverlayVisible, (visible) => {
  if (visible && !releaseOverlayScrollLock) releaseOverlayScrollLock = acquireBodyScrollLock()
  if (!visible && releaseOverlayScrollLock) {
    releaseOverlayScrollLock()
    releaseOverlayScrollLock = null
  }
})

onBeforeUnmount(() => {
  savePreviewPosition()
  window.removeEventListener('resize', handlePreviewResize)
  clearTimeout(resizeTimer)
  void teardownPDFDocument()
  releaseOverlayScrollLock?.()
  releaseOverlayScrollLock = null
})
</script>

<style scoped>
.mobile-documents {
  padding: 12px 12px calc(88px + env(safe-area-inset-bottom));
  min-height: 100vh;
  background: var(--color-surface-subtle);
}

.mobile-browse-toolbar,
.mobile-search-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mobile-browse-toolbar {
  margin-bottom: 12px;
}

.mobile-trash-button {
  width: 44px;
  min-width: 44px;
  height: 44px;
  min-height: 44px;
  flex: 0 0 44px;
}

.mobile-category-filter {
  min-width: 0;
  min-height: 44px;
  flex: 1;
  padding: 5px 10px 5px 6px;
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  text-align: left;
  color: var(--color-text-primary);
  background: var(--color-surface-raised);
  transition: border-color var(--motion-duration-fast) var(--motion-easing-standard), background-color var(--motion-duration-fast) var(--motion-easing-standard), transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.mobile-category-filter:active {
  border-color: var(--color-primary-border);
  background: var(--color-primary-surface);
  transform: scale(.99);
}

.mobile-category-filter__icon {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  background: var(--color-primary-surface);
}

.mobile-category-filter__copy {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 1px;
}

.mobile-category-filter__copy strong,
.mobile-category-filter__copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-category-filter__copy strong { font-size: 13px; }
.mobile-category-filter__copy small { color: var(--color-text-muted); font-size: 11px; }

.mobile-search-actions {
  margin-bottom: 8px;
}

.search-bar {
  min-width: 0;
  flex: 1;
}

.mobile-upload-button {
  min-width: 96px;
  min-height: 40px;
}

.mobile-upload-input {
  display: none;
}

.batch-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #e6f2ff;
  padding: 12px;
  border-radius: 8px;
  margin-bottom: 8px;
}

.batch-actions-space {
  display: flex;
  gap: 8px;
}

.batch-info {
  font-size: 13px;
  color: var(--color-text-primary);
  font-weight: 500;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.section-title .count {
  font-size: 12px;
  color: var(--color-text-muted);
  font-weight: normal;
}

.documents-section {
  border: 1px solid var(--color-border-subtle);
  background: var(--color-surface-raised);
  border-radius: var(--radius-lg);
  padding: 12px;
}

.mobile-document-error {
  margin-bottom: 12px;
}

.mobile-document-error :deep(.native-alert__message) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.document-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.document-item {
  display: flex;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
}

.document-open-target {
  flex: 1;
  min-width: 0;
  min-height: 48px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  gap: 10px;
  color: inherit;
  background: transparent;
  text-align: left;
  font: inherit;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-easing-standard), transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.document-open-target:active { background: var(--color-surface-subtle); transform: scale(.995); }
.document-open-target:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 1px; }

.document-item:last-child {
  border-bottom: none;
}

/* 预览中状态：条目显示loading效果 */
.document-item.previewing {
  opacity: 0.6;
  pointer-events: none;
  position: relative;
}
/* 预览时条目右侧的转圈loading */
.item-loading-spinner {
  flex-shrink: 0;
  padding: 4px 8px;
}

/* 游客模式：不显示操作区域 */
.document-item.guest-mode {
  cursor: default;
}

.file-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  background: var(--color-surface-subtle);
  color: var(--color-text-secondary);
}

.document-type-icon--pdf { color: var(--color-danger-text); background: var(--color-danger-surface); }
.document-type-icon--word { color: #3564b8; background: #edf4ff; }
.document-type-icon--sheet { color: var(--color-success-text); background: var(--color-success-surface); }
.document-type-icon--slides { color: var(--color-warning-text); background: var(--color-warning-surface); }
.document-type-icon--markdown { color: #6a4fb0; background: #f2efff; }
.document-type-icon--image { color: #087c8f; background: #e9f7f8; }
.document-type-icon--code { color: #4f6078; background: #edf0f5; }
.document-type-icon--text { color: var(--color-text-secondary); background: var(--color-surface-subtle); }

.file-info {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.file-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 4px;
}

.file-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.file-meta .divider {
  color: #ddd;
}

.file-tags {
  color: var(--color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 80px;
}

.file-tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.file-tags-more {
  min-height: 20px;
  padding: 2px 6px;
  display: inline-flex;
  align-items: center;
  color: var(--color-text-muted);
  font-size: 11px;
}

.action-menu {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  background: transparent;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

.action-menu:active { color: var(--color-primary); background: var(--color-primary-surface); }
.action-menu:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 1px; }

.mobile-list-pagination {
  margin-top: 14px;
  padding-top: 2px;
  display: grid;
  gap: 8px;
}

.mobile-list-pagination--complete {
  display: flex;
  justify-content: center;
}

.mobile-list-pagination__complete {
  min-height: 28px;
  padding: 5px 10px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  background: var(--color-surface-subtle);
  font-size: 11px;
}

.mobile-list-pagination__status {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--color-text-muted);
  font-size: 11px;
}

.mobile-list-pagination :deep(.native-button) { width: 100%; }

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 0;
  color: var(--color-text-muted);
}

.empty-state p {
  margin-top: 12px;
  font-size: 14px;
}

.loading-state {
  display: flex;
  justify-content: center;
  padding: 40px 0;
}

/* 弹窗样式 */
.edit-popup,
.versions-popup,
.preview-popup {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.popup-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #f0f0f0;
}

.popup-header h3 {
  margin: 0;
  font-size: 16px;
}

/* 对话框底部按钮 */
.dialog-footer-btns {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.upload-form,
.edit-form {
  flex: 1;
  padding: 16px;
  overflow-y: auto;
}

.mt-4 {
  margin-top: 16px;
}

.popup-footer-btns {
  padding-top: 12px;
  border-top: 1px solid #f0f0f0;
}

.preview-body {
  flex: 1;
  overflow-y: auto;
  padding: 2px 1px;
}

.text-preview {
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-text-primary);
}
.text-preview pre {
  margin: 0;
  padding: 0;
}

/* Markdown 预览样式（MdPreview组件移动端适配） */
.mobile-md-preview {
  border: none;
  box-shadow: none;
}
.mobile-md-preview :deep(.md-editor-preview) {
  padding: 0 2px;
}

/* PDF预览 */
.pdf-preview {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.pdf-preview canvas {
  max-width: 100%;
  border: 1px solid #ddd;
  border-radius: 4px;
}
.pdf-controls {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  padding: 8px;
  font-size: 13px;
  color: var(--color-text-secondary);
}

/* 代码预览 */
.code-preview {
  background: #282c34;
  border-radius: 4px;
  overflow-x: auto;
}
.code-preview pre {
  margin: 0;
  padding: 8px 6px;
}
.code-preview code {
  color: #abb2bf;
  font-size: 13px;
  line-height: 1.5;
}

/* Office文档预览 */
.office-toolbar {
  margin-bottom: 12px;
}
.office-content {
  overflow-x: auto;
}
.office-content table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.office-content table td,
.office-content table th {
  border: 1px solid #ddd;
  padding: 4px 6px;
}
.office-preview, .unsupported-preview {
  text-align: center;
  padding: 32px 0;
  color: var(--color-text-muted);
}
.office-preview h3 {
  margin: 12px 0 8px;
  font-size: 16px;
  color: var(--color-text-primary);
}
.office-preview p {
  margin-bottom: 16px;
  font-size: 14px;
}

.mobile-upload-form,
.edit-form {
  display: grid;
  gap: 12px;
}

.mobile-upload-form :deep(.native-form-item),
.edit-form :deep(.native-form-item) { margin: 0; }

.mobile-file-picker {
  width: 100%;
  min-width: 0;
  min-height: 40px;
  justify-content: flex-start;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mobile-version-dialog :deep(.native-dialog__body) { padding: 12px 14px 18px; }

.mobile-version-summary {
  min-width: 0;
  margin-bottom: 12px;
  padding: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-surface-subtle);
}

.mobile-version-summary__icon {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
}

.mobile-version-summary > span:last-child { min-width: 0; display: grid; gap: 3px; }
.mobile-version-summary strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.mobile-version-summary small { color: var(--color-text-muted); font-size: 11px; }

.versions-list {
  max-height: min(62dvh, 520px);
  display: grid;
  gap: 10px;
  overflow-y: auto;
}

.version-item {
  position: relative;
  min-width: 0;
  padding: 13px 12px;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) 40px;
  align-items: start;
  gap: 10px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}

.version-item--current {
  border-color: var(--color-primary-border);
  background: color-mix(in srgb, var(--color-primary-surface) 48%, var(--color-surface-raised));
}

.version-timeline-marker {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-pill);
  color: var(--color-primary);
  background: var(--color-primary-surface);
}

.version-info { min-width: 0; display: grid; gap: 6px; }
.version-header { display: flex; align-items: center; gap: 7px; }
.version-num { color: var(--color-text-primary); font-size: 14px; font-weight: 700; }
.version-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--color-text-muted); font-size: 11px; }
.version-note { margin: 0; color: var(--color-text-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.version-download-button { width: 40px; min-width: 40px; height: 40px; min-height: 40px; }

.version-empty-state {
  min-height: 180px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  color: var(--color-text-muted);
  font-size: 13px;
}

.version-empty-state > span {
  width: 48px;
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  color: var(--color-primary);
  background: var(--color-primary-surface);
}

.version-empty-state strong { color: var(--color-text-primary); }
.version-empty-state small { max-width: 240px; text-align: center; line-height: 1.55; }

  .version-trash-btn {
    padding: 6px 10px;
    font-size: 12px;
    color: #c9353f;
    background: transparent;
    border: 1px solid var(--color-danger);
    border-radius: 4px;
  }

  .version-trash-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .version-trash-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 0;
    border-bottom: 1px solid #f0f0f0;
  }

  .upload-conflict-suggestion {
    margin: 10px 0;
  }

  .upload-conflict-candidates {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 280px;
    overflow-y: auto;
  }

  .upload-conflict-candidate {
    display: flex;
    gap: 8px;
    padding: 8px;
    border: 1px solid #e7e7e7;
    border-radius: 6px;
  }

  .upload-conflict-candidate.hash-match {
    border-color: var(--color-warning);
    background: #fff7ed;
  }

  .upload-conflict-candidate-body {
    display: grid;
    gap: 3px;
    font-size: 12px;
  }

  .upload-conflict-hash-match {
    color: #d54941;
    font-weight: 600;
  }

  .upload-conflict-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 12px;
  }
</style>

<style>
/* 移动端全屏预览与底部操作单需要 Teleport 外同样稳定的全局层级。 */
.native-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 10020;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: var(--color-surface-raised);
  animation: mobile-preview-fade-in var(--motion-duration-fast) var(--motion-easing-standard);
}
.native-preview-container {
  width: 100%;
  height: 100vh;
  height: 100dvh;
  max-width: 100%;
  max-height: 100dvh;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border-radius: 0;
  background: var(--color-surface-raised);
  animation: mobile-preview-rise-in var(--motion-duration-standard) var(--motion-easing-emphasized);
}
.native-preview-header {
  min-height: calc(56px + env(safe-area-inset-top));
  padding: calc(8px + env(safe-area-inset-top)) 10px 8px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: color-mix(in srgb, var(--color-surface-raised) 94%, transparent);
  backdrop-filter: blur(12px);
  color: var(--color-text-primary);
  flex-shrink: 0;
}
.preview-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 650;
}
.preview-header-actions { display: inline-flex; align-items: center; gap: 4px; }
.preview-header-button {
  width: 44px;
  height: 44px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-pill);
  color: var(--color-text-secondary);
  background: transparent;
}
.preview-header-button:active { color: var(--color-primary); background: var(--color-primary-surface); transform: scale(.96); }
.native-preview-body {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  background: var(--color-surface-subtle);
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--color-primary) 54%, transparent) transparent;
}
.native-preview-body--pdf { overflow: hidden; }
.native-preview-body::-webkit-scrollbar { width: 5px; height: 5px; }
.native-preview-body::-webkit-scrollbar-thumb { border-radius: var(--radius-pill); background: color-mix(in srgb, var(--color-primary) 54%, transparent); }
/* 内容区各种预览类型适配 */
.native-preview-body .pdf-preview {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.native-preview-body .pdf-canvas-stage {
  min-height: 0;
  padding: 12px;
  display: flex;
  flex: 1 1 auto;
  justify-content: center;
  overflow: auto;
  overscroll-behavior: contain;
}
.native-preview-body .pdf-preview canvas {
  align-self: flex-start;
  max-width: none;
  display: block;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  background: white;
  box-shadow: var(--shadow-md);
}
.native-preview-body .pdf-controls {
  min-height: calc(62px + env(safe-area-inset-bottom));
  padding: 9px 16px calc(9px + env(safe-area-inset-bottom));
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 14px;
  border-top: 1px solid var(--color-border-subtle);
  color: var(--color-text-secondary);
  background: color-mix(in srgb, var(--color-surface-raised) 94%, transparent);
  box-shadow: 0 -8px 24px rgba(23, 32, 51, .06);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.native-preview-body .pdf-page-button {
  width: 44px;
  min-width: 44px;
  height: 40px;
  padding: 0;
}
.native-preview-body .pdf-page-button .native-icon { width: 15px; height: 15px; flex: 0 0 15px; }
.preview-loading-state {
  min-height: 0;
  flex: 1;
  align-items: center;
}
.mobile-preview-error {
  min-height: 100%;
  padding: 32px 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  text-align: center;
  color: var(--color-text-secondary);
  background: var(--color-surface-raised);
}
.mobile-preview-error strong { color: var(--color-text-primary); }
.mobile-preview-error p { max-width: 28rem; margin: 0; font-size: 13px; line-height: 1.6; }
.mobile-preview-error > div { margin-top: 6px; display: flex; gap: 8px; }
.native-preview-body .mobile-md-preview,
.native-preview-body .code-preview,
.native-preview-body .text-preview {
  width: 100%;
  min-height: 100%;
  margin: 0;
  padding: 16px 14px;
  border: 0;
  border-radius: 0;
  background: var(--color-surface-raised);
}
.native-preview-body .code-preview pre {
  margin: 0;
  padding: 0;
}
.native-preview-body .text-preview pre {
  margin: 0;
  padding: 0;
  color: var(--color-text-primary);
}
.native-preview-body .image-preview-content {
  width: 100%;
  min-height: 100%;
  padding: 12px;
  max-width: 100%;
  display: block;
  margin: 0 auto;
  object-fit: contain;
  background: var(--color-surface-raised);
}
.native-preview-body .office-content {
  min-height: 100%;
  padding: 16px 14px;
  background: var(--color-surface-raised);
  color: var(--color-text-primary);
}
.native-preview-body .office-content table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.native-preview-body .office-content table td,
.native-preview-body .office-content table th {
  border: 1px solid #ddd;
  padding: 6px 8px;
  color: var(--color-text-primary);
}

@keyframes mobile-preview-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes mobile-preview-rise-in { from { opacity: .86; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }

/* 原生底部操作菜单 */
.native-action-overlay {
  position: fixed;
  inset: 0;
  z-index: 10030;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  background: rgba(23, 32, 51, .5);
  backdrop-filter: blur(2px);
  animation: mobile-action-fade-in var(--motion-duration-fast) var(--motion-easing-standard);
}

.delete-confirm-content {
  padding: 8px 2px;
  text-align: center;
}
.delete-confirm-content p {
  margin: 0 0 8px;
  font-size: 15px;
}
.delete-warning {
  color: var(--color-text-secondary);
  font-size: 13px;
}
.native-action-sheet {
  max-height: min(82dvh, 640px);
  padding: 8px 0 calc(8px + env(safe-area-inset-bottom));
  overflow: hidden;
  border-radius: 20px 20px 0 0;
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-lg);
  animation: mobile-action-slide-up var(--motion-duration-standard) var(--motion-easing-emphasized);
}
.action-sheet-handle {
  width: 36px;
  height: 4px;
  margin: 0 auto 6px;
  border-radius: var(--radius-pill);
  background: var(--color-border-default);
}
.category-picker-sheet {
  max-height: min(78dvh, 680px);
  display: flex;
  flex-direction: column;
}
.category-picker-header {
  min-width: 0;
  padding: 8px 16px 13px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--color-border-subtle);
}
.category-picker-header > span { min-width: 0; display: grid; gap: 3px; }
.category-picker-header strong { font-size: 15px; }
.category-picker-header small { color: var(--color-text-muted); font-size: 11px; }
.category-picker-header button {
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-pill);
  color: var(--color-text-secondary);
  background: transparent;
}
.category-picker-header button:active { background: var(--color-surface-subtle); }
.category-picker-error { margin: 12px 14px; }
.category-picker-list {
  min-height: 0;
  padding: 8px 10px calc(12px + env(safe-area-inset-bottom));
  overflow-y: auto;
}
.category-picker-all,
.category-picker-row {
  min-height: 54px;
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
}
.category-picker-all {
  width: 100%;
  padding: 7px 12px;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 20px;
  align-items: center;
  gap: 10px;
  border: 0;
  text-align: left;
  background: transparent;
}
.category-picker-row {
  padding-left: calc(var(--category-depth) * 18px);
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  align-items: center;
}
.category-picker-all.selected,
.category-picker-row.selected { color: var(--color-primary); background: var(--color-primary-surface); }
.category-picker-all:active,
.category-picker-row:active { background: var(--color-surface-subtle); }
.category-picker-all > span:nth-child(2),
.category-picker-option > span:nth-child(2) { min-width: 0; display: grid; gap: 2px; }
.category-picker-all strong,
.category-picker-option strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.category-picker-all small,
.category-picker-option small { color: var(--color-text-muted); font-size: 11px; }
.category-picker-disclosure,
.category-picker-disclosure-spacer {
  width: 34px;
  height: 44px;
}
.category-picker-disclosure {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  background: transparent;
}
.category-picker-disclosure:active { color: var(--color-primary); background: var(--color-primary-surface); }
.category-picker-option {
  min-width: 0;
  min-height: 54px;
  padding: 6px 12px 6px 0;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 20px;
  align-items: center;
  gap: 10px;
  border: 0;
  text-align: left;
  color: inherit;
  background: transparent;
}
.category-picker-row-icon {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  background: var(--color-primary-surface);
}
.category-picker-empty { padding: 28px 12px; text-align: center; color: var(--color-text-muted); font-size: 13px; }
@keyframes mobile-action-slide-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
@keyframes mobile-action-fade-in { from { opacity: 0; } to { opacity: 1; } }
.action-sheet-title {
  min-width: 0;
  padding: 10px 18px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--color-border-subtle);
}
.action-sheet-title > span:last-child { min-width: 0; display: grid; gap: 2px; }
.action-sheet-title strong { overflow: hidden; color: var(--color-text-primary); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.action-sheet-title small { color: var(--color-text-muted); font-size: 11px; }
.action-sheet-file-icon {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  border-radius: var(--radius-sm);
}
.action-sheet-list {
  padding: 8px 0;
  overflow-y: auto;
}
.action-sheet-item {
  width: 100%;
  min-height: 58px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  border: 0;
  border-bottom: 1px solid var(--color-border-subtle);
  text-align: left;
  color: var(--color-text-primary);
  background: transparent;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-easing-standard), transform var(--motion-duration-fast) var(--motion-easing-standard);
}
.action-sheet-item > span { display: grid; gap: 2px; }
.action-sheet-item strong { font-size: 14px; font-weight: 600; }
.action-sheet-item small { color: var(--color-text-muted); font-size: 11px; }
.action-sheet-item:active {
  background: var(--color-surface-subtle);
  transform: scale(.99);
}
.action-sheet-item.delete {
  color: var(--color-danger);
}
.action-sheet-item.delete:active {
  background: #fff0f0;
}
.action-sheet-cancel {
  width: calc(100% - 24px);
  min-height: 48px;
  margin: 8px 12px 0;
  border: 0;
  border-radius: var(--radius-md);
  text-align: center;
  font-size: 15px;
  color: var(--color-text-secondary);
  background: var(--color-surface-subtle);
  cursor: pointer;
}
.action-sheet-cancel:active {
  background: var(--color-surface-subtle);
}

@media (prefers-reduced-motion: reduce) {
  .native-preview-overlay,
  .native-preview-container,
  .native-action-overlay,
  .native-action-sheet { animation: none; }
  .preview-header-button,
  .action-sheet-item { transition: none; }
}
</style>
