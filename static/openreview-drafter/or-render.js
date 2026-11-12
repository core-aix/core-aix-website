/*
 * A copy of OpenReview's Markdown pipeline (openreview-web):
 *   client/view.js  setupMarked()   -> marked options + renderer overrides
 *   app/AppInit.js                  -> DOMPurify config + hook
 *   components/NoteContent.js       -> DOMPurify.sanitize(marked(content))
 * MathJax runs afterwards on the resulting DOM (see app.js).
 */
;(function () {
  'use strict'

  // jQuery's $('<div/>').text(s).html() escapes only &, < and >.
  const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const renderer = new marked.Renderer()
  renderer.image = function ({ href, title, text }) {
    if (href.startsWith('/images/')) {
      const titleAttr = title ? 'title="' + title + '" ' : ''
      const classAttr = href.endsWith('_icon.svg') ? 'class="icon" ' : ''
      return '<img src="' + href + '" alt="' + text + '" ' + titleAttr + classAttr + '/>'
    }
    return escapeText('<img src="' + href + '" alt="' + text + '" title="' + title + '">')
  }
  renderer.checkbox = function ({ checked }) {
    return checked ? '[x]' : '[ ]'
  }
  renderer.html = function ({ text }) {
    return escapeText(text)
  }

  marked.setOptions({
    baseUrl: null,
    breaks: false,
    gfm: true,
    headerIds: false,
    langPrefix: 'language-',
    mangle: false,
    renderer,
  })

  // openreview-web lib/utils.js allowedHtmlTags
  const allowedHtmlTags = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'blockquote', 'pre', 'hr',
    'section', 'article', 'header', 'footer', 'figure', 'figcaption', 'details', 'summary',
    'a', 'b', 'i', 'em', 'strong', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup', 'small',
    'mark', 'code', 'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'br', 'wbr',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'img',
  ]
  DOMPurify.setConfig({ ALLOWED_TAGS: allowedHtmlTags })
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    node.removeAttribute?.('style')
    node.removeAttribute?.('action')
    node.removeAttribute?.('formaction')
  })

  window.renderOpenReview = (text) => DOMPurify.sanitize(marked.parse(text))
})()
