import http from 'node:http'
import fs from 'node:fs'
import { apply } from '../lib/index.js'

const routes = new Map()
const mockCtx = {
  logger: { info: (line) => console.log(line) },
  get(name) {
    if (name === 'webServer') return { port: 3080 }
    if (name === 'connection') {
      return {
        authenticatedUrl: (base) => base + '?token=SMOKE',
        fetch: {
          register(route) {
            if (routes.has(route.path)) throw new Error('duplicate ' + route.path)
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          }
        }
      }
    }
    return undefined
  },
  effect(fn) {
    fn()
  }
}

const PORT = 8877
const stop = apply(mockCtx, {
  port: PORT,
  autoStart: true,
  cloudflaredPath: 'E:/DSH-Portable/workspace/remote-public/cloudflared.exe'
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) process.exitCode = 1
}

function rawRequest({ port, path, host, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: host ? { host } : {} },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

function dshToken() {
  try {
    const log = fs.readFileSync('E:/DSH-Portable/data/logs/dsh.stdout.log', 'utf8')
    const matches = log.match(/dsh web: http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)/g) ?? []
    const last = matches[matches.length - 1] ?? ''
    return /token=([A-Za-z0-9_-]+)$/.exec(last)?.[1] ?? ''
  } catch {
    return ''
  }
}

try {
  let state = null
  for (let i = 0; i < 80; i += 1) {
    state = stop()
    if (state.tunnelUrl) break
    await sleep(500)
  }
  check('tunnel url', Boolean(state?.tunnelUrl), state?.tunnelUrl ?? '')
  check('link has token', String(state?.link ?? '').includes('token=SMOKE'))
  check('pairUrl in state', String(state?.pairUrl ?? '').includes('127.0.0.1:8878/pair'), state?.pairUrl ?? '')

  const root = await rawRequest({ port: PORT, path: '/' })
  check('bridge proxies DSH (401)', root.status === 401, String(root.status))

  const leak = await rawRequest({ port: PORT, path: '/pair' })
  check('bridge blocks /pair', leak.status === 404, String(leak.status))

  const leakForged = await rawRequest({ port: PORT, path: '/pair', host: 'evil.example.com' })
  check('bridge blocks /pair (forged host)', leakForged.status === 404, String(leakForged.status))

  const localPair = await rawRequest({ port: PORT + 1, path: '/pair' })
  check('local pair page', localPair.status === 200 && localPair.body.includes('<svg'), String(localPair.status))

  const stateRoute = routes.get('/api/dsh-public-edge/state')
  const stateJson = await (await stateRoute.fetch(new Request('http://dsh.invalid/api/dsh-public-edge/state'))).json()
  check('state json', stateJson.ok === true && Boolean(stateJson.tunnelUrl))
  check('state has qr svg', String(stateJson.qrSvg ?? '').includes('<svg'))

  const token = dshToken()
  if (token) {
    const remote = await rawRequest({ port: PORT, path: `/?token=${token}`, host: 'example.com' })
    const remoteCookie = String(remote.headers['set-cookie'] ?? '')
    check('remote login issues Secure cookie', /;\s*secure/i.test(remoteCookie), String(remote.status))
    check('remote login sets HSTS', Boolean(remote.headers['strict-transport-security']))
    const local = await rawRequest({ port: PORT, path: `/?token=${token}`, host: '127.0.0.1:8877' })
    const localCookie = String(local.headers['set-cookie'] ?? '')
    check('local login keeps cookie usable (no Secure)', !/;\s*secure/i.test(localCookie), String(local.status))
  } else {
    console.log('SKIP  cookie hardening (no DSH token in log)')
  }

  const control = routes.get('/api/dsh-public-edge/control')
  const stopped = await (await control.fetch(new Request('http://dsh.invalid/api/dsh-public-edge/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'stop' })
  }))).json()
  check('stop works', stopped.running === false)
  const pairAfterStop = await rawRequest({ port: PORT + 1, path: '/pair' }).catch(() => ({ status: 0 }))
  check('pair page closed after stop', pairAfterStop.status === 0, String(pairAfterStop.status))

  const started = await (await control.fetch(new Request('http://dsh.invalid/api/dsh-public-edge/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'start' })
  }))).json()
  check('start works', started.running === true && Boolean(started.tunnelUrl))
} finally {
  await stop()
  await sleep(500)
}
