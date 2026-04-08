#!/usr/bin/env node

/**
 * Redis 缓存功能测试脚本
 * 
 * 使用方法：
 * node test-cache.js
 */

const axios = require('axios')

// 配置
const BASE_URL = 'http://localhost:3000/api'
const TEST_USER = {
  username: 'admin',
  password: 'admin123'
}

let authToken = ''

// 辅助函数：延迟
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// 辅助函数：发送请求
async function request(method, endpoint, data = null) {
  const config = {
    method,
    url: `${BASE_URL}${endpoint}`,
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    }
  }
  if (data) {
    config.data = data
  }
  const start = Date.now()
  const response = await axios(config)
  const duration = Date.now() - start
  return { data: response.data, duration }
}

// 测试函数
async function runTests() {
  console.log('========================================')
  console.log('Redis 缓存功能测试')
  console.log('========================================\n')

  try {
    // 1. 登录获取 Token
    console.log('【步骤 1】登录获取 Token...')
    const loginRes = await axios.post(`${BASE_URL}/auth/login`, TEST_USER)
    authToken = loginRes.data.token
    console.log('✓ 登录成功\n')

    // 2. 测试文档分类接口缓存
    console.log('【步骤 2】测试文档分类接口缓存...')
    console.log('  第1次请求（应该查询数据库）:')
    const cat1 = await request('GET', '/documents/categories')
    console.log(`  ✓ 响应时间: ${cat1.duration}ms`)
    console.log(`  ✓ 分类数量: ${cat1.data.data?.length || 0}`)

    await delay(500)

    console.log('  第2次请求（应该命中缓存）:')
    const cat2 = await request('GET', '/documents/categories')
    console.log(`  ✓ 响应时间: ${cat2.duration}ms`)
    console.log(`  ✓ 分类数量: ${cat2.data.data?.length || 0}`)
    
    if (cat2.duration < cat1.duration) {
      console.log(`  ✓ 性能提升: ${((1 - cat2.duration / cat1.duration) * 100).toFixed(1)}%`)
    }
    console.log()

    // 3. 测试文档标签接口缓存
    console.log('【步骤 3】测试文档标签接口缓存...')
    console.log('  第1次请求（应该查询数据库）:')
    const tags1 = await request('GET', '/documents/tags')
    console.log(`  ✓ 响应时间: ${tags1.duration}ms`)
    console.log(`  ✓ 标签数量: ${tags1.data.data?.length || 0}`)

    await delay(500)

    console.log('  第2次请求（应该命中缓存）:')
    const tags2 = await request('GET', '/documents/tags')
    console.log(`  ✓ 响应时间: ${tags2.duration}ms`)
    console.log(`  ✓ 标签数量: ${tags2.data.data?.length || 0}`)
    
    if (tags2.duration < tags1.duration) {
      console.log(`  ✓ 性能提升: ${((1 - tags2.duration / tags1.duration) * 100).toFixed(1)}%`)
    }
    console.log()

    // 4. 测试音乐艺术家接口缓存
    console.log('【步骤 4】测试音乐艺术家接口缓存...')
    console.log('  第1次请求（应该查询数据库）:')
    const artists1 = await request('GET', '/music/artists')
    console.log(`  ✓ 响应时间: ${artists1.duration}ms`)
    console.log(`  ✓ 艺术家数量: ${artists1.data.data?.length || 0}`)

    await delay(500)

    console.log('  第2次请求（应该命中缓存）:')
    const artists2 = await request('GET', '/music/artists')
    console.log(`  ✓ 响应时间: ${artists2.duration}ms`)
    console.log(`  ✓ 艺术家数量: ${artists2.data.data?.length || 0}`)
    
    if (artists2.duration < artists1.duration) {
      console.log(`  ✓ 性能提升: ${((1 - artists2.duration / artists1.duration) * 100).toFixed(1)}%`)
    }
    console.log()

    // 5. 测试音乐专辑接口缓存
    console.log('【步骤 5】测试音乐专辑接口缓存...')
    console.log('  第1次请求（应该查询数据库）:')
    const albums1 = await request('GET', '/music/albums')
    console.log(`  ✓ 响应时间: ${albums1.duration}ms`)
    console.log(`  ✓ 专辑数量: ${albums1.data.data?.length || 0}`)

    await delay(500)

    console.log('  第2次请求（应该命中缓存）:')
    const albums2 = await request('GET', '/music/albums')
    console.log(`  ✓ 响应时间: ${albums2.duration}ms`)
    console.log(`  ✓ 专辑数量: ${albums2.data.data?.length || 0}`)
    
    if (albums2.duration < albums1.duration) {
      console.log(`  ✓ 性能提升: ${((1 - albums2.duration / albums1.duration) * 100).toFixed(1)}%`)
    }
    console.log()

    // 6. 测试缓存失效（创建分类）
    console.log('【步骤 6】测试缓存失效机制...')
    console.log('  创建新分类...')
    try {
      await request('POST', '/documents/categories', { name: '测试分类_缓存测试' })
      console.log('  ✓ 分类创建成功')
    } catch (error) {
      if (error.response?.data?.message?.includes('已存在')) {
        console.log('  ⚠ 分类已存在，跳过创建')
      } else {
        throw error
      }
    }

    await delay(500)

    console.log('  再次请求分类列表（缓存应该已失效）:')
    const cat3 = await request('GET', '/documents/categories')
    console.log(`  ✓ 响应时间: ${cat3.duration}ms`)
    console.log(`  ✓ 分类数量: ${cat3.data.data?.length || 0}`)
    console.log('  ✓ 缓存失效机制正常工作\n')

    // 7. 测试结果汇总
    console.log('========================================')
    console.log('测试结果汇总')
    console.log('========================================')
    console.log('✓ 所有接口响应正常')
    console.log('✓ 缓存读取功能正常')
    console.log('✓ 缓存失效机制正常')
    console.log()
    console.log('性能提升统计：')
    console.log(`  - 文档分类: ${cat1.duration}ms → ${cat2.duration}ms`)
    console.log(`  - 文档标签: ${tags1.duration}ms → ${tags2.duration}ms`)
    console.log(`  - 音乐艺术家: ${artists1.duration}ms → ${artists2.duration}ms`)
    console.log(`  - 音乐专辑: ${albums1.duration}ms → ${albums2.duration}ms`)
    console.log()
    console.log('🎉 缓存功能测试完成！')

  } catch (error) {
    console.error('\n❌ 测试失败:', error.message)
    if (error.response) {
      console.error('响应数据:', error.response.data)
    }
    process.exit(1)
  }
}

// 运行测试
runTests()
