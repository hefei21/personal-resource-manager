import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const runner = readFileSync(new URL('../scripts/run-worker-hidden.vbs', import.meta.url), 'utf8')

test('hidden scheduled-task runner refreshes Worker-owned User environment before Node starts', () => {
  assert.match(runner, /Environment\("USER"\)/)
  assert.match(runner, /Environment\("PROCESS"\)/)
  assert.match(runner, /UCase\(Left\(environmentName, 10\)\) = "PC_WORKER_"/)
  assert.match(runner, /processEnvironment\(environmentName\) = Mid\(environmentEntry, separatorIndex \+ 1\)/)
  assert.match(runner, /processEnvironment\("Path"\) = userPath & ";" & processEnvironment\("Path"\)/)
  assert.ok(runner.indexOf('Set userEnvironment') < runner.indexOf('shell.Run(command'))
})
