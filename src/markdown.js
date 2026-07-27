// Tiny inline Markdown renderer (~70 lines, no deps).
// Used by the document editor's PREVIEW tab and by the dossier viewer's
// content field. Supports: # ## ### **bold** *italic* - lists > quotes
// [text](url) ![alt](url)

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inlineMd(s) {
  return s
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) =>
      `<img src="${url}" alt="${alt}" />`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) =>
      `<a href="${u}" target="_blank" rel="noopener">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

export function md2html(md) {
  if (!md) return ''
  const lines = String(md).split('\n')
  let out = ''
  let inList = false
  let inQuote = false
  const closeList = () => { if (inList) { out += '</ul>'; inList = false } }
  const closeQuote = () => { if (inQuote) { out += '</blockquote>'; inQuote = false } }
  for (const raw of lines) {
    const line = raw
    if (/^###\s/.test(line)) { closeList(); closeQuote(); out += `<h3>${inlineMd(esc(line.slice(4)))}</h3>`; continue }
    if (/^##\s/.test(line))  { closeList(); closeQuote(); out += `<h2>${inlineMd(esc(line.slice(3)))}</h2>`; continue }
    if (/^#\s/.test(line))   { closeList(); closeQuote(); out += `<h1>${inlineMd(esc(line.slice(2)))}</h1>`; continue }
    if (/^>\s/.test(line)) {
      closeList();
      if (!inQuote) { out += '<blockquote>'; inQuote = true }
      out += `<div>${inlineMd(esc(line.slice(2)))}</div>`
      continue
    }
    if (/^[-*]\s/.test(line)) {
      closeQuote();
      if (!inList) { out += '<ul>'; inList = true }
      out += `<li>${inlineMd(esc(line.slice(2)))}</li>`
      continue
    }
    if (line.trim() === '') { closeList(); closeQuote(); continue }
    closeList(); closeQuote()
    out += `<p>${inlineMd(esc(line))}</p>`
  }
  closeList(); closeQuote()
  return out
}