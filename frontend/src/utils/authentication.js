export function authenticatedAssetUrl(path) {
  return new URL(path, window.location.origin).toString()
}
