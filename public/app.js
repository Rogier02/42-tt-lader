// 42 Table Tennis Ladder: the web page. Talks to the server through /api.
(()=>{
const SC=173.7178, TAU=0.5, DAY=864e5;
let S=null, CFG={authMode:'dev',season:''};
const ui={view:'home',ptab:'profile',lview:'players',pid:null,sort:'rating',scope:'season',tview:'overview',tid:null,tplan:false,month:null,devUsers:null,loginMsg:''};
const COAL_COLORS={Vela:'#d23f36',Cetus:'#2e6fd6',Pyxis:'#8a4fd3'};
const TEMPLATES=[
  {id:'quick',name:'Quick',desc:'Best of 3 every round',stages:{early:3,qf:3,sf:3,final:3}},
  {id:'standard',name:'Standard',desc:'Best of 5 from the semis',stages:{early:3,qf:3,sf:5,final:5}},
  {id:'championship',name:'Championship',desc:'Best of 5, best of 7 final',stages:{early:5,qf:5,sf:5,final:7}}];
const STAGES=['early','qf','sf','final'], STAGE_NAMES={early:'Early rounds',qf:'Quarterfinals',sf:'Semifinals',final:'Final'};
const BO7_NOTE='<div class="notice"><b>One table, many players.</b> A best of 7 can take 45 minutes or more. Check that nobody is waiting before you start, and let others play between games if they are.</div>';

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const P=id=>S.players.find(p=>p.id===Number(id));
const first=p=>p.name.split(' ')[0];

/* ---------- API ---------- */
async function api(path,body){
  const opts=body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)};
  const r=await fetch(path,{credentials:'same-origin',...opts});
  let data=null;try{data=await r.json()}catch(_){}
  if(!r.ok){const e=new Error(data&&data.error||`Something went wrong (${r.status}). Try again.`);e.status=r.status;throw e}
  return data;
}
async function refresh(){try{S=await api('/api/state')}catch(e){S=null;if(e.status!==401)toast(e.message)}render()}
async function act(fn){try{await fn()}catch(e){toast(e.message)}}

/* ---------- previews only; the server owns the real numbers ---------- */
const gf=phi=>1/Math.sqrt(1+3*phi*phi/(Math.PI*Math.PI));
const Ef=(mu,muj,phij)=>1/(1+Math.exp(-gf(phij)*(mu-muj)));
function glicko(p,o,s){
  const mu=(p.r-1500)/SC,phi=p.rd/SC,muj=(o.r-1500)/SC,phij=o.rd/SC,g=gf(phij),e=Ef(mu,muj,phij),v=1/(g*g*e*(1-e)),delta=v*g*(s-e);
  const a=Math.log(p.vol*p.vol),d2=delta*delta,p2=phi*phi;
  const f=x=>{const ex=Math.exp(x);return ex*(d2-p2-v-ex)/(2*Math.pow(p2+v+ex,2))-(x-a)/(TAU*TAU)};
  let A=a,B;if(d2>p2+v)B=Math.log(d2-p2-v);else{let k=1;while(f(a-k*TAU)<0)k++;B=a-k*TAU}
  let fA=f(A),fB=f(B),n=0;while(Math.abs(B-A)>1e-6&&n++<100){const C=A+(A-B)*fA/(fB-fA),fC=f(C);if(fC*fB<=0){A=B;fA=fB}else fA/=2;B=C;fB=fC}
  const vol=Math.exp(A/2),phiS=Math.sqrt(p2+vol*vol),phiN=1/Math.sqrt(1/(phiS*phiS)+1/v);
  return{r:(mu+phiN*phiN*g*(s-e))*SC+1500};
}
const winChance=(p,o)=>Ef((p.r-1500)/SC,(o.r-1500)/SC,Math.sqrt((p.rd/SC)**2+(o.rd/SC)**2));
function validSet(x,y){if(x===y)return false;const hi=Math.max(x,y),lo=Math.min(x,y);if(hi<11)return false;return hi===11?lo<=9:hi-lo===2}

/* ---------- helpers ---------- */
const games=p=>p.w+p.l;
const prov=p=>games(p)<5||p.rd>200;
const ranked=()=>[...S.players].filter(p=>games(p)>0).sort((a,b)=>b.r-a.r);
const rankOf=id=>ranked().findIndex(p=>p.id===id)+1;
const matchesOf=id=>S.matches.filter(m=>m.status==='confirmed'&&(m.a===id||m.b===id)).sort((x,y)=>y.t-x.t);
const inSeason=m=>m.t>=S.seasonStart;
const incoming=id=>S.matches.filter(m=>m.status==='pending'&&m.b===id);
const outgoing=id=>S.matches.filter(m=>m.status==='pending'&&m.a===id);
const opp=(m,id)=>m.a===id?m.b:m.a;
const setsFor=(m,id)=>m.a===id?m.sets:m.sets.map(s=>[s[1],s[0]]);
const tally=sets=>{let a=0,b=0;sets.forEach(s=>s[0]>s[1]?a++:b++);return[a,b]};
const fmtSets=sets=>sets.map(s=>s[0]+'–'+s[1]).join(', ');
const fmtD=d=>(d>=0?'+':'−')+Math.abs(Math.round(d));
const fmtDate=t=>new Date(t).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
const fmtTime=t=>new Date(t).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
function ago(t){const d=(Date.now()-t)/DAY;if(d<1/24)return'just now';if(d<1)return Math.round(d*24)+'h ago';if(d<2)return'yesterday';if(d<14)return Math.round(d)+' days ago';return fmtDate(t)}
function toast(msg){const r=document.getElementById('toast-root');r.innerHTML=`<div class="toast" role="status">${esc(msg)}</div>`;clearTimeout(toast.t);toast.t=setTimeout(()=>r.innerHTML='',3500)}
const colorOf=name=>COAL_COLORS[name]||'var(--muted)';
const coalColor=p=>colorOf(p.coalition);
const coalDot=p=>`<span class="coal-dot" style="--c:${esc(coalColor(p))}" title="${esc(p.coalition)}"></span>`;
const coalChip=p=>p.coalition?`<span class="coal" style="--c:${esc(coalColor(p))}"><i></i>${esc(p.coalition)}</span>`:'';
const nameBtn=p=>`<button class="pname" data-act="player" data-pid="${p.id}"><b>${p.coalition?coalDot(p):''}${esc(p.name)}</b><span>${esc(p.login)}</span></button>`;
function ratingAtSeasonStart(p){let r=1500;for(const h of p.hist){if(h.t<S.seasonStart)r=h.r;else break}return r}
function roundName(n,r){const left=n-r;return left===1?'Final':left===2?'Semifinals':left===3?'Quarterfinals':left===4?'Round of 16':'Round '+(r+1)}
const tById=id=>S.tournaments.find(t=>t.id===Number(id));
const myStatus=t=>(t.players.find(p=>p.id===S.me)||{}).status;
const joinedIds=t=>t.players.filter(p=>p.status==='joined').map(p=>p.id);
const isOrg=t=>S.isAdmin||t.createdBy===S.me;
const STATUS_LABEL={proposed:'Awaiting approval',open:'Open',live:'Live',done:'Finished',rejected:'Not approved',cancelled:'Cancelled'};
const stChip=t=>`<span class="chip st-${t.status}">${STATUS_LABEL[t.status]}</span>`;
const incomingChallenges=()=>S.challenges.filter(c=>c.to===S.me&&c.status==='open');
const myInvites=()=>S.tournaments.filter(t=>t.status==='open'&&myStatus(t)==='invited');
const approvals=()=>S.isAdmin?S.tournaments.filter(t=>t.status==='proposed'):[];
const inboxCount=()=>incoming(S.me).length+incomingChallenges().length+myInvites().length+approvals().length+(S.matchups||[]).filter(m=>(m.a===S.me||m.b===S.me)&&m.status==='open').length;

