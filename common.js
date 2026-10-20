/* 平板借還站 — 借還站與標籤頁共用的設定、平板清單與 QR 產生工具 */
(function (global) {
  'use strict';

  var KEY_CFG = 'tl.cfg';

  var DEFAULT_CFG = {
    school: '力行國小',
    station: '平板車A',      // 借還站（平板車）名稱，寫進紀錄的「借還站」欄
    prefix: 'iPad-',
    start: 1,
    end: 30,
    digits: 2,
    extra: '',               // 每行「編號」或「編號,其他條碼(財產編號/序號/感應貼紙卡號)」
    cards: '',               // 借用人感應卡：每行「卡號,姓名,身分,班級座號」
    pin: '1234',
    camera: 'user',          // user=前鏡頭（平板立在車上面向使用者） environment=後鏡頭
    classes: 8,              // 每個年級的班級數（不登入模式：學生借用時的班級按鈕）
    auth: 'google',          // google=借用人用學校 Google 帳號登入；manual=點班級座號／打姓名
    stuDomain: 'stu.lsps.tp.edu.tw',
    tchDomain: 'lsps.tp.edu.tw',
    autoLogout: true,        // 借完自動登出 Google（共用的借還平板務必開啟）
    gasUrl: '',
    setupDone: false
  };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }

  function loadCfg() {
    var c = {};
    try { c = JSON.parse(lsGet(KEY_CFG) || '{}') || {}; } catch (e) { c = {}; }
    var out = {};
    for (var k in DEFAULT_CFG) out[k] = (c[k] === undefined || c[k] === null) ? DEFAULT_CFG[k] : c[k];
    return out;
  }
  function saveCfg(c) { return lsSet(KEY_CFG, JSON.stringify(c)); }

  // 條碼比對一律去空白、轉大寫，避免掃描器多送空白或大小寫不同
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase(); }

  function pad(n, d) { n = String(n); while (n.length < d) n = '0' + n; return n; }

  function rangeIds(prefix, start, end, digits) {
    var ids = [];
    start = parseInt(start, 10); end = parseInt(end, 10); digits = parseInt(digits, 10) || 0;
    if (!(start >= 0) || !(end >= start) || end - start > 999) return ids;
    for (var i = start; i <= end; i++) ids.push(String(prefix || '') + pad(i, digits));
    return ids;
  }

  // 回傳 { list:[{id, codes:[...]}], map:{正規化條碼: id} }
  function buildDevices(c) {
    var list = [], byId = {};
    function add(id) {
      id = String(id).trim();
      if (!id) return null;
      var k = norm(id);
      if (!byId[k]) { byId[k] = { id: id, codes: [] }; list.push(byId[k]); }
      return byId[k];
    }
    rangeIds(c.prefix, c.start, c.end, c.digits).forEach(add);
    String(c.extra || '').split(/\r?\n/).forEach(function (line) {
      var parts = line.split(/[,，\t]/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!parts.length) return;
      var d = add(parts[0]);
      parts.slice(1).forEach(function (code) { if (d.codes.indexOf(code) < 0) d.codes.push(code); });
    });
    var map = {};
    list.forEach(function (d) {
      map[norm(d.id)] = d.id;
      d.codes.forEach(function (code) { map[norm(code)] = d.id; });
    });
    return { list: list, map: map };
  }

  // 借用人感應卡對照：{ 正規化卡號: {uid, name, role, cls} }
  function buildCards(text) {
    var map = {}, n = 0;
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var p = line.split(/[,，\t]/).map(function (s) { return s.trim(); });
      if (!p[0] || !p[1]) return;
      if (!map[norm(p[0])]) n++;
      map[norm(p[0])] = { uid: p[0], name: p[1], role: p[2] || '', cls: p[3] || '' };
    });
    return { map: map, count: n };
  }

  // 借用證 QR 內容：P:姓名|身分|班級座號
  function personCode(name, role, cls) {
    return 'P:' + [name, role || '', cls || ''].join('|').replace(/\|+$/, '');
  }
  function parsePerson(text) {
    var m = /^P:(.+)$/i.exec(String(text).trim());
    if (!m) return null;
    var p = m[1].split('|');
    if (!p[0].trim()) return null;
    return { name: p[0].trim(), role: (p[1] || '').trim(), cls: (p[2] || '').trim() };
  }

  // 在不讓 QR 變大（格數不變）的前提下，用最高的容錯等級：小標籤刮傷、反光也比較掃得到
  var qrCache = {};
  function bestQr(text) {
    if (qrCache[text]) return qrCache[text];
    var make = function (e) { var q = qrcode(0, e); q.addData(text, 'Byte'); q.make(); return q; };
    var best = make('L'), n = best.getModuleCount();
    ['H', 'Q', 'M'].some(function (e) {
      var q = make(e);
      if (q.getModuleCount() === n) { best = q; return true; }
      return false;
    });
    return (qrCache[text] = best);
  }
  function qrModules(text) { return bestQr(text).getModuleCount(); }

  // 用 qrcode-generator 產生向量 SVG（列印清晰），四周留 2 格白邊
  function qrSvg(text) {
    var qr = bestQr(text);
    var n = qr.getModuleCount(), q = 2, d = '';
    for (var r = 0; r < n; r++) {
      for (var col = 0; col < n; col++) {
        if (qr.isDark(r, col)) d += 'M' + (col + q) + ' ' + (r + q) + 'h1v1h-1z';
      }
    }
    var s = n + q * 2;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + s + ' ' + s +
      '" shape-rendering="crispEdges"><rect width="' + s + '" height="' + s + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  if (global.qrcode) global.qrcode.stringToBytes = global.qrcode.stringToBytesFuncs['UTF-8'];

  global.TL = {
    KEY_CFG: KEY_CFG, DEFAULT_CFG: DEFAULT_CFG,
    lsGet: lsGet, lsSet: lsSet, loadCfg: loadCfg, saveCfg: saveCfg,
    norm: norm, pad: pad, rangeIds: rangeIds, buildDevices: buildDevices, buildCards: buildCards,
    personCode: personCode, parsePerson: parsePerson, qrSvg: qrSvg, qrModules: qrModules, esc: esc
  };
})(window);
