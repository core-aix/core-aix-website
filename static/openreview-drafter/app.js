/* globals MathJax, marked, google, ORConvert, renderOpenReview */
import {
  createClient,
  getYjsProviderForRoom,
  Y,
  Awareness,
  yCollab,
  yUndoManagerKeymap,
  EditorView,
  EditorState,
  Compartment,
  keymap,
  placeholder,
  basicSetup,
  indentWithTab,
} from './vendor/collab.js'

/*
 * How it fits together
 *  - Signing in: Google's button gives an ID token; /api/drafts/session checks
 *    it and returns our own session token (30 days), kept in localStorage.
 *  - Each draft is a Liveblocks room holding one Y.Text ("latex"), the plain
 *    LaTeX source. Everyone in the room edits it live.
 *  - The OpenReview text and the preview are derived from that source. Edits
 *    made in the OpenReview tab are converted back and applied to the source.
 *  - Signed out, there is one scratch draft that lives only in this page.
 *  - A share link (#s=<token>) opens a draft without signing in, as a guest,
 *    read-only if the owner set the link to "view".
 *  - Liveblocks bills by connection time, so an idle page disconnects and
 *    reconnects on the next key press or click (see "Idle").
 */

const API = '/api/drafts'
const SAMPLE = `We thank the reviewer for the careful reading.

**Q1. Is the bound in Theorem 1 tight?**

Yes. For the set $\\{x_i\\}_{i=1}^n$ with $\\|x_i\\|_2 \\leq 1$, the lower bound matches up to a constant:
$$
\\mathcal{L}(\\theta) = \\sum_{i=1}^n \\ell(f_\\theta(x_i), y_i) \\qquad
\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}
$$

- Write math as in a paper under *Plain LaTeX*.
- *OpenReview text* shows what to paste, with only the backslashes OpenReview needs.
- Sign in with Google to save drafts and write them together.
`

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id)
const LS = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k))
    } catch {
      return null
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {}
  },
  del(k) {
    try {
      localStorage.removeItem(k)
    } catch {}
  },
}
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const toOR = (latex) => ORConvert.toOpenReview(latex, { render: (t) => marked.parse(t) })
const initials = (name) =>
  String(name || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')

let toastTimer
function toast(msg, kind = '') {
  const t = $('toast')
  t.textContent = msg
  t.className = `toast ${kind}`
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'error' ? 7000 : 3500)
}

// A modal on <dialog>. Resolves { button, values }; button is null if dismissed.
function ask({ title, html = '', fields = [], buttons, onOpen }) {
  const dlg = $('dialog')
  $('dialog-title').textContent = title
  const body = $('dialog-body')
  body.innerHTML = html
  for (const f of fields) {
    const row = document.createElement('label')
    row.className = 'field'
    row.innerHTML = `<span>${esc(f.label)}</span>`
    const input = document.createElement('input')
    input.type = f.type || 'text'
    input.value = f.value ?? ''
    input.placeholder = f.placeholder ?? ''
    input.autocomplete = 'off'
    input.id = `f-${f.id}`
    row.append(input)
    if (f.help) {
      const h = document.createElement('small')
      h.innerHTML = f.help
      row.append(h)
    }
    body.append(row)
  }
  const bar = $('dialog-buttons')
  bar.innerHTML = ''
  return new Promise((resolve) => {
    const finish = (button) => {
      const values = {}
      for (const f of fields) values[f.id] = $(`f-${f.id}`).value.trim()
      dlg.onclose = null
      dlg.close()
      resolve({ button, values })
    }
    for (const b of buttons) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = b.label
      btn.className = b.kind || ''
      btn.addEventListener('click', () => finish(b.value))
      bar.append(btn)
    }
    // Enter submits with the first (primary) button.
    body.onkeydown = (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault()
        finish(buttons[0].value)
      }
    }
    dlg.onclose = () => resolve({ button: null, values: {} })
    dlg.showModal()
    onOpen?.(body, finish)
    body.querySelector('input')?.focus()
  })
}

// ---------------------------------------------------------------- API
let session = LS.get('ord:session') // { token, user: { email, name, picture } }

// A guest keeps one random id per browser, so Liveblocks counts them once.
function guestId() {
  let id = LS.get('ord:guestId')
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('')
    LS.set('ord:guestId', id)
  }
  return id
}
const guestName = () => LS.get('ord:guestName') || ''
const linkTokens = new Map() // room id -> share-link token it was opened with

class ApiError extends Error {}

