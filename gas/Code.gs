/**
 * 平板借還站 — Google 試算表後端（雲端版）
 *
 * 借還站（平板上的網頁）所有資料都在這裡，平板不存資料：
 *   「借用紀錄」：一台平板借一次＝一列（像以前的紙本借用簿）
 *   「現況」　　：每台平板目前在車上還是在誰手上（每次借還自動重算）
 *   「設定備份」：每台平板車的設定（平板清單、身分驗證方式…）
 *   「感應卡」　：登錄過的借用人感應卡
 *
 * 網頁應用程式網址寫在借還站程式裡（公開），所以：
 *   - 一般查詢只回傳遮蔽過的姓名（王○明），不含帳號、用途、感應卡名單
 *   - 管理密碼只存在這裡（指令碼屬性 ADMIN_PIN，預設 1234），驗證通過才發 12 小時的通行證
 *   - 改設定、看完整紀錄、作廢紀錄都要通行證；一般借還只能新增紀錄或標記歸還
 *
 * 安裝：執行一次 setup() 授權 → 部署 → 網頁應用程式：執行身分「我」、誰可以存取「所有人」
 */

var LOG = '借用紀錄';
var NOW = '現況';
var BAK = '設定備份';
var CARDS = '感應卡';
var HEAD = ['紀錄ID', '平板編號', '借用人', '帳號', '身分', '班級座號', '用途', '借出時間', '歸還時間', '狀態', '借還站', '批次', '最後更新(ms)', '同步時間(ms)'];
var C = { id: 0, device: 1, name: 2, email: 3, role: 4, cls: 5, memo: 6, outAt: 7, inAt: 8, status: 9, station: 10, batch: 11, updated: 12, synced: 13 };
var RECENT_DAYS = 3;   // 借還站畫面顯示幾天內的紀錄

function setup() {
  var ss = getSs_();
  logSheet_(ss);
  nowSheet_(ss);
  adminPin_();
  secret_();
  Logger.log('試算表：' + ss.getUrl());
  return ss.getUrl();
}

// ---------- 入口 ----------
function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    var ss = getSs_();
    if (p.action === 'state') return out_(state_(ss, String(p.station || '')));
    if (p.action === 'card') return out_(cardLookup_(ss, String(p.station || ''), String(p.uid || '')));
    if (p.action === 'log') {
      if (!okToken_(p.token)) return out_({ ok: false, auth: false, error: '請重新輸入管理密碼' });
      return out_(log_(ss, String(p.station || ''), Number(p.days) || 0));
    }
    if (p.action === 'cards') {
      if (!okToken_(p.token)) return out_({ ok: false, auth: false, error: '請重新輸入管理密碼' });
      return out_({ ok: true, cards: readBackup_(ss, String(p.station || '')).cards });
    }
    return out_({ ok: true, app: 'tablet-loan', api: 3, sheet: ss.getName(), time: Date.now() });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) { return out_({ ok: false, error: '資料格式錯誤' }); }
  if (body.action === 'login') return out_(login_(String(body.pin || '')));
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var ss = getSs_(), sh = logSheet_(ss), station = String(body.station || ''), admin = okToken_(body.token);

    if (body.action === 'setpin') {
      if (!admin) return out_({ ok: false, auth: false, error: '請重新輸入管理密碼' });
      if (!/^\d{4,6}$/.test(String(body.pin || ''))) return out_({ ok: false, error: '管理密碼請用 4～6 位數字' });
      PropertiesService.getScriptProperties().setProperty('ADMIN_PIN', String(body.pin));
      return out_({ ok: true });
    }

    if (body.action === 'config') {
      if (!admin) return out_({ ok: false, auth: false, error: '請重新輸入管理密碼' });
      if (!station) return out_({ ok: false, error: '缺少平板車名稱' });
      var conf = body.config || {};
      delete conf.pin;
      conf.cfgUpdated = Date.now();
      saveBackup_(ss, station, conf, body.cards == null ? null : String(body.cards));
      if (body.devices) PropertiesService.getScriptProperties().setProperty('devices:' + station, JSON.stringify(body.devices.slice(0, 500)));
      if (body.renamedFrom && body.renamedFrom !== station) renameStation_(ss, sh, String(body.renamedFrom), station);
      rebuildNow_(ss, sh);
      var st = state_(ss, station);
      st.saved = [];
      return out_(st);
    }

    // 一般借還
    var saved = upsert_(ss, sh, body.loans || [], admin);
    rebuildNow_(ss, sh);
    var res = state_(ss, station);
    res.saved = saved;
    return out_(res);
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

