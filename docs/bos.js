/* BOS — Valid BOS Pullback paper tab (30 Oct 2026).
   Browser port of the backtested engine in backtest/scratch/lux_top3_backtest.py
   (bos_signals), same rules, same parameters:
     BOS: close beyond a confirmed swing high/low by >= 0.1xATR(14).
     After >= 3 bars without a retest, price touches the reference level
     ("Valid Pullback"). Confirmation: close beyond the highest high /
     lowest low since the break (peak from PRIOR bars only).
     Invalidation: close back through reference by > 0.1xATR discards it.
     Expiry: 20 bars after the initial break.
     Entry next bar open. SL = reference -/+ 0.1xATR. TP = entry +/- 2xATR.
   ─────────────────────────────────────────────────────────────────
   TEST ONLY — observe-only paper tally. Backtest (XAUUSD M15, Jan-Oct
   2026, 131 trades): 52.7% WR, +0.379R/trade net of costs, PF 1.65.
   The live paper tally below is the forward test. Judge at 100+
   resolved paper trades, net positive, per the standing process.
   Never trade it live on the backtest alone.
   ───────────────────────────────────────────────────────────────── */
const Bos = (() => {
'use strict';

const PAPER_KEY = 'liqscalp_bos_paper_v1';
const TICK_MS = 20000;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = v => (v == null ? '–' : Number(v).toFixed(2));

let running = false, timer = null;

let paper = (() => {
  try {
    return JSON.parse(localStorage.getItem(PAPER_KEY) || 'null') ||
      { n: 0, wins: 0, losses: 0, netR: 0, open: null, trades: [], lastSeen: 0 };
  } catch (e) {
    return { n: 0, wins: 0, losses: 0, netR: 0, open: null, trades: [], lastSeen: 0 };
  }
})();
function paperSave() { try { localStorage.setItem(PAPER_KEY, JSON.stringify(paper)); } catch (e) {} }

// ---- signal alerts (30 Oct 2026, Mickey's ask: no long chart-watching) ----
// Three free channels, all optional, all configured in the tab itself:
//  * browser notification (works while this page is open; needs Allow)
//  * ntfy.sh topic = instant phone push via the free ntfy app, no account
//  * IFTTT webhook = email (address lives in HIS IFTTT account, never here)
//  * WhatsApp via CallMeBot (free, unofficial — can stop working anytime)
// Numbers, keys and URLs live in this device's localStorage ONLY — they
// are never sent to the assistant or anyone else. Alerts fire ONLY when
// a new paper trade opens (or on the TEST button) — never on re-renders,
// never for armed setups. Webhook POSTs use no-cors fire-and-forget so
// IFTTT's missing CORS headers can't block the trigger.
const ALERT_KEY = 'liqscalp_bos_alerts_v1';
let alerts = (() => {
  try {
    const a = JSON.parse(localStorage.getItem(ALERT_KEY) || 'null') || {};
    if (a.webhook && !a.ntfy) a.ntfy = a.webhook; // migrate single-field setups
    return { browser: !!a.browser, ntfy: a.ntfy || '', ifttt: a.ifttt || '',
             waPhone: a.waPhone || '', waKey: a.waKey || '' };
  } catch (e) { return { browser: false, ntfy: '', ifttt: '', waPhone: '', waKey: '' }; }
})();
let alertsWired = false;
function alertsSave() { try { localStorage.setItem(ALERT_KEY, JSON.stringify(alerts)); } catch (e) {} }
function notifySignal(o, isTest) {
  const title = (isTest ? 'TEST · ' : '') + 'BOS ' + (o.dir === 1 ? 'LONG' : 'SHORT') + ' @ ' + fmt(o.entry);
  const body = 'SL ' + fmt(o.sl) + ' · TP ' + fmt(o.tp) + ' · M15 gold (paper)';
  if (alerts.browser && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body }); } catch (e) {}
  }
  if (alerts.ntfy) {
    try {
      fetch(alerts.ntfy, { method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: title + ' — ' + body }).catch(() => {});
    } catch (e) {}
  }
  if (alerts.ifttt) {
    try {
      fetch(alerts.ifttt, { method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'value1=' + encodeURIComponent(title) +
          '&value2=' + encodeURIComponent(body) +
          '&value3=' + encodeURIComponent('BOS paper signal') }).catch(() => {});
    } catch (e) {}
  }
  if (alerts.waPhone && alerts.waKey) {
    try {
      const phone = alerts.waPhone.replace(/\D/g, '');
      const url = 'https://api.callmebot.com/whatsapp.php?phone=' + phone +
        '&text=' + encodeURIComponent(title + ' — ' + body) +
        '&apikey=' + encodeURIComponent(alerts.waKey);
      fetch(url, { method: 'GET', mode: 'no-cors' }).catch(() => {});
    } catch (e) {}
  }
}
function wireAlerts() {
  if (alertsWired) return;
  alertsWired = true;
  const cb = $('bosNotifyBrowser'), ntfy = $('bosNtfy'), ift = $('bosIfttt'),
    wap = $('bosWaPhone'), wak = $('bosWaKey'),
    btn = $('bosAlertSave'), tst = $('bosAlertTest'), st = $('bosAlertState');
  if (!cb || !ntfy || !btn) return;
  cb.checked = !!alerts.browser;
  ntfy.value = alerts.ntfy || '';
  if (ift) ift.value = alerts.ifttt || '';
  if (wap) wap.value = alerts.waPhone || '';
  if (wak) wak.value = alerts.waKey || '';
  if (!('Notification' in window)) { cb.disabled = true; }
  cb.addEventListener('change', () => {
    if (!cb.checked) { alerts.browser = false; alertsSave(); return; }
    if (Notification.permission === 'granted') { alerts.browser = true; alertsSave(); }
    else if (Notification.permission === 'denied') {
      cb.checked = false;
      if (st) st.textContent = 'Browser notifications are blocked for this page — allow them in the browser site settings first.';
    } else {
      Notification.requestPermission().then(p => {
        alerts.browser = (p === 'granted');
        cb.checked = alerts.browser;
        alertsSave();
        if (st) st.textContent = alerts.browser ? 'Browser alerts ON.' : 'Permission not granted — browser alerts stay off.';
      });
    }
  });
  btn.addEventListener('click', () => {
    alerts.ntfy = ntfy.value.trim();
    if (ift) alerts.ifttt = ift.value.trim();
    if (wap) alerts.waPhone = wap.value.trim();
    if (wak) alerts.waKey = wak.value.trim();
    alertsSave();
    if (st) st.textContent = 'Saved ✓ — the next BOS signal will fire every channel you filled in.';
  });
  if (tst) tst.addEventListener('click', () => {
    const all = (typeof M15 !== 'undefined' ? M15 : []) || [];
    const last = all.length ? all[all.length - 1].c : null;
    notifySignal({ dir: 1, entry: last, sl: last != null ? last - 5 : null,
      tp: last != null ? last + 10 : null }, true);
    if (st) st.textContent = 'Test alert sent — check your phone / email / WhatsApp now. (Browser test needs the box ticked + permission allowed.)';
  });
}

