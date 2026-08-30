<template>
  <div class="documents">
    <div class="page-header document-page-intro">
      <div>
        <p>以分类组织原件、版本和索引状态；上传失败不会影响已有资源。</p>
        <span>单击预览内容，在详情中管理元数据与版本。</span>
      </div>
      <div class="page-header-actions">
        <NativeButton variant="outline" @click="openTrashPage">
          <template #icon><NativeIcon name="trash" /></template>
          回收站
        </NativeButton>
        <NativeButton theme="primary" @click="handleUpload" :disabled="!canWrite">
          <template #icon><NativeIcon name="plus" /></template>
          上传文档
        </NativeButton>
      </div>
    </div>

    <NativeCard class="document-workbench">
      <div class="workbench-toolbar">
        <div class="workbench-location">
          <NativeButton
            variant="text"
            shape="circle"
            :title="folderRailCollapsed ? '展开分类' : '收起分类'"
            @click="folderRailCollapsed = !folderRailCollapsed"
          >
            <template #icon><NativeIcon name="list-dashes" /></template>
          </NativeButton>
          <button type="button" class="breadcrumb-root" @click="backToRoot">全部文档</button>
          <template v-for="category in categoryPath" :key="category.id">
            <NativeIcon name="chevron-right" size="13" />
            <button type="button" class="breadcrumb-segment" @click="selectCategoryFromRail({ trail: categoryPath.slice(0, categoryPath.indexOf(category) + 1) })">
              {{ category.name }}
            </button>
          </template>
        </div>
        <div class="workbench-search">
          <NativeInput
            v-model="searchKeyword"
            class="workbench-query"
            placeholder="搜索标题或标签"
            clearable
            @clear="handleSearch"
            @enter="handleSearch"
          >
            <template #suffix-icon><NativeIcon name="magnifying-glass" /></template>
          </NativeInput>
          <div class="workbench-sort-group" aria-label="文档排序">
            <NativeSelect
              v-model="sortBy"
              class="workbench-sort"
              aria-label="排序字段"
              :options="[
                { value: 'updated_at', label: '最近更新' },
                { value: 'title', label: '文件名' },
                { value: 'file_type', label: '文件类型' },
                { value: 'size', label: '文件大小' }
              ]"
              @change="handleDropdownSortChange"
            />
            <NativeButton class="sort-direction-button" variant="text" shape="circle" :title="sortOrder === 'desc' ? '降序' : '升序'" @click="toggleSortOrder">
              <template #icon><NativeIcon :name="sortOrder === 'desc' ? 'arrow-down' : 'arrow-up'" size="18" /></template>
            </NativeButton>
          </div>
          <NativeButton
            class="workbench-filter-toggle"
            :variant="advancedSearchVisible ? 'base' : 'outline'"
            :theme="advancedSearchVisible ? 'primary' : 'default'"
            @click="advancedSearchVisible = !advancedSearchVisible"
          >
            <template #icon><NativeIcon name="filter" /></template>
            筛选
          </NativeButton>
        </div>
      </div>

      <div v-if="advancedSearchVisible" class="advanced-search-panel workbench-filters">
        <div class="workbench-filter-heading">
          <span class="workbench-filter-icon"><NativeIcon name="filter" size="18" /></span>
          <div>
            <strong>筛选文档</strong>
            <span>{{ activeDocumentFilterCount > 0 ? `已设置 ${activeDocumentFilterCount} 项条件` : '组合标签和更新时间缩小范围' }}</span>
          </div>
        </div>
        <div class="workbench-filter-fields">
          <NativeFormItem label="标签">
            <NativeSelect
              v-model="selectedTags"
              placeholder="选择一个或多个标签"
              multiple
              clearable
              :options="allTags.map(tag => ({ value: tag, label: tag }))"
            />
          </NativeFormItem>
          <NativeFormItem label="更新时间">
            <NativeDateRangePicker v-model="dateRange" />
          </NativeFormItem>
        </div>
        <div class="workbench-filter-actions">
          <NativeButton theme="primary" @click="handleAdvancedSearch">
            <template #icon><NativeIcon name="check" /></template>
            应用筛选
          </NativeButton>
          <NativeButton variant="outline" @click="resetAdvancedSearch">
            <template #icon><NativeIcon name="x" /></template>
            清除
          </NativeButton>
        </div>
      </div>

      <div class="workbench-body" :class="{ 'folder-rail-collapsed': folderRailCollapsed }">
        <aside v-if="!folderRailCollapsed" class="folder-rail" aria-label="文档分类">
          <div class="folder-rail-header">
            <strong>分类</strong>
            <NativeButton v-if="canWrite" variant="text" shape="circle" size="small" title="新建分类" @click="handleCreateCategory">
              <template #icon><NativeIcon name="folder-plus" /></template>
            </NativeButton>
          </div>
          <NativeAlert v-if="categoriesError" theme="error" title="分类加载失败">
            <NativeButton size="small" variant="outline" @click="loadCategories">重试</NativeButton>
          </NativeAlert>
          <div v-else class="folder-tree">
            <button
              type="button"
              class="folder-tree-item folder-tree-all"
              :class="{ active: !currentCategoryId }"
              @click="backToRoot"
            >
              <NativeIcon name="files" size="17" />
              <span>全部文档</span>
              <small>{{ totalAllDocuments }}</small>
            </button>
            <div
              v-for="item in flattenedCategories"
              :key="item.id"
              class="folder-tree-row"
              :class="{ active: currentCategoryId === item.id }"
              :style="{ '--folder-depth': item.depth }"
            >
              <button
                v-if="item.subcategories?.length"
                type="button"
                class="folder-tree-toggle"
                :title="expandedCategoryIds.has(item.id) ? '收起子分类' : '展开子分类'"
                :aria-label="expandedCategoryIds.has(item.id) ? `收起${item.name}` : `展开${item.name}`"
                :aria-expanded="expandedCategoryIds.has(item.id)"
                @click.stop="toggleCategoryExpansion(item.id)"
              >
                <NativeIcon :name="expandedCategoryIds.has(item.id) ? 'caret-down' : 'caret-right'" size="13" />
              </button>
              <span v-else class="folder-tree-toggle-spacer" aria-hidden="true"></span>
              <button type="button" class="folder-tree-item" @click="selectCategoryFromRail(item)">
                <NativeIcon :name="currentCategoryId === item.id ? 'folder-open' : 'folder'" size="17" />
                <span>{{ item.name }}</span>
                <small>{{ item.fileCount || 0 }}</small>
              </button>
              <div v-if="canWrite" class="folder-tree-actions">
                <button type="button" title="新建子分类" @click.stop="handleCreateSubcategory(item)"><NativeIcon name="plus" size="13" /></button>
                <button type="button" title="重命名" @click="handleRenameCategory(item)"><NativeIcon name="pencil" size="13" /></button>
                <button type="button" title="删除" @click="handleDeleteCategory(item)"><NativeIcon name="trash" size="13" /></button>
              </div>
            </div>
          </div>
        </aside>

        <section class="document-file-pane">
          <NativeAlert v-if="documentsError" theme="error" title="文档加载失败" class="document-state-alert">
            <span>{{ documentsError }}</span>
            <NativeButton size="small" variant="outline" @click="loadDocuments">重新加载</NativeButton>
          </NativeAlert>

          <div v-if="selectedRowKeys.length > 0" class="batch-actions-bar">
            <button
              type="button"
              class="batch-selection-summary"
              :title="allCurrentPageSelected ? '清除当前页选择' : '选择当前页全部文档'"
              :aria-label="allCurrentPageSelected ? '清除当前页选择' : '选择当前页全部文档'"
              @click="toggleCurrentPageSelection"
            >
              <NativeIcon :name="allCurrentPageSelected ? 'check-square' : 'minus'" size="17" />
              已选择 <strong>{{ selectedRowKeys.length }}</strong> 项
            </button>
            <NativeButton theme="primary" size="small" @click="handleBatchEdit" :disabled="!canWrite">
              <template #icon><NativeIcon name="pencil" /></template>
              编辑信息
            </NativeButton>
            <NativePopconfirm content="所选文档将进入回收站，确定继续吗？" @confirm="handleBatchDelete">
              <template #trigger>
                <NativeButton theme="danger" variant="outline" size="small" :disabled="!canWrite">
                  <template #icon><NativeIcon name="trash" /></template>
                  移入回收站
                </NativeButton>
              </template>
            </NativePopconfirm>
            <NativeButton variant="text" size="small" @click="selectedRowKeys = []">取消选择</NativeButton>
          </div>

          <NativeLoading v-if="loading && documents.length === 0" center text="加载文档中..." />
          <NativeTable
            v-else-if="documents.length > 0"
            :dataSource="documents"
            :columns="columns"
            :loading="loading"
            rowKey="id"
            hover
            selectable
            :selectedKeys="selectedRowKeys"
            :allRowKeys="allDocumentIds"
            @selectionChange="handleSelectChange"
            @sortChange="handleSortChange"
          >
            <template #cell-title="{ row }">
              <button type="button" class="document-title-cell" @click="handleView(row)">
                <span class="document-type-icon" :class="`document-type-icon--${documentFileTone(row.filePath)}`"><NativeIcon :name="documentFileIcon(row.filePath)" size="18" /></span>
                <span>{{ row.title }}</span>
              </button>
            </template>
            <template #cell-tags="{ row }">
              <span v-if="row.tags" class="document-tags-cell" :title="row.tags">{{ row.tags }}</span>
              <span v-else class="document-tags-empty">—</span>
            </template>
            <template #cell-version="{ row }"><span>v{{ row.version }}</span></template>
            <template #cell-type="{ row }"><span>{{ getFileExtension(row.filePath || '') }}</span></template>
            <template #cell-indexStatus="{ row }">
              <NativeTag :theme="ragStatusTheme(row.indexStatus)" variant="light" size="small">
                {{ ragStatusLabel(row.indexStatus) }}
              </NativeTag>
            </template>
            <template #cell-operation="{ row }">
              <div class="document-row-actions">
                <button type="button" class="document-row-action document-row-action--preview" @click="handleView(row)">
                  <NativeIcon name="eye" size="15" />
                  <span>预览</span>
                </button>
                <button type="button" class="document-row-action" @click="openDocumentDetails(row)">
                  <NativeIcon name="info" size="15" />
                  <span>详情</span>
                </button>
              </div>
            </template>
          </NativeTable>

          <div v-else-if="!documentsError" class="empty-state document-empty-state">
            <span class="document-empty-icon"><NativeIcon name="file" size="34" /></span>
            <strong>{{ currentCategoryId ? '当前分类还没有文档' : '还没有文档' }}</strong>
            <span>{{ currentCategoryId ? '可以上传到当前分类，或从左侧选择其他分类。' : '上传后可在这里预览内容、管理版本并查看资料索引状态。' }}</span>
            <NativeButton v-if="canWrite" theme="primary" @click="handleUpload">上传第一个文档</NativeButton>
          </div>

          <div class="pagination-wrapper" v-if="total > 0">
            <NativePagination
              v-model:current="pagination.current"
              v-model:pageSize="pagination.pageSize"
              :total="total"
              @change="handlePageChange"
            />
          </div>
        </section>
      </div>
    </NativeCard>

    <DocumentDetailDrawer
      v-model:visible="detailDrawerVisible"
      :document="detailDocument"
      :can-write="canWrite"
      :can-edit-content="canEditFile(detailDocument?.filePath)"
      :rag-refresh-loading="detailRagRefreshing"
      @preview="handleView"
      @download="handleDownload"
      @upload-version="openVersionUpload"
      @versions="handleViewVersions"
      @edit-info="handleChangeSingle"
      @edit-content="handleEdit"
      @refresh-index="refreshDocumentIndex"
      @delete="handleDeleteAndClose"
    />

    <!-- 批量编辑对话框 -->
    <DocumentMetadataDialog
      v-model:visible="batchEditDialogVisible"
      v-model:category-id="batchEditForm.categoryId"
      v-model:tags="batchEditForm.tags"
      :single="isSingleEdit"
      :categories="categoryTreeData"
      @confirm="handleBatchEditConfirm"
    />

    <!-- 创建分类对话框 -->
    <NativeDialog
      v-model="createCategoryDialogVisible"
      :title="createCategoryParent ? '创建子分类' : '创建分类'"
      :confirm-btn="{ content: '确认', theme: 'primary' }"
      width="500px"
      @confirm="handleCreateCategoryConfirm"
    >
      <NativeForm :modelValue="categoryForm" :rules="categoryRules">
        <NativeFormItem label="分类名称" name="name" required>
          <NativeInput v-model="categoryForm.name" placeholder="请输入分类名称" />
        </NativeFormItem>
        <NativeFormItem v-if="createCategoryParent" label="父分类">
          <NativeInput :modelValue="createCategoryParent.name" disabled />
        </NativeFormItem>
      </NativeForm>
    </NativeDialog>

    <!-- 删除分类确认对话框 -->
    <NativeDialog
      v-model="deleteCategoryDialogVisible"
      title="删除分类"
      width="550px"
      @confirm="handleDeleteCategoryConfirm"
    >
      <div class="delete-category-content">
        <p class="delete-warning">
          <NativeIcon name="warning-circle" style="color: var(--color-danger); margin-right: 8px;" />
          确定要删除分类「<strong>{{ deleteCategoryData?.name }}</strong>」吗？
        </p>
        <p class="delete-info">
          <NativeIcon name="info" style="color: var(--color-primary); margin-right: 8px;" />
          此操作将同时删除该分类下的所有子分类，但不会删除文档、版本或文件。
        </p>
        <NativeDivider />
        <p class="delete-question">文档将移到该分类的父分类；删除一级分类时，文档将变为未分类并继续显示在“全部文档”。</p>
      </div>
    </NativeDialog>

    <!-- 重命名分类对话框 -->
    <NativeDialog
      v-model="renameCategoryDialogVisible"
      title="重命名分类"
      width="400px"
      @confirm="handleRenameCategoryConfirm"
    >
      <NativeForm>
        <NativeFormItem label="分类名称">
          <NativeInput v-model="renameCategoryName" placeholder="请输入新的分类名称" />
        </NativeFormItem>
      </NativeForm>
      <p style="color: var(--color-text-muted); font-size: 12px; margin-top: 8px;">
        提示：同级分类下不能存在同名分类
      </p>
    </NativeDialog>

    <!-- 上传对话框 -->
    <NativeDialog
      v-model="uploadDialogVisible"
      title="上传文档"
      @confirm="handleUploadConfirm"
      width="760px"
      class="document-dialog document-upload-dialog"
      :class="{ 'drag-active': isDraggingFile }"
      @dragenter.prevent="handleDialogDragEnter"
      @dragover.prevent
      @dragleave.prevent="handleDialogDragLeave"
      @drop.prevent="handleFileDrop"
      :confirm-loading="uploading"
      :confirm-disabled="uploading || !canWrite"
      :close-btn="!uploading"
    >
      <div class="dialog-intro">
        <span class="dialog-intro-icon"><NativeIcon name="upload" size="20" /></span>
        <div><strong>添加新的资料原件</strong><span>上传成功后保留原文件，并自动进入资料索引流程。</span></div>
      </div>
      <NativeForm :modelValue="uploadForm" :rules="uploadRules" class="document-upload-form">
        <!-- 上传进度显示 -->
        <div v-if="uploading" class="upload-progress">
          <NativeIcon name="spinner" spin size="24" />
          <div class="progress-text">
            <div class="progress-title">正在上传文件...</div>
            <div class="progress-info">请稍候，不要关闭对话框</div>
          </div>
        </div>
        
        <NativeFormItem label="文件" required>
          <div class="upload-area">
            <NativeUpload
              v-model="uploadForm.file"
              drag
              accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.xls,.xlsx,.csv,.jpg,.jpeg,.png,.gif,.bmp"
              :multiple="false"
              :autoUpload="false"
              :disabled="uploading"
              @change="onFileChange"
            />
          </div>
        </NativeFormItem>
        <NativeFormItem label="标题" name="title" required>
          <NativeInput v-model="uploadForm.title" placeholder="文档标题" :disabled="uploading" />
        </NativeFormItem>
        <NativeFormItem label="分类">
          <NativeTreeSelect
            v-model="uploadForm.categoryId"
            :data="categoryTreeData"
            placeholder="选择文档分类"
            :disabled="uploading"
          />
        </NativeFormItem>
        <NativeFormItem label="标签" name="tags">
          <NativeInput v-model="uploadForm.tags" placeholder="用逗号分隔" :disabled="uploading" />
        </NativeFormItem>
        <NativeFormItem label="版本说明" name="versionNote">
          <NativeTextarea
            v-model="uploadForm.versionNote"
            placeholder="本次更新的说明"
            :maxlength="500"
            :disabled="uploading"
          />
        </NativeFormItem>
      </NativeForm>
    </NativeDialog>

    <!-- 上传冲突对话框：必须由用户明确选择另建、新版本或取消 -->
    <NativeDialog
      v-model="uploadConflictDialogVisible"
      title="上传冲突"
      width="760px"
      :show-footer="false"
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
            name="pc-upload-conflict-candidate"
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

    <!-- 版本对话框 -->
    <NativeDialog
      v-model="versionsDialogVisible"
      title="版本历史"
      width="1080px"
      class="document-dialog version-history-dialog"
      :show-footer="false"
    >
      <div class="version-dialog-toolbar">
        <div class="version-view-switch" role="tablist" aria-label="版本视图">
          <button type="button" role="tab" :aria-selected="versionHistoryView === 'active'" :class="{ active: versionHistoryView === 'active' }" @click="versionHistoryView = 'active'">
            版本记录 <span>{{ versions.length }}</span>
          </button>
          <button type="button" role="tab" :aria-selected="versionHistoryView === 'trash'" :class="{ active: versionHistoryView === 'trash' }" @click="showVersionTrash">
            已删除版本 <span>{{ versionTrash.length }}</span>
          </button>
        </div>
        <NativeButton theme="primary" :disabled="!canWrite" @click="openVersionUpload">
          <template #icon><NativeIcon name="upload" /></template>
          上传新版本
        </NativeButton>
      </div>
      <p class="version-dialog-description">
        {{ versionHistoryView === 'active' ? '恢复历史版本会创建新的当前版本，不会覆盖或删除原记录。' : '这里保留已删除的历史版本；保护期内可以恢复，当前版本不会出现在此处。' }}
      </p>
      <NativeTable v-if="versionHistoryView === 'active'" :dataSource="versions" :columns="versionColumns" rowKey="id">
        <template #cell-version="{ row }">
          <span>{{ row.version ? (row.version.toString().includes('.') ? row.version : `${row.version}.0`) : '1.0' }}</span>
        </template>
        <template #cell-isCurrent="{ row }">
          <span v-if="row.isCurrent" class="version-current-label">当前版本</span>
          <span v-else>历史版本</span>
        </template>
        <template #cell-operation="{ row }">
          <NativeSpace wrap>
            <NativeButton variant="outline" size="small" @click="handleDownloadVersion(row)">
              <NativeIcon name="download" /> 下载
            </NativeButton>
            <template v-if="!row.isCurrent">
              <NativePopconfirm content="恢复此版本会创建一个新的当前版本，不会覆盖历史。确定恢复吗？" @confirm="handleRestoreVersion(row)">
              <template #trigger>
                <NativeButton theme="default" variant="outline" size="small" :disabled="!canWrite">恢复此版本</NativeButton>
              </template>
              </NativePopconfirm>
              <NativePopconfirm content="移入版本回收站后可在保护期内恢复，确定继续吗？" @confirm="handleDeleteVersion(row)">
                <template #trigger>
                  <NativeButton theme="danger" variant="outline" size="small" :disabled="!canWrite">移入版本回收站</NativeButton>
                </template>
              </NativePopconfirm>
            </template>
          </NativeSpace>
        </template>
      </NativeTable>
      <div v-else-if="versionTrashLoading" class="content-loading compact-loading">
        <NativeLoading size="small" text="加载已删除版本..." />
      </div>
      <div v-else-if="versionTrash.length === 0" class="version-trash-empty">
        <span><NativeIcon name="archive" size="28" /></span>
        <strong>没有已删除版本</strong>
        <p>从版本记录移除的历史版本会在保护期内显示在这里。</p>
      </div>
      <div v-else class="version-trash-list">
        <div v-for="row in versionTrash" :key="row.id" class="version-trash-item">
          <span class="version-trash-number">v{{ row.version }}</span>
          <div><strong>{{ row.note || '无版本说明' }}</strong><span>删除于 {{ formatDateTime(row.deletedAt || row.trashedAt) }}</span></div>
          <NativeButton v-if="!row.isCurrent" size="small" variant="outline" @click="handleRestoreVersionTrash(row)" :disabled="!canWrite">
            恢复版本
          </NativeButton>
        </div>
      </div>
    </NativeDialog>

    <NativeDialog
      v-model="versionUploadDialogVisible"
      title="上传新版本"
      width="720px"
      class="document-dialog version-upload-dialog"
      :confirm-loading="versionUploading"
      :confirm-disabled="versionUploading || !canWrite"
      @confirm="submitVersionUpload"
    >
      <div class="dialog-intro dialog-intro--info">
        <span class="dialog-intro-icon"><NativeIcon name="info" size="20" /></span>
        <div><strong>文档身份保持不变</strong><span>文件类型需一致；新文件成为当前版本，标题、分类和标签不变，旧版本仍可下载或恢复。</span></div>
      </div>
      <NativeForm class="version-upload-form" label-width="112px">
        <NativeFormItem label="新版本文件" required>
          <NativeUpload
            v-model="versionUploadFiles"
            drag
            accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.xls,.xlsx,.csv,.jpg,.jpeg,.png,.gif,.bmp"
            :multiple="false"
            :autoUpload="false"
            :disabled="versionUploading"
          />
        </NativeFormItem>
        <NativeFormItem label="版本说明">
          <NativeTextarea
            v-model="versionUploadNote"
            placeholder="说明本次变更内容"
            :maxlength="500"
            :disabled="versionUploading"
          />
        </NativeFormItem>
      </NativeForm>
    </NativeDialog>

    <!-- 编辑对话框 -->
    <NativeDialog
      v-model="editDialogVisible"
      :title="editForm ? `编辑文档 - ${editForm.fileName || ''}` : '编辑文档'"
      width="1000px"
      @confirm="handleSaveContent"
    >
      <div v-if="editLoading" class="loading-container">
        <NativeLoading text="加载中..." />
      </div>
      <div v-else class="edit-container">
        <NativeForm layout="inline" style="margin-bottom: 16px;">
          <NativeFormItem label="当前版本">
            <NativeInput :modelValue="editForm.currentVersion" disabled style="width: 100px" />
          </NativeFormItem>
          <NativeFormItem label="版本说明">
            <NativeInput
              v-model="editForm.versionNote"
              placeholder="本次更新的说明"
              style="width: 300px"
            />
          </NativeFormItem>
        </NativeForm>
        <div class="editor-wrapper">
          <textarea
            v-model="editForm.content"
            class="editor-textarea"
            :style="{ 'font-family': getFileFont(editForm.fileName || '') }"
            spellcheck="false"
          />
        </div>
        <div class="editor-footer">
          <span class="file-info">文件名: {{ editForm.fileName || '' }}</span>
          <span class="file-info">行数: {{ lineCount }}</span>
        </div>
      </div>
    </NativeDialog>

    <DocumentPreviewDialog ref="previewDialog" @download="handleDownload" />

  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '@/api'