// ---------- 管理密碼與通行證 ----------
function adminPin_() {
  var props = PropertiesService.getScriptProperties(), pin = props.getProperty('ADMIN_PIN');
  if (pin) return pin;
  // 舊版把密碼放在設定備份裡：搬過來後從設定移除
  var found = '';
  listBackups_(getSs_()).forEach(function (b) { if (!found && b.config && /^\d{4,6}$/.test(String(b.config.pin || ''))) found = String(b.config.pin); });
  pin = found || '1234';
  props.setProperty('ADMIN_PIN', pin);
  return pin;
}

function secret_() {
  var props = PropertiesService.getScriptProperties(), s = props.getProperty('SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('SECRET', s); }
  return s;
}

function sign_(s) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, secret_())); }

function okToken_(t) {
  t = String(t || '');
  var i = t.indexOf('.');
  if (i < 1) return false;
  var exp = Number(t.slice(0, i));
  return exp > Date.now() && sign_('admin|' + exp) === t.slice(i + 1);
}

function login_(pin) {
  var cache = CacheService.getScriptCache(), fails = Number(cache.get('pinfail') || 0);
  if (fails >= 8) return { ok: false, error: '密碼錯太多次，請 10 分鐘後再試' };
  if (pin !== adminPin_()) {
    cache.put('pinfail', String(fails + 1), 600);
    return { ok: false, error: '密碼不對' };
  }
  cache.remove('pinfail');
  var exp = Date.now() + 12 * 3600e3;
  return { ok: true, token: exp + '.' + sign_('admin|' + exp), exp: exp };
}

// ---------- 讀取 ----------
// 借還站畫面用：平板車清單、這台車的設定、借出中＋最近幾天的紀錄（姓名遮蔽）
function state_(ss, want) {
  var list = listBackups_(ss), names = list.map(function (b) { return b.station; });
  var st = names.indexOf(want) >= 0 ? want : (names.length === 1 ? names[0] : '');
  var out = { ok: true, api: 3, stations: names, station: st, pinLen: adminPin_().length, time: Date.now() };
  if (!st) return out;
  out.config = publicConfig_(list[names.indexOf(st)].config);
  var since = Date.now() - RECENT_DAYS * 864e5;
  out.loans = readLog_(logSheet_(ss)).filter(function (r) {
    if (!r[C.id] || String(r[C.station]) !== st) return false;
    var open = !r[C.inAt] && r[C.status] !== '已作廢';
    return open || ms_(r[C.outAt]) > since || ms_(r[C.inAt]) > since;
  }).map(publicLoan_);
  return out;
}

// 管理頁「借用紀錄」：完整資料（要通行證）
function log_(ss, station, days) {
  var since = days ? Date.now() - days * 864e5 : 0;
  var loans = readLog_(logSheet_(ss)).filter(function (r) {
    if (!r[C.id] || (station && String(r[C.station]) !== station)) return false;
    if (!since) return true;
    var open = !r[C.inAt] && r[C.status] !== '已作廢';
    return open || ms_(r[C.outAt]) >= since || ms_(r[C.inAt]) >= since;
  }).map(fullLoan_);
  return { ok: true, loans: loans, time: Date.now() };
}

function fullLoan_(r) {
  return {
    id: String(r[C.id]), device: String(r[C.device]), name: String(r[C.name]), email: String(r[C.email]), role: String(r[C.role]),
    cls: String(r[C.cls]), memo: String(r[C.memo]), outAt: ms_(r[C.outAt]), inAt: ms_(r[C.inAt]) || null, void: r[C.status] === '已作廢',
    batch: String(r[C.batch]), station: String(r[C.station]), updated: ms_(r[C.updated])
  };
}

