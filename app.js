/* 平板借還站 — 主程式（掃描、借出、歸還、紀錄、Google 試算表同步） */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = TL.esc;
  var KEY_LOANS = 'tl.loans', KEY_DIRTY = 'tl.dirty', KEY_META = 'tl.meta';
  var DAY = 864e5;

  var cfg = TL.loadCfg();
  var devs = TL.buildDevices(cfg);
  var cards = TL.buildCards(cfg.cards);

  // 借用人 Google 登入：沿用場地預約同一個 Firebase 專案（已授權 pingking0220.github.io 網域）
  var FIREBASE_CONFIG = {
    apiKey: 'AIzaSyCq54PZl6uYgW4Tei-BBZr_uMmfn9AWILk',
    authDomain: 'award-seat.firebaseapp.com',
    projectId: 'award-seat',
    appId: '1:848306139968:web:48d02efaf32161a5f240a5'
  };
  var loans = [], byId = {}, openByDev = {};
  var dirty = {};
  var meta = { pullSince: 0 };

  // ---------- 儲存 ----------
  function load() {
    try { loans = JSON.parse(TL.lsGet(KEY_LOANS) || '[]') || []; } catch (e) { loans = []; }
    try { (JSON.parse(TL.lsGet(KEY_DIRTY) || '[]') || []).forEach(function (id) { dirty[id] = 1; }); } catch (e) {}
    try { meta = JSON.parse(TL.lsGet(KEY_META) || '{}') || {}; } catch (e) { meta = {}; }
    meta.pullSince = meta.pullSince || 0;
    prune();
    reindex();
  }

  // 本機只留近 400 天且已上傳的已結案紀錄，避免塞爆瀏覽器空間（雲端仍有完整紀錄）
  function prune() {
    if (loans.length < 6000) return;
    var cut = Date.now() - 400 * DAY;
    loans = loans.filter(function (l) { return !(l.inAt || l.void) || dirty[l.id] || l.outAt > cut; });
  }

  function reindex() {
    byId = {}; openByDev = {};
    loans.forEach(function (l) {
      byId[l.id] = l;
      if (!l.inAt && !l.void) openByDev[TL.norm(l.device)] = l;
    });
  }

  function persist() {
    var ok = TL.lsSet(KEY_LOANS, JSON.stringify(loans)) &&
      TL.lsSet(KEY_DIRTY, JSON.stringify(Object.keys(dirty))) &&
      TL.lsSet(KEY_META, JSON.stringify(meta));
    if (!ok) toast('⚠️ 無法儲存紀錄（瀏覽器空間不足或在無痕模式），請通知資訊組長', 'bad', 8000);
  }

  function touch(l) { l.updated = Date.now(); dirty[l.id] = 1; }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function changed() { reindex(); persist(); renderAll(); queueSync(); }

  // ---------- 時間格式 ----------
  var WK = '日一二三四五六';
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function sod(t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function hm(t) { var d = new Date(t); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  function when(t) {
    var today = sod(Date.now()), d = new Date(t);
    if (t >= today) return '今天 ' + hm(t);
    if (t >= today - DAY) return '昨天 ' + hm(t);
    return (d.getMonth() + 1) + '/' + d.getDate() + '（' + WK[d.getDay()] + '）' + hm(t);
  }
  function full(t) {
    if (!t) return '';
    var d = new Date(t);
    return d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate()) + ' ' + hm(t);
  }
  function dur(ms) {
    var m = Math.max(0, Math.round(ms / 6e4));
    if (m < 60) return m + ' 分鐘';
    if (m < 1440) return Math.floor(m / 60) + ' 小時' + (m % 60 ? ' ' + (m % 60) + ' 分' : '');
    return Math.floor(m / 1440) + ' 天';
  }
  // 前一天（含）以前借出還沒還＝逾期
  function isLate(l) { return !l.inAt && !l.void && l.outAt < sod(Date.now()); }
  function who(l) {
    var r = l.role === '教師' ? '老師' : l.role;
    if (!l.name) return l.cls || r || '—';
    return l.name + (l.cls ? '（' + l.cls + '）' : (r && l.role !== '學生' ? '（' + r + '）' : ''));
  }

  // ---------- 音效 ----------
  var actx = null;
  function unlockAudio() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch (e) {}
  }
  function beep(kind) {
    if (!actx) return;
    var seq = { add: [[988, .08], [1319, .12]], back: [[1319, .09], [988, .09], [784, .16]], err: [[196, .3]], done: [[784, .08], [988, .08], [1319, .18]] }[kind];
    try {
      var t = actx.currentTime;
      seq.forEach(function (s) {
        var o = actx.createOscillator(), g = actx.createGain();
        o.type = kind === 'err' ? 'square' : 'sine';
        o.frequency.value = s[0];
        g.gain.setValueAtTime(kind === 'err' ? .12 : .3, t);
        g.gain.exponentialRampToValueAtTime(.001, t + s[1]);
        o.connect(g); g.connect(actx.destination);
        o.start(t); o.stop(t + s[1] + .02);
        t += s[1] + .03;
      });
    } catch (e) {}
  }

  // ---------- 提示 ----------
  function toast(msg, kind, ms, action) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<span>' + esc(msg) + '</span>';
    if (action) {
      var b = document.createElement('button');
      b.textContent = action.label;
      b.onclick = function () { action.fn(); el.remove(); };
      el.appendChild(b);
    }
    var host = $('toasts');
    host.appendChild(el);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(function () { el.remove(); }, ms || 3500);
  }

  var flashTimer = 0;
  function flash(kind, icon, t1, t2, ms) {
    var f = $('flash');
    f.className = 'flash ' + kind;
    f.querySelector('.ic').textContent = icon;
    f.querySelector('.t1').textContent = t1;
    f.querySelector('.t2').textContent = t2 || '';
    void f.offsetWidth;
    f.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { f.classList.remove('show'); }, ms || 1600);
  }

  // ---------- 掃描處理 ----------
  var cart = [];            // 這次要借的平板編號
  var person = null;        // 掃借用證帶入的借用人
  var lastScan = { code: '', at: 0 }, busyUntil = 0;

  function onCode(raw, source) {
    var text = String(raw || '').trim();
    if (!text) return;
    var now = Date.now(), key = TL.norm(text);
    // 鏡頭會對同一個條碼連續觸發，3 秒內同一碼只算一次
    if (source === 'camera') {
      if (now < busyUntil) return;
      if (key === lastScan.code && now - lastScan.at < 3000) { lastScan.at = now; return; }
    }
    lastScan = { code: key, at: now };
    busyUntil = now + 700;
    activity();

    if (regWaiting) { regGot(text); return; }
    if (anyModalOpen()) return;

    var p = TL.parsePerson(text) || cards.map[key];
    if (p) { setPerson(p); return; }

    var dev = devs.map[key];
    if (!dev) {
      beep('err');
      // 讀卡機打進來、像卡號的（純數字或十六進位）→ 多半是還沒登錄的卡
      if (source === 'keyboard' && /^[0-9A-F]{6,}$/.test(key)) {
        flash('err', '📶', '這張卡還沒登錄', '卡號：' + text.slice(0, 30));
        toast('這張卡還沒登錄，請找資訊組長在「管理 → 感應卡」登錄', 'bad', 5000);
        return;
      }
      flash('err', '✕', '找不到這台平板', '掃到：' + text.slice(0, 40), 2200);
      showUnknown(text);
      return;
    }
    hideUnknown();

    var open = openByDev[TL.norm(dev)];
    if (open) { doReturn(open); return; }

    if (cart.indexOf(dev) >= 0) {
      flash('add', '👌', dev + ' 已在清單裡', '可以繼續掃下一台，或按「確認借出」', 1200);
      return;
    }
    cart.push(dev);
    beep('add');
    flash('add', '＋', dev, cart.length > 1 ? '已加入借用清單（共 ' + cart.length + ' 台）' : '請在右邊填寫借用人', 1300);
    showBorrow();
  }

  // 掃到的條碼不在平板清單：在右側面板留著說明（掃到什麼、清單是什麼），管理者可一鍵加入
  var unkText = '', unkTimer = 0;
  function showUnknown(text) {
    var L = devs.list, range = L.length ? L[0].id + (L.length > 1 ? '～' + L[L.length - 1].id : '') : '（還沒有設定）';
    unkText = text;
    $('unk').innerHTML = '<div class="uh">⚠️ 掃到了，但平板清單裡沒有這台</div>' +
      '<div class="ub">掃到的內容：<b>' + esc(text.slice(0, 60)) + '</b><br>目前平板清單：' + esc(range) + '（共 ' + L.length + ' 台）<br>' +
      '<small>標籤上的編號要和「管理 → 平板清單」一樣（借還站和印標籤的電腦是各自設定的）。</small></div>' +
      '<div class="ua"><button class="pri" id="unkAdd">把它加入平板清單</button><button id="unkClose">關閉</button></div>';
    $('unk').hidden = false;
    clearTimeout(unkTimer);
    unkTimer = setTimeout(hideUnknown, 30000);
  }
  function hideUnknown() { clearTimeout(unkTimer); $('unk').hidden = true; unkText = ''; }
  function addUnknown() {
    var text = unkText.replace(/[,，\t\r\n]/g, ' ').trim();
    if (!text) return;
    askPin(function () {
      cfg.extra = (String(cfg.extra || '').replace(/\s+$/, '') + '\n' + text).replace(/^\n/, '');
      TL.saveCfg(cfg);
      devs = TL.buildDevices(cfg);
      markCfgChanged();
      hideUnknown();
      renderAll();
      toast('已把「' + text + '」加入平板清單', 'ok');
      lastScan = { code: '', at: 0 }; busyUntil = 0;
      onCode(text, 'manual');
    });
  }

  function doReturn(l) {
    l.inAt = Date.now();
    touch(l);
    changed();
    beep('back');
    flash('back', '✓', l.device + ' 已歸還', '謝謝' + (l.name ? ' ' + l.name : '') + '！借用 ' + dur(l.inAt - l.outAt) + '，請放回車上充電', 1900);
    toast(l.device + ' 已歸還・' + who(l), 'ok', 8000, {
      label: '復原', fn: function () {
        if (!l.inAt) return;
        l.inAt = null; touch(l); changed();
        toast(l.device + ' 已改回借出中', '', 3000);
      }
    });
  }

  // ---------- 借用表單 ----------
  var role = '學生', grade = 0, klass = 0, seat = '';

  function showBorrow() {
    $('pIdle').hidden = true;
    $('pBorrow').hidden = false;
    $('bActs').hidden = false;
    renderCart();
  }

  // fromClick：由按鈕點擊觸發（有人登入過 Google 時要趁點擊當下開登出分頁）
  function resetBorrow(fromClick) {
    cart = []; person = null; role = '學生'; grade = 0; klass = 0; seat = '';
    $('name').value = ''; $('memo').value = ''; $('bErr').textContent = '';
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    $('pBorrow').hidden = true;
    $('bActs').hidden = true;
    $('pIdle').hidden = false;
    renderRole();
    renderPerson();
    renderRecent();
    if (needLogout) finishGoogle(!!fromClick);
  }

  function renderCart() {
    $('cart').innerHTML = cart.map(function (d, i) {
      return '<span class="chip">' + esc(d) + '<button data-i="' + i + '" aria-label="移除">✕</button></span>';
    }).join('');
    $('btnConfirm').textContent = cart.length ? '確認借出 ' + cart.length + ' 台' : '確認借出';
    $('btnConfirm').disabled = !cart.length;
    $('btnConfirm').style.opacity = cart.length ? '' : '.5';
  }

  function renderRole() {
    var g0 = cfg.auth === 'google';
    [].forEach.call($('roles').children, function (b) {
      b.classList.toggle('on', b.dataset.r === role);
      if (b.dataset.r === '其他') b.hidden = g0;
      if (b.dataset.r === '教師') b.textContent = g0 ? '👩‍🏫 老師／職員' : '👩‍🏫 老師';
    });
    $('gBox').hidden = !g0;
    $('nameBox').hidden = g0;
    $('howWho').textContent = g0 ? '選身分、登入學校帳號' : '選身分、填名字';
    if (g0) {
      var dom = role === '學生' ? cfg.stuDomain : cfg.tchDomain;
      $('gLabel').textContent = role === '學生' ? '用學生 Google 帳號登入' : '用老師 Google 帳號登入';
      $('gNote').innerHTML = '請用 <b>＠' + esc(dom) + '</b> 的帳號登入' + (cfg.autoLogout ? '，借完系統會自動登出。' : '。');
      $('stuBox').hidden = true;
      return;
    }
    $('stuBox').hidden = role !== '學生';
    $('nameLbl').textContent = role === '學生' ? '姓名（選填）' : '姓名';
    $('name').placeholder = role === '教師' ? '老師的名字' : '寫下你的名字';
    var g = '';
    for (var i = 1; i <= 6; i++) g += '<button data-g="' + i + '" class="' + (grade === i ? 'on' : '') + '">' + i + ' 年</button>';
    $('gradePick').innerHTML = g;
    var c = '', n = Math.max(1, Math.min(20, parseInt(cfg.classes, 10) || 8));
    for (var j = 1; j <= n; j++) c += '<button data-c="' + j + '" class="' + (klass === j ? 'on' : '') + '">' + j + ' 班</button>';
    $('classPick').innerHTML = c;
    renderSeat();
    renderNames();
  }

  // 座號用螢幕上的數字鍵：接了讀卡機（算外接鍵盤）時 iPad 不會自動跳出鍵盤
  function renderSeat() {
    $('seatV').textContent = seat || '—';
    $('seatV').classList.toggle('empty', !seat);
  }
  function seatPress(k) {
    if (k === '⌫') seat = seat.slice(0, -1);
    else if (seat.length < 2) seat = (seat + k).replace(/^0+/, '');
    renderSeat();
  }

  // 最近 60 天借過的老師／其他人，點一下就帶入姓名
  function renderNames() {
    if (role === '學生') { $('names').innerHTML = ''; return; }
    var seen = {}, out = [], since = Date.now() - 60 * DAY;
    for (var i = loans.length - 1; i >= 0 && out.length < 10; i--) {
      var l = loans[i];
      if (l.void || !l.name || l.role !== role || l.outAt < since || seen[l.name]) continue;
      seen[l.name] = 1; out.push(l.name);
    }
    $('names').innerHTML = out.map(function (n) { return '<button data-n="' + esc(n) + '">' + esc(n) + '</button>'; }).join('');
  }

  function setPerson(p) {
    person = p;
    $('bErr').textContent = '';
    beep('add');
    flash('done', p.email ? '✅' : '🪪', p.name, cart.length ? '已確認借用人' : '請掃描要借的平板', 1400);
    showBorrow();
    renderPerson();
  }

  function renderPerson() {
    $('personBox').hidden = !person;
    $('whoBox').hidden = !!person;
    if (!person) { $('personBox').innerHTML = ''; return; }
    $('personBox').innerHTML = '<div class="person"><div><div class="pn">' + (person.email ? '✅ ' : '🪪 ') + esc(person.name) + '</div><div class="pr">' +
      esc([person.role === '教師' ? '老師' : person.role, person.cls].filter(Boolean).join('・') || '借用證') + '</div>' +
      (person.email ? '<div class="pe">' + esc(person.email) + '</div>' : '') +
      '</div><button id="clearPerson">不是我</button></div>';
  }

  // ---------- Google 帳號登入（借用人驗證） ----------
  var fbAuth = null, fbLoading = null, needLogout = false, signingIn = false;

  function loadFirebase() {
    if (fbLoading) return fbLoading;
    var base = 'https://www.gstatic.com/firebasejs/10.12.0/';
    fbLoading = ['firebase-app-compat.js', 'firebase-auth-compat.js'].reduce(function (p, f) {
      return p.then(function () {
        return new Promise(function (res, rej) {
          var s = document.createElement('script');
          s.src = base + f; s.onload = res; s.onerror = function () { rej(new Error('登入元件載入失敗')); };
          document.head.appendChild(s);
        });
      });
    }, Promise.resolve()).then(function () {
      var app = firebase.initializeApp(FIREBASE_CONFIG, 'tablet-loan');
      fbAuth = app.auth();
      // 不把登入狀態存在借還平板上
      return fbAuth.setPersistence(firebase.auth.Auth.Persistence.NONE);
    }).catch(function (e) { fbLoading = null; throw e; });
    return fbLoading;
  }

  function googleSignIn() {
    activity();
    if (!fbAuth) {
      bErr('登入元件還在載入，請稍等再按一次');
      loadFirebase().catch(function () { bErr('登入元件載入失敗，請檢查網路'); });
      return;
    }
    var r = role === '學生' ? '學生' : '教師';
    var dom = String(r === '學生' ? cfg.stuDomain : cfg.tchDomain).replace(/^@/, '').toLowerCase();
    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ hd: dom, prompt: 'select_account' });
    needLogout = true; signingIn = true;
    $('bErr').textContent = '';
    // 必須在點擊當下呼叫，Safari 才不會擋彈出視窗
    fbAuth.signInWithPopup(provider).then(function (cred) {
      var u = cred.user, email = String(u.email || '').toLowerCase();
      signingIn = false;
      fbAuth.signOut();
      activity();
      if (!email.endsWith('@' + dom)) {
        bErr((r === '學生' ? '學生' : '老師') + '請用 @' + dom + ' 的帳號登入（剛剛登入的是 ' + email + '）');
        return;
      }
      setPerson({ name: u.displayName || email.split('@')[0], role: r, cls: '', email: email });
    }).catch(function (err) {
      var c = (err && err.code) || '';
      signingIn = false;
      activity();
      bErr(c === 'auth/popup-blocked' ? '登入視窗被擋住了：請到「設定 → Safari」關閉「阻擋彈出式視窗」' :
        c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request' ? '登入視窗已關閉，請再按一次登入' :
        c === 'auth/network-request-failed' ? '網路連線失敗，請稍後再試' :
        c === 'auth/unauthorized-domain' ? '這個網址還沒有開放 Google 登入，請通知資訊組長' :
        '登入失敗：' + (c || (err && err.message) || err));
    });
  }

  // 借完把這台借還平板上的 Google 登入狀態清乾淨，下一個人才不會選到上一個人的帳號
  // fromClick：是不是在使用者點擊的當下呼叫（Safari 只允許點擊當下開新視窗）
  function finishGoogle(fromClick) {
    needLogout = false;
    if (fbAuth) fbAuth.signOut();
    if (!cfg.autoLogout) return;
    if (fromClick && logoutPopup()) return;
    // 不是點擊觸發（例如逾時取消）：擋住畫面，等下一個人點一下再登出
    var box = document.createElement('button');
    box.className = 'loggingout';
    box.innerHTML = '🔒 請點一下，完成 Google 登出<small>上一位借用人還沒登出，點一下就好</small>';
    box.onclick = function () { logoutPopup(); box.remove(); };
    document.body.appendChild(box);
  }

  // 在新分頁開 Google 登出頁，2.5 秒後自動關掉回到借還站
  function logoutPopup() {
    var w = null;
    try { w = window.open('https://accounts.google.com/Logout', 'tl_logout'); } catch (e) {}
    if (!w) return false;
    setTimeout(function () { try { w.close(); } catch (e) {} try { window.focus(); } catch (e) {} }, 2500);
    return true;
  }

  function confirmBorrow() {
    activity();
    if (!cart.length) return;
    var b = { name: '', role: role, cls: '', email: '' };
    if (person) {
      b = { name: person.name, role: person.role || '其他', cls: person.cls || '', email: person.email || '' };
    } else if (cfg.auth === 'google') {
      return bErr('請先按「用' + (role === '學生' ? '學生' : '老師') + ' Google 帳號登入」');
    } else if (role === '學生') {
      var sn = parseInt(seat, 10);
      if (!grade || !klass || !(sn > 0)) return bErr('請選年級、班級並按座號');
      b.cls = grade + p2(klass) + '班' + sn + '號';
      b.name = $('name').value.trim();
    } else {
      b.name = $('name').value.trim();
      if (!b.name) return bErr('請填寫姓名');
    }
    var memo = $('memo').value.trim(), now = Date.now(), batch = cart.length > 1 ? uid() : '';
    var made = [];
    cart.forEach(function (dev) {
      if (openByDev[TL.norm(dev)]) return;  // 保險：同時被別台借走就跳過
      var l = { id: uid(), device: dev, name: b.name, email: b.email, role: b.role, cls: b.cls, memo: memo, outAt: now, inAt: null, void: false, batch: batch, station: cfg.station };
      touch(l);
      loans.push(l);
      made.push(dev);
    });
    changed();
    beep('done');
    flash('done', '🎉', '借出成功！', made.join('、') + '｜用完記得回來掃描歸還', needLogout ? 4500 : 2600);
    resetBorrow(true);
  }

  function bErr(msg) { $('bErr').textContent = msg; beep('err'); }

  // ---------- 待機面板 ----------
  function renderRecent() {
    var ev = [], since = Date.now() - 2 * DAY;
    for (var i = loans.length - 1; i >= 0 && ev.length < 40; i--) {
      var l = loans[i];
      if (l.void) continue;
      if (l.inAt && l.inAt > since) ev.push({ t: l.inAt, k: 'i', l: l });
      if (l.outAt > since) ev.push({ t: l.outAt, k: 'o', l: l });
    }
    ev.sort(function (a, b) { return b.t - a.t; });
    ev = ev.slice(0, 7);
    $('recent').innerHTML = ev.length ? ev.map(function (e) {
      return '<li><span class="tm">' + (e.t >= sod(Date.now()) ? hm(e.t) : '昨天') + '</span><span class="tag ' + e.k + '">' + (e.k === 'o' ? '借出' : '歸還') +
        '</span><span class="dv">' + esc(e.l.device) + '</span><span class="nm">' + esc(who(e.l)) + '</span></li>';
    }).join('') : '<li class="none">還沒有借還紀錄</li>';
  }

  function counts() {
    var c = { inn: 0, out: 0, late: 0 };
    devs.list.forEach(function (d) {
      var l = openByDev[TL.norm(d.id)];
      if (!l) c.inn++; else { c.out++; if (isLate(l)) c.late++; }
    });
    return c;
  }

  function renderBar() {
    var c = counts();
    $('stName').textContent = cfg.station || '平板車';
    $('nIn').textContent = c.inn; $('nOut').textContent = c.out; $('nLate').textContent = c.late;
    $('lateBox').hidden = !c.late;
    document.title = (cfg.station || '平板') + ' 借還站';
    renderSyncBadge();
  }

  function renderAll() {
    renderBar();
    renderRecent();
    if (!$('mStatus').hidden) renderStatus();
    if (!$('mAdmin').hidden) renderLog();
  }

  function tickClock() {
    var d = new Date();
    $('clock').textContent = (d.getMonth() + 1) + '/' + d.getDate() + '（' + WK[d.getDay()] + '）' + hm(d.getTime());
  }

  // ---------- 相機（自己開鏡頭，用 zxing-wasm 解碼） ----------
  // 輪流掃「畫面中央（瞄準框，保留原解析度）」和「整張畫面（縮小）」：
  // 中央裁切讓小標籤也夠清楚，整張畫面讓沒對準的也掃得到；每張只解一小塊，iPad 不會卡頓。
  var stream = null, camOn = false, camStarting = false, scanTimer = 0, decoding = false, scanTick = 0;
  var CROP = 0.62;            // 中央正方形佔畫面短邊的比例（和瞄準框一致）
  var READ_OPTS = { formats: ['QRCode', 'Code128', 'Code39', 'EAN13'], tryHarder: true, maxNumberOfSymbols: 1 };
  var grab = document.createElement('canvas'), grabCtx = grab.getContext('2d', { willReadFrequently: true });
  var zxReady = null;

  function prepareReader() {
    if (zxReady) return zxReady;
    if (!window.ZXingWASM) return Promise.reject(new Error('掃描元件載入失敗，請重新整理網頁。'));
    zxReady = Promise.resolve(ZXingWASM.prepareZXingModule({
      overrides: { locateFile: function (path, prefix) { return /\.wasm$/.test(path) ? 'vendor/' + path : prefix + path; } },
      fireImmediately: true
    })).catch(function (e) { zxReady = null; throw e; });
    return zxReady;
  }

  function startCam(testStream) {
    if (camOn || camStarting) return;
    $('camSleep').hidden = true;
    $('camErr').hidden = true;
    if (!testStream && !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      camError(window.isSecureContext ? '這個瀏覽器不能使用相機，請改用 Safari 或 Chrome。' : '相機只能在 https 網址使用。');
      return;
    }
    camStarting = true;
    prepareReader().catch(function (e) { camError((e && e.message) || '掃描元件載入失敗，請重新整理網頁。'); });
    var get = testStream ? Promise.resolve(testStream) : navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: cfg.camera }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    });
    get.then(function (s) {
      stream = s;
      var v = $('video');
      v.muted = true; v.setAttribute('playsinline', ''); v.srcObject = s;
      return v.play();
    }).then(function () {
      camOn = true; camStarting = false;
      $('cam').classList.toggle('mirror', cfg.camera === 'user' && !testStream);
      layoutAim();
      focusContinuous();
      wake();
      scheduleScan(200);
    }).catch(function (e) {
      camStarting = false;
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      var m = String(e && (e.name || e.message) || e);
      if (/NotAllowed|Permission/i.test(m)) camError('相機權限被拒絕。請到「設定 → Safari → 相機」改成「允許」，再按「再試一次」。');
      else if (/NotFound|Overconstrained|NotReadable/i.test(m)) camError('找不到可用的鏡頭（或被其他 App 占用），請到管理 → 基本設定換一個鏡頭。');
      else camError('錯誤訊息：' + m);
    });
  }

  // 後鏡頭有自動對焦就打開連續對焦（前鏡頭多半是定焦，失敗就算了）
  function focusContinuous() {
    try {
      var t = stream && stream.getVideoTracks()[0], caps = t && t.getCapabilities ? t.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
    } catch (e) {}
  }

  function scheduleScan(ms) {
    clearTimeout(scanTimer);
    if (camOn) scanTimer = setTimeout(scanFrame, ms || 80);
  }

  function scanFrame() {
    var v = $('video');
    if (!camOn) return;
    if (decoding || !v.videoWidth || document.visibilityState !== 'visible') { scheduleScan(150); return; }
    var vw = v.videoWidth, vh = v.videoHeight, sx, sy, sw, sh, ow, oh;
    if (scanTick++ % 3 < 2) {
      // 中央瞄準框：原解析度裁切，最多 800px
      sw = sh = Math.round(Math.min(vw, vh) * CROP);
      sx = (vw - sw) / 2; sy = (vh - sh) / 2;
      ow = oh = Math.min(sw, 800);
    } else {
      // 整張畫面縮到寬 960
      sx = 0; sy = 0; sw = vw; sh = vh;
      ow = Math.min(vw, 960); oh = Math.round(vh * ow / vw);
    }
    grab.width = ow; grab.height = oh;
    grabCtx.drawImage(v, sx, sy, sw, sh, 0, 0, ow, oh);
    var img = grabCtx.getImageData(0, 0, ow, oh);
    decoding = true;
    prepareReader().then(function () {
      return ZXingWASM.readBarcodes(img, READ_OPTS);
    }).then(function (res) {
      decoding = false;
      var hit = (res || []).filter(function (r) { return r.isValid && r.text; })[0];
      if (hit) onCode(hit.text, 'camera');
      scheduleScan(hit ? 300 : 70);
    }, function () {
      decoding = false;
      scheduleScan(500);
    });
  }

  // 瞄準框對齊實際解碼的中央區域（影片是 object-fit: cover，要換算縮放）
  function layoutAim() {
    var v = $('video'), cam = $('cam'), aim = document.querySelector('.aim');
    if (!v.videoWidth) return;
    var cw = cam.clientWidth, ch = cam.clientHeight;
    var scale = Math.max(cw / v.videoWidth, ch / v.videoHeight);
    var size = Math.round(Math.min(v.videoWidth, v.videoHeight) * CROP * scale);
    aim.style.width = aim.style.height = Math.min(size, cw - 24, ch - 24) + 'px';
  }

  function stopCam(sleep) {
    clearTimeout(scanTimer);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; camOn = false; camStarting = false;
    var v = $('video');
    if (v) v.srcObject = null;
    if (sleep) $('camSleep').hidden = false;
  }

  function camError(msg) {
    $('camErrMsg').textContent = msg;
    $('camErr').hidden = false;
    $('camSleep').hidden = true;
  }

  function flipCam() {
    cfg.camera = cfg.camera === 'user' ? 'environment' : 'user';
    TL.saveCfg(cfg);
    stopCam(false);
    startCam();
  }

  // 螢幕保持常亮（Safari 16.4 以上支援）
  var wakeLock = null;
  function wake() {
    try {
      if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
        navigator.wakeLock.request('screen').then(function (w) {
          wakeLock = w; w.addEventListener('release', function () { wakeLock = null; });
        }, function () {});
      }
    } catch (e) {}
  }

  // ---------- 閒置 ----------
  var lastAct = Date.now();
  function activity() { lastAct = Date.now(); }
  function idleCheck() {
    var idle = Date.now() - lastAct;
    if (signingIn) return;  // 正在 Google 登入視窗裡打帳密，不要倒數
    if (cart.length || person) {
      if (idle > 120e3) { resetBorrow(); toast('太久沒有動作，已取消這次借用', '', 5000); }
      return;
    }
    // 沒人使用 3 分鐘就關鏡頭省電，點一下再開
    if (camOn && idle > 180e3 && !anyModalOpen()) stopCam(true);
  }

  // ---------- 條碼槍／感應讀卡機（都是模擬鍵盤輸入） ----------
  // 讀卡機會在幾十毫秒內「打」完整串卡號再按 Enter；人打字慢得多，用速度分辨。
  // 游標停在輸入框時，讀卡機打進去的字會被收回來當成刷卡（管理頁的輸入框除外，方便直接刷卡填卡號）。
  var kbuf = '', kstart = 0, klast = 0;
  function onKey(e) {
    var el = e.target, tag = (el && el.tagName) || '';
    var field = /INPUT|TEXTAREA|SELECT/.test(tag);
    if (field && el.closest && el.closest('#mAdmin') && !regWaiting) return;
    var now = Date.now();
    if (now - klast > 100) { kbuf = ''; kstart = now; }
    klast = now;
    if (e.key === 'Enter') {
      var s = kbuf, fast = s.length >= 4 && (now - kstart) / s.length < 40;
      kbuf = '';
      if (s.length < 2 || (field && !fast)) return;
      e.preventDefault();
      if (field && typeof el.value === 'string' && el.value.slice(-s.length) === s) el.value = el.value.slice(0, -s.length);
      onCode(s, 'keyboard');
      return;
    }
    if (e.key && e.key.length === 1) kbuf += e.key;
  }

  // ---------- 現況 ----------
  var statusFilter = 'all';
  function renderStatus() {
    var q = TL.norm($('statusQ').value), c = counts();
    $('statusSum').textContent = '共 ' + devs.list.length + ' 台｜在車上 ' + c.inn + '｜借出 ' + c.out + (c.late ? '｜逾期 ' + c.late : '');
    var html = devs.list.map(function (d) {
      var l = openByDev[TL.norm(d.id)], late = l && isLate(l);
      var st = !l ? 'in' : late ? 'late' : 'out';
      if (statusFilter === 'in' && st !== 'in') return '';
      if (statusFilter === 'out' && st === 'in') return '';
      if (statusFilter === 'late' && st !== 'late') return '';
      if (q && TL.norm(d.id + (l ? l.name + l.cls : '')).indexOf(q) < 0) return '';
      return '<button class="tile ' + st + '" data-d="' + esc(d.id) + '"><div class="tid">' + esc(d.id) + '</div>' +
        '<span class="ts">' + (st === 'in' ? '在車上' : st === 'late' ? '逾期未還' : '借出中') + '</span>' +
        (l ? '<div class="tw">' + esc(who(l)) + '</div><div class="tw">' + esc(when(l.outAt)) + ' 借出</div>' : '') + '</button>';
    }).join('');
    $('statusGrid').innerHTML = html || '<div class="none">沒有符合的平板</div>';
  }

  function showDetail(devId) {
    var l = openByDev[TL.norm(devId)];
    $('dTitle').textContent = '📱 ' + devId;
    var hist = loans.filter(function (x) { return x.device === devId && !x.void; }).slice(-5).reverse();
    var h = '';
    if (l) {
      var same = l.batch ? loans.filter(function (x) { return x.batch === l.batch && !x.inAt && !x.void; }) : [l];
      h += '<dl class="kv"><dt>狀態</dt><dd>' + (isLate(l) ? '<span class="s l">逾期未還</span>' : '<span class="s o">借出中</span>') + '</dd>' +
        '<dt>借用人</dt><dd>' + esc(l.name) + '</dd>' +
        '<dt>身分</dt><dd>' + esc((l.role === '教師' ? '老師' : l.role) + (l.cls ? '・' + l.cls : '')) + '</dd>' +
        (l.memo ? '<dt>用途</dt><dd>' + esc(l.memo) + '</dd>' : '') +
        '<dt>借出時間</dt><dd>' + esc(full(l.outAt)) + '（' + dur(Date.now() - l.outAt) + '前）</dd></dl>' +
        '<div class="mbtns"><button class="mb pri" data-act="ret" data-id="' + l.id + '">手動標記歸還</button>' +
        (same.length > 1 ? '<button class="mb" data-act="retb" data-id="' + l.id + '">同一批借的 ' + same.length + ' 台全部標記歸還</button>' : '') +
        '</div><p class="note" style="margin-top:10px">平板在手邊時，直接掃描條碼就會歸還；手動歸還需要管理密碼。</p>';
    } else {
      h += '<dl class="kv"><dt>狀態</dt><dd><span class="s i">在車上</span></dd></dl>';
    }
    if (hist.length) {
      h += '<div class="sec" style="margin-top:16px">最近借用</div><ul class="recent">' + hist.map(function (x) {
        return '<li><span class="tag ' + (x.inAt ? 'i' : 'o') + '">' + (x.inAt ? '已還' : '借出中') + '</span><span class="nm" style="color:var(--ink)">' +
          esc(who(x)) + '</span><span class="tm" style="width:auto;margin-left:auto">' + esc(when(x.outAt)) + '</span></li>';
      }).join('') + '</ul>';
    }
    $('dBody').innerHTML = h;
    openModal('mDetail');
  }

  function manualReturn(id, wholeBatch) {
    var l = byId[id];
    if (!l) return;
    askPin(function () {
      var list = wholeBatch && l.batch ? loans.filter(function (x) { return x.batch === l.batch && !x.inAt && !x.void; }) : [l];
      var now = Date.now();
      list.forEach(function (x) { if (!x.inAt) { x.inAt = now; touch(x); } });
      changed();
      closeModal('mDetail');
      toast('已標記歸還 ' + list.map(function (x) { return x.device; }).join('、'), 'ok', 4000);
    });
  }

  // ---------- 密碼 ----------
  var pinBuf = '', pinCb = null;
  function askPin(cb) {
    if (pinOkUntil > Date.now()) { pinOkUntil = Date.now() + 5 * 60e3; cb(); return; }
    pinBuf = ''; pinCb = cb;
    $('pinMsg').textContent = '';
    renderPin();
    openModal('mPin');
  }
  var pinOkUntil = 0;
  function renderPin() {
    var n = Math.max(4, String(cfg.pin).length), h = '';
    for (var i = 0; i < n; i++) h += '<i class="' + (i < pinBuf.length ? 'f' : '') + '"></i>';
    $('pinDots').innerHTML = h;
  }
  function pinPress(k) {
    activity();
    if (k === '⌫') pinBuf = pinBuf.slice(0, -1);
    else if (k === 'C') pinBuf = '';
    else if (pinBuf.length < 6) pinBuf += k;
    renderPin();
    if (pinBuf.length >= String(cfg.pin).length) {
      if (pinBuf === String(cfg.pin)) {
        pinOkUntil = Date.now() + 5 * 60e3;  // 5 分鐘內不用再輸入
        closeModal('mPin');
        var cb = pinCb; pinCb = null;
        if (cb) cb();
      } else {
        var d = $('pinDots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake');
        $('pinMsg').textContent = '密碼不對，再試一次';
        pinBuf = '';
        setTimeout(renderPin, 400);
      }
    }
  }

  // ---------- 彈出視窗 ----------
  function openModal(id) { $(id).hidden = false; activity(); }
  function closeModal(id) {
    $(id).hidden = true;
    if (id !== 'mAdmin') return;
    regStop();
    // 第一次設定時沒按「儲存設定」就關掉：一樣當作設定完成，直接開始借還（不然每次開都卡在歡迎畫面）
    if (!cfg.setupDone) {
      cfg.setupDone = true;
      TL.saveCfg(cfg);
      startCam();
    }
  }
  function anyModalOpen() { return [].some.call(document.querySelectorAll('.modal'), function (m) { return !m.hidden; }); }

  // ---------- 點選平板（不用掃描） ----------
  var pickMode = 'borrow', picked = [];

  function openPick(mode) {
    pickMode = mode || 'borrow';
    picked = pickMode === 'borrow' ? cart.slice() : [];
    renderPick();
    openModal('mPick');
  }

  function renderPick() {
    [].forEach.call($('pickTabs').children, function (b) { b.classList.toggle('on', b.dataset.m === pickMode); });
    var tiles = devs.list.filter(function (d) {
      var out = !!openByDev[TL.norm(d.id)];
      return pickMode === 'borrow' ? !out : out;
    });
    $('pickHint').textContent = pickMode === 'borrow'
      ? (tiles.length ? '點選要借的平板（可以選很多台），再按「下一步」填借用人。' : '目前車上沒有可以借的平板。')
      : (tiles.length ? '點選要還的平板（可以選很多台），按「確認歸還」。還完記得放回車上插電。' : '目前沒有借出中的平板。');
    $('pickGrid').innerHTML = tiles.map(function (d) {
      var l = openByDev[TL.norm(d.id)], sel = picked.indexOf(d.id) >= 0;
      return '<button class="tile ' + (l ? (isLate(l) ? 'late' : 'out') : '') + (sel ? ' sel' : '') + '" data-d="' + esc(d.id) + '"><div class="tid">' + esc(d.id) + '</div>' +
        (l ? '<div class="tw">' + esc(who(l)) + '</div><div class="tw">' + esc(when(l.outAt)) + ' 借出</div>' : '<span class="ts">在車上</span>') + '</button>';
    }).join('');
    var n = picked.length;
    $('pickOk').textContent = pickMode === 'borrow' ? (n ? '下一步：填借用人（' + n + ' 台）' : '下一步') : (n ? '確認歸還 ' + n + ' 台' : '確認歸還');
    $('pickOk').style.opacity = n ? '' : '.5';
  }

  function pickOk() {
    if (!picked.length) return;
    closeModal('mPick');
    if (pickMode === 'borrow') {
      cart = picked.filter(function (d) { return !openByDev[TL.norm(d)]; });
      beep('add');
      showBorrow();
      renderPerson();
      return;
    }
    var list = picked.map(function (d) { return openByDev[TL.norm(d)]; }).filter(Boolean);
    if (list.length === 1) { doReturn(list[0]); return; }
    var now = Date.now();
    list.forEach(function (l) { l.inAt = now; touch(l); });
    changed();
    beep('back');
    flash('back', '✓', '已歸還 ' + list.length + ' 台', list.map(function (l) { return l.device; }).join('、'), 2200);
    toast('已歸還 ' + list.map(function (l) { return l.device; }).join('、'), 'ok', 8000, {
      label: '復原', fn: function () {
        list.forEach(function (l) { if (l.inAt === now) { l.inAt = null; touch(l); } });
        changed();
        toast('已改回借出中', '', 3000);
      }
    });
  }

  // ---------- 感應卡登錄 ----------
  var regWaiting = false, regUid = '', regKind = 'p';

  function regStart() {
    regWaiting = true;
    $('regForm').hidden = true;
    $('regHint').textContent = '📶 請把卡片靠近讀卡機…';
    $('regHint').classList.add('wait');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }
  function regStop() {
    regWaiting = false;
    $('regHint').textContent = '按下後把卡片靠近讀卡機（也可以用鏡頭掃原有的條碼）';
    $('regHint').classList.remove('wait');
  }
  function regGot(uidText) {
    regStop();
    regUid = uidText.trim();
    beep('add');
    var key = TL.norm(regUid), c = cards.map[key], d = devs.map[key];
    $('regUid').textContent = regUid;
    $('regWho').textContent = c ? '（目前登錄給 ' + c.name + '）' : d ? '（目前綁定 ' + d + '）' : '（新卡片）';
    regKind = d && !c ? 'd' : 'p';
    $('regName').value = c ? c.name : '';
    $('regRole').value = c && c.role ? c.role : '學生';
    $('regCls').value = c ? c.cls : '';
    $('regDev').innerHTML = devs.list.map(function (x) { return '<option' + (x.id === d ? ' selected' : '') + '>' + esc(x.id) + '</option>'; }).join('');
    renderRegKind();
    $('regForm').hidden = false;
    if (regKind === 'p' && !c) $('regName').focus();
  }
  function renderRegKind() {
    [].forEach.call($('regKind').children, function (b) { b.classList.toggle('on', b.dataset.k === regKind); });
    $('regP').hidden = regKind !== 'p';
    $('regD').hidden = regKind !== 'd';
  }
  // 從「卡號,…」多行文字中拿掉某張卡
  function withoutUid(text, key, keepFirst) {
    return String(text || '').split(/\r?\n/).map(function (line) {
      var p = line.split(/[,，\t]/).map(function (s) { return s.trim(); });
      if (keepFirst) {
        var rest = p.slice(1).filter(function (s) { return TL.norm(s) !== key; });
        return p[0] ? [p[0]].concat(rest).join(',') : line;
      }
      return TL.norm(p[0]) === key ? null : line;
    }).filter(function (l) { return l !== null; }).join('\n');
  }
  function regSave() {
    var key = TL.norm(regUid);
    if (!key) return;
    var cardsText = withoutUid(cfg.cards, key, false), extra = withoutUid(cfg.extra, key, true);
    if (regKind === 'p') {
      var name = $('regName').value.trim().replace(/[,，]/g, ' ');
      if (!name) { toast('請填寫姓名', 'bad'); return; }
      cardsText = (cardsText.trim() ? cardsText.replace(/\s+$/, '') + '\n' : '') + [regUid, name, $('regRole').value, $('regCls').value.trim().replace(/[,，]/g, ' ')].join(',');
    } else {
      var dev = $('regDev').value, found = false;
      extra = extra.split(/\r?\n/).map(function (line) {
        if (!found && TL.norm(line.split(/[,，\t]/)[0]) === TL.norm(dev)) { found = true; return line.replace(/\s+$/, '') + ',' + regUid; }
        return line;
      }).join('\n');
      if (!found) extra = (extra.trim() ? extra.replace(/\s+$/, '') + '\n' : '') + dev + ',' + regUid;
    }
    cfg.cards = cardsText; cfg.extra = extra;
    TL.saveCfg(cfg);
    cards = TL.buildCards(cfg.cards); devs = TL.buildDevices(cfg);
    markCfgChanged();
    $('sCards').value = cfg.cards; $('sExtra').value = cfg.extra;
    renderCardCount();
    $('regForm').hidden = true;
    toast(regKind === 'p' ? '已登錄：' + $('regName').value.trim() : '已綁定到 ' + $('regDev').value, 'ok');
    regStart();  // 接著登錄下一張
  }
  function renderCardCount() { $('cardCount').textContent = TL.buildCards($('sCards').value).count; }
  function saveCards() {
    cfg.cards = $('sCards').value;
    TL.saveCfg(cfg);
    cards = TL.buildCards(cfg.cards);
    markCfgChanged();
    renderCardCount();
    toast('借用人卡名單已儲存，共 ' + cards.count + ' 張', 'ok');
  }

  // ---------- 管理 ----------
  var adminTab = 'log', logRange = 1;

  function openAdmin(tab) {
    fillSettings();
    setAdminTab(tab || adminTab);
    openModal('mAdmin');
  }

  function setAdminTab(t) {
    adminTab = t;
    [].forEach.call($('atabs').children, function (b) { b.classList.toggle('on', b.dataset.t === t); });
    [].forEach.call(document.querySelectorAll('#mAdmin [data-p]'), function (p) { p.hidden = p.dataset.p !== t; });
    if (t === 'log') renderLog();
    if (t === 'cloud') renderSyncInfo();
    if (t === 'dev') renderDevPreview();
    if (t === 'card') { $('sCards').value = cfg.cards; renderCardCount(); } else { regStop(); $('regForm').hidden = true; }
  }

  function fillSettings() {
    $('sPrefix').value = cfg.prefix; $('sStart').value = cfg.start; $('sEnd').value = cfg.end; $('sDigits').value = cfg.digits;
    $('sExtra').value = cfg.extra;
    $('sSchool').value = cfg.school; $('sStation').value = cfg.station; $('sCamera').value = cfg.camera;
    $('sClasses').value = cfg.classes; $('sPin').value = cfg.pin;
    $('sAuth').value = cfg.auth; $('sStuDomain').value = cfg.stuDomain; $('sTchDomain').value = cfg.tchDomain; $('sAutoLogout').checked = !!cfg.autoLogout;
    $('sGas').value = cfg.gasUrl;
    $('sCards').value = cfg.cards;
    $('welcome').hidden = !!cfg.setupDone;
  }

  function draftDevCfg() {
    return { prefix: $('sPrefix').value, start: $('sStart').value, end: $('sEnd').value, digits: $('sDigits').value, extra: $('sExtra').value };
  }

  function renderDevPreview() {
    var d = TL.buildDevices(draftDevCfg()).list;
    var alias = d.filter(function (x) { return x.codes.length; }).length;
    $('devPreview').innerHTML = d.length
      ? '共 <b>' + d.length + '</b> 台：' + esc(d.slice(0, 4).map(function (x) { return x.id; }).join('、')) + (d.length > 4 ? ' … ' + esc(d[d.length - 1].id) : '') +
        (alias ? '｜其中 ' + alias + ' 台有對照原有條碼' : '')
      : '<span style="color:var(--red)">目前沒有任何平板，請填寫編號範圍</span>';
  }

  function saveDev() {
    var d = draftDevCfg(), list = TL.buildDevices(d).list;
    if (!list.length) { toast('平板清單是空的，請填寫編號範圍', 'bad'); return; }
    // 移除清單外但還沒歸還的平板要提醒
    var map = TL.buildDevices(d).map;
    var orphan = loans.filter(function (l) { return !l.inAt && !l.void && !map[TL.norm(l.device)]; });
    if (orphan.length && !confirm(orphan.map(function (l) { return l.device; }).join('、') + ' 還沒歸還但不在新清單裡，確定要儲存嗎？')) return;
    cfg.prefix = d.prefix; cfg.start = parseInt(d.start, 10) || 0; cfg.end = parseInt(d.end, 10) || 0; cfg.digits = parseInt(d.digits, 10) || 0; cfg.extra = d.extra;
    TL.saveCfg(cfg);
    devs = TL.buildDevices(cfg);
    markCfgChanged();
    renderAll();
    toast('平板清單已儲存，共 ' + list.length + ' 台', 'ok');
  }

  function saveSet() {
    var pin = $('sPin').value.trim();
    if (!/^\d{4,6}$/.test(pin)) { toast('管理密碼請用 4～6 位數字', 'bad'); return; }
    var station = $('sStation').value.trim();
    if (!station) { toast('請填寫平板車名稱', 'bad'); return; }
    var renamed = cfg.station !== station;
    cfg.school = $('sSchool').value.trim(); cfg.station = station; cfg.pin = pin;
    cfg.classes = Math.max(1, Math.min(20, parseInt($('sClasses').value, 10) || 8));
    cfg.auth = $('sAuth').value;
    cfg.stuDomain = $('sStuDomain').value.trim().replace(/^@/, '').toLowerCase() || TL.DEFAULT_CFG.stuDomain;
    cfg.tchDomain = $('sTchDomain').value.trim().replace(/^@/, '').toLowerCase() || TL.DEFAULT_CFG.tchDomain;
    cfg.autoLogout = $('sAutoLogout').checked;
    if (cfg.auth === 'google') loadFirebase().catch(function () {});
    var cam = $('sCamera').value, camChanged = cam !== cfg.camera;
    cfg.camera = cam;
    var first = !cfg.setupDone;
    cfg.setupDone = true;
    TL.saveCfg(cfg);
    if (renamed) { meta.pullSince = 0; persist(); }
    markCfgChanged();
    $('welcome').hidden = true;
    renderAll();
    renderRole();
    if (camChanged && camOn) flipCamTo(cam);
    toast(first ? '設定完成，可以開始借還了！' : '設定已儲存', 'ok');
    if (first) { closeModal('mAdmin'); startCam(); }
  }

  function flipCamTo(cam) {
    cfg.camera = cam === 'user' ? 'environment' : 'user';
    flipCam();
  }

  function wipe() {
    if (!confirm('確定要清除這台借還平板上的所有借用紀錄嗎？（雲端試算表的紀錄不會被刪除）')) return;
    if (!confirm('再確認一次：清除後無法復原。')) return;
    loans = []; dirty = {}; meta.pullSince = 0;
    changed();
    toast('已清除本機紀錄', 'ok');
  }

  function logRows() {
    var q = TL.norm($('logQ').value), since = logRange ? sod(Date.now()) - (logRange - 1) * DAY : 0;
    return loans.filter(function (l) {
      if (logRange && l.outAt < since && (!l.inAt || l.inAt < since) && (l.inAt || l.void)) return false;
      if (q && TL.norm([l.device, l.name, l.cls, l.memo, l.role].join(' ')).indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) { return b.outAt - a.outAt; });
  }

  function renderLog() {
    if (adminTab !== 'log') return;
    var rows = logRows();
    var out = rows.filter(function (l) { return !l.inAt && !l.void; }).length;
    $('logSum').textContent = '共 ' + rows.length + ' 筆' + (out ? '，其中 ' + out + ' 筆還沒歸還' : '') + (logRange ? '（含期間內仍借出中的）' : '');
    var shown = rows.slice(0, 300);
    $('logTable').innerHTML = '<tr><th>平板</th><th>借用人</th><th>借出</th><th>歸還</th><th>狀態</th><th></th></tr>' +
      (shown.length ? shown.map(function (l) {
        var st = l.void ? '<span class="s v">已作廢</span>' : l.inAt ? '<span class="s i">已歸還</span>' : isLate(l) ? '<span class="s l">逾期</span>' : '<span class="s o">借出中</span>';
        return '<tr class="' + (l.void ? 'void' : '') + '"><td class="d">' + esc(l.device) + '</td><td>' + esc(who(l)) +
          (l.email ? '<div class="note">' + esc(l.email) + '</div>' : '') + (l.memo ? '<div class="note">' + esc(l.memo) + '</div>' : '') + '</td><td class="t">' + esc(when(l.outAt)) + '</td><td class="t">' +
          (l.inAt ? esc(when(l.inAt)) : '—') + '</td><td>' + st + '</td><td>' +
          (!l.void && !l.inAt ? '<button data-act="lret" data-id="' + l.id + '">歸還</button> ' : '') +
          (!l.void ? '<button data-act="lvoid" data-id="' + l.id + '">作廢</button>' : '<button data-act="lunvoid" data-id="' + l.id + '">還原</button>') +
          '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="none">這段期間沒有紀錄</td></tr>') +
      (rows.length > shown.length ? '<tr><td colspan="6" class="note">只顯示最新 300 筆，完整資料請匯出 CSV</td></tr>' : '');
  }

  function exportCsv() {
    var rows = logRows().slice().reverse();
    var head = ['平板編號', '借用人', '帳號', '身分', '班級座號', '用途', '借出時間', '歸還時間', '借用時間', '狀態', '借還站'];
    var q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [head.join(',')].concat(rows.map(function (l) {
      return [l.device, l.name, l.email, l.role, l.cls, l.memo, full(l.outAt), full(l.inAt), l.inAt ? dur(l.inAt - l.outAt) : '',
        l.void ? '已作廢' : l.inAt ? '已歸還' : '借出中', l.station].map(q).join(',');
    }));
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'), d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = (cfg.station || '平板') + '借用紀錄_' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  // ---------- 雲端同步（Google Apps Script） ----------
  var sync = { busy: false, again: false, lastOk: 0, lastErr: '', lastPull: 0 };
  var devicesDirty = !!cfg.cfgUpdated, syncTimer = 0, hashJoin = false;

  function queueSync() {
    if (!cfg.gasUrl) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncNow(); }, 800);
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('連線逾時')); }, ms); })]);
  }

  function gasPost(payload) {
    // text/plain 不會觸發 CORS 預檢，Apps Script 才收得到
    return withTimeout(fetch(cfg.gasUrl, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow' }), 25000)
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j || !j.ok) throw new Error((j && j.error) || '伺服器回應錯誤'); return j; });
  }
  function gasGet(params) {
    var qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    return withTimeout(fetch(cfg.gasUrl + (cfg.gasUrl.indexOf('?') < 0 ? '?' : '&') + qs, { redirect: 'follow' }), 25000)
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j || !j.ok) throw new Error((j && j.error) || '伺服器回應錯誤'); return j; });
  }

  function merge(list) {
    var n = 0;
    (list || []).forEach(function (r) {
      if (!r || !r.id) return;
      var l = {
        id: String(r.id), device: String(r.device || ''), name: String(r.name || ''), email: String(r.email || ''), role: String(r.role || ''), cls: String(r.cls || ''),
        memo: String(r.memo || ''), outAt: +r.outAt || 0, inAt: +r.inAt || null, void: !!r.void, batch: String(r.batch || ''),
        station: String(r.station || ''), updated: +r.updated || 0
      };
      var cur = byId[l.id];
      if (!cur) { loans.push(l); byId[l.id] = l; n++; }
      else if (l.updated > cur.updated) {
        for (var k in l) cur[k] = l[k];
        delete dirty[l.id];
        n++;
      }
    });
    if (n) loans.sort(function (a, b) { return a.outAt - b.outAt; });
    return n;
  }

  function syncNow(opt) {
    opt = opt || {};
    if (!cfg.gasUrl) return Promise.resolve();
    if (sync.busy) { sync.again = true; return Promise.resolve(); }
    sync.busy = true;
    renderSyncBadge();
    var ids = Object.keys(dirty), sent = {};
    var recs = ids.map(function (id) { return byId[id]; }).filter(Boolean);
    recs.forEach(function (r) { sent[r.id] = r.updated; });
    var step = Promise.resolve();
    if (recs.length || devicesDirty || opt.push) {
      var payload = { station: cfg.station, loans: recs };
      // 平板清單、感應卡名單一起備份到試算表（換新借還平板時可以還原）
      if ((devicesDirty || opt.push) && cfg.cfgUpdated) {
        payload.devices = devs.list.map(function (d) { return d.id; });
        payload.config = backupCfg();
        payload.cards = cfg.cards;
      }
      step = gasPost(payload).then(function (j) {
        (j.saved || []).forEach(function (id) { var l = byId[id]; if (!l || l.updated === sent[id]) delete dirty[id]; });
        if (payload.devices || !cfg.cfgUpdated) devicesDirty = false;
        if (j.cfgAccepted === false) sync.lastPull = 0;  // 雲端設定比較新：馬上拉回來
      });
    }
    return step.then(function () {
      if (!opt.pull && Date.now() - sync.lastPull < 5 * 60e3) return;
      var q = { action: 'pull', station: cfg.station, since: opt.full ? 0 : meta.pullSince, cfg: 1 };
      return gasGet(q).then(function (j) {
        var n = merge(j.loans);
        // 往前重疊 5 秒，避免同一毫秒內寫入的紀錄被漏掉（合併時舊資料不會蓋掉新資料）
        meta.pullSince = (j.time || Date.now()) - 5000;
        sync.lastPull = Date.now();
        if (n) reindex();
        applyCloudCfg(j.config, j.cards, !!opt.full);
        if (opt.full) toast('從雲端取回 ' + n + ' 筆新的或較新的紀錄', 'ok', 5000);
      });
    }).then(function () {
      sync.lastOk = Date.now(); sync.lastErr = '';
    }, function (e) {
      sync.lastErr = (e && e.message) || String(e);
      if (opt.loud) toast('同步失敗：' + sync.lastErr, 'bad', 6000);
    }).then(function () {
      sync.busy = false;
      persist();
      renderAll();
      if (!$('mAdmin').hidden && adminTab === 'cloud') renderSyncInfo();
      if (sync.again) { sync.again = false; queueSync(); }
    });
  }

  // 同一台平板車的所有借還平板共用這些設定（鏡頭、同步網址是每台自己的）
  var BACKUP_KEYS = ['school', 'prefix', 'start', 'end', 'digits', 'extra', 'classes', 'auth', 'stuDomain', 'tchDomain', 'autoLogout', 'pin', 'cfgUpdated'];
  function backupCfg() {
    var o = {};
    BACKUP_KEYS.forEach(function (k) { o[k] = cfg[k]; });
    return o;
  }

  // 管理者改了共用設定：記下修改時間，推到雲端讓其他借還平板跟著更新
  function markCfgChanged() {
    cfg.cfgUpdated = Date.now();
    TL.saveCfg(cfg);
    devicesDirty = true;
    queueSync();
  }

  // 雲端設定比這台新就直接套用；force＝管理者按「從雲端還原」
  function applyCloudCfg(conf, cardsText, force) {
    if (!conf) return false;
    var newer = Number(conf.cfgUpdated || 0) > Number(cfg.cfgUpdated || 0);
    if (!newer && force !== 'always') {
      if (!force) return false;
      var diff = BACKUP_KEYS.some(function (k) { return k !== 'cfgUpdated' && conf[k] !== undefined && String(conf[k]) !== String(cfg[k]); }) ||
        (cardsText || '') !== (cfg.cards || '');
      if (!diff || !confirm('這台的設定比雲端新。確定要用雲端的設定蓋掉這台嗎？')) return false;
    }
    BACKUP_KEYS.forEach(function (k) { if (conf[k] !== undefined) cfg[k] = conf[k]; });
    cfg.cards = cardsText || '';
    cfg.setupDone = true;
    TL.saveCfg(cfg);
    devs = TL.buildDevices(cfg); cards = TL.buildCards(cfg.cards);
    if (!$('mAdmin').hidden) fillSettings();
    renderAll(); renderRole();
    toast('已套用雲端上「' + cfg.station + '」的設定（平板 ' + devs.list.length + ' 台、感應卡 ' + cards.count + ' 張）', 'ok', 5000);
    return true;
  }

  // 新的借還平板：從雲端找已經設定好的平板車，一台就直接加入，多台讓管理者選
  function joinFromCloud(quiet) {
    if (!cfg.gasUrl) return Promise.resolve(false);
    return gasGet({ action: 'stations' }).then(function (j) {
      var list = j.stations || [];
      if (!list.length) { if (!quiet) toast('雲端還沒有任何平板車的設定，請在這台完成設定', '', 6000); return false; }
      if (list.length === 1) { adoptStation(list[0]); return true; }
      $('stationList').innerHTML = list.map(function (st, i) {
        var d = TL.buildDevices(st.config);
        return '<button class="mb" data-i="' + i + '">' + esc(st.station) + '<small>' + d.list.length + ' 台平板' +
          (d.list.length ? '（' + esc(d.list[0].id) + '…）' : '') + '</small></button>';
      }).join('');
      stationChoices = list;
      ['mWelcome', 'mAdmin'].forEach(function (id) { $(id).hidden = true; });
      openModal('mStation');
      return true;
    }, function (e) {
      if (!quiet) toast('讀不到雲端設定：' + ((e && e.message) || e), 'bad', 6000);
      return false;
    });
  }
  var stationChoices = [];

  function adoptStation(st) {
    cfg.station = st.station;
    meta.pullSince = 0;
    applyCloudCfg(st.config, st.cards, 'always');
    devicesDirty = false;
    ['mWelcome', 'mAdmin', 'mStation'].forEach(function (id) { $(id).hidden = true; });
    persist();
    startCam();
    syncNow({ pull: true, full: true });
  }

  // 連上雲端：設定過的平板直接同步；還沒上傳過設定的舊平板先問要用哪一邊；全新平板從雲端加入
  function connectCloud() {
    if (cfg.cfgUpdated) { devicesDirty = true; return syncNow({ push: true, pull: true, loud: true }); }
    if (cfg.setupDone && confirm('這台已經有設定了。\n\n按「確定」：把這台的設定上傳到雲端（其他借還平板會跟著改）。\n按「取消」：改用雲端上已有的設定。')) {
      markCfgChanged();
      return syncNow({ push: true, pull: true, loud: true });
    }
    return joinFromCloud(false).then(function (joined) { if (!joined) return syncNow({ pull: true, loud: true }); });
  }

  // 設定連結：新平板用相機掃這個 QR 就會開啟借還站並自動加入
  function setupLink() { return location.origin + location.pathname + '#gas=' + encodeURIComponent(cfg.gasUrl); }

  function renderSyncBadge() {
    var el = $('sync'), n = Object.keys(dirty).length;
    el.classList.remove('err');
    if (!cfg.gasUrl) { el.textContent = ''; return; }
    if (sync.busy) el.textContent = '☁️ 同步中…';
    else if (sync.lastErr) { el.textContent = '⚠️ 離線' + (n ? '・' + n + ' 筆待上傳' : ''); el.classList.add('err'); }
    else if (n) el.textContent = '⏫ ' + n + ' 筆待上傳';
    else if (sync.lastOk) el.textContent = '☁️ 已同步';
    else el.textContent = '';
  }

  function renderSyncInfo() {
    var n = Object.keys(dirty).length;
    $('syncInfo').innerHTML = !cfg.gasUrl ? '目前是<b>本機模式</b>：紀錄和設定只存在這台借還平板裡，換平板設定就不見了。' :
      '狀態：<b>' + (sync.busy ? '同步中…' : sync.lastErr ? '⚠️ ' + esc(sync.lastErr) : sync.lastOk ? '正常' : '尚未同步') + '</b><br>' +
      '待上傳：<b>' + n + '</b> 筆<br>' +
      '上次成功：<b>' + (sync.lastOk ? esc(full(sync.lastOk)) : '—') + '</b><br>' +
      '設定最後修改：<b>' + (cfg.cfgUpdated ? esc(full(cfg.cfgUpdated)) : '—') + '</b>';
    $('setupBox').hidden = !cfg.gasUrl;
    if (cfg.gasUrl) $('setupQr').innerHTML = TL.qrSvg(setupLink());
  }

  function saveGas() {
    var url = $('sGas').value.trim();
    if (url && !/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) { toast('網址看起來不是 Apps Script 網頁應用程式（https://script.google.com/macros/s/…/exec）', 'bad', 6000); return; }
    cfg.gasUrl = url;
    TL.saveCfg(cfg);
    renderSyncBadge();
    if (!url) { renderSyncInfo(); toast('已改回本機模式', 'ok'); return; }
    $('syncInfo').innerHTML = '測試連線中…';
    gasGet({ action: 'ping' }).then(function (j) {
      toast('連線成功' + (j.sheet ? '：' + j.sheet : ''), 'ok', 5000);
      return connectCloud();
    }, function (e) {
      toast('連不上：' + ((e && e.message) || e) + '。請確認部署時「誰可以存取」選「所有人」。', 'bad', 8000);
      sync.lastErr = (e && e.message) || String(e);
      renderSyncInfo(); renderSyncBadge();
    });
  }

  // ---------- 事件 ----------
  function bind() {
    document.addEventListener('pointerdown', function () { unlockAudio(); activity(); }, true);
    document.addEventListener('keydown', function (e) { activity(); onKey(e); });

    $('camSleep').addEventListener('click', function () { unlockAudio(); startCam(); });
    $('camRetry').addEventListener('click', function () { startCam(); });
    $('flipCam').addEventListener('click', flipCam);

    $('manualForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = $('manual').value.trim();
      if (!v) return;
      $('manual').value = '';
      $('manual').blur();
      // 只打數字時自動補成完整編號（例：7 → iPad-07）
      if (/^\d+$/.test(v) && !devs.map[TL.norm(v)]) v = String(cfg.prefix || '') + TL.pad(parseInt(v, 10), parseInt(cfg.digits, 10) || 0);
      onCode(v, 'manual');
    });

    $('cart').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-i]');
      if (!b) return;
      cart.splice(+b.dataset.i, 1);
      if (!cart.length && !person) resetBorrow(true); else renderCart();
    });
    $('roles').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-r]');
      if (!b) return;
      role = b.dataset.r; $('bErr').textContent = '';
      renderRole();
    });
    $('gradePick').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-g]'); if (!b) return;
      grade = +b.dataset.g; renderRole();
    });
    $('classPick').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-c]'); if (!b) return;
      klass = +b.dataset.c; renderRole();
    });
    $('seatPad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '⌫'].map(function (k) { return '<button data-k="' + k + '">' + k + '</button>'; }).join('');
    $('seatPad').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-k]'); if (b) seatPress(b.dataset.k);
    });
    $('names').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-n]'); if (!b) return;
      $('name').value = b.dataset.n;
    });

    $('btnPick').addEventListener('click', function () { openPick(Object.keys(openByDev).length && !counts().inn ? 'return' : 'borrow'); });
    $('btnAddMore').addEventListener('click', function () { openPick('borrow'); });
    $('pickTabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-m]'); if (!b || b.dataset.m === pickMode) return;
      pickMode = b.dataset.m; picked = pickMode === 'borrow' ? cart.slice() : []; renderPick();
    });
    $('pickGrid').addEventListener('click', function (e) {
      var b = e.target.closest('.tile'); if (!b) return;
      var d = b.dataset.d, i = picked.indexOf(d);
      if (i >= 0) picked.splice(i, 1); else picked.push(d);
      activity();
      renderPick();
    });
    $('pickOk').addEventListener('click', pickOk);

    $('regStart').addEventListener('click', regStart);
    $('regCancel').addEventListener('click', function () { $('regForm').hidden = true; regStop(); });
    $('regSave').addEventListener('click', regSave);
    $('regKind').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-k]'); if (!b) return;
      regKind = b.dataset.k; renderRegKind();
    });
    $('saveCards').addEventListener('click', saveCards);
    $('stationList').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-i]'); if (b) adoptStation(stationChoices[+b.dataset.i]);
    });
    $('stationNew').addEventListener('click', function () { closeModal('mStation'); cfg.setupDone = false; openAdmin('set'); });
    $('copySetup').addEventListener('click', function () {
      var link = setupLink();
      (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(function () {
        toast('已複製設定連結，可以傳到新的借還平板上開啟', 'ok');
      }, function () { window.prompt('請複製這個設定連結：', link); });
    });
    $('sCards').addEventListener('input', renderCardCount);
    $('name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('name').blur(); } });
    $('memo').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('memo').blur(); } });
    $('personBox').addEventListener('click', function (e) {
      if (e.target.id !== 'clearPerson') return;
      person = null; renderPerson();
      if (!cart.length) resetBorrow(true);
    });
    $('btnCancel').addEventListener('click', function () { resetBorrow(true); });
    $('unk').addEventListener('click', function (e) {
      if (e.target.id === 'unkAdd') addUnknown();
      if (e.target.id === 'unkClose') hideUnknown();
    });
    $('btnGoogle').addEventListener('click', googleSignIn);
    $('btnConfirm').addEventListener('click', confirmBorrow);

    $('btnStatus').addEventListener('click', function () { renderStatus(); openModal('mStatus'); if (cfg.gasUrl) syncNow({ pull: true }); });
    $('btnAdmin').addEventListener('click', function () { askPin(function () { openAdmin(); }); });

    document.addEventListener('click', function (e) {
      var c = e.target.closest('[data-close]');
      if (c) closeModal(c.closest('.modal').id);
    });
    [].forEach.call(document.querySelectorAll('.modal'), function (m) {
      m.addEventListener('click', function (e) { if (e.target === m && m.id !== 'mWelcome' && (m.id !== 'mAdmin' || cfg.setupDone)) closeModal(m.id); });
    });

    $('statusFilters').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-f]'); if (!b) return;
      statusFilter = b.dataset.f;
      [].forEach.call(this.querySelectorAll('button'), function (x) { x.classList.toggle('on', x === b); });
      renderStatus();
    });
    $('statusQ').addEventListener('input', renderStatus);
    $('statusGrid').addEventListener('click', function (e) {
      var b = e.target.closest('.tile'); if (b) showDetail(b.dataset.d);
    });
    $('dBody').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]'); if (!b) return;
      manualReturn(b.dataset.id, b.dataset.act === 'retb');
    });

    var pad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'];
    $('pinPad').innerHTML = pad.map(function (k) { return '<button data-k="' + k + '">' + k + '</button>'; }).join('');
    $('pinPad').addEventListener('click', function (e) { var b = e.target.closest('button[data-k]'); if (b) pinPress(b.dataset.k); });
    document.addEventListener('keydown', function (e) {
      if ($('mPin').hidden) return;
      if (/^\d$/.test(e.key)) pinPress(e.key);
      else if (e.key === 'Backspace') pinPress('⌫');
    });

    $('atabs').addEventListener('click', function (e) { var b = e.target.closest('button[data-t]'); if (b) setAdminTab(b.dataset.t); });
    $('logFilters').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-r]'); if (!b) return;
      logRange = +b.dataset.r;
      [].forEach.call(this.querySelectorAll('button[data-r]'), function (x) { x.classList.toggle('on', x === b); });
      renderLog();
    });
    $('logQ').addEventListener('input', renderLog);
    $('btnCsv').addEventListener('click', exportCsv);
    $('logTable').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]'); if (!b) return;
      var l = byId[b.dataset.id]; if (!l) return;
      if (b.dataset.act === 'lret') { l.inAt = Date.now(); }
      else if (b.dataset.act === 'lvoid') { if (!confirm('把 ' + l.device + '（' + l.name + '）這筆紀錄作廢？作廢後視為沒有借出。')) return; l.void = true; }
      else if (b.dataset.act === 'lunvoid') {
        if (!l.inAt && openByDev[TL.norm(l.device)]) { toast(l.device + ' 目前已被別人借出，不能還原這筆', 'bad'); return; }
        l.void = false;
      }
      touch(l); changed();
    });
    ['sPrefix', 'sStart', 'sEnd', 'sDigits', 'sExtra'].forEach(function (id) { $(id).addEventListener('input', renderDevPreview); });
    $('saveDev').addEventListener('click', saveDev);
    $('saveSet').addEventListener('click', saveSet);
    $('btnWipe').addEventListener('click', wipe);
    $('saveGas').addEventListener('click', saveGas);
    $('syncNowBtn').addEventListener('click', function () {
      if (!cfg.gasUrl) { toast('請先填 Apps Script 網址', 'bad'); return; }
      syncNow({ push: true, pull: true, loud: true }).then(function () { if (!sync.lastErr) toast('同步完成', 'ok'); });
    });
    $('restoreBtn').addEventListener('click', function () {
      if (!cfg.gasUrl) { toast('請先填 Apps Script 網址', 'bad'); return; }
      syncNow({ pull: true, full: true, loud: true });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { stopCam(true); }
      else { wake(); renderAll(); queueSync(); if (cfg.setupDone) startCam(); }
    });
    window.addEventListener('online', function () { queueSync(); });
    window.addEventListener('resize', layoutAim);
    $('video').addEventListener('loadedmetadata', layoutAim);
    window.addEventListener('storage', function (e) {
      if (e.key === TL.KEY_CFG) { cfg = TL.loadCfg(); devs = TL.buildDevices(cfg); cards = TL.buildCards(cfg.cards); renderAll(); }
    });
  }

  // ---------- 啟動 ----------
  load();
  bind();
  renderRole();
  renderAll();
  tickClock();
  setInterval(tickClock, 15e3);
  setInterval(idleCheck, 5e3);
  setInterval(function () {
    renderBar();
    if (cfg.gasUrl && (Object.keys(dirty).length || Date.now() - sync.lastPull > 5 * 60e3)) syncNow();
  }, 60e3);
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});

  // 設定連結：借還站網址#gas=Apps Script 網址，開一次就填好雲端同步（不用在 iPad 上手打長網址）
  var hashGas = /[#&]gas=([^&]+)/.exec(location.hash);
  if (hashGas) {
    var g = decodeURIComponent(hashGas[1]);
    if (/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(g)) {
      cfg.gasUrl = g; TL.saveCfg(cfg);
      setTimeout(function () { toast('已設定雲端同步（Google 試算表）', 'ok', 5000); }, 500);
      if (!cfg.cfgUpdated) hashJoin = true;
    }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  }
  if (cfg.auth === 'google') loadFirebase().catch(function () {});
  if (!cfg.setupDone) {
    // 一般人在自己的裝置打開時先看到說明；管理者再按「設定成借還平板」
    openModal('mWelcome');
    $('btnSetupHere').addEventListener('click', function () { closeModal('mWelcome'); openAdmin('set'); });
  } else {
    startCam();
    if (cfg.gasUrl && !hashJoin) syncNow({ pull: true });
  }
  if (hashJoin) setTimeout(connectCloud, 300);

  // 測試用：在主控台 TLdebug.scan('iPad-01') 模擬掃描
  // fakeCamera(stream)：用 canvas.captureStream() 之類的影像代替鏡頭，測試解碼流程
  window.TLdebug = {
    scan: function (t) { onCode(t, 'manual'); },
    loans: function () { return loans; },
    fakeCamera: function (s) { stopCam(false); startCam(s); },
    connect: function () { return connectCloud(); },
    sync: function () { sync.lastPull = 0; return syncNow({ pull: true }); }
  };
})();