import { authenticatedAssetUrl } from '@/utils/authentication'
import { documentTagsLabel } from '@/utils/documentTags'
import {
  parseDocumentListRouteState,
  serializeDocumentListRouteState
} from '@/utils/documentListRouteState'
import {
  collectExpandableCategoryIds,
  documentFileIcon,
  documentFileTone,
  flattenVisibleDocumentCategories
} from '@/utils/documentWorkbench'
import { usePermission } from '@/composables/usePermission'
import { useToast } from '@/composables/useToast'
import { 
  NativeButton, NativeInput, NativeCard, NativeDialog, NativeRow, NativeCol, 
  NativeCheckbox, NativeLoading, NativeIcon, NativeSpace,
  NativeSelect, NativeForm, NativeFormItem, NativeDateRangePicker, NativePopconfirm,
  NativeAlert, NativeTable, NativePagination, NativeUpload, NativeTextarea, NativeDivider,
  NativeTreeSelect, NativeTag
} from '@/components/native'
import DocumentDetailDrawer from '@/pc/components/documents/DocumentDetailDrawer.vue'
import DocumentMetadataDialog from '@/pc/components/documents/DocumentMetadataDialog.vue'
import DocumentPreviewDialog from '@/pc/components/documents/DocumentPreviewDialog.vue'

