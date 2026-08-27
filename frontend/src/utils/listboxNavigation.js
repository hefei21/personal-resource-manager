/**
 * Return the first option that can receive focus/active state.
 *
 * The helpers in this file deliberately do not depend on Vue or the DOM so
 * keyboard behavior can be tested independently from the component.
 */
export function findFirstEnabledIndex(options) {
  const list = Array.isArray(options) ? options : []
  return list.findIndex(option => !option?.disabled)
}

/** Return the last option that can receive focus/active state. */
export function findLastEnabledIndex(options) {
  const list = Array.isArray(options) ? options : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (!list[index]?.disabled) return index
  }
  return -1
}

/**
 * Move an active listbox index while skipping disabled options.
 * Arrow movement is clamped at the first/last enabled option; Home and End
 * jump directly to the corresponding enabled boundary.
 */
export function moveListboxActiveIndex(options, currentIndex, key) {
  const list = Array.isArray(options) ? options : []
  if (list.length === 0) return -1

  if (key === 'Home') return findFirstEnabledIndex(list)
  if (key === 'End') return findLastEnabledIndex(list)

  const step = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0
  if (step === 0) return Number.isInteger(currentIndex) ? currentIndex : -1

  const first = findFirstEnabledIndex(list)
  const last = findLastEnabledIndex(list)
  if (first < 0) return -1

  const index = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < list.length
    ? currentIndex
    : step > 0 ? -1 : list.length

  if (step > 0) {
    for (let next = index + 1; next < list.length; next += 1) {
      if (!list[next]?.disabled) return next
    }
    return last
  }

  for (let next = index - 1; next >= 0; next -= 1) {
    if (!list[next]?.disabled) return next
  }
  return first
}
