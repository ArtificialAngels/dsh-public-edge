/**
 * dsh-public-edge —— DSH 自建公网访问插件
 *
 * 设置页里提供「公网访问」面板：一条命令启动/停止 Cloudflare 隧道，显示并复制
 * 带 token 的公网链接，附带二维码。不依赖任何第三方远程插件。
 *
 * 组成：
 *   1. 局域网桥：监听 0.0.0.0:<port>（默认 8787），转发到 DSH 本机 Web 端口，
 *      并把 Host 改写成回环地址、剥掉 Origin / Sec-Fetch-*，WebSocket 原样透传
 *      （DSH 的 Host 栅栏只放行回环/绑定地址）。
 *   2. 隧道守护：启动 cloudflared quick tunnel 指向这个桥，解析出
 *      https://<随机>.trycloudflare.com，并用 connection.authenticatedUrl
 *      拼出带 token 的链接。
 *   3. 控制接口（走 DSH 已鉴权的 /api 通道，只有 owner 能调）：
 *        GET  /api/dsh-public-edge/state
 *        POST /api/dsh-public-edge/control   { op: 'start' | 'stop' | 'restart' }
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'

export const name = 'public-edge'
export const inject = ['webServer', 'connection']

const STATE_PATH = '/api/dsh-public-edge/state'
const CONTROL_PATH = '/api/dsh-public-edge/control'
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
])
const TUNNEL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/

const DEFAULTS = {
  port: 8787,
  autoStart: true,
  /** 留空 = 自动：先用 ~/.dsh/dsh-public-edge/cloudflared[.exe]，没有再自动下载。 */
  cloudflaredPath: '',
  /** 下载 cloudflared 的镜像前缀（国内网络 GitHub 直连不通时用），按顺序尝试。 */
  downloadMirrors: ['', 'https://gh-proxy.com/', 'https://ghfast.top/']
}

const CLOUDFLARED_ASSET = (() => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  if (process.platform === 'win32') return { name: `cloudflared-windows-${arch}.exe`, tgz: false }
  if (process.platform === 'darwin') return { name: `cloudflared-darwin-${arch}.tgz`, tgz: true }
  return { name: `cloudflared-linux-${arch}`, tgz: false }
})()

function binaryName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

/** ~/.dsh/dsh-public-edge/cloudflared[.exe] */
function defaultBinaryPath() {
  return path.join(os.homedir(), '.dsh', 'dsh-public-edge', binaryName())
}

/** 跑一下 --version，能跑通就返回版本串，否则空串。 */
function probeBinary(file) {
  try {
    const result = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    if (result.status !== 0) return ''
    return String(result.stdout || result.stderr || '').trim()
  } catch {
    return ''
  }
}

/**
 * 下载 cloudflared 到默认位置。GitHub 直连不通时按 downloadMirrors 里的镜像依次重试。
 * Windows/Linux 是单文件；macOS 的 release 是 .tgz，用系统 tar 解出来。
 */
