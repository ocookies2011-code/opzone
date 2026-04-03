<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="theme-color" content="#0a0e1a"/>
<title>OpZone — Player</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Inter:wght@400;500&display=swap" rel="stylesheet"/>
<style>
:root{
  --bg0:#0a0e1a; --bg1:#111827; --bg2:#1a2235; --bg3:#232f45;
  --alpha:#185FA5; --alpha-light:#378ADD;
  --bravo:#8B2500; --bravo-light:#D85A30;
  --green:#1D9E75; --amber:#BA7517; --red:#E24B4A;
  --teal:#5DCAA5; --text:#e8eaf0; --text2:#9aa3b8; --text3:#5a6480;
  --border:rgba(255,255,255,0.08); --radius:12px;
  --team-color:#185FA5;
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
body{font-family:'Inter',sans-serif;background:var(--bg0);color:var(--text);height:100vh;display:flex;flex-direction:column;overflow:hidden;}
h1,h2,.label{font-family:'Rajdhani',sans-serif;}

/* JOIN SCREEN */
#join-screen{position:fixed;inset:0;background:var(--bg0);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;}
.join-card{background:var(--bg1);border:1px solid var(--border);border-radius:20px;padding:32px 24px;max-width:380px;width:100%;text-align:center;}
.join-logo{font-family:'Rajdhani',sans-serif;font-size:36px;font-weight:700;color:var(--teal);letter-spacing:4px;margin-bottom:4px;}
.join-sub{font-size:13px;color:var(--text2);margin-bottom:28px;}
.join-input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--border);background:var(--bg3);font-size:15px;color:var(--text);outline:none;margin-bottom:10px;font-family:'Inter',sans-serif;text-align:center;}
.join-input:focus{border-color:var(--teal);}
.code-input{font-family:'Rajdhani',sans-serif;font-size:22px;letter-spacing:5px;text-transform:uppercase;}
.join-label{font-size:11px;color:var(--text2);margin-bottom:6px;text-align:left;font-weight:500;}
.team-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px;}
.team-btn{padding:16px 10px;border-radius:12px;border:2px solid var(--border);background:var(--bg2);color:var(--text);cursor:pointer;text-align:center;transition:all 0.2s;font-family:'Rajdhani',sans-serif;}
.team-btn:hover{border-color:var(--teal);}
.team-btn.selected-alpha{border-color:var(--alpha-light);background:rgba(24,95,165,0.15);}
.team-btn.selected-bravo{border-color:var(--bravo-light);background:rgba(139,37,0,0.15);}
.team-icon{font-size:28px;margin-bottom:6px;}
.team-name{font-size:14px;font-weight:700;letter-spacing:1px;}
.join-btn{width:100%;padding:16px;border-radius:12px;font-size:17px;font-weight:700;cursor:pointer;border:none;background:var(--teal);color:#000;font-family:'Rajdhani',sans-serif;letter-spacing:1px;}
.join-btn:disabled{opacity:0.4;cursor:not-allowed;}
.join-error{color:var(--red);font-size:12px;margin-top:8px;min-height:18px;}

/* MAIN APP */
.topbar{background:var(--bg1);border-bottom:1px solid var(--border);padding:0 14px;display:flex;align-items:center;justify-content:space-between;height:52px;flex-shrink:0;}
.logo{font-family:'Rajdhani',sans-serif;font-size:18px;font-weight:700;color:var(--teal);letter-spacing:2px;}
.player-badge{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;font-family:'Rajdhani',sans-serif;letter-spacing:0.5px;}
.tabs{display:flex;background:var(--bg1);border-bottom:1px solid var(--border);flex-shrink:0;}
.tab{flex:1;padding:10px 4px;text-align:center;font-size:11px;color:var(--text2);cursor:pointer;border-bottom:2px solid transparent;transition:all 0.2s;font-family:'Rajdhani',sans-serif;font-weight:600;letter-spacing:0.5px;}
.tab.active{color:var(--teal);border-bottom-color:var(--teal);}
.content{flex:1;overflow:hidden;position:relative;}
.panel{display:none;height:100%;flex-direction:column;}
.panel.active{display:flex;}

/* STATUS SCREEN */
.status-scroll{flex:1;overflow-y:auto;padding:16px;}
.big-status{border-radius:16px;padding:24px;text-align:center;margin-bottom:16px;border:2px solid transparent;transition:all 0.5s;}
.big-status.active{background:rgba(29,158,117,0.1);border-color:var(--green);}
.big-status.out{background:rgba(226,75,74,0.1);border-color:var(--red);animation:pulse-card 1.5s infinite;}
.big-status.respawning{background:rgba(186,117,23,0.1);border-color:var(--amber);}
@keyframes pulse-card{0%,100%{opacity:1}50%{opacity:0.7}}
.status-icon{font-size:48px;margin-bottom:8px;}
.status-title{font-family:'Rajdhani',sans-serif;font-size:28px;font-weight:700;letter-spacing:1px;margin-bottom:4px;}
.status-sub{font-size:13px;color:var(--text2);line-height:1.6;}
.hit-btn{width:100%;padding:20px;border-radius:14px;font-size:20px;font-weight:700;cursor:pointer;border:none;background:var(--red);color:#fff;font-family:'Rajdhani',sans-serif;letter-spacing:1px;margin-bottom:12px;transition:transform 0.1s;}
.hit-btn:active{transform:scale(0.97);}
.hit-btn:disabled{opacity:0.3;cursor:not-allowed;}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:10px;}
.card-title{font-family:'Rajdhani',sans-serif;font-size:13px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;}
.stat-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;}
.stat-card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px;text-align:center;}
.stat-num{font-family:'Rajdhani',sans-serif;font-size:24px;font-weight:700;color:var(--text);}
.stat-label{font-size:10px;color:var(--text2);margin-top:2px;}
.info-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);}
.info-row:last-child{border-bottom:none;}
.info-key{font-size:12px;color:var(--text2);}
.info-val{font-size:12px;font-weight:500;color:var(--text);}
.gps-indicator{display:flex;align-items:center;gap:6px;font-size:12px;}
.gps-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
.gps-good{background:var(--green);}
.gps-bad{background:var(--red);animation:pulse-card 1s infinite;}

