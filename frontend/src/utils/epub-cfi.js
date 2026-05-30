/**
 * EPUB CFI (Canonical Fragment Identifier) 工具类
 * 用于精准定位 EPUB 文档中的位置（包括图片等非文本元素）
 * 
 * CFI 格式规范：
 * - epubcfi(/6/4/2)        → 定位到元素
 * - epubcfi(/6/4/2/1:100)  → 定位到文本节点及字符偏移
 * 
 * 关键原则：元素本身就是有效锚点，不强制依赖文本节点
 */

/**
 * 获取元素在父节点中的索引（仅元素节点，符合EPUB CFI规范）
 * CFI规范：路径只包含元素节点，索引从1开始
 * @param {Element} element - 目标元素
 * @returns {number} - 元素索引（从1开始）
 */
function getElementIndex(element) {
  if (!element || !element.parentNode) return 1
  
  const parent = element.parentNode
  let index = 1
  
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = parent.childNodes[i]
    // 严格遵循CFI规范：只计算元素节点
    if (child.nodeType === Node.ELEMENT_NODE) {
      if (child === element) return index
      index++
    }
  }
  
  return index
}

/**
 * 获取元素从body开始的绝对路径
 * @param {Element} element - 目标元素
 * @returns {Array<number>} - 路径数组，如 [2, 4, 6]
 */
function getElementPath(element) {
  const path = []
  let current = element
  
  while (current && current.nodeName !== 'BODY') {
    const index = getElementIndex(current)
    path.unshift(index)
    current = current.parentNode
  }
  
  // 添加body的索引
  if (current && current.nodeName === 'BODY') {
    const bodyIndex = getElementIndex(current)
    path.unshift(bodyIndex)
  }
  
  return path
}

/**
 * 生成CFI字符串
 * 
 * 核心设计：
 * 1. 如果提供的是文本节点+偏移 → 生成完整CFI含字符偏移
 * 2. 如果提供的是元素节点 → 生成元素级别的CFI
 * 3. 图片等非文本元素本身就是有效锚点
 * 
 * @param {Node} node - 目标节点（元素或文本）
 * @param {number} offset - 字符偏移（仅在node是文本节点时使用）
 * @param {string} chapterId - 章节ID（可选）
 * @returns {string|null} - CFI字符串
 */
