<template>
  <div class="documents">
    <div class="page-header">
      <p>管理 PDF、Word、PPT、文本等文档</p>
    </div>

        <!-- 浏览模式切换 -->
        <t-card>
          <t-space direction="vertical" style="width: 100%">
            <t-radio-group v-model="viewMode" variant="default-filled" @change="handleViewModeChange">
              <t-radio-button value="category">
                <t-icon name="folder" /> 分类浏览
              </t-radio-button>
              <t-radio-button value="list">
                <t-icon name="view-list" /> 列表视图
              </t-radio-button>
              <t-radio-button value="private">
                <t-icon name="lock-on" /> 私密空间
              </t-radio-button>
            </t-radio-group>

        <!-- 搜索栏和排序 -->
        <div class="search-sort-row">
          <t-input
            v-model="searchKeyword"
            :placeholder="viewMode === 'private' ? '搜索私密文件...' : '搜索文档...'"
            clearable
            @clear="handleSearch"
            @enter="handleSearch"
            style="flex: 1"
          >
            <template #suffix-icon>
              <t-icon name="search" />
            </template>
          </t-input>

          <t-button variant="outline" @click="advancedSearchVisible = !advancedSearchVisible">
            <t-icon name="filter" /> 高级搜索
          </t-button>

          <t-select
            v-model="sortBy"
            placeholder="排序方式"
            style="width: 140px"
            @change="handleDropdownSortChange"
          >
            <t-option value="updated_at" label="更新时间" />
            <t-option value="title" label="文件名" />
            <t-option value="file_type" label="文件类型" />
            <t-option value="size" label="文件大小" />
          </t-select>

          <t-button
            variant="outline"
            @click="toggleSortOrder"
            shape="circle"
            :title="sortOrder === 'desc' ? '降序' : '升序'"
          >
            <template #icon>
              <t-icon :name="sortOrder === 'desc' ? 'arrow-down' : 'arrow-up'" />
            </template>
          </t-button>
        </div>

        <!-- 高级搜索面板 -->
        <t-card v-if="advancedSearchVisible" class="advanced-search-panel">
          <t-space direction="vertical" style="width: 100%">
            <t-form layout="inline">
              <!-- 标签筛选（私密空间不显示） -->
              <t-form-item v-if="viewMode !== 'private'" label="标签">
                <t-select
                  v-model="selectedTags"
                  placeholder="选择标签"
                  multiple
                  clearable
                  style="width: 200px"
                >
                  <t-option v-for="tag in allTags" :key="tag" :value="tag" :label="tag" />
                </t-select>
              </t-form-item>
              <t-form-item label="日期范围">
                <t-date-range-picker
                  v-model="dateRange"
                  enable-time-picker
                  style="width: 300px"
                />
              </t-form-item>
            </t-form>
            <t-space>
              <t-button theme="primary" @click="handleAdvancedSearch">搜索</t-button>
              <t-button @click="resetAdvancedSearch">重置</t-button>
            </t-space>
          </t-space>
        </t-card>

        <t-space>
          <!-- 批量操作按钮 -->
          <t-button
            v-if="selectedRowKeys.length > 0"
            theme="primary"
            @click="handleBatchEdit"
            :disabled="isGuest"
          >
            <template #icon><t-icon name="edit" /></template>
            批量更改 ({{ selectedRowKeys.length }})
          </t-button>
          <t-popconfirm
            v-if="selectedRowKeys.length > 0"
            content="确定删除选中的文档吗？"
            @confirm="handleBatchDelete"
          >
            <t-button theme="danger" variant="outline" :disabled="isGuest">
              <template #icon><t-icon name="delete" /></template>
              批量删除 ({{ selectedRowKeys.length }})
            </t-button>
          </t-popconfirm>
          <!-- 创建分类按钮（仅在分类浏览模式且在根目录时显示） -->
          <t-button
            v-if="viewMode === 'category' && !currentCategoryId"
            theme="default"
            @click="handleCreateCategory"
            :disabled="isGuest"
          >
            <template #icon><t-icon name="folder-add" /></template>
            创建分类
          </t-button>
          <!-- 创建子分类按钮（在分类内时显示） -->
          <t-button
            v-if="viewMode === 'category' && currentCategoryId"
            theme="default"
            @click="handleCreateSubcategory"
            :disabled="isGuest"
          >
            <template #icon><t-icon name="folder-add" /></template>
            创建子分类
          </t-button>
          <!-- 上传文档按钮（仅在选择了分类时显示） -->
          <t-button
            v-if="viewMode === 'category' && currentCategoryId"
            theme="primary"
            @click="handleUpload"
            :disabled="isGuest"
          >
            <template #icon><t-icon name="add" /></template>
            上传文档
          </t-button>
          <!-- 返回按钮（在分类内时显示） -->
          <t-button v-if="viewMode === 'category' && currentCategoryId" @click="resetCategory">
            <t-icon name="arrow-left" /> 返回上级
          </t-button>
          <t-button v-if="viewMode === 'category' && currentCategoryId" @click="backToRoot" theme="default">
            <t-icon name="home" /> 返回主界面
          </t-button>
        </t-space>
      </t-space>
    </t-card>

    <!-- 分类浏览模式 -->
    <t-card v-if="viewMode === 'category'" class="category-view">
      <!-- 加载状态 -->
      <div v-if="loading" class="content-loading">
        <t-loading size="small" />
      </div>
      <!-- 空状态：没有分类 -->
      <div v-else-if="categories.length === 0" class="empty-categories">
        <t-icon name="folder-open" size="64px" />
        <h3>还没有分类</h3>
        <p>创建第一个分类来开始管理文档</p>
        <t-button theme="primary" size="large" @click="handleCreateCategory" :disabled="isGuest">
          <template #icon><t-icon name="folder-add" /></template>
          创建第一个分类
        </t-button>
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
            <t-icon name="folder" size="48px" />
            <h3>{{ cat.name }}</h3>
            <div v-if="hoveredCategoryId === cat.id && categoryFileCount[cat.id] !== undefined" class="file-count-tooltip">
              {{ categoryFileCount[cat.id] }} 个文件
            </div>
            <div class="drag-handle" @click.stop v-if="!isGuest">
              <t-icon name="move" size="16px" />
            </div>
            <div class="rename-handle" @click.stop="handleRenameCategory(cat)" v-if="!isGuest">
              <t-icon name="edit" size="14px" />
            </div>
            <div class="delete-handle" @click.stop="handleDeleteCategory(cat)" v-if="!isGuest">
              <t-icon name="close" size="16px" />
            </div>
          </div>
        </div>
        <t-alert
          v-else
          type="info"
          message="暂无子分类"
          description="点击下方按钮创建子分类"
          style="margin-top: 20px"
        />
      </div>
      <!-- 显示根分类 -->
      <div v-else class="categories-grid">
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
          <t-icon name="folder" size="48px" />
          <h3>{{ cat.name }}</h3>
          <div v-if="hoveredCategoryId === cat.id && cat.fileCount !== undefined" class="file-count-tooltip">
              {{ cat.fileCount }} 个文件
            </div>
          <div class="drag-handle" @click.stop v-if="!isGuest">
            <t-icon name="move" size="16px" />
          </div>
          <div class="rename-handle" @click.stop="handleRenameCategory(cat)" v-if="!isGuest">
            <t-icon name="edit" size="14px" />
          </div>
          <div class="delete-handle" @click.stop="handleDeleteCategory(cat)" v-if="!isGuest">
            <t-icon name="close" size="16px" />
          </div>
        </div>
      </div>
    </t-card>

    <!-- 文档列表 -->
    <t-card v-if="documents.length > 0" class="documents-list">
      <h3 v-if="viewMode === 'category' && currentCategoryId" class="section-title">
        {{ currentCategoryPath }} - 文档列表
      </h3>
      <h3 v-else class="section-title">
        所有文档
      </h3>

      <t-table
        :data="documents"
        :columns="columns"
        :loading="loading"
        row-key="id"
        hover
        :selected-row-keys="selectedRowKeys"
        @select-change="handleSelectChange"
        :sort="tableSort"
        @sort-change="handleSortChange"
      >
        <template #operation="{ row }">
        <t-space>
            <t-button theme="primary" variant="outline" size="small" @click="handleView(row)">
              <t-icon name="browse" /> 预览
            </t-button>
            <t-button theme="primary" size="small" @click="handleChangeSingle(row)" :disabled="!canWrite">
              <t-icon name="edit" /> 更改
            </t-button>
            <t-button theme="primary" size="small" @click="handleViewVersions(row)">
              <t-icon name="history" /> 版本
            </t-button>
            <t-button theme="default" size="small" @click="handleEdit(row)" :disabled="!canWrite || !canEditFile(row.filePath)">
              <t-icon name="edit" /> 编辑
            </t-button>
            <t-popconfirm
              content="确定删除吗？"
              @confirm="handleDelete(row.id)"
              :disabled="!canWrite"
            >
              <t-button theme="danger" variant="outline" size="small" :disabled="!canWrite">
                <t-icon name="delete" /> 删除
              </t-button>
            </t-popconfirm>
          </t-space>
        </template>
      </t-table>

      <!-- 分页（列表视图和分类浏览） -->
      <div class="pagination-wrapper" v-if="(viewMode === 'list' || viewMode === 'category') && total > 0">
        <t-pagination
          v-model="pagination.current"
          v-model:page-size="pagination.pageSize"
          :total="total"
          show-page-number
          show-page-size
          :page-size-options="[30, 50, 100]"
          @change="handlePageChange"
          @page-size-change="handlePageSizeChange"
        />
      </div>
    </t-card>

    <!-- 空状态（私密空间不显示）- 仅在加载完成且无数据时显示 -->
    <t-card v-if="documents.length === 0 && !loading && !currentCategoryId && viewMode !== 'private' && viewMode !== 'category'" class="empty-state">
      <t-icon name="file" size="64px" />
      <p>暂无文档</p>
    </t-card>
    <t-card v-else-if="documents.length === 0 && !loading && currentCategoryId && viewMode !== 'private'" class="empty-state">
      <t-icon name="file" size="64px" />
      <p>当前分类下暂无文档</p>
      <t-button theme="primary" @click="handleUpload">上传第一个文档</t-button>
    </t-card>

    <!-- 批量编辑对话框 -->
    <t-dialog
      v-model:visible="batchEditDialogVisible"
      :header="isSingleEdit ? '更改文档信息' : '批量编辑文档'"
      @confirm="handleBatchEditConfirm"
      width="600px"
    >
      <t-form :data="batchEditForm">
        <t-form-item label="分类">
          <t-tree-select
            v-model="batchEditForm.categoryPath"
            :data="categoryTreeData"
            placeholder="选择分类（留空则不修改）"
            clearable
            @change="handleBatchCategoryChange"
          />
        </t-form-item>
        <t-form-item label="标签">
          <t-input v-model="batchEditForm.tags" placeholder="输入标签，用逗号分隔（留空则不修改）" />
        </t-form-item>
      </t-form>
      <p style="color: #999; font-size: 12px; margin-top: 10px;">
        提示：只有填写了内容的字段才会被更新，留空的字段保持原值。
      </p>
    </t-dialog>

    <!-- 创建分类对话框 -->
    <t-dialog
      v-model:visible="createCategoryDialogVisible"
      header="创建分类"
      @confirm="handleCreateCategoryConfirm"
      width="500px"
    >
      <t-form :data="categoryForm" :rules="categoryRules">
        <t-form-item label="分类名称" name="name" required>
          <t-input v-model="categoryForm.name" placeholder="请输入分类名称" />
        </t-form-item>
        <t-form-item v-if="currentCategoryId" label="父分类">
          <t-input :value="currentCategoryName" disabled />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 删除分类确认对话框 -->
    <t-dialog
      v-model:visible="deleteCategoryDialogVisible"
      header="删除分类"
      width="550px"
      @confirm="handleDeleteCategoryConfirm"
    >
      <div class="delete-category-content">
        <p class="delete-warning">
          <t-icon name="error-circle" style="color: #e34d59; margin-right: 8px;" />
          确定要删除分类「<strong>{{ deleteCategoryData?.name }}</strong>」吗？
        </p>
        <p class="delete-info">
          <t-icon name="info-circle" style="color: #0052d9; margin-right: 8px;" />
          此操作将同时删除该分类下的所有子分类
        </p>
        <t-divider />
        <p class="delete-question">请选择如何处理分类下的文件：</p>
        <t-radio-group v-model="deleteCategoryFileOption">
          <t-radio value="keep">
            保留文件（文件将提升到父分类，若删除根分类则移至「所有文档」）
          </t-radio>
          <t-radio value="delete">
            同时删除文件（文件将被永久删除，无法恢复）
          </t-radio>
        </t-radio-group>
      </div>
    </t-dialog>

    <!-- 重命名分类对话框 -->
    <t-dialog
      v-model:visible="renameCategoryDialogVisible"
      header="重命名分类"
      width="400px"
      @confirm="handleRenameCategoryConfirm"
    >
      <t-form>
        <t-form-item label="分类名称">
          <t-input v-model="renameCategoryName" placeholder="请输入新的分类名称" />
        </t-form-item>
      </t-form>
      <p style="color: #999; font-size: 12px; margin-top: 8px;">
        提示：同级分类下不能存在同名分类
      </p>
    </t-dialog>

    <!-- 上传对话框 -->
    <t-dialog
      v-model:visible="uploadDialogVisible"
      header="上传文档"
      @confirm="handleUploadConfirm"
      width="600px"
      :class="{ 'drag-active': isDraggingFile }"
      @dragenter.prevent="handleDialogDragEnter"
      @dragover.prevent
      @dragleave.prevent="handleDialogDragLeave"
      @drop.prevent="handleFileDrop"
    >
      <t-form :data="uploadForm" :rules="uploadRules">
        <t-form-item label="文件" required>
          <div class="upload-area">
            <t-upload
              v-model="uploadForm.file"
              theme="file-input"
              accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.xls,.xlsx,.csv,.jpg,.jpeg,.png,.gif,.bmp"
              :multiple="false"
              :auto-upload="false"
              @change="onFileChange"
              :drag="{ content: '拖拽文件到此处或点击上传' }"
            />
          </div>
        </t-form-item>
        <t-form-item label="标题" name="title" required>
          <t-input v-model="uploadForm.title" placeholder="文档标题" />
        </t-form-item>
        <t-form-item label="标签" name="tags">
          <t-input v-model="uploadForm.tags" placeholder="用逗号分隔" />
        </t-form-item>
        <t-form-item label="版本说明" name="versionNote">
          <t-textarea
            v-model="uploadForm.versionNote"
            placeholder="本次更新的说明"
            :maxlength="500"
          />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 版本对话框 -->
    <t-dialog
      v-model:visible="versionsDialogVisible"
      header="版本历史"
      width="800px"
      :footer="false"
    >
      <t-table :data="versions" :columns="versionColumns">
        <template #operation="{ row }">
          <t-button theme="primary" size="small" @click="handleDownloadVersion(row)">
            <t-icon name="download" /> 下载
          </t-button>
        </template>
      </t-table>
    </t-dialog>

    <!-- 编辑对话框 -->
    <t-dialog
      v-model:visible="editDialogVisible"
      :header="editForm ? `编辑文档 - ${editForm.fileName || ''}` : '编辑文档'"
      width="1000px"
      @confirm="handleSaveContent"
    >
      <div v-if="editLoading" class="loading-container">
        <t-loading text="加载中..." />
      </div>
      <div v-else class="edit-container">
        <t-form layout="inline" style="margin-bottom: 16px;">
          <t-form-item label="当前版本">
            <t-input :value="editForm.currentVersion" disabled style="width: 100px" />
          </t-form-item>
          <t-form-item label="新版本号" name="newVersion">
            <t-input
              v-model="editForm.newVersion"
              placeholder="如: 1.1.2"
              style="width: 120px"
            />
          </t-form-item>
          <t-form-item label="版本说明">
            <t-input
              v-model="editForm.versionNote"
              placeholder="本次更新的说明"
              style="width: 300px"
            />
          </t-form-item>
        </t-form>
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
    </t-dialog>

    <!-- 预览对话框 -->
    <t-dialog
      v-model:visible="previewDialogVisible"
      :header="previewTitle"
      width="1200px"
      :footer="false"
      top="50px"
    >
      <div v-if="previewLoading" class="loading-container">
        <t-loading text="加载中..." />
      </div>
      <div v-else class="preview-container">
        <!-- PDF 预览 -->
        <div v-if="previewType === 'pdf'" class="pdf-preview">
          <canvas ref="pdfCanvas"></canvas>
          <div class="pdf-controls">
            <t-button size="small" @click="prevPage" :disabled="currentPage <= 1">
              <t-icon name="chevron-left" /> 上一页
            </t-button>
            <t-input
              v-model="jumpPageNum"
              :min="1"
              :max="totalPages"
              placeholder="页码"
              size="small"
              style="width: 100px"
              type="number"
            />
            <t-button size="small" theme="primary" @click="handleJumpPageConfirm">
              确定
            </t-button>
            <span>共 {{ totalPages }} 页</span>
            <t-button size="small" @click="nextPage" :disabled="currentPage >= totalPages">
              下一页 <t-icon name="chevron-right" />
            </t-button>
          </div>
        </div>

        <!-- Markdown 预览 -->
        <div v-else-if="previewType === 'markdown'" class="markdown-preview" v-html="renderedMarkdown"></div>

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
            <t-button size="small" theme="default" @click="handleDownloadPreviewFile">下载文件</t-button>
          </div>
          <div class="word-content" v-html="previewContent"></div>
        </div>

        <!-- Excel HTML 预览 -->
        <div v-else-if="previewType === 'excel-html'" class="excel-html-preview">
          <div class="office-toolbar">
            <t-button size="small" theme="default" @click="handleDownloadPreviewFile">下载文件</t-button>
          </div>
          <div class="excel-content" v-html="previewContent"></div>
        </div>

        <!-- Office 文档预览 -->
        <div v-else-if="previewType === 'office'" class="office-preview">
          <t-icon :name="getOfficeIconName(previewLanguage)" size="64px" />
          <h3>{{ getOfficeTypeLabel(previewLanguage) }}文档</h3>
          <p>此文件格式不支持在线预览,请下载后使用 Microsoft Office 或 WPS 打开</p>
          <t-button theme="primary" @click="handleDownloadPreviewFile">下载文件</t-button>
        </div>

        <!-- 其他格式 -->
        <div v-else class="unsupported-preview">
          <t-icon name="info-circle" size="48px" />
          <p>此文件格式不支持在线预览,请下载后查看</p>
          <t-button theme="primary" @click="handleDownloadPreviewFile">下载文件</t-button>
        </div>

        <div class="preview-footer">
          <span class="file-info">文件名: {{ previewFileName }}</span>
          <span class="file-info">文件大小: {{ formatFileSize(previewFileSize) }}</span>
        </div>
      </div>
    </t-dialog>

    <!-- 私密空间密码验证对话框 -->
    <t-dialog
      v-model:visible="privatePasswordDialogVisible"
      header="私密空间 - 密码验证"
      width="400px"
      :close-on-overlay-click="false"
      :close-on-esc-keydown="false"
      @confirm="handlePrivatePasswordConfirm"
      @cancel="handlePrivatePasswordCancel"
    >
      <t-form autocomplete="off">
        <t-form-item label="密码">
          <t-input
            v-model="privatePasswordInput"
            type="password"
            placeholder="请输入私密空间密码"
            autocomplete="one-time-code"
            name="private-space-token"
            data-lpignore="true"
            @enter="handlePrivatePasswordConfirm"
          />
        </t-form-item>
      </t-form>
      <p v-if="privatePasswordError" style="color: #e34d59; font-size: 12px;">{{ privatePasswordError }}</p>
    </t-dialog>

    <!-- 私密空间修改密码对话框 -->
    <t-dialog
      v-model:visible="privateChangePasswordDialogVisible"
      header="修改私密空间密码"
      width="400px"
      @confirm="handleChangePrivatePasswordConfirm"
    >
      <t-form autocomplete="off">
        <t-form-item label="当前密码">
          <t-input
            v-model="privateOldPassword"
            type="password"
            placeholder="请输入当前密码"
            autocomplete="one-time-code"
            name="private-old-token"
            data-lpignore="true"
          />
        </t-form-item>
        <t-form-item label="新密码">
          <t-input
            v-model="privateNewPassword"
            type="password"
            placeholder="请输入新密码"
            autocomplete="one-time-code"
            name="private-new-token"
            data-lpignore="true"
          />
        </t-form-item>
        <t-form-item label="确认新密码">
          <t-input
            v-model="privateConfirmPassword"
            type="password"
            placeholder="请再次输入新密码"
            autocomplete="one-time-code"
            name="private-confirm-token"
            data-lpignore="true"
          />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 私密空间上传对话框 -->
    <t-dialog
      v-model:visible="privateUploadDialogVisible"
      header="上传私密文件"
      width="500px"
      @confirm="handlePrivateUploadConfirm"
    >
      <t-form :data="privateUploadForm">
        <t-form-item label="文件" required>
          <t-upload
            v-model="privateUploadForm.file"
            theme="file-input"
            accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.xls,.xlsx,.csv,.jpg,.jpeg,.png,.gif,.bmp"
            :multiple="false"
            :auto-upload="false"
            @change="onPrivateFileChange"
          />
        </t-form-item>
        <t-form-item label="标题" required>
          <t-input v-model="privateUploadForm.title" placeholder="文件标题" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 私密空间视图 -->
    <t-card v-if="viewMode === 'private' && privateAccessGranted" class="private-space-view">
      <div class="private-header">
        <h3>私密文件列表</h3>
        <t-space>
          <t-button theme="primary" @click="handlePrivateUpload" :disabled="isGuest">
            <template #icon><t-icon name="upload" /></template>
            上传文件
          </t-button>
          <t-button theme="default" @click="openChangePrivatePassword" :disabled="isGuest">
            <template #icon><t-icon name="lock-on" /></template>
            修改密码
          </t-button>
        </t-space>
      </div>

      <!-- 批量操作按钮 -->
      <t-space v-if="privateSelectedRowKeys.length > 0" style="margin: 16px 0;">
        <t-popconfirm
          content="确定删除选中的文件吗？"
          @confirm="handlePrivateBatchDelete"
        >
          <t-button theme="danger" variant="outline">
            <template #icon><t-icon name="delete" /></template>
            批量删除 ({{ privateSelectedRowKeys.length }})
          </t-button>
        </t-popconfirm>
      </t-space>

      <!-- 私密文件列表 -->
      <t-table
        :data="privateDocuments"
        :columns="privateColumns"
        :loading="privateLoading"
        row-key="id"
        hover
        :selected-row-keys="privateSelectedRowKeys"
        @select-change="handlePrivateSelectChange"
      >
        <template #operation="{ row }">
          <t-space>
            <t-button theme="primary" variant="outline" size="small" @click="handlePrivateView(row)">
              <t-icon name="browse" /> 预览
            </t-button>
            <t-button theme="default" size="small" @click="handlePrivateDownload(row)">
              <t-icon name="download" /> 下载
            </t-button>
            <t-popconfirm
              content="确定删除吗？"
              @confirm="handlePrivateDelete(row.id)"
            >
              <t-button theme="danger" variant="outline" size="small">
                <t-icon name="delete" /> 删除
              </t-button>
            </t-popconfirm>
          </t-space>
        </template>
      </t-table>

      <!-- 私密空间分页 -->
      <div class="pagination-wrapper" v-if="viewMode === 'private' && privateTotal > 0">
        <t-pagination
          v-model="privatePagination.current"
          v-model:page-size="privatePagination.pageSize"
          :total="privateTotal"
          show-page-number
          show-page-size
          :page-size-options="[30, 50, 100]"
          @change="handlePrivatePageChange"
          @page-size-change="handlePrivatePageSizeChange"
        />
      </div>
    </t-card>

  </div>
