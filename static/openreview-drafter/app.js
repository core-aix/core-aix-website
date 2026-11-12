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
  search,
  indentWithTab,
  createSpellChecker,
  SPELL_LANGUAGES,
  createCommentHighlights,
} from './vendor/collab.js'

/*
 * How it fits together
 *  - Signing in: Google's button gives an ID token; /api/drafts/session checks
 *    it and returns our own session token (30 days), kept in localStorage.
 *  - Each draft is a Liveblocks room holding one Y.Text ("latex"), the plain
 *    LaTeX source. Everyone in the room edits it live.
 *  - The OpenReview Markdown and the preview are derived from that source. Edits
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

- Write in *Standard Markdown*, with equations as in a LaTeX paper.
- *OpenReview Markdown* is what to paste: the same text with the backslashes OpenReview needs.
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
//
// A dialog's "close" event fires a moment after .close(), so it can arrive
// after the next dialog has opened. Only a close the user caused (Escape)
// may cancel the dialog that is open: closes made here are flagged and skipped.
let dialogCancel = null // resolves the open dialog as dismissed
let ignoreClose = 0
$('dialog').addEventListener('close', () => {
  if (ignoreClose > 0) return void ignoreClose--
  const cancel = dialogCancel
  dialogCancel = null
  cancel?.()
})
function closeDialog() {
  const dlg = $('dialog')
  if (!dlg.open) return
  ignoreClose++
  dlg.close()
}

function ask({ title, html = '', fields = [], buttons, onOpen }) {
  const dlg = $('dialog')
  closeDialog() // a dialog replaced by another counts as answered elsewhere
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
    let settled = false
    const finish = (button) => {
      if (settled) return
      settled = true
      const values = {}
      for (const f of fields) values[f.id] = $(`f-${f.id}`)?.value.trim() ?? ''
      dialogCancel = null
      closeDialog()
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
    dialogCancel = () => {
      settled = true
      resolve({ button: null, values: {} })
    }
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

// ---------------------------------------------------------------- spell check
// English (US) unless someone picks another language (remembered per browser).
const DEFAULT_SPELL_LANGUAGE = 'en-US'

const spell = createSpellChecker({
  workerUrl: new URL('./vendor/spell-worker.js', import.meta.url),
  personal: LS.get('ord:dict') || [],
  onStatus: (state, message) => {
    const el = $('spell-status')
    el.textContent = state === 'loading' ? 'Loading dictionary…' : state === 'error' ? 'Dictionary failed' : ''
    el.title = message || ''
    if (state === 'error') toast(message, 'error')
  },
  onMenu: showSpellMenu,
})

function closeSpellMenu() {
  document.getElementById('spell-menu')?.remove()
}

async function showSpellMenu({ view, from, to, word, x, y }) {
  closeSpellMenu()
  const menu = document.createElement('div')
  menu.id = 'spell-menu'
  menu.className = 'spell-menu'
  menu.setAttribute('role', 'menu')
  menu.innerHTML = '<div class="muted">Looking for suggestions…</div>'
  menu.style.left = `${Math.min(x, innerWidth - 230)}px`
  menu.style.top = `${Math.min(y, innerHeight - 260)}px`
  document.body.append(menu)
  const item = (label, fn, cls = '') => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = cls
    b.textContent = label
    b.addEventListener('click', () => {
      closeSpellMenu()
      fn()
      view.focus()
    })
    menu.append(b)
  }
  const list = await spell.suggest(word)
  if (!menu.isConnected) return
  menu.innerHTML = ''
  const editable = !view.state.readOnly
  if (editable) {
    for (const s of list) item(s, () => view.dispatch({ changes: { from, to, insert: s } }), 'suggestion')
    if (!list.length) menu.insertAdjacentHTML('beforeend', '<div class="muted">No suggestions</div>')
    menu.insertAdjacentHTML('beforeend', '<hr>')
  }
  item(`Add “${word}” to dictionary`, () => LS.set('ord:dict', spell.addWord(word)))
  item('Ignore', () => spell.ignoreWord(word))
}
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest?.('#spell-menu')) closeSpellMenu()
})
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSpellMenu())
document.addEventListener('scroll', closeSpellMenu, true)

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
        searchAtTop,
        keymap.of([indentWithTab]),
        EditorView.lineWrapping,
        baseTheme,
        spell.extension,
        orReadOnly.of([]),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet || u.docChanged) scheduleCounts()
          if (u.selectionSet) scheduleCursorMark()
          if (u.transactions.some((t) => t.isUserEvent('input') || t.isUserEvent('delete') || t.isUserEvent('select'))) lastScrolled = 'editor'
          if (!u.docChanged || applyingOr) return
          clearTimeout(orDirtyTimer)
          orDirtyTimer = setTimeout(applyOrEdits, 250)
        }),
      ],
    }),
  })
  watchEditorScroll(orView)
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

// Find and replace opens at the top of the editor: at the bottom, Liveblocks'
// badge covers it.
const searchAtTop = search({ top: true })

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

let handOverText = null // scratch text being turned into a saved draft

function closeDraft() {
  if (!draft) return
  applyOrEditsNow()
  if (draft.creating) handOverText = draft.ytext.toString()
  for (const u of draft.unsubs) u()
  composing = null
  activeComment = null
  $('comment-fab').hidden = true
  spell.forget(draft.latexView)
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
  $('latex-editor').replaceChildren() // never two editors on top of each other
  const undoManager = new Y.UndoManager(d.ytext)
  d.latexView = new EditorView({
    parent: $('latex-editor'),
    state: EditorState.create({
      doc: d.ytext.toString(),
      extensions: [
        keymap.of([...yUndoManagerKeymap, indentWithTab, { key: 'Mod-Alt-m', run: () => startComment() }]),
        basicSetup,
        searchAtTop,
        EditorView.lineWrapping,
        baseTheme,
        placeholder('Write your reply here. Maths as in LaTeX: $x_i$, $$\\sum_i x_i$$ …'),
        yCollab(d.ytext, d.awareness, { undoManager }),
        spell.extension,
        commentMarks.extension,
        readOnlyExt(d.readOnly),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet) {
            scheduleCounts()
            scheduleCursorMark()
          }
          if (u.transactions.some((t) => t.isUserEvent('input') || t.isUserEvent('delete') || t.isUserEvent('select'))) lastScrolled = 'editor'
          if (u.selectionSet || u.focusChanged || u.geometryChanged) updateFab()
        }),
      ],
    }),
  })
  watchEditorScroll(d.latexView)
}

// Recompute the OpenReview Markdown, the preview and the counts from the source.
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
  if (draft.autoCreate && session && latex.trim()) startAutoCreate()
}

// Signed in, no drafts yet: the first thing typed becomes a saved draft.
// Typing can go on while the draft is created; the text is taken over when
// the scratch page is closed.
function startAutoCreate() {
  const d = draft
  d.autoCreate = false
  d.creating = true
  const firstLine = d.ytext.toString().trim().split('\n')[0].replace(/[*#_`$\\]/g, '').trim()
  createDraft(firstLine.slice(0, 60) || 'Untitled draft', () => handOverText ?? '').catch((e) => {
    d.creating = false
    d.autoCreate = true
    toast(e.message, 'error')
  })
}

function attachDerived(d) {
  const handler = (_event, tr) => {
    scheduleDerive()
    scheduleComments()
    if (tr?.local) noteLocalEdit()
    else noteRemoteEdit(d)
  }
  d.ytext.observe(handler)
  d.unsubs.push(() => d.ytext.unobserve(handler))
}

function openScratch(text = SAMPLE, { autoCreate = false } = {}) {
  closeDraft()
  const doc = new Y.Doc()
  const ytext = doc.getText('latex')
  ytext.insert(0, text)
  const d = {
    id: null,
    title: autoCreate ? 'New draft' : 'Scratch draft (not saved)',
    doc,
    ytext,
    awareness: new Awareness(doc),
    unsubs: [],
    initial: text,
    autoCreate,
  }
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
    seen: new Map(), // collaborator name -> when last seen here
    shared: Boolean(link) || (meta.members?.length || 0) > 1,
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
    const text = typeof initialText === 'function' ? initialText() : initialText
    initialText = null
    handOverText = null
    if (text && d.ytext.length === 0) {
      d.ytext.insert(0, text)
      d.latexView.dispatch({ selection: { anchor: text.length } })
      d.latexView.focus()
    }
    updateSyncStatus()
  }
  provider.on('sync', onSync)
  d.unsubs.push(() => provider.off('sync', onSync))
  if (provider.synced) onSync(true)

  const comments = doc.getMap('comments')
  comments.observeDeep(scheduleComments)
  d.unsubs.push(() => comments.unobserveDeep(scheduleComments))
  scheduleComments()
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
function markSeen(d = draft) {
  if (!d?.room || idlePaused || d.room.getStatus() !== 'connected') return
  const now = Date.now()
  for (const [clientId, state] of d.awareness.getStates()) {
    if (clientId !== d.doc.clientID && state?.user?.name) d.seen.set(state.user.name, now)
  }
}

function renderPresence() {
  const box = $('presence')
  box.innerHTML = ''
  markSeen()
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
  markSeen()
  trackLive()
  renderSyncStatus()
  updateConnBanner()
}

function renderSyncStatus() {
  const el = $('sync-status')
  if (!draft) return (el.textContent = '')
  if (!draft.room) {
    el.className = 'sync-status warn'
    el.textContent = online ? 'Not saved' : 'Offline · not saved'
    return
  }
  if (!online) {
    el.className = 'sync-status warn'
    el.textContent = 'Offline'
    el.title = 'No internet connection. Edits are kept in this page and sent when it is back.'
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

// ---------------------------------------------------------------- versions
/*
 * The server keeps versions (see /api/drafts/snapshot). The page asks for one
 * a minute after someone here stops typing, at least every five minutes while
 * they keep typing, and when the page is hidden or goes idle. The server reads
 * the text from Liveblocks itself and skips it if nothing changed.
 */
