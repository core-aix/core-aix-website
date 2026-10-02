/* The projector view for the machine game. It polls the aggregate that the
 * Netlify function builds and redraws the QR code, the tallies, the
 * leaderboard and, once revealed, the class's choices and round totals. */
(function (global) {
  'use strict';

  var API = '/api/machine';
  var POLL_MS = 2500;
  var STORE_KEY = 'machine-dashboard';

  /* The optimal action in each state, marked on the reveal. */
  var OPTIMAL = { fast: 'run', slow: 'service' };

  var el = function (id) { return document.getElementById(id); };

  var settings = { joinUrl: '', adminKey: '' };
  var latest = null;
  var knownIds = {};
  var timer = null;
  var view = 'live';

  /* ---------------------------------------------------------------- */
  /* Settings                                                           */
  /* ---------------------------------------------------------------- */

  function loadSettings() {
    try {
      var raw = global.localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(settings, JSON.parse(raw));
    } catch (err) { /* nothing stored */ }
    var params = new URLSearchParams(global.location.search);
    if (params.get('join')) settings.joinUrl = params.get('join');
  }

  function saveSettings() {
    try { global.localStorage.setItem(STORE_KEY, JSON.stringify(settings)); }
    catch (err) { /* private browsing */ }
  }

  /* ---------------------------------------------------------------- */
  /* QR code                                                            */
  /* ---------------------------------------------------------------- */

  function joinLink() {
    if (!settings.joinUrl) return '';
    var url = settings.joinUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    /* A bare host needs its trailing slash before the query string. */
    if (!/^https?:\/\/[^/?#]+\//i.test(url) && url.indexOf('?') === -1) url += '/';
    return url;
  }

  function renderQR() {
    var host = el('qr');
    var link = joinLink();
    el('join-url').textContent = link || 'set the join link in Controls';
    if (!link) { host.innerHTML = ''; host.dataset.link = ''; return; }
    if (host.dataset.link === link) return;

    var code;
    try { code = global.QR.encode(link); }
    catch (err) { host.innerHTML = ''; el('join-url').textContent = 'the link is too long for a QR code'; return; }

    var quiet = 2;
    var span = code.size + quiet * 2;
    var parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + span + ' ' + span + '" shape-rendering="crispEdges">'];
    parts.push('<rect width="' + span + '" height="' + span + '" fill="#ffffff"/>');
    for (var r = 0; r < code.size; r += 1) {
      var run = 0;
      for (var c = 0; c <= code.size; c += 1) {
        var dark = c < code.size && code.modules[r][c];
        if (dark) { run += 1; continue; }
        if (run > 0) {
          parts.push('<rect x="' + (quiet + c - run) + '" y="' + (quiet + r) +
            '" width="' + run + '" height="1" fill="#0a111a"/>');
          run = 0;
        }
      }
    }
    parts.push('</svg>');
    host.innerHTML = parts.join('');
    host.dataset.link = link;
    host.setAttribute('aria-label', 'QR code for ' + link);
  }

  /* ---------------------------------------------------------------- */
  /* Polling                                                            */
  /* ---------------------------------------------------------------- */

  function poll() {
    /* The choices and the reference totals ride only on the reveal request,
     * so the live page never holds the answer while the class plays. */
    var url = API + '/board?limit=12' + (view === 'reveal' ? '&full=1' : '');
    fetch(url, { headers: { accept: 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.error) throw new Error(data.error);
        latest = data;
        render(data);
        el('status').textContent = 'live, updated ' + new Date().toLocaleTimeString('en-GB');
      })
      .catch(function (err) {
        el('status').textContent = 'no answer from the backend, ' + (err.message || 'retrying');
      });
  }

  function startPolling() {
    if (timer) clearInterval(timer);
    poll();
    timer = setInterval(poll, POLL_MS);
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                          */
  /* ---------------------------------------------------------------- */

  var count = function (n) { return Number(n || 0).toLocaleString('en-GB'); };
  var one = function (x) { return Number(x).toFixed(1); };

  function render(data) {
    var cls = data.class || {};
    el('count-players').textContent = count(cls.players);
    el('count-rounds').textContent = count(cls.rounds);
    el('count-days').textContent = count(cls.days);
    el('join-min').textContent = data.minRankedRounds || 3;
    var open = !data.settings || data.settings.open !== false;
    el('ctl-open').textContent = open ? 'Close joining' : 'Open joining';
    el('bar-sub').textContent = open ? 'live' : 'live, joining closed';

    renderBoard(data.players || []);
    if (view === 'reveal') renderReveal(data.reveal);
  }

  function renderBoard(rows) {
    var list = el('board');
    el('board-empty').hidden = rows.length > 0;
    var rank = 0;
    list.innerHTML = rows.map(function (row) {
      var fresh = !knownIds[row.id || row.name];
      knownIds[row.id || row.name] = true;
      var playing = row.live && row.live.inRound;
      if (row.ranked) rank += 1;
      var classes = (fresh ? 'is-new' : '') + (row.ranked ? '' : ' is-unranked') +
        (playing ? ' is-playing' : '');
      var detail = row.rounds === 1 ? '1 round' : row.rounds + ' rounds';
      if (playing) detail += ', day ' + row.live.day + ', ' + row.live.total + ' so far';
      return '<li class="' + classes.trim() + '">' +
        '<span class="rank">' + (row.ranked ? rank : '') + '</span>' +
        '<span class="who">' + escapeHtml(row.name) + '</span>' +
        '<span class="opt">' + detail + '</span>' +
        '<span class="total">' + (row.mean === null || row.mean === undefined ? '' : one(row.mean)) + '</span>' +
        '</li>';
    }).join('');
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function renderReveal(reveal) {
    if (!reveal) return;
    renderChoices(reveal.choices);
    renderTotals(reveal);
  }

  /* For each state, the share of the class's decisions that were run and
   * that were service, with the optimal action marked. */
  function renderChoices(choices) {
    var host = el('choices');
    host.innerHTML = ['fast', 'slow'].map(function (state) {
      var row = (choices && choices[state]) || { run: 0, service: 0 };
      var total = row.run + row.service;
      var bars = ['run', 'service'].map(function (action) {
        var share = total ? row[action] / total : 0;
        var best = OPTIMAL[state] === action;
        return '<div class="split' + (best ? ' is-best' : '') + '">' +
          '<span class="split-name">' + action + (best ? '<span class="tag">best</span>' : '') + '</span>' +
          '<span class="split-track"><span class="split-fill split-' + action + '" style="width:' +
          (100 * share).toFixed(1) + '%"></span></span>' +
          '<span class="split-share">' + (total ? Math.round(100 * share) + '%' : '') + '</span>' +
          '</div>';
      }).join('');
      var note = total
        ? count(total) + (total === 1 ? ' decision' : ' decisions')
        : 'no decisions yet';
      return '<div class="state-block">' +
        '<h3 class="state-head"><span class="state-badge state-' + state + '">' + state + '</span>' +
        '<span class="state-note">' + note + '</span></h3>' + bars + '</div>';
    }).join('');
  }

  /* The class mean of first rounds and of all rounds against the expected
   * totals of always run and of the optimal policy, as bars on one scale. */
  function renderTotals(reveal) {
    var ref = reveal.reference || {};
    var first = reveal.first || {};
    var all = reveal.all || {};
    var rows = [
      { label: 'The class, first rounds', value: first.meanTotal, kind: 'class',
        note: first.count ? count(first.count) + (first.count === 1 ? ' round' : ' rounds') : 'no rounds yet' },
      { label: 'The class, all rounds', value: all.meanTotal, kind: 'class',
        note: all.rounds ? count(all.rounds) + (all.rounds === 1 ? ' round' : ' rounds') : 'no rounds yet' },
      { label: 'Always run', value: ref.alwaysRun, kind: 'ref', note: 'expected' },
      { label: 'Run when fast, service when slow', value: ref.optimal, kind: 'best', note: 'expected, the best policy' }
    ];
    var top = Math.max.apply(null, rows.map(function (r) { return r.value || 0; }).concat([1]));
    el('totals').innerHTML = rows.map(function (r) {
      var has = r.value !== null && r.value !== undefined;
      return '<div class="total-row total-' + r.kind + '">' +
        '<span class="total-name">' + r.label + '<span class="total-note">' + r.note + '</span></span>' +
        '<span class="split-track"><span class="split-fill" style="width:' +
        (has ? (100 * r.value / top).toFixed(1) : 0) + '%"></span></span>' +
        '<span class="split-share">' + (has ? one(r.value) : '') + '</span>' +
        '</div>';
    }).join('');
    el('totals-note').textContent = 'Each round is short and random, so the class mean ' +
      'moves from round to round. The two policies show the average over very many rounds.';
  }

  /* ---------------------------------------------------------------- */
  /* Controls                                                           */
  /* ---------------------------------------------------------------- */

  function admin(action, patch) {
    var note = el('ctl-note');
    note.textContent = 'working';
    return fetch(API + '/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: settings.adminKey, action: action, settings: patch })
    }).then(function (res) { return res.json(); }).then(function (data) {
      if (data.error) throw new Error(data.error);
      note.textContent = 'done';
      setTimeout(function () { note.textContent = ''; }, 2200);
      poll();
    }).catch(function (err) {
      note.textContent = err.message || 'that did not work';
    });
  }

  function wireControls() {
    el('reveal-toggle').addEventListener('click', function () {
      view = view === 'live' ? 'reveal' : 'live';
      var revealing = view === 'reveal';
      el('view-live').hidden = revealing;
      el('view-reveal').hidden = !revealing;
      this.textContent = revealing ? 'Back to the live board' : 'Reveal the results';
      this.classList.toggle('is-primary', !revealing);
      this.setAttribute('aria-expanded', String(revealing));
      poll();
    });

    el('settings-toggle').addEventListener('click', function () {
      var panel = el('controls');
      panel.hidden = !panel.hidden;
      this.setAttribute('aria-expanded', String(!panel.hidden));
    });

    el('ctl-join').value = settings.joinUrl;
    el('ctl-key').value = settings.adminKey;

    el('ctl-save').addEventListener('click', function () {
      settings.joinUrl = el('ctl-join').value.trim();
      settings.adminKey = el('ctl-key').value;
      saveSettings();
      renderQR();
      startPolling();
      el('ctl-note').textContent = 'saved';
      setTimeout(function () { el('ctl-note').textContent = ''; }, 2200);
    });

    el('ctl-open').addEventListener('click', function () {
      settings.adminKey = el('ctl-key').value;
      var open = latest && latest.settings ? latest.settings.open !== false : true;
      admin('settings', { open: !open });
    });

    el('ctl-wipe').addEventListener('click', function () {
      if (!global.confirm('Delete every player and every score? This cannot be undone.')) return;
      settings.adminKey = el('ctl-key').value;
      knownIds = {};
      admin('wipe');
    });
  }

  loadSettings();
  wireControls();
  renderQR();
  startPolling();
}(window));
