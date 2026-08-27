import test from 'node:test'
import assert from 'node:assert/strict'

import {
  UPLOAD_STATUSES,
  canTransitionUploadStatus,
  clampUploadPercentage,
  getUploadStatusLabel,
  isFileSizeExceeded,
  isUploadCancellable,
  isUploadRetryable,
  maxUploadSizeBytes,
  parseUploadResponse,
  transitionUploadStatus
} from '../src/utils/nativeUploadState.js'

test('upload statuses expose the supported state machine', () => {
  assert.deepEqual(UPLOAD_STATUSES, ['ready', 'uploading', 'success', 'error', 'cancelled'])

  assert.equal(canTransitionUploadStatus('ready', 'uploading'), true)
  assert.equal(canTransitionUploadStatus('uploading', 'success'), true)
  assert.equal(canTransitionUploadStatus('uploading', 'error'), true)
  assert.equal(canTransitionUploadStatus('uploading', 'cancelled'), true)
  assert.equal(canTransitionUploadStatus('error', 'uploading'), true)
  assert.equal(canTransitionUploadStatus('cancelled', 'uploading'), true)
  assert.equal(canTransitionUploadStatus('success', 'uploading'), false)
  assert.equal(canTransitionUploadStatus('ready', 'success'), false)
  assert.equal(canTransitionUploadStatus('unknown', 'ready'), false)
  assert.equal(canTransitionUploadStatus('error', 'error'), true)

  const file = { status: 'error' }
  assert.equal(transitionUploadStatus(file, 'uploading'), true)
  assert.equal(file.status, 'uploading')
  assert.equal(transitionUploadStatus(file, 'ready'), false)
  assert.equal(file.status, 'uploading')
})

test('only uploading items can cancel and failed items can retry', () => {
  assert.equal(isUploadCancellable('uploading'), true)
  assert.equal(isUploadCancellable('ready'), false)
  assert.equal(isUploadCancellable('success'), false)
  assert.equal(isUploadCancellable('error'), false)
  assert.equal(isUploadCancellable('cancelled'), false)

  assert.equal(isUploadRetryable('error'), true)
  assert.equal(isUploadRetryable('cancelled'), true)
  assert.equal(isUploadRetryable('ready'), false)
  assert.equal(isUploadRetryable('uploading'), false)
  assert.equal(isUploadRetryable('success'), false)
  assert.equal(getUploadStatusLabel('cancelled'), '已取消')
  assert.equal(getUploadStatusLabel('not-a-status'), '未知状态')
})

test('upload progress is rounded and clamped to the aria-safe range', () => {
  assert.equal(clampUploadPercentage(-10), 0)
  assert.equal(clampUploadPercentage(0), 0)
  assert.equal(clampUploadPercentage(12.6), 13)
  assert.equal(clampUploadPercentage(100), 100)
  assert.equal(clampUploadPercentage(180), 100)
  assert.equal(clampUploadPercentage('42.4'), 42)
  assert.equal(clampUploadPercentage(Number.NaN), 0)
  assert.equal(clampUploadPercentage('not-a-number'), 0)
})

test('max-size checks report only files above a positive limit', () => {
  assert.equal(maxUploadSizeBytes(2), 2 * 1024 * 1024)
  assert.equal(maxUploadSizeBytes(0), 0)
  assert.equal(maxUploadSizeBytes(-1), 0)
  assert.equal(maxUploadSizeBytes('invalid'), 0)

  assert.equal(isFileSizeExceeded(2 * 1024 * 1024, 2), false)
  assert.equal(isFileSizeExceeded(2 * 1024 * 1024 + 1, 2), true)
  assert.equal(isFileSizeExceeded(50 * 1024 * 1024, 0), false)
  assert.equal(isFileSizeExceeded(-1, 2), false)
})

test('successful non-JSON responses remain successful raw responses', () => {
  assert.deepEqual(parseUploadResponse('{"id":1}'), { id: 1 })
  assert.equal(parseUploadResponse('accepted'), 'accepted')
  assert.equal(parseUploadResponse(''), '')
  const objectResponse = { ok: true }
  assert.equal(parseUploadResponse(objectResponse), objectResponse)
})