</template>

<script setup>
import { ref, onMounted, computed, nextTick } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'
import api from '@/api'
import { marked } from 'marked'
import hljs from 'highlight.js'
import mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import { usePermission } from '@/composables/usePermission'

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
const uploadDialogVisible = ref(false)
const versionsDialogVisible = ref(false)
const createCategoryDialogVisible = ref(false)
const deleteCategoryDialogVisible = ref(false)
const deleteCategoryData = ref(null)
const deleteCategoryFileOption = ref('keep') // 'keep' 或 'delete'
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

// 拖拽相关状态
const draggedCategoryId = ref(null)
const draggedCategoryIndex = ref(null)
const draggedCategoryData = ref(null)
const isDraggingFile = ref(false) // 上传对话框拖拽状态

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
  newVersion: ''
})

const editDialogVisible = ref(false)
const editLoading = ref(false)

const uploadRules = {
  title: [{ required: true, message: '请输入标题', type: 'error' }],
  file: [{ required: true, message: '请选择文件', type: 'error' }]
}

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
const batchEditDialogVisible = ref(false)
const isSingleEdit = ref(false)
const singleEditId = ref(null)
const batchEditForm = ref({
  categoryPath: '',
  category: '',
  subcategory: '',
  tags: ''
})

// 私密空间相关状态
const privatePasswordDialogVisible = ref(false)
const privatePasswordInput = ref('')
const privatePasswordError = ref('')
const privateAccessGranted = ref(false)
const privateChangePasswordDialogVisible = ref(false)
const privateOldPassword = ref('')
const privateNewPassword = ref('')
const privateConfirmPassword = ref('')
const privateDocuments = ref([])
const privateTotal = ref(0)
const privatePagination = ref({ current: 1, pageSize: 30 })
const privateLoading = ref(false)
const privateSelectedRowKeys = ref([])
const privateUploadDialogVisible = ref(false)
const privateUploadForm = ref({
  file: [],
  title: ''
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
    MessagePlugin.warning('请选择要编辑的文档')
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
    MessagePlugin.success(isSingleEdit.value ? '更改成功' : '批量更新成功')
    batchEditDialogVisible.value = false
    selectedRowKeys.value = []
    // 清除文件数量缓存，以便悬停时重新加载
    categoryFileCount.value = {}
    loadDocuments()
  } catch (error) {
    console.error('更新失败:', error)
    MessagePlugin.error('更新失败')
  }
}

