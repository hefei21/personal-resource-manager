// 批量修复所有路由文件中的 better-sqlite3 API 调用
// 修复原则：
// - db.all(sql, params) → db.prepare(sql).all(params)
// - db.run(sql, params) → db.prepare(sql).run(params)
// - db.get(sql, params) → db.prepare(sql).get(params)

const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, 'src/routes');

const files = [
  'documents.js',
  'music.js',
  'code.js',
  'bookmarks.js',
  'anime.js',
  'search.js',
  'auth.js'
];

function fixFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  
  // 替换 db.all(sql, params) 为 db.prepare(sql).all(params)
  let newContent = content.replace(/db\.all\(([^,]+), ([^)]+)\)/g, (match, sql, params) => {
    return `const stmt = db.prepare(${sql})\n    const rows = stmt.all(${params})`;
  });
  
  // 替换 db.run(sql, params) 为 db.prepare(sql).run(params)
  newContent = newContent.replace(/db\.run\(([^,]+), ([^)]+)\)/g, (match, sql, params) => {
    return `const stmt = db.prepare(${sql})\n    stmt.run(${params})`;
  });
  
  // 替换 db.get(sql, params) 为 db.prepare(sql).get(params)
  newContent = newContent.replace(/db\.get\(([^,]+), ([^)]+)\)/g, (match, sql, params) => {
    return `const stmt = db.prepare(${sql})\n    const result = stmt.get(${params})`;
  });
  
  // 替换简单的 db.run('SQL', [params]) 为 db.prepare('SQL').run(params)
  newContent = newContent.replace(/db\.run\('([^']+)', \[([^]]+)\]\)/g, (match, sql, params) => {
    return `const stmt = db.prepare('${sql}')\n    stmt.run(${params})`;
  });
  
  fs.writeFileSync(filePath, newContent);
  console.log(`已修复 ${filePath}`);
}

files.forEach(file => {
  const filePath = path.join(routesDir, file);
  if (fs.existsSync(filePath)) {
    fixFile(filePath);
  } else {
    console.log(`文件不存在: ${filePath}`);
  }
});

console.log('所有路由文件修复完成');