function atr14(bars) {
  const n = bars.length, out = new Array(n).fill(0);
  if (n < 15) return out;
  const tr = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) tr.push(bars[0].h - bars[0].l);
    else tr.push(Math.max(bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  }
  let s = 0;
  for (let i = 0; i < 14; i++) s += tr[i];
  out[13] = s / 14;
  for (let i = 14; i < n; i++) out[i] = (out[i - 1] * 13 + tr[i]) / 14;
  return out;
}

// 1-bar-confirmed fractals, mirroring the Python engine: at bar j, the
// swing at j-1 is confirmed. Returns {highs:[{i,price}], lows:[...]}.
function fractalSwings(bars) {
  const highs = [], lows = [];
  for (let j = 2; j < bars.length; j++) {
    if (bars[j - 1].h > bars[j - 2].h && bars[j - 1].h > bars[j].h)
      highs.push({ i: j - 1, price: bars[j - 1].h });
    if (bars[j - 1].l < bars[j - 2].l && bars[j - 1].l < bars[j].l)
      lows.push({ i: j - 1, price: bars[j - 1].l });
  }
  return { highs, lows };
}

// Full state-machine scan over closed bars. Returns {signals, active}
// where signals have entryIdx (index into bars, may equal bars.length
// when entry falls on the forming bar) and active holds the live setup
// state per direction at the last closed bar.
function scan(bars) {
  const a = atr14(bars);
  const { highs, lows } = fractalSwings(bars);
  const signals = [];
  const states = { 1: null, '-1': null };
  for (let i = 2; i < bars.length; i++) {
    const av = a[i];
    if (!(av > 0)) continue;
    const cl = bars[i].c, hi = bars[i].h, lo = bars[i].l;
    for (const dir of [1, -1]) {
      const swings = dir === 1 ? highs : lows;
      let ref = null;
      for (let k = swings.length - 1; k >= 0; k--) {
        if (swings[k].i <= i - 1) { ref = swings[k].price; break; }
      }
      if (ref == null) continue;
      let st = states[dir];
      if (st === null) {
        if (dir === 1 && cl > ref + 0.1 * av)
          st = states[dir] = { ref, start: i, touched: false, peak: hi };
        else if (dir === -1 && cl < ref - 0.1 * av)
          st = states[dir] = { ref, start: i, touched: false, peak: lo };
        if (st === null) continue;
      }
      if (i - st.start > 20) { states[dir] = null; continue; }
      if (dir === 1) {
        // confirmation against the peak from PRIOR bars (see Python fix note)
        if (st.touched && cl > st.peak) {
          signals.push({ entryIdx: i + 1, dir: 1, ref: st.ref, atr: av, at: bars[i].t });
          states[dir] = null;
        } else if (cl < st.ref - 0.1 * av) {
          states[dir] = null;
        } else {
          if (!st.touched && i - st.start >= 3 && lo <= st.ref) st.touched = true;
          if (hi > st.peak) st.peak = hi;
        }
      } else {
        if (st.touched && cl < st.peak) {
          signals.push({ entryIdx: i + 1, dir: -1, ref: st.ref, atr: av, at: bars[i].t });
          states[dir] = null;
        } else if (cl > st.ref + 0.1 * av) {
          states[dir] = null;
        } else {
          if (!st.touched && i - st.start >= 3 && hi >= st.ref) st.touched = true;
          if (lo < st.peak) st.peak = lo;
        }
      }
    }
  }
  return { signals, active: states };
}