async function api(route, body) {
  const res = await fetch(`${API}/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new ApiError('Could not reach the server. Check your connection.')
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && route !== 'session') {
    signOut({ quiet: true })
    toast(data.error || 'Please sign in again.', 'error')
  }
  if (!res.ok) {
    const e = new ApiError(data.error || `Server error ${res.status}`)
    e.status = res.status
    throw e
  }
  return data
}

// ---------------------------------------------------------------- editors
const prefs = Object.assign({ zoom: 1, tab: 'latex' }, LS.get('ord:prefs'))
const savePrefs = () => LS.set('ord:prefs', prefs)

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '0.875rem', backgroundColor: '#fff' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.5' },
  '.cm-content': { padding: '0.75rem 0' },
  '.cm-gutters': { backgroundColor: '#fafaf7', borderRight: '1px solid #eee', color: '#aaa' },
  '&.cm-focused': { outline: 'none' },
})

// The OpenReview-text editor is local to this page (not shared). Its edits
// are converted back to LaTeX and applied to the shared source.
let orView
const orReadOnly = new Compartment()
let orDirtyTimer = null
let applyingOr = false

function makeOrEditor() {
  orView = new EditorView({
    parent: $('or-editor'),
    state: EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        EditorView.lineWrapping,
        baseTheme,
        orReadOnly.of([]),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet || u.docChanged) scheduleCounts()
          if (!u.docChanged || applyingOr) return
          clearTimeout(orDirtyTimer)
          orDirtyTimer = setTimeout(applyOrEdits, 250)
        }),
      ],
    }),
  })
}

// Replace a CodeMirror document with minimal change, so the cursor stays put.
function setEditorText(view, text) {
  const old = view.state.doc.toString()
  if (old === text) return
  const { from, to, insert } = minimalChange(old, text)
  applyingOr = view === orView
  view.dispatch({ changes: { from, to, insert } })
  applyingOr = false
}

function minimalChange(a, b) {
  let p = 0
  const max = Math.min(a.length, b.length)
  while (p < max && a[p] === b[p]) p++
  let s = 0
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) }
}

const readOnlyExt = (ro) => (ro ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [])

function applyOrEdits() {
  orDirtyTimer = null
  if (!draft || draft.readOnly) return
  const latex = ORConvert.fromOpenReview(orView.state.doc.toString())
  const old = draft.ytext.toString()
  if (latex === old) return
  const { from, to, insert } = minimalChange(old, latex)
  draft.doc.transact(() => {
    if (to > from) draft.ytext.delete(from, to - from)
    if (insert) draft.ytext.insert(from, insert)
  }, 'or-editor')
}

// ---------------------------------------------------------------- the open draft
/*
 * draft = { id|null, title, owner, doc, ytext, awareness, latexView,
 *           room?, leave?, provider?, unsubs[] }
 */
let draft = null
let client = null
let drafts = [] // the list from /list

function getClient() {
  if (client) return client
  client = createClient({
    // Called by Liveblocks whenever it needs a token for a room.
    authEndpoint: async (room) => {
      try {
        const linkToken = linkTokens.get(room)
        return await api(
          'liveblocks-auth',
          linkToken ? { room, linkToken, guestId: guestId(), guestName: guestName() } : { room }
        )
      } catch (e) {
        return { error: 'forbidden', reason: e.message }
      }
    },
    // The browser warns before closing while edits haven't reached Liveblocks.
    preventUnsavedChanges: true,
    badgeLocation: 'bottom-left',
    lostConnectionTimeout: 5000,
    // A tab in the background lets its connection go after a minute (once
    // nothing is waiting to be saved) and reconnects when shown again.
    backgroundKeepAliveTimeout: 60_000,
  })
  client.events.syncStatus.subscribe(updateSyncStatus)
  return client
}

function closeDraft() {
  if (!draft) return
  applyOrEditsNow()
  for (const u of draft.unsubs) u()
  draft.latexView.destroy()
  if (draft.leave) draft.leave()
  else draft.doc.destroy()
  draft = null
  $('presence').innerHTML = ''
}

function applyOrEditsNow() {
  if (orDirtyTimer) {
    clearTimeout(orDirtyTimer)
    applyOrEdits()
  }
}

function mountLatexEditor(d) {
  const undoManager = new Y.UndoManager(d.ytext)
  d.latexView = new EditorView({
    parent: $('latex-editor'),
    state: EditorState.create({
      doc: d.ytext.toString(),
      extensions: [
        keymap.of([...yUndoManagerKeymap, indentWithTab]),
        basicSetup,
        EditorView.lineWrapping,
        baseTheme,
        placeholder('Write your reply here. Math as in LaTeX: $x_i$, $$\\sum_i x_i$$ …'),
        yCollab(d.ytext, d.awareness, { undoManager }),
        readOnlyExt(d.readOnly),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet) scheduleCounts()
        }),
      ],
    }),
  })
}

// Recompute the OpenReview text, the preview and the counts from the source.
let deriveTimer
function scheduleDerive() {
  clearTimeout(deriveTimer)
  deriveTimer = setTimeout(derive, 120)
}
function derive() {
  if (!draft) return
  const latex = draft.ytext.toString()
  const or = toOR(latex)
  draft.or = or
  // Don't overwrite the OpenReview tab while someone is typing in it.
  if (!orDirtyTimer) setEditorText(orView, or)
  updateCounts()
  renderPreview(or)
  updateScratchBanner()
}

function attachDerived(d) {
  const handler = () => scheduleDerive()
  d.ytext.observe(handler)
  d.unsubs.push(() => d.ytext.unobserve(handler))
}

function openScratch(text = SAMPLE) {
  closeDraft()
  const doc = new Y.Doc()
  const ytext = doc.getText('latex')
  ytext.insert(0, text)
  const d = { id: null, title: 'Scratch draft (not saved)', doc, ytext, awareness: new Awareness(doc), unsubs: [], initial: text }
  draft = d
  mountLatexEditor(d)
  attachDerived(d)
  derive()
  renderToolbar()
}

async function openDraft(id, { initialText, link } = {}) {
  closeDraft()
  idlePaused = false
  lastActivity = Date.now()
  // link = { token, mode, title, owner } when opened as a guest through a share link
  if (link) linkTokens.set(id, link.token)
  const meta = link || drafts.find((x) => x.id === id) || { id, title: 'Loading…', owner: '' }
  const { room, leave } = getClient().enterRoom(id)
  const provider = getYjsProviderForRoom(room)
  const doc = provider.getYDoc()
  const ytext = doc.getText('latex')
  const awareness = provider.awareness
  const name = link && !session ? guestName() || 'Guest' : session.user.name
  const colour = colourFor(session && !link ? session.user.email : `guest:${guestId()}`)
  const picture = link && !session ? '' : session.user.picture || ''
  awareness.setLocalStateField('user', { name, color: colour, colorLight: colour + '33', picture })

  const d = {
    id,
    title: meta.title,
    owner: meta.owner,
    guest: Boolean(link),
    linkMode: link?.mode,
    readOnly: link?.mode === 'view',
    doc,
    ytext,
    awareness,
    room,
    leave,
    provider,
    unsubs: [],
  }
  draft = d
  orView.dispatch({ effects: orReadOnly.reconfigure(readOnlyExt(d.readOnly)) })
  if (link) {
    history.replaceState(null, '', `#s=${link.token}`)
  } else {
    history.replaceState(null, '', `#d=${id}`)
    LS.set('ord:last', id)
  }
  mountLatexEditor(d)
  attachDerived(d)
  derive()
  renderToolbar()
  $('latex-editor').classList.add('loading')

  const onSync = (synced) => {
    if (!synced || draft !== d) return
    $('latex-editor').classList.remove('loading')
    // A draft started from a file: fill it once, after the (empty) room has loaded.
    if (initialText && d.ytext.length === 0) {
      d.ytext.insert(0, initialText)
      initialText = null
    }
    updateSyncStatus()
  }
  provider.on('sync', onSync)
  d.unsubs.push(() => provider.off('sync', onSync))
  if (provider.synced) onSync(true)

  d.unsubs.push(room.subscribe('others', renderPresence))
  awareness.on('change', renderPresence)
  d.unsubs.push(() => awareness.off('change', renderPresence))
  d.unsubs.push(room.subscribe('status', updateSyncStatus))
  d.unsubs.push(
    room.subscribe('error', (err) => {
      toast(`Cannot open this draft: ${err.message || 'access denied'}`, 'error')
    })
  )
  if (d.readOnly) {
    // A view-only link: never mark the editor as loading forever if the
    // read-only connection reports sync late.
    setTimeout(() => draft === d && $('latex-editor').classList.remove('loading'), 4000)
  }
  renderPresence()
  updateSyncStatus()
}

