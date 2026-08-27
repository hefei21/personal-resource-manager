import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CHILD_MODE = process.env.AUTH_CHANGE_PASSWORD_ROUTE_CHILD === '1'
const OLD_PASSWORD = 'RouteOldPass-2026!'
const NEW_PASSWORD = 'RouteNewPass-2026!'

async function listen(app) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  return server
}

async function close(server) {
  await new Promise(resolve => server.close(resolve))
}

async function runRouteScenario() {
  process.env.DATA_PATH = process.env.AUTH_CHANGE_PASSWORD_DATA_PATH
  process.env.DEFAULT_USERNAME = 'owner'
  process.env.DEFAULT_PASSWORD = OLD_PASSWORD
  process.env.SESSION_COOKIE_SECURE = 'false'
  process.env.NODE_ENV = 'test'

  const [
    { default: express },
    { default: cookieParser },
    { default: bcrypt },
    { getDatabase, initDatabase },
    { default: authRouter },
    { createOwnerSession, resolveOwnerSession }
  ] = await Promise.all([
    import('express'),
    import('cookie-parser'),
    import('bcryptjs'),
    import('../src/config/database.js'),
    import('../src/routes/auth.js'),
    import('../src/services/sessions.js')
  ])

  const db = initDatabase()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/auth', authRouter)
  const server = await listen(app)

  try {
    const { port } = server.address()
    const baseUrl = `http://127.0.0.1:${port}/api/auth`
    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: OLD_PASSWORD })
    })
    assert.equal(login.status, 200)
    const sessionCookie = login.headers.get('set-cookie')?.split(';')[0]
    assert.match(sessionCookie || '', /^pr_owner_session=/)

    const owner = db.prepare('SELECT id, username FROM users WHERE username = ?').get('owner')
    const secondarySession = createOwnerSession(db, owner, { remember: true })

    const wrongOldPassword = await fetch(`${baseUrl}/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ oldPassword: 'WrongOldPass-2026!', newPassword: NEW_PASSWORD })
    })
    assert.equal(wrongOldPassword.status, 401)
    assert.equal((await wrongOldPassword.json()).code, 'OWNER_OLD_PASSWORD_INVALID')
    assert.notEqual(resolveOwnerSession(db, secondarySession.token), null)

    const changed = await fetch(`${baseUrl}/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie },
      body: JSON.stringify({ oldPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD })
    })
    assert.equal(changed.status, 200)
    assert.deepEqual(await changed.json(), {
      message: '密码修改成功，请重新登录',
      reauthenticationRequired: true
    })
    assert.match(changed.headers.get('set-cookie') || '', /pr_owner_session=;/)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE revoked_at IS NULL').get().count, 0)
    assert.equal(resolveOwnerSession(db, secondarySession.token), null)
    assert.equal(
      await bcrypt.compare(NEW_PASSWORD, db.prepare('SELECT password FROM users WHERE id = ?').get(owner.id).password),
      true
    )

    writeFileSync(process.env.AUTH_CHANGE_PASSWORD_RESULT_PATH, JSON.stringify({ ok: true }))
  } finally {
    await close(server)
  }
}

function runChild(dataPath, resultPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        AUTH_CHANGE_PASSWORD_ROUTE_CHILD: '1',
        AUTH_CHANGE_PASSWORD_DATA_PATH: dataPath,
        AUTH_CHANGE_PASSWORD_RESULT_PATH: resultPath
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => resolve({ code, stdout, stderr }))
  })
}

if (CHILD_MODE) {
  await runRouteScenario()
} else {
  test('password change route separates business 401 and revokes every owner session', async () => {
    const runtimePath = mkdtempSync(join(tmpdir(), 'pr-manager-auth-route-'))
    const resultPath = join(runtimePath, 'result.json')
    try {
      const child = await runChild(runtimePath, resultPath)
      assert.equal(child.code, 0, `${child.stderr}\n${child.stdout}`)
      assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), { ok: true })
    } finally {
      rmSync(runtimePath, { recursive: true, force: true })
    }
  })
}