const toast = useToast()
const route = useRoute()
const router = useRouter()
const { isGuest, canWrite } = usePermission()

const loading = ref(false)
const documents = ref([])
const documentsError = ref('')
const total = ref(0)
const totalAllDocuments = ref(0)
const pagination = ref({ current: 1, pageSize: 30 })
const versions = ref([])
const versionDocumentId = ref(null)
const versionUploadDialogVisible = ref(false)
const versionUploadFiles = ref([])
const versionUploadNote = ref('')
const versionUploading = ref(false)
const versionTrash = ref([])
const versionTrashLoading = ref(false)
const versionHistoryView = ref('active')
const uploadDialogVisible = ref(false)
const uploadConflictDialogVisible = ref(false)
const uploadConflict = ref(null)
const selectedUploadConflictCandidateId = ref(null)
const versionsDialogVisible = ref(false)
const createCategoryDialogVisible = ref(false)
const createCategoryParent = ref(null)
const deleteCategoryDialogVisible = ref(false)
const deleteCategoryData = ref(null)
const renameCategoryDialogVisible = ref(false)
const renameCategoryData = ref(null)
const renameCategoryName = ref('')
const searchKeyword = ref('')
const folderRailCollapsed = ref(false)
const categoriesError = ref('')
const detailDrawerVisible = ref(false)
const detailDocument = ref(null)
const detailRagRefreshing = ref(false)
const ragStatusById = ref(new Map())
const ragCoverageComplete = ref(false)
const previewDialog = ref(null)

// 浏览模式
const viewMode = ref('category') // category, list
const categories = ref([])
const expandedCategoryIds = ref(new Set())
let categoryExpansionInitialized = false
const currentCategoryId = ref(null) // 当前选中的分类ID
const categoryPath = ref([]) // 当前分类路径
const categoryFileCount = ref({}) // 分类文件数量缓存
const currentCategoryPath = computed(() => {
  return categoryPath.value.map(c => c.name).join(' / ')
})

const flattenedCategories = computed(() => (
  flattenVisibleDocumentCategories(categories.value, expandedCategoryIds.value)
))

// 分类悬停相关状态
const hoveredCategoryId = ref(null)
// fileCount 现在从后端分类数据中获取，不再需要额外的状态存储

// 拖拽相关状态
const draggedCategoryId = ref(null)
const draggedCategoryIndex = ref(null)
const draggedCategoryData = ref(null)
const isDraggingFile = ref(false) // 上传对话框拖拽状态
const uploading = ref(false) // 上传进度状态

const uploadForm = ref({
  file: [],
  title: '',
  categoryId: null,
  category: '',
  subcategory: '',
  tags: '',
  versionNote: ''
})

const categoryForm = ref({
  name: ''
})

const categoryRules = {
  name: [{ required: true, message: '请输入分类名称', type: 'error' }]
}

const editForm = ref({
  id: null,
  fileName: '',
  content: '',
  versionNote: '',
  currentVersion: '1.0',
})

const editDialogVisible = ref(false)
const editLoading = ref(false)

const uploadRules = {
  title: [{ required: true, message: '请输入标题', type: 'error' }],
  file: [{ required: true, message: '请选择文件', type: 'error' }]
}

const selectedUploadConflictCandidate = computed(() => {
  const candidates = uploadConflict.value?.candidates || []
  return candidates.find(candidate => String(candidate.id) === String(selectedUploadConflictCandidateId.value)) || null
})

// 排序相关状态
const sortBy = ref('updated_at')
const sortOrder = ref('desc')

// 字段映射：列 colKey -> 后端字段名
const sortFieldMap = {
  'title': 'title',
  'type': 'file_type',
  'updatedAt': 'updated_at'
}

const selectedRowKeys = ref([])
const allDocumentIds = ref([])  // 所有文档ID（用于跨页全选）
const batchEditDialogVisible = ref(false)
const isSingleEdit = ref(false)
const singleEditId = ref(null)
const batchEditForm = ref({
  categoryId: '',
  tags: ''
})

// 高级搜索相关
const advancedSearchVisible = ref(false)
const selectedTags = ref([])
const dateRange = ref([])
const allTags = ref([])
const activeDocumentFilterCount = computed(() => (
  (selectedTags.value.length > 0 ? 1 : 0)
  + (dateRange.value?.length === 2 ? 1 : 0)
))

// 分类树数据（用于树形选择器）
const categoryTreeData = computed(() => {
  const buildTree = (categories) => {
    return categories.map(cat => ({
      value: cat.id,
      label: cat.name,
      children: cat.subcategories && cat.subcategories.length > 0 ? buildTree(cat.subcategories) : undefined
    }))
  }
  return buildTree(categories.value)
})

// 处理表格多选
function handleSelectChange(selectedKeys) {
  selectedRowKeys.value = selectedKeys
}

const allCurrentPageSelected = computed(() => (
  allDocumentIds.value.length > 0
  && allDocumentIds.value.every(id => selectedRowKeys.value.includes(id))
))

function toggleCurrentPageSelection() {
  selectedRowKeys.value = allCurrentPageSelected.value ? [] : [...allDocumentIds.value]
}

const currentSubcategories = computed(() => {
  if (!currentCategoryId.value) return []
  const currentCat = findCategoryById(categories.value, currentCategoryId.value)
  return currentCat?.subcategories || []
})

// 处理排序方式变化（下拉选择框）
function handleDropdownSortChange() {
  pagination.value.current = 1
  loadDocuments()
}

// 处理表头排序变化
function handleSortChange(context) {
  console.log('[表头排序] 完整参数:', context)
  
  // TDesign 排序参数可能是：{ sort: {...} } 或直接是排序对象
  // 取消排序时可能是 undefined 或 { sortBy: undefined }
  const sort = context?.sort || context
  
  if (!sort || !sort.sortBy) {
    console.log('[表头排序] 取消排序，恢复默认排序')
    // 取消排序时，恢复默认排序（更新时间降序）
    sortBy.value = 'updated_at'
    sortOrder.value = 'desc'
    pagination.value.current = 1
    loadDocuments()
    return
  }

  const field = sortFieldMap[sort.sortBy] || sort.sortBy
  if (!field) return

  sortBy.value = field
  sortOrder.value = sort.descending ? 'desc' : 'asc'
  pagination.value.current = 1
  loadDocuments()
}

// 切换排序顺序
function toggleSortOrder() {
  sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc'
  pagination.value.current = 1
  loadDocuments()
}

// 批量编辑相关函数
function handleBatchEdit() {
  isSingleEdit.value = false
  batchEditForm.value = {
    categoryId: '',
    tags: ''
  }
  batchEditDialogVisible.value = true
}

function handleChangeSingle(row) {
  isSingleEdit.value = true
  singleEditId.value = row.id
  batchEditForm.value = {
    categoryId: row.categoryId || '',
    tags: row.tags || ''
  }
  batchEditDialogVisible.value = true
}

async function handleBatchEditConfirm() {
  const ids = isSingleEdit.value ? [singleEditId.value] : selectedRowKeys.value
  
  if (ids.length === 0) {
    toast.warning('请选择要编辑的文档')
    return
  }

  try {
    const updateData = { ids }
    
    if (batchEditForm.value.categoryId) updateData.categoryId = Number(batchEditForm.value.categoryId)
    if (batchEditForm.value.tags) {
      updateData.tags = batchEditForm.value.tags
    }

    const response = await api.documents.batchUpdate(updateData)
    toast.success(response.data?.message || (isSingleEdit.value ? '更改成功' : '批量更新成功'))
    batchEditDialogVisible.value = false
    selectedRowKeys.value = []
    // 清除文件数量缓存，以便悬停时重新加载
    categoryFileCount.value = {}
    await loadDocumentCoverage()
    await Promise.all([loadDocuments(), loadAllTags(), loadCategories()])
  } catch (error) {
    console.error('更新失败:', error)
    toast.error(documentErrorMessage(error, '更新失败'))
  }
}

async function handleBatchDelete() {
  if (selectedRowKeys.value.length === 0) {
    toast.warning('请选择要删除的文档')
    return
  }

  try {
    await Promise.all(selectedRowKeys.value.map(id => api.documents.delete(id)))
    toast.success('批量删除成功')
    selectedRowKeys.value = []
    await loadDocumentCoverage()
    await Promise.all([loadDocuments(), loadCategories(), loadAllTags()])
  } catch (error) {
    console.error('批量删除失败:', error)
    toast.error('批量删除失败')
  }
}

// 高级搜索相关函数
async function loadAllTags() {
  try {
    const response = await api.documents.getTags()
    allTags.value = response.data?.data || []
  } catch (error) {
    console.error('加载标签失败:', error)
  }
}

function handleAdvancedSearch() {
  pagination.value.current = 1
  loadDocuments()
}

function resetAdvancedSearch() {
  selectedTags.value = []
  dateRange.value = []
  pagination.value.current = 1
  loadDocuments()
}

function findCategoryById(categories, id) {
  if (!Array.isArray(categories)) return null
  for (const cat of categories) {
    if (!cat) continue
    if (cat.id === id) return cat
    if (cat.subcategories && Array.isArray(cat.subcategories) && cat.subcategories.length > 0) {
      const found = findCategoryById(cat.subcategories, id)
      if (found) return found
    }
  }
  return null
}

function findCategoryTrail(categories, id, trail = []) {
  for (const category of Array.isArray(categories) ? categories : []) {
    const nextTrail = [...trail, category]
    if (Number(category.id) === Number(id)) return nextTrail
    const nested = findCategoryTrail(category.subcategories, id, nextTrail)
    if (nested.length > 0) return nested
  }
  return []
}

const columns = computed(() => [
  { key: 'title', dataIndex: 'title', title: '标题', width: 340, minWidth: 280, maxWidth: 380, sorter: true },
  { key: 'tags', dataIndex: 'tags', title: '标签', width: 180, minWidth: 140 },
  { key: 'version', dataIndex: 'version', title: '版本', width: 80 },
  { key: 'type', dataIndex: 'filePath', title: '类型', width: 80, sorter: true },
  { key: 'indexStatus', dataIndex: 'indexStatus', title: '资料索引', width: 110 },
  { key: 'updatedAt', dataIndex: 'updatedAt', title: '更新时间', width: 180, sorter: true },
  { key: 'operation', title: '操作', width: 156, align: 'left', headerAlign: 'left' }
])