// ---------------------------------------------------------------- status, presence, toolbar
const COLOURS = ['#d0342c', '#1f6feb', '#2e7d32', '#8e44ad', '#e67e22', '#00838f', '#c2185b', '#5d4037']
function colourFor(email) {
  let h = 0
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLOURS[h % COLOURS.length]
}

function avatar({ name, avatar: pic, color }, title) {
  const span = document.createElement('span')
  span.className = 'avatar'
  span.style.borderColor = color || '#999'
  span.title = title
  if (pic) {
    const img = document.createElement('img')
    img.src = pic
    img.alt = ''
    img.referrerPolicy = 'no-referrer'
    img.onerror = () => img.replaceWith(document.createTextNode(initials(name)))
    span.append(img)
  } else {
    span.textContent = initials(name)
    span.style.background = color || '#999'
  }
  return span
}

// Who else is here, from the editor's awareness states: they carry each
// person's current name and colour (the same ones their cursor label shows).
function renderPresence() {
  const box = $('presence')
  box.innerHTML = ''
  if (!draft?.room || idlePaused) return
  const seen = new Set()
  for (const [clientId, state] of draft.awareness.getStates()) {
    const u = state?.user
    if (clientId === draft.doc.clientID || !u) continue
    const key = `${u.name}|${u.color}`
    if (seen.has(key)) continue // the same person in two tabs
    seen.add(key)
    box.append(avatar({ name: u.name, avatar: u.picture, color: u.color }, `${u.name} is here`))
  }
}

