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
          role: toast.type === 'error' ? 'alert' : 'status',
          'aria-atomic': 'true',
          class: ['toast-item', `toast-item--${toast.type}`]
        }, [
          h('span', { class: 'toast-icon', 'aria-hidden': 'true' }, toast.type === 'success' ? '✓' : toast.type === 'error' ? '✕' : toast.type === 'warning' ? '!' : 'i'),
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
  top: max(16px, env(safe-area-inset-top));
  right: max(16px, env(safe-area-inset-right));
  z-index: 20000;
  width: min(420px, calc(100vw - 32px));
  pointer-events: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toast-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-sm);
  animation: toast-in var(--motion-duration-fast) var(--motion-easing-standard);
  min-width: 0;
}

.toast-item--success { border-left: 4px solid var(--color-success); }
.toast-item--error { border-left: 4px solid var(--color-danger); }
.toast-item--warning { border-left: 4px solid var(--color-warning); }
.toast-item--info { border-left: 4px solid var(--color-primary); }

.toast-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: bold;
}

.toast-item--success .toast-icon { background: var(--color-success-surface); color: var(--color-success-text); }
.toast-item--error .toast-icon { background: var(--color-danger-surface); color: var(--color-danger-text); }
.toast-item--warning .toast-icon { background: var(--color-warning-surface); color: var(--color-warning-text); }
.toast-item--info .toast-icon { background: var(--color-primary-surface); color: var(--color-primary); }

.toast-message {
  font-size: 14px;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--color-text-primary);
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
@media (prefers-reduced-motion: reduce) {
  .toast-item { animation: none; }
}
`
document.head.appendChild(style)