export function generateCFI(node, offset = 0, chapterId = null) {
  if (!node) return null
  
  try {
    let targetElement
    let textNodeIndex = 0
    let charOffset = 0
    
    // 情况1：node是文本节点 → 需要找到父元素，并计算文本节点索引
    if (node.nodeType === Node.TEXT_NODE) {
      targetElement = node.parentElement
      charOffset = offset || 0
      
      // 计算该文本节点在父元素中的索引（CFI规范：/textNodeIndex:offset）
      const parent = node.parentNode
      let index = 1
      for (let i = 0; i < parent.childNodes.length; i++) {
        const child = parent.childNodes[i]
        if (child.nodeType === Node.TEXT_NODE) {
          if (child === node) {
            textNodeIndex = index
            break
          }
          // 只计算非空文本节点
          if (child.textContent && child.textContent.length > 0) {
            index++
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          index++
        }
      }
      if (textNodeIndex === 0) textNodeIndex = 1
    }
    // 情况2：node是元素节点 → 直接定位到该元素
    else if (node.nodeType === Node.ELEMENT_NODE) {
      targetElement = node
      textNodeIndex = 0
      charOffset = 0
    }
    else {
      return null
    }
    
    // 查找章节元素（始终以 data-chapter-id 元素为根）
    let chapterElement = null
    let container = targetElement
    while (container && container !== document.body) {
      if (container.dataset && container.dataset.chapterId) {
        chapterElement = container
        break
      }
      container = container.parentElement
    }
    
    // 获取路径：强制始终以章节元素为根计算相对路径
    // 这样 PC 和移动端生成的路径一致，不受外层 DOM 结构影响
    let path
    if (chapterElement && chapterElement !== targetElement && chapterElement.contains(targetElement)) {
      // 使用章节相对路径
      path = getRelativeElementPath(targetElement, chapterElement)
    } else if (chapterElement && targetElement === chapterElement) {
      // 目标元素就是章节元素本身
      path = [1]
    } else {
      // 兜底：尝试继续向上查找章节元素
      console.warn('未找到章节元素，尝试使用备用方案')
      path = getElementPath(targetElement)
    }
    
    if (!path || path.length === 0) {
      path = [1]
    }
    
    // 构建CFI
    let cfi = 'epubcfi('
    const effectiveChapterId = chapterId || (chapterElement?.dataset?.chapterId)
    
    if (effectiveChapterId) {
      cfi += `[${effectiveChapterId}]!`
    }
    
    cfi += '/' + path.join('/')
    
    // 如果是文本节点，添加文本偏移
    if (node.nodeType === Node.TEXT_NODE && textNodeIndex > 0) {
      cfi += `/${textNodeIndex}:${charOffset}`
    }
    
    cfi += ')'
    
    return cfi
  } catch (error) {
    console.error('生成 CFI 失败:', error)
    return null
  }
}

/**
 * 从Range对象生成CFI（兼容原有API）
 * @param {Range} range - 选区范围
 * @param {string} chapterId - 章节ID
 * @returns {string|null}
 */
export function generateCFIFromRange(range, chapterId = null) {
  if (!range) return null
  return generateCFI(range.startContainer, range.startOffset, chapterId)
}

/**
 * 从视口中心生成CFI（最常用）
 * 这是精准定位的核心：caretRangeFromPoint 返回的位置就是用户正在看的位置
 * 
 * @param {HTMLElement} container - 内容容器
 * @returns {string|null}
 */
export function generateCFIFromViewport(container) {
  if (!container) return null
  
  try {
    const rect = container.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    
    // 使用 caretRangeFromPoint 获取视口中心的精确位置
    // 这是浏览器原生的精准定位API
    let range = null
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(centerX, centerY)
    } else if (document.caretPositionFromPoint) {
      // Firefox 兼容性
      const caretPos = document.caretPositionFromPoint(centerX, centerY)
      if (caretPos) {
        range = document.createRange()
        range.setStart(caretPos.offsetNode, caretPos.offset)
        range.collapse(true)
      }
    }
    
    if (!range) {
      // 备用方案：使用 elementFromPoint
      const element = document.elementFromPoint(centerX, centerY)
      if (!element) return null
      
      // 向上查找到容器内的有效元素
      let validElement = element
      while (validElement && !container.contains(validElement)) {
        validElement = validElement.parentElement
      }
      
      if (!validElement) return null
      
      // 直接使用元素作为锚点
      return generateCFI(validElement, 0, findChapterId(validElement))
    }
    
    // 确保在容器内
    let node = range.startContainer
    if (node.nodeType === Node.TEXT_NODE) {
      node = node.parentElement
    }
    
    let valid = false
    let checkNode = node
    while (checkNode) {
      if (checkNode === container) {
        valid = true
        break
      }
      checkNode = checkNode.parentElement
    }
    
    if (!valid) return null
    
    // 使用 range 的精确位置生成CFI
    const chapterId = findChapterId(range.startContainer)
    return generateCFI(range.startContainer, range.startOffset, chapterId)
    
  } catch (error) {
    console.error('从视口生成 CFI 失败:', error)
    return null
  }
}

/**
 * 查找节点所在的章节ID
 * @param {Node} node - 目标节点
 * @returns {string|null}
 */
function findChapterId(node) {
  let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node
  
  while (element && element !== document.body) {
    if (element.dataset && element.dataset.chapterId) {
      return element.dataset.chapterId
    }
    element = element.parentElement
  }
  
  return null
}