function updateSyncStatus() {
  const el = $('sync-status')
  if (!draft) return (el.textContent = '')
  if (!draft.room) {
    el.className = 'sync-status warn'
    el.textContent = 'Not saved'
    return
  }
  const status = draft.room.getStatus()
  const syncing = client?.getSyncStatus() === 'synchronizing' || !draft.provider.synced
  if (idlePaused) {
    el.className = 'sync-status idle'
    el.textContent = '⏸ Paused while idle'
    el.title = 'Disconnected to save connection time. Reconnects as soon as you type or click.'
    return
  }
  el.title = ''
  if (status === 'disconnected' || status === 'reconnecting') {
    el.className = 'sync-status warn'
    el.textContent = 'Offline: reconnecting…'
  } else if (status !== 'connected') {
    el.className = 'sync-status'
    el.textContent = 'Connecting…'
  } else if (syncing) {
    el.className = 'sync-status'
    el.textContent = 'Saving…'
  } else {
    el.className = 'sync-status ok'
    el.textContent = draft.readOnly ? 'View only' : '✓ Saved'
  }
}

// ---------------------------------------------------------------- idle
/*
 * Liveblocks bills by connection time. A visible page with no key press,
 * click, scroll or touch for IDLE_MS disconnects (once everything is saved),
 * and the next one reconnects; Yjs then merges whatever changed meanwhile.
 * Background tabs are handled by Liveblocks itself (backgroundKeepAliveTimeout).
 */
const IDLE_MS = Number(LS.get('ord:idleMs')) || 5 * 60 * 1000 // ord:idleMs: a testing override
let lastActivity = Date.now()
let idlePaused = false

function onActivity() {
  lastActivity = Date.now()
  if (idlePaused && draft?.room) {
    idlePaused = false
    draft.room.connect()
    updateSyncStatus()
  }
}
for (const ev of ['keydown', 'pointerdown', 'wheel', 'touchstart']) {
  document.addEventListener(ev, onActivity, { capture: true, passive: true })
}
window.addEventListener('focus', onActivity)

setInterval(() => {
  if (!draft?.room || idlePaused || document.hidden) return
  if (Date.now() - lastActivity < IDLE_MS) return
  if (client?.getSyncStatus() === 'synchronizing') return // never drop unsaved edits
  idlePaused = true
  draft.room.disconnect()
  renderPresence()
  updateSyncStatus()
}, Math.min(15_000, IDLE_MS / 2))

function renderToolbar() {
  const signedIn = Boolean(session)
  const sel = $('draft-select')
  sel.hidden = !signedIn
  if (signedIn) {
    sel.innerHTML = ''
    if (!drafts.length) sel.add(new Option('No drafts yet', ''))
    for (const x of drafts) {
      const shared = x.owner && x.owner !== session.user.email ? ` · shared by ${x.owner}` : ''
      sel.add(new Option(`${x.title}${shared}`, x.id, false, draft?.id === x.id))
    }
  }
  const t = $('draft-title')
  t.textContent = draft ? draft.title : ''
  t.disabled = !draft?.id || draft.guest
  $('share').hidden = !draft?.id || draft.guest
  $('delete-draft').hidden = !(draft?.id && !draft.guest && draft.owner === session?.user.email)
  updateSyncStatus()
  updateScratchBanner()
}

function updateScratchBanner() {
  const b = $('banner')
  if (draft?.guest) {
    b.hidden = false
    b.className = 'banner'
    const who = session ? esc(session.user.name) : esc(guestName() || 'Guest')
    b.innerHTML = draft.readOnly
      ? `<b>View only.</b> “${esc(draft.title)}” was shared with you through a link. You can copy the OpenReview text or download it.`
      : `You are editing “${esc(draft.title)}” through a share link, as <b>${who}</b>${
          session ? '' : ' <button type="button" class="link" id="guest-rename">change name</button>'
        }. Changes are saved for everyone who can open it.`
    $('guest-rename')?.addEventListener('click', renameGuest)
    return
  }
  if (session) {
    b.hidden = true
    return
  }
  b.hidden = false
  const changed = draft && draft.ytext.toString() !== draft.initial
  b.className = changed ? 'banner warn' : 'banner'
  b.innerHTML = changed
    ? '⚠ This scratch draft is <b>not saved</b> and is lost when you close the page. Sign in to save it, or download it.'
    : 'Sign in with Google to save drafts and write them together with your co-authors.'
}

