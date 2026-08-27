import { onBeforeUnmount, onMounted, readonly, ref } from 'vue'

export const MOBILE_BREAKPOINT_PX = 768
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`

export function viewportMatchesMobile(windowLike = globalThis.window) {
  if (!windowLike || typeof windowLike.matchMedia !== 'function') return false
  return Boolean(windowLike.matchMedia(MOBILE_MEDIA_QUERY).matches)
}

const isMobile = ref(viewportMatchesMobile())
let mediaQueryList = null
let activeConsumers = 0

function updateViewport(event) {
  isMobile.value = Boolean(event?.matches ?? mediaQueryList?.matches)
}

function startViewportListener() {
  if (mediaQueryList || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  mediaQueryList = window.matchMedia(MOBILE_MEDIA_QUERY)
  updateViewport(mediaQueryList)
  if (typeof mediaQueryList.addEventListener === 'function') {
    mediaQueryList.addEventListener('change', updateViewport)
  } else {
    mediaQueryList.addListener?.(updateViewport)
  }
}

function stopViewportListener() {
  if (!mediaQueryList) return
  if (typeof mediaQueryList.removeEventListener === 'function') {
    mediaQueryList.removeEventListener('change', updateViewport)
  } else {
    mediaQueryList.removeListener?.(updateViewport)
  }
  mediaQueryList = null
}

export function useViewport() {
  let active = false

  onMounted(() => {
    if (active) return
    active = true
    activeConsumers += 1
    startViewportListener()
  })

  onBeforeUnmount(() => {
    if (!active) return
    active = false
    activeConsumers = Math.max(0, activeConsumers - 1)
    if (activeConsumers === 0) stopViewportListener()
  })

  return { isMobile: readonly(isMobile) }
}