async function handleBatchDelete() {
  if (selectedRowKeys.value.length === 0) {
    MessagePlugin.warning('请选择要删除的文档')
    return
  }

  try {
    await Promise.all(selectedRowKeys.value.map(id => api.documents.delete(id)))
    MessagePlugin.success('批量删除成功')
    selectedRowKeys.value = []
    loadDocuments()
  } catch (error) {
    console.error('批量删除失败:', error)
    MessagePlugin.error('批量删除失败')
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
  { colKey: 'row-select', type: 'multiple', width: 50 },
  { colKey: 'title', title: '标题', width: 200, sorter: true },
  { colKey: 'tags', title: '标签', width: 150 },
  { colKey: 'version', title: '版本', width: 80, cell: (h, { row }) => h('span', row.version ? (row.version.toString().includes('.') ? row.version : `${row.version}.0`) : '1.0') },
  { colKey: 'type', title: '类型', width: 80, cell: (h, { row }) => h('span', getFileExtension(row.filePath || '')), sorter: true },
  { colKey: 'updatedAt', title: '更新时间', width: 180, sorter: true },
  { colKey: 'operation', title: '操作', width: 300 }
])

// 私密空间表格列（无版本控制）
const privateColumns = [
  { colKey: 'row-select', type: 'multiple', width: 50 },
  { colKey: 'title', title: '标题', width: 250 },
  { colKey: 'type', title: '类型', width: 100, cell: (h, { row }) => h('span', getFileExtension(row.filePath || '')) },
  { colKey: 'size', title: '大小', width: 100, cell: (h, { row }) => h('span', formatFileSize(row.size || 0)) },
  { colKey: 'updatedAt', title: '更新时间', width: 180 },
  { colKey: 'operation', title: '操作', width: 250 }
]

