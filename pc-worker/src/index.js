import { WorkerApiClient } from './apiClient.js'
import {
  applyCommandLineConfig,
  ensureNoProxyForUrl,
  loadConfig,
  parentProcessIdFromCommandLine
} from './config.js'
import { PcWorker } from './worker.js'
import { createFileLogger } from './fileLogger.js'

applyCommandLineConfig()
const config = loadConfig()
ensureNoProxyForUrl(process.env, config.baseUrl)
const worker = new PcWorker({
  config,
  api: new WorkerApiClient({ baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs }),
  logger: createFileLogger(config.logPath)
})
const parentProcessId = parentProcessIdFromCommandLine()
let parentWatch

if (parentProcessId !== null) {
  parentWatch = setInterval(() => {
    try {
      process.kill(parentProcessId, 0)
    } catch {
      clearInterval(parentWatch)
      worker.stop()
    }
  }, 1_000)
  parentWatch.unref?.()
}

process.on('SIGINT', () => worker.stop())
process.on('SIGTERM', () => worker.stop())

try {
  if (process.argv.includes('--once')) {
    await worker.runOnce()
  } else {
    await worker.run()
  }
} finally {
  if (parentWatch) clearInterval(parentWatch)
}