const versionColumns = [
  { key: 'version', dataIndex: 'version', title: '版本号', width: 90 },
  { key: 'isCurrent', dataIndex: 'isCurrent', title: '状态', width: 110 },
  { key: 'note', dataIndex: 'note', title: '说明', minWidth: 180 },
  { key: 'createdAt', dataIndex: 'createdAt', title: '创建时间', width: 180 },
  { key: 'operation', title: '操作', width: 300 }
]

const lineCount = computed(() => {
  if (!editForm.value || !editForm.value.content) return 0
  return editForm.value.content.split('\n').length
})

function hydrateDocumentListRouteState() {
  const state = parseDocumentListRouteState(route.query)
  currentCategoryId.value = state.categoryId
  searchKeyword.value = state.keyword
  selectedTags.value = state.tags
  dateRange.value = state.dateRange
  sortBy.value = state.sortBy
  sortOrder.value = state.sortOrder
  pagination.value = { current: state.page, pageSize: state.pageSize }
}

function syncDocumentListRouteState() {
  const query = serializeDocumentListRouteState({
    categoryId: currentCategoryId.value,
    keyword: searchKeyword.value,
    tags: selectedTags.value,
    dateRange: dateRange.value,
    sortBy: sortBy.value,
    sortOrder: sortOrder.value,
    page: pagination.value.current,
    pageSize: pagination.value.pageSize
  }, route.query)
  const current = JSON.stringify(route.query)
  if (JSON.stringify(query) !== current) void router.replace({ query })
}

async function loadDocuments() {
  loading.value = true
  documentsError.value = ''
  syncDocumentListRouteState()
  try {
    const params = { 
      keyword: searchKeyword.value,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
      page: pagination.value.current,
      pageSize: pagination.value.pageSize
    }

    if (currentCategoryId.value) {
      params.categoryId = currentCategoryId.value
      params.includeSubcategories = 'true'
    }

    // 高级搜索参数
    if (selectedTags.value.length > 0) {
      params.tags = selectedTags.value.join(',')
    }
    if (dateRange.value && dateRange.value.length === 2) {
      // 格式化日期为 YYYY-MM-DD HH:mm:ss 格式
      // 注意：用户选择的是本地时间（UTC+8），数据库存储的是 UTC 时间
      // 需要将本地时间转换为 UTC 时间
      const formatDateToUTC = (date) => {
        if (!date) return ''
        const d = new Date(date)
        const year = d.getUTCFullYear()
        const month = String(d.getUTCMonth() + 1).padStart(2, '0')
        const day = String(d.getUTCDate()).padStart(2, '0')
        const hours = String(d.getUTCHours()).padStart(2, '0')
        const minutes = String(d.getUTCMinutes()).padStart(2, '0')
        const seconds = String(d.getUTCSeconds()).padStart(2, '0')
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
      }
      params.startDate = formatDateToUTC(dateRange.value[0])
      params.endDate = formatDateToUTC(dateRange.value[1])
      console.log('日期范围搜索（UTC）:', params.startDate, '至', params.endDate)
    }

    const response = await api.documents.list(params)
    console.log('加载文档响应:', response)
    const data = response.data?.data || response.data || []
    total.value = response.data?.total || 0

    documents.value = (Array.isArray(data) ? data : []).map(doc => ({
      id: doc.id,
      title: doc.title,
      categoryId: doc.categoryId,
      category: doc.category,
      subcategory: doc.subcategory || '',
      tags: documentTagsLabel(doc.tags),
      version: doc.version,
      filePath: doc.filePath,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      size: doc.size || 0,
      indexStatus: ragStatusById.value.get(Number(doc.id)) || (ragCoverageComplete.value ? 'missing' : 'unknown')
    }))

    // 批量操作只针对当前页，避免每次列表刷新额外拉取全部资源。
    allDocumentIds.value = documents.value.map(doc => doc.id)
    selectedRowKeys.value = selectedRowKeys.value.filter(id => allDocumentIds.value.includes(id))
    if (!currentCategoryId.value && !searchKeyword.value && selectedTags.value.length === 0 && (dateRange.value?.length || 0) === 0) {
      totalAllDocuments.value = total.value
    }

    // 排序已在后端完成，无需前端再排序
  } catch (error) {
    console.error('加载文档失败:', error)
    documentsError.value = documentErrorMessage(error, '暂时无法加载文档，请稍后重试。')
    documents.value = []
    total.value = 0
    allDocumentIds.value = []
  } finally {
    loading.value = false
  }
}

async function loadCategories() {
  categoriesError.value = ''
  try {
    const response = await api.documents.categories()
    console.log('分类响应:', response)
    const nextCategories = response.data?.data || []
    const expandableIds = collectExpandableCategoryIds(nextCategories)
    if (!categoryExpansionInitialized) {
      expandedCategoryIds.value = new Set()
      categoryExpansionInitialized = true
    } else {
      expandedCategoryIds.value = new Set(
        [...expandedCategoryIds.value].filter(id => expandableIds.has(id))
      )
    }
    categories.value = nextCategories
    if (currentCategoryId.value) {
      const trail = findCategoryTrail(nextCategories, currentCategoryId.value)
      if (trail.length > 0) categoryPath.value = trail
      else {
        currentCategoryId.value = null
        categoryPath.value = []
      }
    }
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
  } catch (error) {
    console.error('加载文档索引覆盖状态失败:', error)
    ragCoverageComplete.value = false
  }
  documents.value = documents.value.map(document => ({
    ...document,
    indexStatus: ragStatusById.value.get(Number(document.id)) || (ragCoverageComplete.value ? 'missing' : 'unknown')
  }))
  if (detailDocument.value) {
    detailDocument.value = documents.value.find(document => document.id === detailDocument.value.id)
      || { ...detailDocument.value, indexStatus: ragStatusById.value.get(Number(detailDocument.value.id)) || 'unknown' }
  }
}

function handleViewModeChange(mode) {
  if (mode === 'trash' || viewMode.value === 'trash') {
    viewMode.value = 'category'
    void router.push({ name: 'Trash', query: { type: 'document' } })
    return
  }
  currentCategoryId.value = null
  categoryPath.value = []
  documents.value = []
  loadDocuments()
}

// 统一搜索处理
function handleSearch() {
  pagination.value.current = 1
  loadDocuments()
}

