<template>
  <div class="equalizer-panel">
    <div class="equalizer-header">
      <h3 class="equalizer-title">均衡器</h3>
      <div class="header-controls">
        <t-switch
          v-model="enabled"
          size="small"
          @change="handleEnableChange"
        />
        <t-select
          v-model="currentPreset"
          size="small"
          class="preset-select"
          @change="handlePresetChange"
        >
          <t-option
            v-for="(preset, key) in presets"
            :key="key"
            :value="key"
            :label="preset.name"
          />
          <t-option value="custom" label="自定义" :disabled="true" />
        </t-select>
      </div>
    </div>

    <div class="bands-container">
      <div class="band" v-for="(value, index) in bands" :key="index">
        <div class="band-value" :class="{ positive: value > 0, negative: value < 0 }">
          {{ value > 0 ? '+' : '' }}{{ value }}dB
        </div>
        <div class="band-slider-wrapper">
          <div class="slider-track">
            <div class="slider-zero-line"></div>
            <div 
              class="slider-fill" 
              :style="{
                height: value >= 0 ? '50%' : `${50 + (Math.abs(value) / 12) * 50}%`,
                bottom: value >= 0 ? '50%' : `${50 - (Math.abs(value) / 12) * 50}%`
              }"
            ></div>
          </div>
          <input
            type="range"
            :min="-12"
            :max="12"
            :value="value"
            @input="handleBandChange(index, $event)"
            :disabled="!enabled"
            class="vertical-slider"
          />
        </div>
        <div class="band-freq">{{ frequencies[index] }}</div>
      </div>
    </div>

    <div class="actions">
      <t-button size="small" variant="outline" @click="handleReset" :disabled="!enabled">
        重置
      </t-button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { equalizer, EQUALIZER_PRESETS } from '../utils/Equalizer.js'

// 频率标签
const frequencies = ['31', '62', '125', '250', '500', '1K', '2K', '4K', '8K', '16K']

// 状态
const enabled = ref(false)
const bands = ref([...equalizer.bands])
const currentPreset = ref('default')
const presets = EQUALIZER_PRESETS

// 监听均衡器状态
watch(() => equalizer.isEnabled, (val) => {
  enabled.value = val
})

watch(() => equalizer.bands, (val) => {
  bands.value = [...val]
}, { deep: true })

watch(() => equalizer.currentPreset, (val) => {
  currentPreset.value = val
})

// 启用/禁用均衡器
function handleEnableChange(value) {
  if (value) {
    equalizer.enable()
  } else {
    equalizer.disable()
  }
  saveConfig()
}

// 预设变更
function handlePresetChange(presetName) {
  equalizer.applyPreset(presetName)
  bands.value = [...equalizer.bands]
  saveConfig()
}

// 频段调整
function handleBandChange(index, event) {
  const value = parseInt(event.target.value)
  // 直接更新本地状态
  bands.value = [...bands.value]
  bands.value[index] = value
  // 更新均衡器
  equalizer.setBandGain(index, value)
  currentPreset.value = 'custom'
  equalizer.currentPreset = 'custom'
  saveConfig()
}

// 重置
function handleReset() {
  equalizer.reset()
  bands.value = [...equalizer.bands]
  currentPreset.value = 'default'
  saveConfig()
}

// 保存配置到 localStorage
function saveConfig() {
  const config = equalizer.getConfig()
  localStorage.setItem('equalizerConfig', JSON.stringify(config))
}

// 加载配置
function loadConfig() {
  try {
    const saved = localStorage.getItem('equalizerConfig')
    if (saved) {
      const config = JSON.parse(saved)
      equalizer.loadConfig(config)
      bands.value = [...equalizer.bands]
      currentPreset.value = equalizer.currentPreset
      enabled.value = equalizer.isEnabled
    }
  } catch (error) {
    console.error('加载均衡器配置失败:', error)
  }
}

// 组件挂载时加载配置
onMounted(() => {
  loadConfig()
})

