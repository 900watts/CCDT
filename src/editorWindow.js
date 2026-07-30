// Document editor — opens a Word-style WinBox window with form fields,
// a Markdown content area with formatting toolbar, drag-drop photo upload,
// and a live preview tab. Save -> calls insertRecord.
import WinBox from 'winbox/src/js/winbox.js'
import 'winbox/dist/css/winbox.min.css'

import { insertRecord, updateRecord } from './terminal/commands'
import { md2html } from './markdown'
import { nextZIndex, registerWindow, focusIfExists } from './windowStack'

const CLASSIFICATIONS = ['PUBLIC', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET']
const MAX_FILE_BYTES = 10 * 1024 * 1024  // 10 MB

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
  // In live mode, upload to Supabase Storage; in DEMO, store as data: URL.
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
  // DEMO: data URL
  const dataUrl = await fileToDataUrl(file)
  return { url: dataUrl, name: file.name }
}

export function openEditorWindow(ctx, prefill = {}, onSaved) {
  const editing = !!prefill._editing
  // Dedup: if editing an existing archive and that editor is already open, focus it.
  // New-create editors always open fresh (no dedup key).
  const dedupKey = editing ? 'editor:' + (prefill.archive_number || '') : null
  if (dedupKey && focusIfExists(dedupKey)) return
  const titleText = editing ? 'CCDT — EDIT DOCUMENT' : 'CCDT — NEW DOCUMENT'
  const html = `
    <div class="ccdt-edit">
      <div class="ccdt-edit__bar">
        <span class="ccdt-edit__title">${titleText}</span>
        <button class="ccdt-edit__save" id="ccdt-e-save">${editing ? 'SAVE CHANGES' : 'SAVE'}</button>
        <button class="ccdt-edit__cancel" id="ccdt-e-cancel">CANCEL</button>
      </div>

      <div class="ccdt-edit__form">
        <label class="ccdt-edit__lbl">ARCHIVE NUMBER
          <input class="ccdt-edit__inp" id="ccdt-e-num" placeholder="e.g. 173" value="${esc(prefill.archive_number || '')}" />
        </label>
        <label class="ccdt-edit__lbl">TITLE
          <input class="ccdt-edit__inp" id="ccdt-e-title" placeholder="document title" value="${esc(prefill.title || '')}" />
        </label>
        <div class="ccdt-edit__row">
          <label class="ccdt-edit__lbl ccdt-edit__lbl--half">CLASSIFICATION
            <select class="ccdt-edit__inp" id="ccdt-e-cls">
              ${CLASSIFICATIONS.map((c) => `<option value="${c}" ${(prefill.classification||'PUBLIC').toUpperCase()===c?'selected':''}>${c}</option>`).join('')}
            </select>
          </label>
          <label class="ccdt-edit__lbl ccdt-edit__lbl--half">DEPARTMENT
            <input class="ccdt-edit__inp" id="ccdt-e-dept" placeholder="department" value="${esc(prefill.department || '')}" />
          </label>
        </div>
        <label class="ccdt-edit__lbl">TAGS
          <input class="ccdt-edit__inp" id="ccdt-e-tags" placeholder="comma, separated, tags" value="${esc((prefill.tags||[]).join(', '))}" />
        </label>
      </div>

      <div class="ccdt-edit__tabs">
        <button class="ccdt-edit__tab ccdt-edit__tab--active" data-tab="write">WRITE</button>
        <button class="ccdt-edit__tab" data-tab="preview">PREVIEW</button>
      </div>

      <div class="ccdt-edit__toolbar" id="ccdt-e-toolbar">
        <button data-act="bold" title="Bold **text**"><b>B</b></button>
        <button data-act="italic" title="Italic *text*"><i>I</i></button>
        <button data-act="h1" title="Heading 1">H1</button>
        <button data-act="h2" title="Heading 2">H2</button>
        <button data-act="h3" title="Heading 3">H3</button>
        <button data-act="ul" title="Bullet list">•</button>
        <button data-act="quote" title="Quote">&gt;</button>
        <button data-act="link" title="Link [text](url)">🔗</button>
        <button data-act="photo" title="Insert photo" id="ccdt-e-photo">📷 PHOTO</button>
        <input type="file" id="ccdt-e-file" accept="image/*" multiple style="display:none" />
      </div>

      <div class="ccdt-edit__body" id="ccdt-e-body">
        <textarea id="ccdt-e-content" placeholder="Type your document here. Drag photos onto this area, or use 📷 PHOTO.&#10;&#10;Supports:&#10;# Heading 1&#10;## Heading 2&#10;### Heading 3&#10;**bold** *italic*&#10;- bullet&#10;> quote&#10;[link text](https://...)&#10;![alt](image-url)">${esc(prefill.content || '')}</textarea>
        <div id="ccdt-e-preview" class="ccdt-edit__preview" style="display:none"></div>
        <div id="ccdt-e-drop" class="ccdt-edit__drop">drop photos here</div>
      </div>

      <div class="ccdt-edit__photos" id="ccdt-e-photos"></div>
      <div class="ccdt-edit__status" id="ccdt-e-status"></div>
    </div>`

  const wb = new WinBox({
    title: titleText,
    class: 'ccdt-win ccdt-win--edit',
    html,
    background: '#05080a',
    border: '2px solid #11331f',
    x: 'center', y: 'center',
    width: '900px',
    height: '86%',
    minheight: 460,
    index: nextZIndex()
  })
  if (dedupKey) registerWindow(dedupKey, wb)

  const $ = (s) => wb.body.querySelector(s)
  const photos = prefill.photos ? prefill.photos.map((p) => ({ ...p })) : []  // [{url, name}]

  const setStatus = (msg, color) => {
    const el = $('#ccdt-e-status')
    el.textContent = msg
    el.style.color = color || '#38ff9a'
  }

  // Tabs
  wb.body.querySelectorAll('.ccdt-edit__tab').forEach((t) => {
    t.addEventListener('click', () => {
      wb.body.querySelectorAll('.ccdt-edit__tab').forEach((x) => x.classList.remove('ccdt-edit__tab--active'))
      t.classList.add('ccdt-edit__tab--active')
      const tab = t.dataset.tab
      if (tab === 'preview') {
        $('#ccdt-e-content').style.display = 'none'
        $('#ccdt-e-toolbar').style.display = 'none'
        $('#ccdt-e-drop').style.display = 'none'
        $('#ccdt-e-preview').style.display = 'block'
        $('#ccdt-e-preview').innerHTML = md2html($('#ccdt-e-content').value)
      } else {
        $('#ccdt-e-content').style.display = 'block'
        $('#ccdt-e-toolbar').style.display = 'flex'
        $('#ccdt-e-drop').style.display = 'none'  // hidden by default; only visible during a real drag
        $('#ccdt-e-preview').style.display = 'none'
      }
    })
  })

  // Toolbar formatting
  const wrap = (before, after) => {
    const ta = $('#ccdt-e-content')
    const s = ta.selectionStart, e = ta.selectionEnd
    const v = ta.value
    const sel = v.slice(s, e)
    ta.value = v.slice(0, s) + before + sel + after + v.slice(e)
    ta.focus()
    ta.selectionStart = s + before.length
    ta.selectionEnd = e + before.length
  }
  const prefixLines = (prefix) => {
    const ta = $('#ccdt-e-content')
    const s = ta.selectionStart, e = ta.selectionEnd
    const v = ta.value
    const lineStart = v.lastIndexOf('\n', s - 1) + 1
    const before = v.slice(0, lineStart)
    const mid = v.slice(lineStart, e)
    const after = v.slice(e)
    ta.value = before + mid.split('\n').map((l) => prefix + l).join('\n') + after
    ta.focus()
  }
  wb.body.querySelectorAll('#ccdt-e-toolbar button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const a = btn.dataset.act
      if (a === 'bold') wrap('**', '**')
      else if (a === 'italic') wrap('*', '*')
      else if (a === 'h1') prefixLines('# ')
      else if (a === 'h2') prefixLines('## ')
      else if (a === 'h3') prefixLines('### ')
      else if (a === 'ul') prefixLines('- ')
      else if (a === 'quote') prefixLines('> ')
      else if (a === 'link') {
        const url = prompt('URL?', 'https://')
        if (!url) return
        wrap('[', `](${url})`)
      }
      else if (a === 'photo') $('#ccdt-e-file').click()
    })
  })

  // Photo handling
  const addPhoto = async (file) => {
    if (!file) return
    if (file.size > MAX_FILE_BYTES) { setStatus('file too large (max 10 MB)', '#ff5b5b'); return }
    if (!file.type.startsWith('image/')) { setStatus('not an image', '#ff5b5b'); return }
    setStatus('uploading ' + file.name + '…', '#ffd166')
    try {
      const ph = await uploadPhoto(file, ctx)
      photos.push(ph)
      renderPhotos()
      // insert markdown at cursor
      const ta = $('#ccdt-e-content')
      const s = ta.selectionStart
      ta.value = ta.value.slice(0, s) + `\n![${ph.name}](${ph.url})\n` + ta.value.slice(s)
      setStatus('photo inserted', '#38ff9a')
    } catch (e) {
      setStatus('upload failed: ' + e.message, '#ff5b5b')
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
          <button data-rm="${i}" class="ccdt-edit__photo-rm">×</button>
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

  // Drag-drop — counter pattern so the overlay only stays visible while a
// drag is actively inside the body (not its child elements).
  const body = $('#ccdt-e-body')
  let dragDepth = 0
  const showDrop = (yes) => { $('#ccdt-e-drop').style.display = yes ? 'flex' : 'none' }
  body.addEventListener('dragenter', (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
    e.preventDefault()
    dragDepth++
    showDrop(true)
  })
  body.addEventListener('dragover', (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
    e.preventDefault()
  })
  body.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) showDrop(false)
  })
  body.addEventListener('drop', async (e) => {
    e.preventDefault()
    dragDepth = 0
    showDrop(false)
    const files = Array.from(e.dataTransfer?.files || [])
    for (const f of files) if (f.type.startsWith('image/')) await addPhoto(f)
  })
  // Safety net: if the drag ends anywhere (or is cancelled), hide.
  document.addEventListener('dragend', () => { dragDepth = 0; showDrop(false) })

  // Save / Cancel
  $('#ccdt-e-save').addEventListener('click', async () => {
    const record = {
      archive_number: $('#ccdt-e-num').value.trim(),
      title: $('#ccdt-e-title').value.trim(),
      classification: $('#ccdt-e-cls').value,
      department: $('#ccdt-e-dept').value.trim(),
      content: $('#ccdt-e-content').value,
      tags: $('#ccdt-e-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
      photos
    }
    if (!record.archive_number || !record.title) {
      setStatus('archive number and title are required', '#ff5b5b')
      return
    }
    setStatus('saving…', '#ffd166')
    try {
      const res = editing
        ? await updateRecord(record, prefill._originalNumber, ctx)
        : await insertRecord(record, ctx)
      setStatus(res[0]?.text || 'saved', '#38ff9a')
      if (onSaved) onSaved(res)
      setTimeout(() => wb.close(), 700)
    } catch (e) {
      setStatus('save failed: ' + e.message, '#ff5b5b')
    }
  })
  $('#ccdt-e-cancel').addEventListener('click', () => wb.close())

  // Render any photos that came in with a prefilled (edit) record.
  renderPhotos()
  setStatus(editing ? 'editing existing record' : 'ready', editing ? '#ffd166' : '#888')
  return wb
}