let snapTimer = null
let snapDirtySince = 0

function noteLocalEdit() {
  if (!draft?.id || draft.readOnly) return
  const now = Date.now()
  if (!snapDirtySince) snapDirtySince = now
  clearTimeout(snapTimer)
  snapTimer = setTimeout(() => snapshotNow(), Math.max(1000, Math.min(60_000, snapDirtySince + 5 * 60_000 - now)))
}

// Resolves once Liveblocks has everything typed here (or after 10 s).
function waitSynced() {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () =>
      !client || client.getSyncStatus() !== 'synchronizing' || Date.now() - start > 10_000
        ? resolve()
        : setTimeout(tick, 300)
    tick()
  })
}

async function snapshotNow({ force = false, keepalive = false } = {}) {
  clearTimeout(snapTimer)
  snapTimer = null
  const d = draft
  if (!d?.id || d.readOnly || (!snapDirtySince && !force)) return
  if (!keepalive) await waitSynced()
  snapDirtySince = 0
  const body = { id: d.id, force, ...(d.guest ? { linkToken: linkTokens.get(d.id), guestName: guestName() } : {}) }
  try {
    const res = await fetch(`${API}/snapshot`, {
      method: 'POST',
      keepalive,
      headers: { ...(session ? { Authorization: `Bearer ${session.token}` } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const r = await res.json().catch(() => ({}))
    // Too soon after the last version: try again when allowed.
    if (r.reason === 'recent' && draft === d && !keepalive) {
      snapDirtySince = snapDirtySince || Date.now()
      snapTimer = setTimeout(() => snapshotNow(), (r.retryIn || 60_000) + 1000)
    }
  } catch {}
}

const flushSnapshot = () => snapDirtySince && snapshotNow({ keepalive: true })
window.addEventListener('pagehide', flushSnapshot)
document.addEventListener('visibilitychange', () => document.hidden && flushSnapshot())

const fmtTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

function downloadText(text, name) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// The versions of a draft (live or deleted): view, download, restore.
async function historyDialog(id, title, { deleted = false } = {}) {
  if (!deleted && draft?.id === id) await snapshotNow({ force: true })
  let versions
  try {
    versions = (await api('versions', { id })).versions
  } catch (e) {
    return toast(e.message, 'error')
  }
  const canRestore = !deleted && draft?.id === id && !draft.readOnly
  const rows = versions.length
    ? versions
        .map(
          (v, i) => `<div class="version" data-key="${esc(v.key)}">
            <div class="who"><b>${esc(fmtTime(v.at))}</b>${i === 0 ? ' <span class="tag">latest</span>' : ''}<br>
              <small>${esc(v.by || '')} · ${v.chars.toLocaleString()} characters${v.note ? ` · ${esc(v.note)}` : ''}</small></div>
            <button type="button" class="link" data-act="view">View</button>
            <button type="button" class="link" data-act="download">Download</button>
            ${canRestore && i > 0 ? '<button type="button" class="link" data-act="restore">Restore</button>' : ''}
          </div>`
        )
        .join('')
    : '<p class="muted">No versions saved yet. One is saved a minute after someone stops typing.</p>'
  await ask({
    title: `Versions of “${title}”`,
    html: `<p class="muted">Saved automatically while people edit, and kept when a draft is deleted.</p>
      <div class="versions">${rows}</div>`,
    buttons: [{ label: 'Close', value: null, kind: 'primary' }],
    onOpen: (body, finish) => {
      body.querySelectorAll('.version button').forEach((btn) =>
        btn.addEventListener('click', async () => {
          const key = btn.closest('.version').dataset.key
          const v = versions.find((x) => x.key === key)
          try {
            if (btn.dataset.act === 'restore') {
              finish(null)
              const r = await ask({
                title: 'Restore this version?',
                html: `<p>The draft will go back to the version from <b>${esc(fmtTime(v.at))}</b> for everyone editing it.</p>
                  <p class="muted">The current text is saved as a version first, so this can be undone.</p>`,
                buttons: [
                  { label: 'Restore', value: 'ok', kind: 'primary' },
                  { label: 'Cancel', value: null },
                ],
              })
              if (r.button !== 'ok') return
              await waitSynced()
              await api('restore-version', { id, key })
              return toast('Version restored.')
            }
            const { version } = await api('version', { id, key })
            const name = `${fileName(title).replace(/\.md$/, '')} ${v.at.slice(0, 16).replace('T', ' ').replace(':', '-')}.md`
            if (btn.dataset.act === 'download') return downloadText(version.text, name)
            finish(null)
            const r = await ask({
              title: `Version from ${fmtTime(v.at)}`,
              html: `<pre class="version-text"></pre>`,
              buttons: [
                { label: 'Download', value: 'download', kind: 'primary' },
                { label: 'Back', value: 'back' },
              ],
              onOpen: (b) => (b.querySelector('.version-text').textContent = version.text || '(empty)'),
            })
            if (r.button === 'download') downloadText(version.text, name)
            if (r.button) historyDialog(id, title, { deleted })
          } catch (e) {
            toast(e.message, 'error')
          }
        })
      )
    },
  })
}

// Drafts deleted by their owner: versions, restore, delete for good.
async function deletedDialog() {
  let list
  try {
    list = (await api('deleted')).drafts
  } catch (e) {
    return toast(e.message, 'error')
  }
  const me = session.user.email
  const rows = list.length
    ? list
        .map(
          (x) => `<div class="version" data-id="${esc(x.id)}">
            <div class="who"><b>${esc(x.title)}</b><br>
              <small>Deleted ${esc(fmtTime(x.deletedAt))} by ${esc(x.deletedBy || '?')}${x.owner === me ? '' : ` · owner ${esc(x.owner)}`}</small></div>
            <button type="button" class="link" data-act="versions">Versions</button>
            ${x.owner === me ? '<button type="button" class="link" data-act="restore">Restore</button><button type="button" class="link danger" data-act="purge">Delete for good</button>' : ''}
          </div>`
        )
        .join('')
    : '<p class="muted">No deleted drafts.</p>'
  await ask({
    title: 'Deleted drafts',
    html: `<p class="muted">Drafts you were part of. Their versions can be viewed and downloaded; the owner can restore them.</p>
      <div class="versions">${rows}</div>`,
    buttons: [{ label: 'Close', value: null, kind: 'primary' }],
    onOpen: (body, finish) => {
      body.querySelectorAll('.version button').forEach((btn) =>
        btn.addEventListener('click', async () => {
          const id = btn.closest('.version').dataset.id
          const x = list.find((d) => d.id === id)
          finish(null)
          try {
            if (btn.dataset.act === 'versions') return historyDialog(id, x.title, { deleted: true })
            if (btn.dataset.act === 'restore') {
              const { draft: meta } = await api('restore-deleted', { id })
              await refreshDrafts()
              await openDraft(meta.id)
              return toast(`Restored “${meta.title}”.`)
            }
            const r = await ask({
              title: 'Delete for good?',
              html: `<p><b>${esc(x.title)}</b> and all its versions will be removed for everyone. This cannot be undone.</p>`,
              buttons: [
                { label: 'Delete for good', value: 'ok', kind: 'danger-solid' },
                { label: 'Cancel', value: null },
              ],
            })
            if (r.button !== 'ok') return deletedDialog()
            await api('purge-deleted', { id })
            toast('Deleted for good.')
          } catch (e) {
            toast(e.message, 'error')
          }
        })
      )
    },
  })
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
  markSeen()
  if (!draft?.room || idlePaused || document.hidden) return
  if (Date.now() - lastActivity < IDLE_MS) return
  if (client?.getSyncStatus() === 'synchronizing') return // never drop unsaved edits
  if (snapDirtySince) return void snapshotNow() // save a version before letting go
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
    const sep = new Option('──────────', '')
    sep.disabled = true
    sel.add(sep)
    sel.add(new Option('Deleted drafts…', '__deleted'))
  }
  const t = $('draft-title')
  t.textContent = draft ? draft.title : ''
  t.disabled = !draft?.id || draft.guest
  $('share').hidden = !draft?.id || draft.guest
  $('history').hidden = !draft?.id || draft.guest
  $('comments-btn').hidden = !draft?.room
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
      ? `<b>View only.</b> “${esc(draft.title)}” was shared with you through a link. You can copy the OpenReview Markdown or download it.`
      : `You are editing “${esc(draft.title)}” through a share link, as <b>${who}</b>${
          session ? '' : ' <button type="button" class="link" id="guest-rename">change name</button>'
        }. Changes are saved for everyone who can open it.`
    $('guest-rename')?.addEventListener('click', renameGuest)
    return
  }
  if (session && draft && !draft.id) {
    b.hidden = false
    b.className = 'banner'
    b.innerHTML = draft.creating
      ? 'Saving as a new draft…'
      : 'You have no drafts yet. Start typing and this becomes a saved draft, or use <b>New</b> or <b>Open file…</b>.'
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
 * Two counts: the standard Markdown (maths written as in LaTeX) and the OpenReview Markdown
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
    el.innerHTML = `Standard ${fmt(latex.length)} · OpenReview <b>${fmt(or.length)}</b> characters`
    el.title = 'Standard: the standard Markdown. OpenReview: the OpenReview Markdown you paste, which OpenReview’s limit applies to. Select text to count part of it.'
    return
  }
  const selLatex = inLatex ? sel : ORConvert.fromOpenReview(sel)
  const selOr = inLatex ? toOR(sel) : sel
  el.classList.add('selection')
  el.innerHTML = `Selected: Standard ${fmt(selLatex.length)} · OpenReview <b>${fmt(selOr.length)}</b> <span class="of">of ${fmt(latex.length)} · ${fmt(or.length)}</span>`
  el.title = `The selection, as ${inLatex ? 'standard Markdown and converted to OpenReview Markdown' : 'OpenReview Markdown and converted back to standard Markdown'}.`
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
    markCursorBlock()
    if (syncOn && lastScrolled !== 'preview') syncFrom('editor')
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
    tab === 'latex' ? 'Maths as in LaTeX, no extra escaping' : 'Exactly what you paste into OpenReview'
  ;(tab === 'latex' ? draft?.latexView : orView)?.requestMeasure()
  scheduleCounts()
  updateFab()
  requestAnimationFrame(() => syncFrom('editor'))
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
    const warning = staleWarning()
    if (warning) toast(`Copied, but ${warning}`, 'error')
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


// ---------------------------------------------------------------- connection: offline, idle, out of date
/*
 * While the page isn't connected (offline, connection lost, or paused while
 * idle), what it shows can be behind what others have written. A banner says
 * so, naming the people who were here recently.
 */
let online = navigator.onLine
window.addEventListener('online', () => {
  online = true
  updateSyncStatus()
})
window.addEventListener('offline', () => {
  online = false
  updateSyncStatus()
})

const RECENT_MS = 10 * 60_000
const isLive = (d = draft) => Boolean(d?.room) && online && !idlePaused && d.room.getStatus() === 'connected'
const nameList = (names) =>
  names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

function othersRecently(d = draft) {
  const now = Date.now()
  return [...(d?.seen || [])].filter(([, t]) => now - t < RECENT_MS).map(([n]) => n)
}

// Note when the connection drops and comes back, to say "caught up" afterwards.
function trackLive() {
  const d = draft
  if (!d?.room) return
  if (isLive(d)) {
    if (d.lostAt) {
      d.lostAt = null
      d.catchingUp = Date.now()
    }
    d.wasLive = true
  } else if (d.wasLive && !d.lostAt) {
    d.lostAt = Date.now()
  }
}

function noteRemoteEdit(d) {
  d.lastRemoteEdit = Date.now()
  if (d.catchingUp && Date.now() - d.catchingUp < 10_000) toast('Updated with changes made while you were away.')
  d.catchingUp = 0
}

function notLive(d = draft) {
  if (!d?.room) return false
  const status = d.room.getStatus()
  return !online || idlePaused || status === 'disconnected' || status === 'reconnecting' || (d.wasLive && status !== 'connected')
}

// Why the text may be out of date, or '' when it isn't.
function staleWarning(d = draft) {
  if (!d?.room) return ''
  if (notLive(d)) {
    const others = othersRecently(d)
    const why = !online ? 'you are offline' : idlePaused ? 'the page is paused while idle' : 'the connection was lost'
    if (others.length) return `${why} and ${nameList(others)} ${others.length > 1 ? 'were' : 'was'} editing, so this may not be the latest version.`
    if (d.shared) return `${why}, so changes others made meanwhile are missing.`
    return ''
  }
  if (d.lastRemoteEdit && Date.now() - d.lastRemoteEdit < 5000) {
    const others = othersRecently(d)
    return `${others.length ? nameList(others) : 'someone'} is still editing, so it may change.`
  }
  return ''
}

function updateConnBanner() {
  const b = $('conn-banner')
  const d = draft
  let html = ''
  if (!online && !d?.room) {
    html = '<b>You are offline.</b> Converting and the preview still work; signing in and saved drafts need a connection.'
  } else if (notLive(d)) {
    const head = !online ? '<b>You are offline.</b>' : idlePaused ? '<b>Paused while idle.</b>' : '<b>Connection lost, reconnecting…</b>'
    const others = othersRecently(d)
    const stale = others.length
      ? `${esc(nameList(others))} ${others.length > 1 ? 'were' : 'was'} also editing, so this <b>may not be the latest version</b>.`
      : d.shared
        ? 'Others with access may have changed it since, so this <b>may not be the latest version</b>.'
        : ''
    const tail = idlePaused
      ? 'Click or type to catch up.'
      : d.readOnly
        ? 'It updates when the connection is back.'
        : 'You can keep editing: your changes stay in this page and merge with theirs when the connection is back. Don’t close the page until it says Saved.'
    html = [head, stale, tail].filter(Boolean).join(' ')
  }
  b.hidden = !html
  b.innerHTML = html
}

// ---------------------------------------------------------------- comments
/*
 * Notes on parts of the text, for signed-in people. They are kept in the
 * draft's Yjs document next to the text (a Y.Map "comments" of Y.Maps), so they
 * sync live like the text. Each one is anchored by Yjs relative positions
 * (the start sticks to the first character, the end to the last), so its range
 * follows edits; if all of its text is deleted the comment stays, marked as
 * such. Highlights show in the standard Markdown editor.
 */
const commentMarks = createCommentHighlights({ onClick: (id) => openComments(id) })
let commentsOpen = false
let activeComment = null
let composing = null // { from, to: relative positions, quote } for a comment being written
let showResolved = false
let commentsFrame = 0
let commentsSig = ''

const canComment = () => Boolean(session && draft?.room && !draft.readOnly)
const me = () => ({
  email: session.user.email,
  name: session.user.name,
  picture: session.user.picture || '',
  color: colourFor(session.user.email),
})
const relPos = (d, index, assoc) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(d.ytext, index, assoc))
function absPos(d, json) {
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), d.doc)
    return abs && abs.type === d.ytext ? abs.index : null
  } catch {
    return null
  }
}

