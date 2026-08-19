<template>
  <div class="documents">
    <div class="page-header">
      <p>管理 PDF、Word、PPT、文本等文档</p>
    </div>

    <!-- 工具栏 -->
    <NativeCard class="toolbar">
      <div class="toolbar-row">
        <!-- 视图切换独占一行 -->
        <NativeRadioGroup v-model="viewMode" variant="default-filled" @change="handleViewModeChange" class="toolbar-view-group">
          <NativeRadio value="category">
            <NativeIcon name="folder" size="14" /> 分类浏览
          </NativeRadio>
          <NativeRadio value="list">
            <NativeIcon name="list-dashes" size="14" /> 列表视图
          </NativeRadio>
          <NativeRadio value="trash">
            <NativeIcon name="trash" size="14" /> 回收站
          </NativeRadio>
        </NativeRadioGroup>
      </div>
      
      <!-- 搜索和排序另起一行 -->
      <div v-if="viewMode !== 'trash'" class="toolbar-row toolbar-row-second">
        <!-- 左侧：搜索和高级搜索 -->
        <div class="toolbar-left">
          <NativeInput
            v-model="searchKeyword"
            placeholder="搜索文档..."
            clearable
            @clear="handleSearch"
            @enter="handleSearch"
            style="width: 300px"
            class="toolbar-search"
          >
            <template #suffix-icon>
              <NativeIcon name="magnifying-glass" />
            </template>
          </NativeInput>

          <NativeButton
            :variant="advancedSearchVisible ? 'base' : 'outline'"
            :theme="advancedSearchVisible ? 'primary' : 'default'"
            @click="advancedSearchVisible = !advancedSearchVisible"
            class="toolbar-btn"
          >
            <NativeIcon name="filter" /> 高级搜索
          </NativeButton>
        </div>

        <!-- 右侧：排序相关 -->
        <div class="toolbar-right">
          <NativeSelect
            v-model="sortBy"
            placeholder="排序方式"
            style="width: 140px"
            :options="[
              { value: 'updated_at', label: '更新时间' },
              { value: 'title', label: '文件名' },
              { value: 'file_type', label: '文件类型' },
              { value: 'size', label: '文件大小' }
            ]"
            @change="handleDropdownSortChange"
            class="toolbar-select"
          />

          <NativeButton
            variant="outline"
            @click="toggleSortOrder"
            shape="circle"
            :title="sortOrder === 'desc' ? '降序' : '升序'"
            class="toolbar-btn"
          >
            <template #icon>
              <NativeIcon :name="sortOrder === 'desc' ? 'arrow-down' : 'arrow-up'" />
            </template>
          </NativeButton>
        </div>
      </div>

      <!-- 高级搜索面板 -->
      <div v-if="advancedSearchVisible && viewMode !== 'trash'" class="advanced-search-panel">
        <NativeSpace>
          <NativeFormItem label="标签" style="margin: 0;">
            <NativeSelect
              v-model="selectedTags"
              placeholder="选择标签"
              multiple
              clearable
              style="width: 200px"
              :options="allTags.map(tag => ({ value: tag, label: tag }))"
            />
          </NativeFormItem>
          <NativeFormItem label="日期范围" style="margin: 0;">
            <NativeDateRangePicker v-model="dateRange" style="width: 300px" />
          </NativeFormItem>
          <NativeButton theme="primary" @click="handleAdvancedSearch">搜索</NativeButton>
          <NativeButton @click="resetAdvancedSearch">重置</NativeButton>
        </NativeSpace>
      </div>
    </NativeCard>

    <!-- 分类浏览模式 -->
    <NativeCard v-if="viewMode === 'category'" class="category-view">
      <!-- 加载状态 -->
      <div v-if="loading" class="content-loading">
        <NativeLoading size="small" />
      </div>
      <!-- 空状态：没有分类 -->
      <div v-else-if="categories.length === 0" class="empty-categories">
        <NativeIcon name="folder-open" size="64" />
        <h3>还没有分类</h3>
        <p>创建第一个分类来开始管理文档</p>
        <NativeButton theme="primary" size="large" iconSize="1.15em" @click="handleCreateCategory" :disabled="isGuest">
          <template #icon><NativeIcon name="folder-plus" /></template>
          创建第一个分类
        </NativeButton>
      </div>
      <!-- 显示当前分类的子分类 -->
      <div v-else-if="currentCategoryId" class="category-children">
        <h3 class="category-path">{{ currentCategoryPath }}</h3>
        <div v-if="currentSubcategories.length > 0" class="categories-grid">
          <div
            v-for="(cat, index) in currentSubcategories"
            :key="cat.id"
            class="category-card"
            :class="{ 'drag-over': draggedCategoryId === cat.id }"
            :draggable="!isGuest"
            @click="enterCategory(cat)"
            @mouseenter="handleCategoryHover(cat.id)"
            @mouseleave="handleCategoryLeave"
            @dragstart="!isGuest && handleDragStart($event, cat, index)"
            @dragover.prevent="!isGuest && handleDragOver($event, cat)"
            @dragleave="handleDragLeave"
            @drop="!isGuest && handleDrop($event, cat, index)"
            @dragend="handleDragEnd"
          >
            <div class="category-actions" v-if="!isGuest">
              <div class="action-btn rename-btn" @click.stop="handleRenameCategory(cat)" title="重命名">
                <NativeIcon name="pencil" size="14" />
              </div>
              <div class="action-btn delete-btn" @click.stop="handleDeleteCategory(cat)" title="删除">
                <NativeIcon name="x" size="14" />
              </div>
            </div>
