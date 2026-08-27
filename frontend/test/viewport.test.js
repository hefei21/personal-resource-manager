import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MOBILE_BREAKPOINT_PX,
  MOBILE_MEDIA_QUERY,
  viewportMatchesMobile
} from '../src/composables/useViewport.js'

test('mobile viewport contract uses an inclusive 768px media query', () => {
  assert.equal(MOBILE_BREAKPOINT_PX, 768)
  assert.equal(MOBILE_MEDIA_QUERY, '(max-width: 768px)')

  const queries = []
  const mobileWindow = {
    matchMedia(query) {
      queries.push(query)
      return { matches: true }
    }
  }

  assert.equal(viewportMatchesMobile(mobileWindow), true)
  assert.deepEqual(queries, [MOBILE_MEDIA_QUERY])
})

test('viewport matcher returns false when the media query does not match or is unavailable', () => {
  assert.equal(
    viewportMatchesMobile({ matchMedia: () => ({ matches: false }) }),
    false
  )
  assert.equal(viewportMatchesMobile({}), false)
  assert.equal(viewportMatchesMobile(null), false)
})
