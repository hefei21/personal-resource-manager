export function getDemoAuthorizationHeaders() {
  const token = sessionStorage.getItem('demoToken')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export function authenticatedAssetUrl(path) {
  const url = new URL(path, window.location.origin)
  const demoToken = sessionStorage.getItem('demoToken')
  if (demoToken) url.searchParams.set('token', demoToken)
  return url.toString()
}