/* MAP */
#player-map{flex:1;min-height:200px;}

/* TEAM PANEL */
.team-scroll{flex:1;overflow-y:auto;padding:14px;}
.player-row{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;display:flex;align-items:center;gap:10px;}
.pr-av{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0;font-family:'Rajdhani',sans-serif;}
.pr-name{font-size:14px;font-weight:600;color:var(--text);font-family:'Rajdhani',sans-serif;}
.pr-sub{font-size:11px;color:var(--text2);}

/* ALERTS */
.alert-list{flex:1;overflow-y:auto;padding:14px;}
.alert-item{background:var(--bg2);border:1px solid var(--border);border-left:3px solid var(--amber);border-radius:10px;padding:12px;margin-bottom:8px;}
.alert-time{font-size:10px;color:var(--text3);font-family:'Rajdhani',sans-serif;}
.alert-msg{font-size:14px;color:var(--text);margin-top:4px;font-weight:500;}

/* TOAST */
.toast-wrap{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9000;display:flex;flex-direction:column;align-items:center;gap:6px;width:90%;max-width:340px;pointer-events:none;}
.toast{padding:12px 20px;border-radius:20px;font-size:13px;font-weight:600;font-family:'Rajdhani',sans-serif;letter-spacing:0.5px;opacity:0;transform:translateY(20px);transition:all 0.35s;pointer-events:none;text-align:center;width:100%;}
.toast.show{opacity:1;transform:translateY(0);}
.toast-alert{background:var(--amber);color:#fff;}
.toast-respawn{background:var(--green);color:#fff;}
.toast-hit{background:var(--red);color:#fff;}
.toast-oob{background:#7a5800;color:#fff;}
.toast-info{background:var(--bg3);color:var(--text);border:1px solid var(--border);}

/* OOB OVERLAY */
#oob-overlay{position:fixed;inset:0;background:rgba(226,75,74,0.15);border:4px solid var(--red);z-index:8000;pointer-events:none;display:none;border-radius:0;}
#oob-overlay.show{display:block;animation:oob-flash 1s infinite;}
@keyframes oob-flash{0%,100%{opacity:1}50%{opacity:0.3}}
</style>
</head>
<body>

<!-- JOIN SCREEN -->
<div id="join-screen">
  <div class="join-card">
    <div class="join-logo">OPZONE</div>
    <div class="join-sub">Player App</div>
    <div class="join-label">Game code</div>
    <input class="join-input code-input" id="code-input" placeholder="ABC123" maxlength="6"/>
    <div class="join-label">Your callsign</div>
    <input class="join-input" id="name-input" placeholder="e.g. Ghost"/>
    <div class="join-label" style="margin-bottom:8px;">Choose team</div>
    <div class="team-row">
      <div class="team-btn" id="btn-alpha" onclick="selectTeam('alpha')">
        <div class="team-icon">🔵</div>
        <div class="team-name" style="color:var(--alpha-light);">ALPHA</div>
      </div>
      <div class="team-btn" id="btn-bravo" onclick="selectTeam('bravo')">
        <div class="team-icon">🔴</div>
        <div class="team-name" style="color:var(--bravo-light);">BRAVO</div>
      </div>
    </div>
    <button class="join-btn" id="join-btn" onclick="joinGame()" disabled>Join Game</button>
    <div class="join-error" id="join-error"></div>
  </div>
</div>

<div id="oob-overlay"></div>
<div class="toast-wrap" id="toast-wrap"></div>

<!-- MAIN APP (hidden until joined) -->
<div id="main-app" style="display:none;flex-direction:column;height:100vh;">
  <div class="topbar">
    <div class="logo">OPZONE</div>
    <div style="display:flex;align-items:center;gap:8px;">
      <span class="player-badge" id="team-badge">---</span>
      <span style="font-family:'Rajdhani',sans-serif;font-size:16px;font-weight:600;color:var(--teal);" id="timer-display">00:00</span>
    </div>
  </div>
  <div class="tabs">
    <div class="tab active" onclick="switchTab('status')">Status</div>
    <div class="tab" onclick="switchTab('map')">Map</div>
    <div class="tab" onclick="switchTab('team')">Team</div>
    <div class="tab" onclick="switchTab('alerts')">Alerts <span id="alert-dot" style="display:none;color:var(--red);">●</span></div>
  </div>
  <div class="content">

    <!-- STATUS -->
    <div class="panel active" id="panel-status">
      <div class="status-scroll">
        <div class="big-status active" id="big-status">
          <div class="status-icon" id="status-icon">✅</div>
          <div class="status-title" id="status-title">ACTIVE</div>
          <div class="status-sub" id="status-sub">You're in the game. Stay alert!</div>
        </div>
        <button class="hit-btn" id="hit-btn" onclick="selfMarkOut()">💥 I'VE BEEN HIT</button>
        <div class="stat-row">
          <div class="stat-card"><div class="stat-num" id="p-kills">0</div><div class="stat-label">My kills</div></div>
          <div class="stat-card"><div class="stat-num" id="p-alpha-score" style="color:var(--alpha-light);">0</div><div class="stat-label">Alpha kills</div></div>
          <div class="stat-card"><div class="stat-num" id="p-bravo-score" style="color:var(--bravo-light);">0</div><div class="stat-label">Bravo kills</div></div>
        </div>
        <div class="card">
          <div class="card-title">GPS</div>
          <div class="gps-indicator">
            <div class="gps-dot gps-bad" id="gps-dot"></div>
            <span id="gps-label">Acquiring location...</span>
          </div>
          <div style="font-size:11px;color:var(--text3);margin-top:6px;" id="gps-coords">---</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px;" id="gps-accuracy"></div>
        </div>
        <div class="card">
          <div class="card-title">Game info</div>
          <div class="info-row"><span class="info-key">Mode</span><span class="info-val" id="inf-mode">---</span></div>
          <div class="info-row"><span class="info-key">Round</span><span class="info-val" id="inf-round">1</span></div>
          <div class="info-row"><span class="info-key">Game code</span><span class="info-val" id="inf-code">---</span></div>
          <div class="info-row"><span class="info-key">Team</span><span class="info-val" id="inf-team">---</span></div>
        </div>
      </div>
    </div>

    <!-- MAP -->
    <div class="panel" id="panel-map">
      <div id="player-map"></div>
    </div>

    <!-- TEAM -->
    <div class="panel" id="panel-team">
      <div class="team-scroll" id="team-list"></div>
    </div>

    <!-- ALERTS -->
    <div class="panel" id="panel-alerts">
      <div class="alert-list" id="alert-list">
        <div style="font-size:13px;color:var(--text2);">No alerts yet.</div>
      </div>
    </div>

  </div>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
let gameCode=null, myPlayer=null, es=null;
let selectedTeam=null;
let pMap=null, pStreet=null, pSat=null;
let pMarkers={}, pZoneCircles={};
let gpsWatcher=null, lastState=null;
let alerts=[];
let myLat=null, myLng=null;

// ── JOIN ──────────────────────────────────────────────────────────────────────

// Pre-fill code from URL
const urlParams=new URLSearchParams(window.location.search);
if(urlParams.get('code')) document.getElementById('code-input').value=urlParams.get('code').toUpperCase();

// Restore session if previously joined
const saved=localStorage.getItem('opzone_player');
if(saved) { try { const d=JSON.parse(saved); gameCode=d.code; myPlayer=d.player; launchApp(); } catch(e){} }

document.getElementById('code-input').addEventListener('input',validateJoin);
document.getElementById('name-input').addEventListener('input',validateJoin);
function validateJoin(){
  const ok=document.getElementById('code-input').value.length>=4 && document.getElementById('name-input').value.trim() && selectedTeam;
  document.getElementById('join-btn').disabled=!ok;
}
function selectTeam(t){
  selectedTeam=t;
  document.getElementById('btn-alpha').className='team-btn '+(t==='alpha'?'selected-alpha':'');
  document.getElementById('btn-bravo').className='team-btn '+(t==='bravo'?'selected-bravo':'');
  validateJoin();
}

async function joinGame(){
  const code=document.getElementById('code-input').value.trim().toUpperCase();
  const name=document.getElementById('name-input').value.trim();
  const err=document.getElementById('join-error');
  err.textContent='';
  try {
    const res=await fetch('/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,name,team:selectedTeam})});
    const data=await res.json();
    if(data.error){err.textContent='Game not found. Check your code.';return;}
    gameCode=data.player.id?code:null;
    if(!gameCode){err.textContent='Could not join.';return;}
    myPlayer=data.player;
    gameCode=code;
    localStorage.setItem('opzone_player',JSON.stringify({code,player:myPlayer}));
    launchApp();
  } catch(e){ err.textContent='Cannot connect to server. Is it running?'; }
}

function launchApp(){
  document.getElementById('join-screen').style.display='none';
  const app=document.getElementById('main-app');
  app.style.display='flex';
  app.style.flexDirection='column';
  document.getElementById('inf-code').textContent=gameCode;
  setTeamColors();
  connectSSE();
  initPlayerMap();
  startGPS();
}

function setTeamColors(){
  const isAlpha=myPlayer.team==='alpha';
  const color=isAlpha?'#185FA5':'#8B2500';
  const light=isAlpha?'#378ADD':'#D85A30';
  document.documentElement.style.setProperty('--team-color',color);
  const badge=document.getElementById('team-badge');
  badge.textContent=isAlpha?'ALPHA':'BRAVO';
  badge.style.background=isAlpha?'rgba(24,95,165,0.2)':'rgba(139,37,0,0.2)';
  badge.style.color=light;
  document.getElementById('inf-team').textContent=isAlpha?'Team Alpha':'Team Bravo';
}

// ── SSE ───────────────────────────────────────────────────────────────────────

function connectSSE(){
  es=new EventSource(`/events?code=${gameCode}`);
  es.addEventListener('state',e=>applyState(JSON.parse(e.data)));
  es.addEventListener('timer',e=>{ const d=JSON.parse(e.data); document.getElementById('timer-display').textContent=fmt(d.seconds); });
  es.addEventListener('alert',e=>{ const d=JSON.parse(e.data); onAlert(d); });
  es.addEventListener('respawn',e=>{ const d=JSON.parse(e.data); if(d.player===myPlayer.name) onMyRespawn(); });
  es.addEventListener('hit',e=>{ const d=JSON.parse(e.data); if(d.player!==myPlayer.name) showToast(`💥 ${d.player} eliminated`,'toast-hit'); });
  es.addEventListener('boundary',e=>{ const d=JSON.parse(e.data); if(d.player===myPlayer.name) onOOB(); });
}

function applyState(s){
  lastState=s;
  const me=s.players.find(p=>p.id===myPlayer.id);
  if(me){ myPlayer=me; updateMyStatus(); }
  document.getElementById('p-alpha-score').textContent=s.scores.alpha;
  document.getElementById('p-bravo-score').textContent=s.scores.bravo;
  document.getElementById('inf-mode').textContent=s.mode;
  document.getElementById('inf-round').textContent=s.roundNum;
  document.getElementById('timer-display').textContent=fmt(s.gameSeconds);
  syncMapZones(s.zones);
  syncMapPlayers(s.players);
  renderTeamList(s.players);
}

function updateMyStatus(){
  const bs=document.getElementById('big-status');
  const icon=document.getElementById('status-icon');
  const title=document.getElementById('status-title');
  const sub=document.getElementById('status-sub');
  const btn=document.getElementById('hit-btn');
  document.getElementById('p-kills').textContent=myPlayer.kills;
  if(myPlayer.out){
    bs.className='big-status out';
    icon.textContent='💀';
    title.textContent='ELIMINATED';
    sub.textContent='You\'ve been hit! Walk to your team\'s respawn zone to come back.';
    btn.disabled=true;
    btn.textContent='Walk to your respawn zone...';
  } else {
    bs.className='big-status active';
    icon.textContent='✅';
    title.textContent='ACTIVE';
    sub.textContent='You\'re in the game. Stay sharp!';
    btn.disabled=false;
    btn.textContent='💥 I\'VE BEEN HIT';
    document.getElementById('oob-overlay').classList.remove('show');
  }
}

async function selfMarkOut(){
  if(!confirm('Mark yourself as hit?')) return;
  await fetch('/api/markout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:gameCode,playerId:myPlayer.id})});
}

function onMyRespawn(){
  showToast('✅ You\'ve respawned — back in the game!','toast-respawn');
  updateMyStatus();
}

function onOOB(){
  document.getElementById('oob-overlay').classList.add('show');
  showToast('⚠️ You are OUT OF BOUNDS! Return immediately!','toast-oob');
}

function onAlert(d){
  alerts.unshift(d);
  renderAlerts();
  showToast(`📢 ${d.message}`,'toast-alert');
  document.getElementById('alert-dot').style.display='';
}

// ── GPS ───────────────────────────────────────────────────────────────────────

function startGPS(){
  if(!navigator.geolocation){ document.getElementById('gps-label').textContent='GPS not available'; return; }
  gpsWatcher=navigator.geolocation.watchPosition(
    pos=>onGPS(pos),
    err=>onGPSError(err),
    { enableHighAccuracy:true, maximumAge:3000, timeout:10000 }
  );
}

function onGPS(pos){
  myLat=pos.coords.latitude;
  myLng=pos.coords.longitude;
  const acc=Math.round(pos.coords.accuracy);
  document.getElementById('gps-dot').className='gps-dot gps-good';
  document.getElementById('gps-label').textContent=`GPS locked (±${acc}m)`;
  document.getElementById('gps-coords').textContent=`${myLat.toFixed(6)}, ${myLng.toFixed(6)}`;
  document.getElementById('gps-accuracy').textContent=`Accuracy: ±${acc} metres`;
  sendLocation(myLat,myLng);
  if(pMap){
    pMap.setView([myLat,myLng]);
    if(pMarkers['_me']){ pMarkers['_me'].setLatLng([myLat,myLng]); }
    else {
      pMarkers['_me']=L.circleMarker([myLat,myLng],{radius:10,color:'#fff',fillColor:var_team(),fillOpacity:1,weight:3}).addTo(pMap).bindPopup('You are here');
    }
  }
}

function var_team(){ return myPlayer&&myPlayer.team==='alpha'?'#185FA5':'#8B2500'; }

function onGPSError(err){
  document.getElementById('gps-dot').className='gps-dot gps-bad';
  document.getElementById('gps-label').textContent='GPS error — check permissions';
}

async function sendLocation(lat,lng){
  try {
    await fetch('/api/location',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:gameCode,playerId:myPlayer.id,lat,lng})});
  } catch(e){}
}

// ── PLAYER MAP ────────────────────────────────────────────────────────────────

function initPlayerMap(){
  pMap=L.map('player-map',{zoomControl:true,attributionControl:false}).setView([51.504,-0.089],16);
  pStreet=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19});
  pStreet.addTo(pMap);
  if(myLat) pMap.setView([myLat,myLng],17);
}

function syncMapZones(zones){
  if(!pMap) return;
  const ids=new Set(zones.map(z=>z.id));
  Object.keys(pZoneCircles).forEach(id=>{ if(!ids.has(parseInt(id))){ pZoneCircles[id].remove(); delete pZoneCircles[id]; }});
  const colors={alpha:'#185FA5',bravo:'#8B2500',boundary:'#7a7a00'};
  const fills={alpha:'rgba(24,95,165,0.12)',bravo:'rgba(139,37,0,0.12)',boundary:'rgba(122,122,0,0.08)'};
  zones.forEach(z=>{
    if(!pZoneCircles[z.id]){
      pZoneCircles[z.id]=L.circle([z.lat,z.lng],{radius:z.radius,color:colors[z.type],fillColor:fills[z.type],fillOpacity:1,weight:2,dashArray:z.type==='boundary'?'8 5':null}).addTo(pMap).bindPopup(z.label);
    }
  });
  // highlight my respawn zone
  zones.filter(z=>z.type===myPlayer.team).forEach(z=>{
    if(pZoneCircles[z.id]) pZoneCircles[z.id].setStyle({weight:3,color:z.type==='alpha'?'#5DCAA5':'#F0997B'});
  });
}

function syncMapPlayers(players){
  if(!pMap) return;
  players.forEach(p=>{
    if(!p.lat || p.id===myPlayer.id) return;
    const showEnemy = false; // hide enemies from player map (tactical decision)
    if(p.team!==myPlayer.team && !showEnemy) return;
    const color=p.out?'#444':(p.team==='alpha'?'#185FA5':'#8B2500');
    if(!pMarkers[p.id]){
      pMarkers[p.id]=L.marker([p.lat,p.lng],{icon:L.divIcon({className:'',html:`<div style="background:${color};color:#fff;padding:3px 8px;border-radius:12px;font-size:10px;font-weight:700;font-family:'Rajdhani',sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.4);">${p.name}</div>`,iconAnchor:[20,10]})}).addTo(pMap);
    } else {
      pMarkers[p.id].setLatLng([p.lat,p.lng]);
    }
  });
}

// ── TEAM LIST ─────────────────────────────────────────────────────────────────

function renderTeamList(players){
  const myTeam=players.filter(p=>p.team===myPlayer.team);
  const el=document.getElementById('team-list');
  el.innerHTML='<div style="font-family:\'Rajdhani\',sans-serif;font-size:11px;color:var(--teal);font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Your team — '+(myPlayer.team==='alpha'?'Alpha':'Bravo')+'</div>';
  el.innerHTML+=myTeam.map(p=>{
    const isSelf=p.id===myPlayer.id;
    const color=myPlayer.team==='alpha'?'#185FA5':'#8B2500';
    const st=p.out?'color:var(--red)':'color:var(--teal)';
    const sl=p.out?'Out — respawning':'Active';
    return `<div class="player-row">
      <div class="pr-av" style="background:${p.out?'#444':color}">${p.name[0]}</div>
      <div>
        <div class="pr-name">${p.name}${isSelf?' (you)':''}</div>
        <div class="pr-sub" style="${st}">${sl} · ${p.kills} kills</div>
      </div>
    </div>`;
  }).join('');
}

// ── ALERTS ────────────────────────────────────────────────────────────────────

function renderAlerts(){
  const el=document.getElementById('alert-list');
  if(!alerts.length){el.innerHTML='<div style="font-size:13px;color:var(--text2);">No alerts yet.</div>';return;}
  el.innerHTML=alerts.map(a=>`<div class="alert-item"><div class="alert-time">${new Date(a.time).toLocaleTimeString()}</div><div class="alert-msg">${a.message}</div></div>`).join('');
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function fmt(s){return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');}

function switchTab(name){
  const names=['status','map','team','alerts'];
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',names[i]===name));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-'+name).classList.add('active');
  if(name==='map') setTimeout(()=>pMap&&pMap.invalidateSize(),100);
  if(name==='alerts') document.getElementById('alert-dot').style.display='none';
}

function showToast(msg,cls){
  const wrap=document.getElementById('toast-wrap');
  const t=document.createElement('div');
  t.className=`toast ${cls}`; t.textContent=msg;
  wrap.appendChild(t);
  setTimeout(()=>t.classList.add('show'),10);
  setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(),400); },5000);
}
</script>
</body>
</html>
