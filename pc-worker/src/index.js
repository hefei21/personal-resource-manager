import { WorkerApiClient } from './apiClient.js'
import { ensureNoProxyForUrl, loadConfig } from './config.js'
import { PcWorker } from './worker.js'

const config = loadConfig()
ensureNoProxyForUrl(process.env, config.baseUrl)
const worker = new PcWorker({
  config,
  api: new WorkerApiClient({ baseUrl: config.baseUrl, requestTimeoutMs: config.requestTimeoutMs })
})

process.on('SIGINT', () => worker.stop())
process.on('SIGTERM', () => worker.stop())

if (process.argv.includes('--once')) {
  await worker.runOnce()
} else {
  await worker.run()
}