async function downloadCloudflared(log, mirrors) {
  const dir = path.dirname(defaultBinaryPath())
  fs.mkdirSync(dir, { recursive: true })
  const target = defaultBinaryPath()
  const temp = `${target}.download`
  const assetUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/${CLOUDFLARED_ASSET.name}`
  const failures = []

  for (const mirror of mirrors) {
    const base = String(mirror ?? '')
    if (base !== '' && !/^https?:\/\//i.test(base)) continue
    const url = base === '' ? assetUrl : `${base}${assetUrl}`
    try {
      log(`downloading cloudflared: ${url}`)
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length < 1_000_000) throw new Error(`文件太小（${bytes.length} 字节），可能被镜像/网络拦截`)

      if (CLOUDFLARED_ASSET.tgz) {
        fs.writeFileSync(temp, bytes)
        const extracted = spawnSync('tar', ['-xzf', temp, '-C', dir], { encoding: 'utf8', timeout: 60000 })
        if (extracted.status !== 0) throw new Error(`解压失败：${(extracted.stderr || '').trim()}`)
      } else {
        fs.writeFileSync(target, bytes)
      }
      fs.rmSync(temp, { force: true })
      if (process.platform !== 'win32') fs.chmodSync(target, 0o755)
      if (probeBinary(target) === '') throw new Error('下载的文件无法执行')
      log(`cloudflared downloaded (${bytes.length} bytes)`)
      return target
    } catch (error) {
      failures.push(`${base === '' ? 'GitHub' : base} → ${error?.message ?? error}`)
      try { fs.rmSync(temp, { force: true }) } catch {}
      log(`download failed: ${failures[failures.length - 1]}`)
    }
  }
  throw new Error(`cloudflared 下载失败（${failures.join('；')}）。请手动安装后填 cloudflaredPath。`)
}

/** 找到可用的 cloudflared：配置路径 > 默认位置 > 自动下载。 */
async function ensureCloudflared(options, log) {
  const configured = String(options.cloudflaredPath ?? '').trim()
  if (configured !== '') {
    if (!fs.existsSync(configured)) throw new Error(`cloudflaredPath 指向的文件不存在：${configured}`)
    return configured
  }
  const local = defaultBinaryPath()
  if (fs.existsSync(local) && probeBinary(local) !== '') return local
  log('cloudflared not found, downloading…')
  const mirrors = Array.isArray(options.downloadMirrors) && options.downloadMirrors.length > 0
    ? options.downloadMirrors
    : DEFAULTS.downloadMirrors
  await downloadCloudflared(log, mirrors)
  return local
}


function logger(ctx) {
  const api = ctx?.logger ?? ctx?.get?.('logger')
  return (line) => {
    const text = `[public-edge] ${line}`
    try {
      if (api?.info) api.info(text)
    } catch {}
    if (process.env.DSH_PUBLIC_EDGE_DEBUG === '1') console.log(text)
  }
}

/** 带 token 的访问链接；没有 connection 时退回裸地址。 */
function authenticated(connection, publicUrl) {
  if (typeof connection?.authenticatedUrl === 'function') {
    try {
      return connection.authenticatedUrl(`${publicUrl}/`)
    } catch {}
  }
  return `${publicUrl}/`
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 走隧道进来的 Host（公网域名），不是 IP、也不是 localhost。 */
function isRemoteHost(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const name = host.replace(/:\d+$/, '')
  if (name === '' || name === 'localhost') return false
  return !/^\[?[0-9a-f:.]+\]?$/.test(name)
}

/** 隧道是 HTTPS 终结的，给非 Secure 的 DSH cookie 补上 Secure，避免明文 http 带出凭证。 */
function hardenResponseHeaders(req, headers) {
  if (!isRemoteHost(req)) return
  const cookies = headers['set-cookie']
  if (cookies !== undefined) {
    const list = Array.isArray(cookies) ? cookies : [cookies]
    headers['set-cookie'] = list.map((value) => (/;\s*secure\b/i.test(value) ? value : `${value}; Secure`))
  }
  if (headers['strict-transport-security'] === undefined) {
    headers['strict-transport-security'] = 'max-age=2592000'
  }
}

function stripHeaders(req, targetHost, targetPort) {
  const out = Object.create(null)
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (lower === 'origin' || lower.startsWith('sec-fetch-')) continue
    if (lower === 'host' || HOP_BY_HOP.has(lower)) continue
    out[lower] = value
  }
  out.host = `${targetHost}:${targetPort}`
  return out
}

export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  const port = Number(options.port) || DEFAULTS.port
  const log = logger(ctx)
  const getWebServer = () => ctx.get?.('webServer') ?? ctx.webServer
  const getConnection = () => ctx.get?.('connection') ?? ctx.connection

  const state = {
    running: false,
    starting: false,
    tunnelUrl: '',
    link: '',
    error: '',
    startedAt: 0,
    binary: '',
    bridge: null,
    pair: null,
    child: null,
    retry: null
  }

  const target = () => {
    const ws = getWebServer()
    const value = Number(ws?.port)
    return Number.isInteger(value) && value > 0 ? value : 0
  }

  function json(status, payload) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    })
  }

  function snapshot() {
    return {
      ok: state.error === '',
      running: state.running,
      starting: state.starting,
      tunnelUrl: state.tunnelUrl,
      link: state.link,
      bridgePort: port,
      pairUrl: `http://127.0.0.1:${port + 1}/pair`,
      binary: state.binary,
      error: state.error,
      startedAt: state.startedAt
    }
  }

  // ---------------------------------------------------------------- 局域网桥
  async function pairPage() {
    const link = state.link || `${'http://127.0.0.1:' + port}/?token=`
    let svg = ''
    try {
      svg = await QRCode.toString(link, { type: 'svg', margin: 1, width: 260 })
    } catch {}
    const escape = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>配对 · DSH 公网访问</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0f14;color:#e5e7eb;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.card{background:#141b23;border:1px solid #24303d;border-radius:18px;padding:22px;max-width:420px;width:calc(100% - 32px);text-align:center}
h1{font-size:17px;margin:0 0 4px}p{color:#94a3b8;font-size:12px;margin:0 0 14px;line-height:1.6}
.qr{background:#fff;border-radius:12px;padding:10px;display:inline-block}.qr svg{width:240px;height:240px}
code{display:block;word-break:break-all;background:#0b0f14;border:1px solid #24303d;border-radius:10px;padding:10px;font-size:12px;margin:14px 0 0;color:#cbd5e1}
.b{display:none}</style></head><body><main class="card">
<h1>DSH 公网访问</h1><p>手机浏览器打开下面的链接，或扫码。首次打开后 cookie 有效 30 天。</p>
<div class="qr">${svg}</div><code>${escape(link)}</code></main></body></html>`
  }

  function handleHttp(req, res) {
    const pathname = (req.url ?? '/').split('?')[0]
    if (pathname === '/pair' || pathname === '/pair/') {
      // 二维码页带 token，只在本机回环端口（port+1）提供；桥（含隧道流量）一律拒绝，
      // 防止任何人拿到隧道地址后从 /pair 读到 token。
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`配对页只在本机提供：http://127.0.0.1:${port + 1}/pair\n`)
      return
    }

    const targetPort = target()
    if (targetPort === 0) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('DSH web server is not ready\n')
      return
    }
    const upstream = http.request({
      host: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: stripHeaders(req, '127.0.0.1', targetPort)
    }, (answer) => {
      const out = Object.create(null)
      for (const [header, value] of Object.entries(answer.headers)) {
        if (HOP_BY_HOP.has(header.toLowerCase())) continue
        out[header] = value
      }
      hardenResponseHeaders(req, out)
      res.writeHead(answer.statusCode ?? 502, out)
      answer.pipe(res)
    })
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      res.end(`dsh-public-edge: upstream unavailable: ${error.message}\n`)
    })
    req.pipe(upstream)
  }

  function handleUpgrade(req, socket, head) {
    const targetPort = target()
    if (targetPort === 0) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n')
      return
    }
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    const headers = stripHeaders(req, '127.0.0.1', targetPort)
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    for (const [header, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${header}: ${item}`)
      else lines.push(`${header}: ${value}`)
    }
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head?.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    const teardown = () => {
      socket.destroy()
      upstream.destroy()
    }
    upstream.on('error', teardown)
    socket.on('error', teardown)
    socket.on('close', teardown)
  }

  function openBridge() {
    return new Promise((resolve, reject) => {
      const server = http.createServer(handleHttp)
      server.on('upgrade', handleUpgrade)
      server.once('error', reject)
      server.listen(port, '0.0.0.0', () => {
        server.off('error', reject)
        log(`bridge listening on 0.0.0.0:${port}`)
        resolve(server)
      })
    })
  }

  function closeBridge() {
    const server = state.bridge
    state.bridge = null
    if (server === null) return Promise.resolve()
    return new Promise((resolve) => {
      try {
        server.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  // ---------------------------------------------------------------- 本机二维码页（只绑回环，不经过隧道）
  const pairPort = port + 1
  const pairUrl = `http://127.0.0.1:${pairPort}/pair`

  function handlePair(req, res) {
    const pathname = (req.url ?? '/').split('?')[0]
    if (pathname !== '/' && pathname !== '/pair' && pathname !== '/pair/') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found\n')
      return
    }
    pairPage().then((html) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    }).catch(() => {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('pair page failed')
    })
  }

  function openPairServer() {
    return new Promise((resolve, reject) => {
      const server = http.createServer(handlePair)
      server.once('error', reject)
      server.listen(pairPort, '127.0.0.1', () => {
        server.off('error', reject)
        log(`local pair page: ${pairUrl}`)
        resolve(server)
      })
    })
  }

  function closePairServer() {
    const server = state.pair
    state.pair = null
    if (server === null) return Promise.resolve()
    return new Promise((resolve) => {
      try {
        server.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  // ---------------------------------------------------------------- 隧道
  function handleTunnelData(chunk) {
    const text = chunk.toString()
    const match = TUNNEL_RE.exec(text)
    if (match === null || match[0] === state.tunnelUrl) return
    state.tunnelUrl = match[0]
    state.link = authenticated(getConnection(), match[0])
    state.error = ''
    log(`tunnel url: ${state.tunnelUrl}`)
  }

  function spawnTunnel() {
    return new Promise((resolve, reject) => {
      let settled = false
      const child = spawn(state.binary, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      state.child = child
      const onData = (chunk) => {
        handleTunnelData(chunk)
        if (!settled && state.tunnelUrl !== '') {
          settled = true
          resolve()
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', (error) => {
        state.error = `cloudflared 启动失败：${error.message}`
        log(state.error)
        if (!settled) {
          settled = true
          reject(error)
        }
      })
      child.on('exit', (code) => {
        log(`cloudflared exited (${code})`)
        state.child = null
        if (!settled) {
          settled = true
          reject(new Error(`cloudflared exited with ${code}`))
        }
        if (state.running) {
          state.error = `隧道断开（code ${code}），5 秒后重试`
          scheduleRestart()
        }
      })
    })
  }

  function scheduleRestart() {
    if (state.retry !== null) return
    state.retry = setTimeout(async () => {
      state.retry = null
      if (!state.running) return
      try {
        await closeTunnel()
        await startTunnelOnly()
      } catch (error) {
        state.error = error?.message ?? String(error)
        log(`tunnel restart failed: ${state.error}`)
        scheduleRestart()
      }
    }, 5000)
  }

  async function startTunnelOnly() {
    state.tunnelUrl = ''
    state.link = ''
    await spawnTunnel()
  }

  async function closeTunnel() {
    const child = state.child
    state.child = null
    if (child !== null) {
      try { child.kill() } catch {}
    }
  }

  // ---------------------------------------------------------------- 生命周期
  async function waitForWebPort() {
    for (let i = 0; i < 240; i += 1) {
      if (target() > 0) return target()
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('DSH web server 端口未就绪')
  }

  async function start() {
    if (state.running || state.starting) return snapshot()
    state.starting = true
    state.error = ''
    try {
      await waitForWebPort()
      if (state.bridge === null) state.bridge = await openBridge()
      if (state.pair === null) state.pair = await openPairServer()
      if (state.binary === '') state.binary = await ensureCloudflared(options, log)
      await startTunnelOnly()
      state.running = true
      state.startedAt = Date.now()
      log('public edge started')
    } catch (error) {
      state.error = error?.message ?? String(error)
      state.running = false
      log(`start failed: ${state.error}`)
      await closeTunnel()
      await closeBridge()
      await closePairServer()
    } finally {
      state.starting = false
    }
    return snapshot()
  }

  async function stop() {
    state.running = false
    if (state.retry !== null) {
      clearTimeout(state.retry)
      state.retry = null
    }
    await closeTunnel()
    await closeBridge()
    await closePairServer()
    state.tunnelUrl = ''
    state.link = ''
    state.startedAt = 0
    log('public edge stopped')
    return snapshot()
  }

  async function restart() {
    await stop()
    return start()
  }

  // ---------------------------------------------------------------- 控制接口
  const disposers = []
  try {
    const connection = getConnection()
    const register = connection?.fetch?.register
    if (typeof register !== 'function') {
      log('connection.fetch.register 不可用，设置面板将无法控制')
    } else {
      disposers.push(register.call(connection.fetch, {
        path: STATE_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          const data = snapshot()
          if (data.link !== '') {
            try {
              data.qrSvg = await QRCode.toString(data.link, { type: 'svg', margin: 1, width: 220 })
            } catch {}
          }
          return json(200, data)
        }
      }))
      disposers.push(register.call(connection.fetch, {
        path: CONTROL_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body = {}
          try { body = await request.json() } catch {}
          const op = String(body?.op ?? '')
          try {
            if (op === 'start') return json(200, await start())
            if (op === 'stop') return json(200, await stop())
            if (op === 'restart') return json(200, await restart())
            return json(400, { ok: false, error: `unknown op: ${op}` })
          } catch (error) {
            return json(500, { ok: false, error: error?.message ?? String(error), ...snapshot() })
          }
        }
      }))
      log('control routes registered')
    }
  } catch (error) {
    state.error = `控制接口注册失败：${error?.message ?? error}`
    log(state.error)
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch {}
      }
      void stop()
    }, 'public-edge: lifecycle')
  }

  if (options.autoStart !== false) {
    setTimeout(() => { void start() }, 800)
  }

  return snapshot
}

export default { name, inject, apply }
