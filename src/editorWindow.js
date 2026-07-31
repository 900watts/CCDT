// Document editor — opens a Word-2026-style WinBox window.
// - Ribbon with font name + size, bold/italic/underline, color, headings,
//   lists, quote, link, photo buttons.
// - A large white "page" area as a contenteditable div so the user can
//   click text and apply formatting that survives save.
// - SAVE button opens a modal with the archive's metadata (number, title,
//   classification, department, tags, photos). Confirming it persists
//   the record and closes both the modal and the editor.
//
// On save, the contenteditable HTML is serialized back to markdown so
// the rest of the app stays in markdown format.
import WinBox from 'winbox/src/js/winbox.js'
import 'winbox/dist/css/winbox.min.css'

import { insertRecord, updateRecord } from './terminal/commands'
import { md2html } from './markdown'
import { htmlToMarkdown } from './htmlToMarkdown'
import { nextZIndex, registerWindow, focusIfExists } from './windowStack'

const CLASSIFICATIONS = ['PUBLIC', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET']
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB

// Common font/size choices. Word-2026 ships Calibri, Times, Consolas,
// Courier New as standard fonts.
const FONTS = [
  'Calibri',
  'Cambria',
  'Times New Roman',
  'Consolas',
  'Courier New',
  'Arial',
  'Georgia'
]
const SIZES = ['1', '2', '3', '4', '5', '6', '7'] // HTML <font size=1..7>

// Common Word-style colors. Hex strings; applied via document.execCommand.
const COLORS = [
  '#000000', '#1a1a1a', '#4a4a4a', '#808080',
  '#c00000', '#ed7d31', '#ffc000', '#70ad47',
  '#00b050', '#0070c0', '#2e75b6', '#7030a0'
]

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = reject
    fr.readAsDataURL(file)
  })
}

