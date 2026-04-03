/**
 * 自动应用游客权限中间件脚本
 * 
 * 此脚本会自动在所有写操作路由（POST/PUT/DELETE）上添加 requireWritePermission 中间件
 * 
 * 使用方法：
 * node apply_guest_middleware.js
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const routesDir = path.join(__dirname, 'src/routes')

// 需要处理的文件列表
const routeFiles = [
  'anime.js',
  'blog.js',
  'bookmarks.js',
  'books.js',
  'code.js',
  'documents.js',
  'games.js',
  'music.js',
  'todos.js'
]

// 只读路由（不需要添加中间件）
const readOnlyRoutes = [
  'auth.js',      // auth.js 已经手动添加了
  'bookSearch.js', // 搜索功能，只读
  'search.js'      // 搜索功能，只读
]

/**
 * 检查文件是否已经导入 requireWritePermission
 */
function hasRequireWritePermissionImport(content) {
  return content.includes('requireWritePermission')
}

/**
 * 添加 requireWritePermission 导入
 */
function addRequireWritePermissionImport(content) {
  // 查找 authenticateToken 的导入行
  const authImportPattern = /import\s+\{\s*([^}]+)\s*\}\s+from\s+['"]\.\.\/middlewares\/auth\.js['"]/
  const match = content.match(authImportPattern)
  
  if (match) {
    const imports = match[1].trim()
    if (!imports.includes('requireWritePermission')) {
      // 添加 requireWritePermission 到现有导入
      const newImports = imports.includes('authenticateToken')
        ? imports.replace('authenticateToken', 'authenticateToken, requireWritePermission')
        : imports + ', requireWritePermission'
      
      return content.replace(
        authImportPattern,
        `import { ${newImports} } from '../middlewares/auth.js'`
      )
    }
    return content
  } else {
    // 如果没有导入 authenticateToken，添加新的导入
    const firstImportIndex = content.indexOf('import')
    const beforeImport = content.substring(0, firstImportIndex)
    const afterImport = content.substring(firstImportIndex)
    
    return `${beforeImport}import { requireWritePermission } from '../middlewares/auth.js'\n${afterImport}`
  }
}

/**
 * 在路由上添加中间件
 */
function addMiddlewareToRoute(content, method, path, existingMiddleware) {
  // 匹配路由定义
  // 例如：router.post('/path', authenticateToken, handler)
  // 或者：router.post('/path', handler)
  
  const routePattern = new RegExp(
    `router\\.${method}\\(['"\`](${path.replace(/\//g, '\\/')})['"\`],\\s*([^,]+(?:,\\s*[^,]+)*)`,
    'g'
  )
  
  return content.replace(routePattern, (match, routePath, middlewares) => {
    const middlewareList = middlewares.split(',').map(m => m.trim())
    
    // 如果已经有 requireWritePermission，跳过
    if (middlewareList.some(m => m.includes('requireWritePermission'))) {
      return match
    }
    
    // 如果有 authenticateToken，在其后添加 requireWritePermission
    if (middlewareList.some(m => m.includes('authenticateToken'))) {
      const newMiddlewares = middlewareList.map(m => {
        if (m.includes('authenticateToken')) {
          return `${m}, requireWritePermission`
        }
        return m
      }).join(', ')
      
      return `router.${method}('${routePath}', ${newMiddlewares}`
    }
    
    // 如果没有 authenticateToken，先添加 authenticateToken
    const newMiddlewares = ['authenticateToken, requireWritePermission', ...middlewareList].join(', ')
    return `router.${method}('${routePath}', ${newMiddlewares}`
  })
}

/**
 * 处理单个文件
 */
function processFile(filename) {
  const filePath = path.join(routesDir, filename)
  
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  文件不存在: ${filename}`)
    return
  }
  
  let content = fs.readFileSync(filePath, 'utf-8')
  const originalContent = content
  
  console.log(`\n处理文件: ${filename}`)
  
  // 1. 添加 requireWritePermission 导入
  if (!hasRequireWritePermissionImport(content)) {
    content = addRequireWritePermissionImport(content)
    console.log(`  ✓ 添加 requireWritePermission 导入`)
  }
  
  // 2. 查找所有写操作路由
  const writeOperations = [
    // POST 操作
    { method: 'post', paths: [] },
    // PUT 操作
    { method: 'put', paths: [] },
    // DELETE 操作
    { method: 'delete', paths: [] }
  ]
  
  // 提取路由路径
  writeOperations.forEach(op => {
    const routeRegex = new RegExp(`router\\.${op\\.method}\\(['"\`]([^'"\`]+)`, 'g')
    let match
    while ((match = routeRegex.exec(content)) !== null) {
      op.paths.push(match[1])
    }
  })
  
  // 3. 为每个写操作添加中间件
  let addedCount = 0
  writeOperations.forEach(op => {
    op.paths.forEach(path => {
      const beforeAdd = content
      content = addMiddlewareToRoute(content, op.method, path)
      if (content !== beforeAdd) {
        addedCount++
        console.log(`  ✓ ${op.method.toUpperCase()} ${path} - 添加权限验证`)
      }
    })
  })
  
  if (addedCount === 0) {
    console.log(`  ℹ️  所有写操作已有权限验证`)
  }
  
  // 4. 保存文件
  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf-8')
    console.log(`  ✅ 文件已更新`)
  } else {
    console.log(`  ℹ️  无需更新`)
  }
}

// 主函数
console.log('🔒 开始应用游客权限中间件...\n')

routeFiles.forEach(processFile)

console.log('\n✅ 所有文件处理完成！')
console.log('\n⚠️  重要提示：')
console.log('1. 请手动检查生成的代码是否正确')
console.log('2. 运行测试确保功能正常')
console.log('3. 部署前务必验证游客无法执行写操作')