// 分页处理
function handlePageChange() {
  loadDocuments()
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

function handlePageSizeChange() {
  pagination.value.current = 1
  loadDocuments()
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

function enterCategory(category) {
  categoryPath.value.push(category)
  currentCategoryId.value = category.id
  loadDocuments()
}

function selectCategoryFromRail(item) {
  const trail = Array.isArray(item?.trail) ? item.trail : []
  categoryPath.value = trail
  currentCategoryId.value = trail.at(-1)?.id || null
  pagination.value.current = 1
  selectedRowKeys.value = []
  loadDocuments()
}

function toggleCategoryExpansion(categoryId) {
  const next = new Set(expandedCategoryIds.value)
  if (next.has(categoryId)) next.delete(categoryId)
  else next.add(categoryId)
  expandedCategoryIds.value = next
}

function resetCategory() {
  if (categoryPath.value.length > 1) {
    // 返回上一级
    categoryPath.value.pop()
    currentCategoryId.value = categoryPath.value[categoryPath.value.length - 1]?.id || null
  } else {
    // 返回根目录
    categoryPath.value = []
    currentCategoryId.value = null
  }
  loadDocuments()
}

function backToRoot() {
  categoryPath.value = []
  currentCategoryId.value = null
  pagination.value.current = 1
  selectedRowKeys.value = []
  loadDocuments()
}

function handleCreateCategory() {
  createCategoryParent.value = null
  categoryForm.value = { name: '' }
  createCategoryDialogVisible.value = true
}

function handleCreateSubcategory(category) {
  createCategoryParent.value = {
    id: category.id,
    name: category.name
  }
  categoryForm.value = { name: '' }
  createCategoryDialogVisible.value = true
}

async function handleCreateCategoryConfirm() {
  try {
    if (!categoryForm.value.name || !categoryForm.value.name.trim()) {
      toast.error('请输入分类名称')
      return
    }

    const parentId = createCategoryParent.value?.id || null
    await api.documents.createCategory({
      name: categoryForm.value.name.trim(),
      parentId
    })

    if (parentId) {
      expandedCategoryIds.value = new Set([...expandedCategoryIds.value, parentId])
    }
    toast.success('创建成功')
    createCategoryDialogVisible.value = false
    createCategoryParent.value = null
    await loadCategories()
  } catch (error) {
    console.error('创建分类失败:', error)
    toast.error(error.response?.data?.message || '创建失败')
  }
}

function handleDeleteCategory(category) {
  deleteCategoryData.value = category
  deleteCategoryDialogVisible.value = true
}

async function handleDeleteCategoryConfirm() {
  try {
    if (!deleteCategoryData.value) return

    const response = await api.documents.deleteCategory(deleteCategoryData.value.id)

    toast.success(response.data?.message || '分类已删除，文档已移到父分类或未分类')
    deleteCategoryDialogVisible.value = false
    deleteCategoryData.value = null

    // 刷新分类和文档列表
    await loadDocumentCoverage()
    await Promise.all([loadCategories(), loadDocuments()])
    // 清除文件数量缓存
    categoryFileCount.value = {}
  } catch (error) {
    console.error('删除分类失败:', error)
    toast.error(error.response?.data?.message || '删除失败')
  }
}

function handleRenameCategory(category) {
  renameCategoryData.value = category
  renameCategoryName.value = category.name
  renameCategoryDialogVisible.value = true
}

async function handleRenameCategoryConfirm() {
  try {
    if (!renameCategoryData.value) return
    if (!renameCategoryName.value || !renameCategoryName.value.trim()) {
      toast.error('请输入分类名称')
      return
    }

    const response = await api.documents.updateCategory(renameCategoryData.value.id, {
      name: renameCategoryName.value.trim()
    })

    toast.success(response.data?.message || '重命名成功')
    renameCategoryDialogVisible.value = false
    renameCategoryData.value = null

    // 刷新分类和文档列表
    await loadDocumentCoverage()
    await Promise.all([loadCategories(), loadDocuments()])
    // 清除文件数量缓存
    categoryFileCount.value = {}
  } catch (error) {
    console.error('重命名分类失败:', error)
    toast.error(error.response?.data?.message || '重命名失败')
  }
}

function handleUpload() {
  if (!canWrite.value) return
  uploadConflictDialogVisible.value = false
  uploadConflict.value = null
  selectedUploadConflictCandidateId.value = null
  uploadForm.value = {
    file: [],
    title: '',
    categoryId: null,
    category: '',
    subcategory: '',
    tags: '',
    versionNote: ''
  }

  // 自动填充当前分类
  if (currentCategoryId.value) {
    const currentCat = findCategoryById(categories.value, currentCategoryId.value)
    if (currentCat) {
      uploadForm.value.categoryId = currentCat.id
      // 将分类路径拆分为 category 和 subcategory
      const pathParts = currentCat.path.split('/')
      uploadForm.value.category = pathParts[0]
      uploadForm.value.subcategory = pathParts.length > 1 ? pathParts.slice(1).join('/') : ''
    }
  }

  uploadDialogVisible.value = true
}

function onFileChange(files) {
  if (files.length > 0) {
    const fileName = files[0].name
    uploadForm.value.title = fileName.replace(/\.[^/.]+$/, '')
  }
}

function documentErrorMessage(error, fallback) {
  const message = error?.response?.data?.message
  return typeof message === 'string' && message.trim() ? message : fallback
}

function ragStatusLabel(status) {
  return ({
    ready: '可问',
    partial: '部分可问',
    pending: '索引中',
    stale: '待刷新',
    failed: '索引失败',
    missing: '未索引',
    unknown: '状态未知'
  })[status] || '状态未知'
}

function ragStatusTheme(status) {
  if (status === 'ready') return 'success'
  if (status === 'partial' || status === 'pending') return 'primary'
  if (status === 'stale' || status === 'missing') return 'warning'
  if (status === 'failed') return 'danger'
  return 'default'
}

function ragStatusDescription(status) {
  return ({
    ready: '正文和向量索引均已就绪，可在统一搜索中绑定此文档问答。',
    partial: '部分索引已可用，回答范围可能不完整。',
    pending: '索引任务已进入任务中心，完成后可绑定此文档问答。',
    stale: '文档已更新，当前索引等待刷新。',
    failed: '最近一次索引任务失败，可重新建立索引并在任务中心查看原因。',
    missing: '尚未为此文档建立资料索引。',
    unknown: '暂时无法读取索引状态，不影响文档预览和下载。'
  })[status] || '暂时无法读取索引状态。'
}

function documentCategoryLabel(document) {
  if (!document?.category) return '未分类'
  return document.subcategory ? `${document.category} / ${document.subcategory}` : document.category
}

function openDocumentDetails(row) {
  detailDocument.value = row
  detailDrawerVisible.value = true
}

function openTrashPage() {
  void router.push({ name: 'Trash', query: { type: 'document' } })
}

async function refreshDocumentIndex(row) {
  if (!row?.id || detailRagRefreshing.value || !canWrite.value) return
  detailRagRefreshing.value = true
  try {
    const response = await api.rag.refreshIndex({
      source: { type: 'document', id: row.id },
      filter: { sourceIds: [row.id] },
      rebuild: true
    })
    if (!response.data?.data?.id) throw new Error('missing task id')
    ragStatusById.value.set(Number(row.id), 'pending')
    documents.value = documents.value.map(document => (
      document.id === row.id ? { ...document, indexStatus: 'pending' } : document
    ))
    detailDocument.value = { ...row, indexStatus: 'pending' }
    toast.success('索引刷新已加入任务中心')
  } catch (error) {
    const message = error?.response?.status === 409
      ? '此文档已有索引任务正在运行'
      : documentErrorMessage(error, '无法启动索引刷新任务')
    toast.error(message)
  } finally {
    detailRagRefreshing.value = false
  }
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
  if (!canWrite.value || !uploadForm.value.file || uploadForm.value.file.length === 0) {
    if (!uploadForm.value.file || uploadForm.value.file.length === 0) toast.error('请选择文件')
    return false
  }

  uploading.value = true
  try {
    const file = uploadForm.value.file[0]
    const formData = new FormData()
    const fileToUpload = file.raw || file.originFileObj || file
    formData.append('file', fileToUpload)
    formData.append('title', title)
    if (uploadForm.value.categoryId) formData.append('categoryId', String(uploadForm.value.categoryId))
    formData.append('category', uploadForm.value.category)
    formData.append('subcategory', uploadForm.value.subcategory)
    formData.append('tags', uploadForm.value.tags)
    formData.append('versionNote', uploadForm.value.versionNote)
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
    categoryFileCount.value = {}
    await loadDocumentCoverage()
    await Promise.all([loadCategories(), loadAllTags(), loadDocuments()])
    return true
  } catch (error) {
    if (!resolution && error?.response?.data?.code === 'DOCUMENT_UPLOAD_CONFLICT') {
      openUploadConflict(error)
    } else {
      console.error('上传错误:', error)
      toast.error(documentErrorMessage(error, '上传失败'))
    }
    return false
  } finally {
    uploading.value = false
  }
}

async function handleUploadConfirm() {
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

function handleView(row) {
  if (!row || !row.id) {
    toast.error('无法预览，文档ID不存在')
    return
  }
  void previewDialog.value?.open(row)
}

function handleDownload(row) {
  window.open(authenticatedAssetUrl(`/api/documents/download/${row.id}`), '_blank')
}

function handleDownloadVersion(row) {
  window.open(authenticatedAssetUrl(`/api/documents/download/version/${row.id}`), '_blank')
}

async function handleEdit(row) {
  // 检查文件是否可编辑
  if (!canEditFile(row.filePath)) {
    const ext = row.filePath?.split('.').pop()?.toLowerCase()
    toast.warning(`此文件格式不支持编辑: ${ext}\n支持的编辑格式: txt, md, json, xml, html, css, js, ts, py, java, c, cpp, h, go, rs, sql, sh, bat, yml, yaml, csv`)
    return
  }

  try {
    editDialogVisible.value = true
    editLoading.value = true
    editForm.value = {
      id: row.id,
      fileName: '',
      content: '',
      versionNote: '',
      currentVersion: row.version ? row.version.toString() : '1.0'
    }

    const response = await api.documents.getContent(row.id)
    console.log('文档内容响应:', response)
    console.log('响应数据:', response.data)

    const data = response.data
    editForm.value.content = (data && data.content) || ''
    editForm.value.fileName = (data && data.fileName) || ''
  } catch (error) {
    console.error('加载文档内容失败:', error)
    console.error('错误响应:', error.response?.data)
    if (error.response?.status === 400) {
      toast.error(error.response?.data?.message || '不支持编辑此文件格式')
    } else if (error.response?.status === 404) {
      toast.error('文件不存在，无法编辑')
    } else {
      toast.error('加载文档内容失败')
    }
    editDialogVisible.value = false
  } finally {
    editLoading.value = false
  }
}

function canEditFile(fileName) {
  if (!fileName) return false
  const ext = fileName.split('.').pop().toLowerCase()
  const editableExtensions = ['txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'sql', 'sh', 'bat', 'yml', 'yaml', 'csv']
  return editableExtensions.includes(ext)
}

async function handleSaveContent() {
  try {
    if (!editForm.value.content.trim()) {
      toast.error('内容不能为空')
      return
    }

    const response = await api.documents.updateContent(editForm.value.id, {
      content: editForm.value.content,
      versionNote: editForm.value.versionNote
    })

    toast.success(response.data?.message || '保存成功')
    editDialogVisible.value = false
    await loadDocumentCoverage()
    await loadDocuments()
  } catch (error) {
    console.error('保存失败:', error)
    toast.error(error.response?.data?.message || '保存失败')
  }
}

function getFileExtension(fileName) {
  if (!fileName) return ''
  const parts = fileName.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : ''
}

function getFileFont(fileName) {
  if (!fileName || typeof fileName !== 'string') return "'Courier New', monospace"

  const parts = fileName.split('.')
  if (parts.length < 2) return "'Courier New', monospace"

  const ext = parts.pop().toLowerCase()
  const fontMap = {
    'js': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'ts': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'json': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'css': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'html': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'md': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'py': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'java': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'c': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'cpp': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'go': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'rs': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'sql': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'xml': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'yml': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'yaml': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'sh': "'Fira Code', 'Monaco', 'Courier New', monospace",
    'bat': "'Consolas', 'Courier New', monospace"
  }

  return fontMap[ext] || "'Courier New', monospace"
}

async function handleDelete(id) {
  try {
    const response = await api.documents.delete(id)
    toast.success(response.data?.message || '文档已移入回收站')
    await Promise.all([loadCategories(), loadAllTags(), loadDocumentCoverage()])
    await loadDocuments()
    return true
  } catch (error) {
    toast.error(documentErrorMessage(error, '移入回收站失败'))
    return false
  }
}

async function handleDeleteAndClose(id) {
  if (await handleDelete(id)) {
    detailDrawerVisible.value = false
    detailDocument.value = null
  }
}

async function loadActiveVersions() {
  if (!versionDocumentId.value) return
  const response = await api.documents.versions(versionDocumentId.value)
  const data = response.data?.data || response.data || []
  versions.value = Array.isArray(data) ? data : []
}

async function handleViewVersions(row) {
  versionDocumentId.value = row.id
  versionHistoryView.value = 'active'
  versionsDialogVisible.value = true
  try {
    await Promise.all([loadActiveVersions(), loadVersionTrash()])
  } catch (error) {
    console.error('加载版本失败:', error)
    toast.error(documentErrorMessage(error, '加载版本失败'))
  }
}

function openVersionUpload(row = null) {
  const id = Number(row?.id || versionDocumentId.value)
  if (!Number.isSafeInteger(id) || id <= 0 || !canWrite.value) return
  versionDocumentId.value = id
  versionUploadFiles.value = []
  versionUploadNote.value = ''
  versionUploadDialogVisible.value = true
}

async function submitVersionUpload() {
  if (versionUploading.value || !canWrite.value) return false
  const uploadEntry = versionUploadFiles.value?.[0]
  if (!uploadEntry) {
    toast.error('请选择新版本文件')
    return false
  }
  versionUploading.value = true
  try {
    const file = uploadEntry.raw || uploadEntry.originFileObj || uploadEntry
    const formData = new FormData()
    formData.append('file', file)
    formData.append('versionNote', versionUploadNote.value)
    const response = await api.documents.uploadVersion(versionDocumentId.value, formData)
    toast.success(response.data?.message || '新版本上传成功')
    versionUploadDialogVisible.value = false
    await loadDocuments()
    await loadDocumentCoverage()
    if (versionsDialogVisible.value) {
      await handleViewVersions({ id: versionDocumentId.value })
    }
    return true
  } catch (error) {
    toast.error(documentErrorMessage(error, '新版本上传失败'))
    return false
  } finally {
    versionUploading.value = false
  }
}

async function handleRestoreVersion(row) {
  if (!versionDocumentId.value || row?.isCurrent || !canWrite.value) return
  try {
    const response = await api.documents.restoreVersion(versionDocumentId.value, row.id)
    toast.success(response.data?.message || '版本恢复成功，已创建新的当前版本')
    await loadDocumentCoverage()
    await Promise.all([loadActiveVersions(), loadVersionTrash(), loadDocuments()])
  } catch (error) {
    console.error('恢复版本失败:', error)
    toast.error(documentErrorMessage(error, '恢复版本失败'))
  }
}

async function handleDeleteVersion(row) {
  if (!versionDocumentId.value || row?.isCurrent || !canWrite.value) return
  try {
    await api.documents.deleteVersion(versionDocumentId.value, row.id)
    toast.success('版本已移入回收站')
    await Promise.all([loadActiveVersions(), loadVersionTrash()])
  } catch (error) {
    console.error('移入版本回收站失败:', error)
    toast.error(documentErrorMessage(error, '移入版本回收站失败'))
  }
}

async function loadVersionTrash() {
  if (!versionDocumentId.value) return
  versionTrashLoading.value = true
  try {
    const response = await api.documents.versionsTrash(versionDocumentId.value)
    const data = response.data?.data || response.data || []
    versionTrash.value = Array.isArray(data) ? data : []
  } catch (error) {
    console.error('加载版本回收站失败:', error)
    toast.error(documentErrorMessage(error, '加载版本回收站失败'))
    versionTrash.value = []
  } finally {
    versionTrashLoading.value = false
  }
}

async function showVersionTrash() {
  versionHistoryView.value = 'trash'
  await loadVersionTrash()
}

async function handleRestoreVersionTrash(row) {
  if (!versionDocumentId.value || !row?.id || !canWrite.value) return
  try {
    const response = await api.documents.restoreVersionTrash(versionDocumentId.value, row.id)
    toast.success(response.data?.message || '版本已恢复，已创建新的当前版本')
    await loadDocumentCoverage()
    await Promise.all([
      loadVersionTrash(),
      loadActiveVersions(),
      loadDocuments()
    ])
  } catch (error) {
    console.error('恢复版本回收站条目失败:', error)
    toast.error(documentErrorMessage(error, '恢复版本失败'))
  }
}

function formatDateTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

async function handleCategoryHover(categoryId) {
  hoveredCategoryId.value = categoryId
  // 文件数量现在从后端分类数据中获取，不再需要额外请求
}

function handleCategoryLeave() {
  hoveredCategoryId.value = null
}

// 拖拽相关函数
function handleDragStart(event, category, index) {
  draggedCategoryId.value = category.id
  draggedCategoryIndex.value = index
  draggedCategoryData.value = category
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', category.id)
  event.target.style.opacity = '0.5'
}

function handleDragOver(event, category) {
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  if (draggedCategoryId.value !== category.id) {
    draggedCategoryId.value = category.id
  }
}

function handleDragLeave(event) {
  // 拖拽离开时重置样式
  draggedCategoryId.value = null
}

async function handleDrop(event, targetCategory, targetIndex) {
  event.preventDefault()
  event.stopPropagation()

  if (!draggedCategoryData.value || draggedCategoryData.value.id === targetCategory.id) {
    return
  }

  try {
    // 获取当前显示的分类列表
    const currentCategories = currentCategoryId.value ? currentSubcategories.value : categories.value
    const parentId = currentCategoryId.value || null

    // 重新排序
    const reorderedCategories = [...currentCategories]
    const [removed] = reorderedCategories.splice(draggedCategoryIndex.value, 1)
    reorderedCategories.splice(targetIndex, 0, removed)

    // 更新 sortOrder
    const orders = reorderedCategories.map((cat, idx) => ({
      id: cat.id,
      sortOrder: idx
    }))

    // 调用后端 API 更新排序
    await api.documents.reorderCategories({ orders })

    // 更新本地状态
    if (currentCategoryId.value) {
      // 更新子分类
      const parentCat = findCategoryById(categories.value, currentCategoryId.value)
      if (parentCat) {
        parentCat.subcategories = reorderedCategories
      }
    } else {
      // 更新根分类
      categories.value = reorderedCategories
    }

    toast.success('排序已更新')
  } catch (error) {
    console.error('更新排序失败:', error)
    toast.error('更新排序失败')
  } finally {
    // 清理拖拽状态
    draggedCategoryId.value = null
    draggedCategoryIndex.value = null
    draggedCategoryData.value = null
  }
}

function handleDragEnd(event) {
  event.target.style.opacity = '1'
  draggedCategoryId.value = null
  draggedCategoryIndex.value = null
  draggedCategoryData.value = null
}

function handleFileDrop(event) {
  event.preventDefault()
  isDraggingFile.value = false
  const files = event.dataTransfer.files
  if (files.length > 0) {
    const file = files[0]
    uploadForm.value.file = [{
      name: file.name,
      raw: file,
      url: URL.createObjectURL(file)
    }]
    if (!uploadForm.value.title) {
      uploadForm.value.title = file.name.replace(/\.[^/.]+$/, '')
    }
  }
}

function handleDialogDragEnter(event) {
  event.preventDefault()
  isDraggingFile.value = true
}

function handleDialogDragLeave(event) {
  event.preventDefault()
  isDraggingFile.value = false
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

onMounted(async () => {
  hydrateDocumentListRouteState()
  await Promise.all([loadCategories(), loadAllTags(), loadDocumentCoverage()])
  await loadDocuments()
  const documentId = Number(route.query.documentId)
  if (Number.isSafeInteger(documentId) && documentId > 0) {
    const row = documents.value.find((item) => Number(item.id) === documentId) || { id: documentId, title: `文档 ${documentId}` }
    await previewDialog.value?.open(row)
  }
})

</script>

<style scoped>
.documents {
  padding: 0;
}

.empty-state-inline {
  display: flex;
  min-height: 180px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 12px;
  color: #888;
}

/* 上传进度显示 */
.upload-progress {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  margin-bottom: 20px;
  background: linear-gradient(135deg, #e3f2fd 0%, #bbdefb 100%);
  border-radius: 8px;
  border-left: 4px solid #2196f3;
}

.upload-progress .native-icon {
  color: #2196f3;
}

.progress-text {
  flex: 1;
}

.progress-title {
  font-size: 16px;
  font-weight: 500;
  color: #1976d2;
  margin-bottom: 4px;
}

.progress-info {
  font-size: 14px;
  color: #64b5f6;
}

/* 内容区域加载状态 */
.content-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 300px;
}

.page-header {
  margin-bottom: 20px;
}

.page-header h2 {
  font-size: 28px;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0 0 8px 0;
}

.page-header p {
  font-size: 16px;
  color: var(--color-text-primary);
  margin: 0;
  font-weight: 500;
}

/* 工具栏 */
.toolbar {
  margin-bottom: 16px;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar-view-group {
  margin-right: 24px;
}

.toolbar-search {
  margin-right: 12px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.toolbar-row-second {
  margin-top: 12px;
  justify-content: space-between;
}

/* 统一工具栏按钮高度 */
.toolbar-row :deep(.native-radio-group),
.toolbar-row :deep(.native-radio--filled),
.toolbar-row :deep(.native-input),
.toolbar-row :deep(.native-select-trigger),
.toolbar-row :deep(.native-button) {
  height: 36px;
  line-height: 36px;
}

.toolbar-row :deep(.native-radio-group) {
  display: flex;
  align-items: center;
}

.toolbar-row :deep(.native-radio--filled) {
  display: flex;
  align-items: center;
  padding: 0 16px;
  line-height: 1;
}

.toolbar-row :deep(.native-input) {
  display: flex;
  align-items: center;
}

.toolbar-row :deep(.native-input__inner) {
  height: 36px;
}

.toolbar-row :deep(.native-select-trigger) {
  display: flex;
  align-items: center;
}

.toolbar-row :deep(.native-button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
}

.toolbar-row :deep(.native-button[shape="circle"]) {
  width: 36px;
  padding: 0;
}

/* 分类卡片区域操作栏 */
.category-actions-bar {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border-subtle);
  display: flex;
  gap: 12px;
}

/* 高级搜索面板 */
.advanced-search-panel {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border-subtle);
}

/* 可排序列样式 */
:deep(.sortable-col) {
  cursor: pointer;
}

:deep(.sortable-col:hover) {
  background-color: rgba(0, 82, 217, 0.05);
}

/* 分页样式 */
.pagination-wrapper {
  display: flex;
  justify-content: flex-end;
  padding: 16px 0 0 0;
}

/* 分类浏览 */
.category-view {
  margin-top: 16px;
}

.empty-categories {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  gap: 20px;
}

.empty-categories .native-icon {
  color: #d0d0d0;
}

.empty-categories h3 {
  font-size: 24px;
  color: var(--color-text-primary);
  margin: 0;
}

.empty-categories p {
  font-size: 16px;
  color: var(--color-text-secondary);
  margin: 0;
}

.category-children {
  padding: 16px 0;
}

.category-path {
  font-size: 18px;
  color: var(--color-text-primary);
  margin-bottom: 24px;
  padding-bottom: 12px;
  border-bottom: 2px solid var(--color-primary);
}

.categories-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 16px;
}

.category-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-active) 100%);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 3px 8px var(--color-primary-alpha-20);
  position: relative;
  user-select: none;
}

.category-card:hover {
  box-shadow: var(--shadow-md);
}

.category-card.drag-over {
  border: 2px dashed var(--color-primary);
  background: linear-gradient(135deg, #e8f0ff 0%, #f0e8ff 100%);
}

/* 分类操作按钮容器 - 右上角 */
.category-card .category-actions {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
  z-index: 10;
}

.category-card:hover .category-actions {
  opacity: 1;
}

.category-card .action-btn {
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.2s;
  color: white;
}

.category-card .action-btn .native-icon {
  color: white;
}

.category-card .action-btn:hover {
  background: rgba(255, 255, 255, 0.5);
}

.category-card .action-btn.rename-btn:hover {
  background: rgba(0, 82, 217, 0.6);
}

.category-card .action-btn.delete-btn:hover {
  background: rgba(227, 77, 89, 0.8);
}

/* 文件夹图标样式 */
.category-card .category-icon {
  color: white;
  margin-bottom: 12px;
  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));
}

