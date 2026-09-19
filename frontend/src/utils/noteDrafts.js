export const NOTE_DRAFT_PREFIX = 'pr-manager:note-draft:v1:'
export function noteForm(value = {}) {
  return { title: value.title || '', content: value.content || '', category_id: value.category_id || null, tags: [...new Set((value.tags || []).map(t => t.normalize('NFKC').trim()).filter(Boolean))], is_top: Boolean(value.is_top) }
}
export const sameNote = (a, b) => JSON.stringify(noteForm(a)) === JSON.stringify(noteForm(b))
export function newNoteMutation() {
  // crypto.randomUUID is unavailable on many HTTP LAN origins.
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('')
}
export function readNoteDrafts(storage, owner) {
  const prefix = NOTE_DRAFT_PREFIX + encodeURIComponent(owner) + ':'
  const records = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key?.startsWith(prefix)) continue
    try {
      const value = JSON.parse(storage.getItem(key))
      if (value.version === 1 && typeof value.form?.content === 'string' && typeof value.form?.title === 'string' && Array.isArray(value.form.tags) && value.form.tags.every(t => typeof t === 'string') && typeof value.mutationId === 'string') records.push({ ...value, key })
    } catch { /* malformed local data is not rendered */ }
  }
  return records.sort((a, b) => b.updatedAt - a.updatedAt)
}
export function writeNoteDraft(storage, key, draft) {
  if (!key?.startsWith(NOTE_DRAFT_PREFIX)) throw new Error('Draft owner is missing')
  storage.setItem(key, JSON.stringify({ version: 1, ...draft, form: noteForm(draft.form), updatedAt: Date.now() }))
}
export function clearNoteDrafts(storage) {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i)
    if (key?.startsWith(NOTE_DRAFT_PREFIX)) storage.removeItem(key)
  }
}
