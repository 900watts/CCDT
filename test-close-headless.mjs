import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const consoleLogs = []
page.on('console', msg => consoleLogs.push('[' + msg.type() + '] ' + msg.text()))

await page.goto('https://company-archive-terminal.vercel.app/')
await page.waitForSelector('.terminal', { timeout: 10000 })

const prompt = page.locator('.terminal__input input')
await prompt.fill('mail inbox')
await prompt.press('Enter')

await page.waitForSelector('.winbox.ccdt-win--mail', { timeout: 5000 })
console.log('Mailbox opened')

const closeBtn = page.locator('.winbox.ccdt-win--mail .wb-close')
const exists = await closeBtn.count()
console.log('Close button count:', exists)

const box = await closeBtn.first().boundingBox()
console.log('Close button box:', JSON.stringify(box))

await closeBtn.first().click({ force: true })
console.log('Clicked X')

await page.waitForTimeout(500)

const stillOpen = await page.locator('.winbox.ccdt-win--mail').count()
console.log('Mailbox count after click:', stillOpen)

console.log('--- console logs ---')
for (const l of consoleLogs) console.log(l)

await browser.close()
