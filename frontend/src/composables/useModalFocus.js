import { nextTick, onMounted, onUnmounted, watch } from 'vue'

/**
 * The selector intentionally contains only elements that can be reached with
 * Tab in the browser. Elements with tabindex=-1 remain programmatically
 * focusable (which is useful for the modal container), but are not part of
 * the Tab loop.
 */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  'audio[controls]',
  'video[controls]',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

const bodyScrollLocks = new WeakMap()
const activeModalScopes = []

/**
 * Keep the focus rules pure so they can be tested without jsdom or another
 * browser implementation.
 */
export function filterFocusableCandidates(candidates = []) {
  return candidates.filter((candidate) => {
    if (!candidate || candidate.disabled || candidate.hidden || candidate.inert) {
      return false
    }

    if (candidate.ariaHidden === true || candidate.ariaHidden === 'true') {
      return false
    }

    if (candidate.type === 'hidden') {
      return false
    }

    const tabIndex = candidate.tabIndex == null ? 0 : Number(candidate.tabIndex)
    return Number.isFinite(tabIndex) && tabIndex >= 0
  })
}

/**
 * Return the next index for a Tab/Shift+Tab event. An index outside the list
 * means focus entered from outside the modal, so traversal starts at the
 * corresponding edge.
 */
export function getNextFocusIndex(currentIndex, count, backwards = false) {
  if (!Number.isInteger(count) || count <= 0) {
    return -1
  }

  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= count) {
    return backwards ? count - 1 : 0
  }

  return backwards
    ? (currentIndex - 1 + count) % count
    : (currentIndex + 1) % count
}

/**
 * Lock one document body while at least one modal is open. Each caller gets a
 * release function; repeated releases are harmless, which makes unmount and
 * prop transitions safe even when they race with one another.
 */
export function acquireBodyScrollLock(documentLike = globalThis.document) {
  const body = documentLike?.body
  if (!body?.style) {
    return () => {}
  }

  let state = bodyScrollLocks.get(body)
  if (!state) {
    state = {
      count: 0,
      originalOverflow: body.style.overflow
    }
    bodyScrollLocks.set(body, state)
  }

  state.count += 1
  body.style.overflow = 'hidden'

  let released = false
  return () => {
    if (released) {
      return
    }
    released = true

    const currentState = bodyScrollLocks.get(body)
    if (!currentState) {
      return
    }

    currentState.count -= 1
    if (currentState.count <= 0) {
      body.style.overflow = currentState.originalOverflow
      bodyScrollLocks.delete(body)
    }
  }
}

function isConnected(element) {
  if (!element) {
    return false
  }
  return element.isConnected !== false
}

function isProgrammaticallyFocusable(element) {
  if (!element || typeof element.focus !== 'function' || !isConnected(element)) {
    return false
  }

  if (element.disabled || element.hidden || element.inert) {
    return false
  }

  if (element.getAttribute?.('aria-hidden') === 'true') {
    return false
  }

  if (element.closest?.('fieldset[disabled], [inert], [aria-hidden="true"]')) {
    return false
  }

  return true
}

function isTabbableElement(element) {
  if (!isProgrammaticallyFocusable(element)) {
    return false
  }

  const tabIndex = element.tabIndex == null ? 0 : Number(element.tabIndex)
  if (!Number.isFinite(tabIndex) || tabIndex < 0) {
    return false
  }

  const ownerWindow = element.ownerDocument?.defaultView
  const computedStyle = ownerWindow?.getComputedStyle?.(element)
  if (computedStyle?.display === 'none' || computedStyle?.visibility === 'hidden') {
    return false
  }

  return true
}

function getFocusableElements(container) {
  if (!container?.querySelectorAll) {
    return []
  }

  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isTabbableElement)
}

function focusElement(element) {
  if (!isProgrammaticallyFocusable(element)) {
    return false
  }

  try {
    element.focus({ preventScroll: true })
  } catch {
    // A few browser-like hosts only implement focus() without options.
    element.focus()
  }
  return true
}

function removeModalScope(scope) {
  const index = activeModalScopes.lastIndexOf(scope)
  if (index !== -1) {
    activeModalScopes.splice(index, 1)
  }
}

function resolveOpenState(source) {
  if (typeof source === 'function') {
    return Boolean(source())
  }
  return Boolean(source?.value ?? source)
}

/**
 * Add focus management to a teleported modal or drawer content element.
 * `containerRef` is a Vue ref and `isOpen` may be a ref, a getter, or a value.
 */
export function useModalFocus(containerRef, isOpen) {
  let active = false
  let previousActiveElement = null
  let removeKeydown = null
  const scope = {}

  const resolveDocument = () => (
    containerRef.value?.ownerDocument || globalThis.document
  )

  function handleKeydown(event) {
    if (!active || event.key !== 'Tab' || activeModalScopes.at(-1) !== scope) {
      return
    }

    const container = containerRef.value
    if (!container) {
      return
    }

    const focusableElements = getFocusableElements(container)
    if (focusableElements.length === 0) {
      event.preventDefault()
      focusElement(container)
      return
    }

    const documentLike = resolveDocument()
    const currentIndex = focusableElements.indexOf(documentLike?.activeElement)
    const nextIndex = getNextFocusIndex(currentIndex, focusableElements.length, event.shiftKey)
    if (nextIndex === -1) {
      return
    }

    event.preventDefault()
    focusElement(focusableElements[nextIndex])
  }

  function activate() {
    if (active) {
      return
    }

    const documentLike = resolveDocument()
    active = true
    previousActiveElement = documentLike?.activeElement || null
    activeModalScopes.push(scope)

    if (documentLike?.addEventListener) {
      documentLike.addEventListener('keydown', handleKeydown)
      removeKeydown = () => documentLike.removeEventListener('keydown', handleKeydown)
    }

    nextTick(() => {
      if (!active) {
        return
      }

      const container = containerRef.value
      const firstFocusable = getFocusableElements(container)[0]
      focusElement(firstFocusable || container)
    })
  }

  function deactivate() {
    if (!active) {
      return
    }

    active = false
    removeKeydown?.()
    removeKeydown = null
    removeModalScope(scope)

    const elementToRestore = previousActiveElement
    previousActiveElement = null
    nextTick(() => {
      if (isProgrammaticallyFocusable(elementToRestore)) {
        focusElement(elementToRestore)
      }
    })
  }

  const stop = watch(
    () => resolveOpenState(isOpen),
    (open) => {
      if (open) {
        activate()
      } else {
        deactivate()
      }
    },
    { flush: 'post' }
  )

  onMounted(() => {
    if (resolveOpenState(isOpen)) {
      activate()
    }
  })

  onUnmounted(() => {
    stop()
    deactivate()
  })

  return {
    activate,
    deactivate,
    getFocusableElements
  }
}