.category-card .category-icon,
.category-card .category-icon svg,
.category-card .category-icon .native-icon {
  width: 32px !important;
  height: 32px !important;
  min-width: 32px !important;
  min-height: 32px !important;
}

.category-card h3 {
  margin: 6px 0;
  font-size: 16px;
  color: white;
  font-weight: 600;
}

.category-card p {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
}

.file-count-tooltip {
  position: absolute;
  bottom: 4px;
  right: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 4px;
  pointer-events: none;
  white-space: nowrap;
}

/* 删除分类对话框样式 */
.delete-category-content {
  padding: 16px 0;
}

.delete-category-content .delete-warning {
  display: flex;
  align-items: center;
  font-size: 16px;
  margin-bottom: 12px;
  color: var(--color-text-primary);
}

.delete-category-content .delete-info {
  display: flex;
  align-items: center;
  font-size: 14px;
  color: var(--color-text-secondary);
  margin-bottom: 0;
}

.delete-category-content .delete-question {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 12px;
}

.delete-category-content .t-radio-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.upload-area {
  width: 100%;
}

/* 拖拽上传时的阴影效果 */
.drag-active :deep(.t-dialog) {
  box-shadow: 0 0 30px var(--color-primary-alpha-60) !important;
  border: 2px dashed var(--color-primary) !important;
}

.drag-active :deep(.native-dialog__content) {
  background: var(--color-primary-alpha-05) !important;
}

.empty-state .t-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  line-height: 1.5;
}

.file-count-tooltip {
  position: absolute;
  bottom: 4px;
  right: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 4px;
  pointer-events: none;
  white-space: nowrap;
}

.subcategory-view h3 {
  font-size: 20px;
  color: var(--color-text-primary);
  margin-bottom: 20px;
}

.subcategory-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  background: #f6f8fa;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.subcategory-item:hover {
  background: var(--color-primary);
  color: white;
  transform: translateX(5px);
}

.subcategory-item .t-icon {
  color: var(--color-primary);
}

.subcategory-item:hover .t-icon {
  color: white;
}

.subcategory-item.all-docs {
  background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-active) 100%);
  color: white;
}

.subcategory-item.all-docs .t-icon {
  color: white;
}

/* 文档列表 */
.documents-list {
  margin-top: 16px;
}

.section-title {
  font-size: 18px;
  color: var(--color-text-primary);
  margin-bottom: 0;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--color-primary);
}

/* 批量操作栏 */
.batch-actions-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin-bottom: 8px;
  background: #f0f3ff;
  border-radius: 6px;
}

.batch-actions-hint {
  font-size: 13px;
  color: var(--color-text-secondary);
  margin-left: auto;
}

.native-table {
  margin-top: 16px;
}

.native-table :deep(.native-table__th) {
  background: #f6f8fa;
  font-weight: 600;
  color: var(--color-text-primary);
}

.native-table :deep(.native-table__tr:hover) {
  background: #f0f3ff;
}

.native-button {
  margin-right: 4px;
}

/* 空状态和不可预览文件的下载按钮 */
.empty-state .native-button,
.office-preview .native-button,
.unsupported-preview .native-button,
.word-html-preview .native-button {
  height: 28px !important;
  min-height: 28px !important;
  padding: 0 16px !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 4px !important;
}

