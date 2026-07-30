// Drive Chrome via DevTools Protocol to test the live mailbox X button.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import http from 'node:http'

const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--remote-debugging-port=9222',
  '--user-data-dir=C:\\Users\\red_w\\AppData\\Local\\Temp\\chrome-test-' + Date.now(),
  'https://company-archive-terminal.vercel.app/'
], { detached: true })

await sleep(3000)

const tabs = await new Promise((resolve, reject) => {
  http.get('http://localhost:9222/json', res => {
    let body = ''
    res.on('data', d => body += d)
    res.on('end', () => resolve(JSON.parse(body)))
  }).on('error', reject)
})

const tab = tabs.find(t => t.url.includes('vercel.app'))
if (!tab) {
  console.log('No tab found, tabs:', tabs.map(t => t.url))
  chrome.kill()
  process.exit(1)
}
console.log('Tab:', tab.url)

// Use native WebSocket
const ws = new WebSocket(tab.webSocketDebuggerUrl)
const messages = []
ws.addEventListener('message', e => messages.push(JSON.parse(e.data)))

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

console.log('Step 1: type mail inbox')
await evalJS(`
  (() => {
    const inp = document.querySelector('.terminal__input input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, 'mail inbox')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    return true
  })()
`)

await sleep(1500)

console.log('Step 2: check mailbox')
const opened = await evalJS(`!!document.querySelector('.winbox.ccdt-win--mail')`)
console.log('  opened:', opened.result.value)

console.log('Step 3: get close button box')
const btnInfo = await evalJS(`
  (() => {
    const wb = document.querySelector('.winbox.ccdt-win--mail')
    if (!wb) return null
    const btn = wb.querySelector('.wb-close')
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, z: getComputedStyle(wb).zIndex }
  })()
`)
console.log('  btn:', JSON.stringify(btnInfo.result.value))

if (!btnInfo.result.value) {
  console.log('No close button found!')
  chrome.kill()
  process.exit(1)
}

const r = btnInfo.result.value
const cx = r.x + r.w / 2
const cy = r.y + r.h / 2

console.log('Step 4: click X via CDP at', cx, cy)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
await sleep(100)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 })
await sleep(100)
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 })

await sleep(500)

console.log('Step 5: check if closed')
const stillOpen = await evalJS(`!!document.querySelector('.winbox.ccdt-win--mail')`)
console.log('  mailbox still open:', stillOpen.result.value)
const allWinboxes = await evalJS(`document.querySelectorAll('.winbox').length`)
console.log('  total winboxes:', allWinboxes.result.value)

ws.close()
chrome.kill()
process.exit(0)
