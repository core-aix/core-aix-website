/* A small QR code generator, byte mode, error correction level M, versions 1
 * to 10. That covers any join link this page needs and keeps the dashboard
 * free of an external script, which matters in a lecture theatre.
 *
 * Usage:  QR.encode("https://example.com")  ->  { size, modules }
 * where `modules` is an array of rows of booleans, true meaning a dark module.
 */
(function (global) {
  'use strict';

  /* Error correction level M, indexed by version:
   * [ec codewords per block, blocks in group 1, data per block in group 1,
   *  blocks in group 2, data per block in group 2] */
  var EC = [
    null,
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44]
  ];

  var ALIGN = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];

  var REMAINDER = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

  /* ---------------------------------------------------------------- */
  /* Arithmetic in GF(256) with the QR primitive polynomial 0x11d      */
  /* ---------------------------------------------------------------- */
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1, i;
    for (i = 0; i < 255; i += 1) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
  }());

  function gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function generator(degree) {
    var poly = [1], d, j, shifted, scaled, out;
    for (d = 0; d < degree; d += 1) {
      shifted = poly.concat([0]);
      scaled = poly.map(function (c) { return gmul(c, EXP[d]); });
      out = shifted.slice();
      for (j = 0; j < scaled.length; j += 1) out[j + 1] ^= scaled[j];
      poly = out;
    }
    return poly;
  }

  function remainder(data, degree) {
    var gen = generator(degree);
    var res = new Uint8Array(degree);
    var i, j, factor;
    for (i = 0; i < data.length; i += 1) {
      factor = data[i] ^ res[0];
      res.copyWithin(0, 1);
      res[degree - 1] = 0;
      for (j = 0; j < degree; j += 1) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  /* ---------------------------------------------------------------- */
  /* Data codewords                                                     */
  /* ---------------------------------------------------------------- */

  function utf8Bytes(text) {
    var encoded = unescape(encodeURIComponent(text));
    var bytes = [], i;
    for (i = 0; i < encoded.length; i += 1) bytes.push(encoded.charCodeAt(i) & 0xff);
    return bytes;
  }

  function dataCapacity(version) {
    var ec = EC[version];
    return ec[1] * ec[2] + ec[3] * ec[4];
  }

  function pickVersion(byteCount) {
    for (var v = 1; v <= 10; v += 1) {
      var countBits = v < 10 ? 8 : 16;
      var needed = Math.ceil((4 + countBits + 8 * byteCount) / 8);
      if (needed <= dataCapacity(v)) return v;
    }
    throw new Error('the link is too long for this generator');
  }

  function buildCodewords(bytes, version) {
    var capacity = dataCapacity(version);
    var countBits = version < 10 ? 8 : 16;
    var bits = [];
    var push = function (value, width) {
      for (var i = width - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
    };

    push(0b0100, 4);
    push(bytes.length, countBits);
    bytes.forEach(function (b) { push(b, 8); });

    var room = capacity * 8;
    var terminator = Math.min(4, room - bits.length);
    push(0, terminator);
    while (bits.length % 8 !== 0) bits.push(0);

    var words = [];
    for (var i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (var j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
      words.push(byte);
    }
    var pads = [0xec, 0x11], p = 0;
    while (words.length < capacity) { words.push(pads[p % 2]); p += 1; }
    return words;
  }

  function interleave(words, version) {
    var ec = EC[version];
    var ecLen = ec[0];
    var blocks = [];
    var offset = 0, i;

    for (i = 0; i < ec[1]; i += 1) { blocks.push(words.slice(offset, offset + ec[2])); offset += ec[2]; }
    for (i = 0; i < ec[3]; i += 1) { blocks.push(words.slice(offset, offset + ec[4])); offset += ec[4]; }

    var parities = blocks.map(function (block) { return remainder(block, ecLen); });
    var longest = Math.max.apply(null, blocks.map(function (b) { return b.length; }));
    var out = [];
    var b;

    for (i = 0; i < longest; i += 1) {
      for (b = 0; b < blocks.length; b += 1) if (i < blocks[b].length) out.push(blocks[b][i]);
    }
    for (i = 0; i < ecLen; i += 1) {
      for (b = 0; b < parities.length; b += 1) out.push(parities[b][i]);
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Matrix                                                             */
  /* ---------------------------------------------------------------- */

  function blank(size) {
    var grid = [], reserved = [], i, j, row, mark;
    for (i = 0; i < size; i += 1) {
      row = []; mark = [];
      for (j = 0; j < size; j += 1) { row.push(false); mark.push(false); }
      grid.push(row); reserved.push(mark);
    }
    return { grid: grid, reserved: reserved };
  }

  function placeFinder(m, top, left) {
    for (var r = -1; r <= 7; r += 1) {
      for (var c = -1; c <= 7; c += 1) {
        var y = top + r, x = left + c;
        if (y < 0 || x < 0 || y >= m.grid.length || x >= m.grid.length) continue;
        var inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                     (c >= 0 && c <= 6 && (r === 0 || r === 6));
        var inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m.grid[y][x] = inRing || inCore;
        m.reserved[y][x] = true;
      }
    }
  }

  function placeAlignment(m, version) {
    var centres = ALIGN[version], size = m.grid.length;
    for (var a = 0; a < centres.length; a += 1) {
      for (var b = 0; b < centres.length; b += 1) {
        var cy = centres[a], cx = centres[b];
        var nearFinder = (cy <= 8 && cx <= 8) ||
                         (cy <= 8 && cx >= size - 9) ||
                         (cy >= size - 9 && cx <= 8);
        if (nearFinder) continue;
        for (var r = -2; r <= 2; r += 1) {
          for (var c = -2; c <= 2; c += 1) {
            m.grid[cy + r][cx + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
            m.reserved[cy + r][cx + c] = true;
          }
        }
      }
    }
  }

  function placeTiming(m) {
    var size = m.grid.length;
    for (var i = 8; i < size - 8; i += 1) {
      var dark = i % 2 === 0;
      m.grid[6][i] = dark; m.reserved[6][i] = true;
      m.grid[i][6] = dark; m.reserved[i][6] = true;
    }
  }

  function reserveFormat(m, version) {
    var size = m.grid.length, i;
    for (i = 0; i <= 8; i += 1) {
      if (i !== 6) { m.reserved[8][i] = true; m.reserved[i][8] = true; }
    }
    m.reserved[8][6] = true;
    m.reserved[6][8] = true;
    for (i = 0; i < 8; i += 1) {
      m.reserved[8][size - 1 - i] = true;
      m.reserved[size - 1 - i][8] = true;
    }
    /* The dark module is fixed and never carries data. */
    m.grid[size - 8][8] = true;
    m.reserved[size - 8][8] = true;

    if (version >= 7) {
      for (i = 0; i < 6; i += 1) {
        for (var j = 0; j < 3; j += 1) {
          m.reserved[i][size - 11 + j] = true;
          m.reserved[size - 11 + j][i] = true;
        }
      }
    }
  }

  function placeData(m, codewords) {
    var size = m.grid.length;
    var bits = [];
    codewords.forEach(function (word) {
      for (var i = 7; i >= 0; i -= 1) bits.push((word >> i) & 1);
    });

    var index = 0, upward = true, col, row, c, x;
    for (col = size - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;          /* the vertical timing pattern is skipped */
      for (row = 0; row < size; row += 1) {
        for (c = 0; c < 2; c += 1) {
          x = col - c;
          var y = upward ? size - 1 - row : row;
          if (m.reserved[y][x]) continue;
          m.grid[y][x] = index < bits.length ? bits[index] === 1 : false;
          index += 1;
        }
      }
      upward = !upward;
    }
  }

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
    function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; }
  ];

  function applyMask(m, maskIndex) {
    var size = m.grid.length, fn = MASKS[maskIndex];
    var out = m.grid.map(function (row) { return row.slice(); });
    for (var r = 0; r < size; r += 1) {
      for (var c = 0; c < size; c += 1) {
        if (!m.reserved[r][c] && fn(r, c)) out[r][c] = !out[r][c];
      }
    }
    return out;
  }

  function formatBits(maskIndex) {
    /* Level M is 0b00. The five data bits take a BCH(15, 5) code and are then
     * masked with 0x5412, as the standard requires. */
    var data = (0b00 << 3) | maskIndex;
    var value = data << 10;
    for (var i = 4; i >= 0; i -= 1) {
      if (value & (1 << (i + 10))) value ^= 0b10100110111 << i;
    }
    return ((data << 10) | value) ^ 0b101010000010010;
  }

  function versionBits(version) {
    var value = version << 12;
    for (var i = 5; i >= 0; i -= 1) {
      if (value & (1 << (i + 12))) value ^= 0b1111100100101 << i;
    }
    return (version << 12) | value;
  }

  function writeFormat(grid, maskIndex) {
    var size = grid.length;
    var bits = formatBits(maskIndex);
    var get = function (i) { return ((bits >> i) & 1) === 1; };
    var i;

    /* First copy, down column 8 and then left along row 8. */
    for (i = 0; i <= 5; i += 1) grid[i][8] = get(i);
    grid[7][8] = get(6);
    grid[8][8] = get(7);
    grid[8][7] = get(8);
    for (i = 9; i <= 14; i += 1) grid[8][14 - i] = get(i);

    /* Second copy, right along row 8 and then down column 8. */
    for (i = 0; i <= 7; i += 1) grid[8][size - 1 - i] = get(i);
    for (i = 8; i <= 14; i += 1) grid[size - 15 + i][8] = get(i);

    grid[size - 8][8] = true;
  }

  function writeVersion(grid, version) {
    if (version < 7) return;
    var size = grid.length;
    var bits = versionBits(version);
    for (var i = 0; i < 18; i += 1) {
      var bit = ((bits >> i) & 1) === 1;
      var a = Math.floor(i / 3);
      var b = i % 3;
      grid[a][size - 11 + b] = bit;
      grid[size - 11 + b][a] = bit;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Mask penalty, as defined by the standard                           */
  /* ---------------------------------------------------------------- */
  function penalty(grid) {
    var size = grid.length;
    var score = 0;
    var N1 = 3, N2 = 3, N3 = 40, N4 = 10;
    var x, y;

    /* A run of five or more equal modules in a line, and a finder-like
     * 1:1:3:1:1 run bounded by a light area four times as wide. The run
     * history keeps the last six run lengths, with the area outside the
     * symbol counted as light. */
    function countPatterns(history) {
      var n = history[1];
      var core = n > 0 && history[2] === n && history[3] === n * 3 &&
                 history[4] === n && history[5] === n;
      return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
             (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
    }

    function addHistory(runLength, history) {
      if (history[0] === 0) runLength += size;   /* the light border before the first run */
      history.copyWithin(1, 0, history.length - 1);
      history[0] = runLength;
    }

    function terminate(runDark, runLength, history) {
      if (runDark) { addHistory(runLength, history); runLength = 0; }
      runLength += size;                          /* the light border after the last run */
      addHistory(runLength, history);
      return countPatterns(history);
    }

    function scanLine(get) {
      var history = new Int32Array(7);
      var dark = false, run = 0, lineScore = 0, j;
      for (j = 0; j < size; j += 1) {
        if (get(j) === dark) {
          run += 1;
          if (run === 5) lineScore += N1;
          else if (run > 5) lineScore += 1;
        } else {
          addHistory(run, history);
          if (!dark) lineScore += countPatterns(history) * N3;
          dark = get(j);
          run = 1;
        }
      }
      lineScore += terminate(dark, run, history) * N3;
      return lineScore;
    }

    for (y = 0; y < size; y += 1) {
      score += scanLine((function (row) { return function (j) { return grid[row][j]; }; }(y)));
    }
    for (x = 0; x < size; x += 1) {
      score += scanLine((function (col) { return function (j) { return grid[j][col]; }; }(x)));
    }

    /* Blocks of the same colour, two by two. */
    for (y = 0; y < size - 1; y += 1) {
      for (x = 0; x < size - 1; x += 1) {
        var v = grid[y][x];
        if (v === grid[y][x + 1] && v === grid[y + 1][x] && v === grid[y + 1][x + 1]) score += N2;
      }
    }

    /* Imbalance between dark and light modules. */
    var dark = 0;
    for (y = 0; y < size; y += 1) for (x = 0; x < size; x += 1) if (grid[y][x]) dark += 1;
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += k * N4;

    return score;
  }

  /* ---------------------------------------------------------------- */
  /* Public entry point                                                 */
  /* ---------------------------------------------------------------- */
  function encode(text, forcedMask) {
    var bytes = utf8Bytes(text);
    var version = pickVersion(bytes.length);
    var size = version * 4 + 17;

    var m = blank(size);
    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);
    placeAlignment(m, version);
    placeTiming(m);
    reserveFormat(m, version);

    var words = interleave(buildCodewords(bytes, version), version);
    var padded = words.slice();
    placeData(m, padded);
    void REMAINDER[version];   /* the remainder bits are already left light */

    var best = null, bestScore = Infinity, bestMask = 0;
    for (var mask = 0; mask < 8; mask += 1) {
      var candidate = applyMask(m, mask);
      writeFormat(candidate, mask);
      writeVersion(candidate, version);
      var score = forcedMask === undefined ? penalty(candidate) : (mask === forcedMask ? -1 : 1e9);
      if (score < bestScore) { bestScore = score; best = candidate; bestMask = mask; }
    }
    return { size: size, version: version, mask: bestMask, modules: best };
  }

  global.QR = {
    encode: encode,
    /* Exposed for the verification script that checks this file against a
     * reference encoder. Nothing on the page uses them. */
    internal: {
      buildCodewords: buildCodewords,
      interleave: interleave,
      blank: blank,
      placeFinder: placeFinder,
      placeAlignment: placeAlignment,
      placeTiming: placeTiming,
      reserveFormat: reserveFormat,
      utf8Bytes: utf8Bytes,
      pickVersion: pickVersion,
      MASKS: MASKS,
      penalty: penalty
    }
  };
}(typeof window !== 'undefined' ? window : globalThis));