/**
 * 获取元素相对于父元素的路径
 * @param {Element} element - 目标元素
 * @param {Element} parent - 父元素（边界）
 * @returns {Array<number>}
 */
function getRelativeElementPath(element, parent) {
  const path = []
  let current = element
  
  while (current && current !== parent) {
    const index = getElementIndex(current)
    path.unshift(index)
    current = current.parentNode
  }
  
  return path
}

/**
 * 解析CFI并定位到DOM位置
 * 
 * 支持两种格式：
 * - epubcfi(/2/4/6)        → 返回元素
 * - epubcfi(/2/4/6/1:100)  → 返回文本节点及偏移
 * 
 * @param {Document} doc - 文档对象
 * @param {string} cfi - CFI字符串
 * @param {HTMLElement} container - 内容容器
 * @returns {Object|null} - { node, offset, element }
 */
export function parseCFI(doc, cfi, container) {
  if (!doc || !cfi || !cfi.startsWith('epubcfi(')) return null
  
  try {
    // 提取括号内内容
    const match = cfi.match(/epubcfi\((.+)\)$/)
    if (!match) return null
    
    let content = match[1]
    
    // 解析章节ID
    let chapterId = null
    const chapterMatch = content.match(/^\[([^\]]+)\]!(.+)$/)
    if (chapterMatch) {
      chapterId = chapterMatch[1]
      content = chapterMatch[2]
    }
    
    // 解析路径和文本偏移
    // 格式: /2/4/6 或 /2/4/6/1:100
    const parts = content.split('/').filter(p => p)
    if (parts.length === 0) return null
    
    // 最后一个部分可能是 "textIndex:offset" 格式
    let charOffset = 0
    let path = []
    
    const lastPart = parts[parts.length - 1]
    const offsetMatch = lastPart.match(/^(\d+):(\d+)$/)
    
    if (offsetMatch) {
      // 有文本偏移：/2/4/6/1:100 → path=[2,4,6], textIndex=1, offset=100
      const textIndex = parseInt(offsetMatch[1], 10)
      charOffset = parseInt(offsetMatch[2], 10)
      path = parts.slice(0, -1).map(p => parseInt(p, 10))
      path.push(textIndex) // 文本节点索引作为路径最后一级
    } else {
      // 纯元素路径：/2/4/6 → path=[2,4,6]
      path = parts.map(p => parseInt(p, 10))
      charOffset = -1 // 标记为纯元素定位
    }
    
    // 确定搜索根元素：优先使用章节内容容器作为根
    let rootElement = doc.body
    if (chapterId && container) {
      // 优先查找内容容器（必须是 .book-text 或 .chapter-content 且带 data-chapter-id）
      // 避免匹配到外层包装元素（如移动端的 .chapter-block）
      const chapterEl = container.querySelector(`.book-text[data-chapter-id="${chapterId}"], .chapter-content[data-chapter-id="${chapterId}"]`)
      if (chapterEl) {
        rootElement = chapterEl
      } else {
        // 容错：查找任意带 data-chapter-id 的元素
        const fallbackEl = container.querySelector(`[data-chapter-id="${chapterId}"]`)
        if (fallbackEl) {
          rootElement = fallbackEl
          console.warn(`未找到标准内容容器，使用备用元素:`, fallbackEl.className)
        }
      }
    } else if (container) {
      // 如果没有 chapterId，尝试从容器推断
      const chapterEl = container.querySelector('.book-text[data-chapter-id], .chapter-content[data-chapter-id]')
      if (chapterEl) {
        rootElement = chapterEl
      } else {
        rootElement = container
      }
    }
    
    // 根据路径查找节点
    const result = findNodeByPath(rootElement, path, charOffset >= 0)
    
    if (!result) return null
    
    return {
      node: result.node,
      offset: charOffset >= 0 ? Math.min(charOffset, result.node.textContent?.length || 0) : 0,
      element: result.element,
      chapterId: chapterId
    }
    
  } catch (error) {
    console.error('解析 CFI 失败:', error)
    return null
  }
}