function publicLoan_(r) {
  var l = fullLoan_(r);
  l.name = mask_(l.name);
  delete l.email; delete l.memo;
  return l;
}

function publicConfig_(c) {
  var o = {};
  Object.keys(c || {}).forEach(function (k) { if (k !== 'pin') o[k] = c[k]; });
  return o;
}

// 王小明 → 王○明、王明 → 王○
function mask_(s) {
  var a = Array.from(String(s || ''));
  if (a.length <= 1) return a.join('');
  if (a.length === 2) return a[0] + '○';
  return a[0] + new Array(a.length - 1).join('○') + a[a.length - 1];
}

function normUid_(s) { return String(s || '').replace(/\s+/g, '').toUpperCase(); }

function findCard_(ss, station, uid) {
  var cs = ss.getSheetByName(CARDS), key = normUid_(uid), hit = null;
  if (!key || !cs || cs.getLastRow() < 2) return null;
  cs.getRange(2, 1, cs.getLastRow() - 1, 5).getValues().forEach(function (r) {
    if (normUid_(r[1]) !== key) return;
    if (!hit || String(r[0]) === station) hit = { name: String(r[2]), role: String(r[3]), cls: String(r[4]) };
  });
  return hit;
}

function cardLookup_(ss, station, uid) {
  var c = findCard_(ss, station, uid);
  return c ? { ok: true, found: true, name: mask_(c.name), role: c.role, cls: c.cls } : { ok: true, found: false };
}

// ---------- 寫入 ----------
// 一般借還只能：新增借出紀錄、標記歸還（或復原歸還）。改姓名、作廢要通行證。
function upsert_(ss, sh, loans, admin) {
  if (!loans.length) return [];
  var rows = readLog_(sh), index = {};
  rows.forEach(function (r, i) { if (r[C.id]) index[String(r[C.id])] = i; });
  var now = Date.now(), saved = [], appendRows = [];
  loans.forEach(function (l) {
    if (!l || !l.id) return;
    var id = String(l.id), i = index[id];
    if (i !== undefined) {
      var r = rows[i];
      if (ms_(r[C.updated]) > Number(l.updated || 0)) { saved.push(id); return; }  // 試算表上的比較新
      var wasVoid = r[C.status] === '已作廢', isVoid = admin ? !!l.void : wasVoid;
      var inAt = l.inAt ? new Date(Number(l.inAt)) : '';
      r[C.inAt] = inAt;
      r[C.status] = isVoid ? '已作廢' : (inAt ? '已歸還' : '借出中');
      r[C.updated] = Number(l.updated || now);
      r[C.synced] = now;
      sh.getRange(i + 2, 1, 1, HEAD.length).setValues([r]);
      saved.push(id);
      return;
    }
    var who = { name: String(l.name || ''), email: String(l.email || ''), role: String(l.role || ''), cls: String(l.cls || '') };
    if (l.card) {
      var c = findCard_(ss, String(l.station || ''), l.card);
      if (c) who = { name: c.name, email: '', role: c.role, cls: c.cls };
    }
    var row = [
      id, String(l.device || ''), who.name, who.email, who.role, who.cls, String(l.memo || ''),
      l.outAt ? new Date(Number(l.outAt)) : new Date(now), l.inAt ? new Date(Number(l.inAt)) : '',
      l.inAt ? '已歸還' : '借出中',
      String(l.station || ''), String(l.batch || ''), Number(l.updated || now), now
    ];
    appendRows.push(row);
    index[id] = rows.length;
    rows.push(row);
    saved.push(id);
  });
  if (appendRows.length) sh.getRange(sh.getLastRow() + 1, 1, appendRows.length, HEAD.length).setValues(appendRows);
  return saved;
}

