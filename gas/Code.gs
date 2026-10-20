/**
 * 平板借還站 — Google 試算表同步後端
 *
 * 借還站（平板上的網頁）每次借還都會把紀錄送到這裡，寫進試算表：
 *   「借用紀錄」：一台平板借一次＝一列（像以前的紙本借用簿）
 *   「現況」　　：每台平板目前在車上還是在誰手上（每次同步自動重算）
 *
 * 安裝：
 *   1. 在這個 Apps Script 專案執行一次 setup()，按提示授權（會建立或使用試算表）
 *   2. 部署 → 新增部署作業 → 網頁應用程式：執行身分「我」、誰可以存取「所有人」
 *   3. 把產生的 …/exec 網址貼到借還站「管理 → 雲端同步」
 */

var LOG = '借用紀錄';
var NOW = '現況';
var HEAD = ['紀錄ID', '平板編號', '借用人', '帳號', '身分', '班級座號', '用途', '借出時間', '歸還時間', '狀態', '借還站', '批次', '最後更新(ms)', '同步時間(ms)'];
var C = { id: 0, device: 1, name: 2, email: 3, role: 4, cls: 5, memo: 6, outAt: 7, inAt: 8, status: 9, station: 10, batch: 11, updated: 12, synced: 13 };
var KEEP_DAYS = 400;  // 從雲端還原時最多拿回幾天內的已結案紀錄（借出中的一律回傳）

function setup() {
  var ss = getSs_();
  logSheet_(ss);
  nowSheet_(ss);
  Logger.log('試算表：' + ss.getUrl());
  return ss.getUrl();
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'pull') {
      var res = pull_(String(p.station || ''), Number(p.since) || 0);
      if (p.full && p.station) {
        var b = readBackup_(getSs_(), String(p.station));
        res.config = b.config; res.cards = b.cards;
      }
      return out_(res);
    }
    var ss = getSs_();
    return out_({ ok: true, app: 'tablet-loan', sheet: ss.getName(), time: Date.now() });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var body = JSON.parse(e.postData.contents || '{}');
    var ss = getSs_();
    var sh = logSheet_(ss);
    var saved = upsert_(sh, body.loans || []);
    if (body.station && body.devices) {
      PropertiesService.getScriptProperties().setProperty('devices:' + body.station, JSON.stringify(body.devices.slice(0, 500)));
    }
    if (body.station && body.config) saveBackup_(ss, String(body.station), body.config, String(body.cards || ''));
    rebuildNow_(ss, sh);
    return out_({ ok: true, saved: saved, time: Date.now() });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
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

function upsert_(sh, loans) {
  if (!loans.length) return [];
  var rows = readLog_(sh), index = {};
  rows.forEach(function (r, i) { if (r[C.id]) index[String(r[C.id])] = i; });
  var now = Date.now(), saved = [], appendRows = [];
  loans.forEach(function (l) {
    if (!l || !l.id) return;
    var id = String(l.id), i = index[id];
    if (i !== undefined && ms_(rows[i][C.updated]) > Number(l.updated || 0)) { saved.push(id); return; }  // 試算表上的比較新
    var row = [
      id, String(l.device || ''), String(l.name || ''), String(l.email || ''), String(l.role || ''), String(l.cls || ''), String(l.memo || ''),
      l.outAt ? new Date(Number(l.outAt)) : '', l.inAt ? new Date(Number(l.inAt)) : '',
      l.void ? '已作廢' : (l.inAt ? '已歸還' : '借出中'),
      String(l.station || ''), String(l.batch || ''), Number(l.updated || 0), now
    ];
    if (i !== undefined) {
      sh.getRange(i + 2, 1, 1, HEAD.length).setValues([row]);
      rows[i] = row;
    } else {
      appendRows.push(row);
      index[id] = rows.length;
      rows.push(row);
    }
    saved.push(id);
  });
  if (appendRows.length) sh.getRange(sh.getLastRow() + 1, 1, appendRows.length, HEAD.length).setValues(appendRows);
  return saved;
}

function pull_(station, since) {
  var sh = logSheet_(getSs_()), rows = readLog_(sh);
  var keep = Date.now() - KEEP_DAYS * 864e5, out = [];
  rows.forEach(function (r) {
    if (!r[C.id]) return;
    if (station && String(r[C.station]) !== station) return;
    if (since && ms_(r[C.synced]) <= since) return;
    var open = !r[C.inAt] && r[C.status] !== '已作廢';
    if (!since && !open && ms_(r[C.outAt]) < keep) return;
    out.push({
      id: String(r[C.id]), device: String(r[C.device]), name: String(r[C.name]), email: String(r[C.email]), role: String(r[C.role]), cls: String(r[C.cls]),
      memo: String(r[C.memo]), outAt: ms_(r[C.outAt]), inAt: ms_(r[C.inAt]) || null, void: r[C.status] === '已作廢',
      batch: String(r[C.batch]), station: String(r[C.station]), updated: ms_(r[C.updated])
    });
  });
  return { ok: true, loans: out, time: Date.now() };
}

// ---------- 借還站設定與感應卡名單備份（換新借還平板時可還原） ----------
var BAK = '設定備份';
var CARDS = '感應卡';

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
}

function readBackup_(ss, station) {
  var out = { config: null, cards: '' };
  var sh = ss.getSheetByName(BAK);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (String(r[0]) === station) { try { out.config = JSON.parse(r[1]); } catch (e) {} }
    });
  }
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