function readComments(d = draft) {
  if (!d?.room) return []
  const out = []
  for (const [id, m] of d.doc.getMap('comments')) {
    if (!(m instanceof Y.Map)) continue
    const c = m.toJSON()
    const from = absPos(d, c.from)
    const to = absPos(d, c.to)
    out.push({ ...c, id, from, to, orphan: from == null || to == null || to <= from, ymap: m })
  }
  out.sort((a, b) => a.orphan - b.orphan || (a.from ?? 0) - (b.from ?? 0) || a.created - b.created)
  return out
}

function scheduleComments() {
  cancelAnimationFrame(commentsFrame)
  commentsFrame = requestAnimationFrame(refreshComments)
}

function refreshComments() {
  const d = draft
  const btn = $('comments-btn')
  if (!d?.room || !d.latexView) {
    if (commentsOpen) closeComments()
    return
  }
  const list = readComments(d)
  const ranges = list.filter((c) => !c.resolved && !c.orphan).map((c) => ({ id: c.id, from: c.from, to: c.to }))
  if (composing) {
    const from = absPos(d, composing.from)
    const to = absPos(d, composing.to)
    if (from != null && to != null) ranges.push({ id: '__new', from, to })
  }
  commentMarks.set(d.latexView, ranges, composing ? '__new' : activeComment)
  const open = list.filter((c) => !c.resolved).length
  btn.textContent = open ? `Comments (${open})` : 'Comments'
  btn.classList.toggle('active', commentsOpen)
  const sig = JSON.stringify([
    list.map((c) => [c.id, c.text, c.resolved, c.replies?.length, c.orphan, c.from]),
    activeComment,
    showResolved,
    Boolean(composing),
    canComment(),
  ])
  if (commentsOpen && sig !== commentsSig) renderCommentsPanel(list)
  commentsSig = commentsOpen ? sig : ''
}