const versionColumns = [
  { colKey: 'version', title: '版本号', width: 100, cell: (h, { row }) => h('span', row.version ? (row.version.toString().includes('.') ? row.version : `${row.version}.0`) : '1.0') },
  { colKey: 'note', title: '说明' },
  { colKey: 'createdAt', title: '创建时间', width: 180 },
  { colKey: 'operation', title: '操作', width: 150 }
]

const lineCount = computed(() => {
  if (!editForm.value || !editForm.value.content) return 0
  return editForm.value.content.split('\n').length
})

const renderedMarkdown = computed(() => {
  if (!previewContent.value || previewType.value !== 'markdown') return ''
  return marked.parse(previewContent.value)
})

const highlightedCode = computed(() => {
  if (!previewContent.value || previewType.value !== 'code') return ''
  return hljs.highlight(previewContent.value, { language: previewLanguage.value }).value
})

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

    const response = await api.documents.list(params)
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

    // 排序已在后端完成，无需前端再排序
  } catch (error) {
    console.error('加载文档失败:', error)
    MessagePlugin.error('加载文档失败')
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

  // 处理私密空间 - 每次进入都要重新验证密码
  if (viewMode.value === 'private') {
    // 游客无权访问私密空间
    if (isGuest.value) {
      MessagePlugin.warning('游客无权访问私密空间')
      viewMode.value = 'category'  // 重置为分类浏览模式
      loadDocuments()  // 重新加载文档列表
      return
    }
    
    // 重置授权状态
    privateAccessGranted.value = false
    // 显示密码验证对话框
    privatePasswordDialogVisible.value = true
    privatePasswordInput.value = ''
    privatePasswordError.value = ''
  } else {
    loadDocuments()
  }
}