/* ---------- a challenger approaches ---------- */
const myMatchups=()=>(S.matchups||[]).filter(m=>m.a===S.me||m.b===S.me);
const openMatchups=()=>myMatchups().filter(m=>m.status==='open');
const muOpp=m=>P(m.a===S.me?m.b:m.a);
const isChallenger=id=>openMatchups().some(m=>muOpp(m).id===Number(id));
function challengerCard(){
  if(!S.matchups)return '';
  const mine=myMatchups().filter(m=>m.status!=='expired'),X=S.matchupRules.multiplier;
  const doneCount=mine.filter(m=>m.status==='done').length;
  if(!mine.length)return S.matchupsOptOut?'':`<div class="challenger quiet"><span class="eyebrow">A challenger approaches</span><p class="sub">Your first challenger arrives ${fmtDate(S.nextDraw)}.</p></div>`;
  const rows=mine.map(m=>{
    const o=muOpp(m),me=P(S.me),bonus=m.kind==='bonus'?'<span class="chip warn">bonus round</span>':'';
    if(m.status==='done'){const mt=S.matches.find(x=>x.id===m.matchId),won=mt&&mt.w===S.me;
      return `<div class="ch-row done"><div><b>${esc(o.name)}</b> ${bonus}<span class="sub">Done: you ${won?'won':'lost'} and earned ${mt&&mt.pts?mt.pts[S.me]:0} season points${won&&mt.coalPts?`, +${mt.coalPts} for ${esc(mt.coalition)}`:''}.</span></div></div>`}
    if(m.status==='pending')return `<div class="ch-row"><div><b>${esc(o.name)}</b> ${bonus}<span class="sub">Result logged, waiting for confirmation.</span></div><button class="btn btn-sm" data-act="nav" data-view="inbox">Inbox</button></div>`;
    return `<div class="ch-row"><div class="ch-vs"><span class="ch-name">You vs <button class="link-btn" style="opacity:1" data-act="player" data-pid="${o.id}">${esc(o.name)}</button></span> ${bonus}
        <span class="sub">${coalChip(o)} ${Math.round(o.r)} rating · your win chance ${Math.round(winChance(me,o)*100)}% · play before ${fmtDate(m.expiresAt)}</span></div>
      <button class="btn btn-new btn-sm" data-act="newmatch" data-pid="${o.id}">Log result</button></div>`;
  }).join('');
  const waiting=doneCount>0&&!mine.some(m=>m.status==='open'||m.status==='pending')&&mine.length<S.matchupRules.maxPerWeek;
  return `<div class="challenger"><div class="ch-head"><span class="ch-title">A challenger approaches</span><span class="ch-mult">${X}× points</span></div>
    <p class="sub">Find them on campus or on Slack and play. Both of you earn ${X}× season points, and the winner earns ${X}× coalition points. Ratings count as normal.</p>
    ${rows}${waiting?`<p class="sub">Finished this week's challenge. When another player finishes theirs, you'll be drawn for a bonus round.</p>`:''}</div>`;
}
function challengerBoard(){
  const all=(S.matchups||[]);if(!all.length)return '';
  const label={open:'<span class="chip">to play</span>',pending:'<span class="chip warn">waiting</span>',done:'<span class="chip win">played</span>',expired:'<span class="chip">expired</span>'};
  const played=all.filter(m=>m.status==='done').length;
  return `<section class="panel"><div class="head-row"><h3>Challenger matches this week</h3><span class="sub">${played} of ${all.length} played · ${S.matchupRules.multiplier}× points</span></div>
    <div class="ch-board">${all.map(m=>{const a=P(m.a),b=P(m.b),mt=m.matchId&&S.matches.find(x=>x.id===m.matchId),w=m.status==='done'&&mt?mt.w:null;
      return `<div class="ch-pair"><span class="${w===a.id?'w':''}">${coalDot(a)}${esc(a.name)}</span><span class="vs">vs</span><span class="${w===b.id?'w':''}">${coalDot(b)}${esc(b.name)}</span>${m.kind==='bonus'?'<span class="chip warn">bonus</span>':''}${label[m.status]}</div>`}).join('')}</div></section>`;
}

/* ---------- shell ---------- */
function render(){
  const app=document.getElementById('app');
  if(!S){app.innerHTML=viewLogin();return}
  const me=P(S.me),inc=inboxCount();
  const tab=(v,l,extra='')=>`<button class="tab" data-act="nav" data-view="${v}" ${ui.view===v||(v==='home'&&ui.view==='player'&&false)?'aria-current="page"':''}>${l}${extra}</button>`;
  app.innerHTML=`<header class="top"><div class="top-in">
    <div class="brand-row"><p class="brand"><span class="ball" aria-hidden="true"></span>42 Table Tennis Ladder</p>
      <div class="top-actions"><button class="new-match" data-act="newmatch"><span class="plus" aria-hidden="true">+</span>New match</button>
      <div class="who"><b>${esc(me.login)}</b>${S.isAdmin?' <span class="chip" style="color:inherit;border-color:currentColor">admin</span>':''}<button class="link-btn" data-act="signout">${S.authMode==='dev'?'Switch user':'Sign out'}</button></div></div></div>
    <nav class="tabs" aria-label="Sections">${tab('home','Home')}${tab('ladder','Ladder')}${tab('tourn','Tournaments')}${tab('inbox','Inbox',inc?`<span class="badge">${inc}</span>`:'')}</nav>
  </div></header>
  ${S.authMode==='dev'?'<div class="demo-note">Development mode: sign-in is simulated. Add 42 credentials to the server config to switch to real 42 sign-in.</div>':''}
  <main id="main"></main>`;
  const main=document.getElementById('main');
  if(ui.view==='home')viewProfile(main,me,true);
  else if(ui.view==='player')viewProfile(main,P(ui.pid),false);
  else ({ladder:viewLadder,tourn:viewTourn,inbox:viewInbox})[ui.view](main,me);
}

function viewLogin(){
  const msg=ui.loginMsg?`<p class="status err">${esc(ui.loginMsg)}</p>`:'';
  const top=`<div class="login-top"><h1><span class="ball" aria-hidden="true"></span>42 Table Tennis Ladder</h1><p>Ratings, matches and tournaments for the campus table.</p></div>`;
  if(CFG.authMode==='42')return `<div class="login"><div class="login-card">${top}
    <div class="login-body">${msg}<a class="btn-42" href="/auth/42" style="text-decoration:none"><span class="mark">42</span>Sign in with 42 intra</a>
    <p class="note">We store your 42 login, name, coalition and the matches you play. Nothing else.</p></div></div></div>`;
  return `<div class="login"><div class="login-card">${top}
    <div class="login-body">${msg}<p class="note">Development mode: 42 sign-in isn't configured yet, so pick a test account.</p>
      <div class="pick">${(ui.devUsers||[]).map(u=>`<button data-act="devlogin" data-pid="${u.id}"><b>${esc(u.name)}${u.isAdmin?' <span class="chip">admin</span>':''}</b><span>${esc(u.login)}</span></button>`).join('')||'<p class="empty">Loading accounts…</p>'}</div>
    </div></div></div>`;
}