function openComments(id) {
  if (!draft?.room) return
  commentsOpen = true
  if (id) {
    activeComment = id
    composing = null
  }
  $('comments-panel').hidden = false
  commentsSig = ''
  refreshComments()
  if (id) $('comments-panel').querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
}

function closeComments() {
  commentsOpen = false
  activeComment = null
  composing = null
  $('comments-panel').hidden = true
  scheduleComments()
}

$('comments-btn').addEventListener('click', () => (commentsOpen ? closeComments() : openComments()))

function startComment() {
  const d = draft
  if (!d?.latexView) return false
  if (!d.room) return toast('Sign in to save drafts and comment on them.'), true
  if (!canComment()) return toast(session ? 'This draft is view only.' : 'Sign in with Google to comment.'), true
  if (prefs.tab !== 'latex') showTab('latex')
  const r = d.latexView.state.selection.main
  if (r.empty) return toast('Select some text in Standard Markdown first.'), true
  composing = { from: relPos(d, r.from, 0), to: relPos(d, r.to, -1), quote: d.latexView.state.sliceDoc(r.from, r.to).slice(0, 400) }
  activeComment = null
  $('comment-fab').hidden = true
  openComments()
  requestAnimationFrame(() => $('comments-panel').querySelector('textarea[data-for="__new"]')?.focus())
  return true
}