<NativeIcon name="folder-open" size="24" class="category-icon" />
          <h3>{{ cat.name }}</h3>
          <div v-if="hoveredCategoryId === cat.id && cat.fileCount !== undefined" class="file-count-tooltip">
              {{ cat.fileCount }} 个文件
            </div>
          </div>
        </div>
        <NativeAlert
          v-else
          theme="info"
          title="暂无子分类"
          style="margin-top: 20px"
        >
          点击下方按钮创建子分类
        </NativeAlert>
        <!-- 创建子分类按钮和返回按钮 -->
        <div class="category-actions-bar" v-if="!isGuest">
          <NativeButton theme="primary" @click="handleUpload" :disabled="!canWrite">
            <template #icon><NativeIcon name="plus" size="14" /></template>
            上传文档
          </NativeButton>
          <NativeButton theme="default" @click="handleCreateSubcategory">
            <template #icon><NativeIcon name="folder-plus" size="14" /></template>
            创建子分类
          </NativeButton>
          <NativeButton @click="resetCategory">
            <template #icon><NativeIcon name="arrow-left" size="14" /></template>
            返回上级
          </NativeButton>
          <NativeButton @click="backToRoot" theme="default">
            <template #icon><NativeIcon name="home" size="14" /></template>
            返回主界面
          </NativeButton>
        </div>
      </div>
      <!-- 显示根分类 -->
      <div v-else>
        <div class="categories-grid">
          <div
            v-for="(cat, index) in categories"
            :key="cat.id"
            class="category-card"
            :class="{ 'drag-over': draggedCategoryId === cat.id }"
            :draggable="!isGuest"
            @click="enterCategory(cat)"
            @mouseenter="handleCategoryHover(cat.id)"
            @mouseleave="handleCategoryLeave"
            @dragstart="!isGuest && handleDragStart($event, cat, index)"
            @dragover.prevent="!isGuest && handleDragOver($event, cat)"
            @dragleave="handleDragLeave"
            @drop="!isGuest && handleDrop($event, cat, index)"
            @dragend="handleDragEnd"
          >
            <div class="category-actions" v-if="!isGuest">
              <div class="action-btn rename-btn" @click.stop="handleRenameCategory(cat)" title="重命名">
                <NativeIcon name="pencil" size="14" />
              </div>
              <div class="action-btn delete-btn" @click.stop="handleDeleteCategory(cat)" title="删除">
                <NativeIcon name="x" size="14" />
              </div>
            </div>
            <NativeIcon name="folder-open" size="24" class="category-icon" />
            <h3>{{ cat.name }}</h3>
            <div v-if="hoveredCategoryId === cat.id && cat.fileCount !== undefined" class="file-count-tooltip">
              {{ cat.fileCount }} 个文件
            </div>
          </div>
        </div>
        <!-- 创建分类按钮 -->
        <div class="category-actions-bar" v-if="!isGuest">
          <NativeButton theme="default" @click="handleCreateCategory">
            <template #icon><NativeIcon name="folder-plus" size="14" /></template>
            创建分类
          </NativeButton>
        </div>
      </div>
    </NativeCard>

    <!-- 文档列表 -->
    <NativeCard v-if="viewMode === 'trash'" class="documents-list">
      <h3 class="section-title">文档回收站</h3>
      <NativeAlert theme="info" title="删除的文档默认保留 30 天">
        恢复会优先放回原分类；永久删除不可撤销。
      </NativeAlert>
      <div v-if="trashLoading" class="content-loading">
        <NativeLoading size="small" />
      </div>
      <NativeTable v-else-if="trashDocuments.length > 0" :dataSource="trashDocuments" :columns="trashColumns" rowKey="id" hover>
        <template #cell-originalPath="{ row }">
          <span>{{ row.originalPath || '未分类' }}</span>
        </template>
        <template #cell-deletedAt="{ row }">
          <span>{{ formatDateTime(row.deletedAt) }}</span>
        </template>
        <template #cell-purgeAfter="{ row }">
          <span>{{ formatDateTime(row.purgeAfter) }}</span>
        </template>
        <template #cell-operation="{ row }">
          <NativeSpace>
            <NativePopconfirm content="恢复后将优先返回原分类，确定恢复吗？" @confirm="handleRestoreTrash(row.id)">
              <template #trigger>
                <NativeButton theme="primary" size="small" :disabled="!canWrite">恢复</NativeButton>
              </template>
            </NativePopconfirm>
            <NativePopconfirm content="永久删除将同时清理该文档的历史版本，且不可恢复。确定继续吗？" @confirm="handlePermanentlyDeleteTrash(row.id)">
              <template #trigger>
                <NativeButton theme="danger" variant="outline" size="small" :disabled="!canWrite">永久删除</NativeButton>
              </template>
            </NativePopconfirm>
          </NativeSpace>
        </template>
      </NativeTable>
      <div v-else class="empty-state-inline">
        <NativeIcon name="trash" size="48" />
        <p>回收站为空</p>
      </div>
    </NativeCard>

    <NativeCard v-if="viewMode !== 'trash' && documents.length > 0" class="documents-list">
      <h3 v-if="viewMode === 'category' && currentCategoryId" class="section-title">
        {{ currentCategoryPath }} - 文档列表
      </h3>
      <h3 v-else class="section-title">
        所有文档
      </h3>

      <!-- 批量操作栏 -->
      <div v-if="selectedRowKeys.length > 0" class="batch-actions-bar">
        <NativeButton theme="primary" size="small" @click="handleBatchEdit" :disabled="isGuest">
          <template #icon><NativeIcon name="pencil" /></template>
          批量更改 ({{ selectedRowKeys.length }})
        </NativeButton>
        <NativePopconfirm content="确定删除选中的文档吗？" @confirm="handleBatchDelete">
          <template #trigger>
            <NativeButton theme="danger" variant="outline" size="small" :disabled="isGuest">
              <template #icon><NativeIcon name="trash" /></template>
              批量删除 ({{ selectedRowKeys.length }})
            </NativeButton>
          </template>
        </NativePopconfirm>
        <span class="batch-actions-hint">已选择 {{ selectedRowKeys.length }} 项</span>
      </div>

      <NativeTable
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
        <template #cell-version="{ row }">
          <span>v{{ row.version }}</span>
        </template>
        <template #cell-type="{ row }">
          <span>{{ getFileExtension(row.filePath || '') }}</span>
        </template>
        <template #cell-operation="{ row }">
          <NativeSpace>
            <NativeButton theme="primary" variant="outline" size="small" iconSize="1.2em" @click="handleView(row)">
              <template #icon><NativeIcon name="eye" /></template>预览
            </NativeButton>
            <NativeButton theme="primary" size="small" iconSize="1.2em" @click="handleChangeSingle(row)" :disabled="!canWrite">
              <template #icon><NativeIcon name="pencil" /></template>更改
            </NativeButton>
            <NativeButton theme="primary" size="small" iconSize="1.2em" @click="handleViewVersions(row)">
              <template #icon><NativeIcon name="clock-counter-clockwise" /></template>版本
            </NativeButton>
            <NativeButton theme="default" variant="outline" size="small" iconSize="1.2em" @click="handleEdit(row)" :disabled="!canWrite || !canEditFile(row.filePath)">
              <template #icon><NativeIcon name="pencil" /></template>编辑
            </NativeButton>
            <NativePopconfirm
              content="确定删除吗？"
              @confirm="handleDelete(row.id)"
            >
              <template #trigger>
                <NativeButton theme="danger" variant="outline" size="small" iconSize="1.2em" :disabled="!canWrite">
                  <template #icon><NativeIcon name="trash" /></template>删除
                </NativeButton>
              </template>
            </NativePopconfirm>
          </NativeSpace>
        </template>
      </NativeTable>

      <!-- 分页（列表视图和分类浏览） -->
      <div class="pagination-wrapper" v-if="(viewMode === 'list' || viewMode === 'category') && total > 0">
        <NativePagination
          v-model:current="pagination.current"
          v-model:pageSize="pagination.pageSize"
          :total="total"
          @change="handlePageChange"
        />
      </div>
    </NativeCard>

    <!-- 空状态 - 仅在加载完成且无数据时显示 -->
    <NativeCard v-if="documents.length === 0 && !loading && !currentCategoryId && viewMode !== 'category'" class="empty-state">
      <NativeIcon name="file" size="64" />
      <p>暂无文档</p>
    </NativeCard>
    <NativeCard v-else-if="documents.length === 0 && !loading && currentCategoryId" class="empty-state">
      <NativeIcon name="file" size="64" />
      <p>当前分类下暂无文档</p>
      <NativeButton theme="primary" @click="handleUpload">上传第一个文档</NativeButton>
    </NativeCard>

    <!-- 批量编辑对话框 -->
    <NativeDialog
      v-model="batchEditDialogVisible"
      :title="isSingleEdit ? '更改文档信息' : '批量编辑文档'"
      @confirm="handleBatchEditConfirm"
      width="600px"
    >
      <NativeForm :modelValue="batchEditForm">
        <NativeFormItem label="分类">
          <NativeTreeSelect
            v-model="batchEditForm.categoryPath"
            :data="categoryTreeData"
            placeholder="选择分类（留空则不修改）"
            clearable
            @change="handleBatchCategoryChange"
          />
        </NativeFormItem>
        <NativeFormItem label="标签">
          <NativeInput v-model="batchEditForm.tags" placeholder="输入标签，用逗号分隔（留空则不修改）" />
        </NativeFormItem>
      </NativeForm>
      <p style="color: #999; font-size: 12px; margin-top: 10px;">
        提示：只有填写了内容的字段才会被更新，留空的字段保持原值。
      </p>
    </NativeDialog>

    <!-- 创建分类对话框 -->
    <NativeDialog
      v-model="createCategoryDialogVisible"
      title="创建分类"
      :confirm-btn="{ content: '确认', theme: 'primary' }"
      width="500px"
      @confirm="handleCreateCategoryConfirm"
    >
      <NativeForm :modelValue="categoryForm" :rules="categoryRules">
        <NativeFormItem label="分类名称" name="name" required>
          <NativeInput v-model="categoryForm.name" placeholder="请输入分类名称" />
        </NativeFormItem>
        <NativeFormItem v-if="currentCategoryId" label="父分类">
          <NativeInput :modelValue="currentCategoryName" disabled />
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
          <NativeIcon name="warning-circle" style="color: #e34d59; margin-right: 8px;" />
          确定要删除分类「<strong>{{ deleteCategoryData?.name }}</strong>」吗？
        </p>
        <p class="delete-info">
          <NativeIcon name="info" style="color: #0052d9; margin-right: 8px;" />
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
      <p style="color: #999; font-size: 12px; margin-top: 8px;">
        提示：同级分类下不能存在同名分类
      </p>
    </NativeDialog>

    <!-- 上传对话框 -->
    <NativeDialog
      v-model="uploadDialogVisible"
      title="上传文档"
      @confirm="handleUploadConfirm"
      width="600px"
      :class="{ 'drag-active': isDraggingFile }"
      @dragenter.prevent="handleDialogDragEnter"
      @dragover.prevent
      @dragleave.prevent="handleDialogDragLeave"
      @drop.prevent="handleFileDrop"
      :confirm-btn="{ content: '上传', loading: uploading, disabled: uploading }"
      :close-btn="!uploading"
    >
      <NativeForm :modelValue="uploadForm" :rules="uploadRules">
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
      width="800px"
      :show-footer="false"
    >
      <div class="version-dialog-toolbar">
        <NativeButton variant="outline" size="small" @click="openVersionTrash">
          版本回收站
        </NativeButton>
      </div>
      <NativeTable :dataSource="versions" :columns="versionColumns" rowKey="id">
        <template #cell-version="{ row }">
          <span>{{ row.version ? (row.version.toString().includes('.') ? row.version : `${row.version}.0`) : '1.0' }}</span>
        </template>
        <template #cell-isCurrent="{ row }">
          <span v-if="row.isCurrent" class="version-current-label">当前版本</span>
          <span v-else>历史版本</span>
        </template>
        <template #cell-operation="{ row }">
          <NativeSpace>
            <NativeButton theme="primary" size="small" @click="handleDownloadVersion(row)">
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
    </NativeDialog>

    <!-- 版本回收列表 -->
    <NativeDialog
      v-model="versionTrashDialogVisible"
      title="版本回收站"
      width="700px"
      :show-footer="false"
    >
      <div v-if="versionTrashLoading" class="content-loading">
        <NativeLoading size="small" />
      </div>
      <div v-else-if="versionTrash.length === 0" class="empty-state-inline">
        <p>版本回收站为空</p>
      </div>
      <div v-else class="version-trash-list">
        <div v-for="row in versionTrash" :key="row.id" class="version-trash-item">
          <span>v{{ row.version }}</span>
          <span>{{ row.note || '无说明' }}</span>
          <span>{{ formatDateTime(row.deletedAt || row.trashedAt) }}</span>
          <NativeButton v-if="!row.isCurrent" size="small" theme="primary" @click="handleRestoreVersionTrash(row)" :disabled="!canWrite">
            恢复
          </NativeButton>
        </div>
      </div>
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

    <!-- 预览对话框 -->
    <NativeDialog
      v-model="previewDialogVisible"
      :title="previewTitle"
      width="85%"
      :show-footer="false"
    >
      <div v-if="previewLoading" class="loading-container">
        <NativeLoading text="加载中..." />
      </div>
      <div v-else class="preview-container">
        <!-- PDF 预览 -->
        <div v-if="previewType === 'pdf'" class="pdf-preview">
          <canvas ref="pdfCanvas"></canvas>
          <div class="pdf-controls">
            <NativeButton size="small" @click="prevPage" :disabled="currentPage <= 1">
              <NativeIcon name="chevron-left" /> 上一页
            </NativeButton>
            <NativeInput
              v-model="jumpPageNum"
              :min="1"
              :max="totalPages"
              placeholder="页码"
              size="small"
              style="width: 100px"
              type="number"
            />
            <NativeButton size="small" theme="primary" @click="handleJumpPageConfirm">
              确定
            </NativeButton>
            <span>共 {{ totalPages }} 页</span>
            <NativeButton size="small" @click="nextPage" :disabled="currentPage >= totalPages">
              下一页 <NativeIcon name="chevron-right" />
            </NativeButton>
          </div>
        </div>

        <!-- Markdown 预览 -->
        <MdPreview
          v-else-if="previewType === 'markdown'"
          :modelValue="previewContent"
          :sanitize="sanitizeRichHtml"
          :theme="editorTheme"
          :previewTheme="previewTheme"
          :codeTheme="codeTheme"
          class="markdown-preview"
        />

        <!-- 代码预览 -->
        <div v-else-if="previewType === 'code'" class="code-preview">
          <pre><code v-html="highlightedCode" :class="`language-${previewLanguage}`"></code></pre>
        </div>

        <!-- 文本预览 -->
        <div v-else-if="previewType === 'text'" class="text-preview">
          <pre>{{ previewContent }}</pre>
        </div>

        <!-- 图片预览 -->
        <div v-else-if="previewType === 'image'" class="image-preview">
          <img :src="`data:image/${getImageMimeType(previewFileName)};base64,${previewContent}`" :alt="previewFileName" />
        </div>

        <!-- Word HTML 预览 -->
        <div v-else-if="previewType === 'word-html'" class="word-html-preview">
          <div class="office-toolbar">
            <NativeButton size="small" theme="default" @click="handleDownloadPreviewFile">下载文件</NativeButton>
          </div>
          <div class="word-content" v-html="sanitizedPreviewContent"></div>
        </div>

        <!-- Office 文档预览 -->
        <div v-else-if="previewType === 'office'" class="office-preview">
          <NativeIcon :name="getOfficeIconName(previewLanguage)" size="64" />
          <h3>{{ getOfficeTypeLabel(previewLanguage) }}文档</h3>
          <p>此文件格式不支持在线预览,请下载后使用 Microsoft Office 或 WPS 打开</p>
          <NativeButton theme="primary" @click="handleDownloadPreviewFile">下载文件</NativeButton>
        </div>

        <!-- 其他格式 -->
        <div v-else class="unsupported-preview">
          <NativeIcon name="info" size="48" />
          <p>此文件格式不支持在线预览,请下载后查看</p>
          <NativeButton theme="primary" @click="handleDownloadPreviewFile">下载文件</NativeButton>
        </div>

        <div class="preview-footer">
          <span class="file-info">文件名: {{ previewFileName }}</span>
          <span class="file-info">文件大小: {{ formatFileSize(previewFileSize) }}</span>
        </div>
      </div>
    </NativeDialog>

  </div>
