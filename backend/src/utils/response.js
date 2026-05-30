/**
 * 统一 API 响应格式
 */

/**
 * 成功响应
 * @param {Response} res - Express 响应对象
 * @param {any} data - 响应数据
 * @param {string} message - 成功消息
 * @param {number} statusCode - HTTP 状态码
 */
export function success(res, data = null, message = 'success', statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    code: 0,
    message,
    data,
    timestamp: new Date().toISOString()
  })
}

/**
 * 分页成功响应
 * @param {Response} res - Express 响应对象
 * @param {Array} list - 列表数据
 * @param {number} total - 总记录数
 * @param {number} page - 当前页
 * @param {number} pageSize - 每页大小
 * @param {string} message - 成功消息
 */
export function successPage(res, list, total, page, pageSize, message = 'success') {
  return res.status(200).json({
    success: true,
    code: 0,
    message,
    data: list,
    pagination: {
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      hasMore: page * pageSize < total
    },
    timestamp: new Date().toISOString()
  })
}

/**
 * 错误响应
 * @param {Response} res - Express 响应对象
 * @param {string} message - 错误消息
 * @param {number} code - 业务错误码
 * @param {number} statusCode - HTTP 状态码
 * @param {any} details - 错误详情
 */
export function error(res, message = 'error', code = 1, statusCode = 400, details = null) {
  const response = {
    success: false,
    code,
    message,
    timestamp: new Date().toISOString()
  }
  if (details) {
    response.details = details
  }
  return res.status(statusCode).json(response)
}

/**
 * 常见错误码
 */
export const ErrorCode = {
  // 系统级错误 1000-1999
  UNKNOWN_ERROR: 1000,
  INTERNAL_ERROR: 1001,
  SERVICE_UNAVAILABLE: 1002,
  TIMEOUT: 1003,
  
  // 参数错误 2000-2999
  INVALID_PARAMS: 2000,
  MISSING_PARAMS: 2001,
  INVALID_FORMAT: 2002,
  
  // 认证授权错误 3000-3999
  UNAUTHORIZED: 3000,
  FORBIDDEN: 3001,
  TOKEN_EXPIRED: 3002,
  TOKEN_INVALID: 3003,
  
  // 资源错误 4000-4999
  NOT_FOUND: 4000,
  ALREADY_EXISTS: 4001,
  RESOURCE_LIMIT: 4002,
  
  // 业务错误 5000-5999
  OPERATION_FAILED: 5000,
  BUSINESS_LOGIC_ERROR: 5001
}

/**
 * 快捷错误响应方法
 */
export const errorHandler = {
  notFound: (res, message = '资源不存在') => error(res, message, ErrorCode.NOT_FOUND, 404),
  unauthorized: (res, message = '未授权') => error(res, message, ErrorCode.UNAUTHORIZED, 401),
  forbidden: (res, message = '禁止访问') => error(res, message, ErrorCode.FORBIDDEN, 403),
  badRequest: (res, message = '请求参数错误') => error(res, message, ErrorCode.INVALID_PARAMS, 400),
  internalError: (res, message = '服务器内部错误') => error(res, message, ErrorCode.INTERNAL_ERROR, 500),
  conflict: (res, message = '资源已存在') => error(res, message, ErrorCode.ALREADY_EXISTS, 409)
}
