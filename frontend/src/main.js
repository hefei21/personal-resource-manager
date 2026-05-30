import { createApp } from 'vue'
import { createPinia } from 'pinia'
import TDesign from 'tdesign-vue-next'
import 'tdesign-vue-next/es/style/index.css'
import App from './App.vue'
import router from './router'
import './styles/global.css'
import 'highlight.js/styles/atom-one-dark.css'
import { useToast } from './composables/useToast'
import { NativeIcon } from '@/components/native'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(TDesign)
app.component('NativeIcon', NativeIcon)

// 全局 API toast 监听
app.mixin({
  mounted() {
    this._apiToastHandler = (e) => {
      const toast = useToast()
      toast[e.detail.type || 'warning'](e.detail.message)
    }
    window.addEventListener('api-toast', this._apiToastHandler)
  },
  beforeUnmount() {
    window.removeEventListener('api-toast', this._apiToastHandler)
  }
})

app.mount('#app')
