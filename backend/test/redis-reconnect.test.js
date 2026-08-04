import test from 'node:test'
import assert from 'node:assert/strict'
import { redisReconnectDelay } from '../src/utils/redis.js'

test('Redis reconnect strategy never permanently gives up', () => {
  for (const retries of [0, 1, 5, 6, 20, 1000]) {
    const delay = redisReconnectDelay(retries)
    assert.equal(typeof delay, 'number')
    assert.equal(delay > 0, true)
    assert.equal(delay <= 10000, true)
  }
})

test('Redis reconnect strategy backs off and caps at ten seconds', () => {
  assert.equal(redisReconnectDelay(0), 250)
  assert.equal(redisReconnectDelay(1), 500)
  assert.equal(redisReconnectDelay(5), 8000)
  assert.equal(redisReconnectDelay(6), 10000)
  assert.equal(redisReconnectDelay(100), 10000)
})