/* ---------- home / profile ---------- */
function ratingChart(p){
  const h=[{r:1500},...p.hist].slice(-41);
  if(h.length<2)return '<p class="empty">No rated games yet.</p>';
  const W=640,H=200,L=44,Rt=12,T=12,B=26,rs=h.map(x=>x.r);
  const lo=Math.floor((Math.min(...rs)-20)/50)*50,hi=Math.ceil((Math.max(...rs)+20)/50)*50;
  const X=i=>L+i*(W-L-Rt)/(h.length-1),Y=r=>T+(hi-r)*(H-T-B)/(hi-lo);
  const ticks=[];for(let v=lo;v<=hi;v+=(hi-lo)>200?100:50)ticks.push(v);
  const pts=h.map((x,i)=>`${X(i).toFixed(1)},${Y(x.r).toFixed(1)}`);
  return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating over the last ${h.length-1} games, now ${Math.round(p.r)}">
    ${ticks.map(v=>`<line x1="${L}" x2="${W-Rt}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L-8}" y="${Y(v)+4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="IBM Plex Mono, monospace">${v}</text>`).join('')}
    <polygon points="${L},${H-B} ${pts.join(' ')} ${X(h.length-1)},${H-B}" opacity=".12"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${X(h.length-1)}" cy="${Y(p.r)}" r="5" fill="var(--ball)" stroke="var(--surface)" stroke-width="2"/>
    <text x="${L}" y="${H-6}" font-size="11" fill="var(--muted)">${h.length-1} games ago</text><text x="${W-Rt}" y="${H-6}" font-size="11" fill="var(--muted)" text-anchor="end">now</text>
  </svg></div>`;
}
function matchRow(m,pid){
  const o=P(opp(m,pid)),won=m.w===pid,s=setsFor(m,pid),[a,b]=tally(s),t=m.tourn&&tById(m.tourn),d=m.delta?m.delta[pid]:0,pts=m.pts?m.pts[pid]:0;
  return `<div class="mrow"><div class="main"><span><span class="chip ${won?'win':'loss'}" style="margin-left:0">${won?'W':'L'} ${a}–${b}</span> vs <button class="link-btn" style="opacity:1" data-act="player" data-pid="${o.id}">${esc(o.name)}</button>${m.upset&&won?' <span class="chip warn">upset</span>':''}${m.matchup?` <span class="chip ch">${S.matchupRules?S.matchupRules.multiplier:3}× challenger</span>`:''}</span>
    <span class="sub"><span class="score">${fmtSets(s)}</span> · best of ${m.bo}${t?` · <button class="link-btn" data-act="topen" data-tid="${t.id}">${esc(t.name)}</button>`:''} · ${ago(m.t)}</span></div>
    <div class="right"><span class="score ${d>=0?'up':'down'}">${fmtD(d)}</span>${inSeason(m)?`<span class="pts">+${pts} pts${m.coalPts&&m.w===pid?` · <span class="coal-dot" style="--c:${esc(colorOf(m.coalition))}"></span>+${m.coalPts} ${esc(m.coalition)}`:''}</span>`:''}</div></div>`;
}
const coalOf=name=>(S.coalitions||[]).find(c=>c.name===name);
function profileTabs(p,count){
  return `<div class="ptabs" role="tablist" aria-label="Profile sections">
    <button role="tab" data-act="ptab" data-t="profile" aria-selected="${ui.ptab==='profile'}">Profile</button>
    <button role="tab" data-act="ptab" data-t="matches" aria-selected="${ui.ptab==='matches'}">Matches<span class="count">${count}</span></button></div>`;
}
function viewProfile(main,p,isMe){
  const me=P(S.me),ms=matchesOf(p.id),sm=ms.filter(inSeason),rk=rankOf(p.id);
  const hero=`<div class="hero">
      <div class="hero-id"><span class="eyebrow">${isMe?'Your profile':'Player'}</span><h2>${esc(p.name)}</h2>
        <div class="id-line"><span>${esc(p.login)}</span>${coalChip(p)}${prov(p)?'<span class="chip" title="Rating still settling: fewer than 5 games">provisional</span>':''}</div></div>
      <div class="rating-block"><span class="eyebrow">Rating</span><span class="rating-big">${Math.round(p.r)}<small>±${Math.round(p.rd)}</small></span></div>
    </div>`;
  main.innerHTML=`${isMe?challengerCard():''}<section class="panel">${hero}${profileTabs(p,sm.length)}<div id="ptab-body"></div></section>`;
  const body=main.querySelector('#ptab-body');
  body.innerHTML=ui.ptab==='matches'?matchesTab(p,isMe):profileTab(p,isMe,me,sm,rk);
}
function profileTab(p,isMe,me,sm,rk){
  const sw=sm.filter(m=>m.w===p.id).length,sDelta=p.r-ratingAtSeasonStart(p),c=coalOf(p.coalition);
  let nudges='';
  if(isMe){
    const next=S.tournaments.filter(t=>['open','live'].includes(t.status)&&myStatus(t)==='joined').sort((a,b)=>a.startsAt-b.startsAt)[0];
    const n=inboxCount(),items=[];
    if(n)items.push(`<button class="btn btn-sm" data-act="nav" data-view="inbox">${n} thing${n>1?'s':''} waiting in your inbox</button>`);
    if(next)items.push(`<button class="btn btn-sm" data-act="topen" data-tid="${next.id}">${next.status==='live'?'Playing now':'Next up'}: ${esc(next.name)}${next.status==='live'?'':', '+fmtDate(next.startsAt)}</button>`);
    nudges=items.length?`<div class="nudges">${items.join('')}</div>`:'';
  }
  return `<div class="stats">
      <div class="stat"><span class="k">Rank</span><span class="v">${rk?'#'+rk:'–'} <small>of ${ranked().length}</small></span></div>
      <div class="stat"><span class="k">Season record</span><span class="v">${sw}–${sm.length-sw}</span></div>
      <div class="stat"><span class="k">Season points</span><span class="v">${p.pts}</span></div>
      <div class="stat"><span class="k">This season</span><span class="v ${sDelta>=0?'up':'down'}">${fmtD(sDelta)}</span></div>
      <div class="stat"><span class="k">All time</span><span class="v">${p.w}–${p.l}</span></div>
      ${c?`<div class="stat"><span class="k">For ${esc(c.name)}</span><span class="v">${c.contributors[p.id]||0} <small>pts</small></span></div>`:''}
      ${!isMe?`<div class="stat"><span class="k">Your win chance</span><span class="v">${Math.round(winChance(me,p)*100)}%</span></div>`:''}
    </div>
    ${nudges}${isMe&&S.matchupRules?`<label class="check" for="mu-opt"><input id="mu-opt" type="checkbox" data-act-change="muopt" ${S.matchupsOptOut?'':'checked'}> Give me a weekly challenger</label>`:''}${!isMe?`<div class="actions"><button class="btn btn-new btn-sm" data-act="newmatch" data-pid="${p.id}" data-mode="challenge">Challenge ${esc(first(p))}</button><button class="btn btn-new btn-sm" data-act="newmatch" data-pid="${p.id}">Log a result vs ${esc(first(p))}</button></div>`:''}
    <h3>Rating history</h3>${ratingChart(p)}`;
}
function matchesTab(p,isMe){
  const all=matchesOf(p.id),list=ui.scope==='season'?all.filter(inSeason):all;
  const w=list.filter(m=>m.w===p.id).length,gained=list.reduce((s,m)=>s+(m.delta?m.delta[p.id]:0),0);
  const pts=list.reduce((s,m)=>s+(m.pts?m.pts[p.id]:0),0),cpts=list.reduce((s,m)=>s+(m.w===p.id?m.coalPts:0),0);
  const pend=isMe?incoming(p.id).length+outgoing(p.id).length:0;
  return `<div class="head-row"><p class="lede">${isMe?"Every rated game you've played":'Every rated game '+esc(first(p))+' has played'}, with the rating gained or lost in each.</p>
      <div class="seg" role="group" aria-label="Period"><button data-act="scope" data-scope="season" aria-pressed="${ui.scope==='season'}">${esc(S.season)}</button><button data-act="scope" data-scope="all" aria-pressed="${ui.scope==='all'}">All time</button></div></div>
    <div class="stats">
      <div class="stat"><span class="k">Played</span><span class="v">${list.length}</span></div>
      <div class="stat"><span class="k">Won–lost</span><span class="v">${w}–${list.length-w}</span></div>
      <div class="stat"><span class="k">Rating</span><span class="v ${gained>=0?'up':'down'}">${fmtD(gained)}</span></div>
      ${ui.scope==='season'?`<div class="stat"><span class="k">Match points</span><span class="v">${pts}</span></div>${p.coalition?`<div class="stat"><span class="k">For ${esc(p.coalition)}</span><span class="v">${cpts}</span></div>`:''}`:''}
    </div>
    <div class="actions">${isMe?`<button class="btn btn-new btn-sm" data-act="newmatch">Log a result</button><button class="btn btn-new btn-sm" data-act="newmatch" data-mode="challenge">Challenge someone</button>
      ${pend?`<button class="btn btn-sm" data-act="nav" data-view="inbox">${pend} unconfirmed</button>`:''}`:`<button class="btn btn-new btn-sm" data-act="newmatch" data-pid="${p.id}" data-mode="challenge">Challenge ${esc(first(p))}</button>`}</div>
    <div class="list">${list.map(m=>matchRow(m,p.id)).join('')||`<p class="empty">No matches ${ui.scope==='season'?'this season ':''}yet.</p>`}</div>`;
}

/* ---------- ladder and coalitions ---------- */
function viewLadder(main,me){
  const seg=`<div class="seg" role="group" aria-label="Show"><button data-act="lview" data-v="players" aria-pressed="${ui.lview==='players'}">Players</button><button data-act="lview" data-v="coalitions" aria-pressed="${ui.lview==='coalitions'}">Coalitions</button></div>`;
  if(ui.lview==='coalitions')return viewCoalitions(main,me,seg);
  const list=ranked();
  if(ui.sort==='points')list.sort((a,b)=>b.pts-a.pts||b.r-a.r);
  main.innerHTML=`<section class="panel">
    <div class="head-row"><div><h2>${esc(S.season)} ladder</h2><p class="lede">Rating measures skill (Glicko-2) and can go down. Season points reward playing and reset each season.</p></div>${seg}</div>
    <div class="head-row"><span class="lbl">Sort by</span><div class="seg" role="group" aria-label="Sort by"><button data-act="sort" data-sort="rating" aria-pressed="${ui.sort==='rating'}">Rating</button><button data-act="sort" data-sort="points" aria-pressed="${ui.sort==='points'}">Season points</button></div></div>
    ${list.length?`<div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Player</th><th class="r">Rating</th><th class="r">W–L</th><th>Last 5</th><th class="r">Points</th></tr></thead>
      <tbody>${list.map((p,i)=>{const f=matchesOf(p.id).slice(0,5).reverse();
        return `<tr class="${p.id===me.id?'me':''}"><td class="rank">${i+1}</td><td>${nameBtn(p)}</td>
        <td class="r num">${Math.round(p.r)}${prov(p)?'<span class="chip" title="Rating still settling: fewer than 5 games">prov.</span>':''}</td>
        <td class="r num">${p.w}–${p.l}</td>
        <td><span class="form" aria-label="Last five results">${f.map(m=>`<span class="dot ${m.w===p.id?'w':'l'}" title="${m.w===p.id?'Win':'Loss'} vs ${esc(P(opp(m,p.id)).name)}"></span>`).join('')}</span></td>
        <td class="r num">${p.pts}</td></tr>`}).join('')}</tbody></table></div>`:'<p class="empty">Nobody has played a rated match yet.</p>'}
  </section>`;
}
function viewCoalitions(main,me,seg){
  const cs=S.coalitions||[],max=Math.max(1,...cs.map(c=>c.points)),R=S.coalitionRules,cur=S.currentSeason;
  const top=c=>Object.entries(c.contributors).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([id,n])=>`<button class="link-btn" style="opacity:1" data-act="player" data-pid="${id}">${esc(first(P(id)))}</button> ${n}`).join(' · ');
  const daysLeft=cur.plannedEnd?Math.ceil((cur.plannedEnd-Date.now())/DAY):null;
  const ends=cur.plannedEnd?` · ends ${fmtDate(cur.plannedEnd)}${daysLeft>0?` (${daysLeft} day${daysLeft===1?'':'s'} left)`:''}`:'';
  const dateVal=t=>t?new Date(t-new Date(t).getTimezoneOffset()*6e4).toISOString().slice(0,10):'';
  const admin=S.isAdmin?`<details class="admin-box"><summary>Season settings (admin)</summary>
      <div class="form-grid" style="margin-top:12px">
        <div class="field"><label for="ss-name">Season name</label><input id="ss-name" type="text" maxlength="40" value="${esc(cur.name)}"></div>
        <div class="field"><label for="ss-end">Planned end</label><input id="ss-end" type="date" value="${dateVal(cur.plannedEnd)}"></div>
      </div>
      <div class="field" style="max-width:720px;margin-top:12px"><label for="ss-prize">Prize for the winning coalition</label><input id="ss-prize" type="text" maxlength="300" value="${esc(cur.prize)}" placeholder="e.g. New rubbers for the top three scorers"></div>
      <div class="actions" style="margin-top:12px"><button class="btn btn-sm" data-act="ssave">Save season</button></div>
      <h3 style="margin-top:20px">End this season</h3>
      <p class="note">Freezes the final standings and the winner, then starts the next season right away. Season points reset; ratings carry over. This can't be undone.</p>
      <div class="form-grid" style="margin-top:8px">
        <div class="field"><label for="sn-name">Next season</label><input id="sn-name" type="text" maxlength="40" placeholder="e.g. Winter 2027"></div>
        <div class="field"><label for="sn-end">Its planned end (optional)</label><input id="sn-end" type="date"></div>
      </div>
      <div class="field" style="max-width:720px;margin-top:12px"><label for="sn-prize">Its prize (optional)</label><input id="sn-prize" type="text" maxlength="300"></div>
      <div class="actions" style="margin-top:12px"><button class="btn btn-new btn-sm" data-act="send">End ${esc(cur.name)} and start the next season</button></div>
    </details>`:'';
  const hist=(S.seasons||[]).map(s=>{
    const r=s.results||{coalitions:[]},w=r.coalitions.find(c=>c.name===r.winner);
    return `<details class="season"><summary>
        <span class="season-name"><b>${esc(s.name)}</b><span class="sub">${fmtDate(s.startsAt)} – ${fmtDate(s.endsAt)}</span></span>
        <span class="season-win">${w?`<span class="coal" style="--c:${esc(colorOf(w.name))}"><i></i>${esc(w.name)}</span><span class="num">${w.points} pts</span>`:'<span class="sub">No winner</span>'}</span>
        ${r.mvp?`<span class="sub season-mvp">MVP ${esc(r.mvp.name)} · ${r.mvp.pts} pts for ${esc(r.mvp.coalition)}</span>`:''}
      </summary>
      <div class="season-body">
        ${s.prize?`<p class="sub">Prize: ${esc(s.prize)}</p>`:''}
        <div class="season-grid">${r.coalitions.map((c,i)=>`<div class="season-coal" style="--c:${esc(colorOf(c.name))}">
          <div class="race-name"><span class="rank" style="width:auto">${i+1}</span><b>${esc(c.name)}</b><span class="race-pts num">${c.points} pts</span></div>
          <span class="sub">${c.wins}–${c.losses} against other coalitions · ${c.members} players</span>
          <ol class="tops">${c.top.map(p=>`<li><button class="link-btn" style="opacity:1" data-act="player" data-pid="${p.id}">${esc(p.name)}</button><span class="num">${p.pts}</span></li>`).join('')||'<li class="sub">No points scored</li>'}</ol>
        </div>`).join('')}</div>
        ${r.topPlayers&&r.topPlayers.length?`<p class="sub">Most season points: ${r.topPlayers.map(p=>`${esc(p.name)} (${p.pts})`).join(', ')}</p>`:''}
      </div></details>`}).join('');
  main.innerHTML=`<section class="panel">
    <div class="head-row"><div><h2>Coalition race</h2><p class="lede"><b>${esc(cur.name)}</b> · started ${fmtDate(cur.startsAt)}${ends}. Win against another coalition and your coalition scores.</p></div>${seg}</div>
    ${cur.prize?`<div class="prize"><span class="eyebrow">Season prize</span><b>${esc(cur.prize)}</b></div>`:''}
    <div class="race">${cs.map((c,i)=>`<div class="race-row ${c.name===me.coalition?'mine':''}" style="--c:${esc(colorOf(c.name))}">
      <span class="rank">${i+1}</span>
      <div class="race-main"><div class="race-name"><b>${esc(c.name)}</b>${c.name===me.coalition?'<span class="chip">your coalition</span>':''}<span class="race-pts num">${c.points} pts</span></div>
        <div class="race-bar" role="img" aria-label="${esc(c.name)}: ${c.points} points"><i style="width:${(c.points/max*100).toFixed(1)}%"></i></div>
        <span class="sub">${c.wins}–${c.losses} against other coalitions · ${c.members} players${Object.keys(c.contributors).length?' · top scorers: '+top(c):''}</span></div>
    </div>`).join('')}</div>
    ${admin}
  </section>
  ${challengerBoard()}
  <section class="panel"><h3>Season history</h3>
    <div class="seasons">${hist||'<p class="empty">No finished seasons yet. When an admin ends this season, its winner shows up here.</p>'}</div></section>
  <section class="panel"><h3>Head to head this season</h3>
    <div class="tbl-wrap"><table class="h2h"><thead><tr><th></th>${cs.map(c=>`<th class="r"><span class="coal-dot" style="--c:${esc(colorOf(c.name))}"></span>vs ${esc(c.name)}</th>`).join('')}</tr></thead>
    <tbody>${cs.map(a=>`<tr><td><span class="coal-dot" style="--c:${esc(colorOf(a.name))}"></span><b>${esc(a.name)}</b></td>${cs.map(b=>a.name===b.name?'<td class="r muted">–</td>':`<td class="r num">${(a.vs[b.name]||{w:0}).w}–${(a.vs[b.name]||{l:0}).l}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="note">Wins–losses of each row's players against the column's players.</p></section>
  <section class="panel"><h3>How coalition points work</h3>
    <ul class="rules">
      <li>A win against a player from another coalition earns your coalition <b>${R.win}</b> points.</li>
      <li>Beat someone rated ${R.upsetMargin} or more higher and it's <b>${R.upset}</b> points. A true upset, against someone rated ${R.bigUpsetMargin} or more higher, earns <b>${R.bigUpset}</b>.</li>
      <li>Losing costs your coalition nothing, but the other coalition scores.</li>
      <li>Matches within your own coalition don't count.</li>
      <li>Your first ${R.fullPerPairPerWeek} matches against the same player each week score in full. After that, each win still earns <b>${R.afterCap}</b> point, so playing different people pays more.</li>
      <li>Tournaments: every player earns <b>+${R.tournamentPlayer}</b> for their coalition for taking part. On top of that, the champion's coalition gets <b>${R.champion}</b>, the runner-up's <b>${R.runnerUp}</b>, each semifinalist's <b>${R.semifinal}</b>.</li>
      <li>A challenger approaches: every week the app pairs everyone with an opponent. Those matches count <b>${S.matchupRules?S.matchupRules.multiplier:3}×</b> for season and coalition points.</li>
      <li>The coalition with the most points when the season ends wins it. Points reset each season.</li>
    </ul></section>`;
}

/* ---------- set entry ---------- */
function setEditor(host,bo,prefix,labA,labB,onChange){
  host.innerHTML=`<div class="set-head"><span>Set</span><span>${esc(labA)}</span><span>${esc(labB)}</span></div><div class="sets">${
    Array.from({length:bo},(_,i)=>`<div class="set-row"><span class="sn">Set ${i+1}</span>
    <input id="${prefix}-a${i}" type="number" inputmode="numeric" min="0" max="99" aria-label="Set ${i+1}, ${esc(labA)}">
    <input id="${prefix}-b${i}" type="number" inputmode="numeric" min="0" max="99" aria-label="Set ${i+1}, ${esc(labB)}"></div>`).join('')}</div>`;
  const need=Math.ceil(bo/2);
  function read(){
    const sets=[];let err='',wa=0,wb=0,done=false;
    for(let i=0;i<bo;i++){
      const ia=host.querySelector(`#${prefix}-a${i}`),ib=host.querySelector(`#${prefix}-b${i}`);
      ia.classList.remove('bad');ib.classList.remove('bad');
      const va=ia.value.trim(),vb=ib.value.trim();
      if(done){ia.disabled=ib.disabled=true;ia.value=ib.value='';continue}
      ia.disabled=ib.disabled=false;
      if(!va&&!vb)continue;
      if(!va||!vb){err=err||`Set ${i+1}: enter both scores.`;continue}
      const x=+va,y=+vb;
      if(!validSet(x,y)){ia.classList.add('bad');ib.classList.add('bad');err=err||`Set ${i+1}: ${x}–${y} isn't a valid set. Play to 11, win by 2.`;continue}
      sets.push([x,y]);x>y?wa++:wb++;
      if(wa===need||wb===need)done=true;
    }
    return{sets,err,wa,wb,decided:done&&!err};
  }
  host.addEventListener('input',()=>onChange(read()));
  return read;
}

