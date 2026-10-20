/* FLOW — Mickey's DOMFlow v144, ported to run in the browser (19 Oct 2026).
   Bitget XAUUSDT perpetual order flow over a direct public websocket.
   No Python server, no login, no token.
   ─────────────────────────────────────────────────────────────────
   TEST ONLY. This reads CRYPTO-PERP gold flow, not Exness spot gold.
   The decision read is UNPROVEN — observe only, never trade it live.
   ───────────────────────────────────────────────────────────────── */
const Flow = (() => {
'use strict';

// ---- config: mirrors dom_engine.py / dom_decision.py ----
const WS_URL  = 'wss://ws.bitget.com/v2/ws/public';
const SYM     = 'XAUUSDT';
const BIN     = 0.10;          // footprint bin ($)
const WHALE_TH= 25000;         // $ — whale print threshold
const LVL_TH  = 25000;         // $ — large level threshold
const W = {aggression60:20, aggression10:10, cvdTrend:12, book:6,
           absorption:15, stacked:10, value:8, largePrints:8, liquidity:12};
const WSUM = 101;
const FLOW_KEYS = ['aggression60','aggression10','cvdTrend','absorption','largePrints'];
const SMOOTH=0.3, NEED_STRENGTH=22, NEED_HOLD=10, FLIP=8;
const ACTIVE_NORM_60=12, ACTIVE_MIN=6;
const COST_MULT=2.5, BASE_COST_BP=3.0, TICK=0.01;
const REGIME_NEED = {range:30, unclear:45, trend:70, volatile:60};

// ---- state ----
let ws=null, running=false, reconnects=0;
let t500=null, t1s=null, tWall=null, tTrend=null;
let trades=[], frames=[], candles=new Map(), whales=[], events=[];
let bids=new Map(), asks=new Map(), bb=0, ba=0, last=0, markPx=0;
let cvd=0, bookOk=false, connected=false, lastMsg=0, errMsg='';
let win={tb:0,ts:0,n:0,mx:null,ms:null};
let profile={day:null, rows:new Map(), vw:[0,0,0]};
let walls=new Map();            // key side:bin -> {side,price,usd,firstSeen}
let toxHist=[];
let st={smooth:null, verdict:'WAIT', since:0, plan:null, last:null};
let trend={dir:0, label:'Trend unknown'};
let lastOut=null;
let seed=new Map(), rzBound=false, tfBound=false;   // chart history seed (Bitget REST)
let flowTF='M1';                                     // FLOW chart timeframe (follows the TF bar)
const FLOW_TF_MS={M1:60000,M5:300000,M15:900000,H1:3600000,H4:14400000,D1:86400000};
const FLOW_TF_GRAN={M1:'1m',M5:'5m',M15:'15m',H1:'1H',H4:'4H',D1:'1D'};

const $=id=>document.getElementById(id);
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const usd=v=>{v=Math.abs(v||0);return v>=1e6?'$'+(v/1e6).toFixed(2)+'M':v>=1e3?'$'+(v/1e3).toFixed(1)+'K':'$'+v.toFixed(0);};
const pct=v=>Math.round(v*100)+'%';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// ================= websocket =================
function connect(){
  if(ws){try{ws.close();}catch(e){}}
  ws=new WebSocket(WS_URL);
  ws.onopen=()=>{
    connected=false; errMsg='';
    ws.send(JSON.stringify({op:'subscribe',args:['trade','books','ticker'].map(ch=>({instType:'USDT-FUTURES',channel:ch,instId:SYM}))}));
    ws.send('ping');
  };
  ws.onmessage=ev=>{
    lastMsg=Date.now();
    if(ev.data==='pong')return;
    let j; try{j=JSON.parse(ev.data);}catch(e){return;}
    const arg=j.arg||{}, ch=arg.channel, data=j.data||[];
    if(ch==='trade'){
      const arr=(Array.isArray(data)?data:[]).slice().sort((a,b)=>+a.ts-+b.ts);
      for(const t of arr) onTrade(+t.ts, +t.price, +t.size, t.side==='buy'?1:-1);
    }else if(ch==='books'){
      for(const b of data){
        if(j.action==='snapshot') onBookSnap(b.bids||[], b.asks||[]);
        else onBookUpd(b.bids||[], b.asks||[]);
      }
    }else if(ch==='ticker'){
      for(const t of data){
        if(t.markPrice)markPx=+t.markPrice;
        onTop(t.bidPr,t.askPr,t.lastPr);
      }
      connected=true; reconnects=0; errMsg='';
    }
  };
  ws.onerror=()=>{ errMsg='socket error'; };
  ws.onclose=()=>{
    connected=false;
    if(!running)return;
    reconnects++;
    errMsg='reconnecting…';
    setTimeout(()=>{ if(running)connect(); }, Math.min(15000, 1000*reconnects));
  };
  const ping=setInterval(()=>{ if(!running){clearInterval(ping);return;} try{ws.send('ping');}catch(e){} },25000);
}

function onTop(bbp,bap,lp){
  if(bbp)bb=+bbp; if(bap)ba=+bap; if(lp)last=+lp;
}
function onBookSnap(b,a){
  bids=new Map(); asks=new Map();
  for(const [p,q] of b){ if(+q>0)bids.set(Math.round(+p*100),+q); }
  for(const [p,q] of a){ if(+q>0)asks.set(Math.round(+p*100),+q); }
  bookOk=true; refreshTop();
}
function onBookUpd(b,a){
  for(const [p,q] of b){ const c=Math.round(+p*100); if(+q<=0)bids.delete(c); else bids.set(c,+q); }
  for(const [p,q] of a){ const c=Math.round(+p*100); if(+q<=0)asks.delete(c); else asks.set(c,+q); }
  refreshTop();
}
function refreshTop(){
  if(bids.size)bb=Math.max(...bids.keys())/100;
  if(asks.size)ba=Math.min(...asks.keys())/100;
}
function mid(){ return (bb&&ba)?(bb+ba)/2:last; }

// ================= tape =================
function onTrade(tms,price,qty,side){
  price=+price; qty=+qty; const u=price*qty; side=side>0?1:-1;
  last=price;
  trades.push([tms,price,qty,side,u]);
  if(trades.length>6000)trades.splice(0,trades.length-6000);
  cvd+=side*u;
  const w=win; w.n++;
  if(side>0)w.tb+=u; else w.ts+=u;
  w.mx=w.mx===null?price:Math.max(w.mx,price);
  w.ms=w.ms===null?price:Math.min(w.ms,price);
  // 1m candle + footprint rows
  const m=Math.floor(tms/60000);
  let c=candles.get(m);
  if(!c){ c={t:m*60,o:price,h:price,l:price,c:price,vol:0,bv:0,sv:0,n:0,rows:{},wb:0,ws:0,dmax:0,dmin:0};
          candles.set(m,c);
          while(candles.size>320){const k=candles.keys().next().value;candles.delete(k);} }
  c.h=Math.max(c.h,price); c.l=Math.min(c.l,price); c.c=price; c.n++; c.vol+=u;
  if(side>0)c.bv+=u; else c.sv+=u;
  const d=c.bv-c.sv; c.dmax=Math.max(c.dmax,d); c.dmin=Math.min(c.dmin,d);
  const b=Math.floor(price/BIN+1e-9), r=c.rows[b]||(c.rows[b]=[0,0]);
  r[side>0?1:0]+=u;
  // session profile (UTC day)
  const day=Math.floor(Date.now()/86400000);
  if(profile.day!==day)profile={day,rows:new Map(),vw:[0,0,0]};
  const pb=Math.floor(price/BIN+1e-9), pr=profile.rows.get(pb)||profile.rows.set(pb,[0,0]).get(pb);
  pr[side>0?1:0]+=u;
  profile.vw[0]+=u; profile.vw[1]+=price*u; profile.vw[2]+=price*price*u;
  // whales
  if(u>=WHALE_TH){
    whales.push([tms,price,qty,side,u]);
    if(whales.length>300)whales.shift();
    if(side>0)c.wb+=u; else c.ws+=u;
    addEvent(tms,'print',side>0?'ask':'bid',price,u,(side>0?'buy print, lifted ask':'sell print, hit bid'));
  }
  toxTick(side,u);
}
function addEvent(t,typ,side,price,u,txt){
  events.push([t,typ,side,price,u,txt]);
  if(events.length>1500)events.shift();
}

// ---- toxicity: 60s |net|/total percentile vs session (light VPIN stand-in) ----
let toxWin={b:0,s:0,t:0};
function toxTick(side,u){
  const now=Date.now();
  if(now-toxWin.t>60000){ // roll the window
    const tot=toxWin.b+toxWin.s;
    if(tot>0){toxHist.push(Math.abs(toxWin.b-toxWin.s)/tot); if(toxHist.length>600)toxHist.shift();}
    toxWin={b:0,s:0,t:now};
  }
  if(side>0)toxWin.b+=u; else toxWin.s+=u;
}
function toxicity(){
  const tot=toxWin.b+toxWin.s;
  if(tot<=0||toxHist.length<20)return{v:null,p:null};
  const v=Math.abs(toxWin.b-toxWin.s)/tot;
  const p=toxHist.filter(x=>x<v-1e-9).length/toxHist.length;
  return{v,p};
}

// ================= 500ms frames =================
function frameTick(){
  const now=Date.now(), m=mid();
  if(!m||!bookOk)return;
  frames.push({t:now,m:Math.round(m*1000)/1000,p:last||m,cvd:Math.round(cvd),
               tb:win.tb,ts:win.ts,n:win.n,mx:win.mx||0,ms:win.ms||0,bb,ba});
  if(frames.length>1500)frames.splice(0,frames.length-1500);
  win={tb:0,ts:0,n:0,mx:null,ms:null};
}

// ================= walls (2s) =================
function wallsTick(){
  const now=Date.now(), price=mid();
  if(!price||!bookOk)return;
  const band=price*0.005, excl=Math.max(0.03,price*2e-4);
  const lv=[];
  const push=(map,isbid)=>{
    for(const [c,q] of map){
      const p=c/100;
      if(Math.abs(p-price)>band||Math.abs(p-price)<=excl)continue;
      const u=p*q; if(u>0)lv.push({bin:Math.floor(p/BIN),price:p,usd:u,isbid});
    }
  };
  push(bids,true); push(asks,false);
  if(lv.length<10)return;
  const us=lv.map(x=>x.usd).sort((a,b)=>a-b), med=us[Math.floor(us.length/2)];
  const seen=new Set();
  for(const x of lv){
    if(x.usd<med*4)continue;
    const key=(x.isbid?'b':'a')+':'+x.bin; seen.add(key);
    const w=walls.get(key);
    if(w){w.usd=x.usd;w.price=x.price;}
    else walls.set(key,{side:x.isbid?'bid':'ask',price:x.price,usd:x.usd,firstSeen:now,pulled:0});
  }
  // vanished walls that lived <60s count as pulled
  for(const [key,w] of walls){
    if(seen.has(key))continue;
    if(now-w.firstSeen<60000){
      w.pulled++;
      addEvent(now,'pulled',w.side,w.price,w.usd,'wall pulled after '+Math.round((now-w.firstSeen)/1000)+'s');
    }
    walls.delete(key);
  }
}

// ================= trend: 15m EMA20/50 from Bitget klines =================
async function refreshTrend(){
  try{
    const r=await fetch('https://api.bitget.com/api/v2/mix/market/candles?symbol='+SYM+'&productType=USDT-FUTURES&granularity=15m&limit=60');
    const j=await r.json();
    const rows=(j.data||[]).map(x=>+x[4]).reverse(); // close
    if(rows.length>=30){
      const ema=(n)=>{const k=2/(n+1);let e=rows[0];for(const v of rows)e=v*k+e*(1-k);return e;};
      const e20=ema(20),e50=ema(50),px=rows[rows.length-1];
      trend={dir:px>e20&&e20>e50?1:px<e20&&e20<e50?-1:0,
             label:'15m '+(px>e20&&e20>e50?'uptrend':px<e20&&e20<e50?'downtrend':'range')};
      return;
    }
  }catch(e){}
  trend={dir:0,label:'Trend unknown'};
}

// ================= chart: Bitget history seed (per-TF) + live tape candles =================
async function seedChart(){
  const tf=flowTF, ms=FLOW_TF_MS[tf];
  try{
    const r=await fetch('https://api.bitget.com/api/v2/mix/market/candles?symbol='+SYM+'&productType=USDT-FUTURES&granularity='+FLOW_TF_GRAN[tf]+'&limit=200');
    const j=await r.json();
    const m=new Map();
    for(const x of (j.data||[])){
      const t=Math.floor(+x[0]/ms)*ms/1000;   // bar start, seconds (matches tape candles)
      m.set(t,{t,o:+x[1],h:+x[2],l:+x[3],c:+x[4],vol:+x[6]||0});
    }
    if(tf===flowTF&&m.size){seed=m;drawFlowChart(lastOut?lastOut.d:null);}
  }catch(e){}
}
function chartSeries(){
  if(flowTF==='M1'){
    const m=new Map(seed);
    for(const c of candles.values())m.set(c.t,{t:c.t,o:c.o,h:c.h,l:c.l,c:c.c,vol:c.vol});
    return [...m.values()].sort((a,b)=>a.t-b.t);
  }
  // higher TFs: seeded bars, with the forming bar patched/rolled from the 1m tape
  const sec=FLOW_TF_MS[flowTF]/1000;
  const out=[...seed.values()].sort((a,b)=>a.t-b.t);
  const tape=[...candles.values()].sort((a,b)=>a.t-b.t);
  for(const c of tape){
    const bkt=Math.floor(c.t/sec)*sec, lastB=out[out.length-1];
    if(lastB&&bkt===lastB.t){
      lastB.h=Math.max(lastB.h,c.h); lastB.l=Math.min(lastB.l,c.l); lastB.c=c.c;
    }else if(!lastB||bkt>lastB.t){
      out.push({t:bkt,o:c.o,h:c.h,l:c.l,c:c.c,vol:c.vol});
    }
  }
  return out;
}
function drawFlowChart(d){
  const cv=$('flowChart'); if(!cv)return;
  const dpr=window.devicePixelRatio||1;
  const Wd=cv.clientWidth, Hd=cv.clientHeight;
  if(!Wd||!Hd)return;
  const pw=Math.round(Wd*dpr), ph=Math.round(Hd*dpr);
  if(cv.width!==pw||cv.height!==ph){cv.width=pw;cv.height=ph;}
  const ctx=cv.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,Wd,Hd);
  ctx.font='10px system-ui,sans-serif';
  const cs=chartSeries().slice(-90);
  if(!cs.length){
    ctx.fillStyle='#888'; ctx.textAlign='center';
    ctx.fillText('waiting for trades…',Wd/2,Hd/2);
    ctx.textAlign='left'; return;
  }
  const AX=56, plotW=Wd-AX, plotH=Hd-14;
  let mn=Infinity,mx=-Infinity,vmx=0;
  for(const c of cs){mn=Math.min(mn,c.l);mx=Math.max(mx,c.h);vmx=Math.max(vmx,c.vol||0);}
  const va=valueArea();
  if(va){mn=Math.min(mn,va.val);mx=Math.max(mx,va.vah);}
  const T=d&&d.plan;
  if(T){mn=Math.min(mn,T.stop,T.target,T.entry);mx=Math.max(mx,T.stop,T.target,T.entry);}
  if(!(mx>mn))mx=mn+1;
  const pad=(mx-mn)*0.08; mx+=pad; mn-=pad;
  const Y=p=>6+(mx-p)/(mx-mn)*(plotH-12);
  // grid + price labels
  ctx.strokeStyle='rgba(255,255,255,.06)'; ctx.fillStyle='#888'; ctx.lineWidth=1;
  for(let g=0;g<=4;g++){
    const p=mn+(mx-mn)*g/4, y=Y(p);
    ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(plotW,y);ctx.stroke();
    ctx.fillText(p.toFixed(2),plotW+5,y+3);
  }
  const slot=plotW/cs.length, bw=Math.max(1,slot*0.62);
  // volume (subtle overlay at the bottom)
  if(vmx>0){
    const vh=plotH*0.16;
    cs.forEach((c,idx)=>{
      const hgt=(c.vol||0)/vmx*vh;
      ctx.fillStyle=c.c>=c.o?'rgba(38,166,154,.35)':'rgba(239,83,80,.35)';
      ctx.fillRect(idx*slot+0.5,plotH-hgt,Math.max(1,bw),hgt);
    });
  }
  // value area lines
  if(va){
    const vaLine=(p,txt,col)=>{
      if(p<mn||p>mx)return; const y=Y(p);
      ctx.strokeStyle=col; ctx.setLineDash([2,3]);
      ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(plotW,y);ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle=col; ctx.fillText(txt,3,y-2);
    };
    vaLine(va.vah,'VAH','rgba(200,200,200,.55)');
    vaLine(va.poc,'POC','rgba(245,166,35,.85)');
    vaLine(va.val,'VAL','rgba(200,200,200,.55)');
  }
  // candles
  cs.forEach((c,idx)=>{
    const x=idx*slot+slot/2, col=c.c>=c.o?'#26a69a':'#ef5350';
    ctx.strokeStyle=col; ctx.fillStyle=col;
    ctx.beginPath();ctx.moveTo(x,Y(c.h));ctx.lineTo(x,Y(c.l));ctx.stroke();
    const y1=Y(Math.max(c.o,c.c)), y2=Y(Math.min(c.o,c.c));
    ctx.fillRect(x-bw/2,y1,bw,Math.max(1,y2-y1));
  });
  // plan lines (entry / stop / target)
  if(T){
    const pLine=(p,txt,col,dash)=>{
      if(p<mn||p>mx)return; const y=Y(p);
      ctx.strokeStyle=col; ctx.setLineDash(dash);
      ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(plotW,y);ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle=col; ctx.fillText(txt+' '+p.toFixed(2),3,y-2);
    };
    pLine(T.entry,'ENTRY','#4da3ff',[6,4]);
    pLine(T.stop,'SL','#ef5350',[]);
    pLine(T.target,'TP','#26a69a',[]);
  }
  // last price line + tag
  const lp=cs[cs.length-1].c, ly=Y(lp);
  ctx.strokeStyle='rgba(255,255,255,.45)'; ctx.setLineDash([4,4]);
  ctx.beginPath();ctx.moveTo(0,ly);ctx.lineTo(plotW,ly);ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle='#e6eaf2'; ctx.fillRect(plotW+1,ly-8,AX-3,16);
  ctx.fillStyle='#0a0e14'; ctx.fillText(lp.toFixed(2),plotW+5,ly+3);
  // time labels (UTC)
  ctx.fillStyle='#888';
  const stepLbl=Math.max(1,Math.floor(cs.length/4));
  cs.forEach((c,idx)=>{
    if(idx%stepLbl)return;
    const dt=new Date(c.t*1000);
    const s=flowTF==='D1'
      ? dt.getUTCDate()+'/'+(dt.getUTCMonth()+1)
      : String(dt.getUTCHours()).padStart(2,'0')+':'+String(dt.getUTCMinutes()).padStart(2,'0');
    ctx.fillText(s,idx*slot+1,Hd-2);
  });
}

// ================= live paper tally (forward test, 20 Oct 2026) =================
// The tape engine has no historical data, so it can never be backtested —
// this tally is its only honest scoreboard. Every fresh plan the engine
// prints is recorded (this device, localStorage) and resolved against the
// live price: TP = +netRr (the plan's own net-of-costs R), SL = -1R,
// verdict abandoning/replacing an unsettled plan = FLAT at market minus costs.
const PAPER_KEY='liqscalp_flow_paper_v1';
let paper=(()=>{try{return JSON.parse(localStorage.getItem(PAPER_KEY)||'null')||{n:0,tp:0,sl:0,flat:0,netR:0,open:null};}catch(e){return{n:0,tp:0,sl:0,flat:0,netR:0,open:null};}})();
function paperSave(){try{localStorage.setItem(PAPER_KEY,JSON.stringify(paper));}catch(e){}}
function paperFlat(o,px){
  const risk=Math.abs(o.entry-o.stop); if(!(risk>0)){paper.open=null;paperSave();return;}
  const gross=o.side*(px-o.entry)/risk, costR=(o.entry*2*BASE_COST_BP/10000)/risk;
  paper.flat++; paper.netR+=gross-costR; paper.open=null; paperSave();
}
function paperOpen(side,T,now){
  if(!T)return;
  if(paper.open)paperFlat(paper.open,T.entry);
  paper.n++;
  paper.open={side,entry:T.entry,stop:T.stop,target:T.target,netRr:T.netRr,t:now};
  paperSave();
}
function paperTick(hiPx,loPx){
  const o=paper.open; if(!o||!hiPx||!loPx)return;
  if(o.side>0?loPx<=o.stop:hiPx>=o.stop){paper.sl++;paper.netR-=1;paper.open=null;paperSave();}
  else if(o.side>0?hiPx>=o.target:loPx<=o.target){paper.tp++;paper.netR+=o.netRr;paper.open=null;paperSave();}
}
function paperText(){
  const judged=paper.tp+paper.sl;
  const acc=judged?(100*paper.tp/judged).toFixed(0)+'%':'—';
  let s='📝 <b>live paper tally</b> (tape engine, this device): '+paper.n+' signals · '
    +paper.tp+' TP / '+paper.sl+' SL / '+paper.flat+' flat · accuracy '+acc
    +' · net <b>'+(paper.netR>=0?'+':'')+paper.netR.toFixed(1)+'R</b>'
    +' · judge at 100+ resolved (now '+judged+')';
  if(paper.open){
    const o=paper.open;
    s+='<br>open: '+(o.side>0?'LONG ':'SHORT ')+o.entry.toFixed(2)+' → TP '+o.target.toFixed(2)+' / SL '+o.stop.toFixed(2);
  }
  return s;
}

// ================= the READ (ported from dom_decision.read) =================
function winStats(ms){
  const now=Date.now();let b=0,s=0,act=0,first=null,lastF=null;
  for(const f of frames){
    if(f.t<now-ms)continue;
    b+=f.tb;s+=f.ts;
    if(f.tb+f.ts>0)act++;
    if(!first)first=f; lastF=f;
  }
  const tot=b+s;
  const mv=(first&&lastF&&first.m>0)?(lastF.m-first.m)/first.m*1e4:0;
  return{buy:b,sell:s,total:tot,active:act,ratio:tot>0?(b-s)/tot:0,moveBps:mv};
}
function minuteRanges(n){
  const now=Date.now(),cur=Math.floor(now/60000),hi={},lo={};
  for(const f of frames){
    if(!f.mx||!f.ms)continue;
    const m=Math.floor(f.t/60000);
    if(m>=cur||m<cur-n)continue;
    hi[m]=Math.max(hi[m]??-1e18,f.mx);lo[m]=Math.min(lo[m]??1e18,f.ms);
  }
  return Object.keys(hi).sort().map(m=>hi[m]-lo[m]);
}
function volMult(){
  const now=Date.now(),n=new Array(11).fill(0);
  for(const f of frames){
    const k=Math.floor((now-f.t)/60000);
    if(k>=0&&k<=10)n[k]+=f.tb+f.ts;
  }
  const r=n.slice(1).filter(x=>x>0).sort((a,b)=>a-b);
  if(r.length<3)return 1;
  const med=r[Math.floor(r.length/2)];
  return med>0?n[0]/med:1;
}
function candleRange(price){
  const rs=minuteRanges(10);
  let r;
  if(rs.length>=3)r=rs.reduce((a,b)=>a+b,0)/rs.length;
  else{const cs=[...candles.values()].slice(-10);r=cs.length?cs.reduce((a,c)=>a+c.h-c.l,0)/cs.length:0;}
  return r>0&&price>0?{bps:r/price*1e4,abs:r}:{bps:10,abs:0};
}
function cvdDivergence(){
  const cs=[...candles.values()].slice(-10);
  if(cs.length<6)return 0;
  const cum=[];let s=0;
  for(const c of cs){s+=c.bv-c.sv;cum.push(s);}
  const n=cs.length-1;let ih=0,il=0;
  for(let i=1;i<n;i++){if(cs[i].h>cs[ih].h)ih=i;if(cs[i].l<cs[il].l)il=i;}
  if(cs[n].h>cs[ih].h&&cum[n]<cum[ih])return -1;
  if(cs[n].l<cs[il].l&&cum[n]>cum[il])return 1;
  return 0;
}
function stacked(candle,kind){
  if(!candle)return[0,0,0];
  const rows=candle.rows,bins=Object.keys(rows).map(Number).sort((a,b)=>a-b);
  let best=[0,0,0],run=0,start=0,prev=null;
  for(const b of bins){
    const[sell,buy]=rows[b];let imb=false;
    if(kind==='buy'){const below=rows[b-1];imb=buy>0&&below&&buy>=3*Math.max(below[0],1);}
    else{const above=rows[b+1];imb=sell>0&&above&&sell>=3*Math.max(above[1],1);}
    if(imb){
      run=(prev!==null&&b===prev+1&&run>0)?run+1:1;
      if(run===1)start=b;
      if(run>best[0])best=[run,start,b];
    }else run=0;
    prev=b;
  }
  return best;
}
function valueArea(){
  const rows=[...profile.rows.entries()];
  if(!rows.length)return null;
  const tot=rows.reduce((a,[,v])=>a+v[0]+v[1],0);
  const d=new Map(rows.map(([b,v])=>[b,v[0]+v[1]]));
  let poc=[...d.entries()].reduce((a,b)=>b[1]>a[1]?b:a)[0];
  let lo=poc,hi=poc,cum=d.get(poc);
  while(cum<0.7*tot){
    const up=d.get(hi+1)||0,dn=d.get(lo-1)||0;
    if(!up&&!dn)break;
    if(up>=dn){hi++;cum+=up;}else{lo--;cum+=dn;}
  }
  return{poc:(poc+0.5)*BIN,vah:(hi+1)*BIN,val:lo*BIN};
}
function bookWalls(price){
  const out=[];
  for(const[,w] of walls){
    if(Date.now()-w.firstSeen<30000||w.pulled>=2)continue;
    out.push(w);
  }
  return out.sort((a,b)=>Math.abs(a.price-price)-Math.abs(b.price-price));
}

function read(){
  const now=Date.now(), price=mid();
  if(!frames.length||!price||!connected)return null;
  const S=[];
  const c60=winStats(60000),c10=winStats(10000);
  const cs=[...candles.values()];
  const closedN=cs.filter(c=>c.t<Math.floor(now/60000)*60);
  const ns=closedN.slice(-60).map(c=>Math.min(c.n,120)).filter(n=>n>0).sort((a,b)=>a-b);
  const norm60=clamp(ns.length>=10?ns[Math.floor(ns.length/2)]:ACTIVE_NORM_60,ACTIVE_MIN,ACTIVE_NORM_60);
  const act=clamp(c60.active/norm60,0,1), act10=clamp(c10.active/Math.max(1,norm60/3),0,1);
  // 1. aggression 60s
  if(c60.total>0){
    const r=c60.ratio;
    S.push({key:'aggression60',label:'Aggression (1 min)',score:clamp(r/0.4,-1,1)*W.aggression60*act,max:W.aggression60,
      short:Math.abs(r)<.1?'Buying and selling balanced':(r>0?'Buyers':'Sellers')+' took '+pct(Math.max(c60.buy,c60.sell)/c60.total)+' of 1-min volume'});
  }
  // 2. momentum 10s
  if(c10.total>0){
    const r=c10.ratio;
    S.push({key:'aggression10',label:'Momentum (10 s)',score:clamp(r/0.5,-1,1)*W.aggression10*act10,max:W.aggression10,
      short:Math.abs(r)<.2?'No short-term push':(r>0?'Buying':'Selling')+' burst in the last 10 s'});
  }
  // 3. CVD trend / divergence
  const c300=winStats(300000), cr=candleRange(price), flat=Math.max(2,cr.bps*0.2);
  if(c300.total>0){
    const firstF=frames.find(f=>f.t>=now-300000), lastF=frames[frames.length-1];
    const nCvd=(lastF?lastF.cvd:0)-(firstF?firstF.cvd:0), r=nCvd/c300.total;
    const dv=cvdDivergence();
    if(dv===0){
      S.push({key:'cvdTrend',label:'CVD trend (5 min)',score:clamp(r/0.3,-1,1)*W.cvdTrend*0.5,max:W.cvdTrend,
        short:Math.abs(r)<.05?'Net flow flat over 5 min':'Net '+(r>0?'buying':'selling')+' over 5 min'});
    }else{
      S.push({key:'cvdTrend',label:'CVD trend (5 min)',score:dv*W.cvdTrend,max:W.cvdTrend,
        short:dv<0?'Divergence: new high without buyers':'Divergence: new low without sellers'});
    }
  }
  // 4. order book ±0.1%, pulled-adjusted
  {
    const band=price*0.001;let yb=0,ya=0;
    for(const[c,q]of bids){const p=c/100;if(price-p<=band&&p<=price)yb+=p*q;}
    for(const[c,q]of asks){const p=c/100;if(p-price<=band&&p>=price)ya+=p*q;}
    if(yb+ya>0){
      let bPul=0,aPul=0,bAdd=0,aAdd=0;
      for(const[,w] of walls){
        if(Math.abs(w.price-price)>band)continue;
        if(w.side==='bid'){bAdd++;bPul+=w.pulled;}else{aAdd++;aPul+=w.pulled;}
      }
      const bRel=(bAdd+1)/(bAdd+bPul+2), aRel=(aAdd+1)/(aAdd+aPul+2);
      const cc=((yb*bRel)-(ya*aRel))/((yb*bRel+ya*aRel)||1);
      S.push({key:'book',label:'Order book (±0.1%)',score:clamp(cc/0.5,-1,1)*W.book,max:W.book,
        short:Math.abs(cc)<.15?'Order book even':(cc>0?'Bids':'Asks')+' heavier in the book'});
    }
  }
  // 5. absorption
  {
    const vr=volMult();
    if(c60.total>0&&c60.active>=ACTIVE_MIN){
      let e=0,n='No absorption';
      if(vr>=1.5&&c60.ratio<=-.25&&c60.moveBps>=-flat){e=W.absorption;n='Heavy selling absorbed (possible floor)';}
      else if(vr>=1.5&&c60.ratio>=.25&&c60.moveBps<=flat){e=-W.absorption;n='Heavy buying absorbed (possible ceiling)';}
      S.push({key:'absorption',label:'Absorption',score:e*act,max:W.absorption,short:n});
    }
  }
  // 6. stacked imbalances, last two candles
  {
    const two=cs.slice(-2);
    let wb=[0,0,0],ws=[0,0,0];
    for(const c of two){
      const b=stacked(c,'buy'),s=stacked(c,'sell');
      if(b[0]>wb[0])wb=b; if(s[0]>ws[0])ws=s;
    }
    let e=0,n='No stacked imbalances';
    if(wb[0]>=3&&wb[0]>=ws[0]){e=clamp(wb[0]/4,0,1)*W.stacked;n=wb[0]+' stacked buy imbalances';}
    else if(ws[0]>=3){e=-clamp(ws[0]/4,0,1)*W.stacked;n=ws[0]+' stacked sell imbalances';}
    S.push({key:'stacked',label:'Footprint imbalances',score:e,max:W.stacked,short:n,_wb:wb,_ws:ws});
  }
  // 7. value area
  {
    const va=valueArea();
    if(va){
      let sc2=0,cc='Inside the value area (ranging)';
      if(price>va.vah){sc2=W.value;cc='Above the value area';}
      else if(price<va.val){sc2=-W.value;cc='Below the value area';}
      S.push({key:'value',label:'Value area',score:sc2,max:W.value,short:cc,_va:va});
    }
  }
  // 8. large prints 60s
  {
    const O=whales.filter(w=>w[0]>=now-60000);
    if(O.length){
      const net=O.reduce((a,w)=>a+w[3]*w[4],0), tot=O.reduce((a,w)=>a+w[4],0);
      S.push({key:'largePrints',label:'Large prints (1 min)',score:clamp(net/(tot||1),-1,1)*W.largePrints,max:W.largePrints,
        short:'Large traders net '+(net>=0?'buying':'selling')});
    }
  }
  // 9. inferred liquidity: pulled walls 60s
  {
    let e=0;const notes=[];
    for(const ev of events){
      if(ev[0]<now-60000)continue;
      if(ev[1]==='pulled'){e+=ev[2]==='bid'?-4:4;notes.push('wall pulled '+ev[2]+' @ '+ev[3].toFixed(2));}
    }
    if(notes.length)S.push({key:'liquidity',label:'Pulled walls (1 min)',score:clamp(e/W.liquidity,-1,1)*W.liquidity,max:W.liquidity,short:notes[notes.length-1]});
  }
  const tot=S.reduce((a,f)=>a+f.score,0);
  const score=Math.round(tot/WSUM*100);
  const thin=c60.active<ACTIVE_MIN;
  const bias=thin?'NEUTRAL':score>=45?'STRONG_BUY':score>=20?'BUY':score<=-45?'STRONG_SELL':score<=-20?'SELL':'NEUTRAL';
  const sg=Math.sign(score);
  const P=S.reduce((a,f)=>a+Math.abs(f.score),0);
  const agree=P>0?S.filter(f=>Math.sign(f.score)===sg).reduce((a,f)=>a+Math.abs(f.score),0)/P:0;
  // supports / resistances
  const sup=[],res=[];
  for(const[,w] of bookWalls(price)){
    const why=(w.side==='bid'?'bid':'ask')+' wall '+usd(w.usd);
    if(w.side==='bid'&&w.price<price)sup.push({price:w.price,why});
    else if(w.side==='ask'&&w.price>price)res.push({price:w.price,why});
  }
  if(cs.length>=3){
    const z=cs.slice(-10),lo=Math.min(...z.map(c=>c.l)),hi=Math.max(...z.map(c=>c.h));
    if(lo<price)sup.push({price:lo,why:'recent low'});
    if(hi>price)res.push({price:hi,why:'recent high'});
  }
  const vaF=S.find(f=>f.key==='value');
  if(vaF&&vaF._va){
    const{poc,vah,val}=vaF._va;
    if(val<price)sup.push({price:val,why:'value area low'});
    if(poc<price)sup.push({price:poc,why:'POC'});else if(poc>price)res.push({price:poc,why:'POC'});
    if(vah>price)res.push({price:vah,why:'value area high'});
  }
  sup.sort((a,b)=>b.price-a.price);res.sort((a,b)=>a.price-b.price);
  const lead=S.filter(f=>Math.sign(f.score)===sg&&sg!==0).sort((a,b)=>Math.abs(b.score)-Math.abs(a.score));
  const summary=thin?'Thin trading — not enough flow to read. Wait for trades to confirm.'
    :bias==='NEUTRAL'?'Mixed order flow — no side clearly in control. Waiting is a position.'
    :(sg>0?'Buy':'Sell')+'-side flow leading: '+lead.slice(0,2).map(f=>f.label.toLowerCase()).join(' + ')+'.';
  return{t:now,price,score,bias,agreement:Math.round(agree*1000)/1000,activity:Math.round(act*1000)/1000,
         active60:c60.active,factors:S,supports:sup.slice(0,10),resistances:res.slice(0,10),
         summary,candleRange:cr.abs,volMult:Math.round(volMult()*100)/100,thin};
}

// ================= the DECISION (ported from dom_decision.decide) =================
function makePlan(rd,side,tick,crange,costBps,entry){
  const o=entry,s=Math.max(crange*0.75,o*8e-4,tick*3),c=Math.max(tick*2,o*2e-4,crange*0.4);
  const pool=side>0?rd.supports:rd.resistances;
  const l=pool.find(x=>{const d=Math.abs(o-x.price)+c;return d>=s&&d<=s*4;});
  const stop=l?l.price-side*c:o-side*s*1.5;
  const stopWhy=l?'beyond '+l.why:'volatility stop — no level nearby';
  const f=Math.abs(o-stop),p=Math.max(tick*3,o*3e-4,crange*0.25);
  const m=(side>0?rd.resistances:rd.supports).filter(x=>Math.abs(x.price-o)>=p);
  const h=m.find(x=>Math.abs(x.price-o)>=f*1.5)||m[m.length-1];
  const g=!!h&&Math.abs(h.price-o)>tick*2;
  const tgt=g?h.price-side*tick:o+side*f*2;
  const tw=g?'before '+h.why:'2× risk — no level mapped';
  const y=f/o*1e4,b=Math.abs(tgt-o)/o*1e4;
  return{side,entry:Math.round(o*100)/100,stop:Math.round(stop*100)/100,target:Math.round(tgt*100)/100,
    stopWhy,targetWhy:tw,riskBps:Math.round(y*100)/100,rewardBps:Math.round(b*100)/100,
    rr:Math.round(b/Math.max(y,1e-9)*100)/100,costBps:Math.round(costBps*100)/100,
    netBps:Math.round((b-costBps)*100)/100,
    netRr:Math.round((b-costBps)/Math.max(y+costBps,1e-9)*100)/100,
    breakevenWin:Math.round((y+costBps)/Math.max(b+y,1e-9)*1000)/1000};
}

function decide(rd){
  const now=Date.now(),score=rd.score,price=rd.price;
  const r=st.smooth===null?score:st.smooth+SMOOTH*(score-st.smooth);
  const i=r>=FLIP?1:r<=-FLIP?-1:0;
  const a=i!==0?i:(score<0?-1:1);
  const tr=trend;
  const u=st.verdict==='BUY'?1:st.verdict==='SELL'?-1:0;
  const fr3=frames.slice(-3);
  const hi=Math.max(price,...fr3.map(f=>f.mx||0)), lo=Math.min(price,...fr3.map(f=>f.ms||Infinity));
  const spreadBps=(bb&&ba&&price)?(ba-bb)/price*1e4:0;
  const cost=BASE_COST_BP+spreadBps;
  const stopped=p=>p.side>0?lo<=p.stop:hi>=p.stop;
  const hit=p=>p.side>0?hi>p.target:lo<p.target;
  let h=null;
  if(u!==0&&st.plan){
    if(stopped(st.plan))h='Stop reached — the setup was wrong. Waiting for the next one.';
    else if(hit(st.plan))h='Target reached — the setup is complete. Waiting for the next one.';
  }
  const keep=!h&&u!==0&&u===i;
  const cool=60000;
  const x=(!keep&&i!==0&&st.last&&st.last.side===i)?st.last:null;
  const S=x&&!x.ended&&x.plan&&(now-x.t<cool);
  const C=x&&x.ended&&(now-x.endedAt<cool);
  const w=i>0?(ba||price):(bb||price);
  const T=i===0?null:(keep&&st.plan)?st.plan:(S&&x.plan)?x.plan:makePlan(rd,i,TICK,rd.candleRange,cost,w);
  const E=rd.activity<0.5;
  let D=0,O=0;
  for(const f of rd.factors){
    if(i!==0&&Math.sign(f.score)===i){D+=Math.abs(f.score);if(FLOW_KEYS.includes(f.key))O+=Math.abs(f.score);}
  }
  const k=D>0?O/D:0;
  const vr=rd.volMult, tox=toxicity();
  const wide=true;
  let regime='unclear';
  if((vr>=1.8&&wide)||(tox.p||0)>=0.95)regime='volatile';
  else if(tr.dir!==0&&vr>=1.2)regime='trend';
  else if(tr.dir===0&&vr<0.9)regime='range';
  const j=REGIME_NEED[regime]||45;
  const M=keep?NEED_HOLD:NEED_STRENGTH+(regime==='volatile'?10:0);
  const N=keep?0.4:0.5, P=keep?1:1.2, F=cost*(keep?1.5:COST_MULT);
  let I=null;
  const sideW=i>0?'buy':'sell';
  if(h)I=h;
  else if(E)I='Too little trading to read — resting orders alone can be pulled.';
  else if(i===0)I='Buyers and sellers are balanced — nobody is in control.';
  else if(C&&x)I=x.ended==='stop'
    ?'Last '+sideW+' setup was stopped — no new one for 60s.'
    :'Last '+sideW+' setup hit target — letting it settle.';
  else if(i*r<M)I='Leaning '+sideW+', but the evidence is not strong enough yet.';
  else if(k<N)I='Leaning '+sideW+', but the push comes from resting orders, not trades — wait for aggressive '+(i>0?'buying.':'selling.');
  else if(T&&T.rewardBps<F)I='Leaning '+sideW+', but target move is too small for ~'+(cost/100).toFixed(2)+'% costs.';
  else if(T&&T.netRr<P)I='Leaning '+sideW+', but after costs the reward is only '+T.netRr+'× risk.';
  else if(tr.dir===-i&&i*r<j&&!keep)I='Leaning '+sideW+', but against the 15m '+tr.label+' — waiting for a stronger read.';
  const L=I?'WAIT':(i>0?'BUY':'SELL');
  const fac=key=>rd.factors.find(f=>f.key===key);
  const ok=key=>{const f=fac(key);if(!f||Math.abs(f.score)<0.5)return null;return Math.sign(f.score)===a;};
  const R=fac('absorption');
  const checks=[
    {label:a>0?'Aggressive buyers in control':'Aggressive sellers in control',ok:ok('aggression60')},
    {label:'Order book agrees',ok:ok('book')},
    {label:'No absorption against it',ok:R?(R.score*a>=-0.5):null},
    {label:'15m trend agrees',ok:tr.dir===0?null:tr.dir===a},
    {label:'Enough trading activity',ok:!E},
    {label:'Reward ≥ 1.5× risk after costs',ok:T?T.netRr>=1.5:null},
    {label:'Target ≥ 2.5× costs',ok:T?T.rewardBps>=cost*COST_MULT:null}];
  const why=rd.factors.filter(f=>Math.abs(f.score)>=0.5&&Math.sign(f.score)===a)
    .sort((x2,y2)=>Math.abs(y2.score)-Math.abs(x2.score)).slice(0,3).map(f=>f.short);
  const V=clamp(Math.abs(r)/50,0,1), ne=i===0?0.5:tr.dir===i?1:tr.dir===0?0.5:0;
  const H=T?clamp((T.netRr-1)/1.5,0,1):0;
  const conf=Math.round(100*(0.35*V+0.2*rd.agreement+0.2*rd.activity+0.15*ne+0.1*H));
  const since=(L===st.verdict&&st.since)?st.since:now;
  if(L!=='WAIT'&&!keep&&!S){st.last={side:i,t:now,plan:T,ended:null,endedAt:0};paperOpen(i,T,now);}
  if(st.last&&!st.last.ended&&st.last.plan){
    if(stopped(st.last.plan)){st.last.ended='stop';st.last.endedAt=now;}
    else if(hit(st.last.plan)){st.last.ended='target';st.last.endedAt=now;}
  }
  st.smooth=r;st.verdict=L;st.since=since;st.plan=L==='WAIT'?null:T;
  return{t:now,price,verdict:L,score:Math.round(r),confidence:conf,
    confidenceLabel:conf>=70?'High':conf>=45?'Medium':'Low',
    action:L!=='WAIT'&&T
      ?(i>0?'Buy-side flow is leading. Buy ':'Sell-side flow is leading. Sell ')+T.entry+', stop '+T.stop+', target '+T.target+'. If the stop comes first, the read was wrong.'
      :'Wait. Only with the flow confirming.',
    waitReason:I,why,checks,plan:L==='WAIT'?null:T,trend:tr,regime,since,score};
}

// ================= render =================
function render(d,rd){
  if(!running)return;
  const dot=$('flowDot'),px=$('flowPrice'),sp=$('flowSpread');
  if(dot)dot.className='fdot '+(connected?'live':'dead');
  if(px)px.textContent=rd?rd.price.toFixed(2):'–';
  if(sp)sp.textContent=(bb&&ba)?('spread '+(ba-bb).toFixed(2)):'';
  const vb=$('flowVerdict');
  if(vb&&d){
    const col=d.verdict==='BUY'?'#26a69a':d.verdict==='SELL'?'#ef5350':'#888';
    vb.innerHTML='<div class="fv" style="border-color:'+col+'">'
      +'<div class="fv-h" style="color:'+col+'">'+d.verdict
      +(d.verdict!=='WAIT'?' <span class="fv-c">'+d.confidence+'% · '+d.confidenceLabel+'</span>':'')
      +'</div><div class="fv-s">'+esc(d.action)+'</div>'
      +(d.waitReason&&d.verdict==='WAIT'?'<div class="fv-w">'+esc(d.waitReason)+'</div>':'')
      +'</div>';
  }
  const pp=$('flowPaper');
  if(pp)pp.innerHTML=paperText();
  const pl=$('flowPlan');
  if(pl){
    const T=d&&d.plan;
    pl.innerHTML=T?'<div class="fp"><b>'+(T.side>0?'LONG':'SHORT')+' '+T.entry+'</b>'
      +' · stop '+T.stop+' <span class="dim">('+esc(T.stopWhy)+')</span>'
      +' · target '+T.target+' <span class="dim">('+esc(T.targetWhy)+')</span>'
      +' · <b>'+T.netRr+'R</b> net of costs · breakeven '+(T.breakevenWin*100).toFixed(1)+'%</div>'
      :'<div class="fp dim">No active plan — waiting.</div>';
  }
  const g=$('flowGates');
  if(g&&d){
    g.innerHTML='<div class="fg">'+d.checks.map(c=>
      '<span class="fg-i '+(c.ok===null?'na':c.ok?'ok':'no')+'">'
      +(c.ok===null?'○':c.ok?'✓':'✗')+' '+esc(c.label)+'</span>').join('')+'</div>';
  }
  const f=$('flowFactors');
  if(f&&d){
    f.innerHTML=d.why.map(x=>'<div class="ff">· '+esc(x)+'</div>').join('')
      +'<div class="ff dim">score '+d.score+' · agreement '+Math.round(rd.agreement*100)+'% · activity '+Math.round(rd.activity*100)+'% · '+esc(d.regime)+'</div>';
  }
  const lv=$('flowLevels');
  if(lv&&rd){
    lv.innerHTML='<div class="fl2"><div><b class="up">Supports</b>'
      +rd.supports.slice(0,4).map(s=>'<div>'+s.price.toFixed(2)+' <span class="dim">'+esc(s.why)+'</span></div>').join('')
      +'</div><div><b class="dn">Resistances</b>'
      +rd.resistances.slice(0,4).map(s=>'<div>'+s.price.toFixed(2)+' <span class="dim">'+esc(s.why)+'</span></div>').join('')
      +'</div></div>';
  }
  const wh=$('flowWhales');
  if(wh){
    const rows=whales.slice(-8).reverse().map(w=>
      '<div class="fw '+(w[3]>0?'up':'dn')+'">'+(w[3]>0?'▲':'▼')+' '+usd(w[4])+' @ '+w[1].toFixed(2)+'</div>').join('');
    wh.innerHTML=rows||'<div class="dim">waiting for prints…</div>';
  }
  const er=$('flowErr');
  if(er)er.textContent=errMsg&&!connected?('⚠ '+errMsg+' — retrying'):(!connected?'◌ connecting…':'');
}

// ================= lifecycle =================
function step(){
  if(!running)return;
  const rd=read();
  if(!rd){render(null,null);drawFlowChart(null);return;}
  const d=decide(rd);
  paperTick(Math.max(rd.price,last||0),Math.min(rd.price,last||Infinity));
  lastOut={d,rd};
  render(d,rd);
  drawFlowChart(d);
}
function start(){
  if(running)return;
  running=true;
  applyTab(true);
  connect();
  refreshTrend();
  // FLOW chart opens on whatever TF the bar shows, and follows TF taps
  const actB=document.querySelector('#tfbar .tf.active');
  flowTF=(actB&&FLOW_TF_MS[actB.dataset.tf])?actB.dataset.tf:'M1';
  seed=new Map();
  seedChart();
  if(!tfBound){tfBound=true;document.querySelectorAll('#tfbar .tf').forEach(b=>b.addEventListener('click',()=>{
    if(!running)return;
    const tf=b.dataset.tf;
    if(!FLOW_TF_MS[tf]||tf===flowTF)return;
    flowTF=tf; seed=new Map(); seedChart(); drawFlowChart(lastOut?lastOut.d:null);
  }));}
  if(!rzBound){rzBound=true;window.addEventListener('resize',()=>{if(running)drawFlowChart(lastOut?lastOut.d:null);});}
  t500=setInterval(frameTick,500);
  t1s=setInterval(step,1000);
  tWall=setInterval(wallsTick,2000);
  tTrend=setInterval(()=>{refreshTrend();seedChart();},5*60*1000);
  step();
}
function stop(){
  running=false;
  [t500,t1s,tWall,tTrend].forEach(t=>t&&clearInterval(t));
  t500=t1s=tWall=tTrend=null;
  if(ws){try{ws.close();}catch(e){}ws=null;}
  connected=false;
  applyTab(false);
}
function applyTab(on){
  const w=$('flowWrap'),c=$('chartWrap');
  if(w)w.style.display=on?'block':'none';
  if(c)c.style.display=on?'none':'block';
  // hide the sniper tab's panels while FLOW is on (CSS: body.flow-on) —
  // they belong to the sniper chart, not to this tab
  document.body.classList.toggle('flow-on',on);
}
function isOn(){return running;}

return{start,stop,applyTab,isOn};
})();