const clip = (s, n = 140) => (s.length > n ? s.slice(0, n).trimEnd() + '…' : s)
const ago = (t) => {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function renderCommentsPanel(list = readComments()) {
  const panel = $('comments-panel')
  // Keep what people are typing across re-renders.
  const typed = new Map([...panel.querySelectorAll('textarea[data-for]')].map((t) => [t.dataset.for, t.value]))
  const focused = document.activeElement?.closest?.('#comments-panel textarea')?.dataset.for
  const mine = session?.user.email
  const can = canComment()
  const open = list.filter((c) => !c.resolved)
  const resolved = list.filter((c) => c.resolved)
  const head = (who, when) =>
    `<div class="c-head"><span class="c-av" data-name="${esc(who?.name || '?')}" data-pic="${esc(who?.picture || '')}" data-color="${esc(who?.color || '#999')}"></span><b>${esc(who?.name || 'Someone')}</b><small>${esc(ago(when))}</small></div>`
  const card = (c) => {
    const quote = c.orphan
      ? `<div class="c-quote orphan" title="${esc(c.quote || '')}">The text this was on has been removed: “${esc(clip(c.quote || ''))}”</div>`
      : `<button type="button" class="c-quote" data-act="goto" title="Show in the editor">“${esc(clip(c.quote || ''))}”</button>`
    const replies = (c.replies || []).map((r) => `<div class="c-reply">${head(r.author, r.created)}<div class="c-text">${esc(r.text)}</div></div>`).join('')
    const canDelete = can && (c.author?.email === mine || draft.owner === mine)
    const actions = can
      ? `<div class="c-actions">
          ${c.resolved ? '' : `<textarea data-for="${esc(c.id)}" rows="1" placeholder="Reply…"></textarea><button type="button" data-act="reply">Reply</button>`}
          <button type="button" data-act="${c.resolved ? 'reopen' : 'resolve'}">${c.resolved ? 'Reopen' : 'Resolve'}</button>
          ${canDelete ? '<button type="button" class="danger" data-act="delete">Delete</button>' : ''}
        </div>`
      : ''
    const resolvedNote = c.resolved ? `<div class="c-resolved">Resolved by ${esc(c.resolved.by || 'someone')} · ${esc(ago(c.resolved.at))}</div>` : ''
    return `<div class="comment${c.id === activeComment ? ' active' : ''}${c.resolved ? ' resolved' : ''}" data-id="${esc(c.id)}">
      ${head(c.author, c.created)}${quote}<div class="c-text">${esc(c.text)}</div>${replies}${resolvedNote}${actions}</div>`
  }
  const composer = composing
    ? `<div class="comment composing" data-id="__new"><div class="c-quote">“${esc(clip(composing.quote))}”</div>
        <textarea data-for="__new" rows="3" placeholder="Add a comment… (Ctrl/⌘ + Enter to post)"></textarea>
        <div class="c-actions"><button type="button" class="primary" data-act="post">Comment</button><button type="button" data-act="cancel">Cancel</button></div></div>`
    : ''
  const hint = !session
    ? '<p class="c-hint">Sign in with Google to add comments.</p>'
    : !can
      ? '<p class="c-hint">This draft is view only.</p>'
      : composing
        ? ''
        : '<p class="c-hint">Select text in <b>Standard Markdown</b> and click <b>💬 Comment</b> (or Ctrl/⌘ + Alt + M).</p>'
  panel.innerHTML = `<div class="c-top"><b>Comments</b><button type="button" class="c-close" data-act="close" aria-label="Close comments">×</button></div>
    <div class="c-list">${hint}${composer}${open.map(card).join('') || (composing ? '' : '<p class="c-empty">No open comments.</p>')}
    ${resolved.length ? `<button type="button" class="link c-toggle" data-act="toggle-resolved">${showResolved ? 'Hide' : 'Show'} resolved (${resolved.length})</button>` : ''}
    ${showResolved ? resolved.map(card).join('') : ''}</div>`
  for (const el of panel.querySelectorAll('.c-av')) {
    el.replaceWith(avatar({ name: el.dataset.name, avatar: el.dataset.pic, color: el.dataset.color }, el.dataset.name))
  }
  for (const t of panel.querySelectorAll('textarea[data-for]')) {
    if (typed.has(t.dataset.for)) t.value = typed.get(t.dataset.for)
    if (t.dataset.for === focused) t.focus()
  }
}

function findComment(id) {
  const m = draft?.doc.getMap('comments').get(id)
  return m instanceof Y.Map ? m : null
}

function showCommentInEditor(id) {
  const c = readComments().find((x) => x.id === id)
  if (!c || c.orphan) return
  if (prefs.tab !== 'latex') showTab('latex')
  const v = draft.latexView
  v.dispatch({ selection: { anchor: c.from, head: c.to }, effects: EditorView.scrollIntoView(c.from, { y: 'center' }) })
  v.focus()
}

async function commentAction(act, id, card) {
  const d = draft
  if (act === 'close') return closeComments()
  if (act === 'toggle-resolved') {
    showResolved = !showResolved
    return refreshComments()
  }
  if (act === 'cancel') {
    composing = null
    return refreshComments()
  }
  if (act === 'post') {
    const text = card.querySelector('textarea').value.trim()
    if (!text || !composing || !canComment()) return
    const m = new Y.Map()
    const c = composing
    d.doc.transact(() => {
      d.doc.getMap('comments').set(crypto.randomUUID(), m)
      m.set('from', c.from)
      m.set('to', c.to)
      m.set('quote', c.quote)
      m.set('text', text.slice(0, 5000))
      m.set('author', me())
      m.set('created', Date.now())
      m.set('resolved', null)
      m.set('replies', new Y.Array())
    }, 'comments')
    composing = null
    return refreshComments()
  }
  activeComment = id
  if (act === 'goto') {
    refreshComments()
    return showCommentInEditor(id)
  }
  const m = findComment(id)
  if (!m || !canComment()) return
  if (act === 'reply') {
    const t = card.querySelector('textarea')
    const text = t.value.trim()
    if (!text) return t.focus()
    t.value = ''
    m.get('replies')?.push([{ author: me(), text: text.slice(0, 5000), created: Date.now() }])
  } else if (act === 'resolve') {
    m.set('resolved', { by: session.user.name, at: Date.now() })
    activeComment = null
  } else if (act === 'reopen') {
    m.set('resolved', null)
  } else if (act === 'delete') {
    const r = await ask({
      title: 'Delete this comment?',
      html: '<p>The comment and its replies are removed for everyone.</p>',
      buttons: [
        { label: 'Delete', value: 'ok', kind: 'danger-solid' },
        { label: 'Cancel', value: null },
      ],
    })
    if (r.button !== 'ok') return
    d.doc.getMap('comments').delete(id)
    activeComment = null
  }
  refreshComments()
}

$('comments-panel').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]')
  const card = e.target.closest('.comment')
  if (b) return void commentAction(b.dataset.act, card?.dataset.id, card)
  if (card && card.dataset.id !== '__new' && card.dataset.id !== activeComment && !e.target.closest('textarea')) {
    activeComment = card.dataset.id
    refreshComments()
  }
})
$('comments-panel').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.matches('textarea')) {
    e.preventDefault()
    const card = e.target.closest('.comment')
    commentAction(card.dataset.id === '__new' ? 'post' : 'reply', card.dataset.id, card)
  } else if (e.key === 'Escape' && composing) {
    composing = null
    refreshComments()
  }
})