// 私密空间密码验证
async function handlePrivatePasswordConfirm() {
  try {
    const response = await api.documents.verifyPrivatePassword({ password: privatePasswordInput.value })
    if (response.data?.success) {
      privateAccessGranted.value = true
      privatePasswordDialogVisible.value = false
      privatePasswordInput.value = ''
      privatePasswordError.value = ''
      loadPrivateDocuments()
    } else {
      privatePasswordError.value = '密码错误'
      privatePasswordInput.value = ''
    }
  } catch (error) {
    console.error('密码验证失败:', error)
    privatePasswordError.value = error.response?.data?.message || '密码验证失败'
    privatePasswordInput.value = ''
  }
}

// 私密空间密码验证取消
function handlePrivatePasswordCancel() {
  // 关闭对话框并回到分类浏览视图
  privatePasswordDialogVisible.value = false
  privatePasswordInput.value = ''
  privatePasswordError.value = ''
  viewMode.value = 'category'
  loadDocuments()
}

// 打开修改密码对话框
function openChangePrivatePassword() {
  privateOldPassword.value = ''
  privateNewPassword.value = ''
  privateConfirmPassword.value = ''
  privateChangePasswordDialogVisible.value = true
}

// 修改私密空间密码
async function handleChangePrivatePasswordConfirm() {
  if (!privateOldPassword.value || !privateNewPassword.value || !privateConfirmPassword.value) {
    MessagePlugin.warning('请填写所有字段')
    return
  }
  if (privateNewPassword.value !== privateConfirmPassword.value) {
    MessagePlugin.error('两次输入的新密码不一致')
    return
  }

  try {
    await api.documents.changePrivatePassword({
      oldPassword: privateOldPassword.value,
      newPassword: privateNewPassword.value
    })
    MessagePlugin.success('密码修改成功')
    privateChangePasswordDialogVisible.value = false
  } catch (error) {
    console.error('修改密码失败:', error)
    MessagePlugin.error(error.response?.data?.message || '修改密码失败')
  }
}