// 暴露方法供父组件调用
defineExpose({
  loadConfig,
  saveConfig
})
</script>

<style scoped>
.equalizer-panel {
  background: linear-gradient(145deg, #0d1b2a 0%, #1b263b 50%, #0d1b2a 100%);
  backdrop-filter: blur(10px);
  border-radius: 12px;
  padding: 12px 10px;
  min-width: 480px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.equalizer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.equalizer-title {
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  margin: 0;
}

.header-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 预设下拉框样式 */
.preset-select {
  width: 100px;
}

.preset-select :deep(.t-input) {
  background: rgba(255, 255, 255, 0.15) !important;
  border-color: rgba(255, 255, 255, 0.2) !important;
}

.preset-select :deep(.t-input__inner) {
  color: #fff !important;
  font-size: 13px;
}

.preset-select :deep(.t-input__inner::placeholder) {
  color: rgba(255, 255, 255, 0.5);
}

.preset-select :deep(.t-fake-arrow) {
  color: rgba(255, 255, 255, 0.8);
}

/* 开关样式 */
.header-controls :deep(.t-switch) {
  --td-switch-checked-color: #6bcb77;
}

.bands-container {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 16px 4px;
}

.band {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.band-value {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  min-height: 16px;
  text-align: center;
  transition: color 0.3s;
  white-space: nowrap;
}

.band-value.positive {
  color: #4ade80;
  text-shadow: 0 0 8px rgba(74, 222, 128, 0.4);
}

.band-value.negative {
  color: #fca5a5;
  text-shadow: 0 0 8px rgba(252, 165, 165, 0.4);
}

.band-slider-wrapper {
  position: relative;
  height: 120px;
  width: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.slider-track {
  position: absolute;
  width: 4px;
  height: 100%;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  pointer-events: none;
}

.slider-zero-line {
  position: absolute;
  width: 10px;
  height: 2px;
  background: rgba(255, 255, 255, 0.5);
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.slider-fill {
  position: absolute;
  width: 100%;
  border-radius: 2px;
  background: linear-gradient(to top, 
    #4ade80 0%, 
    #4ade80 40%, 
    #fbbf24 50%, 
    #fca5a5 60%, 
    #fca5a5 100%
  );
  pointer-events: none;
  box-shadow: 0 0 6px rgba(74, 222, 128, 0.3), 0 0 6px rgba(252, 165, 165, 0.3);
}

.vertical-slider {
  position: relative;
  width: 120px;
  height: 20px;
  transform: rotate(-90deg);
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  outline: none;
  cursor: pointer;
}

.vertical-slider::-webkit-slider-runnable-track {
  width: 100%;
  height: 4px;
  background: transparent;
  border-radius: 2px;
}

.vertical-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  background: #fff;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  transition: transform 0.2s, box-shadow 0.2s;
  margin-top: -6px;
}

.vertical-slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
}

.vertical-slider::-moz-range-track {
  width: 100%;
  height: 4px;
  background: transparent;
  border-radius: 2px;
}

.vertical-slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  background: #fff;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  transition: transform 0.2s, box-shadow 0.2s;
}

.vertical-slider::-moz-range-thumb:hover {
  transform: scale(1.2);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
}

.vertical-slider:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.vertical-slider:disabled::-webkit-slider-thumb {
  cursor: not-allowed;
}

.band-freq {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
  text-align: center;
  font-weight: 500;
}

.actions {
  display: flex;
  justify-content: center;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

/* 重置按钮样式 */
.actions :deep(.t-button) {
  color: #fff;
  border-color: rgba(255, 255, 255, 0.3);
  background: rgba(255, 255, 255, 0.1);
  font-weight: 500;
}

.actions :deep(.t-button:hover) {
  border-color: rgba(255, 255, 255, 0.5);
  background: rgba(255, 255, 255, 0.15);
}

.actions :deep(.t-button:disabled) {
  opacity: 0.4;
}
</style>