/* 空状态 */
.empty-state {
  margin-top: 32px;
  text-align: center;
  padding: 60px 20px;
}

.empty-state .t-icon {
  color: #d0d0d0;
  margin-bottom: 20px;
}

.empty-state p {
  font-size: 16px;
  color: var(--color-text-secondary);
  margin: 0 0 24px 0;
}

/* 预览容器样式 */
.preview-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 400px;
  max-height: 70vh;
  overflow-y: auto;
}

.loading-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 400px;
}

/* PDF 预览 */
.pdf-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.pdf-preview canvas {
  max-width: 100%;
  border: 1px solid #d0d0d0;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.pdf-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 24px;
  background: #f6f8fa;
  border-radius: 8px;
}

.pdf-controls span {
  font-weight: 500;
  color: var(--color-text-primary);
  min-width: 100px;
  text-align: center;
}

/* Markdown 预览样式 */
.markdown-preview {
  padding: 20px;
  background: #fff;
  border-radius: 8px;
  overflow-x: auto;
}

/* 代码预览样式 */
.code-preview {
  padding: 20px;
  background: #f6f8fa;
  border-radius: 8px;
  overflow-x: auto;
  max-height: 70vh;
}

.code-preview pre {
  margin: 0;
  padding: 16px;
  background: #282c34;
  border-radius: 6px;
  overflow-x: auto;
}

.code-preview code {
  font-family: 'Fira Code', 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.6;
  color: #abb2bf;
}

/* Highlight.js 主题 */
.code-preview .hljs {
  background: #282c34;
  padding: 0;
  margin: 0;
}

.code-preview .hljs-comment {
  color: #5c6370;
  font-style: italic;
}

.code-preview .hljs-string {
  color: #98c379;
}

.code-preview .hljs-number {
  color: #d19a66;
}

.code-preview .hljs-keyword {
  color: #c678dd;
}

.code-preview .hljs-function {
  color: #61afef;
}

.code-preview .hljs-title {
  color: #e5c07b;
}

.code-preview .hljs-variable {
  color: #e06c75;
}

.code-preview .hljs-operator {
  color: #56b6c2;
}

.code-preview .hljs-tag {
  color: #e06c75;
}

.code-preview .hljs-attr {
  color: #d19a66;
}

.code-preview .hljs-value {
  color: #98c379;
}

/* 文本预览样式 */
.text-preview {
  padding: 20px;
  background: #f6f8fa;
  border-radius: 8px;
  overflow-x: auto;
  max-height: 70vh;
}

/* 图片预览样式 */
.image-preview {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 20px;
  background: #f6f8fa;
  border-radius: 8px;
  min-height: 400px;
}

.image-preview img {
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

/* Office 文档预览样式 */
.office-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 60px 20px;
  background: #f6f8fa;
  border-radius: 8px;
  min-height: 400px;
}

.office-preview .native-icon {
  color: var(--color-primary);
  margin-bottom: 20px;
}

.office-preview h3 {
  margin: 0;
  font-size: 20px;
  color: var(--color-text-primary);
}

.office-preview p {
  margin: 0;
  font-size: 14px;
  color: var(--color-text-secondary);
  text-align: center;
}

.text-preview pre {
  margin: 0;
  padding: 16px;
  background: #fff;
  border-radius: 6px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-x: auto;
}

/* 不支持的格式 */
.unsupported-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 60px 20px;
  color: var(--color-text-secondary);
}

.unsupported-preview .t-icon {
  color: var(--color-text-muted);
}

.unsupported-preview p {
  font-size: 16px;
  margin: 0;
}

/* Word HTML 预览 */
.word-html-preview {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 70vh;
  overflow-y: auto;
}

.word-content {
  padding: 20px;
  background: #fff;
  border-radius: 8px;
  overflow-x: auto;
}

.word-content :deep(p) {
  margin: 12px 0;
  line-height: 1.8;
}

.word-content :deep(h1),
.word-content :deep(h2),
.word-content :deep(h3) {
  margin: 20px 0 12px 0;
  padding-bottom: 8px;
  border-bottom: 1px solid #eaecef;
}

.word-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
}

.word-content :deep(table td) {
  border: 1px solid #dfe2e5;
  padding: 8px 12px;
}

.preview-footer {
  display: flex;
  justify-content: space-between;
  padding: 12px 20px;
  background: #f6f8fa;
  border-radius: 8px;
  font-size: 14px;
  color: var(--color-text-secondary);
}

/* 编辑对话框 */
.loading-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 400px;
}

.edit-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.editor-wrapper {
  width: 100%;
  border: 1px solid #dcdcdc;
  border-radius: 8px;
  overflow: hidden;
  transition: all 0.3s ease;
}

.editor-wrapper:hover {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-alpha-10);
}

.editor-textarea {
  width: 100%;
  min-height: 400px;
  max-height: 600px;
  padding: 16px;
  border: none;
  resize: vertical;
  font-size: 14px;
  line-height: 1.6;
  background: #f9f9f9;
  color: var(--color-text-primary);
  outline: none;
  transition: background 0.3s ease;
}

.editor-textarea:focus {
  background: #fff;
}

.editor-footer {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.file-info {
  display: flex;
  align-items: center;
  gap: 16px;
}

/* 预览内部滚动条：静止、悬停和拖动状态均使用当前视觉语言。 */
.preview-container,
.pdf-canvas-stage,
.code-preview,
.code-preview pre,
.text-preview,
.text-preview pre,
.word-html-preview,
.word-content,
.markdown-preview :deep(.md-editor-preview-wrapper),
.markdown-preview :deep(pre) {
  scrollbar-color: var(--color-border-strong) transparent;
  scrollbar-width: thin;
}

.preview-container::-webkit-scrollbar,
.pdf-canvas-stage::-webkit-scrollbar,
.code-preview::-webkit-scrollbar,
.code-preview pre::-webkit-scrollbar,
.text-preview::-webkit-scrollbar,
.text-preview pre::-webkit-scrollbar,
.word-html-preview::-webkit-scrollbar,
.word-content::-webkit-scrollbar,
.markdown-preview :deep(.md-editor-preview-wrapper)::-webkit-scrollbar,
.markdown-preview :deep(pre)::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.preview-container::-webkit-scrollbar-track,
.pdf-canvas-stage::-webkit-scrollbar-track,
.code-preview::-webkit-scrollbar-track,
.code-preview pre::-webkit-scrollbar-track,
.text-preview::-webkit-scrollbar-track,
.text-preview pre::-webkit-scrollbar-track,
.word-html-preview::-webkit-scrollbar-track,
.word-content::-webkit-scrollbar-track,
.markdown-preview :deep(.md-editor-preview-wrapper)::-webkit-scrollbar-track,
.markdown-preview :deep(pre)::-webkit-scrollbar-track {
  background: color-mix(in srgb, var(--color-surface-subtle) 72%, transparent);
  border-radius: var(--radius-pill);
}

.preview-container::-webkit-scrollbar-thumb,
.pdf-canvas-stage::-webkit-scrollbar-thumb,
.code-preview::-webkit-scrollbar-thumb,
.code-preview pre::-webkit-scrollbar-thumb,
.text-preview::-webkit-scrollbar-thumb,
.text-preview pre::-webkit-scrollbar-thumb,
.word-html-preview::-webkit-scrollbar-thumb,
.word-content::-webkit-scrollbar-thumb,
.markdown-preview :deep(.md-editor-preview-wrapper)::-webkit-scrollbar-thumb,
.markdown-preview :deep(pre)::-webkit-scrollbar-thumb {
  background: var(--color-border-strong);
  border: 2px solid transparent;
  border-radius: var(--radius-pill);
  background-clip: padding-box;
}

.preview-container::-webkit-scrollbar-thumb:hover,
.pdf-canvas-stage::-webkit-scrollbar-thumb:hover,
.code-preview::-webkit-scrollbar-thumb:hover,
.code-preview pre::-webkit-scrollbar-thumb:hover,
.text-preview::-webkit-scrollbar-thumb:hover,
.text-preview pre::-webkit-scrollbar-thumb:hover,
.word-html-preview::-webkit-scrollbar-thumb:hover,
.word-content::-webkit-scrollbar-thumb:hover,
.markdown-preview :deep(.md-editor-preview-wrapper)::-webkit-scrollbar-thumb:hover,
.markdown-preview :deep(pre)::-webkit-scrollbar-thumb:hover {
  background-color: var(--color-primary);
}

.preview-container::-webkit-scrollbar-thumb:active,
.pdf-canvas-stage::-webkit-scrollbar-thumb:active,
.code-preview::-webkit-scrollbar-thumb:active,
.code-preview pre::-webkit-scrollbar-thumb:active,
.text-preview::-webkit-scrollbar-thumb:active,
.text-preview pre::-webkit-scrollbar-thumb:active,
.word-html-preview::-webkit-scrollbar-thumb:active,
.word-content::-webkit-scrollbar-thumb:active,
.markdown-preview :deep(.md-editor-preview-wrapper)::-webkit-scrollbar-thumb:active,
.markdown-preview :deep(pre)::-webkit-scrollbar-thumb:active {
  background-color: var(--color-primary-active);
}

/* 预览对话框样式调整 */
:deep(.native-dialog) {
  max-height: 90vh;
  overflow: visible;
}

:deep(.t-dialog__body) {
  max-height: 80vh;
  overflow-y: auto;
}

/* 视图切换按钮图标大小调整 */
:deep(.native-radio-button .native-icon) {
  width: 16px;
  height: 16px;
}

/* NativeTable 样式 */
::deep(.native-table td) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

::deep(.native-table .title-cell),
::deep(.native-table .tags-cell) {
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
}

/* 操作列沿用其余列的左对齐轴，表头与按钮组保持一致。 */
::deep(.native-table th:last-child),
::deep(.native-table td:last-child) {
  text-align: left;
  white-space: nowrap;
}
  .version-dialog-toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 12px;
  }

  .version-current-label {
    color: var(--color-primary);
    font-weight: 600;
  }

  .version-trash-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .version-trash-item {
    display: grid;
    grid-template-columns: 80px minmax(0, 1fr) 180px auto;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid #f0f0f0;
  }

  .upload-conflict-suggestion {
    margin: 12px 0;
  }

  .upload-conflict-candidates {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 320px;
    overflow-y: auto;
  }

  .upload-conflict-candidate {
    display: flex;
    gap: 10px;
    padding: 10px;
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
    font-size: 13px;
  }

  .upload-conflict-hash-match {
    color: #d54941;
    font-weight: 600;
  }

  .upload-conflict-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }

.documents {
  width: 100%;
  max-width: 1900px;
  margin: 0 auto;
}

.document-page-intro {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
}

.document-page-intro p {
  margin: 0 0 5px;
  font-size: 15px;
  color: var(--color-text-primary);
}

.document-page-intro span {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.page-header-actions,
.workbench-search,
.workbench-location,
.workbench-filter-actions,
.document-detail-heading {
  display: flex;
  align-items: center;
  gap: 10px;
}

.document-workbench {
  overflow: hidden;
  border-color: var(--color-border-default);
  box-shadow: var(--shadow-sm);
}

.document-workbench :deep(.native-card__body) {
  padding: 0;
}

.workbench-toolbar {
  min-height: 64px;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface-raised);
}

.workbench-location {
  min-width: 0;
  color: var(--color-text-secondary);
}

.breadcrumb-root,
.breadcrumb-segment {
  padding: 4px 2px;
  border: 0;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  font: inherit;
  white-space: nowrap;
}

.breadcrumb-root {
  color: var(--color-text-primary);
  font-weight: 650;
}

.breadcrumb-root:hover,
.breadcrumb-segment:hover {
  color: var(--color-primary);
}