// 统一搜索处理
function handleSearch() {
  if (viewMode.value === 'private') {
    privatePagination.value.current = 1
    loadPrivateDocuments()
  } else {
    pagination.value.current = 1
    loadDocuments()
  }
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

function handlePrivatePageChange() {
  loadPrivateDocuments()
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

function handlePrivatePageSizeChange() {
  privatePagination.value.current = 1
  loadPrivateDocuments()
  const scrollContainer = document.querySelector('.scrollable-content')
  if (scrollContainer) {
    scrollContainer.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

// 加载私密文件列表
async function loadPrivateDocuments() {
  privateLoading.value = true
  try {
    const params = {
      page: privatePagination.value.current,
      pageSize: privatePagination.value.pageSize
    }
    if (searchKeyword.value) {
      params.keyword = searchKeyword.value
    }
    const response = await api.documents.listPrivate(params)
    privateDocuments.value = response.data?.data || []
    privateTotal.value = response.data?.total || 0
  } catch (error) {
    console.error('加载私密文件失败:', error)
    MessagePlugin.error('加载私密文件失败')
    privateDocuments.value = []
    privateTotal.value = 0
  } finally {
    privateLoading.value = false
  }
}

// 私密文件上传
function handlePrivateUpload() {
  privateUploadForm.value = { file: [], title: '' }
  privateUploadDialogVisible.value = true
}

function onPrivateFileChange(files) {
  if (files.length > 0) {
    const fileName = files[0].name
    privateUploadForm.value.title = fileName.replace(/\.[^/.]+$/, '')
  }
}

async function handlePrivateUploadConfirm() {
  try {
    if (!privateUploadForm.value.file || privateUploadForm.value.file.length === 0) {
      MessagePlugin.error('请选择文件')
      return
    }

    const file = privateUploadForm.value.file[0]
    const formData = new FormData()
    const fileToUpload = file.raw || file.originFileObj || file
    formData.append('file', fileToUpload)
    formData.append('title', privateUploadForm.value.title)

    await api.documents.uploadPrivate(formData)
    MessagePlugin.success('上传成功')
    privateUploadDialogVisible.value = false
    loadPrivateDocuments()
  } catch (error) {
    console.error('上传失败:', error)
    MessagePlugin.error(error.response?.data?.message || '上传失败')
  }
}

// 私密文件操作
function handlePrivateView(row) {
  // 复用现有的预览功能
  loadPreviewContent({ ...row, isPrivate: true })
}

function handlePrivateDownload(row) {
  const token = localStorage.getItem('token')
  if (token) {
    window.open(`${window.location.origin}/api/documents/download/private/${row.id}?token=${token}`, '_blank')
  } else {
    MessagePlugin.error('无法下载，未登录')
  }
}

async function handlePrivateDelete(id) {
  try {
    await api.documents.deletePrivate(id)
    MessagePlugin.success('删除成功')
    loadPrivateDocuments()
  } catch (error) {
    console.error('删除失败:', error)
    MessagePlugin.error('删除失败')
  }
}

function handlePrivateSelectChange(selectedKeys) {
  privateSelectedRowKeys.value = selectedKeys
}

async function handlePrivateBatchDelete() {
  if (privateSelectedRowKeys.value.length === 0) {
    MessagePlugin.warning('请选择要删除的文件')
    return
  }

  try {
    await Promise.all(privateSelectedRowKeys.value.map(id => api.documents.deletePrivate(id)))
    MessagePlugin.success('批量删除成功')
    privateSelectedRowKeys.value = []
    loadPrivateDocuments()
  } catch (error) {
    console.error('批量删除失败:', error)
    MessagePlugin.error('批量删除失败')
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
      MessagePlugin.error('请输入分类名称')
      return
    }

    const parentId = currentCategoryId.value
    await api.documents.createCategory({
      name: categoryForm.value.name.trim(),
      parentId: parentId || null
    })

    MessagePlugin.success('创建成功')
    createCategoryDialogVisible.value = false
    loadCategories()
  } catch (error) {
    console.error('创建分类失败:', error)
    MessagePlugin.error(error.response?.data?.message || '创建失败')
  }
}

function handleDeleteCategory(category) {
  deleteCategoryData.value = category
  deleteCategoryFileOption.value = 'keep' // 默认保留文件
  deleteCategoryDialogVisible.value = true
}

async function handleDeleteCategoryConfirm() {
  try {
    if (!deleteCategoryData.value) return

    const deleteFiles = deleteCategoryFileOption.value === 'delete'
    await api.documents.deleteCategory(deleteCategoryData.value.id, deleteFiles)

    MessagePlugin.success(deleteFiles ? '分类及相关文件已删除' : '分类已删除，文件已提升到父分类')
    deleteCategoryDialogVisible.value = false
    deleteCategoryData.value = null

    // 刷新分类和文档列表
    loadCategories()
    loadDocuments()
    // 清除文件数量缓存
    categoryFileCount.value = {}
  } catch (error) {
    console.error('删除分类失败:', error)
    MessagePlugin.error(error.response?.data?.message || '删除失败')
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
      MessagePlugin.error('请输入分类名称')
      return
    }

    await api.documents.updateCategory(renameCategoryData.value.id, {
      name: renameCategoryName.value.trim()
    })

    MessagePlugin.success('重命名成功')
    renameCategoryDialogVisible.value = false
    renameCategoryData.value = null

    // 刷新分类和文档列表
    loadCategories()
    loadDocuments()
    // 清除文件数量缓存
    categoryFileCount.value = {}
  } catch (error) {
    console.error('重命名分类失败:', error)
    MessagePlugin.error(error.response?.data?.message || '重命名失败')
  }
}

function handleUpload() {
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

async function handleUploadConfirm() {
  try {
    if (!uploadForm.value.file || uploadForm.value.file.length === 0) {
      MessagePlugin.error('请选择文件')
      return
    }

    console.log('上传文件信息:', uploadForm.value.file)
    const file = uploadForm.value.file[0]
    console.log('文件对象:', file)
    console.log('文件原始数据:', file.raw)
    console.log('文件URL:', file.url)
    console.log('文件名称:', file.name)

    const formData = new FormData()
    const fileToUpload = file.raw || file.originFileObj || file
    formData.append('file', fileToUpload)
    formData.append('title', uploadForm.value.title)
    formData.append('category', uploadForm.value.category)
    formData.append('subcategory', uploadForm.value.subcategory)
    formData.append('tags', uploadForm.value.tags)
    formData.append('versionNote', uploadForm.value.versionNote)

    console.log('准备上传的FormData:', formData)
    const response = await api.documents.upload(formData)
    console.log('上传响应:', response)

    // 如果标题被修改了（重名自动添加后缀），提示用户
    if (response.data?.title && response.data.title !== uploadForm.value.title) {
      MessagePlugin.warning(`文件名已重命名为：${response.data.title}`)
    } else {
      MessagePlugin.success('上传成功')
    }

    uploadDialogVisible.value = false
    // 清除文件数量缓存，以便悬停时重新加载
    categoryFileCount.value = {}
    loadCategories()
    loadAllTags()
    loadDocuments()
  } catch (error) {
    console.error('上传错误:', error)
    console.error('错误详情:', error.response?.data)
    MessagePlugin.error(error.response?.data?.message || '上传失败')
  }
}

function handleView(row) {
  const token = localStorage.getItem('token') || sessionStorage.getItem('token')
  console.log('预览文件，row数据:', row)
  console.log('文件路径:', row.filePath)

  if (!token) {
    MessagePlugin.error('无法预览，未登录')
    return
  }

  if (!row || !row.id) {
    MessagePlugin.error('无法预览，文档ID不存在')
    return
  }

  loadPreviewContent(row)
}

function handleDownload(row) {
  const token = localStorage.getItem('token')
  if (token) {
    window.open(`${window.location.origin}/api/documents/download/${row.id}?token=${token}`, '_blank')
  } else {
    MessagePlugin.error('无法下载，未登录')
  }
}

function handleDownloadVersion(row) {
  window.open(`${window.location.origin}/api/documents/download/version/${row.id}`, '_blank')
}

async function handleEdit(row) {
  // 检查文件是否可编辑
  if (!canEditFile(row.filePath)) {
    const ext = row.filePath?.split('.').pop()?.toLowerCase()
    MessagePlugin.warning(`此文件格式不支持编辑: ${ext}\n支持的编辑格式: txt, md, json, xml, html, css, js, ts, py, java, c, cpp, h, go, rs, sql, sh, bat, yml, yaml, csv`)
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
      currentVersion: row.version ? row.version.toString() : '1.0',
      newVersion: ''
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
      MessagePlugin.error(error.response?.data?.message || '不支持编辑此文件格式')
    } else if (error.response?.status === 404) {
      MessagePlugin.error('文件不存在，无法编辑')
    } else {
      MessagePlugin.error('加载文档内容失败')
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
      MessagePlugin.error('内容不能为空')
      return
    }

    // 验证版本号
    if (editForm.value.newVersion) {
      const versionRegex = /^\d+(\.\d+)*$/
      if (!versionRegex.test(editForm.value.newVersion)) {
        MessagePlugin.error('版本号格式不正确，请使用数字和点号，如: 1.1.2')
        return
      }

      // 比较版本号
      if (!isVersionGreater(editForm.value.newVersion, editForm.value.currentVersion)) {
        MessagePlugin.error(`新版本号必须大于当前版本 ${editForm.value.currentVersion}`)
        return
      }
    }

    await api.documents.updateContent(editForm.value.id, {
      content: editForm.value.content,
      versionNote: editForm.value.versionNote,
      newVersion: editForm.value.newVersion || null
    })

    MessagePlugin.success('保存成功')
    editDialogVisible.value = false
    loadDocuments()
  } catch (error) {
    console.error('保存失败:', error)
    MessagePlugin.error(error.response?.data?.message || '保存失败')
  }
}

// 比较版本号函数：判断 newVersion 是否大于 currentVersion
function isVersionGreater(newVersion, currentVersion) {
  const newParts = newVersion.split('.').map(Number)
  const currentParts = currentVersion.split('.').map(Number)

  const maxLen = Math.max(newParts.length, currentParts.length)

  for (let i = 0; i < maxLen; i++) {
    const newPart = newParts[i] || 0
    const currentPart = currentParts[i] || 0

    if (newPart > currentPart) return true
    if (newPart < currentPart) return false
  }

  return false // 版本号相等
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
    MessagePlugin.success('删除成功')
    loadCategories()
    loadDocuments()
  } catch (error) {
    MessagePlugin.error('删除失败')
  }
}

async function handleViewVersions(row) {
  try {
    const response = await api.documents.versions(row.id)
    console.log('版本响应:', response)
    const data = response.data?.data || response.data || []
    versions.value = Array.isArray(data) ? data : []
    versionsDialogVisible.value = true
  } catch (error) {
    console.error('加载版本失败:', error)
    MessagePlugin.error('加载版本失败')
  }
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

    // 根据是否为私密文件调用不同的 API
    const response = row.isPrivate
      ? await api.documents.getPrivateContent(row.id)
      : await api.documents.getContent(row.id)
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
      MessagePlugin.error('加载预览失败')
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
  try {
    // 将base64转换为ArrayBuffer
    const binaryString = atob(base64Content)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    const arrayBuffer = bytes.buffer

    if (ext === 'docx') {
      // Word文档预览
      const result = await mammoth.convertToHtml({ arrayBuffer })
      previewContent.value = result.value
      previewType.value = 'word-html'
      previewLoading.value = false
    } else if (ext === 'xlsx' || ext === 'xls') {
      // Excel文档预览
      const workbook = XLSX.read(arrayBuffer, { type: 'array' })
      const firstSheetName = workbook.SheetNames[0]
      const worksheet = workbook.Sheets[firstSheetName]
      const html = XLSX.utils.sheet_to_html(worksheet, { editable: false })
      previewContent.value = html
      previewType.value = 'excel-html'
      previewLoading.value = false
    } else {
      // 其他Office格式暂不支持预览
      previewType.value = 'office'
      previewLoading.value = false
    }
  } catch (error) {
    console.error('加载Office文档内容失败:', error)
    previewType.value = 'office'
    previewLoading.value = false
    MessagePlugin.warning('文档预览失败，请下载后查看')
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

    MessagePlugin.error('PDF 加载失败: ' + (error.message || '未知错误'))
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
    MessagePlugin.error('渲染 PDF 页面失败')
  }
}

async function prevPage() {
  if (currentPage.value > 1) {
    currentPage.value--
    await renderPage(currentPage.value)
  }
}

async function nextPage() {
  if (currentPage.value < totalPages.value) {
    currentPage.value++
    jumpPageNum.value = currentPage.value
    await renderPage(currentPage.value)
  }
}

async function handleJumpPageConfirm() {
  const pageNum = parseInt(jumpPageNum.value)
  if (pageNum >= 1 && pageNum <= totalPages.value) {
    currentPage.value = pageNum
    await renderPage(currentPage.value)
  } else {
    MessagePlugin.warning(`请输入有效的页码（1-${totalPages.value}）`)
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

    MessagePlugin.success('排序已更新')
  } catch (error) {
    console.error('更新排序失败:', error)
    MessagePlugin.error('更新排序失败')
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
  } else if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'].includes(ext)) {
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
  const icons = {
    'word': 'file-word',
    'ppt': 'file-ppt',
    'excel': 'file-excel'
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

/* 搜索和排序行 */
.search-sort-row {
  display: flex;
  gap: 12px;
  align-items: center;
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

.empty-categories .t-icon {
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

.category-card .drag-handle {
  position: absolute;
  top: 8px;
  right: 8px;
  opacity: 0;
  transition: opacity 0.2s;
  cursor: grab;
  padding: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 4px;
}

.category-card:hover .drag-handle {
  opacity: 1;
}

.category-card .drag-handle:active {
  cursor: grabbing;
}

.category-card .delete-handle {
  position: absolute;
  top: 8px;
  left: 8px;
  opacity: 0;
  transition: opacity 0.2s;
  cursor: pointer;
  padding: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 4px;
}

.category-card:hover .delete-handle {
  opacity: 1;
}

.category-card .delete-handle:hover {
  background: rgba(227, 77, 89, 0.8);
}

.category-card .rename-handle {
  position: absolute;
  top: 8px;
  left: 32px;
  opacity: 0;
  transition: opacity 0.2s;
  cursor: pointer;
  padding: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 4px;
}

.category-card:hover .rename-handle {
  opacity: 1;
}

.category-card .rename-handle:hover {
  background: rgba(0, 82, 217, 0.6);
}

.category-card .t-icon {
  color: white;
  margin-bottom: 12px;
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

.drag-active :deep(.t-dialog__content) {
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
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 2px solid #667eea;
}

.t-table {
  margin-top: 16px;
}

.t-table :deep(.t-table__th) {
  background: #f6f8fa;
  font-weight: 600;
  color: #333;
}

.t-table :deep(.t-table__tr:hover) {
  background: #f0f3ff;
}

.t-button {
  margin-right: 4px;
}

/* 只修复空状态和预览中不支持预览时的下载按钮 */
.empty-state .t-button,
.office-preview .t-button,
.unsupported-preview .t-button,
.word-html-preview .t-button,
.excel-html-preview .t-button {
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
  line-height: 1.8;
  color: #333;
  overflow-x: auto;
}

.markdown-preview h1,
.markdown-preview h2,
.markdown-preview h3,
.markdown-preview h4,
.markdown-preview h5,
.markdown-preview h6 {
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.4;
}

.markdown-preview h1 {
  font-size: 28px;
  border-bottom: 2px solid #eaecef;
  padding-bottom: 10px;
}

.markdown-preview h2 {
  font-size: 24px;
  border-bottom: 1px solid #eaecef;
  padding-bottom: 8px;
}

.markdown-preview h3 {
  font-size: 20px;
}

.markdown-preview h4 {
  font-size: 18px;
}

.markdown-preview h5 {
  font-size: 16px;
}

.markdown-preview h6 {
  font-size: 14px;
  color: #666;
}

.markdown-preview p {
  margin: 16px 0;
}

.markdown-preview ul,
.markdown-preview ol {
  margin: 16px 0;
  padding-left: 2em;
}

.markdown-preview li {
  margin: 8px 0;
}

.markdown-preview code {
  background: #f6f8fa;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 14px;
}

.markdown-preview pre {
  background: #f6f8fa;
  border-radius: 8px;
  padding: 16px;
  overflow-x: auto;
  margin: 16px 0;
}

.markdown-preview pre code {
  background: none;
  padding: 0;
  font-size: 14px;
}

.markdown-preview blockquote {
  border-left: 4px solid #dfe2e5;
  padding-left: 16px;
  margin: 16px 0;
  color: #666;
}

.markdown-preview table {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0;
}

.markdown-preview th,
.markdown-preview td {
  border: 1px solid #dfe2e5;
  padding: 8px 12px;
  text-align: left;
}

.markdown-preview th {
  background: #f6f8fa;
  font-weight: 600;
}

.markdown-preview a {
  color: #0066cc;
  text-decoration: none;
}

.markdown-preview a:hover {
  text-decoration: underline;
}

.markdown-preview img {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
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

.office-preview .t-icon {
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

/* Excel HTML 预览 */
.excel-html-preview {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 70vh;
  overflow-y: auto;
}

.excel-content {
  padding: 20px;
  background: #fff;
  border-radius: 0 0 8px 8px;
  min-height: 400px;
  overflow-x: auto;
}

.excel-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.excel-content :deep(table td),
.excel-content :deep(table th) {
  border: 1px solid #dfe2e5;
  padding: 8px 12px;
  text-align: left;
}

.excel-content :deep(table th) {
  background: #f6f8fa;
  font-weight: 600;
  color: #333;
}

.excel-content :deep(table tr:hover td) {
  background: #f0f3ff;
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
:deep(.t-dialog) {
  max-height: 90vh;
  overflow: visible;
}

:deep(.t-dialog__body) {
  max-height: 80vh;
  overflow-y: auto;
}

/* 私密空间样式 */
.private-space-view {
  margin-top: 16px;
}

.private-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.private-header h3 {
  font-size: 18px;
  color: #333;
  margin: 0;
  padding-bottom: 8px;
  border-bottom: 2px solid #e34d59;
}

/* 第10项：条目不换行 */
::deep(.t-table td) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

::deep(.t-table .title-cell),
::deep(.t-table .tags-cell) {
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
}

/* 第12项：操作列左对齐 */
::deep(.t-table .t-table__body td:last-child) {
  text-align: left;
}
</style>