function renameStation_(ss, sh, from, to) {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('devices:' + from);
  var bak = ss.getSheetByName(BAK);
  if (bak && bak.getLastRow() > 1) {
    var rg = bak.getRange(2, 1, bak.getLastRow() - 1, 3), v = rg.getValues();
    var keep = v.filter(function (r) { return String(r[0]) !== from; });
    rg.clearContent();
    if (keep.length) bak.getRange(2, 1, keep.length, 3).setValues(keep);
  }
  var n = sh.getLastRow() - 1;
  if (n > 0) {
    var col = sh.getRange(2, C.station + 1, n, 1), vals = col.getValues();
    col.setValues(vals.map(function (r) { return [String(r[0]) === from ? to : r[0]]; }));
  }
  var cs = ss.getSheetByName(CARDS);
  if (cs && cs.getLastRow() > 1) {
    var cc = cs.getRange(2, 1, cs.getLastRow() - 1, 1), cv = cc.getValues();
    cc.setValues(cv.map(function (r) { return [String(r[0]) === from ? to : r[0]]; }));
  }
}

// ---------- 試算表 ----------
function getSs_() {
  var active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (active) return active;  // 從試算表「擴充功能 → Apps Script」建立的專案
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SS_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) {}
  }
  var ss = SpreadsheetApp.create('平板借還紀錄');
  props.setProperty('SS_ID', ss.getId());
  return ss;
}

function logSheet_(ss) {
  var sh = ss.getSheetByName(LOG);
  if (!sh) {
    sh = ss.getSheets().length === 1 && ss.getSheets()[0].getLastRow() === 0 ? ss.getSheets()[0].setName(LOG) : ss.insertSheet(LOG, 0);
    sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold').setBackground('#EAF3FF');
    sh.setFrozenRows(1);
    sh.getRange('H:I').setNumberFormat('yyyy/mm/dd hh:mm');
    sh.setColumnWidth(2, 90); sh.setColumnWidth(3, 110); sh.setColumnWidth(4, 200); sh.setColumnWidth(6, 110); sh.setColumnWidth(7, 160);
    sh.setColumnWidths(8, 2, 130);
    sh.hideColumns(1); sh.hideColumns(12, 3);
  }
  return sh;
}

function nowSheet_(ss) {
  var sh = ss.getSheetByName(NOW);
  if (!sh) sh = ss.insertSheet(NOW, 0);
  return sh;
}

function readLog_(sh) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, HEAD.length).getValues();
}

function ms_(v) {
  if (v instanceof Date) return v.getTime();
  var n = Number(v);
  return n > 0 ? n : 0;
}