async function renameGuest() {
  const r = await ask({
    title: 'Your name',
    fields: [{ id: 'name', label: 'Shown to others editing this draft', value: guestName(), placeholder: 'e.g. Sam' }],
    buttons: [
      { label: 'Save', value: 'ok', kind: 'primary' },
      { label: 'Cancel', value: null },
    ],
  })
  if (r.button !== 'ok') return
  LS.set('ord:guestName', r.values.name.slice(0, 40))
  if (draft?.room) {
    const colour = colourFor(`guest:${guestId()}`)
    draft.awareness.setLocalStateField('user', { name: guestName() || 'Guest', color: colour, colorLight: colour + '33', picture: '' })
  }
  updateScratchBanner()
}

// ---------------------------------------------------------------- character counts
/*
 * Two counts: the raw Markdown (the plain-LaTeX source) and the OpenReview text
 * (what gets pasted, so what OpenReview's character limit applies to). With
 * text selected in either editor, both counts are for the selection: the other
 * form is worked out by converting just the selected text.
 */
let countsFrame = 0
function scheduleCounts() {
  cancelAnimationFrame(countsFrame)
  countsFrame = requestAnimationFrame(updateCounts)
}

function selectedText(view) {
  if (!view) return ''
  return view.state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => view.state.sliceDoc(r.from, r.to))
    .join('\n')
}

function updateCounts() {
  const el = $('count')
  if (!draft) return (el.textContent = '')
  const fmt = (n) => n.toLocaleString()
  const latex = draft.ytext.toString()
  const or = draft.or ?? toOR(latex)
  const inLatex = prefs.tab === 'latex'
  const sel = selectedText(inLatex ? draft.latexView : orView)
  if (!sel) {
    el.classList.remove('selection')
    el.innerHTML = `Markdown ${fmt(latex.length)} · OpenReview <b>${fmt(or.length)}</b> characters`
    el.title = 'Markdown: the plain-LaTeX text. OpenReview: the text you paste, which OpenReview’s limit applies to. Select text to count part of it.'
    return
  }
  const selLatex = inLatex ? sel : ORConvert.fromOpenReview(sel)
  const selOr = inLatex ? toOR(sel) : sel
  el.classList.add('selection')
  el.innerHTML = `Selected: Markdown ${fmt(selLatex.length)} · OpenReview <b>${fmt(selOr.length)}</b> <span class="of">of ${fmt(latex.length)} · ${fmt(or.length)}</span>`
  el.title = `The selection, as ${inLatex ? 'plain LaTeX and converted to OpenReview text' : 'OpenReview text and converted back to plain LaTeX'}.`
}

// ---------------------------------------------------------------- preview
const preview = $('preview')
let typesetChain = Promise.resolve()
function renderPreview(text) {
  typesetChain = typesetChain.then(async () => {
    if (window.MathJax?.typesetClear) MathJax.typesetClear([preview])
    preview.innerHTML = text ? renderOpenReview(text) : ''
    if (window.MathJax?.startup?.promise) {
      await MathJax.startup.promise
      await MathJax.typesetPromise([preview]).catch(() => console.warn('Could not typeset TeX content'))
    }
  })
}

// ---------------------------------------------------------------- tabs, zoom, copy, download
function showTab(tab) {
  if (prefs.tab === 'or' && tab !== 'or') applyOrEditsNow()
  prefs.tab = tab
  savePrefs()
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab))
  $('latex-editor').hidden = tab !== 'latex'
  $('or-editor').hidden = tab !== 'or'
  $('tab-hint').textContent =
    tab === 'latex' ? 'Write math normally' : 'Exactly what you paste. Edits update the LaTeX.'
  ;(tab === 'latex' ? draft?.latexView : orView)?.requestMeasure()
  scheduleCounts()
}
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    showTab(t.dataset.tab)
    ;(prefs.tab === 'latex' ? draft?.latexView : orView)?.focus()
  })
)

const noteContent = document.querySelector('.note-content')
function setZoom(z) {
  prefs.zoom = Math.round(Math.min(3, Math.max(0.5, z)) * 100) / 100
  noteContent.style.zoom = prefs.zoom
  $('zoom-reset').textContent = `${Math.round(prefs.zoom * 100)}%`
  savePrefs()
}
$('zoom-in').addEventListener('click', () => setZoom(prefs.zoom + 0.1))
$('zoom-out').addEventListener('click', () => setZoom(prefs.zoom - 0.1))
$('zoom-reset').addEventListener('click', () => setZoom(1))
$('preview-scroll').addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return // a trackpad pinch also sets ctrlKey
    e.preventDefault()
    setZoom(prefs.zoom * Math.exp(-e.deltaY * 0.002))
  },
  { passive: false }
)

$('copy').addEventListener('click', async () => {
  applyOrEditsNow()
  derive()
  const btn = $('copy')
  try {
    await navigator.clipboard.writeText(draft.or)
    btn.textContent = 'Copied ✓'
  } catch {
    btn.textContent = 'Copy failed'
  }
  setTimeout(() => (btn.textContent = 'Copy for OpenReview'), 1500)
})