// The floating "Comment" button next to a selection in the standard Markdown editor.
const fab = $('comment-fab')
function updateFab() {
  const v = draft?.latexView
  const r = v?.state.selection.main
  if (!v || !canComment() || prefs.tab !== 'latex' || !r || r.empty || !v.hasFocus) return void (fab.hidden = true)
  const c = v.coordsAtPos(r.head)
  const host = $('latex-editor').getBoundingClientRect()
  if (!c || c.bottom < host.top || c.top > host.bottom) return void (fab.hidden = true)
  fab.hidden = false
  const top = Math.min(Math.max(c.bottom + 6, host.top + 4), host.bottom - fab.offsetHeight - 4)
  fab.style.top = `${top}px`
  fab.style.left = `${Math.max(host.left + 4, Math.min(c.left, host.right - fab.offsetWidth - 12))}px`
}
fab.addEventListener('pointerdown', (e) => e.preventDefault()) // keep the editor's selection
fab.addEventListener('click', () => startComment())

// ---------------------------------------------------------------- editor ⇄ preview position
/*
 * The text is split into Markdown blocks (paragraphs, lists, headings, …) with
 * marked's lexer, which matches the preview's top-level elements one to one.
 * Scrolling either side scrolls the other to the same block (and the same
 * fraction of it); the block with the cursor is marked in the preview, and
 * double-clicking the preview moves the editor there. If the blocks don't
 * line up, scrolling falls back to the same fraction of the whole.
 */
