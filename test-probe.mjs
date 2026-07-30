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

console.log('=== After page load ===')
console.log(await evalJS(`document.querySelector('.terminal__bar .ok')?.textContent || 'no session'`).then(r => r.result.value))
console.log(await evalJS(`document.querySelectorAll('.line').length + ' lines'`).then(r => r.result.value))

console.log('=== typing "help" ===')
await evalJS(`
  (() => {
    const inp = document.querySelector('.terminal__input input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(inp, 'help')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    return true
  })()
`)
await sleep(800)
const lines = await evalJS(`Array.from(document.querySelectorAll('.line')).slice(-15).map(l => l.textContent).join('\\n')`)
console.log(lines.result.value)

ws.close()
chrome.kill()
process.exit(0)