const fileName = (title) => `${(title || 'draft').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'draft'}.md`
$('download').addEventListener('click', () => {
  applyOrEditsNow()
  const blob = new Blob([draft.ytext.toString()], { type: 'text/markdown;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = fileName(draft.id ? draft.title : 'scratch')
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
})

// ---------------------------------------------------------------- drafts: list, new, open, rename, delete
async function refreshDrafts() {
  if (!session) return
  try {
    drafts = (await api('list')).drafts.sort((a, b) =>
      String(b.lastConnectionAt || b.createdAt).localeCompare(String(a.lastConnectionAt || a.createdAt))
    )
  } catch (e) {
    toast(e.message, 'error')
  }
  if (draft?.id) {
    const meta = drafts.find((x) => x.id === draft.id)
    if (meta) Object.assign(draft, { title: meta.title, owner: meta.owner })
  }
  renderToolbar()
}

async function createDraft(title, initialText) {
  const { draft: meta } = await api('create', { title })
  drafts.unshift(meta)
  await openDraft(meta.id, { initialText })
  toast(`Created “${meta.title}”.`)
}

$('draft-select').addEventListener('change', (e) => {
  if (e.target.value) openDraft(e.target.value)
})

$('new-draft').addEventListener('click', async () => {
  if (!session) {
    const r = await ask({
      title: 'Sign in to create drafts',
      html: '<p>Drafts are saved to your account and can be shared with co-authors. Use the <b>Sign in with Google</b> button at the top right.</p><p class="muted">Without signing in you can keep using the scratch draft, which is not saved.</p>',
      buttons: [
        { label: 'Clear the scratch draft', value: 'clear' },
        { label: 'OK', value: null, kind: 'primary' },
      ],
    })
    if (r.button === 'clear') openScratch('')
    return
  }
  const r = await ask({
    title: 'New draft',
    fields: [{ id: 'title', label: 'Title', value: '', placeholder: 'e.g. Paper 1234 – reply to reviewer 2' }],
    buttons: [
      { label: 'Create', value: 'ok', kind: 'primary' },
      { label: 'Cancel', value: null },
    ],
  })
  if (r.button !== 'ok') return
  createDraft(r.values.title).catch((e) => toast(e.message, 'error'))
})

$('open-file').addEventListener('click', () => $('open-file-input').click())
$('open-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  const text = await file.text()
  if (!session) return openScratch(text)
  createDraft(file.name.replace(/\.(md|markdown|txt)$/i, ''), text).catch((err) => toast(err.message, 'error'))
})

$('draft-title').addEventListener('click', async () => {
  if (!draft?.id) return
  const r = await ask({
    title: 'Rename draft',
    fields: [{ id: 'title', label: 'Title', value: draft.title }],
    buttons: [
      { label: 'Rename', value: 'ok', kind: 'primary' },
      { label: 'Cancel', value: null },
    ],
  })
  if (r.button !== 'ok') return
  try {
    const { draft: meta } = await api('rename', { id: draft.id, title: r.values.title })
    draft.title = meta.title
    await refreshDrafts()
  } catch (e) {
    toast(e.message, 'error')
  }
})

$('delete-draft').addEventListener('click', async () => {
  const r = await ask({
    title: 'Delete this draft?',
    html: `<p><b>${esc(draft.title)}</b> will be deleted for everyone it is shared with. This cannot be undone.</p>
      <p class="muted">Download it first if you want a copy.</p>`,
    buttons: [
      { label: 'Delete for everyone', value: 'delete', kind: 'danger-solid' },
      { label: 'Cancel', value: null },
    ],
  })
  if (r.button !== 'delete') return
  try {
    const id = draft.id
    await api('delete', { id })
    closeDraft()
    drafts = drafts.filter((x) => x.id !== id)
    LS.del('ord:last')
    history.replaceState(null, '', location.pathname)
    toast('Draft deleted.')
    await openFirstOrNew()
  } catch (e) {
    toast(e.message, 'error')
  }
})

// ---------------------------------------------------------------- sharing
$('share').addEventListener('click', () => shareDialog())

async function shareDialog() {
  const id = draft.id
  const render = async (body) => {
    const list = body.querySelector('.members')
    list.textContent = 'Loading…'
    try {
      const { members, owner } = await api('members', { id })
      const me = session.user.email
      list.innerHTML = ''
      for (const [email, info] of Object.entries(members)) {
        const row = document.createElement('div')
        row.className = 'member'
        row.append(avatar({ name: info?.name || email, avatar: info?.picture, color: colourFor(email) }, email))
        const who = document.createElement('div')
        who.className = 'who'
        who.innerHTML = `<b>${esc(info?.name || email)}</b>${email === owner ? ' <span class="tag">owner</span>' : ''}${
          info ? '' : ' <span class="tag muted">not signed in yet</span>'
        }<br><small>${esc(email)}</small>`
        row.append(who)
        if (email !== owner && (me === owner || email === me)) {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'link danger'
          btn.textContent = email === me ? 'Leave' : 'Remove'
          btn.addEventListener('click', async () => {
            try {
              await api('unshare', { id, email })
              if (email === me) {
                $('dialog').close()
                closeDraft()
                await refreshDrafts()
                await openFirstOrNew()
                return toast('You left the draft.')
              }
              render(body)
            } catch (e) {
              toast(e.message, 'error')
            }
          })
          row.append(btn)
        }
        list.append(row)
      }
    } catch (e) {
      list.textContent = e.message
    }
  }

  const LINK_LABELS = {
    edit: 'Anyone with the link can edit',
    view: 'Anyone with the link can view',
    off: 'Link turned off',
  }
  const renderLink = (body, info) => {
    const url = `${location.origin}${location.pathname}#s=${info.token}`
    const input = body.querySelector('#pub-link')
    input.value = info.mode === 'off' ? 'Link sharing is turned off' : url
    body.querySelector('#pub-copy').disabled = info.mode === 'off'
    body.querySelector('#pub-copy').onclick = async () => {
      await navigator.clipboard.writeText(url).catch(() => {})
      toast('Share link copied.')
    }
    const ctl = body.querySelector('#link-controls')
    if (info.canManage) {
      ctl.innerHTML = `<select id="link-mode">${Object.entries(LINK_LABELS)
        .map(([v, l]) => `<option value="${v}"${v === info.mode ? ' selected' : ''}>${l}</option>`)
        .join('')}</select>
        <button type="button" class="link" id="link-reset" title="Make a new link; the old one stops working">Reset link</button>`
      const update = async (payload) => {
        try {
          renderLink(body, await api('link-settings', { id, ...payload }))
          toast(payload.reset ? 'New link made. The old link no longer works.' : 'Link setting saved.')
        } catch (e) {
          toast(e.message, 'error')
        }
      }
      ctl.querySelector('#link-mode').onchange = (e) => update({ mode: e.target.value })
      ctl.querySelector('#link-reset').onclick = () => update({ reset: true })
    } else {
      ctl.innerHTML = `<span class="muted">${LINK_LABELS[info.mode]}${
        info.mode === 'off' ? '' : ', no sign-in needed'
      }. Only the owner can change this.</span>`
    }
  }

  await ask({
    title: `Share “${draft.title}”`,
    html: `
      <h3 class="first">Share link</h3>
      <p class="muted">Opens this draft without signing in. Changes made through it are saved for everyone.</p>
      <div class="share-link">
        <input id="pub-link" readonly value="Loading…">
        <button type="button" id="pub-copy" disabled>Copy link</button>
      </div>
      <div id="link-controls" class="link-controls"></div>
      <h3>Add people by e-mail</h3>
      <p class="muted">They sign in with Google using that address, and then see this draft in their list.</p>
      <div class="share-add">
        <input id="share-email" type="email" placeholder="co-author@example.com" autocomplete="off">
        <button type="button" id="share-add" class="primary">Add</button>
      </div>
      <h3>People with access</h3>
      <div class="members"></div>`,
    buttons: [{ label: 'Done', value: null, kind: 'primary' }],
    onOpen: (body) => {
      render(body)
      api('link', { id })
        .then((info) => renderLink(body, info))
        .catch((e) => (body.querySelector('#pub-link').value = e.message))
      const add = async () => {
        const input = body.querySelector('#share-email')
        const email = input.value.trim()
        if (!email) return
        try {
          await api('share', { id, email })
          input.value = ''
          render(body)
          toast(`Shared with ${email}. They will find it in their list after signing in.`)
        } catch (e) {
          toast(e.message, 'error')
        }
      }
      body.querySelector('#share-add').addEventListener('click', add)
      body.querySelector('#share-email').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          add()
        }
      })
    },
  })
}

