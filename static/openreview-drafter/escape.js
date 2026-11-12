/*
 * Convert "plain LaTeX-in-Markdown" into the form OpenReview needs.
 *
 * Why this is needed: OpenReview runs the text through `marked` (Markdown)
 * first and MathJax second. Markdown treats a backslash before any ASCII
 * punctuation as an escape and removes it, and treats _ * ~ ` < [ as
 * formatting. So `\{`, `\\`, `\,`, `\(` ... lose their backslash, and
 * `a_1 ... b_2` can turn into <em>. MathJax then sees broken TeX.
 *
 * Strategy:
 *  1. Find every math region (the delimiters OpenReview's MathJax accepts:
 *     $...$, $$...$$, \(...\), \[...\], \begin{env}...\end{env}). Code spans
 *     and fenced code blocks are left untouched.
 *  2. Escape each region fully: a backslash before punctuation is always
 *     doubled (Markdown would always eat it). Every other added backslash is
 *     marked as optional.
 *  3. If a Markdown renderer is supplied, minimise: drop each optional
 *     backslash, and keep each multi-line region's line breaks, whenever the
 *     rendered HTML stays identical to the fully escaped version. The result
 *     therefore renders exactly like the safe version, with as few added
 *     characters as possible.
 */
;(function (root) {
  'use strict'

  const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
  // Characters that Markdown may treat as syntax inside a line.
  const ESCAPE_BARE = new Set(['_', '*', '~', '`', '<', '>', '[', ']'])
  const OPT = { opt: true } // an optional backslash

  const isPunct = (c) => c !== undefined && ASCII_PUNCT.includes(c)

  // Remove TeX % comments (but not \%).
  function stripComments(tex) {
    let out = ''
    for (let i = 0; i < tex.length; i++) {
      const c = tex[i]
      if (c === '\\') {
        out += c + (tex[i + 1] ?? '')
        i++
      } else if (c === '%') {
        while (i < tex.length && tex[i] !== '\n') i++
        if (i < tex.length) out += '\n'
      } else {
        out += c
      }
    }
    return out.replace(/[ \t]+\n/g, '\n')
  }

  // Escape one math region (delimiters included) into a list of pieces:
  // strings, plus OPT markers for backslashes that may be unnecessary.
  function escapeMath(tex, flatten) {
    let t = stripComments(tex)
    // Newlines are whitespace to TeX, but to Markdown a line starting with
    // -, +, #, >, =, "1." or a blank line changes the structure.
    if (flatten) t = t.replace(/\n\s*/g, ' ')
    const pieces = []
    for (let i = 0; i < t.length; i++) {
      const c = t[i]
      const next = t[i + 1]
      if (c === '\\' && isPunct(next)) {
        // TeX control symbol such as \{ \, \\ \( : Markdown always eats the
        // backslash, so it must be doubled.
        pieces.push('\\\\')
        if (ESCAPE_BARE.has(next) || next === '\\') pieces.push(OPT)
        pieces.push(next)
        i++
      } else if (ESCAPE_BARE.has(c)) {
        pieces.push(OPT, c)
      } else {
        pieces.push(c)
      }
    }
    return pieces
  }

  // Index of the next unescaped `delim` at or after `from`, or -1.
  // `delim` may be a list of alternatives; returns { at, len } via findCloseAny.
  function findClose(src, from, delim, stopAtBlankLine) {
    const r = findCloseAny(src, from, [delim], stopAtBlankLine)
    return r ? r.at : -1
  }

  function findCloseAny(src, from, delims, stopAtBlankLine) {
    for (let j = from; j < src.length; j++) {
      const d = delims.find((x) => src.startsWith(x, j))
      if (d) return { at: j, len: d.length }
      if (src[j] === '\\') {
        j++
        continue
      }
      if (stopAtBlankLine && src[j] === '\n' && /^\n[ \t]*\n/.test(src.slice(j, j + 50))) {
        return null
      }
    }
    return null
  }

  // Split the source into [{text}] and [{math}] segments.
  function segment(src) {
    const segs = []
    let text = ''
    const pushMath = (tex) => {
      if (text) segs.push({ text })
      text = ''
      segs.push({ math: tex })
    }
    let i = 0
    const n = src.length

    while (i < n) {
      const atLineStart = i === 0 || src[i - 1] === '\n'

      // Fenced code block: copy verbatim.
      if (atLineStart) {
        const m = /^ {0,3}(`{3,}|~{3,})[^\n]*(\n|$)/.exec(src.slice(i))
        if (m) {
          const fence = m[1]
          const closeRe = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$', 'm')
          const cm = closeRe.exec(src.slice(i + m[0].length))
          const end = cm ? i + m[0].length + cm.index + cm[0].length : n
          text += src.slice(i, end)
          i = end
          continue
        }
      }

      const c = src[i]

      // Inline code span: copy verbatim.
      if (c === '`') {
        let k = i
        while (src[k] === '`') k++
        const run = src.slice(i, k)
        const re = new RegExp('(?<!`)' + run + '(?!`)', 'g')
        re.lastIndex = k
        const m = re.exec(src)
        const end = m ? m.index + run.length : k
        text += src.slice(i, end)
        i = end
        continue
      }

      if (c === '\\') {
        const next = src[i + 1]
        if (next === '(' || next === '[') {
          const j = findClose(src, i + 2, next === '(' ? '\\)' : '\\]', next === '(')
          if (j >= 0) {
            pushMath(src.slice(i, j + 2))
            i = j + 2
            continue
          }
        }
        if (src.startsWith('\\begin{', i)) {
          const m = /^\\begin\{([^}]+)\}/.exec(src.slice(i))
          const endTag = '\\end{' + m[1] + '}'
          const j = src.indexOf(endTag, i + m[0].length)
          if (j >= 0) {
            pushMath(src.slice(i, j + endTag.length))
            i = j + endTag.length
            continue
          }
        }
        if (next === '$') {
          // A literal dollar sign: Markdown would turn \$ into $, which
          // MathJax would then read as a math delimiter.
          text += '\\\\$'
          i += 2
          continue
        }
        // Any other Markdown escape in prose: keep as is.
        text += c + (next ?? '')
        i += 2
        continue
      }

      if (c === '$') {
        const display = src[i + 1] === '$'
        const delim = display ? '$$' : '$'
        const j = findClose(src, i + delim.length, delim, !display)
        if (j >= 0) {
          pushMath(src.slice(i, j + delim.length))
          i = j + delim.length
          continue
        }
      }

      text += c
      i++
    }
    if (text) segs.push({ text })
    return segs
  }

  const join = (pieces, dropped) =>
    pieces.map((p, k) => (p === OPT ? (dropped && dropped.has(k) ? '' : '\\') : p)).join('')

  /*
   * opts.render: (markdown) => html, the same Markdown renderer OpenReview
   * uses. Without it the fully escaped (safe but verbose) text is returned.
   */
  function toOpenReview(src, opts = {}) {
    const segs = segment(src)
    const flat = segs.map((s) => (s.math !== undefined ? escapeMath(s.math, true) : [s.text]))
    const render = opts.render
    if (!render) return join(flat.flat())

    // Whitespace differences don't matter: we never touch code blocks, and
    // MathJax treats newlines in TeX as spaces.
    const norm = (html) => html.replace(/\s+/g, ' ')
    const ref = norm(render(join(flat.flat())))
    const same = (pieces, dropped) => norm(render(join(pieces, dropped))) === ref

    // Keep the author's line breaks in multi-line math where that's safe.
    const chosen = flat.slice()
    segs.forEach((s, i) => {
      if (s.math === undefined || !s.math.includes('\n')) return
      const trial = chosen.slice()
      trial[i] = escapeMath(s.math, false)
      if (same(trial.flat())) chosen[i] = trial[i]
    })

    // Drop every optional backslash that isn't needed. Rendering the whole
    // document per trial is slow on long replies, so first minimise each
    // paragraph-sized chunk on its own, then check the whole document.
    const pieces = chosen.flat()
    const minimise = (from, to, isSame) => {
      const dropped = new Set()
      for (let k = from; k < to; k++) {
        if (pieces[k] !== OPT) continue
        dropped.add(k)
        if (!isSame(dropped)) dropped.delete(k)
      }
      return dropped
    }
    const dropped = new Set()
    let start = 0
    for (let k = 0; k <= pieces.length; k++) {
      const boundary = k === pieces.length || (typeof pieces[k] === 'string' && /\n[ \t]*\n/.test(pieces[k]))
      if (!boundary) continue
      const end = Math.min(k + 1, pieces.length)
      const chunk = pieces.slice(start, end)
      if (chunk.includes(OPT)) {
        const chunkRef = norm(render(join(chunk)))
        const local = minimise(start, end, (d) => {
          const shifted = new Set([...d].map((x) => x - start))
          return norm(render(join(chunk, shifted))) === chunkRef
        })
        local.forEach((x) => dropped.add(x))
      }
      start = end
    }
    if (same(pieces, dropped)) return join(pieces, dropped)
    // Chunks interacted (e.g. a list spanning blank lines): do it globally.
    return join(pieces, minimise(0, pieces.length, (d) => same(pieces, d)))
  }

  /*
   * The reverse direction: OpenReview text -> plain LaTeX. Each math region
   * is replaced by the TeX MathJax actually receives (Markdown's backslash
   * escapes removed), so the result is what you would write in a paper.
   */
  function fromOpenReview(src) {
    let out = ''
    let i = 0
    const n = src.length
    // Undo Markdown's backslash escapes, as marked does before MathJax runs.
    const unescape = (s) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1')
    const takeMath = (end) => {
      out += unescape(src.slice(i, end))
      i = end
    }

    while (i < n) {
      const atLineStart = i === 0 || src[i - 1] === '\n'
      if (atLineStart) {
        const m = /^ {0,3}(`{3,}|~{3,})[^\n]*(\n|$)/.exec(src.slice(i))
        if (m) {
          const fence = m[1]
          const closeRe = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$', 'm')
          const cm = closeRe.exec(src.slice(i + m[0].length))
          const end = cm ? i + m[0].length + cm.index + cm[0].length : n
          out += src.slice(i, end)
          i = end
          continue
        }
      }

      const c = src[i]
      if (c === '`') {
        let k = i
        while (src[k] === '`') k++
        const run = src.slice(i, k)
        const re = new RegExp('(?<!`)' + run + '(?!`)', 'g')
        re.lastIndex = k
        const m = re.exec(src)
        const end = m ? m.index + run.length : k
        out += src.slice(i, end)
        i = end
        continue
      }

      if (c === '\\') {
        const next = src[i + 1]
        if (next === '\\') {
          // Opening \\( or \\[ , possibly written \\\( or \\\[
          const open = /^\\\\\\?([([])/.exec(src.slice(i, i + 4))
          if (open) {
            const b = open[1] === '(' ? ')' : ']'
            const r = findCloseAny(src, i + open[0].length, ['\\\\\\' + b, '\\\\' + b], open[1] === '(')
            if (r) {
              takeMath(r.at + r.len)
              continue
            }
          }
          const third = src[i + 2]
          if (third === '$') {
            out += '\\$' // a literal dollar sign
            i += 3
            continue
          }
          out += '\\\\'
          i += 2
          continue
        }
        if (src.startsWith('\\begin{', i)) {
          const m = /^\\begin\{([^}]+)\}/.exec(src.slice(i))
          const endTag = '\\end{' + m[1] + '}'
          const j = src.indexOf(endTag, i + m[0].length)
          if (j >= 0) {
            takeMath(j + endTag.length)
            continue
          }
        }
        if (next === '(' || next === '[' || next === '$') {
          // Markdown shows these as the bare character.
          out += next
          i += 2
          continue
        }
        out += c + (next ?? '')
        i += 2
        continue
      }

      if (c === '$') {
        const display = src[i + 1] === '$'
        const delim = display ? '$$' : '$'
        const j = findClose(src, i + delim.length, delim, !display)
        if (j >= 0) {
          takeMath(j + delim.length)
          continue
        }
      }

      out += c
      i++
    }
    return out
  }

  const api = { toOpenReview, fromOpenReview }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.ORConvert = api
})(typeof window !== 'undefined' ? window : globalThis)
