/**
 * 批量为后端路由添加权限中间件的脚本
 * 
 * 使用方法：
 * node add_permission_middleware.js
 */

const fs = require('fs')
const path = require('path')

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

// 需要排除的路由模式（这些路由不需要权限检查）
const excludePatterns = [
  '/private/verify-password'  // 验证密码接口允许访问，但前端会拦截
]

/**
 * 处理单个文件
 */
function processFile(filename) {
  const filePath = path.join(__dirname, 'src/routes', filename)
  
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  文件不存在: ${filename}`)
    return
  }
  
  let content = fs.readFileSync(filePath, 'utf-8')
  let modified = false
  
  console.log(`\n处理文件: ${filename}`)
  
  // 1. 添加 requireWritePermission 导入
  if (!content.includes('requireWritePermission')) {
    // 查找 authenticateToken 导入行
    const authImportPattern = /import\s+\{\s*([^}]+)\s*\}\s+from\s+['"]\.\.\/middlewares\/auth\.js['"]/
    const match = content.match(authImportPattern)
    
    if (match) {
      const imports = match[1].trim()
      if (!imports.includes('requireWritePermission')) {
        // 添加 requireWritePermission 到现有导入
        const newImports = imports.includes('authenticateToken')
          ? imports.replace('authenticateToken', 'authenticateToken, requireWritePermission')
          : imports + ', requireWritePermission'
        
        content = content.replace(
          authImportPattern,
          `import { ${newImports} } from '../middlewares/auth.js'`
        )
        console.log(`  ✓ 添加 requireWritePermission 导入`)
        modified = true
      }
    } else {
      // 如果没有导入 authenticateToken，添加新的导入
      const firstImportIndex = content.indexOf('import')
      const beforeImport = content.substring(0, firstImportIndex)
      const afterImport = content.substring(firstImportIndex)
      
      content = `${beforeImport}import { requireWritePermission } from '../middlewares/auth.js'\n${afterImport}`
      console.log(`  ✓ 添加 requireWritePermission 导入`)
      modified = true
    }
  }
  
  // 2. 为所有 POST/PUT/DELETE 路由添加 requireWritePermission
  const routePattern = /(router\.(post|put|delete)\(['"`]([^'"`]+)['"`],\s*authenticateToken)(,)/g
  
  content = content.replace(routePattern, (match, prefix, method, routePath, suffix) => {
    // 检查是否需要排除
    if (excludePatterns.some(pattern => routePath.includes(pattern))) {
      console.log(`  ⊘ ${method.toUpperCase()} ${routePath} - 跳过（排除列表）`)
      return match
    }
    
    // 检查是否已经有 requireWritePermission
    if (match.includes('requireWritePermission')) {
      return match
    }
    
    console.log(`  ✓ ${method.toUpperCase()} ${routePath} - 添加权限验证`)
    modified = true
    return `${prefix}, requireWritePermission${suffix}`
  })
  
  // 3. 保存文件
  if (modified) {
    fs.writeFileSync(filePath, content, 'utf-8')
    console.log(`  ✅ 文件已更新`)
  } else {
    console.log(`  ℹ️  无需更新`)
  }
}

// 主函数
console.log('🔒 开始添加游客权限中间件...\n')

routeFiles.forEach(processFile)

console.log('\n✅ 所有文件处理完成！')
console.log('\n⚠️  重要提示：')
console.log('1. 请手动检查生成的代码是否正确')
console.log('2. 运行测试确保功能正常')
console.log('3. 部署前务必验证游客无法执行写操作')