.workbench-search {
  flex: 0 1 540px;
  justify-content: flex-end;
}

.workbench-query {
  min-width: 220px;
  max-width: 280px;
  flex: 1 1 250px;
}

.workbench-search :deep(.native-input) {
  min-width: 220px;
}

.workbench-sort-group {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.workbench-sort {
  width: 116px;
  flex: 0 0 116px;
}

.workbench-search :deep(.sort-direction-button.native-btn) {
  width: 36px;
  min-width: 36px;
  height: 36px;
  flex: 0 0 36px;
  color: var(--color-text-secondary);
  border-color: transparent;
  background: transparent;
}

.workbench-search :deep(.sort-direction-button.native-btn:hover:not(:disabled)),
.workbench-search :deep(.sort-direction-button.native-btn:focus-visible) {
  color: var(--color-primary);
  border-color: var(--color-primary-border);
  background: var(--color-primary-surface);
}

.workbench-filters {
  margin: 12px 16px 14px;
  padding: 14px 16px;
  display: grid;
  grid-template-columns: 176px minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  border: 1px solid color-mix(in srgb, var(--color-primary-border) 50%, var(--color-border-subtle));
  border-radius: var(--radius-lg);
  background: linear-gradient(112deg, color-mix(in srgb, var(--color-primary-surface) 66%, var(--color-surface-raised)), var(--color-surface-raised) 46%);
  box-shadow: var(--shadow-sm);
}

.workbench-filter-heading,
.workbench-filter-heading > div,
.dialog-intro > div,
.preview-file-meta > div,
.version-trash-item > div {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.workbench-filter-heading {
  display: flex;
  align-items: center;
  gap: 10px;
}

.workbench-filter-heading strong,
.dialog-intro strong {
  color: var(--color-text-primary);
  font-size: 13px;
}

.workbench-filter-heading span,
.dialog-intro span,
.preview-file-meta span,
.version-trash-item span,
.version-dialog-description {
  color: var(--color-text-muted);
  font-size: 12px;
}

.workbench-filter-icon,
.dialog-intro-icon {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  color: var(--color-primary);
  background: var(--color-primary-surface);
}

.workbench-filter-icon {
  border: 1px solid var(--color-primary-border);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.workbench-filter-fields {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(180px, 0.8fr) minmax(280px, 1.2fr);
  gap: 14px;
}

.workbench-filter-fields :deep(.native-form-item) {
  margin: 0;
}

.workbench-filter-fields :deep(.native-form-item__label) {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.workbench-filter-actions {
  padding: 4px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-surface-subtle) 72%, var(--color-surface-raised));
}

.document-row-actions {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 5px;
}

.document-row-action {
  min-height: 30px;
  padding: 5px 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  transition: color .16s ease, border-color .16s ease, background-color .16s ease;
}

.document-row-action:hover,
.document-row-action:focus-visible {
  color: var(--color-text-primary);
  border-color: var(--color-border-default);
  background: var(--color-surface-subtle);
}

.document-row-action--preview {
  color: var(--color-primary);
  background: var(--color-primary-surface);
}

.document-row-action--preview:hover,
.document-row-action--preview:focus-visible {
  color: var(--color-primary-hover);
  border-color: var(--color-primary-border);
  background: color-mix(in srgb, var(--color-primary) 13%, var(--color-surface-raised));
}

.document-row-action:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

.workbench-body {
  display: grid;
  grid-template-columns: 244px minmax(0, 1fr);
  min-height: clamp(620px, calc(100vh - 260px), 820px);
  background: var(--color-surface-raised);
}

.workbench-body.folder-rail-collapsed {
  grid-template-columns: minmax(0, 1fr);
}

.folder-rail {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border-subtle);
  background: color-mix(in srgb, var(--color-surface-subtle) 82%, white);
}

.folder-rail-header {
  min-height: 52px;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.folder-rail-header {
  border-bottom: 1px solid var(--color-border-subtle);
  color: var(--color-text-primary);
}

.folder-tree {
  padding: 8px;
  overflow-y: auto;
}

.folder-tree-row {
  position: relative;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: center;
  padding-left: calc(5px + var(--folder-depth, 0) * 15px);
  border-radius: var(--radius-sm);
}

.folder-tree-toggle,
.folder-tree-toggle-spacer {
  width: 20px;
  height: 30px;
}

.folder-tree-toggle {
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}

.folder-tree-toggle:hover,
.folder-tree-toggle:focus-visible {
  color: var(--color-primary);
  background: var(--color-surface-raised);
}

.folder-tree-item {
  width: 100%;
  min-width: 0;
  min-height: 38px;
  padding: 7px 8px 7px 2px;
  display: grid;
  grid-template-columns: 19px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  text-align: left;
  cursor: pointer;
}

.folder-tree-item span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-tree-item small {
  color: var(--color-text-muted);
  font-size: 11px;
}

.folder-tree-row:hover,
.folder-tree-row.active {
  background: var(--color-primary-surface);
}

.folder-tree-item:hover,
.folder-tree-row.active .folder-tree-item {
  color: var(--color-primary);
}

.folder-tree-all {
  margin-bottom: 4px;
  padding-left: 9px;
  --folder-depth: 0;
}

.folder-tree-actions {
  position: absolute;
  right: 5px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-left: 12px;
  background: linear-gradient(90deg, transparent, var(--color-primary-surface) 25%);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-fast) var(--ease-standard);
}

.folder-tree-row:hover .folder-tree-actions,
.folder-tree-row:focus-within .folder-tree-actions {
  opacity: 1;
  pointer-events: auto;
}

.folder-tree-actions button {
  width: 26px;
  height: 26px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.folder-tree-actions button:hover {
  color: var(--color-primary);
  background: var(--color-surface-raised);
}

.document-file-pane {
  position: relative;
  min-width: 0;
  padding: 16px 18px 20px;
  overflow: hidden;
}

.document-file-pane :deep(.native-table th),
.document-file-pane :deep(.native-table td) {
  overflow: hidden;
  text-overflow: ellipsis;
}

.document-state-alert {
  margin-bottom: 12px;
}

.document-state-alert :deep(.native-alert__message) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.document-title-cell {
  max-width: 100%;
  padding: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 0;
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.document-title-cell > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.document-title-cell:hover {
  color: var(--color-primary);
}

.document-tags-cell {
  max-width: 100%;
  padding: 3px 8px;
  display: inline-block;
  overflow: hidden;
  border-radius: var(--radius-pill);
  color: var(--color-text-secondary);
  background: var(--color-surface-subtle);
  font-size: 12px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}

.document-tags-empty {
  color: var(--color-text-disabled);
}

.document-type-icon,
.document-detail-icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  background: var(--color-primary-surface);
}

.document-type-icon {
  width: 32px;
  height: 32px;
}

.document-type-icon--pdf {
  color: var(--color-danger-text);
  background: var(--color-danger-surface);
}

.document-type-icon--word {
  color: #3564b8;
  background: #edf4ff;
}

.document-type-icon--sheet {
  color: var(--color-success-text);
  background: var(--color-success-surface);
}

.document-type-icon--slides {
  color: var(--color-warning-text);
  background: var(--color-warning-surface);
}

.document-type-icon--markdown {
  color: #6a4fb0;
  background: #f2efff;
}

.document-type-icon--image {
  color: #087c8f;
  background: #e9f7f8;
}

.document-type-icon--code {
  color: #4f6078;
  background: #edf0f5;
}

.document-type-icon--text {
  color: var(--color-primary);
  background: var(--color-primary-surface);
}

.document-empty-state {
  min-height: 520px;
  margin: 0;
  padding: 40px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  color: var(--color-text-secondary);
}

.document-empty-state strong {
  color: var(--color-text-primary);
  font-size: 16px;
}

.document-empty-state > span:not(.document-empty-icon) {
  max-width: 460px;
  margin-bottom: 8px;
  color: var(--color-text-muted);
  text-align: center;
}

.document-empty-icon {
  width: 64px;
  height: 64px;
  margin-bottom: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-primary-border);
  border-radius: var(--radius-xl);
  color: var(--color-primary);
  background: var(--color-primary-surface);
}

.version-upload-form {
  margin-top: 16px;
}

.version-upload-form :deep(.native-form-item__label) {
  white-space: nowrap;
}

.version-dialog-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.version-view-switch {
  display: inline-flex;
  gap: 3px;
  padding: 3px;
  border-radius: var(--radius-md);
  background: var(--color-surface-subtle);
}

.version-view-switch button {
  min-height: 34px;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  background: transparent;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.version-view-switch button.active {
  color: var(--color-primary);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-sm);
}

.version-view-switch button span {
  min-width: 20px;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  color: inherit;
  background: var(--color-primary-surface);
  font-size: 11px;
}

.version-dialog-description {
  margin: 12px 0 14px;
}

.version-current-label {
  display: inline-flex;
  padding: 3px 8px;
  border-radius: var(--radius-pill);
  color: var(--color-success-text);
  background: var(--color-success-surface);
  font-size: 12px;
  font-weight: 650;
}

.version-trash-list {
  display: grid;
  gap: 8px;
}

.version-trash-item {
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 13px 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
}

.version-trash-item strong {
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.version-trash-number {
  color: var(--color-primary) !important;
  font-weight: 700;
}

.version-trash-empty,
.preview-error-state {
  min-height: 250px;
  padding: 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px dashed var(--color-border-default);
  border-radius: var(--radius-lg);
  color: var(--color-text-secondary);
  background: var(--color-surface-subtle);
  text-align: center;
}

.version-trash-empty > span,
.preview-error-state > span {
  width: 52px;
  height: 52px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-lg);
  color: var(--color-primary);
  background: var(--color-primary-surface);
}

.version-trash-empty strong,
.preview-error-state strong {
  color: var(--color-text-primary);
}

.version-trash-empty p,
.preview-error-state p {
  margin: 0;
}

.preview-error-state > div {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.preview-error-state > span {
  color: var(--color-danger);
  background: var(--color-danger-surface);
}

.compact-loading {
  min-height: 250px;
}

.dialog-intro {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 14px;
  margin-bottom: 18px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-surface-subtle);
}

.dialog-intro--info {
  border-color: var(--color-info-border);
  background: var(--color-info-surface);
}

.document-upload-form :deep(.native-upload__drag),
.version-upload-form :deep(.native-upload__drag) {
  min-height: 164px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.batch-actions-bar {
  position: absolute;
  top: 16px;
  right: 18px;
  left: 18px;
  z-index: 4;
  min-height: 48px;
  margin: 0;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--color-primary-border);
  border-radius: var(--radius-md);
  background: var(--color-primary-surface);
  box-shadow: var(--shadow-sm);
}

.batch-selection-summary {
  margin-right: auto;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--color-primary);
  background: transparent;
  cursor: pointer;
  font-size: 13px;
}

.batch-selection-summary:hover,
.batch-selection-summary:focus-visible {
  background: color-mix(in srgb, var(--color-primary) 9%, transparent);
}

.batch-selection-summary:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

:deep(.document-dialog.native-dialog) {
  overflow: hidden;
}

:deep(.version-history-dialog .native-dialog__body) {
  padding-top: 16px;
}

@media (max-width: 1180px) {
  .workbench-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .workbench-search {
    width: 100%;
    flex: 1 1 auto;
    justify-content: flex-start;
  }

  .workbench-search :deep(.native-input) {
    flex: 1;
  }

  .workbench-body {
    grid-template-columns: 204px minmax(0, 1fr);
  }
}

@media (max-width: 900px) {
  .document-page-intro {
    align-items: flex-start;
    flex-direction: column;
  }

  .workbench-filters {
    grid-template-columns: 1fr;
  }
}
</style>