/**
 * 根据路径查找节点
 * 
 * 核心逻辑：
 * - 路径前n-1级是元素索引
 * - 路径最后一级：如果needTextNode=true则是文本节点索引，否则也是元素索引
 * 
 * @param {Element} root - 根元素
 * @param {Array<number>} path - 路径数组
 * @param {boolean} needTextNode - 是否需要返回文本节点
 * @returns {Object|null} - { node, element }
 */
function findNodeByPath(root, path, needTextNode = false) {
  if (!path || path.length === 0) return null
  
  let current = root
  
  for (let i = 0; i < path.length; i++) {
    const targetIndex = path[i]
    const isLast = i === path.length - 1
    
    if (!current || !current.childNodes) {
      return null
    }
    
    let found = null
    let elementIndex = 1
    let textIndex = 1
    
    for (let j = 0; j < current.childNodes.length; j++) {
      const child = current.childNodes[j]
      
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (elementIndex === targetIndex) {
          if (isLast && !needTextNode) {
            // 纯元素定位，最后一级匹配元素
            return { node: child, element: child }
          }
          found = child
          break
        }
        elementIndex++
        textIndex++ // 元素节点也计入文本节点索引（CFI规范）
      } else if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent || ''
        if (isLast && needTextNode && textIndex === targetIndex) {
          // 需要文本节点，且匹配
          return { node: child, element: current }
        }
        if (text.length > 0) {
          textIndex++
        }
      }
    }
    
    if (!found) {
      // 容错：使用最后一个可用元素
      const lastElement = getLastElement(current)
      if (lastElement) {
        console.warn(`CFI路径第${i+1}级索引${targetIndex}未找到，使用最后一个元素`)
        found = lastElement
      } else {
        return null
      }
    }
    
    current = found
  }
  
  // 到达这里说明找到了目标元素
  if (needTextNode && current.nodeType === Node.ELEMENT_NODE) {
    // 需要文本节点但找到的是元素，查找第一个文本子节点
    const textNode = getFirstTextNode(current)
    if (textNode) {
      return { node: textNode, element: current }
    }
  }
  
  return { 
    node: current, 
    element: current.nodeType === Node.ELEMENT_NODE ? current : current.parentElement 
  }
}

/**
 * 获取元素最后一个子元素（容错用）
 */
function getLastElement(element) {
  if (!element || !element.childNodes) return null
  
  for (let i = element.childNodes.length - 1; i >= 0; i--) {
    const child = element.childNodes[i]
    if (child.nodeType === Node.ELEMENT_NODE) {
      return child
    }
  }
  return null
}

/**
 * 获取元素的第一个文本子节点
 */
function getFirstTextNode(element) {
  if (!element) return null
  
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  )
  
  return walker.nextNode()
}

/**
 * 滚动到CFI指定的位置
 * @param {HTMLElement} container - 内容容器
 * @param {string} cfi - CFI字符串
 * @param {Document} doc - 文档对象
 * @param {boolean} smooth - 是否平滑滚动
 * @returns {boolean}
 */
