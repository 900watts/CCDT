// Test the live mailbox X button: log in, open mailbox, click X.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import http from 'node:http'
import { request as httpsReq } from 'node:https'
import { readFileSync } from 'node:fs'

// Get credentials from .env
const env = Object.fromEntries(
  readFileSync('.env', 'utf8').split('\n')
    .map(l => /^([A-Z0-9_]+)=(.*)$/.exec(l))
    .filter(Boolean)
    .map(m => [m[1], m[2]])
)

// Sign in as the operator to get a JWT
const signinBody = JSON.stringify({
  email: 'suuupercharge900watts@hotmail.com',
  password: 'CcdtMailReply_2026'  // we reset this earlier for ccdt_assistant
})
// Try a different password
let loginToken = null
async function tryLogin(pw) {
  return new Promise(resolve => {
    const data = JSON.stringify({ email: 'suuupercharge900watts@hotmail.com', password: pw })
    const req = httpsReq({
      hostname: new URL(env.VITE_SUPABASE_URL).hostname,
      path: '/auth/v1/token?grant_type=password',
      method: 'POST',
      headers: {
        'apikey': env.VITE_SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }, res => {
      let body = ''
      res.on('data', d => body += d)
      res.on('end', () => {
        try {
          const j = JSON.parse(body)
          if (j.access_token) {
            console.log('Login OK with password')
            resolve(j.access_token)
          } else {
            console.log('Login failed:', body.slice(0, 200))
            resolve(null)
          }
        } catch { resolve(null) }
      })
    })
    req.on('error', e => { console.log('req error', e.message); resolve(null) })
    req.write(data)
    req.end()
  })
}

loginToken = await tryLogin('TestPass!2026')
if (!loginToken) {
  console.log('Could not log in. Test will run without auth (mailbox wont open).')
}

// Launch Chrome
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--remote-debugging-port=9223',
  '--user-data-dir=C:\\Users\\red_w\\AppData\\Local\\Temp\\chrome-test-' + Date.now(),
  'https://company-archive-terminal.vercel.app/'
], { detached: true })

await sleep(3000)

const tabs = await new Promise((resolve, reject) => {
  http.get('http://localhost:9223/json', res => {
    let body = ''
    res.on('data', d => body += d)
    res.on('end', () => resolve(JSON.parse(body)))
  }).on('error', reject)
})

const tab = tabs.find(t => t.url.includes('vercel.app'))
const ws = new WebSocket(tab.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))

let id = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const args = (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' ')
    console.log('[browser ' + m.params.type + ']', args)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    console.log('[EXCEPTION]', JSON.stringify(m.params.exceptionDetails))
  }
})

function send(method, params = {}) {
  return new Promise(resolve => {
    const myId = ++id
    pending.set(myId, resolve)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
}

await send('Page.enable')
await send('Runtime.enable')
await sleep(2000)

async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result
}

// If we got a token, inject it into localStorage so the SPA is auto-logged-in
if (loginToken) {
  await evalJS(`
    (() => {
      // Supabase stores session in localStorage under 'sb-' + projectRef + '-auth-token'
      const ref = new URL('${env.VITE_SUPABASE_URL}').hostname.split('.')[0]
      const key = 'sb-' + ref + '-auth-token'
      const session = {
        access_token: '${loginToken}',
        refresh_token: 'fake',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now()/1000) + 3600
      }
      localStorage.setItem(key, JSON.stringify(session))
      return 'logged in'
    })()
  `)
  await sleep(500)
  // Reload to pick up the session
  await send('Page.reload')
  await sleep(2000)
}

console.log('Step 1: type mail inbox')
await evalJS(`
  (() => {
    const inp = document.querySelector('.terminal__input input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(inp, 'mail')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    return true
  })()
`)

await sleep(1500)

const opened = await evalJS(`!!document.querySelector('.winbox.ccdt-win--mail')`)
console.log('Step 2: mailbox opened:', opened.result.value)

if (!opened.result.value) {
  console.log('Mailbox did not open. Last few terminal lines:')
  const lines = await evalJS(`Array.from(document.querySelectorAll('.line')).slice(-8).map(l => l.textContent).join('\\n')`)
  console.log(lines.result.value)
  ws.close()
  chrome.kill()
  process.exit(0)
}

const btnInfo = await evalJS(`
  (() => {
    const wb = document.querySelector('.winbox.ccdt-win--mail')
    const btn = wb.querySelector('.wb-close')
    const r = btn.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })()
`)
console.log('Step 3: close button at:', JSON.stringify(btnInfo.result.value))

const r = btnInfo.result.value
const cx = r.x + r.w / 2
const cy = r.y + r.h / 2

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
await sleep(50)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
await sleep(50)
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })

await sleep(500)

const stillOpen = await evalJS(`!!document.querySelector('.winbox.ccdt-win--mail')`)
const count = await evalJS(`document.querySelectorAll('.winbox').length`)
console.log('Step 4: mailbox still open:', stillOpen.result.value)
console.log('Step 5: total winboxes:', count.result.value)

if (!stillOpen.result.value) {
  console.log('SUCCESS: X button closes the mailbox.')
} else {
  console.log('FAILED: X button did not close the mailbox.')
}

ws.close()
chrome.kill()
process.exit(0)