</template>

<script setup>
import { ref, onMounted, computed, nextTick } from 'vue'
import api from '@/api'
import { authenticatedAssetUrl } from '@/utils/authentication'
import { marked } from 'marked'
import hljs from 'highlight.js'
import mammoth from 'mammoth'
import { usePermission } from '@/composables/usePermission'
import { useToast } from '@/composables/useToast'
import {
  sanitizeHighlightHtml,
  sanitizeRichHtml
} from '@/utils/sanitizeHtml'
import { 
  NativeButton, NativeInput, NativeCard, NativeDialog, NativeRow, NativeCol, 
  NativeCheckbox, NativeLoading, NativeIcon, NativeSpace, NativeRadioGroup, NativeRadio,
  NativeSelect, NativeForm, NativeFormItem, NativeDateRangePicker, NativePopconfirm,
  NativeAlert, NativeTable, NativePagination, NativeUpload, NativeTextarea, NativeDivider,
  NativeTreeSelect
} from '@/components/native'
import { MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'

const toast = useToast()
const { isGuest, canWrite } = usePermission()

// 动态加载 PDF.js (不使用本地 pdfjs-dist,避免版本冲突)
let pdfjsLib = null

// 配置 marked 选项
marked.setOptions({
  highlight: function (code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value
    }
    return hljs.highlightAuto(code).value
  },
  breaks: true,
  gfm: true
})