let syncOn = prefs.sync !== false
let lastScrolled = 'editor'
let ignoreScroll = { editor: 0, preview: 0 } // our own scrolls, not to be echoed back
const previewScroll = $('preview-scroll')
const blockCache = new Map()

function blocksOf(text) {
  if (blockCache.has(text)) return blockCache.get(text)
  const out = []
  let pos = 0
  try {
    for (const t of marked.lexer(text)) {
      if (t.type !== 'space' && t.type !== 'def') out.push({ from: pos, to: pos + t.raw.length })
      pos += t.raw.length
    }
  } catch {
    /* fall back to proportional scrolling */
  }
  if (blockCache.size > 4) blockCache.clear()
  blockCache.set(text, out)
  return out
}

const activeView = () => (prefs.tab === 'latex' ? draft?.latexView : orView)

// The editor's blocks and the preview's elements, when they line up.
function blockMap() {
  const view = activeView()
  if (!view) return null
  const blocks = blocksOf(view.state.doc.toString())
  const els = [...preview.children]
  return blocks.length && blocks.length === els.length ? { view, blocks, els } : { view, blocks: null, els }
}

function elBox(el) {
  const top = el.getBoundingClientRect().top - previewScroll.getBoundingClientRect().top + previewScroll.scrollTop
  return { top, bottom: top + el.getBoundingClientRect().height }
}
function lineBox(view, { from, to }) {
  const end = Math.max(from, Math.min(to, view.state.doc.length) - 1)
  return { top: view.lineBlockAt(from).top, bottom: view.lineBlockAt(end).bottom }
}

// Which box the position y falls in (or the next one), and how far through it.
function locate(boxes, y) {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]
    if (b.bottom > y) return { i, frac: b.bottom > b.top ? Math.max(0, Math.min(1, (y - b.top) / (b.bottom - b.top))) : 0 }
  }
  return null
}

function ownScroll(target, el) {
  ignoreScroll[target] = Date.now()
  return el
}

function syncFrom(source, refine = true) {
  if (!syncOn || !draft) return
  const m = blockMap()
  if (!m) return
  const ed = m.view.scrollDOM
  const [from, to] = source === 'editor' ? [ed, previewScroll] : [previewScroll, ed]
  const target = source === 'editor' ? 'preview' : 'editor'
  const max = (el) => el.scrollHeight - el.clientHeight
  let y
  if (from.scrollTop <= 1) y = 0
  else if (from.scrollTop >= max(from) - 1) y = max(to)
  else if (m.blocks) {
    const edBoxes = m.blocks.map((b) => lineBox(m.view, b))
    const pvBoxes = m.els.map(elBox)
    const [src, dst] = source === 'editor' ? [edBoxes, pvBoxes] : [pvBoxes, edBoxes]
    // In the editor, measure from below its top padding.
    const offset = source === 'editor' ? m.view.documentTop - ed.getBoundingClientRect().top + ed.scrollTop : 0
    const hit = locate(src, from.scrollTop - offset)
    if (!hit) y = max(to)
    else {
      const b = dst[hit.i]
      const dOffset = target === 'editor' ? m.view.documentTop - ed.getBoundingClientRect().top + ed.scrollTop : 0
      y = b.top + hit.frac * (b.bottom - b.top) + dOffset
    }
  } else {
    y = (from.scrollTop / Math.max(1, max(from))) * max(to)
  }
  if (Math.abs(to.scrollTop - y) < 2) return
  ownScroll(target, to).scrollTop = y
  // The editor only knows the real height of lines it has drawn; once it has
  // drawn the new ones, correct the position.
  if (refine && target === 'editor') requestAnimationFrame(() => requestAnimationFrame(() => syncFrom(source, false)))
}

let syncFrame = 0
function onScrolled(source) {
  if (Date.now() - ignoreScroll[source] < 120) return // the echo of our own scroll
  lastScrolled = source
  if (source === 'editor') updateFab()
  if (!syncOn) return
  cancelAnimationFrame(syncFrame)
  syncFrame = requestAnimationFrame(() => syncFrom(source))
}
function watchEditorScroll(view) {
  view.scrollDOM.addEventListener('scroll', () => view === activeView() && onScrolled('editor'), { passive: true })
}
previewScroll.addEventListener('scroll', () => onScrolled('preview'), { passive: true })

// Mark the preview block that holds the editor's cursor.
let cursorFrame = 0
function scheduleCursorMark() {
  cancelAnimationFrame(cursorFrame)
  cursorFrame = requestAnimationFrame(markCursorBlock)
}
function markCursorBlock() {
  preview.querySelector(':scope > .sync-current')?.classList.remove('sync-current')
  if (!syncOn) return
  const m = blockMap()
  if (!m?.blocks) return
  const head = m.view.state.selection.main.head
  let i = m.blocks.findIndex((b) => head < b.to)
  if (i < 0) i = m.blocks.length - 1
  m.els[i]?.classList.add('sync-current')
}

