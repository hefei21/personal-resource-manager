export const THEME_STORAGE_KEY = 'prm.appearance'
export const THEME_CHOICES = Object.freeze(['system', 'light', 'dark'])
export const normalizeTheme = value => THEME_CHOICES.includes(value) ? value : 'system'
export const resolveTheme = (preference, systemDark) => normalizeTheme(preference) === 'system'
  ? (systemDark ? 'dark' : 'light') : normalizeTheme(preference)

export function createThemeController({ storage, media, root, onChange = () => {} }) {
  let preference = 'system'
  try { preference = normalizeTheme(storage?.getItem(THEME_STORAGE_KEY)) } catch {}
  function apply() {
    const resolved = resolveTheme(preference, media?.matches === true)
    root.dataset.theme = resolved
    root.style.colorScheme = resolved
    onChange({ preference, resolved })
  }
  function set(value) {
    preference = normalizeTheme(value)
    try { storage?.setItem(THEME_STORAGE_KEY, preference) } catch {}
    apply()
  }
  function syncStorage(event) {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      preference = normalizeTheme(event.key === null ? null : event.newValue)
      apply()
    }
  }
  media?.addEventListener?.('change', apply)
  apply()
  return { set, syncStorage, dispose: () => media?.removeEventListener?.('change', apply) }
}
