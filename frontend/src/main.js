import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './styles/global.css'
import { useToast } from './composables/useToast'

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount('#app')

// 全局 API toast 监听（单例注册）
window.addEventListener('api-toast', (e) => {
  const toast = useToast()
  toast[e.detail.type || 'warning'](e.detail.message)
})
