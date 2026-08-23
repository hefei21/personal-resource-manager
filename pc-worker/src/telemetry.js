import { execFile as execFileCallback } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const MIB = 1024 * 1024

async function nvidiaGpus(run = execFile) {
  try {
    const { stdout } = await run('nvidia-smi', [
      '--query-gpu=name,memory.total,memory.free,driver_version',
      '--format=csv,noheader,nounits'
    ], { timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024 })
    return stdout.trim().split(/\r?\n/u).filter(Boolean).slice(0, 8).map((line) => {
      const [name, total, free, driverVersion] = line.split(',').map((value) => value.trim())
      return {
        vendor: 'NVIDIA',
        name,
        totalMemoryBytes: Math.round(Number(total) * MIB),
        freeMemoryBytes: Math.round(Number(free) * MIB),
        driverVersion
      }
    }).filter((gpu) => gpu.name && Number.isSafeInteger(gpu.totalMemoryBytes) && Number.isSafeInteger(gpu.freeMemoryBytes))
  } catch {
    return []
  }
}

async function loadedModels(run = execFile) {
  try {
    const { stdout } = await run('lms', ['ps', '--json'], { timeout: 5_000, windowsHide: true, maxBuffer: 256 * 1024 })
    const models = JSON.parse(stdout)
    if (!Array.isArray(models)) return []
    return models.slice(0, 16).map((model) => ({
      id: String(model.modelKey || model.identifier || model.path || 'unknown').slice(0, 256),
      backend: 'lm-studio',
      ...(model.quantization?.name ? { version: String(model.quantization.name).slice(0, 128) } : {}),
      ...(Number.isSafeInteger(model.estimatedVramUsageBytes) ? { memoryBytes: model.estimatedVramUsageBytes } : {})
    }))
  } catch {
    return []
  }
}

export async function collectProfile(displayName, dependencies = {}) {
  const run = dependencies.execFile ?? execFile
  const [gpus, models] = await Promise.all([nvidiaGpus(run), loadedModels(run)])
  return {
    displayName,
    protocolVersion: 1,
    agentVersion: '0.1.0',
    platform: process.platform,
    architecture: process.arch,
    capabilities: {
      processors: [{ taskType: 'content.inspect', processorVersion: 'v1', executionClass: 'gpu', outputSchemaVersion: 1 }],
      resources: {
        cpuLogicalCores: os.availableParallelism(),
        systemMemoryBytes: os.totalmem(),
        gpus,
        loadedModels: models
      }
    }
  }
}