// 动态加载 PDF.js 的函数
async function loadPdfJS() {
  if (pdfjsLib) return pdfjsLib

  try {
    // 使用 PDF.js 2.10.377 版本(经过验证的稳定版本)
    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.10.377/pdf.min.js'
    script.async = true

    await new Promise((resolve, reject) => {
      script.onload = resolve
      script.onerror = reject
      document.head.appendChild(script)
    })

    // 获取全局的 pdfjsLib 对象
    pdfjsLib = window.pdfjsLib

    // 配置 worker URL(使用 jsdelivr CDN,更稳定)
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.10.377/build/pdf.worker.min.js'

    console.log('PDF.js 加载成功,版本:', pdfjsLib.version)
    return pdfjsLib
  } catch (error) {
    console.error('加载 PDF.js 失败:', error)
    throw error
  }
}

const loading = ref(false)
const documents = ref([])
const total = ref(0)
const pagination = ref({ current: 1, pageSize: 30 })
const versions = ref([])
const versionDocumentId = ref(null)
const versionTrash = ref([])
const versionTrashLoading = ref(false)
const versionTrashDialogVisible = ref(false)
const trashDocuments = ref([])
const trashLoading = ref(false)
const uploadDialogVisible = ref(false)
const uploadConflictDialogVisible = ref(false)
const uploadConflict = ref(null)
const selectedUploadConflictCandidateId = ref(null)
const versionsDialogVisible = ref(false)
const createCategoryDialogVisible = ref(false)
const deleteCategoryDialogVisible = ref(false)
const deleteCategoryData = ref(null)
const renameCategoryDialogVisible = ref(false)
const renameCategoryData = ref(null)
const renameCategoryName = ref('')
const searchKeyword = ref('')

// 浏览模式
const viewMode = ref('category') // category, list
const categories = ref([])
const currentCategoryId = ref(null) // 当前选中的分类ID
const categoryPath = ref([]) // 当前分类路径
const categoryFileCount = ref({}) // 分类文件数量缓存
const currentCategoryName = computed(() => {
  if (categoryPath.value.length === 0) return ''
  return categoryPath.value[categoryPath.value.length - 1].name
})
const currentCategoryPath = computed(() => {
  return categoryPath.value.map(c => c.name).join(' / ')
})

// 预览相关状态
const previewDialogVisible = ref(false)
const previewLoading = ref(false)
const previewContent = ref('')
const previewType = ref('text')
const previewLanguage = ref('plaintext')
const previewFileName = ref('')
const previewFileSize = ref(0)
const previewTitle = ref('')
const previewDocumentId = ref(null)
const pdfCanvas = ref(null)
const currentPage = ref(1)
const totalPages = ref(0)
const pdfDoc = ref(null)
const jumpPageNum = ref(1)

// 分类悬停相关状态
const hoveredCategoryId = ref(null)
// fileCount 现在从后端分类数据中获取，不再需要额外的状态存储

// Markdown预览主题配置
const editorTheme = ref('light')
const previewTheme = ref('default')
const codeTheme = ref('atom')

// 拖拽相关状态
const draggedCategoryId = ref(null)
const draggedCategoryIndex = ref(null)
const draggedCategoryData = ref(null)
const isDraggingFile = ref(false) // 上传对话框拖拽状态
const uploading = ref(false) // 上传进度状态

