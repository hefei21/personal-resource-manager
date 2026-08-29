export const TASK_TYPE_OPTIONS = Object.freeze([
  { value: 'rag.index.refresh', label: 'RAG 文本索引' },
  { value: 'rag.content.extract', label: 'RAG 内容提取' },
  { value: 'rag.embedding.generate', label: 'RAG 向量化' },
  { value: 'rag.query.embed', label: '查询向量化' },
  { value: 'rag.rerank', label: 'RAG 结果重排' },
  { value: 'rag.answer.generate', label: 'RAG 回答生成' },
  { value: 'search.index.refresh', label: '统一搜索索引刷新' },
  { value: 'code.repository.clone', label: '代码仓库克隆' },
  { value: 'code.repository.sync', label: '代码仓库同步' },
  { value: 'code.repository.reclone', label: '代码仓库安全重克隆' },
  { value: 'code.repository.git_nas.discover', label: 'NAS Git 仓库发现' },
  { value: 'code.repository.git_nas.import', label: 'NAS Git 仓库导入' },
  { value: 'nas.resource.scan', label: 'NAS 资源扫描' },
  { value: 'nas.resource.repair', label: 'NAS 资源修复' },
  { value: 'resource.domain.adapt', label: '资源域适配' },
  { value: 'content.inspect', label: '资源内容检查' },
  { value: 'music.lyrics.batch', label: '批量下载歌词' },
  { value: 'games.steam.sync', label: 'Steam 游戏同步' },
  { value: 'anime.bangumi.refresh', label: '动漫信息刷新' },
  { value: 'ebook.cover.generate', label: '电子书封面生成' },
  { value: 'ebook.metadata.reparse', label: '电子书元数据重解析' },
  { value: 'music.metadata.reparse', label: '音乐元数据重解析' }
].map(Object.freeze))

export const TASK_TYPE_LABELS = Object.freeze(Object.fromEntries(
  TASK_TYPE_OPTIONS.map(({ value, label }) => [value, label])
))

export const TASK_STATUS_LABELS = Object.freeze({
  pending: '排队中',
  leased: '准备执行',
  running: '运行中',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消'
})

export const TASK_STATUS_THEMES = Object.freeze({
  pending: 'warning',
  leased: 'primary',
  running: 'primary',
  succeeded: 'success',
  partial: 'warning',
  failed: 'danger',
  cancelled: 'default'
})

export const TASK_ERROR_MESSAGES = Object.freeze({
  TASK_PROCESSOR_FAILED: '任务处理失败，请稍后重试',
  TASK_HEARTBEAT_FAILED: '任务运行状态异常，请稍后重试',
  TASK_LEASE_EXPIRED: '任务运行超时，请稍后重试',
  TASK_PROGRESS_REJECTED: '任务进度更新失败',
  TASK_INPUT_INVALID: '任务输入无效',
  TASK_ID_INVALID: '来源资源标识无效',
  TASK_TYPE_UNSUPPORTED: '任务类型暂不支持',
  RAG_INDEX_SOURCE_FAILED: '目标资源没有生成可用的 RAG 文本索引',
  RAG_INDEX_REFRESH_FAILED: 'RAG 索引刷新失败',
  WORKER_INPUT_MISMATCH: 'Worker 下载到的内容与任务版本不一致',
  WORKER_CONTENT_EXTRACT_INPUT_INVALID: '内容提取任务参数无效',
  WORKER_CONTENT_EXTRACT_INPUT_TOO_LARGE: '源文件超过内容提取大小限制',
  WORKER_CONTENT_EXTRACT_ARCHIVE_INVALID: 'EPUB 或文档压缩包结构无效',
  WORKER_CONTENT_EXTRACT_ARCHIVE_UNSAFE: '压缩包包含不安全路径，已拒绝处理',
  WORKER_CONTENT_EXTRACT_ARCHIVE_TOO_LARGE: '压缩包解压后的内容超过安全限制',
  WORKER_CONTENT_EXTRACT_ARTIFACT_TOO_LARGE: '提取后的文本超过索引产物限制',
  WORKER_CONTENT_EXTRACT_EMPTY: '文件中没有提取到可索引正文',
  WORKER_CONTENT_EXTRACT_PDF_INVALID: 'PDF 结构无效或无法解析',
  WORKER_ARTIFACT_UPLOAD_FAILED: '提取结果上传失败',
  WORKER_PROCESSING_FAILED: 'Worker 处理失败；旧任务未保留具体原因',
  WORKER_REQUEST_REJECTED: 'NAS 拒绝了 Worker 请求；请检查内容授权与版本',
  WORKER_MODEL_NOT_READY: '所需本地模型未就绪',
  WORKER_MODEL_UNAVAILABLE: '本地模型在执行过程中不可用',
  EBOOK_METADATA_PARSE_FAILED: '电子书元数据解析失败，可重试',
  EBOOK_METADATA_PARSE_TIMEOUT: '电子书元数据解析超时，可重试',
  MUSIC_METADATA_PARSE_FAILED: '音乐元数据解析失败，可重试',
  MUSIC_METADATA_PARSE_TIMEOUT: '音乐元数据解析超时，可重试',
  TASK_CANCELLED: '任务已取消',
  EBOOK_COVER_TASK_TIMEOUT: '封面生成超时，请稍后重试',
  EBOOK_COVER_TASK_MISSING: '封面任务不存在',
  EBOOK_COVER_TASK_FAILED: '封面生成失败，请稍后重试',
  PROXY_DNS_FAILED: '代理服务名称无法解析，请检查容器网络',
  PROXY_CONNECTION_FAILED: '代理服务暂时无法连接'
})