function costR(entry, risk) {
  return (2 * (0.0002 * entry + 0.50)) / risk;
}

function recompute() {
  if (!running) return;
  try {
    const all = (typeof M15 !== 'undefined' ? M15 : []) || [];
    if (all.length < 30) { render(null, 'waiting for M15 feed…'); return; }
    const nowMs = Date.now();
    const closed = (typeof LS !== 'undefined' && LS.closed_only)
      ? LS.closed_only(all, nowMs) : all.slice(0, -1);
    if (closed.length < 30) { render(null, 'waiting for M15 feed…'); return; }
    const forming = all.length > closed.length ? all[all.length - 1] : null;
    const { signals, active } = scan(closed);
    // paper ledger: only signals newer than lastSeen; one open trade.
    const fresh = signals.filter(s => s.at > (paper.lastSeen || 0))
      .sort((x, y) => x.at - y.at);
    for (const s of fresh) {
      paper.lastSeen = Math.max(paper.lastSeen || 0, s.at);
      if (paper.open) continue; // one-open-trade suppression, like the backtest
      let entry = null;
      if (s.entryIdx < closed.length) entry = closed[s.entryIdx].o;
      else if (forming && forming.t > closed[closed.length - 1].t) entry = forming.o;
      if (entry == null) continue;
      const sl = s.dir === 1 ? s.ref - 0.1 * s.atr : s.ref + 0.1 * s.atr;
      const tp = s.dir === 1 ? entry + 2 * s.atr : entry - 2 * s.atr;
      const risk = Math.abs(entry - sl);
      if (!(risk > 0)) continue;
      paper.open = { dir: s.dir, entry, sl, tp, at: s.at, costR: costR(entry, risk) };
      notifySignal(paper.open); // alert fires once, when the paper trade opens
    }
    // resolve the open paper trade against closed bars after its entry bar
    if (paper.open) {
      const o = paper.open;
      const startIdx = closed.findIndex(b => b.t > o.at);
      if (startIdx >= 0) {
        for (let i = startIdx; i < closed.length; i++) {
          const h = closed[i].h, l = closed[i].l;
          const hitSL = o.dir === 1 ? (l <= o.sl) : (h >= o.sl);
          const hitTP = o.dir === 1 ? (h >= o.tp) : (l <= o.tp);
          if (hitSL || hitTP) {
            const r = hitSL ? -1.0 : 2.0;
            const rNet = +(r - o.costR).toFixed(3);
            paper.trades.unshift({ at: o.at, dir: o.dir, entry: o.entry,
              sl: o.sl, tp: o.tp, exit: hitSL ? 'SL' : 'TP', r, rNet });
            paper.trades = paper.trades.slice(0, 50);
            paper.n++;
            if (r > 0) paper.wins++; else paper.losses++;
            paper.netR = +(paper.netR + rNet).toFixed(2);
            paper.open = null;
            break;
          }
        }
      }
    }
    paperSave();
    render(active, null);
    drawBosChart(all, closed, active);
  } catch (e) {
    render(null, 'BOS engine error: ' + esc(e && e.message ? e.message : e));
  }
}

