import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SCHEDULING_TIME_ZONE,
  resolveSchedulingTimeZone,
} from '../lib/config/scheduling.ts'

test('action scheduling uses one configurable IANA timezone', () => {
  assert.equal(resolveSchedulingTimeZone(), DEFAULT_SCHEDULING_TIME_ZONE)
  assert.equal(resolveSchedulingTimeZone('  America/New_York  '), 'America/New_York')
  assert.throws(() => resolveSchedulingTimeZone('Not/A_Time_Zone'), /Invalid EYE scheduling time zone/)
})