async function uploadPhoto(file, ctx) {
  if (ctx.isConfigured && ctx.supabase) {
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '')
    const path = `${ctx.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { error } = await ctx.supabase.storage.from('archive-photos').upload(path, file, {
      cacheControl: '3600', upsert: false, contentType: file.type
    })
    if (error) throw new Error(error.message)
    const { data: pub } = ctx.supabase.storage.from('archive-photos').getPublicUrl(path)
    return { url: pub.publicUrl, name: file.name }
  }
  const dataUrl = await fileToDataUrl(file)
  return { url: dataUrl, name: file.name }
}

export function openEditorWindow(ctx, prefill = {}, onSaved) {
  const editing = !!prefill._editing
  const dedupKey = editing ? 'editor:' + (prefill.archive_number || '') : null
  if (dedupKey && focusIfExists(dedupKey)) return

  const titleText = editing ? 'CCDT — EDIT DOCUMENT' : 'CCDT — NEW DOCUMENT'

  // Compose the Word-2026-styled editor surface. The "page" is a
  // contenteditable div, so the user can click text and apply bold /
  // italic / underline / color directly (execCommand preserves ranges
  // of selection, just like real Word).
  const html = `
    <div class="ccdt-edit ccdt-edit--word">
      <!-- Ribbon: file / new-document row -->
      <div class="ccdt-edit__ribbon">
        <div class="ccdt-edit__ribbon-row ccdt-edit__ribbon-row--file">
          <span class="ccdt-edit__ribbon-title">${esc(titleText)}</span>
          <button class="ccdt-edit__btn ccdt-edit__btn--primary" id="ccdt-e-save">SAVE</button>
          <button class="ccdt-edit__btn ccdt-edit__btn--ghost" id="ccdt-e-cancel">CANCEL</button>
        </div>
        <!-- Ribbon: formatting row -->
        <div class="ccdt-edit__ribbon-row ccdt-edit__ribbon-row--fmt">
          <select class="ccdt-edit__select" id="ccdt-e-font" title="Font">
            ${FONTS.map((f) => `<option value="${f}" ${(prefill.font || 'Calibri') === f ? 'selected' : ''}>${f}</option>`).join('')}
          </select>
          <select class="ccdt-edit__select ccdt-edit__select--sm" id="ccdt-e-size" title="Font size">
            ${SIZES.map((s) => `<option value="${s}" ${String(prefill.size || '3') === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <div class="ccdt-edit__divider"></div>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="bold" title="Bold (Ctrl+B)"><b>B</b></button>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="italic" title="Italic (Ctrl+I)"><i>I</i></button>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="underline" title="Underline (Ctrl+U)"><u>U</u></button>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="strikeThrough" title="Strikethrough"><s>S</s></button>
          <div class="ccdt-edit__divider"></div>
          <div class="ccdt-edit__color" title="Text color">
            <span class="ccdt-edit__color-label">A</span>
            <input type="color" id="ccdt-e-color" value="${esc(prefill.color || '#000000')}" />
          </div>
          <div class="ccdt-edit__color" title="Highlight color">
            <span class="ccdt-edit__color-label" style="background:#fff7c0">A</span>
            <input type="color" id="ccdt-e-hilite" value="${esc(prefill.hilite || '#fff7c0')}" />
          </div>
          <div class="ccdt-edit__divider"></div>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="h1" title="Heading 1">H1</button>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="h2" title="Heading 2">H2</button>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="h3" title="Heading 3">H3</button>
          <div class="ccdt-edit__divider"></div>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="justifyLeft" title="Align left">⬅</button>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="justifyCenter" title="Center">⬌</button>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="justifyRight" title="Align right">➡</button>
          <div class="ccdt-edit__divider"></div>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="insertUnorderedList" title="Bullet list">•</button>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="insertOrderedList" title="Numbered list">1.</button>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="formatBlock" data-arg="blockquote" title="Quote">❝</button>
          <div class="ccdt-edit__divider"></div>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="link" title="Insert link">🔗</button>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="photo" title="Insert photo">📷</button>
          <button class="ccdt-edit__btn ccdt-edit__btn--icon" data-act="hr" title="Horizontal rule">—</button>
          <input type="file" id="ccdt-e-file" accept="image/*" multiple style="display:none" />
        </div>
      </div>

      <!-- Page: large white contenteditable area -->
      <div class="ccdt-edit__page" id="ccdt-e-page">
        <div class="ccdt-edit__paper" id="ccdt-e-paper"
             contenteditable="true" spellcheck="true"
             data-placeholder="Start typing your document here.&#10;&#10;Tip: use the toolbar above for fonts, sizes, bold / italic / underline, headings, lists, links, and photos. Your formatting is preserved when you save."></div>
        <div id="ccdt-e-drop" class="ccdt-edit__drop">drop photos here</div>
      </div>

      <!-- Bottom: live markdown preview + photo strip -->
      <div class="ccdt-edit__bottom">
        <div class="ccdt-edit__status" id="ccdt-e-status">${editing ? 'editing existing record' : 'ready'}</div>
        <div class="ccdt-edit__photos" id="ccdt-e-photos"></div>
      </div>
    </div>`

  const wb = new WinBox({
    title: titleText,
    class: 'ccdt-win ccdt-win--edit',
    html,
    background: '#f3f3f3',
    border: '2px solid #11331f',
    x: 'center', y: 'center',
    width: '1080px',
    height: '92%',
    minheight: 560,
    index: nextZIndex()
  })
  if (dedupKey) registerWindow(dedupKey, wb)

  const $ = (s) => wb.body.querySelector(s)
  const $$ = (s) => Array.from(wb.body.querySelectorAll(s))
  const photos = prefill.photos ? prefill.photos.map((p) => ({ ...p })) : []

  // Seed the editable paper with the prefilled content (or markdown→HTML).
  const paper = $('#ccdt-e-paper')
  if (prefill.content && prefill.content.trim()) {
    paper.innerHTML = md2html(prefill.content) || ''
  } else {
    paper.innerHTML = ''
  }
  // If we're editing and we have a font/size pref, apply it to the whole
  // document so the saved HTML preserves it.
  if (editing && prefill.font) {
    paper.style.fontFamily = prefill.font
  }

  // Set initial placeholder behaviour — contenteditable doesn't honour the
  // placeholder attribute, so we manage it manually via a :empty style
  // hook in the CSS. Nothing to wire up here.

  const setStatus = (msg, color) => {
    const el = $('#ccdt-e-status')
    el.textContent = msg
    el.style.color = color || '#666'
  }

  // ── Toolbar actions ──
  // execCommand is deprecated but still works in Chromium and is the only
  // zero-dep way to do Word-style inline formatting. We call it with
  // explicit arguments for everything that needs them.
  const cmd = (a, arg) => {
    paper.focus()
    try { document.execCommand(a, false, arg) } catch { /* noop */ }
  }

  $$('#ccdt-e-save, #ccdt-e-cancel, #ccdt-e-font, #ccdt-e-size, #ccdt-e-color, #ccdt-e-hilite, .ccdt-edit__ribbon button[data-act]')
    .forEach((el) => {
      // Skip here — these are wired individually below for clarity.
    })

  // Font + size dropdowns apply to the current selection (or whole doc).
  $('#ccdt-e-font').addEventListener('change', (e) => {
    cmd('fontName', e.target.value)
    paper.style.fontFamily = e.target.value
  })
  $('#ccdt-e-size').addEventListener('change', (e) => {
    cmd('fontSize', e.target.value)
  })
  $('#ccdt-e-color').addEventListener('input', (e) => {
    cmd('foreColor', e.target.value)
  })
  $('#ccdt-e-hilite').addEventListener('input', (e) => {
    cmd('hiliteColor', e.target.value)
  })

  // Toolbar buttons.
  $$('.ccdt-edit__ribbon button[data-act]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => {
      // Prevent the editor from losing selection when clicking a button.
      e.preventDefault()
    })
    btn.addEventListener('click', () => {
      const a = btn.dataset.act
      const arg = btn.dataset.arg
      switch (a) {
        case 'bold':
        case 'italic':
        case 'underline':
        case 'strikeThrough':
        case 'justifyLeft':
        case 'justifyCenter':
        case 'justifyRight':
        case 'insertUnorderedList':
        case 'insertOrderedList':
          cmd(a)
          break
        case 'h1': cmd('formatBlock', 'H1'); break
        case 'h2': cmd('formatBlock', 'H2'); break
        case 'h3': cmd('formatBlock', 'H3'); break
        case 'formatBlock':
          cmd(a, arg ? `<${arg}>` : 'BLOCKQUOTE')
          break
        case 'hr':
          cmd('insertHorizontalRule')
          break
        case 'link': {
          const url = prompt('URL?', 'https://')
          if (!url) return
          cmd('createLink', url)
          break
        }
        case 'photo':
          $('#ccdt-e-file').click()
          break
      }
    })
  })

  // Keyboard shortcuts (Ctrl+B / I / U).
  paper.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return
    const k = e.key.toLowerCase()
    if (k === 'b') { e.preventDefault(); cmd('bold') }
    else if (k === 'i') { e.preventDefault(); cmd('italic') }
    else if (k === 'u') { e.preventDefault(); cmd('underline') }
    else if (k === 's') { e.preventDefault(); openSaveDialog() }
  })

  // ── Photo handling (drag-drop + 📷 button) ──
  const addPhoto = async (file) => {
    if (!file) return
    if (file.size > MAX_FILE_BYTES) { setStatus('file too large (max 10 MB)', '#c00000'); return }
    if (!file.type.startsWith('image/')) { setStatus('not an image', '#c00000'); return }
    setStatus('uploading ' + file.name + '…', '#b07b00')
    try {
      const ph = await uploadPhoto(file, ctx)
      photos.push(ph)
      renderPhotos()
      // Insert markdown image syntax at the current cursor position.
      paper.focus()
      cmd('insertHTML', `<img src="${ph.url}" alt="${esc(ph.name)}" />`)
      setStatus('photo inserted', '#00723f')
    } catch (e) {
      setStatus('upload failed: ' + e.message, '#c00000')
    }
  }

  const renderPhotos = () => {
    const box = $('#ccdt-e-photos')
    if (!photos.length) { box.innerHTML = ''; return }
    box.innerHTML = '<div class="ccdt-edit__photos-label">ATTACHED PHOTOS (' + photos.length + ')</div>' +
      photos.map((p, i) => `
        <div class="ccdt-edit__photo">
          <img src="${esc(p.url)}" alt="${esc(p.name)}" />
          <div class="ccdt-edit__photo-name">${esc(p.name)}</div>
          <button data-rm="${i}" class="ccdt-edit__photo-rm" title="remove">×</button>
        </div>`).join('')
    box.querySelectorAll('button[data-rm]').forEach((b) => {
      b.addEventListener('click', () => {
        const i = parseInt(b.dataset.rm, 10)
        photos.splice(i, 1)
        renderPhotos()
      })
    })
  }

  $('#ccdt-e-file').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || [])
    for (const f of files) await addPhoto(f)
    e.target.value = ''
  })

  // Drag-drop overlay.
  const drop = $('#ccdt-e-drop')
  let dragDepth = 0
  const showDrop = (yes) => { drop.style.display = yes ? 'flex' : 'none' }
  paper.addEventListener('dragenter', (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('files')) return
    e.preventDefault()
    dragDepth++
    showDrop(true)
  })
  paper.addEventListener('dragover', (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('files')) return
    e.preventDefault()
  })
  paper.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) showDrop(false)
  })
  paper.addEventListener('drop', async (e) => {
    e.preventDefault()
    dragDepth = 0
    showDrop(false)
    const files = Array.from(e.dataTransfer?.files || [])
    for (const f of files) if (f.type.startsWith('image/')) await addPhoto(f)
  })
  document.addEventListener('dragend', () => { dragDepth = 0; showDrop(false) })

  // ── Save dialog (modal overlay, mirrors Word 2026 "Save As") ──
  const dialogHtml = `
    <div class="ccdt-save" id="ccdt-save" hidden>
      <div class="ccdt-save__backdrop"></div>
      <div class="ccdt-save__panel" role="dialog" aria-modal="true" aria-labelledby="ccdt-save-title">
        <div class="ccdt-save__title" id="ccdt-save-title">${editing ? 'UPDATE ARCHIVE' : 'SAVE NEW ARCHIVE'}</div>
        <label class="ccdt-save__lbl">Archive Number
          <input class="ccdt-save__inp" id="ccdt-save-num" value="${esc(prefill.archive_number || '')}" />
        </label>
        <label class="ccdt-save__lbl">Title
          <input class="ccdt-save__inp" id="ccdt-save-title-inp" value="${esc(prefill.title || '')}" />
        </label>
        <label class="ccdt-save__lbl">Classification
          <select class="ccdt-save__inp" id="ccdt-save-cls">
            ${CLASSIFICATIONS.map((c) => `<option value="${c}" ${(prefill.classification || 'PUBLIC').toUpperCase() === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </label>
        <label class="ccdt-save__lbl">Department
          <input class="ccdt-save__inp" id="ccdt-save-dept" value="${esc(prefill.department || '')}" />
        </label>
        <label class="ccdt-save__lbl">Tags
          <input class="ccdt-save__inp" id="ccdt-save-tags" value="${esc((prefill.tags || []).join(', '))}" placeholder="comma, separated, tags" />
        </label>
        <div class="ccdt-save__files">${photos.length} photo${photos.length === 1 ? '' : 's'} attached</div>
        <div class="ccdt-save__actions">
          <button class="ccdt-save__btn ccdt-save__btn--cancel" id="ccdt-save-cancel">CANCEL</button>
          <button class="ccdt-save__btn ccdt-save__btn--ok" id="ccdt-save-ok">${editing ? 'UPDATE' : 'SAVE'}</button>
        </div>
      </div>
    </div>`
  // Append dialog to the editor window body so it overlays the editor.
  wb.body.insertAdjacentHTML('beforeend', dialogHtml)
  const dialog = wb.body.querySelector('#ccdt-save')
  const openSaveDialog = () => {
    $('#ccdt-save-num').value = prefill._lastNum || prefill.archive_number || ''
    $('#ccdt-save-title-inp').value = prefill._lastTitle || prefill.title || ''
    $('#ccdt-save-cls').value = $('#ccdt-save-cls').value
    $('#ccdt-save-dept').value = prefill._lastDept || prefill.department || ''
    $('#ccdt-save-tags').value = prefill._lastTags || (prefill.tags || []).join(', ')
    dialog.hidden = false
    setTimeout(() => $('#ccdt-save-num').focus(), 50)
  }
  const closeSaveDialog = () => { dialog.hidden = true }

  // Save button on ribbon opens the dialog. Cancel on ribbon closes
  // the editor outright.
  $('#ccdt-e-save').addEventListener('click', openSaveDialog)
  $('#ccdt-e-cancel').addEventListener('click', () => wb.close())

  // Dialog buttons.
  $('#ccdt-save-ok').addEventListener('click', async () => {
    const num = $('#ccdt-save-num').value.trim()
    const ttl = $('#ccdt-save-title-inp').value.trim()
    if (!num || !ttl) {
      setStatus('archive number and title are required', '#c00000')
      return
    }
    const record = {
      archive_number: num,
      title: ttl,
      classification: $('#ccdt-save-cls').value,
      department: $('#ccdt-save-dept').value.trim(),
      content: htmlToMarkdown(paper.innerHTML),
      tags: $('#ccdt-save-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
      photos
    }
    closeSaveDialog()
    setStatus('saving…', '#b07b00')
    try {
      const res = editing
        ? await updateRecord(record, prefill._originalNumber, ctx)
        : await insertRecord(record, ctx)
      setStatus(res[0]?.text || 'saved', '#00723f')
      if (onSaved) onSaved(res)
      // After a brief flash, close the entire editor window — this drops
      // the dialog along with it (it's a child of wb.body).
      setTimeout(() => wb.close(), 600)
    } catch (e) {
      setStatus('save failed: ' + e.message, '#c00000')
      // Re-open the dialog so the user can retry without losing inputs.
      openSaveDialog()
    }
  })
  $('#ccdt-save-cancel').addEventListener('click', closeSaveDialog)
  // Clicking the backdrop also cancels.
  dialog.querySelector('.ccdt-save__backdrop').addEventListener('click', closeSaveDialog)

  renderPhotos()
  return wb
}