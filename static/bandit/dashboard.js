/* The projector view. It polls the aggregate that the Netlify function builds
 * and redraws the QR code, the tallies, the leaderboard and the two curves. */
(function (global) {
  'use strict';

  var API = '/api/bandit';
  var POLL_MS = 2500;
  var STORE_KEY = 'bandit-dashboard';

  var SERIES = [
    { key: 'students', label: 'The class', colour: 'var(--series-students)' },
    { key: 'eps', label: 'Epsilon 0.1', colour: 'var(--series-eps)' },
    { key: 'ucb', label: 'UCB c=0.7', colour: 'var(--series-ucb)' },
    { key: 'greedy', label: 'Greedy', colour: 'var(--series-greedy)' }
  ];

  var el = function (id) { return document.getElementById(id); };

  var settings = { session: 'l02', joinUrl: '', adminKey: '' };
  var latest = null;
  var knownNames = {};
  var timer = null;
  var view = 'live';
  var zoom = 0;            /* pulls to plot, 0 meaning all of them */

  /* ---------------------------------------------------------------- */
  /* Settings                                                           */
  /* ---------------------------------------------------------------- */

  function loadSettings() {
    try {
      var raw = global.localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(settings, JSON.parse(raw));
    } catch (err) { /* nothing stored */ }
    var params = new URLSearchParams(global.location.search);
    if (params.get('s')) settings.session = params.get('s');
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
    var joiner = url.indexOf('?') === -1 ? '?' : '&';
    return url + joiner + 's=' + encodeURIComponent(settings.session);
  }

  function renderQR() {
    var host = el('qr');
    var link = joinLink();
    el('join-url').textContent = link || 'set the join link in Controls';
    if (!link) { host.innerHTML = ''; return; }
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
    /* The curves and the arm split ride only on the reveal request, so the
     * live page is not holding the answer in memory while the class plays. */
    var url = API + '/board?session=' + encodeURIComponent(settings.session) +
      '&limit=10' + (view === 'reveal' ? '&full=1' : '');
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

  function render(data) {
    el('count-joined').textContent = data.counts.joined;
    el('count-pulls').textContent = data.counts.pulls || 0;
    el('join-min').textContent = data.minRankedPulls || 10;
    el('ctl-arms').value = data.settings.k;
    el('ctl-open').textContent = data.settings.open ? 'Close joining' : 'Open joining';
    el('bar-sub').innerHTML = 'Session <span id="session-name">' + escapeHtml(data.session) + '</span>' +
      (data.settings.open ? '' : ', joining closed');

    var pulls = data.counts.pulls || 0;
    el('hero-paid').textContent = pulls ? Math.round(100 * data.counts.paid) + '%' : '–';
    el('hero-sub').textContent = pulls
      ? (data.counts.wins || 0).toLocaleString('en-GB') + ' wins from ' +
        pulls.toLocaleString('en-GB') + ' pulls'
      : 'of every pull, so far';

    renderBoard(data.leaderboard);
    if (view === 'reveal') {
      renderArms(data.arms || []);
      renderCharts(data);
    }
  }

  /* The per arm split, which is the answer to the game. */
  function renderArms(arms) {
    var host = el('arms-split');
    if (!arms.length) {
      host.innerHTML = '<p class="card-sub">Nobody has pulled an arm yet.</p>';
      el('arms-note').textContent = '';
      return;
    }
    var top = Math.max.apply(null, arms.map(function (a) { return a.share; })) || 1;
    host.innerHTML = arms.map(function (a, i) {
      var best = i === 0;
      return '<div class="arm-split' + (best ? ' is-best' : '') + '">' +
        '<span class="arm-split-rate">pays ' + Math.round(100 * a.rate) + '%</span>' +
        '<span class="arm-split-track"><span class="arm-split-fill" style="width:' +
        (100 * a.share / top).toFixed(1) + '%"></span></span>' +
        '<span class="arm-split-share">' + Math.round(100 * a.share) + '%</span>' +
        '</div>';
    }).join('');
    var bestShare = Math.round(100 * arms[0].share);
    el('arms-note').textContent = 'The class sent ' + bestShare +
      ' per cent of its pulls to the best arm. Pulling at random would send ' +
      Math.round(100 / arms.length) + ' per cent.';
  }

  function renderBoard(rows) {
    var list = el('board');
    el('board-empty').hidden = rows.length > 0;
    list.innerHTML = rows.map(function (row, i) {
      var fresh = !knownNames[row.id];
      knownNames[row.id] = true;
      var classes = (fresh ? 'is-new' : '') + (row.ranked ? '' : ' is-unranked') +
        (row.playing ? ' is-playing' : '');
      return '<li class="' + classes.trim() + '">' +
        '<span class="rank">' + (row.ranked ? i + 1 : '–') + '</span>' +
        '<span class="who">' + escapeHtml(row.name) + '</span>' +
        '<span class="opt">' + row.pulls + ' pulls</span>' +
        '<span class="total">' + Math.round(row.avg * 100) + '%</span>' +
        '</li>';
    }).join('');
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* Centred moving average. A per-step mean over a few dozen students is far
   * too noisy to project, and the shape is what the lecture is after. */
  function smooth(values, window) {
    var half = Math.floor(window / 2);
    return values.map(function (_, i) {
      var sum = 0, n = 0;
      for (var j = i - half; j <= i + half; j += 1) {
        if (j < 0 || j >= values.length || values[j] === null) continue;
        sum += values[j];
        n += 1;
      }
      return n ? sum / n : null;
    });
  }

  function renderCharts(data) {
    var curves = data.curves;
    if (!curves || !curves.n) {
      drawChart(el('chart-reward'), [], { empty: 'Curves appear once a student has pulled ten times.' });
      drawChart(el('chart-optimal'), [], { empty: 'Curves appear once a student has pulled ten times.' });
      el('legend-reward').innerHTML = '';
      el('legend-optimal').innerHTML = '';
      el('table-view').innerHTML = '';
      return;
    }

    var full = curves.steps || curves.students.r.length;
    var steps = zoom ? Math.min(zoom, full) : full;
    var window = Math.max(5, Math.round(steps / 12));
    var clip = function (values) { return values.slice(0, steps); };

    /* The tail of the curve rests on fewer and fewer students, so say where it
     * thins instead of leaving the room to wonder why it wanders. */
    var support = curves.support || [];
    var atEnd = support.length >= steps ? support[steps - 1] : curves.n;
    el('zoom-note').textContent = full
      ? 'out of ' + full + ' pulls, and ' + atEnd + ' of ' + curves.n +
        ' students reached pull ' + steps
      : '';

    var rewardSeries = SERIES.map(function (s) {
      return {
        key: s.key, label: s.label, colour: s.colour,
        values: clip(smooth(curves[s.key].r, window)).map(function (v) {
          return v === null ? null : v * 100;
        })
      };
    });
    var optimalSeries = SERIES.map(function (s) {
      return {
        key: s.key, label: s.label, colour: s.colour,
        values: clip(smooth(curves[s.key].o, window)).map(function (v) { return v === null ? null : v * 100; })
      };
    });

    drawChart(el('chart-reward'), rewardSeries, {
      yLabel: 'per cent',
      yMin: 0,
      yMax: 100,
      format: function (v) { return Math.round(v) + '%'; },
      reference: { value: 100 * curves.optimalMean, label: 'best arm' }
    });
    drawChart(el('chart-optimal'), optimalSeries, {
      yLabel: 'per cent',
      yMin: 0,
      yMax: 100,
      format: function (v) { return Math.round(v) + '%'; }
    });

    renderLegend(el('legend-reward'), rewardSeries, true);
    renderLegend(el('legend-optimal'), optimalSeries, false);
    renderTable(data, rewardSeries, optimalSeries);
  }

  function renderLegend(host, series, withReference) {
    var items = series.map(function (s) {
      return '<span class="legend-item"><span class="legend-swatch" style="background:' + s.colour +
        '"></span>' + s.label + '</span>';
    });
    if (withReference) {
      items.push('<span class="legend-item"><span class="legend-swatch is-dashed" style="color:var(--series-optimal)">' +
        '</span>Best arm on average</span>');
    }
    host.innerHTML = items.join('');
  }

  function renderTable(data, rewardSeries, optimalSeries) {
    var last = function (values) {
      for (var i = values.length - 1; i >= 0; i -= 1) if (values[i] !== null) return values[i];
      return null;
    };
    var mean = function (values) {
      var sum = 0, n = 0;
      values.forEach(function (v) { if (v !== null) { sum += v; n += 1; } });
      return n ? sum / n : null;
    };
    var rows = rewardSeries.map(function (s, i) {
      var o = optimalSeries[i];
      var show = function (v) { return v === null ? '–' : Math.round(v) + '%'; };
      return '<tr><td>' + s.label + '</td>' +
        '<td>' + show(mean(s.values)) + '</td>' +
        '<td>' + show(last(s.values)) + '</td>' +
        '<td>' + show(last(o.values)) + '</td></tr>';
    }).join('');
    el('table-view').innerHTML =
      '<table><caption class="card-sub">Averaged over ' + data.curves.n +
      ' first rounds, out to ' + data.curves.steps + ' pulls.</caption>' +
      '<thead><tr><th>Series</th><th>Paid, mean</th>' +
      '<th>Paid, at the end</th><th>Best arm, at the end</th></tr></thead><tbody>' +
      rows + '</tbody></table>';
  }

  /* ---------------------------------------------------------------- */
  /* The line chart                                                     */
  /* ---------------------------------------------------------------- */

  var NS = 'http://www.w3.org/2000/svg';

  function node(name, attrs, text) {
    var n = document.createElementNS(NS, name);
    Object.keys(attrs || {}).forEach(function (key) { n.setAttribute(key, attrs[key]); });
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function drawChart(svg, series, options) {
    options = options || {};
    var width = svg.clientWidth || 880;
    var height = svg.clientHeight || 260;
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    if (!series.length) {
      svg.appendChild(node('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'axis-text' },
        options.empty || ''));
      return;
    }

    /* Room for the 17px axis text and the end labels beside the lines. */
    var pad = { top: 18, right: 132, bottom: 46, left: 68 };
    var plotW = Math.max(10, width - pad.left - pad.right);
    var plotH = Math.max(10, height - pad.top - pad.bottom);
    var steps = series[0].values.length;

    var values = [];
    series.forEach(function (s) { s.values.forEach(function (v) { if (v !== null) values.push(v); }); });
    if (options.reference) values.push(options.reference.value);
    var lo = options.yMin !== undefined ? options.yMin : Math.min.apply(null, values);
    var hi = options.yMax !== undefined ? options.yMax : Math.max.apply(null, values);
    if (hi - lo < 1e-6) { hi = lo + 1; }
    if (options.yMin === undefined) { lo = lo - (hi - lo) * 0.08; }
    if (options.yMax === undefined) { hi = hi + (hi - lo) * 0.08; }

    var x = function (i) { return pad.left + (steps < 2 ? 0 : (plotW * i) / (steps - 1)); };
    var y = function (v) { return pad.top + plotH * (1 - (v - lo) / (hi - lo)); };

    /* Grid and axes */
    var ticks = 4, t;
    for (t = 0; t <= ticks; t += 1) {
      var value = lo + ((hi - lo) * t) / ticks;
      var yy = y(value);
      svg.appendChild(node('line', { x1: pad.left, y1: yy, x2: pad.left + plotW, y2: yy, class: 'grid-line' }));
      svg.appendChild(node('text', {
        x: pad.left - 11, y: yy + 6, 'text-anchor': 'end', class: 'axis-text'
      }, (options.format || String)(value)));
    }
    svg.appendChild(node('line', {
      x1: pad.left, y1: pad.top + plotH, x2: pad.left + plotW, y2: pad.top + plotH, class: 'axis-line'
    }));
    for (t = 0; t <= 4; t += 1) {
      var idx = Math.round(((steps - 1) * t) / 4);
      svg.appendChild(node('text', {
        x: x(idx), y: pad.top + plotH + 24, 'text-anchor': 'middle', class: 'axis-text'
      }, String(idx + 1)));
    }
    svg.appendChild(node('text', {
      x: pad.left + plotW / 2, y: height - 4, 'text-anchor': 'middle', class: 'axis-text'
    }, 'pull number'));

    /* The reference line for the best arm, which is not one of the series */
    if (options.reference) {
      var ry = y(options.reference.value);
      svg.appendChild(node('line', {
        x1: pad.left, y1: ry, x2: pad.left + plotW, y2: ry,
        class: 'series series-optimal', stroke: 'var(--series-optimal)'
      }));
      svg.appendChild(node('text', {
        x: pad.left + plotW + 9, y: ry + 6, class: 'end-label', fill: 'var(--series-optimal)'
      }, options.reference.label));
    }

    /* The series, each labelled at its own end so identity never rests on
     * colour alone. */
    series.forEach(function (s) {
      var d = '', started = false, lastPoint = null;
      s.values.forEach(function (v, i) {
        if (v === null) { started = false; return; }
        d += (started ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
        started = true;
        lastPoint = { x: x(i), y: y(v) };
      });
      if (!d) return;
      svg.appendChild(node('path', { d: d.trim(), class: 'series', stroke: s.colour }));
      if (lastPoint) {
        svg.appendChild(node('text', {
          x: Math.min(lastPoint.x + 10, pad.left + plotW + 9), y: lastPoint.y + 6,
          class: 'end-label', fill: s.colour
        }, s.label));
      }
    });

    attachHover(svg, series, { x: x, y: y, pad: pad, plotW: plotW, plotH: plotH, steps: steps, format: options.format });
  }

  function attachHover(svg, series, geom) {
    var crosshair = node('line', { class: 'crosshair', y1: geom.pad.top, y2: geom.pad.top + geom.plotH });
    crosshair.setAttribute('opacity', '0');
    svg.appendChild(crosshair);
    var dots = series.map(function (s) {
      var dot = node('circle', { r: 6, fill: s.colour, class: 'hover-dot', opacity: '0' });
      svg.appendChild(dot);
      return dot;
    });
    var tip = el('tooltip');

    var hide = function () {
      crosshair.setAttribute('opacity', '0');
      dots.forEach(function (d) { d.setAttribute('opacity', '0'); });
      tip.hidden = true;
    };

    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('mousemove', function (event) {
      var box = svg.getBoundingClientRect();
      var scale = geom.plotW ? (box.width / svg.viewBox.baseVal.width) : 1;
      var localX = (event.clientX - box.left) / scale;
      var i = Math.round(((localX - geom.pad.left) / geom.plotW) * (geom.steps - 1));
      if (i < 0 || i >= geom.steps) { hide(); return; }

      var cx = geom.x(i);
      crosshair.setAttribute('x1', cx);
      crosshair.setAttribute('x2', cx);
      crosshair.setAttribute('opacity', '1');

      var rows = ['<div class="tooltip-head">Pull ' + (i + 1) + '</div>'];
      series.forEach(function (s, n) {
        var v = s.values[i];
        if (v === null || v === undefined) { dots[n].setAttribute('opacity', '0'); return; }
        dots[n].setAttribute('cx', cx);
        dots[n].setAttribute('cy', geom.y(v));
        dots[n].setAttribute('opacity', '1');
        rows.push('<div class="tooltip-row"><span class="tooltip-swatch" style="background:' + s.colour +
          '"></span>' + s.label + '<span class="tooltip-value">' + (geom.format || String)(v) + '</span></div>');
      });
      tip.innerHTML = rows.join('');
      tip.hidden = false;
      tip.style.left = Math.min(event.clientX + 14, global.innerWidth - tip.offsetWidth - 10) + 'px';
      tip.style.top = Math.max(10, event.clientY - tip.offsetHeight - 12) + 'px';
    });
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
      body: JSON.stringify({
        session: settings.session, key: settings.adminKey, action: action, settings: patch
      })
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

    el('ctl-session').value = settings.session;
    el('ctl-join').value = settings.joinUrl;
    el('ctl-key').value = settings.adminKey;

    el('ctl-save').addEventListener('click', function () {
      settings.session = el('ctl-session').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'default';
      settings.joinUrl = el('ctl-join').value.trim();
      settings.adminKey = el('ctl-key').value;
      saveSettings();
      knownNames = {};
      renderQR();
      admin('settings', { k: Number(el('ctl-arms').value) });
      startPolling();
    });

    el('ctl-open').addEventListener('click', function () {
      var open = latest && latest.settings ? latest.settings.open : true;
      admin('settings', { open: !open });
    });

    el('ctl-reset').addEventListener('click', function () {
      if (!global.confirm('Clear every player and score in session ' + settings.session + '?')) return;
      knownNames = {};
      admin('reset');
    });

    Array.prototype.forEach.call(
      document.querySelectorAll('.zoom-button'), function (button) {
        button.addEventListener('click', function () {
          zoom = Number(button.dataset.zoom);
          Array.prototype.forEach.call(
            document.querySelectorAll('.zoom-button'), function (other) {
              other.classList.toggle('is-on', other === button);
            });
          if (latest) render(latest);
        });
      });

    el('table-toggle').addEventListener('click', function () {
      var view = el('table-view');
      view.hidden = !view.hidden;
      this.setAttribute('aria-expanded', String(!view.hidden));
      this.textContent = view.hidden ? 'Show the numbers' : 'Hide the numbers';
    });
  }

  var resizeTimer = null;
  global.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (latest) render(latest); }, 180);
  });

  loadSettings();
  wireControls();
  renderQR();
  startPolling();
}(window));