/* ---------- new match: log a result or send a challenge ---------- */
const nm={mode:'log',opp:'',bo:5};
function openNewMatch(opts={}){
  Object.assign(nm,{mode:opts.mode||'log',opp:opts.opp||'',bo:opts.bo||nm.bo});
  renderNewMatch();
}
function renderNewMatch(){
  const me=P(S.me),root=document.getElementById('modal-root');
  const others=S.players.filter(p=>p.id!==me.id).sort((a,b)=>a.name.localeCompare(b.name));
  const accepted=S.challenges.filter(c=>c.status==='accepted');
  root.innerHTML=`<div class="overlay" data-act="mclose-bg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="nmh">
    <div class="head-row"><h3 id="nmh">New match</h3><button class="link-btn" data-act="mclose">Close</button></div>
    <div class="seg" role="group" aria-label="What do you want to do"><button data-act="nm-mode" data-mode="log" aria-pressed="${nm.mode==='log'}">Log a result</button><button data-act="nm-mode" data-mode="challenge" aria-pressed="${nm.mode==='challenge'}">Challenge</button></div>
    <div class="field"><label for="nm-opp">Opponent</label><select id="nm-opp"><option value="">Choose a player…</option>${others.map(p=>`<option value="${p.id}" ${String(nm.opp)===String(p.id)?'selected':''}>${esc(p.name)} (${esc(p.login)}) · ${Math.round(p.r)}${accepted.some(c=>c.from===p.id||c.to===p.id)?' · challenge accepted':''}${isChallenger(p.id)?' · your challenger, '+S.matchupRules.multiplier+'× points':''}</option>`).join('')}</select></div>
    <div class="field"><span class="lbl">Format</span><div class="seg" role="group" aria-label="Format">${[3,5,7].map(b=>`<button data-act="nm-bo" data-bo="${b}" aria-pressed="${nm.bo===b}">Best of ${b}</button>`).join('')}</div></div>
    ${nm.bo===7?BO7_NOTE:''}
    <div id="nm-pred"></div>
    ${nm.mode==='log'?`<div id="nm-sets"></div><p class="note">Your opponent confirms the result before ratings change. If they don't respond, it confirms itself after ${S.autoConfirmHours} hours.</p>`:
      `<div class="field" style="max-width:none"><label for="nm-msg">Message (optional)</label><input id="nm-msg" type="text" maxlength="140" placeholder="e.g. Lunch tomorrow at 12:30?"></div>`}
    <div id="nm-status" class="status" aria-live="polite"></div>
    <div class="actions"><button id="nm-send" class="btn btn-new" disabled>${nm.mode==='log'?'Send for confirmation':'Send challenge'}</button></div>
  </div></div>`;
  const sel=root.querySelector('#nm-opp'),pred=root.querySelector('#nm-pred'),st=root.querySelector('#nm-status'),send=root.querySelector('#nm-send');
  let state={sets:[],decided:false,err:''};
  function upd(){
    const o=nm.opp&&P(nm.opp);
    if(o){const c=winChance(me,o),w=glicko(me,o,1).r-me.r,l=glicko(me,o,0).r-me.r;
      pred.innerHTML=`<div class="pred"><span>Win chance <b>${Math.round(c*100)}%</b></span><span>If you win <b class="up">${fmtD(w)}</b></span><span>If you lose <b class="down">${fmtD(l)}</b></span></div>`}
    else pred.innerHTML='';
    if(nm.mode==='challenge'){send.disabled=!o;st.textContent='';return}
    if(state.err){st.className='status err';st.textContent=state.err}
    else if(state.decided){st.className='status ok';st.textContent=state.wa>state.wb?`You win ${state.wa}–${state.wb}.`:`${o?first(o):'They'} win ${state.wb}–${state.wa}.`}
    else{st.className='status';st.textContent=state.sets.length?`Score so far ${state.wa}–${state.wb}.`:''}
    send.disabled=!(o&&state.decided);
  }
  if(nm.mode==='log'){const read=setEditor(root.querySelector('#nm-sets'),nm.bo,'nm','You','Opponent',s=>{state=s;upd()});state=read()}
  sel.addEventListener('change',()=>{nm.opp=sel.value;upd()});
  send.addEventListener('click',()=>act(async()=>{
    const o=P(nm.opp);if(!o)return;
    if(nm.mode==='log'&&!state.decided)return;
    send.disabled=true;
    try{
      if(nm.mode==='log'){const r=await api('/api/matches',{opponentId:o.id,bestOf:nm.bo,sets:state.sets});toast(r.challenger?`Challenger match sent to ${o.name}. ${S.matchupRules.multiplier}× points once confirmed.`:`Sent to ${o.name} for confirmation.`)}
      else{await api('/api/challenges',{opponentId:o.id,bestOf:nm.bo,message:root.querySelector('#nm-msg').value});toast(`Challenge sent to ${o.name}.`)}
    }finally{send.disabled=false}
    closeModal();nm.opp='';await refresh();
  }));
  upd();
  (nm.opp?root.querySelector(nm.mode==='log'?'#nm-a0':'#nm-msg'):sel).focus();
}

/* ---------- inbox ---------- */
function viewInbox(main,me){
  const inc=incoming(me.id).sort((a,b)=>b.t-a.t),out=outgoing(me.id).sort((a,b)=>b.t-a.t);
  const disp=S.matches.filter(m=>m.status==='disputed').sort((a,b)=>b.t-a.t);
  const left=m=>`confirms itself in ${Math.max(0,Math.ceil((m.created+S.autoConfirmHours*36e5-Date.now())/36e5))}h`;
  const line=(body,actions)=>`<div class="item"><div class="main">${body}</div>${actions?`<div class="actions">${actions}</div>`:''}</div>`;
  const section=(title,lede,items,empty)=>items.length||empty?`<section class="panel"><div><h3>${title}</h3>${lede?`<p class="lede">${lede}</p>`:''}</div><div class="list">${items.join('')||`<p class="empty">${empty}</p>`}</div></section>`:'';
  const ch=S.challenges,quote=c=>c.message?'“'+esc(c.message)+'” · ':'';
  main.innerHTML=[
    section('Needs your confirmation',"Check the score. Confirming updates both ratings. If it's wrong, dispute it and log it again together.",
      inc.map(m=>{const o=P(m.a),mine=setsFor(m,me.id),[a,b]=tally(mine),won=m.w===me.id;
        return line(`<span><b>${esc(o.name)}</b> logged a ${won?'win for you':'loss for you'} <span class="chip ${won?'win':'loss'}">${a}–${b}</span></span><span class="sub"><span class="score">${fmtSets(mine)}</span> · best of ${m.bo} · ${ago(m.created)} · ${left(m)}</span>`,
        `<button class="btn btn-good btn-sm" data-act="confirm" data-mid="${m.id}">Confirm</button><button class="btn btn-sm" data-act="dispute" data-mid="${m.id}">Dispute</button>`)}),'Nothing to confirm.'),
    section('A challenger approaches',`Play these this week for ${S.matchupRules?S.matchupRules.multiplier:3}× season and coalition points.`,
      openMatchups().map(m=>{const o=muOpp(m);return line(`<span>You vs <b>${esc(o.name)}</b> ${coalChip(o)}${m.kind==='bonus'?' <span class="chip warn">bonus round</span>':''}</span><span class="sub">${Math.round(o.r)} rating · play before ${fmtDate(m.expiresAt)}</span>`,
        `<button class="btn btn-new btn-sm" data-act="newmatch" data-pid="${o.id}">Log result</button><button class="btn btn-sm" data-act="player" data-pid="${o.id}">Profile</button>`)})),
    section('Approve tournaments','New tournaments only show up for everyone after an admin approves them.',
      approvals().map(t=>line(`<span><b>${esc(t.name)}</b> ${stChip(t)}</span><span class="sub">${fmtDate(t.startsAt)} ${fmtTime(t.startsAt)} · planned by ${esc(P(t.createdBy).name)}</span>`,
        `<button class="btn btn-good btn-sm" data-act="tapprove" data-tid="${t.id}">Approve</button><button class="btn btn-sm" data-act="treject" data-tid="${t.id}">Reject</button><button class="btn btn-sm" data-act="topen" data-tid="${t.id}">View</button>`))),
    section('Challenges','',[
      ...ch.filter(c=>c.to===me.id&&c.status==='open').map(c=>line(`<span><b>${esc(P(c.from).name)}</b> challenges you to a best of ${c.bo}</span><span class="sub">${quote(c)}${ago(c.created)}</span>`,
        `<button class="btn btn-good btn-sm" data-act="caccept" data-cid="${c.id}">Accept</button><button class="btn btn-sm" data-act="cdecline" data-cid="${c.id}">Decline</button>`)),
      ...ch.filter(c=>c.status==='accepted').map(c=>{const o=P(c.from===me.id?c.to:c.from);return line(`<span>Best of ${c.bo} with <b>${esc(o.name)}</b> <span class="chip win">accepted</span></span><span class="sub">${quote(c)}play it, then log the result</span>`,
        `<button class="btn btn-new btn-sm" data-act="newmatch" data-pid="${o.id}" data-bo="${c.bo}">Log result</button><button class="btn btn-sm" data-act="${c.from===me.id?'ccancel':'cdecline'}" data-cid="${c.id}">Call it off</button>`)}),
      ...ch.filter(c=>c.from===me.id&&c.status==='open').map(c=>line(`<span>You challenged <b>${esc(P(c.to).name)}</b> to a best of ${c.bo}</span><span class="sub">waiting for an answer · ${ago(c.created)}</span>`,
        `${S.authMode==='dev'?`<button class="btn btn-sm" data-act="devlogin" data-pid="${c.to}" data-then="inbox">Sign in as ${esc(P(c.to).login)}</button>`:''}<button class="btn btn-sm" data-act="ccancel" data-cid="${c.id}">Withdraw</button>`))]),
    section('Tournament invites','',myInvites().map(t=>line(`<span><b>${esc(t.name)}</b></span><span class="sub">${fmtDate(t.startsAt)} ${fmtTime(t.startsAt)} · invited by ${esc(P(t.createdBy).name)}</span>`,
      `<button class="btn btn-good btn-sm" data-act="tjoin" data-tid="${t.id}">Join</button><button class="btn btn-sm" data-act="tleave" data-tid="${t.id}">Decline</button><button class="btn btn-sm" data-act="topen" data-tid="${t.id}">View</button>`))),
    section('Waiting on your opponent','',out.map(m=>{const o=P(m.b),[a,b]=tally(m.sets);
      return line(`<span>vs <b>${esc(o.name)}</b> <span class="chip ${m.w===me.id?'win':'loss'}">${a}–${b}</span></span><span class="sub"><span class="score">${fmtSets(m.sets)}</span> · sent ${ago(m.created)} · ${left(m)}</span>`,
      `${S.authMode==='dev'?`<button class="btn btn-sm" data-act="devlogin" data-pid="${o.id}" data-then="inbox">Sign in as ${esc(o.login)}</button>`:''}<button class="btn btn-sm" data-act="withdraw" data-mid="${m.id}">Withdraw</button>`)})),
    section('Disputed','',disp.map(m=>{const o=P(opp(m,me.id)),mine=setsFor(m,me.id);
      return line(`<span>vs <b>${esc(o.name)}</b> <span class="chip warn">Disputed</span></span><span class="sub"><span class="score">${fmtSets(mine)}</span> · no rating change</span>`)}))
  ].join('');
}

/* ---------- tournaments ---------- */
function upcoming(){const order={live:0,open:1,proposed:2,rejected:3};return S.tournaments.filter(t=>t.status in order).sort((a,b)=>order[a.status]-order[b.status]||a.startsAt-b.startsAt)}
function recent(){return S.tournaments.filter(t=>t.status==='done').sort((a,b)=>b.startsAt-a.startsAt)}
function tRow(t){
  const d=new Date(t.startsAt),n=joinedIds(t).length,my=myStatus(t);
  const right=t.status==='done'?`<span class="sub">Won by ${esc(first(P(t.champion)))}</span>`:my==='joined'?'<span class="chip win">Joined</span>':my==='invited'?'<span class="chip warn">Invited</span>':'';
  return `<button class="trow" data-act="topen" data-tid="${t.id}"><span class="datebox"><b>${d.getDate()}</b><span>${d.toLocaleDateString('en-GB',{month:'short'})}</span></span>
    <span style="min-width:0"><span class="tname">${esc(t.name)}</span><span class="sub">${t.status!=='done'?stChip(t)+' ':''}${fmtTime(t.startsAt)} · ${n}${t.maxPlayers?'/'+t.maxPlayers:''} players</span></span>${right}</button>`;
}
function viewTourn(main,me){
  if(ui.tplan)return viewPlan(main,me);
  if(ui.tid&&tById(ui.tid))return viewTDetail(main,me,tById(ui.tid));
  const head=`<div class="head-row"><div><h2>Tournaments</h2><p class="lede">Anyone can plan one.${S.requireApproval?' New tournaments show up after an admin approves them.':''}</p></div>
    <div class="actions"><div class="seg" role="group" aria-label="View"><button data-act="tview" data-v="overview" aria-pressed="${ui.tview==='overview'}">Overview</button><button data-act="tview" data-v="calendar" aria-pressed="${ui.tview==='calendar'}">Calendar</button></div>
    <button class="btn btn-new btn-sm" data-act="tplan">Plan a tournament</button></div></div>`;
  if(ui.tview==='calendar'){main.innerHTML=`<section class="panel">${head}${calendar()}</section>`;return}
  const up=upcoming().slice(0,5),rc=recent().slice(0,5);
  main.innerHTML=`<section class="panel">${head}
    <div class="two"><div class="panel" style="background:var(--sunk)"><h3>Coming up</h3><div class="list">${up.map(tRow).join('')||'<p class="empty">Nothing planned yet. <button class="link-btn" data-act="tplan">Plan the first one</button></p>'}</div></div>
    <div class="panel" style="background:var(--sunk)"><h3>Recent</h3><div class="list">${rc.map(tRow).join('')||'<p class="empty">No finished tournaments yet.</p>'}</div></div></div></section>`;
}
function calendar(){
  const now=new Date(),m=ui.month||new Date(now.getFullYear(),now.getMonth(),1);
  const startOffset=(m.getDay()+6)%7,start=new Date(m.getFullYear(),m.getMonth(),1-startOffset);
  const last=new Date(m.getFullYear(),m.getMonth()+1,0),endOffset=6-((last.getDay()+6)%7);
  const days=startOffset+last.getDate()+endOffset,cells=[];
  const key=d=>d.getFullYear()+'-'+d.getMonth()+'-'+d.getDate();
  const byDay={};S.tournaments.filter(t=>t.status!=='rejected').forEach(t=>{const k=key(new Date(t.startsAt));(byDay[k]=byDay[k]||[]).push(t)});
  for(let i=0;i<days;i++){
    const d=new Date(start.getFullYear(),start.getMonth(),start.getDate()+i);
    const evs=(byDay[key(d)]||[]).sort((a,b)=>a.startsAt-b.startsAt);
    cells.push(`<div class="day ${d.getMonth()!==m.getMonth()?'out':''} ${key(d)===key(now)?'today':''}"><span class="dn">${d.getDate()}</span>${evs.map(t=>`<button class="ev ${t.status}" data-act="topen" data-tid="${t.id}" title="${esc(t.name)}, ${fmtTime(t.startsAt)}">${fmtTime(t.startsAt)} ${esc(t.name)}</button>`).join('')}</div>`);
  }
  return `<div class="cal-head"><button class="btn btn-sm" data-act="month" data-d="-1" aria-label="Previous month">←</button><h3>${m.toLocaleDateString('en-GB',{month:'long',year:'numeric'})}</h3><button class="btn btn-sm" data-act="month" data-d="1" aria-label="Next month">→</button></div>
    <div class="cal-wrap"><div class="cal">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>`<div class="dow">${d}</div>`).join('')}${cells.join('')}</div></div>
    <div class="legend"><span><i style="background:var(--table)"></i>Open</span><span><i style="background:var(--ball)"></i>Live</span><span><i style="background:var(--warn-bg);border:1px solid var(--warn)"></i>Awaiting approval</span><span><i style="background:var(--line)"></i>Finished</span></div>`;
}
function stageSelects(prefix,stages){
  return `<div class="stage-grid">${STAGES.map(s=>`<div class="field"><label for="${prefix}-${s}">${STAGE_NAMES[s]}</label><select id="${prefix}-${s}">${[3,5,7].map(b=>`<option value="${b}" ${stages[s]===b?'selected':''}>Best of ${b}</option>`).join('')}</select></div>`).join('')}</div>`;
}
const readStages=prefix=>Object.fromEntries(STAGES.map(s=>[s,Number(document.getElementById(`${prefix}-${s}`).value)]));
const fmtStages=st=>STAGES.map(s=>`${STAGE_NAMES[s]}: best of ${st[s]}`).join(' · ');
const hasBo7=prefix=>STAGES.some(s=>document.getElementById(`${prefix}-${s}`).value==='7');

function viewTDetail(main,me,t){
  const org=P(t.createdBy),joined=joinedIds(t),invited=t.players.filter(p=>p.status==='invited').map(p=>p.id),my=myStatus(t),n=t.rounds.length;
  const full=t.maxPlayers&&joined.length>=t.maxPlayers,acts=[];
  if(t.status==='proposed'&&S.isAdmin)acts.push(`<button class="btn btn-good btn-sm" data-act="tapprove" data-tid="${t.id}">Approve</button><button class="btn btn-sm" data-act="treject" data-tid="${t.id}">Reject</button>`);
  if(t.status==='open'||t.status==='proposed'){
    if(my==='joined')acts.push(`<button class="btn btn-sm" data-act="tleave" data-tid="${t.id}">Leave</button>`);
    else if(t.status==='open'&&my==='invited')acts.push(`<button class="btn btn-good btn-sm" data-act="tjoin" data-tid="${t.id}">Accept invite</button><button class="btn btn-sm" data-act="tleave" data-tid="${t.id}">Decline</button>`);
    else if(t.status==='open'&&(t.signupOpen||my==='declined')&&!full)acts.push(`<button class="btn btn-primary btn-sm" data-act="tjoin" data-tid="${t.id}">Sign up</button>`);
  }
  if(t.status==='open'&&isOrg(t))acts.push(`<button class="btn btn-primary btn-sm" data-act="tstart" data-tid="${t.id}" ${joined.length<3?'disabled title="Needs at least 3 players"':''}>Start bracket</button>`);
  if(['proposed','open','live'].includes(t.status)&&isOrg(t))acts.push(`<button class="btn btn-sm" data-act="tcancel" data-tid="${t.id}">Cancel tournament</button>`);
  const note=t.status==='proposed'?`<div class="notice"><b>Waiting for approval.</b> ${S.isAdmin?'Approve it to put it on the calendar for everyone.':'An admin needs to approve this before others can see it. You can already invite players.'}</div>`:
    t.status==='rejected'?'<div class="notice"><b>Not approved.</b> Talk to an admin, or plan a new one with different details.</div>':
    t.status==='open'&&full&&my!=='joined'?'<div class="notice"><b>Full.</b> Ask the organiser if a spot opens up.</div>':'';
  let format='';
  if(['proposed','open'].includes(t.status)){
    format=isOrg(t)?`<div class="field" style="max-width:none"><span class="lbl">Format per stage</span>${stageSelects('tf',t.stages)}</div><div id="tf-bo7"></div><div class="actions"><button class="btn btn-sm" data-act="tformat" data-tid="${t.id}">Save format</button></div>`
      :`<p class="meta"><span>${fmtStages(t.stages)}</span></p>`;
  }else if(t.status==='live'&&isOrg(t)){
    format=`<div class="field" style="max-width:none"><span class="lbl">Format per round</span><div class="rounds-fmt">${t.rounds.map((rd,r)=>{const locked=rd.some(m=>m.w&&!m.bye);
      return `<label class="rf" for="rf-${r}">${roundName(n,r)}<select id="rf-${r}" data-act-change="tround" data-tid="${t.id}" data-r="${r}" ${locked?'disabled title="This round already has results"':''}>${[3,5,7].map(b=>`<option value="${b}" ${t.roundBestOf[r]===b?'selected':''}>Bo${b}</option>`).join('')}</select></label>`}).join('')}</div>
      <p class="note">Rounds that already have results keep their format.</p></div>`;
  }
  let bracket='';
  if(t.status==='live'||t.status==='done'){
    const seedNo=id=>t.seeds.indexOf(id)+1;
    bracket=`${t.status==='done'?`<div class="pred"><span>Champion <b>${esc(P(t.champion).name)}</b></span>${t.awards.map(a=>`<span>${esc(first(P(a.id)))} <b class="up">+${a.n}</b> pts (${a.why})</span>`).join('')}</div>`:''}
      <div class="bracket">${t.rounds.map((rd,r)=>`<div class="round"><h3>${roundName(n,r)}<span class="bo">Bo${t.roundBestOf[r]}</span></h3>${rd.map((m,k)=>{
        const slot=(id,i)=>{if(!id)return `<div class="slot lost"><span><span class="sd"></span>${m.bye&&i===1?'Bye':'TBD'}</span></div>`;
          const cls=m.w?(m.w===id?'won':'lost'):'';const ss=m.sets?m.sets.filter(s=>i===0?s[0]>s[1]:s[1]>s[0]).length:'';
          return `<div class="slot ${cls}"><span><span class="sd">${seedNo(id)}</span>${esc(P(id).name)}</span><span class="num">${m.bye?'':ss}</span></div>`};
        const ready=t.status==='live'&&m.a&&m.b&&!m.w,can=isOrg(t)||[m.a,m.b].includes(S.me);
        return `<div class="bm">${slot(m.a,0)}${slot(m.b,1)}${ready?`<div class="foot"><span>Ready to play</span>${can?`<button class="btn btn-sm" data-act="report" data-tid="${t.id}" data-r="${r}" data-k="${k}">Enter result</button>`:''}</div>`:m.sets?`<div class="foot"><span class="score">${fmtSets(m.sets)}</span></div>`:''}</div>`}).join('')}</div>`).join('')}</div>`;
  }
  const people=ids=>ids.map(id=>`<button class="person ${invited.includes(id)?'inv':''}" data-act="player" data-pid="${id}">${P(id).coalition?coalDot(P(id)):''}${esc(P(id).name)}</button>`).join('');
  const candidates=S.players.filter(p=>!joined.includes(p.id)&&!invited.includes(p.id)).sort((a,b)=>a.name.localeCompare(b.name));
  main.innerHTML=`<section class="panel">
    <button class="link-btn back" data-act="tback">← All tournaments</button>
    <div class="head-row"><h2>${esc(t.name)}</h2>${stChip(t)}</div>
    <div class="meta"><span><b>${fmtDate(t.startsAt)}</b> at <b>${fmtTime(t.startsAt)}</b></span>${t.location?`<span>${esc(t.location)}</span>`:''}<span>Organised by <b>${esc(org.name)}</b></span>
      <span>${joined.length}${t.maxPlayers?' of '+t.maxPlayers:''} player${(t.maxPlayers||joined.length)===1?'':'s'}</span><span>${t.signupOpen?'Anyone can sign up':'Invite only'}</span></div>
    ${t.description?`<p class="lede">${esc(t.description)}</p>`:''}
    ${note}${acts.length?`<div class="actions">${acts.join('')}</div>`:''}
    ${format}${bracket}
  </section>
  ${t.status!=='live'&&t.status!=='done'?`<section class="panel"><h3>Players</h3>
    <div class="people">${people(joined)||'<p class="empty">Nobody has signed up yet.</p>'}</div>
    ${invited.length?`<span class="lbl">Invited, no answer yet</span><div class="people">${people(invited)}</div>`:''}
    ${isOrg(t)&&['proposed','open'].includes(t.status)&&candidates.length?`<details><summary>Invite players</summary><div class="checks" style="margin-top:10px">${candidates.map(p=>`<label><input type="checkbox" class="inv-chk" value="${p.id}" id="inv-${p.id}">${esc(p.name)}<span>${Math.round(p.r)}</span></label>`).join('')}</div>
      <div class="actions" style="margin-top:10px"><button class="btn btn-sm" data-act="tinvite" data-tid="${t.id}">Send invites</button></div></details>`:''}</section>`:''}`;
  if(document.getElementById('tf-bo7'))watchBo7('tf');
}
function watchBo7(prefix){
  const box=document.getElementById(`${prefix}-bo7`),upd=()=>{box.innerHTML=hasBo7(prefix)?BO7_NOTE:''};
  STAGES.forEach(s=>document.getElementById(`${prefix}-${s}`).addEventListener('change',()=>{
    if(prefix==='tp')document.querySelectorAll('.tpl button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.tpl==='custom'));
    upd()}));
  upd();
}

function viewPlan(main,me){
  const d=new Date(Date.now()+2*DAY);d.setHours(18,0,0,0);
  const local=new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,16);
  const tpl=TEMPLATES[1],needsApproval=S.requireApproval&&!S.isAdmin;
  main.innerHTML=`<section class="panel">
    <button class="link-btn back" data-act="tback">← All tournaments</button>
    <div><h2>Plan a tournament</h2><p class="lede">${needsApproval?'An admin approves new tournaments before they appear on the calendar. You can already invite players.':'It goes on the calendar right away.'}</p></div>
    <div class="form-grid">
      <div class="field"><label for="tp-name">Name</label><input id="tp-name" type="text" maxlength="60" placeholder="e.g. Lunch Break Cup"></div>
      <div class="field"><label for="tp-when">Date and time</label><input id="tp-when" type="datetime-local" value="${local}"></div>
      <div class="field"><label for="tp-loc">Location</label><input id="tp-loc" type="text" maxlength="60" value="Campus table"></div>
      <div class="field"><label for="tp-max">Max players (optional)</label><input id="tp-max" class="plain" type="number" min="3" max="64" placeholder="No limit"></div>
    </div>
    <div class="field" style="max-width:720px"><label for="tp-desc">Description (optional)</label><textarea id="tp-desc" maxlength="500" placeholder="What makes this one special?"></textarea></div>
    <div class="field" style="max-width:none"><span class="lbl">Format</span>
      <div class="tpl" role="group" aria-label="Format templates">${TEMPLATES.map(x=>`<button data-act="tpl" data-tpl="${x.id}" aria-pressed="${x.id===tpl.id}"><b>${x.name}</b><span>${x.desc}</span></button>`).join('')}<button data-act="tpl" data-tpl="custom" aria-pressed="false"><b>Custom</b><span>Pick each stage below</span></button></div>
    </div>
    ${stageSelects('tp',tpl.stages)}
    <p class="note">Rounds are matched to stages by how far they are from the final. You can still change the format later, round by round, until a round has results.</p>
    <div id="tp-bo7"></div>
    <div class="field" style="max-width:none"><span class="lbl">Who can join</span>
      <label class="check" for="tp-open"><input id="tp-open" type="checkbox" checked> Anyone can sign up</label>
      <label class="check" for="tp-play"><input id="tp-play" type="checkbox" checked> I'm playing too</label></div>
    <details><summary>Invite players (optional)</summary><div class="checks" style="margin-top:10px">${S.players.filter(p=>p.id!==me.id).sort((a,b)=>a.name.localeCompare(b.name)).map(p=>`<label><input type="checkbox" class="tp-inv" value="${p.id}" id="tpi-${p.id}">${esc(p.name)}<span>${Math.round(p.r)}</span></label>`).join('')}</div></details>
    <div class="actions"><button class="btn btn-new" data-act="tcreate">${needsApproval?'Send for approval':'Publish'}</button><button class="btn" data-act="tback">Cancel</button></div>
  </section>`;
  watchBo7('tp');
}

function openReport(tid,r,k){
  const t=tById(tid),m=t.rounds[r][k],A=P(m.a),B=P(m.b),bo=t.roundBestOf[r];
  const root=document.getElementById('modal-root');
  root.innerHTML=`<div class="overlay" data-act="mclose-bg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="mh">
    <h3 id="mh">${esc(roundName(t.rounds.length,r))}: ${esc(A.name)} vs ${esc(B.name)}</h3><p class="note">Best of ${bo}</p>
    <div id="msets"></div><div id="mst" class="status" aria-live="polite"></div>
    <div class="actions"><button class="btn btn-primary" id="msave" disabled>Save result</button><button class="btn" data-act="mclose">Cancel</button></div></div></div>`;
  let st={};const mst=root.querySelector('#mst'),ms=root.querySelector('#msave');
  setEditor(root.querySelector('#msets'),bo,'tm',first(A),first(B),s=>{st=s;
    mst.className='status '+(s.err?'err':s.decided?'ok':'');
    mst.textContent=s.err||(s.decided?`${(s.wa>s.wb?A:B).name} wins ${Math.max(s.wa,s.wb)}–${Math.min(s.wa,s.wb)}.`:'');
    ms.disabled=!s.decided});
  ms.addEventListener('click',()=>act(async()=>{
    if(!st.decided)return;ms.disabled=true;
    let res;try{res=await api(`/api/tournaments/${t.id}/results`,{round:r,slot:k,sets:st.sets})}catch(e){ms.disabled=false;throw e}
    closeModal();await refresh();
    toast(res.finished?`${P(res.winner).name} wins ${t.name}!`:'Result saved. Ratings updated.');
  }));
  root.querySelector('#tm-a0').focus();
}

async function loadDevUsers(){if(CFG.authMode!=='dev')return;try{ui.devUsers=await api('/api/dev-users')}catch(e){ui.loginMsg=e.message}render()}
function closeModal(){document.getElementById('modal-root').innerHTML=''}

/* ---------- events ---------- */
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-act]');if(!el)return;
  const a=el.dataset.act,tid=Number(el.dataset.tid);
  if(a==='mclose-bg'&&e.target!==el)return;
  const go=view=>{ui.view=view;closeModal();render();window.scrollTo(0,0)};
  switch(a){
    case 'devlogin':act(async()=>{await api('/auth/dev-login',{userId:Number(el.dataset.pid)});ui.view=el.dataset.then||'home';ui.pid=null;await refresh();if(el.dataset.then)toast(`Signed in as ${P(S.me).login}.`)});break;
    case 'signout':act(async()=>{await api('/auth/logout',{});S=null;render();loadDevUsers()});break;
    case 'nav':if(el.dataset.view==='tourn'){ui.tid=null;ui.tplan=false}go(el.dataset.view);break;
    case 'player':ui.pid=Number(el.dataset.pid);ui.ptab='profile';go(ui.pid===S.me?'home':'player');break;
    case 'ptab':ui.ptab=el.dataset.t;render();break;
    case 'lview':ui.lview=el.dataset.v;render();break;
    case 'ssave':act(async()=>{const v=id=>document.getElementById(id).value.trim(),end=v('ss-end');
      await api('/api/seasons/current',{name:v('ss-name'),prize:v('ss-prize'),plannedEnd:end?new Date(end+'T23:59').getTime():null});await refresh();toast('Season saved.')});break;
    case 'send':if(el.dataset.sure){act(async()=>{const v=id=>document.getElementById(id).value.trim(),end=v('sn-end');
        const r=await api('/api/seasons/end',{nextName:v('sn-name'),nextPrize:v('sn-prize'),nextPlannedEnd:end?new Date(end+'T23:59').getTime():null});
        await refresh();toast(r.winner?`Season over. ${r.winner} wins!`:'Season over. No coalition scored.')})}
      else{if(!document.getElementById('sn-name').value.trim()){toast('Name the next season first.');break}
        el.dataset.sure='1';const t=el.textContent;el.textContent='Click again to end the season';setTimeout(()=>{if(el.isConnected){delete el.dataset.sure;el.textContent=t}},4000)}break;
    case 'newmatch':openNewMatch({opp:el.dataset.pid||'',mode:el.dataset.mode||'log',bo:el.dataset.bo?Number(el.dataset.bo):undefined});break;
    case 'nm-mode':nm.mode=el.dataset.mode;nm.opp=document.getElementById('nm-opp').value;renderNewMatch();break;
    case 'nm-bo':nm.bo=Number(el.dataset.bo);nm.opp=document.getElementById('nm-opp').value;renderNewMatch();break;
    case 'sort':ui.sort=el.dataset.sort;render();break;
    case 'scope':ui.scope=el.dataset.scope;render();break;
    case 'confirm':act(async()=>{const r=await api(`/api/matches/${el.dataset.mid}/confirm`,{});await refresh();toast(`Confirmed. Your rating ${fmtD(r.delta||0)}, +${r.pts||0} season points.`)});break;
    case 'dispute':act(async()=>{await api(`/api/matches/${el.dataset.mid}/dispute`,{});await refresh();toast('Marked as disputed. No ratings changed.')});break;
    case 'withdraw':act(async()=>{await api(`/api/matches/${el.dataset.mid}/withdraw`,{});await refresh();toast('Result withdrawn.')});break;
    case 'caccept':act(async()=>{await api(`/api/challenges/${el.dataset.cid}/accept`,{});await refresh();toast('Challenge accepted. Log the result after you play.')});break;
    case 'cdecline':act(async()=>{await api(`/api/challenges/${el.dataset.cid}/decline`,{});await refresh();toast('Challenge declined.')});break;
    case 'ccancel':act(async()=>{await api(`/api/challenges/${el.dataset.cid}/cancel`,{});await refresh();toast('Challenge withdrawn.')});break;
    case 'topen':ui.tid=tid;ui.tplan=false;go('tourn');break;
    case 'tback':ui.tid=null;ui.tplan=false;render();window.scrollTo(0,0);break;
    case 'tview':ui.tview=el.dataset.v;render();break;
    case 'month':{const now=new Date(),m=ui.month||new Date(now.getFullYear(),now.getMonth(),1);ui.month=new Date(m.getFullYear(),m.getMonth()+Number(el.dataset.d),1);render();break}
    case 'tplan':ui.tplan=true;ui.tid=null;render();window.scrollTo(0,0);break;
    case 'tpl':{const x=TEMPLATES.find(t=>t.id===el.dataset.tpl);document.querySelectorAll('.tpl button').forEach(b=>b.setAttribute('aria-pressed',b===el));
      if(x)STAGES.forEach(s=>{document.getElementById(`tp-${s}`).value=x.stages[s]});
      document.getElementById('tp-bo7').innerHTML=hasBo7('tp')?BO7_NOTE:'';break}
    case 'tcreate':act(async()=>{
      const v=id=>document.getElementById(id).value.trim(),when=new Date(v('tp-when')).getTime();
      if(!v('tp-name'))throw new Error('Give the tournament a name.');
      if(!when)throw new Error('Pick a date and time.');
      const r=await api('/api/tournaments',{name:v('tp-name'),startsAt:when,location:v('tp-loc'),description:v('tp-desc'),maxPlayers:v('tp-max')?Number(v('tp-max')):null,
        stages:readStages('tp'),signupOpen:document.getElementById('tp-open').checked,playing:document.getElementById('tp-play').checked,
        inviteIds:[...document.querySelectorAll('.tp-inv:checked')].map(x=>Number(x.value))});
      ui.tplan=false;ui.tid=r.id;await refresh();window.scrollTo(0,0);toast(r.status==='proposed'?'Sent to an admin for approval.':'Tournament published.')});break;
    case 'tapprove':act(async()=>{await api(`/api/tournaments/${tid}/approve`,{});await refresh();toast('Approved. It is on the calendar now.')});break;
    case 'treject':act(async()=>{await api(`/api/tournaments/${tid}/reject`,{});await refresh();toast('Tournament not approved.')});break;
    case 'tjoin':act(async()=>{await api(`/api/tournaments/${tid}/join`,{});await refresh();toast("You're in.")});break;
    case 'tleave':act(async()=>{await api(`/api/tournaments/${tid}/leave`,{});await refresh();toast("Done. You're not playing in this one.")});break;
    case 'tinvite':act(async()=>{const ids=[...document.querySelectorAll('.inv-chk:checked')].map(x=>Number(x.value));if(!ids.length)throw new Error('Pick at least one player.');
      const r=await api(`/api/tournaments/${tid}/invite`,{userIds:ids});await refresh();toast(`${r.invited} invite${r.invited===1?'':'s'} sent.`)});break;
    case 'tformat':act(async()=>{await api(`/api/tournaments/${tid}/format`,{stages:readStages('tf')});await refresh();toast('Format saved.')});break;
    case 'tstart':act(async()=>{await api(`/api/tournaments/${tid}/start`,{});await refresh();toast('Bracket created. Good luck!')});break;
    case 'tcancel':if(el.dataset.sure){act(async()=>{await api(`/api/tournaments/${tid}/cancel`,{});ui.tid=null;await refresh();toast('Tournament cancelled.')})}
      else{el.dataset.sure='1';el.textContent='Click again to cancel';setTimeout(()=>{if(el.isConnected){delete el.dataset.sure;el.textContent='Cancel tournament'}},4000)}break;
    case 'report':openReport(tid,+el.dataset.r,+el.dataset.k);break;
    case 'mclose':case 'mclose-bg':closeModal();break;
  }
});
document.addEventListener('change',e=>{
  const el=e.target.closest('[data-act-change]');if(!el)return;
  if(el.dataset.actChange==='muopt')act(async()=>{await api('/api/me/matchups',{enabled:el.checked});await refresh();toast(el.checked?"You'll get a challenger every Monday.":'No more weekly challengers. Your open ones still count.')});
  if(el.dataset.actChange==='tround')act(async()=>{await api(`/api/tournaments/${el.dataset.tid}/format`,{round:Number(el.dataset.r),bestOf:Number(el.value)});await refresh();toast('Round format updated.')});
});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});

(async()=>{
  const q=new URLSearchParams(location.search).get('login');
  if(q==='failed')ui.loginMsg='42 sign-in did not complete. Try again.';
  if(q==='campus')ui.loginMsg='This ladder is only open to students of this campus.';
  if(q)history.replaceState(null,'',location.pathname);
  try{CFG=await api('/api/config')}catch(_){}
  await refresh();
  if(!S)loadDevUsers();
  // Pick up other people's changes every minute, unless you're in the middle of something.
  setInterval(()=>{if(S&&!document.querySelector('.overlay')&&!ui.tplan&&document.visibilityState==='visible'&&!document.activeElement.matches('input,select,textarea'))refresh()},60e3);
})();
})();
