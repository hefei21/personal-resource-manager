export const collectionStatuses = {
  game: [
    { value: 'unplayed', label: '未玩' },
    { value: 'playing', label: '在玩' },
    { value: 'played', label: '已玩' },
    { value: 'dropped', label: '搁置' },
    { value: 'wishlist', label: '想玩' },
  ],
  anime: [
    { value: 'none', label: '未标记' },
    { value: 'want_to_watch', label: '想看' },
    { value: 'watching', label: '在看' },
    { value: 'watched', label: '看过' },
    { value: 'on_hold', label: '搁置' },
  ],
}
export const collectionSorts = {
  game: [
    { value: 'playtime_2weeks', label: '最近两周游玩' },
    { value: 'playtime_forever', label: '累计时长' },
    { value: 'title', label: '名称' },
    { value: 'user_rating', label: '我的评分' },
  ],
  anime: [
    { value: 'updated_at', label: '最近更新' },
    { value: 'air_date', label: '放送日期' },
    { value: 'title', label: '名称' },
    { value: 'user_rating', label: '我的评分' },
    { value: 'rating', label: 'Bangumi 评分' },
  ],
}
export const collectionTitle = (item) => item.name_cn || item.title || '未命名'
export function playtimeLabel(minutes) {
  const value = Math.max(0, Number(minutes) || 0)
  if (!value) return '尚无游玩记录'
  if (value < 60) return `${Math.round(value)} 分钟`
  return `${(value / 60).toFixed(1)} 小时`
}
export function collectionCover(item, kind) {
  const data = item.cover_image_data
  if (
    typeof data === 'string' &&
    /^data:image\/(png|jpeg|webp|gif);base64,/i.test(data)
  )
    return data
  if (
    kind === 'game' &&
    Number.isSafeInteger(Number(item.steam_appid)) &&
    Number(item.steam_appid) > 0
  )
    return `/api/games/cover-proxy?appid=${item.steam_appid}&type=library`
  if (
    kind === 'anime' &&
    Number.isSafeInteger(Number(item.id)) &&
    Number(item.id) > 0
  )
    return `/api/anime/${item.id}/cover-image`
  try {
    const url = new URL(item.cover_image)
    if (
      url.protocol === 'https:' &&
      (url.hostname === 'bgm.tv' ||
        url.hostname.endsWith('.bgm.tv') ||
        url.hostname === 'bangumi.tv' ||
        url.hostname.endsWith('.bangumi.tv'))
    )
      return url.href
  } catch {
    /* Missing covers have a stable local placeholder. */
  }
  return ''
}
