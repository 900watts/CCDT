// Convert a contenteditable HTML fragment back to markdown on save.
// Mirrors the small subset of md2html() that the editor emits, plus
// the formatting actions exposed by the ribbon (bold / italic /
// underline / colors / headings / lists / links / images).
//
// We deliberately keep this conservative: if we see an unknown tag or
// attribute, we drop to its textContent rather than fail — markdown
// stores plain text just fine.

const VOID = new Set(['br', 'hr', 'img', 'meta', 'link'])

function escMd(s) {
  return String(s ?? '').replace(/\r\n/g, '\n')
}

function inline(node, ctx) {
  if (!node) return ''
  if (node.nodeType === 3) { // text
    const t = escMd(node.nodeValue || '')
    return ctx.useBackslash
      ? t.replace(/(?<!\\)([_*`\[])/g, '\\$1')
      : t
  }
  if (node.nodeType !== 1) return ''
  const tag = node.tagName.toLowerCase()
  const inner = Array.from(node.childNodes).map((c) => inline(c, ctx)).join('')

  switch (tag) {
    case 'br':
      return '  \n' // markdown hard-break
    case 'b':
    case 'strong':
      return `**${inner}**`
    case 'i':
    case 'em':
      return `*${inner}*`
    case 'u':
      // no native markdown — use HTML span so it round-trips through md2html
      return `<u>${inner}</u>`
    case 's':
    case 'strike':
    case 'del':
      return `~~${inner}~~`
    case 'code':
      return `\`${inner.replace(/`/g, '\\`')}\``
    case 'a': {
      const href = node.getAttribute('href') || ''
      return href ? `[${inner}](${href})` : inner
    }
    case 'img': {
      const src = node.getAttribute('src') || ''
      const alt = node.getAttribute('alt') || ''
      return src ? `![${alt}](${src})` : ''
    }
    case 'span': {
      const color = node.style && node.style.color
      const family = node.style && node.style.fontFamily
      const size = node.style && node.style.fontSize
      if (color || family || size) {
        const parts = []
        if (color) parts.push(`color:${color}`)
        if (family) parts.push(`font-family:${family}`)
        if (size) parts.push(`font-size:${size}`)
        return `<span style="${parts.join(';')}">${inner}</span>`
      }
      return inner
    }
    case 'font': {
      const color = node.getAttribute('color')
      if (color) return `<span style="color:${color}">${inner}</span>`
      return inner
    }
    default:
      return inner
  }
}

function block(node, ctx) {
  if (!node) return ''
  if (node.nodeType === 3) {
    const t = escMd(node.nodeValue || '').trim()
    return t ? t + '\n\n' : ''
  }
  if (node.nodeType !== 1) return ''
  const tag = node.tagName.toLowerCase()
  const inner = Array.from(node.childNodes).map((c) => block(c, ctx)).join('')

  switch (tag) {
    case 'h1':
      return `# ${inline(node, { ...ctx, useBackslash: true })}\n\n`
    case 'h2':
      return `## ${inline(node, { ...ctx, useBackslash: true })}\n\n`
    case 'h3':
      return `### ${inline(node, { ...ctx, useBackslash: true })}\n\n`
    case 'h4':
      return `#### ${inline(node, { ...ctx, useBackslash: true })}\n\n`
    case 'h5':
      return `##### ${inline(node, { ...ctx, useBackslash: true })}\n\n`
    case 'h6':
      return `###### ${inline(node, { ...ctx, useBackslash: true })}\n\n`
    case 'p':
      return `${inline(node, { ...ctx, useBackslash: true })}\n\n`
    case 'div':
      // Treat as block if it has block-only children, else as inline span.
      return `${inline(node, ctx)}\n\n`
    case 'ul': {
      const items = Array.from(node.children)
        .filter((c) => c.tagName.toLowerCase() === 'li')
        .map((li) => `- ${inline(li, ctx).replace(/\n+/g, ' ')}`)
        .join('\n')
      return items ? items + '\n\n' : ''
    }
    case 'ol': {
      let i = 1
      const items = Array.from(node.children)
        .filter((c) => c.tagName.toLowerCase() === 'li')
        .map((li) => `${i++}. ${inline(li, ctx).replace(/\n+/g, ' ')}`)
        .join('\n')
      return items ? items + '\n\n' : ''
    }
    case 'blockquote': {
      const text = Array.from(node.childNodes).map((c) => block(c, ctx)).join('').trim()
      const quoted = text.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n')
      return quoted ? quoted + '\n\n' : ''
    }
    case 'pre': {
      return `\`\`\`\n${node.textContent.replace(/^\n+|\n+$/g, '')}\n\`\`\`\n\n`
    }
    case 'hr':
      return `\n---\n\n`
    case 'br':
      return '\n'
    case 'img': {
      const src = node.getAttribute('src') || ''
      const alt = node.getAttribute('alt') || ''
      return src ? `![${alt}](${src})\n\n` : ''
    }
    case 'script':
    case 'style':
    case 'meta':
    case 'link':
      return ''
    default:
      // Inline-ish tag — emit its inline children.
      return `${inline(node, ctx)}\n\n`
  }
}

export function htmlToMarkdown(html) {
  if (!html) return ''
  // Wrap so that a top-level <div> doesn't get treated as paragraph
  // and so that leading/trailing whitespace gets normalized.
  const tmp = document.createElement('div')
  tmp.innerHTML = String(html)
  // Strip the placeholder paragraph if the contenteditable is empty.
  if (!tmp.textContent.trim()) return ''
  const ctx = { useBackslash: false }
  let out = Array.from(tmp.childNodes).map((c) => block(c, ctx)).join('')
  // Collapse runs of >2 blank lines to exactly one.
  out = out.replace(/\n{3,}/g, '\n\n').trim()
  return out
}

export default htmlToMarkdown