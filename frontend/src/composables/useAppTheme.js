import { ref } from 'vue'
import { createThemeController } from '../domain/appTheme'

const preference = ref('system'), resolved = ref('light')
let controller
export function initializeAppTheme() {
  if (controller || typeof window === 'undefined') return
  let storage
  try { storage = window.localStorage } catch {}
  controller = createThemeController({ storage, media: window.matchMedia('(prefers-color-scheme: dark)'),
    root: document.documentElement,
    onChange: value => { preference.value = value.preference; resolved.value = value.resolved } })
  window.addEventListener('storage', controller.syncStorage)
}
export function useAppTheme() {
  initializeAppTheme()
  return { preference, resolved, setTheme: value => controller?.set(value) }
}
