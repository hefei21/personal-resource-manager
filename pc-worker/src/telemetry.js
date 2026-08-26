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

function safeModelKey(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized === '' ? null : normalized.slice(0, 256)
}

function isPathLikeModelIdentity(value) {
  if (typeof value !== 'string') return false
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) || /^file:/iu.test(value) ||
    /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || /^\//u.test(value) ||
    /^[.]{1,2}[\\/]/u.test(value) || value.includes('\\') ||
    /\.(?:gguf|safetensors|bin|onnx|pt|pth)$/iu.test(value)
}

function safeLoadedModelIdentity(value) {
  const normalized = safeModelKey(value)
  return normalized && !isPathLikeModelIdentity(normalized) ? normalized : null
}

function normalizeLoadedModel(model) {
  const modelKey = safeLoadedModelIdentity(model?.modelKey)
  const identifier = safeLoadedModelIdentity(model?.identifier)
  const id = modelKey || identifier || 'unknown'
  return {
    id,
    ...(modelKey ? { modelKey } : {}),
    ...(identifier ? { identifier } : {}),
    backend: 'lm-studio',
    ...(model?.quantization?.name ? { version: String(model.quantization.name).slice(0, 128) } : {}),
    ...(Number.isSafeInteger(model?.estimatedVramUsageBytes) ? { memoryBytes: model.estimatedVramUsageBytes } : {})
  }
}

function profileLoadedModel(model) {
  const normalized = {
    id: model.id,
    backend: model.backend
  }
  if (model.version !== undefined) normalized.version = model.version
  if (Number.isSafeInteger(model.memoryBytes) && model.memoryBytes >= 0) {
    normalized.memoryBytes = model.memoryBytes
  }
  return normalized
}

export async function collectLoadedModels(run = execFile) {
  try {
    const { stdout } = await run('lms', ['ps', '--json'], { timeout: 5_000, windowsHide: true, maxBuffer: 256 * 1024 })
    const parsed = JSON.parse(stdout)
    const models = Array.isArray(parsed) ? parsed : parsed?.models
    if (!Array.isArray(models)) return []
    return models.slice(0, 16).map(normalizeLoadedModel)
  } catch {
    return []
  }
}

export async function collectProfile(displayName, dependencies = {}) {
  const run = dependencies.execFile ?? execFile
  const [gpus, models] = await Promise.all([nvidiaGpus(run), collectLoadedModels(run)])
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
        // Readiness keeps the richer local identity, but the wire contract only
        // exposes the backend-owned loaded-model fields.
        loadedModels: models.map(profileLoadedModel)
      }
    }
  }
}
