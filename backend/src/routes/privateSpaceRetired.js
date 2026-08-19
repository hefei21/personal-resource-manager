import express from 'express'

export const PRIVATE_SPACE_RETIRED_CODE = 'PRIVATE_SPACE_RETIRED'

const LEGACY_PRIVATE_SPACE_PATHS = Object.freeze([
  '/docs/special/verify',
  '/docs/special/inventory',
  '/docs/special/update-auth',
  '/docs/special/list',
  '/docs/special/list/:id',
  '/docs/special/upload',
  '/docs/special/view/:id',
  '/secure/upload',
  '/secure/download/:id',
  '/secure/files/:id'
])

export function createPrivateSpaceRetiredRouter() {
  const router = express.Router()
  router.all(LEGACY_PRIVATE_SPACE_PATHS, (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.status(410).json({ code: PRIVATE_SPACE_RETIRED_CODE })
  })
  return router
}

export default createPrivateSpaceRetiredRouter()