// ---------------------------------------------------------------- sign in / out
let googleClientId = null

async function setUpGoogle() {
  try {
    googleClientId = (await api('config')).googleClientId
  } catch {}
  if (!googleClientId) {
    $('google-button').innerHTML = '<span class="muted small">Sign-in is not configured on this server.</span>'
    $('google-button').hidden = Boolean(session)
    return
  }
  // The Google script loads asynchronously.
  for (let i = 0; i < 100 && !window.google?.accounts?.id; i++) await new Promise((r) => setTimeout(r, 100))
  if (!window.google?.accounts?.id) {
    $('google-button').innerHTML = '<span class="muted small">Google sign-in could not load.</span>'
    $('google-button').hidden = Boolean(session)
    return
  }
  google.accounts.id.initialize({
    client_id: googleClientId,
    callback: onGoogleCredential,
    ux_mode: 'popup',
    use_fedcm_for_button: true,
  })
  renderAccount()
}

async function onGoogleCredential({ credential }) {
  try {
    const data = await api('session', { credential })
    session = { token: data.session, user: data.user }
    LS.set('ord:session', session)
    toast(data.isNew ? `Welcome, ${data.user.name}! Your account is ready.` : `Signed in as ${data.user.name}.`)
    await afterSignIn()
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function afterSignIn() {
  if (draft?.guest) {
    renderAccount()
    await refreshDrafts()
    return openLink(linkTokens.get(draft.id))
  }
  const scratch = draft && !draft.id ? draft.ytext.toString() : null
  const keepScratch = scratch !== null && scratch !== draft.initial && scratch.trim()
  renderAccount()
  await refreshDrafts()
  if (keepScratch) {
    // Don't lose what was written before signing in.
    await createDraft('Untitled draft', scratch).catch((e) => toast(e.message, 'error'))
  } else {
    await openFromHashOrLast()
  }
}

function signOut({ quiet = false } = {}) {
  const guestToken = draft?.guest ? linkTokens.get(draft.id) : null
  closeDraft()
  session = null
  drafts = []
  LS.del('ord:session')
  LS.del('ord:last')
  if (client) {
    client.logout()
    client = null
  }
  window.google?.accounts?.id?.disableAutoSelect()
  const token = guestToken || hashLinkToken()
  history.replaceState(null, '', token ? `#s=${token}` : location.pathname)
  renderAccount()
  if (!token) openScratch()
  else openLink(token)
  if (!quiet) toast('Signed out.')
}
$('sign-out').addEventListener('click', () => signOut())

function renderAccount() {
  const signedIn = Boolean(session)
  $('user-menu').hidden = !signedIn
  $('google-button').hidden = signedIn
  if (signedIn) {
    $('user-name').textContent = session.user.name
    $('user-avatar').src = session.user.picture || ''
    $('user-avatar').hidden = !session.user.picture
  } else if (window.google?.accounts?.id && googleClientId) {
    $('google-button').innerHTML = ''
    google.accounts.id.renderButton($('google-button'), { theme: 'outline', size: 'medium', text: 'signin_with', shape: 'pill' })
  }
  renderToolbar()
}

// ---------------------------------------------------------------- start
function hashDraftId() {
  const m = /(?:^|[#&])d=(ord-[A-Za-z0-9_-]+)/.exec(location.hash)
  return m ? m[1] : null
}
function hashLinkToken() {
  const m = /(?:^|[#&])s=([A-Za-z0-9_-]{43})\b/.exec(location.hash)
  return m ? m[1] : null
}

// Open a share link: as a member if this account is one, otherwise as a guest.
async function openLink(token) {
  let info
  try {
    info = await api('link-open', { token })
  } catch (e) {
    toast(e.message, 'error')
    history.replaceState(null, '', location.pathname)
    return false
  }
  if (info.member) {
    await openDraft(info.draft.id)
  } else {
    await openDraft(info.draft.id, { link: { token, mode: info.mode, title: info.draft.title, owner: info.draft.owner } })
    if (!session && info.mode === 'edit' && !guestName()) renameGuest()
  }
  return true
}

async function openFirstOrNew() {
  if (drafts.length) return openDraft(drafts[0].id)
  draft = null
  openScratch('')
  // Signed in with no drafts: offer to create one.
  $('banner').hidden = false
  $('banner').className = 'banner'
  $('banner').innerHTML = 'You have no drafts yet. Click <b>New</b> to create one, or <b>Open file…</b> to start from a Markdown file.'
}

async function openFromHashOrLast() {
  const token = hashLinkToken()
  if (token && (await openLink(token))) return
  const wanted = hashDraftId() || LS.get('ord:last')
  if (wanted) {
    if (!drafts.some((x) => x.id === wanted) && hashDraftId()) {
      toast('That draft has not been shared with this account, or it no longer exists.', 'error')
      history.replaceState(null, '', location.pathname)
    } else if (drafts.some((x) => x.id === wanted)) {
      return openDraft(wanted)
    }
  }
  return openFirstOrNew()
}

window.addEventListener('hashchange', () => {
  const token = hashLinkToken()
  if (token && token !== linkTokens.get(draft?.id)) return openLink(token)
  const id = hashDraftId()
  if (session && id && id !== draft?.id) openDraft(id)
})

// The scratch draft is never saved, so warn before closing if it changed.
// (Liveblocks drafts are covered by preventUnsavedChanges.)
window.addEventListener('beforeunload', (e) => {
  applyOrEditsNow()
  if (draft && !draft.id && draft.ytext.toString() !== draft.initial && draft.ytext.toString().trim()) {
    e.preventDefault()
    e.returnValue = ''
  }
})

async function start() {
  setZoom(Number(prefs.zoom) || 1)
  makeOrEditor()
  showTab(prefs.tab === 'or' ? 'or' : 'latex')
  if (session) {
    renderAccount()
    await refreshDrafts()
    if (session) await openFromHashOrLast()
  } else if (!(hashLinkToken() && (await openLink(hashLinkToken())))) {
    openScratch()
  }
  setUpGoogle()
}
start()