const SAFE_TASK_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_.-]{0,63}$/u
const NON_RETRYABLE_TASK_TYPES = new Set(['rag.query.embed', 'rag.rerank', 'rag.answer.generate'])

export function taskTypeLabel(taskType) {
  return TASK_TYPE_LABELS[taskType] || '系统后台任务'
}

export function effectiveTaskStatus(task) {
  return task?.status === 'succeeded' && task?.result?.status === 'partial' ? 'partial' : task?.status
}

export function taskStatusLabel(task) {
  return TASK_STATUS_LABELS[effectiveTaskStatus(task)] || '未知状态'
}

export function taskStatusTheme(task) {
  return TASK_STATUS_THEMES[effectiveTaskStatus(task)] || 'default'
}

export function taskSourcePresentation(task) {
  const source = task?.source
  if (source && typeof source.title === 'string' && source.title.trim()) {
    const id = Number.isSafeInteger(source.id) && source.id > 0 ? ` · #${source.id}` : ''
    return Object.freeze({
      title: source.title,
      meta: `${source.label || '来源'}${id}`,
      route: typeof source.route === 'string' ? source.route : null
    })
  }
  return Object.freeze({ title: '后台系统任务', meta: '没有单一资源来源', route: null })
}

export function taskStageLabel(task) {
  if (task?.taskType === 'rag.index.refresh') return 'NAS · 文本收集与分块'
  if (task?.taskType === 'rag.content.extract') return 'PC Worker · 文件正文提取'
  if (task?.taskType === 'rag.embedding.generate') return 'PC Worker · 向量生成'
  if (task?.taskType === 'rag.query.embed') return 'PC Worker · 查询向量'
  if (task?.taskType === 'rag.rerank') return 'PC Worker · 候选重排'
  if (task?.taskType === 'rag.answer.generate') return 'PC Worker · 有证据回答'
  const execution = { cpu: 'CPU', disk: '磁盘', network: '网络', gpu: 'GPU' }[task?.executionClass]
  return execution ? `${execution} 任务` : '后台任务'
}

export function taskErrorLabel(errorCode) {
  const safeCode = typeof errorCode === 'string' && SAFE_TASK_ERROR_CODE_PATTERN.test(errorCode) ? errorCode : null
  if (!safeCode) return '任务失败（代码：未知）'
  return TASK_ERROR_MESSAGES[safeCode] || `任务失败（代码：${safeCode}）`
}

export function taskCanRetry(task) {
  return task?.status === 'failed' && !NON_RETRYABLE_TASK_TYPES.has(task?.taskType)
}