export function scrollToCFI(container, cfi, doc = null, smooth = false) {
  if (!container || !cfi) return false
  
  const document = doc || container.ownerDocument
  if (!document) return false
  
  try {
    const result = parseCFI(document, cfi, container)
    if (!result) {
      console.error('解析CFI失败:', cfi)
      return false
    }
    
    const { node, element, offset } = result
    
    if (!element) {
      console.error('CFI未定位到有效元素')
      return false
    }
    
    // 计算目标位置 - 使用视口中心对齐（与generateCFIFromViewport一致）
    const elementRect = element.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    
    let targetY = elementRect.top + elementRect.height / 2 // 默认元素中心
    
    // 如果有文本偏移，尝试更精确的定位到文本位置
    if (node && node.nodeType === Node.TEXT_NODE && offset > 0) {
      try {
        const range = document.createRange()
        range.setStart(node, Math.min(offset, node.textContent.length))
        range.collapse(true)
        
        const textRect = range.getBoundingClientRect()
        if (textRect && textRect.top > 0) {
          targetY = textRect.top // 文本光标位置
        }
      } catch (e) {
        // 忽略错误，使用元素中心
      }
    }
    
    // 让 targetY 对齐到视口中心（与保存时一致）
    // save时: caretRangeFromPoint(centerX, centerY) 获取视口中心位置
    // restore时: 让保存的位置滚动到视口中心
    const containerCenterY = containerRect.top + containerRect.height / 2
    const deltaY = targetY - containerCenterY
    let targetScrollTop = container.scrollTop + deltaY
    
    // 确保不超出范围
    const maxScrollTop = container.scrollHeight - container.clientHeight
    targetScrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop))
    
    container.scrollTo({
      top: targetScrollTop,
      behavior: smooth ? 'smooth' : 'auto'
    })
    
    return true
    
  } catch (error) {
    console.error('滚动到 CFI 失败:', error)
    return false
  }
}

/**
 * 获取当前视口位置的CFI（用于保存阅读进度）
 * @param {HTMLElement} container - 内容容器
 * @returns {string|null}
 */
export function getCurrentCFI(container) {
  if (!container) return null
  
  try {
    // 优先使用视口中心（最准确）
    const viewportCFI = generateCFIFromViewport(container)
    if (viewportCFI) return viewportCFI
    
    // 备用：使用容器顶部
    const rect = container.getBoundingClientRect()
    const element = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 50)
    
    if (element && container.contains(element)) {
      return generateCFI(element, 0, findChapterId(element))
    }
    
    return null
  } catch (error) {
    console.error('获取当前 CFI 失败:', error)
    return null
  }
}

/**
 * 计算阅读进度百分比（基于滚动位置）
 * @param {HTMLElement} container - 内容容器
 * @returns {number}
 */
export function calculateProgress(container) {
  if (!container) return 0
  
  const scrollTop = container.scrollTop
  const scrollHeight = container.scrollHeight - container.clientHeight
  
  if (scrollHeight <= 0) return 0
  
  return Math.min(100, Math.max(0, (scrollTop / scrollHeight) * 100))
}

/**
 * 计算基于字符偏移的进度
 */
export class CharacterOffsetProgress {
  constructor() {
    this.chapterOffsets = []
    this.totalChars = 0
    this.initialized = false
  }
  
  init(chapters) {
    if (!chapters || chapters.length === 0) {
      this.initialized = false
      return
    }
    
    this.chapterOffsets = []
    this.totalChars = 0
    
    chapters.forEach((chapter, index) => {
      const textLength = this.extractTextLength(chapter.content || '')
      this.chapterOffsets.push({
        chapterIndex: index,
        chapterId: chapter.id,
        startOffset: this.totalChars,
        textLength: textLength
      })
      this.totalChars += textLength
    })
    
    this.initialized = this.chapterOffsets.length > 0 && this.totalChars > 0
    console.log('📊 字符偏移进度计算器已初始化，总字符数:', this.totalChars)
  }
  