// ---- BOS chart (30 Oct 2026, Mickey's ask: chart same as sniper setup,
// auto-marked when a setup appears or a signal fires) ----
// Same candle style as the sniper chart (green #22c55e / red #ef4444,
// amber #f5a623 for test/pending marks), M15 gold only, last 120 bars.
// Redraws on every engine recompute (20s while the tab is open), so
// markers appear on their own — no reload, no tap needed:
//  * amber dashed line + tag = armed setup (break done, awaiting
//    pullback touch and/or confirmation close)
//  * green ▲ / red ▼ arrow = signal entry bar (open trade + recent
//    resolved trades, when the entry bar is in view)
//  * dashed lines = open trade entry / SL / TP levels
// Wrapped in try/catch: a chart failure must never break the engine,
// the paper tally, or the alerts.
let bosChartLast = null, bosChartResizeWired = false;
function drawBosChart(all, closed, active) {
  try {
    const cv = $('bosChart');
    if (!cv) return;
    bosChartLast = { all, closed, active };
    if (!bosChartResizeWired) {
      bosChartResizeWired = true;
      window.addEventListener('resize', () => {
        if (bosChartLast) drawBosChart(bosChartLast.all, bosChartLast.closed, bosChartLast.active);
      });
    }
    const W = cv.clientWidth, H = 320;
    if (!W) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = W * dpr; cv.height = H * dpr;
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#0e1420'; c.fillRect(0, 0, W, H);
    const bars = (all || []).slice(-120);
    c.font = '11px system-ui';
    if (bars.length < 5) {
      c.fillStyle = '#9aa3b8'; c.textAlign = 'center';
      c.fillText('waiting for M15 feed…', W / 2, H / 2);
      return;
    }
    let lo = Infinity, hi = -Infinity;
    for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    const extra = [];
    if (paper.open) extra.push(paper.open.entry, paper.open.sl, paper.open.tp);
    if (active) for (const d of [1, -1]) if (active[d]) extra.push(active[d].ref);
    for (const v of extra) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const pad = (hi - lo) * 0.03 || 1;
    lo -= pad; hi += pad;
    const TOP = 8, BOT = H - 20;
    const y = v => TOP + (hi - v) / (hi - lo) * (BOT - TOP);
    const cw = W / bars.length;
    c.strokeStyle = 'rgba(255,255,255,.07)'; c.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const yy = TOP + (BOT - TOP) * g / 4, pv = hi - (hi - lo) * g / 4;
      c.beginPath(); c.moveTo(0, yy); c.lineTo(W, yy); c.stroke();
      c.fillStyle = '#9aa3b8'; c.textAlign = 'right';
      c.fillText(pv.toFixed(1), W - 4, yy - 3);
    }
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i], x = i * cw + cw / 2, bw = Math.max(1, cw * 0.62);
      const col = b.c >= b.o ? '#22c55e' : '#ef4444';
      c.strokeStyle = col;
      c.beginPath(); c.moveTo(x, y(b.h)); c.lineTo(x, y(b.l)); c.stroke();
      c.fillStyle = col;
      c.fillRect(x - bw / 2, Math.min(y(b.o), y(b.c)), bw,
        Math.max(1, Math.abs(y(b.c) - y(b.o))));
    }
    c.textAlign = 'left';
    const labStep = bars.length > 100 ? 20 : 10;
    c.fillStyle = '#9aa3b8';
    for (let i = 0; i < bars.length; i += labStep) {
      const t = new Date(bars[i].t);
      c.fillText(String(t.getHours()).padStart(2, '0') + ':' +
        String(t.getMinutes()).padStart(2, '0'), i * cw + 2, H - 6);
    }
    const hline = (v, color, label) => {
      const yy = Math.round(y(v)) + .5;
      c.strokeStyle = color; c.setLineDash([6, 4]); c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(0, yy); c.lineTo(W, yy); c.stroke();
      c.setLineDash([]);
      c.fillStyle = color; c.textAlign = 'left';
      c.fillText(label, 6, yy - 4);
    };
    const arrowAt = (barTime, dir, color, big) => {
      for (let i = 0; i < bars.length; i++) {
        if (bars[i].t > barTime) {
          const b = bars[i], x = i * cw + cw / 2;
          c.fillStyle = color; c.textAlign = 'center';
          c.font = (big ? '15px' : '12px') + ' system-ui';
          if (dir === 1) c.fillText('▲', x, y(b.l) + 14);
          else c.fillText('▼', x, y(b.h) - 6);
          c.font = '11px system-ui';
          return true;
        }
      }
      return false;
    };
    if (active) {
      for (const d of [1, -1]) {
        const st = active[d];
        if (!st) continue;
        hline(st.ref, '#f5a623', (d === 1 ? 'LONG SETUP' : 'SHORT SETUP') +
          ' ref ' + fmt(st.ref) + (st.touched ? ' · pullback valid' : ''));
      }
    }
    if (paper.open) {
      const o = paper.open, col = o.dir === 1 ? '#22c55e' : '#ef4444';
      hline(o.entry, col, 'ENTRY ' + fmt(o.entry));
      hline(o.sl, '#ef4444', 'SL ' + fmt(o.sl));
      hline(o.tp, '#22c55e', 'TP ' + fmt(o.tp));
      arrowAt(o.at, o.dir, col, true);
    }
    for (const t of (paper.trades || []).slice(0, 10)) {
      const col = t.dir === 1 ? '#22c55e' : '#ef4444';
      c.globalAlpha = 0.6;
      arrowAt(t.at, t.dir, col, false);
      c.globalAlpha = 1;
    }
    c.fillStyle = '#9aa3b8'; c.textAlign = 'left';
    c.fillText('BOS · M15 GOLD', 6, 14);
  } catch (e) { /* chart must never break engine/tally/alerts */ }
}

