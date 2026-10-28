/*
 * Revit Version Checker
 * Everything runs locally. The file is read in small slices with File.slice()
 * and is never uploaded anywhere.
 *
 * The parser below is environment-neutral: it only needs a `reader` object
 *   { size: number, read(offset, length) => Promise<Uint8Array> }
 * so the same code runs in the browser and in tests/parse.test.mjs (Node).
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Text detection
  // ---------------------------------------------------------------------------

  var RE_FORMAT = /Format:\s*(20\d{2})/;
  // Pre-2019 product names, e.g. "Autodesk Revit 2016", "Autodesk Revit LT 2017",
  // "Autodesk Revit Architecture 2012".
  var RE_PRODUCT = /Autodesk Revit (LT |Architecture |Structure |MEP )?(20\d{2})/;
  var RE_BUILD = /Build:\s*([^\r\n\u0000]{1,80})/g;
  var RE_LT = /Revit LT/;

  // Pull a version out of decoded text, following the priority order:
  // 1. "Format: YYYY"  2. "Autodesk Revit (LT )?YYYY"  3. year at start of "Build:".
  function detectFromText(text) {
    var builds = [];
    var m;
    RE_BUILD.lastIndex = 0;
    while ((m = RE_BUILD.exec(text)) !== null) {
      builds.push(cleanBuild(m[1]));
    }
    // Prefer a Build value that looks like a real build stamp (starts with digits).
    var rawBuild = builds.filter(function (b) { return /^\d/.test(b); })[0] || builds[0] || null;

    var result = { version: null, source: null, build: rawBuild, isLT: RE_LT.test(text) };

    if ((m = RE_FORMAT.exec(text))) {
      result.version = m[1];
      result.source = 'format';
    } else if ((m = RE_PRODUCT.exec(text))) {
      result.version = m[2];
      result.source = 'product';
      if (m[1] === 'LT ') result.isLT = true;
    } else {
      for (var i = 0; i < builds.length; i++) {
        var y = /^(20\d{2})/.exec(builds[i]);
        if (y) {
          result.version = y[1];
          result.source = 'build';
          result.build = builds[i];
          break;
        }
      }
    }
    return result;
  }

  function cleanBuild(s) {
    s = s.replace(/[\u0000-\u001f]/g, '').trim();
    // Keep the build token itself, e.g. "20230308_1635(x64)".
    var stamp = /^\d{8}_\d{4}(\(x64\))?/.exec(s);
    if (stamp) return stamp[0];
    return s.slice(0, 60);
  }

  var utf16 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-16le') : null;
  var latin1 = typeof TextDecoder !== 'undefined' ? new TextDecoder('latin1') : null;

  // UTF-16 strings in a binary blob can start on either byte alignment,
  // so decode both alignments (plus a single-byte pass) and try each.
  function detectFromBytes(bytes) {
    var texts = [
      utf16.decode(bytes),
      utf16.decode(bytes.subarray(1)),
      latin1.decode(bytes)
    ];
    var best = null;
    var rank = { format: 3, product: 2, build: 1 };
    for (var i = 0; i < texts.length; i++) {
      var r = detectFromText(texts[i]);
      if (!best) { best = r; continue; }
      if (r.isLT) best.isLT = true;
      if (!best.build && r.build) best.build = r.build;
      if (r.version && (!best.version || rank[r.source] > rank[best.source])) {
        var lt = best.isLT;
        var build = best.build;
        best = r;
        best.isLT = best.isLT || lt;
        best.build = best.build || build;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // OLE Compound File Binary (CFB) reader
  // ---------------------------------------------------------------------------

  var CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  var ENDOFCHAIN = 0xfffffffe;
  var MAXREGSECT = 0xfffffffa;
  var TARGET_STREAM = 'BasicFileInfo';
  var MAX_STREAM_BYTES = 4 * 1024 * 1024;

  function u32(view, off) { return view.getUint32(off, true); }
  function dv(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

  async function readCfbStream(reader, streamName) {
    var head = await reader.read(0, 512);
    if (head.length < 512) throw new Error('File too small to be a Revit file');
    for (var i = 0; i < 8; i++) {
      if (head[i] !== CFB_SIGNATURE[i]) throw new Error('Not an OLE compound file');
    }
    var h = dv(head);
    var sectorSize = 1 << h.getUint16(0x1e, true);
    var miniSectorSize = 1 << h.getUint16(0x20, true);
    var firstDirSector = u32(h, 0x30);
    var miniCutoff = u32(h, 0x38);
    var firstMiniFat = u32(h, 0x3c);
    var numMiniFat = u32(h, 0x40);
    var firstDifat = u32(h, 0x44);
    var numDifat = u32(h, 0x48);
    if (sectorSize !== 512 && sectorSize !== 4096) throw new Error('Unsupported sector size');

    var perSector = sectorSize / 4;
    var maxSteps = Math.ceil(reader.size / sectorSize) + 1;
    var sectorOffset = function (s) { return (s + 1) * sectorSize; };

    // DIFAT: the list of FAT sector numbers. 109 live in the header, the rest in a chain.
    var difat = [];
    for (var d = 0; d < 109; d++) difat.push(u32(h, 0x4c + d * 4));
    var ds = firstDifat;
    for (var n = 0; n < numDifat && ds <= MAXREGSECT; n++) {
      var dbuf = dv(await reader.read(sectorOffset(ds), sectorSize));
      for (var k = 0; k < perSector - 1; k++) difat.push(u32(dbuf, k * 4));
      ds = u32(dbuf, (perSector - 1) * 4);
    }

    // FAT sectors are loaded lazily, only the ones a chain actually touches.
    var fatCache = new Map();
    async function nextSector(s) {
      var idx = Math.floor(s / perSector);
      var fatSector = difat[idx];
      if (fatSector === undefined || fatSector > MAXREGSECT) throw new Error('Corrupt FAT');
      var view = fatCache.get(idx);
      if (!view) {
        view = dv(await reader.read(sectorOffset(fatSector), sectorSize));
        fatCache.set(idx, view);
      }
      return u32(view, (s % perSector) * 4);
    }

    // Walk a sector chain, calling visit(sector, index); visit returns true to stop.
    async function walk(start, visit) {
      var s = start;
      for (var step = 0; s <= MAXREGSECT; step++) {
        if (step > maxSteps) throw new Error('Sector chain loop');
        if (await visit(s, step)) return;
        s = await nextSector(s);
      }
    }

    // Scan directory entries (128 bytes each) for the target stream.
    var root = null;
    var entry = null;
    await walk(firstDirSector, async function (s) {
      var buf = await reader.read(sectorOffset(s), sectorSize);
      var view = dv(buf);
      for (var off = 0; off < sectorSize; off += 128) {
        var type = buf[off + 0x42];
        if (type === 0) continue;
        var nameLen = view.getUint16(off + 0x40, true);
        var name = nameLen >= 2 ? utf16.decode(buf.subarray(off, off + Math.min(nameLen, 64) - 2)) : '';
        var rec = { name: name, type: type, start: u32(view, off + 0x74), size: u32(view, off + 0x78) };
        if (type === 5 && !root) root = rec;
        if (type === 2 && name === streamName) { entry = rec; return true; }
      }
      return false;
    });
    if (!entry) throw new Error('Stream "' + streamName + '" not found');

    var size = Math.min(entry.size, MAX_STREAM_BYTES);
    var out = new Uint8Array(size);
    var pos = 0;

    if (entry.size >= miniCutoff) {
      // Regular stream: read its sectors directly.
      await walk(entry.start, async function (s) {
        var len = Math.min(sectorSize, size - pos);
        out.set((await reader.read(sectorOffset(s), len)).subarray(0, len), pos);
        pos += len;
        return pos >= size;
      });
      return out;
    }

    // Mini stream: small streams live in 64-byte mini sectors inside the root
    // entry's stream, indexed by the mini FAT.
    if (!root) throw new Error('Root entry not found');
    var miniFat = [];
    await walk(firstMiniFat, async function (s, i) {
      if (i >= numMiniFat) return true;
      var view = dv(await reader.read(sectorOffset(s), sectorSize));
      for (var k = 0; k < perSector; k++) miniFat.push(u32(view, k * 4));
      return false;
    });

    // Map mini-stream byte positions to file offsets via the root chain (built on demand).
    var rootChain = [];
    var rootCursor = root.start;
    async function rootSectorAt(index) {
      while (rootChain.length <= index) {
        if (rootCursor > MAXREGSECT || rootChain.length > maxSteps) throw new Error('Mini stream truncated');
        rootChain.push(rootCursor);
        rootCursor = await nextSector(rootCursor);
      }
      return rootChain[index];
    }

    var ms = entry.start;
    for (var steps = 0; pos < size && ms <= MAXREGSECT; steps++) {
      if (steps > miniFat.length) throw new Error('Mini chain loop');
      var miniPos = ms * miniSectorSize;
      var regular = await rootSectorAt(Math.floor(miniPos / sectorSize));
      var len = Math.min(miniSectorSize, size - pos);
      var chunk = await reader.read(sectorOffset(regular) + (miniPos % sectorSize), len);
      out.set(chunk.subarray(0, len), pos);
      pos += len;
      ms = miniFat[ms];
      if (ms === undefined) throw new Error('Corrupt mini FAT');
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Fallback: chunked byte scan
  // ---------------------------------------------------------------------------

  var CHUNK_SIZE = 8 * 1024 * 1024;
  var WINDOW = 512;

  function utf16Bytes(str) {
    var b = new Uint8Array(str.length * 2);
    for (var i = 0; i < str.length; i++) b[i * 2] = str.charCodeAt(i);
    return b;
  }
  var PATTERNS = [utf16Bytes('Format: '), utf16Bytes('Autodesk Revit')];
  var OVERLAP = Math.max(PATTERNS[0].length, PATTERNS[1].length) - 1;

  function indexOfBytes(hay, needle, from) {
    var first = needle[0];
    var last = hay.length - needle.length;
    outer: for (var i = hay.indexOf(first, from); i !== -1 && i <= last; i = hay.indexOf(first, i + 1)) {
      for (var j = 1; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  async function scanForVersion(reader, onProgress) {
    var lt = false;
    var build = null;
    for (var offset = 0; offset < reader.size; offset += CHUNK_SIZE) {
      var start = Math.max(0, offset - OVERLAP);
      var chunk = await reader.read(start, Math.min(CHUNK_SIZE + (offset - start), reader.size - start));

      // Collect matches in this chunk, earliest first.
      var hits = [];
      for (var p = 0; p < PATTERNS.length; p++) {
        var from = 0;
        var idx;
        while ((idx = indexOfBytes(chunk, PATTERNS[p], from)) !== -1) {
          hits.push(start + idx);
          from = idx + 1;
          if (hits.length > 64) break;
        }
      }
      hits.sort(function (a, b) { return a - b; });

      for (var h = 0; h < hits.length; h++) {
        // Read a little context before the hit too, so "Build:" and "LT" nearby are seen.
        var winStart = Math.max(0, hits[h] - WINDOW);
        var win = await reader.read(winStart, Math.min(WINDOW * 2, reader.size - winStart));
        var aligned = (hits[h] - winStart) % 2 === 0 ? win : win.subarray(1);
        var r = detectFromBytes(aligned);
        if (r.isLT) lt = true;
        if (!build && r.build) build = r.build;
        if (r.version && r.source !== 'build') {
          r.isLT = r.isLT || lt;
          r.build = r.build || build;
          return r;
        }
      }
      if (onProgress) onProgress(Math.min(1, (offset + CHUNK_SIZE) / reader.size));
    }
    return { version: null, source: null, build: build, isLT: lt };
  }

  // ---------------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------------

  async function detectVersion(reader, onProgress) {
    try {
      var bytes = await readCfbStream(reader, TARGET_STREAM);
      var r = detectFromBytes(bytes);
      if (r.version) { r.method = 'cfb'; return r; }
    } catch (e) {
      // Fall through to the byte scan.
    }
    var s = await scanForVersion(reader, onProgress);
    s.method = 'scan';
    return s;
  }

  global.RevitVersion = {
    detectVersion: detectVersion,
    detectFromText: detectFromText,
    readCfbStream: readCfbStream,
    scanForVersion: scanForVersion
  };

  // ---------------------------------------------------------------------------
  // Browser UI
  // ---------------------------------------------------------------------------

  if (typeof document === 'undefined') return;

  var ACCEPTED = ['rvt', 'rfa', 'rte', 'rft'];

  function fileReader(file) {
    return {
      size: file.size,
      read: function (offset, length) {
        return file.slice(offset, offset + length).arrayBuffer().then(function (b) {
          return new Uint8Array(b);
        });
      }
    };
  }

  function formatSize(bytes) {
    var units = ['bytes', 'KB', 'MB', 'GB'];
    var i = 0;
    var n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + units[i];
  }

  function $(id) { return document.getElementById(id); }

  function initChecker() {
    var zone = $('dropzone');
    var input = $('file-input');
    var status = $('status');
    var statusText = $('status-text');
    var bar = $('progress-bar');
    var card = $('result');
    var busy = false;

    function setState(state) {
      zone.classList.toggle('is-busy', state === 'busy');
      status.hidden = state !== 'busy';
      card.hidden = state !== 'result';
    }

    function showResult(file, r, error) {
      var meta = [file.name, formatSize(file.size)];
      $('result-headline').textContent = r && r.version ? 'Revit ' + r.version : '';
      $('result-lt').hidden = !(r && r.version && r.isLT);
      if (r && r.version) {
        if (r.build) meta.push('Build ' + r.build);
        if (r.source === 'build') meta.push('estimated from build date');
        $('result-error').hidden = true;
        card.classList.remove('is-error');
      } else {
        $('result-error').textContent = error || "Couldn't detect the version. This may not be a valid Revit file.";
        $('result-error').hidden = false;
        card.classList.add('is-error');
      }
      $('result-meta').textContent = meta.join('  ·  ');
      setState('result');
      card.focus();
    }

    async function handle(file) {
      if (!file || busy) return;
      var ext = (file.name.split('.').pop() || '').toLowerCase();
      if (ACCEPTED.indexOf(ext) === -1 || file.name.indexOf('.') === -1) {
        showResult(file, null, 'That file type isn’t supported. Choose a .rvt, .rfa, .rte or .rft file.');
        return;
      }
      busy = true;
      statusText.textContent = 'Reading ' + file.name + '…';
      bar.style.width = '0%';
      bar.parentNode.classList.add('is-indeterminate');
      setState('busy');
      try {
        var r = await detectVersion(fileReader(file), function (p) {
          bar.parentNode.classList.remove('is-indeterminate');
          bar.style.width = Math.round(p * 100) + '%';
          statusText.textContent = 'Scanning ' + file.name + '… ' + Math.round(p * 100) + '%';
        });
        showResult(file, r);
      } catch (e) {
        showResult(file, null);
      } finally {
        busy = false;
        input.value = '';
      }
    }

    $('choose-btn').addEventListener('click', function () { input.click(); });
    $('again-btn').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { handle(input.files[0]); });

    zone.addEventListener('click', function (e) {
      if (!busy && !e.target.closest('button')) input.click();
    });
    zone.addEventListener('keydown', function (e) {
      if (e.target === zone && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); input.click(); }
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('is-over'); });
    });
    zone.addEventListener('drop', function (e) {
      handle(e.dataTransfer.files[0]);
    });
    // A file dropped outside the zone would otherwise open in the browser tab.
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });
  }

  initChecker();
})(typeof window !== 'undefined' ? window : globalThis);