  /**
   * 计算当前阅读进度百分比
   * @param {number} currentChapterIndex - 当前章节索引
   * @param {HTMLElement} container - 内容容器
   * @param {HTMLElement} chapterContent - 当前章节内容元素
   * @returns {number} - 进度百分比 0-100
   */
  calculateProgress(currentChapterIndex, container, chapterContent) {
    if (!this.initialized || this.totalChars === 0) {
      return (currentChapterIndex / Math.max(this.chapterOffsets.length, 1)) * 100
    }
    
    const chapterInfo = this.chapterOffsets[currentChapterIndex]
    if (!chapterInfo) return 0
    
    // 计算章节内已读字符数
    let innerChars = 0
    if (chapterContent && container) {
      // 章节顶部相对于容器顶部的偏移
      const chapterOffsetTop = chapterContent.offsetTop
      
      // 当前滚动位置
      const scrollTop = container.scrollTop
      
      // 章节总高度
      const chapterHeight = chapterContent.scrollHeight
      
      if (chapterHeight > 0) {
        // 计算章节内已读比例
        const scrolledInChapter = Math.max(0, scrollTop - chapterOffsetTop)
        const innerRatio = Math.max(0, Math.min(1, scrolledInChapter / chapterHeight))
        innerChars = Math.floor(chapterInfo.textLength * innerRatio)
      }
    }
    
    // 当前总偏移 = 本章起始偏移 + 章节内偏移
    const currentOffset = chapterInfo.startOffset + innerChars
    
    // 进度百分比
    const progress = (currentOffset / this.totalChars) * 100
    
    return Math.min(100, Math.max(0, progress))
  }
  
  extractTextLength(html) {
    if (!html) return 0
    // 使用 DOMParser 而不是 innerHTML，避免触发图片加载
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')
    return (doc.body.textContent || '').replace(/\s+/g, '').length
  }
  
  clear() {
    this.chapterOffsets = []
    this.totalChars = 0
    this.initialized = false
  }
}

/**
 * 章节边界缓存类
 */
export class ChapterBoundaryCache {
  constructor() {
    this.boundaries = []
    this.totalLength = 0
    this.initialized = false
  }
  
  init(container, chapters) {
    if (!container || !chapters || chapters.length === 0) {
      this.initialized = false
      return
    }
    
    this.boundaries = []
    let accumulatedChars = 0
    
    chapters.forEach((chapter, index) => {
      const chapterEl = container.querySelector(`[data-chapter-id="${chapter.id}"]`)
      if (chapterEl) {
        const startCFI = generateCFI(chapterEl, 0, chapter.id)
        const textLength = this.estimateTextLength(chapterEl)
        
        this.boundaries.push({
          chapterIndex: index,
          chapterId: chapter.id,
          startCFI: startCFI,
          startOffset: accumulatedChars,
          textLength: textLength
        })
        
        accumulatedChars += textLength
      }
    })
    
    this.totalLength = accumulatedChars
    this.initialized = this.boundaries.length > 0
  }
  
  estimateTextLength(element) {
    let length = 0
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false)
    let node
    while ((node = walker.nextNode())) {
      length += node.textContent.length
    }
    return Math.max(length, 1)
  }
  
  clear() {
    this.boundaries = []
    this.totalLength = 0
    this.initialized = false
  }
}

/**
 * 计算章节进度
 */
export function calculateChapterProgress(currentChapterIndex, totalChapters, innerProgress = 0) {
  if (totalChapters === 0) return 0
  return Math.min(100, ((currentChapterIndex + innerProgress) / totalChapters) * 100)
}

/**
 * PC端单章节进度计算
 */
export function calculateSingleChapterProgress(currentChapterIndex, totalChapters, container) {
  if (totalChapters === 0) return 0
  
  const baseProgress = currentChapterIndex / totalChapters
  let innerProgress = 0
  
  if (container) {
    const scrollTop = container.scrollTop
    const scrollHeight = container.scrollHeight - container.clientHeight
    if (scrollHeight > 0) {
      innerProgress = (scrollTop / scrollHeight) / totalChapters
    }
  }
  
  return Math.min(100, (baseProgress + innerProgress) * 100)
}

export default {
  generateCFI,
  generateCFIFromRange,
  generateCFIFromViewport,
  parseCFI,
  scrollToCFI,
  getCurrentCFI,
  calculateProgress,
  CharacterOffsetProgress,
  ChapterBoundaryCache,
  calculateChapterProgress,
  calculateSingleChapterProgress
}
