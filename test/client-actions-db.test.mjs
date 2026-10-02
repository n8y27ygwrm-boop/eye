import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const migration = join(repo, 'supabase/migrations/20260925221611_client_actions_phase1.sql')
const authPrivilegeMigration = join(repo, 'supabase/migrations/20260925221829_client_actions_auth_uid_privilege.sql')
const identityBridgeMigration = join(repo, 'supabase/migrations/20260925222213_client_actions_identity_bridge.sql')
const bootstrap = join(repo, 'test/fixtures/client-actions-bootstrap.sql')
const assertions = join(repo, 'test/fixtures/client-actions-boundary.sql')

function run(binary, args, label) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 60_000 })
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`)
  assert.equal(result.status, 0, `${label} failed\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

function mustFail(binary, args, label) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 60_000 })
  assert.equal(result.error, undefined, `${label}: ${result.error?.message}`)
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`)
}

test('canonical action boundary: schema, commands, history, idempotency, RLS', () => {
  const root = mkdtempSync('/tmp/eye-action-db-')
  const data = join(root, 'data')
  const socket = join(root, 'socket')
  const log = join(root, 'postgres.log')
  const port = String(55000 + Math.floor(Math.random() * 1000))
  mkdirSync(socket)
  let started = false
  try {
    run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-instructions'], 'initdb')
    run('pg_ctl', ['-D', data, '-o', `-c listen_addresses= -c unix_socket_directories=${socket} -p ${port}`, '-l', log, '-w', 'start'], 'start PostgreSQL')
    started = true
    const psqlArgs = ['-X', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', port, '-U', 'postgres', '-d', 'postgres']
    mustFail('psql', [...psqlArgs, '-f', migration], 'reject missing legacy baseline')
    run('psql', [...psqlArgs, '-f', bootstrap], 'bootstrap verified legacy fixture')
    run('psql', [...psqlArgs, '-f', migration], 'apply action migration')
    run('psql', [...psqlArgs, '-f', authPrivilegeMigration], 'grant restricted auth.uid schema usage')
    run('psql', [...psqlArgs, '-f', identityBridgeMigration], 'install restricted identity bridge')
    const adminArgs = ['-X', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', port, '-U', 'eye_migration_admin', '-d', 'postgres']
    run('psql', [...adminArgs, '-f', assertions], 'exercise action boundary')
    const check = run('psql', [...adminArgs, '-Atc', "SELECT count(*) FROM public.client_action_events WHERE event_type = 'completed'"], 'verify stored completion')
    assert.equal(check.trim(), '1')
  } catch (error) {
    if (started) error.message += `\nPostgreSQL log:\n${readFileSync(log, 'utf8').slice(-4000)}`
    throw error
  } finally {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], 'stop PostgreSQL')
    rmSync(root, { recursive: true, force: true })
  }
})
