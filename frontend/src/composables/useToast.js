import { ref, h, render } from 'vue'

const toasts = ref([])
let toastId = 0

// Toast 容器组件
const ToastContainer = {
  setup() {
    return () => h('div', { class: 'toast-container' },
      toasts.value.map(toast =>
        h('div', {
          key: toast.id,
          class: ['toast-item', `toast-item--${toast.type}`]
        }, [
          h('span', { class: 'toast-icon' }, toast.type === 'success' ? '✓' : toast.type === 'error' ? '✕' : toast.type === 'warning' ? '!' : 'i'),
          h('span', { class: 'toast-message' }, toast.message)
        ])
      )
    )
  }
}

let containerMounted = false

function mountContainer() {
  if (containerMounted) return
  const container = document.createElement('div')
  container.id = 'toast-root'
  document.body.appendChild(container)
  render(h(ToastContainer), container)
  containerMounted = true
}

export function useToast() {
  mountContainer()

  function show(message, type = 'info', duration = 3000) {
    const id = ++toastId
    toasts.value.push({ id, message, type })
    
    setTimeout(() => {
      const index = toasts.value.findIndex(t => t.id === id)
      if (index > -1) {
        toasts.value.splice(index, 1)
      }
    }, duration)
  }

  return {
    success: (msg, duration) => show(msg, 'success', duration),
    error: (msg, duration) => show(msg, 'error', duration),
    warning: (msg, duration) => show(msg, 'warning', duration),
    info: (msg, duration) => show(msg, 'info', duration)
  }
}

// 全局样式
const style = document.createElement('style')
style.textContent = `
.toast-container {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toast-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 6px;
  background: #fff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  animation: toast-in 0.3s ease;
  min-width: 200px;
}

.toast-item--success { border-left: 4px solid #00a870; }
.toast-item--error { border-left: 4px solid #e34d59; }
.toast-item--warning { border-left: 4px solid #ed7b2f; }
.toast-item--info { border-left: 4px solid #0052d9; }

.toast-icon {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: bold;
  color: #fff;
}

.toast-item--success .toast-icon { background: #00a870; }
.toast-item--error .toast-icon { background: #e34d59; }
.toast-item--warning .toast-icon { background: #ed7b2f; }
.toast-item--info .toast-icon { background: #0052d9; }

.toast-message {
  font-size: 14px;
  color: #333;
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateX(100%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
`
document.head.appendChild(style)