// Double-click in the preview: put the editor's cursor at that block.
preview.addEventListener('dblclick', (e) => {
  const m = blockMap()
  if (!m) return
  const el = [...preview.children].find((c) => c.contains(e.target))
  if (!el) return
  const i = m.els.indexOf(el)
  let pos
  if (m.blocks) pos = m.blocks[i].from
  else pos = Math.round((i / Math.max(1, m.els.length)) * m.view.state.doc.length)
  const line = m.view.state.doc.lineAt(pos)
  window.getSelection()?.removeAllRanges()
  m.view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 40 }) })
  m.view.focus()
  lastScrolled = 'editor'
  requestAnimationFrame(() => syncFrom('editor'))
})

function setSync(on) {
  syncOn = on
  prefs.sync = on
  savePrefs()
  const b = $('sync-scroll')
  b.setAttribute('aria-pressed', String(on))
  b.classList.toggle('on', on)
  markCursorBlock()
  if (on) syncFrom('editor')
}
$('sync-scroll').addEventListener('click', () => setSync(!syncOn))

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
  const v = e.target.value
  if (v === '__deleted') {
    e.target.value = draft?.id || ''
    return deletedDialog()
  }
  if (v) openDraft(v)
})
$('history').addEventListener('click', () => historyDialog(draft.id, draft.title))

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
    html: `<p><b>${esc(draft.title)}</b> will be deleted for everyone it is shared with.</p>
      <p class="muted">Its versions are kept: you can restore it later from <b>Deleted drafts…</b> in the drafts list,
      and anyone it was shared with can still download them.</p>`,
    buttons: [
      { label: 'Delete for everyone', value: 'delete', kind: 'danger-solid' },
      { label: 'Cancel', value: null },
    ],
  })
  if (r.button !== 'delete') return
  try {
    const id = draft.id
    await waitSynced() // the server saves the text as Liveblocks has it
    await api('delete', { id })
    closeDraft()
    drafts = drafts.filter((x) => x.id !== id)
    LS.del('ord:last')
    history.replaceState(null, '', location.pathname)
    toast('Draft deleted. Restore it from “Deleted drafts…” in the list.')
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

// ---------------------------------------------------------------- splitter
/*
 * The bar between the editor and the preview. Drag it, or focus it and use
 * the arrow keys (Shift for bigger steps); double-click resets it. Side by
 * side it sets the editor's width; stacked (narrow screens) its height.
 */
const mainEl = document.querySelector('main')
const splitter = $('splitter')
const stackedQuery = matchMedia('(max-width: 760px)')
const SPLIT_MIN = 15
const SPLIT_MAX = 85

function setSplit(pct, save = true) {
  const v = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct))
  prefs.split = Math.round(v * 10) / 10
  mainEl.style.setProperty('--split', `${prefs.split}%`)
  splitter.setAttribute('aria-valuenow', String(Math.round(prefs.split)))
  if (save) savePrefs()
}
function syncOrientation() {
  const stacked = stackedQuery.matches
  document.body.classList.toggle('stacked', stacked)
  splitter.setAttribute('aria-orientation', stacked ? 'horizontal' : 'vertical')
}
splitter.setAttribute('aria-valuemin', String(SPLIT_MIN))
splitter.setAttribute('aria-valuemax', String(SPLIT_MAX))
stackedQuery.addEventListener('change', syncOrientation)
syncOrientation()

splitter.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  e.preventDefault()
  splitter.setPointerCapture(e.pointerId)
  splitter.classList.add('dragging')
  document.body.classList.add('resizing')
  const rect = mainEl.getBoundingClientRect()
  const move = (ev) => {
    const pct = stackedQuery.matches
      ? ((ev.clientY - rect.top) / rect.height) * 100
      : ((ev.clientX - rect.left) / rect.width) * 100
    setSplit(pct, false)
  }
  const up = () => {
    splitter.removeEventListener('pointermove', move)
    splitter.removeEventListener('pointerup', up)
    splitter.removeEventListener('pointercancel', up)
    splitter.classList.remove('dragging')
    document.body.classList.remove('resizing')
    savePrefs()
  }
  splitter.addEventListener('pointermove', move)
  splitter.addEventListener('pointerup', up)
  splitter.addEventListener('pointercancel', up)
})
splitter.addEventListener('dblclick', () => setSplit(50))
splitter.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 10 : 2
  const back = stackedQuery.matches ? 'ArrowUp' : 'ArrowLeft'
  const fwd = stackedQuery.matches ? 'ArrowDown' : 'ArrowRight'
  if (e.key === back) setSplit(prefs.split - step)
  else if (e.key === fwd) setSplit(prefs.split + step)
  else if (e.key === 'Home') setSplit(SPLIT_MIN)
  else if (e.key === 'End') setSplit(SPLIT_MAX)
  else return
  e.preventDefault()
})

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
  // Signed in with no drafts: an empty page that becomes a saved draft as
  // soon as something is typed (see startAutoCreate).
  openScratch('', { autoCreate: true })
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
  setSync(syncOn)
  setZoom(Number(prefs.zoom) || 1)
  setSplit(Number(prefs.split) || 50, false)
  const langSel = $('spell-lang')
  langSel.add(new Option('Spelling: off', 'off'))
  for (const [code, { label }] of Object.entries(SPELL_LANGUAGES)) langSel.add(new Option(label, code))
  langSel.value = (SPELL_LANGUAGES[prefs.spell] || prefs.spell === 'off') ? prefs.spell : DEFAULT_SPELL_LANGUAGE
  langSel.addEventListener('change', () => {
    prefs.spell = langSel.value
    savePrefs()
    spell.setLanguage(langSel.value === 'off' ? null : langSel.value)
  })
  spell.setLanguage(langSel.value === 'off' ? null : langSel.value)
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