// ---------- 設定與感應卡 ----------
// cardsText = null 表示不動感應卡名單
function saveBackup_(ss, station, config, cardsText) {
  var sh = ss.getSheetByName(BAK);
  if (!sh) {
    sh = ss.insertSheet(BAK);
    sh.getRange(1, 1, 1, 3).setValues([['平板車', '設定(JSON)', '更新時間']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  var rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues() : [];
  var at = -1;
  rows.forEach(function (r, i) { if (String(r[0]) === station) at = i; });
  var row = [station, JSON.stringify(config), new Date()];
  if (at >= 0) sh.getRange(at + 2, 1, 1, 3).setValues([row]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, 3).setValues([row]);
  if (cardsText === null) return true;

  // 感應卡一張一列，方便在試算表上查看
  var cs = ss.getSheetByName(CARDS);
  if (!cs) {
    cs = ss.insertSheet(CARDS);
    cs.getRange(1, 1, 1, 5).setValues([['平板車', '卡號', '姓名', '身分', '班級座號']]).setFontWeight('bold');
    cs.setFrozenRows(1);
    cs.getRange('B:B').setNumberFormat('@');
  }
  var keep = cs.getLastRow() > 1 ? cs.getRange(2, 1, cs.getLastRow() - 1, 5).getValues().filter(function (r) { return r[0] && String(r[0]) !== station; }) : [];
  var mine = cardsText.split(/\r?\n/).map(function (line) {
    var p = line.split(/[,，\t]/).map(function (s) { return s.trim(); });
    return p[0] && p[1] ? [station, p[0], p[1], p[2] || '', p[3] || ''] : null;
  }).filter(Boolean);
  var all = keep.concat(mine);
  if (cs.getLastRow() > 1) cs.getRange(2, 1, cs.getLastRow() - 1, 5).clearContent();
  if (all.length) cs.getRange(2, 1, all.length, 5).setValues(all);
  return true;
}

function listBackups_(ss) {
  var sh = ss.getSheetByName(BAK), out = [];
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    if (!r[0]) return;
    var c = null;
    try { c = JSON.parse(r[1]); } catch (e) {}
    if (c) out.push({ station: String(r[0]), config: c });
  });
  return out;
}

function readBackup_(ss, station) {
  var out = { config: null, cards: '' };
  listBackups_(ss).forEach(function (b) { if (b.station === station) out.config = b.config; });
  var cs = ss.getSheetByName(CARDS);
  if (cs && cs.getLastRow() > 1) {
    out.cards = cs.getRange(2, 1, cs.getLastRow() - 1, 5).getValues()
      .filter(function (r) { return String(r[0]) === station && r[1]; })
      .map(function (r) { return [r[1], r[2], r[3], r[4]].join(',').replace(/,+$/, ''); }).join('\n');
  }
  return out;
}

// 「現況」：每台車的每台平板目前狀態，借出中排前面
function rebuildNow_(ss, sh) {
  var props = PropertiesService.getScriptProperties().getProperties();
  var stations = Object.keys(props).filter(function (k) { return k.indexOf('devices:') === 0; }).map(function (k) { return k.slice(8); }).sort();
  var open = {};
  readLog_(sh).forEach(function (r) {
    if (r[C.inAt] || r[C.status] !== '借出中') return;
    open[r[C.station] + '\u0001' + r[C.device]] = r;
  });
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var head = ['平板車', '平板編號', '狀態', '借用人', '帳號', '身分', '班級座號', '用途', '借出時間', '已借多久'];
  var data = [], colors = [];
  stations.forEach(function (st) {
    var list = [];
    try { list = JSON.parse(props['devices:' + st]) || []; } catch (e) {}
    list.forEach(function (dev) {
      var r = open[st + '\u0001' + dev];
      if (!r) { data.push([st, dev, '在車上', '', '', '', '', '', '', '']); colors.push('#FFFFFF'); return; }
      var out = ms_(r[C.outAt]), late = out < today.getTime();
      data.push([st, dev, late ? '逾期未還' : '借出中', r[C.name], r[C.email], r[C.role], r[C.cls], r[C.memo], new Date(out), dur_(Date.now() - out)]);
      colors.push(late ? '#FFE4E4' : '#FFF1E6');
    });
  });
  var order = data.map(function (_, i) { return i; }).sort(function (a, b) {
    var ra = data[a][2] === '在車上' ? 1 : 0, rb = data[b][2] === '在車上' ? 1 : 0;
    return ra - rb || a - b;
  });
  data = order.map(function (i) { return data[i]; });
  colors = order.map(function (i) { return colors[i]; });

  var shNow = nowSheet_(ss);
  shNow.clear();
  var outCount = data.filter(function (r) { return r[2] !== '在車上'; }).length;
  shNow.getRange(1, 1).setValue('更新時間：' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm') +
    '　借出中 ' + outCount + ' 台／共 ' + data.length + ' 台（這張表每次借還都會自動重算，請勿手動修改）');
  shNow.getRange(1, 1).setFontColor('#6B6E85');
  shNow.getRange(2, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#EAF3FF');
  if (data.length) {
    var rg = shNow.getRange(3, 1, data.length, head.length);
    rg.setValues(data);
    rg.setBackgrounds(colors.map(function (c) { return head.map(function () { return c; }); }));
    shNow.getRange(3, 9, data.length, 1).setNumberFormat('yyyy/mm/dd hh:mm');
  }
  shNow.setFrozenRows(2);
}

function dur_(ms) {
  var m = Math.max(0, Math.round(ms / 6e4));
  if (m < 60) return m + ' 分鐘';
  if (m < 1440) return Math.floor(m / 60) + ' 小時';
  return Math.floor(m / 1440) + ' 天';
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
