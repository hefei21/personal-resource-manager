/**
 * 音频均衡器工具类
 * 使用 Web Audio API 实现10段均衡器
 */

// 均衡器预设配置
export const EQUALIZER_PRESETS = {
  default: {
    name: '默认',
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  },
  pop: {
    name: '流行',
    bands: [-1, 2, 3, 4, 3, 0, -1, -1, -1, -1]
  },
  rock: {
    name: '摇滚',
    bands: [5, 4, 3, 1, -1, -1, 0, 2, 4, 5]
  },
  classical: {
    name: '古典',
    bands: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4]
  },
  jazz: {
    name: '爵士',
    bands: [3, 2, 1, 2, -1, 0, 1, 2, 3, 3]
  },
  electronic: {
    name: '电子',
    bands: [5, 4, 2, 0, -1, 0, 2, 3, 4, 5]
  },
  vocal: {
    name: '人声',
    bands: [-2, -1, 0, 2, 4, 5, 4, 2, 0, -1]
  },
  acg: {
    name: 'ACG',
    bands: [2, 1, -1, 0, 2, 4, 4, 3, 2, 1]
  },
  acgBass: {
    name: 'ACG重低音',
    bands: [5, 4, 1, -1, 1, 3, 3, 2, 1, 0]
  }
}

// 10段均衡器频率配置
const BAND_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

class Equalizer {
  constructor() {
    this.audioContext = null
    this.sourceNode = null
    this.filters = []
    this.gainNode = null
    this.isEnabled = false
    this.isInitialized = false
    this.bands = [...EQUALIZER_PRESETS.default.bands]
    this.currentPreset = 'default'
    this.pendingEnabled = false // 记录用户期望的启用状态
  }

  /**
   * 初始化均衡器
   * @param {HTMLAudioElement} audioElement - 音频元素
   */
  async init(audioElement) {
    if (this.isInitialized) return

    try {
      // 创建 AudioContext
      const AudioContext = window.AudioContext || window.webkitAudioContext
      this.audioContext = new AudioContext()

      // 创建媒体元素源
      this.sourceNode = this.audioContext.createMediaElementSource(audioElement)

      // 创建各频段滤波器
      this.filters = BAND_FREQUENCIES.map((frequency, index) => {
        const filter = this.audioContext.createBiquadFilter()
        filter.type = 'peaking'
        filter.frequency.value = frequency
        filter.Q.value = 1.4 // Q值，影响滤波器的带宽
        filter.gain.value = this.bands[index]
        return filter
      })

      // 创建增益节点（主音量控制）
      this.gainNode = this.audioContext.createGain()
      this.gainNode.gain.value = 1

      // 根据 pendingEnabled 决定初始连接方式
      if (this.pendingEnabled) {
        // 启用均衡器：source -> filters -> gainNode -> destination
        this.sourceNode.connect(this.filters[0])
        for (let i = 0; i < this.filters.length - 1; i++) {
          this.filters[i].connect(this.filters[i + 1])
        }
        this.filters[this.filters.length - 1].connect(this.gainNode)
        this.gainNode.connect(this.audioContext.destination)
        this.isEnabled = true
      } else {
        // 禁用均衡器：直接连接到输出
        this.sourceNode.connect(this.audioContext.destination)
        this.isEnabled = false
      }

      this.isInitialized = true
      console.log(`✓ 均衡器初始化成功 (已${this.isEnabled ? '启用' : '禁用'})`)
      return true
    } catch (error) {
      console.error('均衡器初始化失败:', error)
      return false
    }
  }

  /**
   * 启用均衡器
   */
  enable() {
    this.pendingEnabled = true
    if (!this.isInitialized) {
      this.isEnabled = true // 先设置状态，初始化时会应用
      return
    }
    this.isEnabled = true
    // 重新连接均衡器路径
    this.sourceNode.disconnect()
    this.sourceNode.connect(this.filters[0])
    console.log('✓ 均衡器已启用')
  }

  /**
   * 禁用均衡器（直通模式）
   */
  disable() {
    this.pendingEnabled = false
    if (!this.isInitialized) {
      this.isEnabled = false // 先设置状态，初始化时会应用
      return
    }
    this.isEnabled = false
    // 断开均衡器，直接连接到输出
    this.sourceNode.disconnect()
    this.sourceNode.connect(this.audioContext.destination)
    console.log('✓ 均衡器已禁用')
  }

  /**
   * 设置指定频段的增益值
   * @param {number} bandIndex - 频段索引 (0-9)
   * @param {number} value - 增益值 (-12 到 +12 dB)
   */
  setBandGain(bandIndex, value) {
    if (bandIndex < 0 || bandIndex >= 10) return
    
    const clampedValue = Math.max(-12, Math.min(12, value))
    this.bands[bandIndex] = clampedValue
    
    // 只有初始化后才应用到滤波器
    if (this.isInitialized && this.filters[bandIndex]) {
      this.filters[bandIndex].gain.value = clampedValue
    }
  }

  /**
   * 批量设置所有频段增益值
   * @param {number[]} bands - 增益值数组
   */
  setAllBands(bands) {
    if (!Array.isArray(bands) || bands.length !== 10) return
    
    bands.forEach((value, index) => {
      this.setBandGain(index, value)
    })
  }

  /**
   * 应用预设
   * @param {string} presetName - 预设名称
   */
  applyPreset(presetName) {
    const preset = EQUALIZER_PRESETS[presetName]
    if (!preset) return

    this.currentPreset = presetName
    this.setAllBands(preset.bands)
    console.log(`✓ 已应用预设: ${preset.name}`)
  }

  /**
   * 重置为默认值
   */
  reset() {
    this.applyPreset('default')
  }

  /**
   * 获取当前配置
   */
  getConfig() {
    return {
      enabled: this.isEnabled,
      preset: this.currentPreset,
      bands: [...this.bands]
    }
  }

  /**
   * 从配置恢复
   * @param {object} config - 配置对象
   */
  loadConfig(config) {
    if (!config) return

    if (config.bands && Array.isArray(config.bands)) {
      this.setAllBands(config.bands)
    }

    // 恢复预设名称（如果保存的是预设）或标记为自定义
    if (config.preset && EQUALIZER_PRESETS[config.preset]) {
      this.currentPreset = config.preset
    } else {
      this.currentPreset = 'custom'
    }

    if (config.enabled) {
      this.enable()
    } else {
      this.disable()
    }
  }

  /**
   * 恢复音频元素直连（卸载均衡器）
   */
  destroy() {
    if (!this.isInitialized) return

    try {
      this.sourceNode.disconnect()
      this.sourceNode.connect(this.audioContext.destination)
      this.audioContext.close()
      this.isInitialized = false
      this.isEnabled = false
      console.log('✓ 均衡器已卸载')
    } catch (error) {
      console.error('均衡器卸载失败:', error)
    }
  }
}

// 导出单例实例
export const equalizer = new Equalizer()

// 导出类供特殊用途
export default Equalizer