function render(active, err) {
  const v = $('bosVerdict'), p = $('bosPaper'), s = $('bosSignals');
  if (!v) return;
  if (err) { v.innerHTML = '<div class="bs-tag">BOS · TEST</div><div>' + err + '</div>'; return; }
  let verdict = 'WAIT — no valid BOS setup on M15 right now.';
  if (paper.open) {
    const o = paper.open;
    verdict = 'BOS PAPER · ' + (o.dir === 1 ? 'LONG' : 'SHORT') +
      ' @ ' + fmt(o.entry) + ' · SL ' + fmt(o.sl) + ' · TP ' + fmt(o.tp);
  } else if (active) {
    const parts = [];
    for (const dir of [1, -1]) {
      const st = active[dir];
      if (st) parts.push((dir === 1 ? 'LONG' : 'SHORT') + ' setup armed — ref ' +
        fmt(st.ref) + (st.touched ? ' · pullback valid, awaiting confirmation'
          : ' · awaiting pullback'));
    }
    if (parts.length) verdict = 'SETUP — ' + parts.join(' · ');
  }
  v.innerHTML = '<div class="bs-tag">BOS SIGNAL · TEST</div><div>' + verdict + '</div>';
  const wr = paper.n ? Math.round(100 * paper.wins / paper.n) : 0;
  p.textContent = 'PAPER TALLY (this device) — ' + paper.n + ' resolved · ' +
    paper.wins + 'W / ' + paper.losses + 'L (' + wr + '% WR) · net ' +
    (paper.netR >= 0 ? '+' : '') + paper.netR.toFixed(2) + 'R' +
    (paper.open ? ' · trade open' : '') +
    ' — judge at 100+ resolved, net positive, per the standing process.';
  s.innerHTML = paper.trades.length
    ? paper.trades.slice(0, 10).map(t =>
        '<div>' + new Date(t.at).toLocaleString() + ' · ' +
        (t.dir === 1 ? 'LONG' : 'SHORT') + ' @ ' + fmt(t.entry) +
        ' → ' + t.exit + ' ' + (t.r > 0 ? '+' : '') + t.r.toFixed(2) +
        'R (net ' + (t.rNet >= 0 ? '+' : '') + t.rNet.toFixed(2) + 'R)</div>').join('')
    : '<div class="dim">No paper trades resolved yet — the tally starts from this tab\'s first live signal, no backfilled history.</div>';
}

function applyTab(on) {
  const w = $('bosWrap'), c = $('chartWrap');
  if (w) w.style.display = on ? 'block' : 'none';
  if (c) c.style.display = on ? 'none' : 'block';
  document.body.classList.toggle('bos-on', on);
}

function start() {
  applyTab(true);
  wireAlerts();
  if (running) { recompute(); return; }
  running = true;
  recompute();
  timer = setInterval(recompute, TICK_MS);
}
function stop() {
  running = false;
  if (timer) { clearInterval(timer); timer = null; }
  applyTab(false);
}
function isOn() { return running; }

return { start, stop, applyTab, isOn };
})();