const uploadForm = ref({
  file: [],
  title: '',
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

// 反向映射：后端字段名 -> 列 colKey
const sortColKeyMap = {
  'title': 'title',
  'file_type': 'type',
  'updated_at': 'updatedAt'
}

// 计算表格排序状态（双向同步）
const tableSort = computed(() => {
  const colKey = sortColKeyMap[sortBy.value]
  if (!colKey) {
    // 下拉栏选择的是表头没有的字段，清空表头高亮
    return null
  }
  return {
    sortBy: colKey,
    descending: sortOrder.value === 'desc'
  }
})

const selectedRowKeys = ref([])
const allDocumentIds = ref([])  // 所有文档ID（用于跨页全选）
const batchEditDialogVisible = ref(false)
const isSingleEdit = ref(false)
const singleEditId = ref(null)
const batchEditForm = ref({
  categoryPath: '',
  category: '',
  subcategory: '',
  tags: ''
})

// 高级搜索相关
const advancedSearchVisible = ref(false)
const selectedTags = ref([])
const dateRange = ref([])
const allTags = ref([])

// 分类树数据（用于树形选择器）
const categoryTreeData = computed(() => {
  const buildTree = (categories) => {
    return categories.map(cat => ({
      value: cat.path,
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

const currentSubcategories = computed(() => {
  if (!currentCategoryId.value) return []
  const currentCat = findCategoryById(categories.value, currentCategoryId.value)
  return currentCat?.subcategories || []
})

// 处理排序方式变化（下拉选择框）
function handleDropdownSortChange() {
  tableSort.value = { sortBy: sortBy.value, descending: sortOrder.value === 'desc' }
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
    categoryPath: '',
    category: '',
    subcategory: '',
    tags: ''
  }
  batchEditDialogVisible.value = true
}

function handleChangeSingle(row) {
  isSingleEdit.value = true
  singleEditId.value = row.id
  // 预填充当前值
  const currentPath = row.category ? (row.subcategory ? `${row.category}/${row.subcategory}` : row.category) : ''
  batchEditForm.value = {
    categoryPath: currentPath,
    category: row.category || '',
    subcategory: row.subcategory || '',
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
    
    // 解析分类路径
    if (batchEditForm.value.categoryPath) {
      const pathParts = batchEditForm.value.categoryPath.split('/')
      updateData.category = pathParts[0]
      updateData.subcategory = pathParts.length > 1 ? pathParts.slice(1).join('/') : ''
    }
    if (batchEditForm.value.tags) {
      updateData.tags = batchEditForm.value.tags
    }

    await api.documents.batchUpdate(updateData)
    toast.success(isSingleEdit.value ? '更改成功' : '批量更新成功')
    batchEditDialogVisible.value = false
    selectedRowKeys.value = []
    // 清除文件数量缓存，以便悬停时重新加载
    categoryFileCount.value = {}
    loadDocuments()
    // 重新加载标签列表
    loadAllTags()
  } catch (error) {
    console.error('更新失败:', error)
    toast.error('更新失败')
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
    loadDocuments()
  } catch (error) {
    console.error('批量删除失败:', error)
    toast.error('批量删除失败')
  }
}

function handleBatchCategoryChange(value) {
  // 解析分类路径
  if (value) {
    const pathParts = value.split('/')
    batchEditForm.value.category = pathParts[0]
    batchEditForm.value.subcategory = pathParts.length > 1 ? pathParts.slice(1).join('/') : ''
  } else {
    batchEditForm.value.category = ''
    batchEditForm.value.subcategory = ''
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
  loadDocuments()
}

function resetAdvancedSearch() {
  selectedTags.value = []
  dateRange.value = []
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

const columns = computed(() => [
  { key: 'title', dataIndex: 'title', title: '标题', minWidth: 200, sorter: true },
  { key: 'tags', dataIndex: 'tags', title: '标签', width: 150 },
  { key: 'version', dataIndex: 'version', title: '版本', width: 80 },
  { key: 'type', dataIndex: 'filePath', title: '类型', width: 80, sorter: true },
  { key: 'updatedAt', dataIndex: 'updatedAt', title: '更新时间', width: 180, sorter: true },
  { key: 'operation', title: '操作', width: 200, align: 'left', headerAlign: 'left' }
])

const versionColumns = [
  { key: 'version', dataIndex: 'version', title: '版本号', width: 100 },
  { key: 'isCurrent', dataIndex: 'isCurrent', title: '状态', width: 100 },
  { key: 'note', dataIndex: 'note', title: '说明' },
  { key: 'createdAt', dataIndex: 'createdAt', title: '创建时间', width: 180 },
  { key: 'operation', title: '操作', width: 420 }
]

const trashColumns = [
  { key: 'title', dataIndex: 'title', title: '标题', minWidth: 200 },
  { key: 'originalPath', dataIndex: 'originalPath', title: '原分类', minWidth: 160 },
  { key: 'deletedAt', dataIndex: 'deletedAt', title: '删除时间', width: 180 },
  { key: 'purgeAfter', dataIndex: 'purgeAfter', title: '保护期至', width: 180 },
  { key: 'operation', title: '操作', width: 220 }
]

const lineCount = computed(() => {
  if (!editForm.value || !editForm.value.content) return 0
  return editForm.value.content.split('\n').length
})

const highlightedCode = computed(() => {
  if (!previewContent.value || previewType.value !== 'code') return ''
  return sanitizeHighlightHtml(
    hljs.highlight(previewContent.value, {
      language: previewLanguage.value
    }).value
  )
})

const sanitizedPreviewContent = computed(() =>
  sanitizeRichHtml(previewContent.value)
)

async function loadDocuments() {
  loading.value = true
  try {
    const params = { 
      keyword: searchKeyword.value,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
      page: pagination.value.current,
      pageSize: pagination.value.pageSize
    }

    if (currentCategoryId.value) {
      const currentCat = findCategoryById(categories.value, currentCategoryId.value)
      if (currentCat) {
        // 将分类路径拆分为 category 和 subcategory
        const pathParts = currentCat.path.split('/')
        params.category = pathParts[0]
        if (pathParts.length > 1) {
          params.subcategory = pathParts.slice(1).join('/')
          // 包含所有子分类的文档
          params.includeSubcategories = 'true'
        }
      }
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

    // 同时获取分页数据和所有文档ID（用于跨页全选）
    const [response, allIdsResponse] = await Promise.all([
      api.documents.list(params),
      api.documents.list({ ...params, page: 1, pageSize: 10000 })  // 获取所有ID
    ])
    console.log('加载文档响应:', response)
    const data = response.data?.data || response.data || []
    total.value = response.data?.total || 0

    documents.value = (Array.isArray(data) ? data : []).map(doc => ({
      id: doc.id,
      title: doc.title,
      category: doc.category,
      subcategory: doc.subcategory || '',
      tags: doc.tags,
      version: doc.version,
      filePath: doc.filePath,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      size: doc.size || 0
    }))

    // 存储所有文档ID用于跨页全选
    const allData = allIdsResponse.data?.data || allIdsResponse.data || []
    allDocumentIds.value = (Array.isArray(allData) ? allData : []).map(doc => doc.id)

    // 排序已在后端完成，无需前端再排序
  } catch (error) {
    console.error('加载文档失败:', error)
    toast.error('加载文档失败')
    documents.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

async function loadCategories() {
  try {
    const response = await api.documents.categories()
    console.log('分类响应:', response)
    categories.value = response.data?.data || []
  } catch (error) {
    console.error('加载分类失败:', error)
    categories.value = []
  }
}

function handleViewModeChange() {
  currentCategoryId.value = null
  categoryPath.value = []
  documents.value = []

  if (viewMode.value === 'trash') {
    loadTrashDocuments()
  } else {
    loadDocuments()
  }
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
  // 直接返回主界面(根分类)
  categoryPath.value = []
  currentCategoryId.value = null
  loadDocuments()
}

function handleCreateCategory() {
  categoryForm.value = { name: '' }
  createCategoryDialogVisible.value = true
}

function handleCreateSubcategory() {
  categoryForm.value = { name: '' }
  createCategoryDialogVisible.value = true
}

async function handleCreateCategoryConfirm() {
  try {
    if (!categoryForm.value.name || !categoryForm.value.name.trim()) {
      toast.error('请输入分类名称')
      return
    }

    const parentId = currentCategoryId.value
    await api.documents.createCategory({
      name: categoryForm.value.name.trim(),
      parentId: parentId || null
    })

    toast.success('创建成功')
    createCategoryDialogVisible.value = false
    loadCategories()
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

    await api.documents.deleteCategory(deleteCategoryData.value.id)

    toast.success('分类已删除，文档已移到父分类或未分类')
    deleteCategoryDialogVisible.value = false
    deleteCategoryData.value = null

    // 刷新分类和文档列表
    loadCategories()
    loadDocuments()
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

    await api.documents.updateCategory(renameCategoryData.value.id, {
      name: renameCategoryName.value.trim()
    })

    toast.success('重命名成功')
    renameCategoryDialogVisible.value = false
    renameCategoryData.value = null

    // 刷新分类和文档列表
    loadCategories()
    loadDocuments()
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
    category: '',
    subcategory: '',
    tags: '',
    versionNote: ''
  }

  // 自动填充当前分类
  if (currentCategoryId.value) {
    const currentCat = findCategoryById(categories.value, currentCategoryId.value)
    if (currentCat) {
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
  console.log('预览文件，row数据:', row)
  console.log('文件路径:', row.filePath)

  if (!row || !row.id) {
    toast.error('无法预览，文档ID不存在')
    return
  }

  loadPreviewContent(row)
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

    await api.documents.updateContent(editForm.value.id, {
      content: editForm.value.content,
      versionNote: editForm.value.versionNote
    })

    toast.success('保存成功')
    editDialogVisible.value = false
    loadDocuments()
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
    await api.documents.delete(id)
    toast.success('删除成功')
    loadCategories()
    loadDocuments()
  } catch (error) {
    toast.error('删除失败')
  }
}

async function handleViewVersions(row) {
  try {
    versionDocumentId.value = row.id
    const response = await api.documents.versions(row.id)
    console.log('版本响应:', response)
    const data = response.data?.data || response.data || []
    versions.value = Array.isArray(data) ? data : []
    versionsDialogVisible.value = true
  } catch (error) {
    console.error('加载版本失败:', error)
    toast.error(documentErrorMessage(error, '加载版本失败'))
  }
}

async function handleRestoreVersion(row) {
  if (!versionDocumentId.value || row?.isCurrent || !canWrite.value) return
  try {
    await api.documents.restoreVersion(versionDocumentId.value, row.id)
    toast.success('版本恢复成功，已创建新的当前版本')
    versionsDialogVisible.value = false
    await loadDocuments()
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
    await Promise.all([handleViewVersions({ id: versionDocumentId.value }), loadVersionTrash(false)])
  } catch (error) {
    console.error('移入版本回收站失败:', error)
    toast.error(documentErrorMessage(error, '移入版本回收站失败'))
  }
}

async function loadVersionTrash(showDialog = true) {
  if (!versionDocumentId.value) return
  versionTrashLoading.value = true
  try {
    const response = await api.documents.versionsTrash(versionDocumentId.value)
    const data = response.data?.data || response.data || []
    versionTrash.value = Array.isArray(data) ? data : []
    if (showDialog) versionTrashDialogVisible.value = true
  } catch (error) {
    console.error('加载版本回收站失败:', error)
    toast.error(documentErrorMessage(error, '加载版本回收站失败'))
    versionTrash.value = []
  } finally {
    versionTrashLoading.value = false
  }
}

function openVersionTrash() {
  loadVersionTrash(true)
}

async function handleRestoreVersionTrash(row) {
  if (!versionDocumentId.value || !row?.id || !canWrite.value) return
  try {
    await api.documents.restoreVersionTrash(versionDocumentId.value, row.id)
    toast.success('版本已恢复，已创建新的当前版本')
    await Promise.all([
      loadVersionTrash(false),
      handleViewVersions({ id: versionDocumentId.value }),
      loadDocuments()
    ])
  } catch (error) {
    console.error('恢复版本回收站条目失败:', error)
    toast.error(documentErrorMessage(error, '恢复版本失败'))
  }
}

async function loadTrashDocuments() {
  trashLoading.value = true
  try {
    const response = await api.documents.trash()
    trashDocuments.value = response.data?.data || []
  } catch (error) {
    console.error('加载回收站失败:', error)
    toast.error('加载回收站失败')
    trashDocuments.value = []
  } finally {
    trashLoading.value = false
  }
}

async function handleRestoreTrash(id) {
  try {
    await api.documents.restoreTrash(id)
    toast.success('文档已恢复')
    await Promise.all([loadTrashDocuments(), loadCategories()])
  } catch (error) {
    console.error('恢复文档失败:', error)
    toast.error(error.response?.data?.message || '恢复文档失败')
  }
}

async function handlePermanentlyDeleteTrash(id) {
  try {
    await api.documents.permanentlyDeleteTrash(id)
    toast.success('文档已永久删除')
    await loadTrashDocuments()
  } catch (error) {
    console.error('永久删除文档失败:', error)
    toast.error(error.response?.data?.message || '永久删除文档失败')
  }
}

function formatDateTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

async function loadPreviewContent(row) {
  try {
    previewDialogVisible.value = true
    previewLoading.value = true
    previewContent.value = ''
    previewFileName.value = row.title || row.filePath?.split('/').pop() || '未知文件'
    previewTitle.value = `预览 - ${previewFileName.value}`
    previewDocumentId.value = row.id
    currentPage.value = 1
    totalPages.value = 0
    pdfDoc.value = null

    const listedExt = row.filePath?.split('.').pop()?.toLowerCase()
    if (listedExt === 'xls' || listedExt === 'xlsx') {
      previewType.value = 'office'
      previewLanguage.value = 'excel'
      previewFileSize.value = row.size || 0
      previewLoading.value = false
      return
    }

    const response = await api.documents.getContent(row.id)
    console.log('预览内容响应:', response)

    const data = response.data || {}
    const content = data.content || ''
    const fileName = data.fileName || ''
    const isBase64 = data.isBase64 || false
    const fileSize = data.fileSize || 0

    previewFileSize.value = fileSize

    // 根据文件扩展名确定预览类型
    const ext = fileName.split('.').pop().toLowerCase()
    const previewInfo = getPreviewType(ext)

    previewType.value = previewInfo.type
    previewLanguage.value = previewInfo.language

    if (previewType.value === 'pdf') {
      // 处理 PDF 预览：将 base64 转换为 Uint8Array
      const pdfData = isBase64 ? base64ToUint8Array(content) : content

      // 先加载 PDF 文档,但不渲染
      await loadPDFDocument(pdfData)

      // 先停止加载状态,让 canvas 渲染到 DOM
      previewLoading.value = false

      // 等待 DOM 更新完成
      await nextTick()

      // 现在渲染第一页
      await renderPage(currentPage.value)
    } else if (isBase64) {
      // 其他二进制和图片文件
      if (previewType.value === 'image') {
        // 图片: 直接使用 base64
        previewContent.value = content
        previewLoading.value = false
      } else if (previewType.value === 'office') {
        // Office 文件: 尝试解析并预览
        await loadOfficeContent(content, ext)
      } else {
        // 其他二进制文件不支持预览
        previewType.value = 'unsupported'
        console.log('不支持预览的文件类型:', ext)
        previewLoading.value = false
      }
    } else {
      previewContent.value = content
      previewLoading.value = false
    }

    console.log('预览类型:', previewType.value, '语言:', previewLanguage.value, '是否Base64:', isBase64)
  } catch (error) {
    console.error('加载预览内容失败:', error)
    if (error.response?.status === 400) {
      previewType.value = 'unsupported'
    } else {
      toast.error('加载预览失败')
      previewDialogVisible.value = false
    }
    previewLoading.value = false
  }
}

// 将 base64 字符串转换为 Uint8Array
function base64ToUint8Array(base64) {
  const binaryString = atob(base64)
  const len = binaryString.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

// 加载Office文档内容
async function loadOfficeContent(base64Content, ext) {
  if (ext !== 'docx') {
    previewType.value = 'office'
    previewLoading.value = false
    return
  }

  try {
    // 将base64转换为ArrayBuffer
    const binaryString = atob(base64Content)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    const arrayBuffer = bytes.buffer

    // Word文档预览
    const result = await mammoth.convertToHtml({ arrayBuffer })
    previewContent.value = result.value
    previewType.value = 'word-html'
    previewLoading.value = false
  } catch (error) {
    console.error('加载Office文档内容失败:', error)
    previewType.value = 'office'
    previewLoading.value = false
    toast.warning('文档预览失败，请下载后查看')
  }
}

async function loadPDFDocument(pdfData) {
  try {
    console.log('开始加载 PDF,数据类型:', typeof pdfData, '长度:', pdfData?.length)
    console.log('PDF 数据前 100 字符:', typeof pdfData === 'string' ? pdfData.substring(0, 100) : 'binary data')

    // 动态加载 PDF.js
    const pdfjs = await loadPdfJS()
    console.log('PDF.js 已加载,版本:', pdfjs.version)

    // 确保数据是 Uint8Array
    let uint8Array = pdfData
    if (typeof pdfData === 'string') {
      uint8Array = base64ToUint8Array(pdfData)
      console.log('转换为 Uint8Array,长度:', uint8Array.length)
    }

    // 使用 Promise 方式加载,添加详细错误处理
    console.log('开始加载 PDF 文档...')
    console.log('PDF 数据前 16 字节(Array):', Array.from(uint8Array.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '))

    const loadingTask = pdfjs.getDocument(uint8Array)

    // 监听加载进度
    loadingTask.onProgress = (progress) => {
      if (progress.total > 0) {
        console.log(`PDF 加载进度: ${Math.round(progress.loaded / progress.total * 100)}%`)
      }
    }

    const doc = await loadingTask.promise
    console.log('PDF 文档加载成功,页数:', doc.numPages)

    pdfDoc.value = doc
    totalPages.value = doc.numPages
  } catch (error) {
    console.error('加载 PDF 文档失败:', error)
    console.error('错误名称:', error.name)
    console.error('错误消息:', error.message)
    console.error('错误堆栈:', error.stack)

    // 尝试提供更多诊断信息
    if (error.message.includes('private member')) {
      console.error('这是私有字段访问错误,可能需要降级 PDF.js 版本')
    }

    toast.error('PDF 加载失败: ' + (error.message || '未知错误'))
    throw error
  }
}

async function renderPage(pageNum) {
  try {
    if (!pdfDoc.value || !pdfCanvas.value) {
      console.error('pdfDoc 或 pdfCanvas 未初始化')
      return
    }

    console.log(`开始渲染第 ${pageNum} 页`)
    const page = await pdfDoc.value.getPage(pageNum)
    console.log(`第 ${pageNum} 页获取成功`)

    const canvas = pdfCanvas.value
    const context = canvas.getContext('2d')

    const scale = 1.5
    const viewport = page.getViewport({ scale })

    console.log(`页面尺寸: ${viewport.width} x ${viewport.height}`)

    // 清空 canvas 并设置新尺寸
    context.clearRect(0, 0, canvas.width, canvas.height)
    canvas.height = viewport.height
    canvas.width = viewport.width

    const renderContext = {
      canvasContext: context,
      viewport: viewport
    }

    await page.render(renderContext).promise
    console.log(`第 ${pageNum} 页渲染成功`)
  } catch (error) {
    console.error(`渲染第 ${pageNum} 页失败:`, error)
    console.error('错误名称:', error.name)
    console.error('错误消息:', error.message)
    toast.error('渲染 PDF 页面失败')
  }
}

async function prevPage() {
  if (currentPage.value > 1) {
    currentPage.value--
    await renderPage(currentPage.value)
    // 滚动到PDF预览区域顶部
    scrollToPdfTop()
  }
}

async function nextPage() {
  if (currentPage.value < totalPages.value) {
    currentPage.value++
    jumpPageNum.value = currentPage.value
    await renderPage(currentPage.value)
    // 滚动到PDF预览区域顶部
    scrollToPdfTop()
  }
}

async function handleJumpPageConfirm() {
  const pageNum = parseInt(jumpPageNum.value)
  if (pageNum >= 1 && pageNum <= totalPages.value) {
    currentPage.value = pageNum
    await renderPage(currentPage.value)
    // 滚动到PDF预览区域顶部
    scrollToPdfTop()
  } else {
    toast.warning(`请输入有效的页码（1-${totalPages.value}）`)
  }
}

// 滚动到PDF预览区域顶部
function scrollToPdfTop() {
  const pdfPreview = document.querySelector('.pdf-preview')
  if (pdfPreview) {
    pdfPreview.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
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

function getPreviewType(ext) {
  const markdownFiles = ['md', 'markdown', 'mdown', 'mkd']
  const codeFiles = {
    'js': 'javascript',
    'ts': 'typescript',
    'jsx': 'javascript',
    'tsx': 'typescript',
    'py': 'python',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'go': 'go',
    'rs': 'rust',
    'rb': 'ruby',
    'php': 'php',
    'swift': 'swift',
    'kt': 'kotlin',
    'scala': 'scala',
    'sql': 'sql',
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'fish': 'bash',
    'xml': 'xml',
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'ini': 'ini',
    'conf': 'ini',
    'cfg': 'ini',
    'pdf': 'pdf'
  }

  if (ext === 'pdf') {
    return { type: 'pdf', language: 'pdf', editable: false }
  } else if (markdownFiles.includes(ext)) {
    return { type: 'markdown', language: 'markdown', editable: true }
  } else if (codeFiles[ext]) {
    return { type: 'code', language: codeFiles[ext], editable: true }
  } else if (['txt', 'log', 'csv', 'tsv'].includes(ext)) {
    return { type: 'text', language: 'plaintext', editable: true }
  } else if (['doc', 'docx'].includes(ext)) {
    return { type: 'office', language: 'word', editable: false }
  } else if (['ppt', 'pptx'].includes(ext)) {
    return { type: 'office', language: 'ppt', editable: false }
  } else if (['xls', 'xlsx'].includes(ext)) {
    return { type: 'office', language: 'excel', editable: false }
  } else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) {
    return { type: 'image', language: 'image', editable: false }
  } else {
    return { type: 'unsupported', language: 'plaintext', editable: false }
  }
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

function getImageMimeType(fileName) {
  if (!fileName) return 'png'
  const ext = fileName.split('.').pop().toLowerCase()
  const mimeTypes = {
    'jpg': 'jpeg',
    'jpeg': 'jpeg',
    'png': 'png',
    'gif': 'gif',
    'bmp': 'bmp',
    'webp': 'webp'
  }
  return mimeTypes[ext] || 'png'
}

function getOfficeIconName(type) {
  // Phosphor Icons 图标名称映射
  const icons = {
    'word': 'file-text',
    'ppt': 'file-text',
    'excel': 'file-text'
  }
  return icons[type] || 'file'
}

function getOfficeTypeLabel(type) {
  const labels = {
    'word': 'Word',
    'ppt': 'PowerPoint',
    'excel': 'Excel'
  }
  return labels[type] || 'Office'
}

function handleDownloadPreviewFile() {
  const row = documents.value.find(d => d.id === previewDocumentId.value)
  if (row) {
    handleDownload(row)
  }
}

onMounted(() => {
  loadCategories()
  loadAllTags()
  loadDocuments()
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
  color: #333;
  margin: 0 0 8px 0;
}

.page-header p {
  font-size: 16px;
  color: #333;
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
  border-top: 1px solid #e8e8e8;
  display: flex;
  gap: 12px;
}

/* 高级搜索面板 */
.advanced-search-panel {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #e8e8e8;
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
  color: #333;
  margin: 0;
}

.empty-categories p {
  font-size: 16px;
  color: #666;
  margin: 0;
}

.category-children {
  padding: 16px 0;
}

.category-path {
  font-size: 18px;
  color: #333;
  margin-bottom: 24px;
  padding-bottom: 12px;
  border-bottom: 2px solid #667eea;
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
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 3px 8px rgba(102, 126, 234, 0.2);
  position: relative;
  user-select: none;
}

.category-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 6px 16px rgba(102, 126, 234, 0.4);
}

.category-card.drag-over {
  border: 2px dashed #0052d9;
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
  color: #333;
}

.delete-category-content .delete-info {
  display: flex;
  align-items: center;
  font-size: 14px;
  color: #666;
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
  box-shadow: 0 0 30px rgba(102, 126, 234, 0.6) !important;
  border: 2px dashed #667eea !important;
}

.drag-active :deep(.native-dialog__content) {
  background: rgba(102, 126, 234, 0.05) !important;
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
  color: #333;
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
  background: #667eea;
  color: white;
  transform: translateX(5px);
}

.subcategory-item .t-icon {
  color: #667eea;
}

.subcategory-item:hover .t-icon {
  color: white;
}

.subcategory-item.all-docs {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
  color: #333;
  margin-bottom: 0;
  padding-bottom: 8px;
  border-bottom: 2px solid #667eea;
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
  color: #666;
  margin-left: auto;
}

.native-table {
  margin-top: 16px;
}

.native-table :deep(.native-table__th) {
  background: #f6f8fa;
  font-weight: 600;
  color: #333;
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
  color: #666;
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
  color: #333;
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
  color: #667eea;
  margin-bottom: 20px;
}

.office-preview h3 {
  margin: 0;
  font-size: 20px;
  color: #333;
}

.office-preview p {
  margin: 0;
  font-size: 14px;
  color: #666;
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
  color: #666;
}

.unsupported-preview .t-icon {
  color: #999;
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

.office-toolbar {
  display: flex;
  justify-content: flex-end;
  padding: 8px 16px;
  background: #f6f8fa;
  border-radius: 8px 8px 0 0;
}

.word-content {
  padding: 20px;
  background: #fff;
  border-radius: 0 0 8px 8px;
  min-height: 400px;
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
  color: #666;
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
  border-color: #667eea;
  box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
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
  color: #333;
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
  color: #666;
}

.file-info {
  display: flex;
  align-items: center;
  gap: 16px;
}

/* 滚动条美化 */
:deep(*)::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

:deep(*)::-webkit-scrollbar-track {
  background: #f1f1f1;
  border-radius: 4px;
}

:deep(*)::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, #667eea 0%, #764ba2 100%);
  border-radius: 4px;
}

:deep(*)::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, #5568d3 0%, #653a8f 100%);
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

/* 操作列样式：内容左对齐，但列整体靠右 */
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
    color: #0052d9;
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
    border-color: #ed7b2f;
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
</style>
