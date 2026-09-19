// Local-device state only; never persist credentials, paths, lyrics or artwork.
export const PLAYER_SNAPSHOT_VERSION = 1
export const MAX_SAVED_QUEUE = 500
export function normalizeQueue(songs) {
  const seen = new Set()
  return (Array.isArray(songs) ? songs : []).filter(song => {
    const id = Number(song?.id)
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) return false
    seen.add(id)
    return true
  }).map(song => ({
    id: Number(song.id), title: String(song.title || '未命名曲目').slice(0, 500),
    artist: String(song.artist || '').slice(0, 300), album: String(song.album || '').slice(0, 300),
    duration: Number.isFinite(Number(song.duration)) ? Math.max(0, Number(song.duration)) : 0,
    has_cover: Boolean(song.has_cover)
  }))
}
export function nextQueueIndex(index, length, direction = 1, shuffle = false, random = Math.random) {
  if (length < 1) return -1
  if (length === 1) return 0
  if (shuffle) return (Math.max(0, index) + 1 + Math.floor(Math.min(.999999, Math.max(0, random())) * (length - 1))) % length
  return (index + direction + length) % length
}
export function playbackSnapshot(queue, songId, position, volume, mode, now = Date.now()) {
  const normalized = normalizeQueue(queue)
  const current = normalized.find(song => song.id === Number(songId))
  let saved = normalized.slice(0, MAX_SAVED_QUEUE)
  if (current && !saved.some(song => song.id === current.id)) saved = [current, ...saved.slice(0, MAX_SAVED_QUEUE - 1)]
  return { version: PLAYER_SNAPSHOT_VERSION, savedAt: now, queue: saved, songId: current?.id ?? null,
    position: Number.isFinite(position) ? Math.max(0, position) : 0,
    volume: Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) : 80,
    mode: ['sequence', 'loop', 'shuffle'].includes(mode) ? mode : 'sequence' }
}
export function readPlaybackSnapshot(raw, now = Date.now()) {
  try {
    const value = JSON.parse(raw)
    if (value?.version !== PLAYER_SNAPSHOT_VERSION || !Number.isFinite(value.savedAt) ||
      now - value.savedAt > 30 * 86400000 || value.savedAt > now + 60000) return null
    return playbackSnapshot(value.queue, value.songId, value.position, value.volume, value.mode, value.savedAt)
  } catch { return null }
}
