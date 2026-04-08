const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const SUPER_ADMIN_USER = process.env.ADMIN_USER || 'chriszulu';
const SUPER_ADMIN_PASS = process.env.ADMIN_PASS || 'SwindonA1rsoft!';
const adminSessions = new Map();

let db = null;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return def; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2)); }
  catch (e) { console.error('File save error:', e.message); }
}

const siteAdmins = {};
const savedMaps = {};
const roomTemplates = {};
const playerAccounts = {};
const clubs = {};
const playerStats = {};
const rooms = {};
const eventLog = [];

async function dbGet(key) {
  if (!db) return null;
  try { const r = await db.query('SELECT value FROM kv_store WHERE key=$1', [key]); return r.rows.length ? JSON.parse(r.rows[0].value) : null; }
  catch { return null; }
}
async function dbSet(key, value) {
  if (!db) return;
  try { await db.query('INSERT INTO kv_store(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2, updated_at=NOW()', [key, JSON.stringify(value)]); }
  catch (e) { console.error('DB write error:', e.message); }
}
async function dbDel(key) {
  if (!db) return;
  try { await db.query('DELETE FROM kv_store WHERE key=$1', [key]); } catch {}
}
async function persist(collection, key, data) {
  await dbSet(collection + ':' + key, data);
  const fm = { 'site-admins': siteAdmins, 'saved-maps': savedMaps, 'room-templates': roomTemplates, 'player-accounts': playerAccounts, 'clubs': clubs, 'player-stats': playerStats };
  if (fm[collection]) saveJSON(collection + '.json', fm[collection]);
}
async function persistDel(collection, key) {
  await dbDel(collection + ':' + key);
  const fm = { 'site-admins': siteAdmins, 'saved-maps': savedMaps, 'room-templates': roomTemplates, 'player-accounts': playerAccounts, 'clubs': clubs, 'player-stats': playerStats };
  if (fm[collection]) saveJSON(collection + '.json', fm[collection]);
}

async function initDB() {
  if (!process.env.DATABASE_URL) { console.log('ℹ No DATABASE_URL — using file storage'); loadFileData(); return; }
  try {
    const { Pool } = require('pg');
    db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await db.query('CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())');
    console.log('✅ PostgreSQL connected');
    await loadDBData();
  } catch (e) { console.error('DB init failed:', e.message, '— falling back to files'); db = null; loadFileData(); }
}

async function loadDBData() {
  try {
    const r = await db.query('SELECT key, value FROM kv_store');
    for (const row of r.rows) {
      const [col, ...kp] = row.key.split(':'); const key = kp.join(':'); const val = JSON.parse(row.value);
      if (col === 'site-admins') siteAdmins[key] = val;
      else if (col === 'saved-maps') savedMaps[key] = val;
      else if (col === 'room-templates') roomTemplates[key] = val;
      else if (col === 'player-accounts') playerAccounts[key] = val;
      else if (col === 'clubs') clubs[key] = val;
      else if (col === 'player-stats') playerStats[key] = val;
    }
    console.log(`♻ DB loaded: ${Object.keys(siteAdmins).length} admins, ${Object.keys(savedMaps).length} maps, ${Object.keys(playerAccounts).length} players, ${Object.keys(clubs).length} clubs`);
    restoreRooms();
  } catch (e) { console.error('DB load failed:', e.message); loadFileData(); }
}

function loadFileData() {
  Object.assign(siteAdmins, loadJSON('site-admins.json', {}));
  Object.assign(savedMaps, loadJSON('saved-maps.json', {}));
  Object.assign(roomTemplates, loadJSON('room-templates.json', {}));
  Object.assign(playerAccounts, loadJSON('player-accounts.json', {}));
  Object.assign(clubs, loadJSON('clubs.json', {}));
  Object.assign(playerStats, loadJSON('player-stats.json', {}));
  console.log(`♻ Files loaded: ${Object.keys(siteAdmins).length} admins, ${Object.keys(savedMaps).length} maps, ${Object.keys(playerAccounts).length} players`);
  restoreRooms();
}

function restoreRooms() {
  Object.entries(roomTemplates).forEach(([code, tmpl]) => {
    const room = makeRoom(code, tmpl.name, tmpl.password);
    room.zones = tmpl.zones || []; room.objectives = tmpl.objectives || [];
    room.allowedRoles = tmpl.allowedRoles || null; room.roleLimits = tmpl.roleLimits || null;
    room.gameMode = tmpl.gameMode || 'Standard'; room.gameModeConfig = tmpl.gameModeConfig || {};
    room.createdAt = tmpl.createdAt || room.createdAt;
    rooms[code] = room;
    console.log(`  🗺 Restored: ${tmpl.name} (${code}) [${room.gameMode}]`);
  });
}

async function persistRoomTemplate(room) {
  roomTemplates[room.code] = { name: room.name, password: room.password, zones: room.zones, objectives: room.objectives, allowedRoles: room.allowedRoles, roleLimits: room.roleLimits, gameMode: room.gameMode || 'Standard', gameModeConfig: room.gameModeConfig || {}, createdAt: room.createdAt };
  await persist('room-templates', room.code, roomTemplates[room.code]);
}
async function deleteRoomTemplate(code) {
  delete roomTemplates[code]; await persistDel('room-templates', code); saveJSON('room-templates.json', roomTemplates);
}
function logEvent(type, data) { eventLog.push({ type, data, ts: Date.now() }); if (eventLog.length > 2000) eventLog.shift(); }

const GAME_MODES = {
  Standard:     { label: 'Standard',      desc: 'Classic free-play game with full roles.' },
  Elimination:  { label: 'Elimination',   desc: 'Eliminate the enemy team. Limited respawns.' },
  Domination:   { label: 'Domination',    desc: 'Capture and hold objectives. Score-based.' },
  BattleRoyale: { label: 'Battle Royale', desc: 'Safe zone shrinks. Last team standing wins.' },
  Countdown:    { label: 'Countdown',     desc: 'Complete all objectives before time expires.' },
  Escort:       { label: 'Escort',        desc: 'Escort the VIP to extraction. Defenders must stop them.' },
};

const ZONE_TYPES = {
  respawn_red:  { label: 'Red Respawn',   color: '#ff4444', fillOpacity: 0.18 },
  respawn_blue: { label: 'Blue Respawn',  color: '#4488ff', fillOpacity: 0.18 },
  objective:    { label: 'Objective',     color: '#ffaa00', fillOpacity: 0.20 },
  hazard:       { label: 'Hazard Zone',   color: '#ff2a2a', fillOpacity: 0.15 },
  safe:         { label: 'Safe Zone',     color: '#00cc66', fillOpacity: 0.12 },
  boundary:     { label: 'Game Boundary', color: '#e8c84a', fillOpacity: 0.00 },
  extraction:   { label: 'Extraction',    color: '#00ff88', fillOpacity: 0.22 },
  custom:       { label: 'Custom Zone',   color: '#cc44ff', fillOpacity: 0.15 },
};

const ALL_ROLES = ['Assault', 'Sniper', 'Support', 'Medic', 'Scout', 'Commander'];
const DEFAULT_ROLE_LIMITS = {
  Standard: {}, Elimination: { Medic: 2, Commander: 1 }, Domination: { Medic: 2, Commander: 1, Sniper: 2 },
  BattleRoyale: { Medic: 1, Commander: 1 }, Countdown: { Medic: 2, Commander: 1 }, Escort: { Medic: 2, Commander: 1 },
};

function makeRoom(code, name, password) {
  return {
    code, name: name || code, password: password || '',
    players: {}, adminObservers: new Set(),
    orders: [{ id: uuidv4(), from: 'SYSTEM', text: `🎯 ${name||code} — Stand by. Await deployment orders.`, priority: 'normal', ts: Date.now() }],
    objectives: [], zones: [], mapTiles: 'osm',
    allowedRoles: null, roleLimits: null,
    gameMode: 'Standard', gameModeConfig: {},
    activeMapId: null, createdAt: Date.now(), gamePaused: false,
    gameTimer: null, safeZone: null,
    uavActive: {}, teamCooldowns: { red: {}, blue: {} }, empScramble: {},
    domScore: { red: 0, blue: 0 },
  };
}

function getOrCreateRoom(code, name, password) {
  if (!rooms[code]) { rooms[code] = makeRoom(code, name, password); logEvent('room_created', { code, name }); }
  return rooms[code];
}

setInterval(() => {
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    if (roomTemplates[code]) continue;
    const active = Object.values(room.players).some(p => p.ws && p.ws.readyState === WebSocket.OPEN);
    if (!active) { delete rooms[code]; logEvent('room_expired', { code }); }
  }
}, 600_000);

function sendTo(ws, msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function broadcastTeam(room, team, msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  for (const p of Object.values(room.players)) {
    if (team && p.team !== team) continue;
    if (p.ws && p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
  if (room.adminObservers) { for (const ows of room.adminObservers) { if (ows !== excludeWs && ows.readyState === WebSocket.OPEN) ows.send(data); } }
}
function broadcastAll(room, msg, excludeWs = null) { broadcastTeam(room, null, msg, excludeWs); }

function playerPublic(p) {
  return { id: p.id, callsign: p.callsign, team: p.team, role: p.role, status: p.status, lat: p.lat, lng: p.lng, heading: p.heading, lastSeen: p.lastSeen, joinedAt: p.joinedAt, rank: p.rank || 'soldier', kills: p.kills || 0, deaths: p.deaths || 0, revives: p.revives || 0 };
}

function roomSnapshotForTeam(room, viewerTeam) {
  const uavActive = room.uavActive && room.uavActive[viewerTeam];
  return {
    players: Object.values(room.players).map(p => { const pub = playerPublic(p); if (p.team !== viewerTeam && !uavActive) { pub.lat = null; pub.lng = null; } return pub; }),
    orders: room.orders.slice(-100), objectives: room.objectives, zones: room.zones,
    mapTiles: room.mapTiles, gamePaused: room.gamePaused, roomName: room.name,
    gameMode: room.gameMode || 'Standard', gameModeConfig: room.gameModeConfig || {},
    gameTimer: room.gameTimer || null, safeZone: room.safeZone || null,
    domScore: room.domScore || { red: 0, blue: 0 },
  };
}

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const session = token && adminSessions.get(token);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  req.adminSession = session; next();
}
function superAdminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const session = token && adminSessions.get(token);
  if (!session || session.role !== 'super') return res.status(403).json({ error: 'Super admin only' });
  req.adminSession = session; next();
}
function canAccessRoom(session, roomCode) {
  if (session.role === 'super') return true;
  return session.managedSites && session.managedSites.includes(roomCode);
}
function playerAuth(req, res, next) {
  const token = req.headers['x-player-token'];
  const sess = token && playerSessions.get(token);
  if (!sess) return res.status(401).json({ error: 'Not logged in' });
  req.playerSession = sess; next();
}

// Stats
function getStats(username) {
  if (!playerStats[username]) playerStats[username] = { username, gamesPlayed: 0, wins: 0, losses: 0, kills: 0, deaths: 0, revives: 0, totalPlaytime: 0, gameHistory: [], rank: 'Recruit', xp: 0, lastGame: null };
  return playerStats[username];
}
const RANKS = [[0,'Recruit'],[100,'Private'],[300,'Corporal'],[600,'Lance Sergeant'],[1000,'Sergeant'],[1500,'Staff Sergeant'],[2200,'Warrant Officer'],[3000,'Lieutenant'],[4000,'Captain'],[5500,'Major'],[7500,'Colonel'],[10000,'Brigadier'],[15000,'General']];
function addXP(username, amount) {
  const s = getStats(username); s.xp = (s.xp||0) + amount;
  for (let i = RANKS.length-1; i >= 0; i--) { if (s.xp >= RANKS[i][0]) { s.rank = RANKS[i][1]; break; } }
  persist('player-stats', username, s).catch(() => {});
}
function recordStat(username, stat) {
  const s = getStats(username);
  if (stat==='kill') { s.kills=(s.kills||0)+1; addXP(username,10); }
  else if (stat==='death') s.deaths=(s.deaths||0)+1;
  else if (stat==='revive') { s.revives=(s.revives||0)+1; addXP(username,15); }
  else if (stat==='win') { s.wins=(s.wins||0)+1; addXP(username,50); }
  else if (stat==='game') { s.gamesPlayed=(s.gamesPlayed||0)+1; addXP(username,5); }
  persist('player-stats', username, s).catch(() => {});
}

// Physics
function haversine(lat1, lng1, lat2, lng2) {
  const R=6371000, dLat=(lat2-lat1)*Math.PI/180, dLng=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function checkTeamCooldown(room,team,perk) { const cd=room.teamCooldowns[team][perk]; if(cd&&Date.now()<cd)return Math.ceil((cd-Date.now())/1000); return 0; }
function setTeamCooldown(room,team,perk,seconds) { room.teamCooldowns[team][perk]=Date.now()+seconds*1000; broadcastTeam(room,team,{type:'team_cooldown',perk,seconds,endsAt:room.teamCooldowns[team][perk]}); }

function revivePlayer(room, target, byCallsign) {
  if (target.status==='alive') return;
  if (target._bleedExpired) { sendTo(target.ws,{type:'revive_blocked',reason:'Bleed-out expired — reach respawn zone.'}); return; }
  if (target._bleedTimer) { clearTimeout(target._bleedTimer); target._bleedTimer=null; }
  target.status='alive'; target.bleedingOut=false;
  broadcastAll(room,{type:'status_update',playerId:target.id,status:'alive',team:target.team});
  sendTo(target.ws,{type:'revived',by:byCallsign});
  room.orders.push({id:uuidv4(),from:byCallsign,team:target.team,text:`🩹 ${byCallsign} revived ${target.callsign}!`,priority:'normal',ts:Date.now()});
  broadcastAll(room,{type:'new_order',order:room.orders[room.orders.length-1]});
  if (target._username) recordStat(target._username,'revive');
}
const BLEED_OUT_MS = 120000;
function startBleedOut(room, player) {
  if (player._bleedTimer) clearTimeout(player._bleedTimer);
  player.bleedingOut=true; player._bleedExpired=false;
  broadcastAll(room,{type:'bleed_start',playerId:player.id,duration:BLEED_OUT_MS});
  sendTo(player.ws,{type:'you_are_bleeding',duration:BLEED_OUT_MS});
  player._bleedTimer=setTimeout(()=>{
    player._bleedTimer=null; player.bleedingOut=false; player._bleedExpired=true;
    if(player.status!=='alive'){broadcastAll(room,{type:'bleed_expired',playerId:player.id});sendTo(player.ws,{type:'bleed_expired'});}
  },BLEED_OUT_MS);
}
function startMedicScanner(room) {
  const downed=Object.values(room.players).filter(p=>p.status==='dead');
  if(!downed.length)return;
  Object.values(room.players).filter(p=>p.role==='Medic'&&p.status==='alive'&&p.lat).forEach(medic=>{
    downed.forEach(target=>{if(target.team===medic.team&&target.lat&&haversine(medic.lat,medic.lng,target.lat,target.lng)<=5)revivePlayer(room,target,medic.callsign);});
  });
}

const PERK_CONFIGS = {
  uav:{teamCd:60,effect(room,caster){const team=caster.team,rem=checkTeamCooldown(room,team,'uav');if(rem)return{feedback:`UAV on cooldown — ${rem}s.`,cooldown:true};if(!caster.lat)return{feedback:'No GPS — UAV requires location.'};const UAV_DUR=20000;setTeamCooldown(room,team,'uav',60);if(!room.uavActive)room.uavActive={};room.uavActive[team]=true;const enemies=Object.values(room.players).filter(p=>p.team!==team&&p.lat&&haversine(caster.lat,caster.lng,p.lat,p.lng)<=30);const reveals=enemies.map(playerPublic);broadcastTeam(room,team,{type:'uav_reveal',reveals,duration:UAV_DUR,callsign:caster.callsign});broadcastTeam(room,team,{type:'perk_anim_persist',perk:'uav',lat:caster.lat,lng:caster.lng,duration:UAV_DUR,callsign:caster.callsign,team});const et=team==='red'?'blue':'red';const warn={id:uuidv4(),from:'INTEL',team:et,text:'📡 UAV SCAN DETECTED — Enemy surveillance active! Move now!',priority:'high',ts:Date.now()};room.orders.push(warn);broadcastTeam(room,et,{type:'new_order',order:warn});setTimeout(()=>{if(room.uavActive)room.uavActive[team]=false;broadcastTeam(room,team,{type:'uav_expired'});},UAV_DUR);logEvent('perk_uav',{room:room.code,caster:caster.callsign,hits:enemies.length});return{feedback:`UAV scanning 30m — ${enemies.length} contact(s) revealed for 20s.`};}},
  emp:{teamCd:270,effect(room,caster){const team=caster.team,rem=checkTeamCooldown(room,team,'emp');if(rem)return{feedback:`EMP on cooldown — ${rem}s.`,cooldown:true};if(!caster.lat)return{feedback:'No GPS.'};const EMP_DUR=30000;const enemies=Object.values(room.players).filter(p=>p.team!==team&&p.lat&&haversine(caster.lat,caster.lng,p.lat,p.lng)<=100);setTeamCooldown(room,team,'emp',270);const et=team==='red'?'blue':'red';enemies.forEach(e=>sendTo(e.ws,{type:'emp_scramble_start',duration:EMP_DUR,from:caster.callsign}));broadcastTeam(room,team,{type:'emp_scramble_enemies',duration:EMP_DUR,enemyTeam:et});broadcastTeam(room,team,{type:'perk_anim',perk:'emp',lat:caster.lat,lng:caster.lng,callsign:caster.callsign,team});setTimeout(()=>{enemies.forEach(e=>sendTo(e.ws,{type:'emp_scramble_end'}));broadcastTeam(room,team,{type:'emp_scramble_done',enemyTeam:et});},EMP_DUR);return{feedback:enemies.length?`EMP hit ${enemies.length} enemies.`:'EMP deployed — no enemies in range.'};}},
  smoke:{teamCd:180,effect(room,caster){const team=caster.team,rem=checkTeamCooldown(room,team,'smoke');if(rem)return{feedback:`Smoke on cooldown — ${rem}s.`,cooldown:true};if(!caster.lat)return{feedback:'No GPS.'};setTeamCooldown(room,team,'smoke',180);const SMOKE_DUR=30000;const zone={id:uuidv4(),zoneType:'custom',label:`💨 SMOKE — ${caster.callsign}`,shape:'circle',center:[caster.lat,caster.lng],radius:15,color:'#888888',fillOpacity:0.6,latlngs:[],createdBy:{callsign:caster.callsign},ts:Date.now(),isSmoke:true};room.zones.push(zone);broadcastAll(room,{type:'zone_added',zone});broadcastTeam(room,team,{type:'perk_anim_persist',perk:'smoke',lat:caster.lat,lng:caster.lng,duration:SMOKE_DUR,callsign:caster.callsign,team});setTimeout(()=>{room.zones=room.zones.filter(z=>z.id!==zone.id);broadcastAll(room,{type:'zone_removed',id:zone.id});broadcastTeam(room,team,{type:'perk_anim_end',perk:'smoke'});},SMOKE_DUR);return{feedback:'Smoke deployed for 30s.'};}},
  hack:{playerCd:150,effect(room,caster){const now=Date.now();if(caster._hackCooldownUntil&&now<caster._hackCooldownUntil)return{feedback:`Hack on cooldown — ${Math.ceil((caster._hackCooldownUntil-now)/1000)}s.`,cooldown:true};const enemies=Object.values(room.players).filter(p=>p.team!==caster.team&&p.lat);if(!enemies.length)return{feedback:'No targets with GPS.'};caster._hackCooldownUntil=now+150000;sendTo(caster.ws,{type:'player_cooldown',perk:'hack',seconds:150,endsAt:caster._hackCooldownUntil});const target=enemies[Math.floor(Math.random()*enemies.length)];sendTo(caster.ws,{type:'hack_reveal',target:playerPublic(target),duration:10000});sendTo(target.ws,{type:'hack_detected',from:caster.callsign});sendTo(caster.ws,{type:'perk_anim',perk:'hack',lat:caster.lat,lng:caster.lng,callsign:caster.callsign,team:caster.team});return{feedback:`Hacked: ${target.callsign} revealed for 10s.`};}},
  medkit:{teamCd:120,effect(room,caster){const team=caster.team,rem=checkTeamCooldown(room,team,'medkit');if(rem)return{feedback:`Medkit on cooldown — ${rem}s.`,cooldown:true};if(!caster.lat)return{feedback:'No GPS.'};setTeamCooldown(room,team,'medkit',120);const downed=Object.values(room.players).filter(p=>p.team===team&&p.id!==caster.id&&p.status!=='alive'&&p.lat&&haversine(caster.lat,caster.lng,p.lat,p.lng)<=10);downed.forEach(p=>revivePlayer(room,p,caster.callsign+' (MEDKIT)'));broadcastTeam(room,team,{type:'perk_anim',perk:'medkit',lat:caster.lat,lng:caster.lng,callsign:caster.callsign,team});return{feedback:downed.length?`Medkit revived ${downed.length} teammate(s).`:'No downed teammates within 10m.'};}},
  air:{teamCd:240,effect(room,caster){const team=caster.team,rem=checkTeamCooldown(room,team,'air');if(rem)return{feedback:`Air support on cooldown — ${rem}s.`,cooldown:true};if(!caster.lat)return{feedback:'No GPS.'};setTeamCooldown(room,team,'air',240);const zone={id:uuidv4(),zoneType:'hazard',label:`🚁 SUPPRESSION FIRE — ${caster.callsign}`,shape:'circle',center:[caster.lat,caster.lng],radius:10,color:'#ff6600',latlngs:[],createdBy:{callsign:caster.callsign},ts:Date.now()};room.zones.push(zone);broadcastAll(room,{type:'zone_added',zone});broadcastTeam(room,team,{type:'perk_anim',perk:'air',lat:caster.lat,lng:caster.lng,callsign:caster.callsign,team});const ord={id:uuidv4(),from:'⭐ AIR CMD',team,text:`🚁 AIR SUPPORT — Suppression fire at ${caster.callsign}'s position!`,priority:'high',ts:Date.now()};room.orders.push(ord);broadcastAll(room,{type:'new_order',order:ord});setTimeout(()=>{room.zones=room.zones.filter(z=>z.id!==zone.id);broadcastAll(room,{type:'zone_removed',id:zone.id});},60000);return{feedback:'Air support called — 10m danger zone for 60s.'};}},
};

wss.on('connection', (ws) => {
  let playerId=null, roomCode=null;
  ws.on('message',(raw)=>{
    let msg; try{msg=JSON.parse(raw);}catch{return;}
    switch(msg.type){
      case 'join':{
        const code=(msg.room||'').toUpperCase().trim();
        const room=rooms[code];
        if(!room){sendTo(ws,{type:'error',code:'ROOM_NOT_FOUND',message:'Map not found.'});break;}
        if(room.password&&room.password!==msg.password){sendTo(ws,{type:'error',code:'WRONG_PASSWORD',message:'Incorrect password.'});break;}
        roomCode=code;playerId=uuidv4();
        const team=['red','blue'].includes(msg.team)?msg.team:'red';
        const reqRole=msg.role||'Assault';
        if(room.allowedRoles&&!room.allowedRoles.includes(reqRole)){sendTo(ws,{type:'error',code:'ROLE_DENIED',message:`${reqRole} is not available in this game mode.`});break;}
        if(room.roleLimits&&room.roleLimits[reqRole]!==undefined){const cc=Object.values(room.players).filter(p=>p.role===reqRole).length;if(cc>=room.roleLimits[reqRole]){sendTo(ws,{type:'error',code:'ROLE_FULL',message:`${reqRole} slots full (max ${room.roleLimits[reqRole]}). Choose another role.`});break;}}
        const player={id:playerId,callsign:(msg.callsign||'SOLDIER').toUpperCase().slice(0,12),team,role:reqRole,status:'alive',lat:null,lng:null,heading:0,lastSeen:Date.now(),joinedAt:Date.now(),ws,rank:msg.commandRank||'soldier',kills:0,deaths:0,revives:0,_username:msg.username||null};
        room.players[playerId]=player;
        if(player._username)recordStat(player._username,'game');
        sendTo(ws,{type:'init',playerId,room:roomSnapshotForTeam(room,team),roomCode});
        broadcastTeam(room,team,{type:'player_joined',player:playerPublic(player)},ws);
        const et=team==='red'?'blue':'red';
        broadcastTeam(room,et,{type:'enemy_count_update',redCount:Object.values(room.players).filter(p=>p.team==='red').length,blueCount:Object.values(room.players).filter(p=>p.team==='blue').length});
        const jm={id:uuidv4(),from:'SYSTEM',text:`📡 ${player.callsign} [${team.toUpperCase()}/${reqRole}] joined.`,priority:'low',ts:Date.now()};
        room.orders.push(jm);broadcastAll(room,{type:'new_order',order:jm});
        logEvent('player_joined',{roomCode,callsign:player.callsign,team,role:reqRole});
        break;
      }
      case 'location':{
        if(!playerId||!roomCode)break;
        const room=rooms[roomCode];if(!room)break;
        const player=room.players[playerId];if(!player)break;
        player.lat=msg.lat;player.lng=msg.lng;player.heading=msg.heading||0;player.lastSeen=Date.now();
        const locMsg={type:'location_update',playerId,lat:msg.lat,lng:msg.lng,heading:msg.heading||0,lastSeen:player.lastSeen};
        broadcastTeam(room,player.team,locMsg,ws);
        const et=player.team==='red'?'blue':'red';
        if(room.uavActive&&room.uavActive[et])broadcastTeam(room,et,locMsg);
        if(player.status==='dead'&&player._bleedExpired&&msg.lat&&msg.lng){
          const rt=player.team==='red'?'respawn_red':'respawn_blue';
          const inZone=room.zones.filter(z=>z.zoneType===rt).some(z=>{if(z.shape==='circle'&&z.center)return haversine(msg.lat,msg.lng,z.center[0],z.center[1])<=z.radius;return false;});
          if(inZone){player._bleedExpired=false;player.status='alive';broadcastAll(room,{type:'status_update',playerId:player.id,status:'alive',team:player.team});sendTo(player.ws,{type:'respawn_zone_revive'});const ord={id:uuidv4(),from:'SYSTEM',team:player.team,text:`🔄 ${player.callsign} reached respawn zone — back in action!`,priority:'normal',ts:Date.now()};room.orders.push(ord);broadcastAll(room,{type:'new_order',order:ord});}
        }
        break;
      }
      case 'status':{
        if(!playerId||!roomCode)break;
        const room=rooms[roomCode];if(!room)break;
        const player=room.players[playerId];if(!player)break;
        if(!['medic','support'].includes(msg.status))break;
        const prev=player.status;player.status=msg.status;
        broadcastAll(room,{type:'status_update',playerId,status:msg.status,team:player.team});
        if(msg.status==='medic'&&prev!=='dead'){
          player.status='dead';player.deaths=(player.deaths||0)+1;
          broadcastAll(room,{type:'status_update',playerId,status:'dead',team:player.team});
          startBleedOut(room,player);startMedicScanner(room);
          if(player._username)recordStat(player._username,'death');
          const alert={id:uuidv4(),from:player.callsign,team:player.team,text:`🚨 MEDIC NEEDED — ${player.callsign} (${player.team.toUpperCase()}) is down! 2 minutes!`,priority:'high',ts:Date.now()};
          room.orders.push(alert);broadcastAll(room,{type:'new_order',order:alert});
          sendTo(ws,{type:'you_are_bleeding',duration:120000});
        }
        if(msg.status==='support'){
          const alert={id:uuidv4(),from:player.callsign,team:player.team,text:`⚡ SUPPORT NEEDED — ${player.callsign} needs backup!`,priority:'high',ts:Date.now()};
          room.orders.push(alert);broadcastAll(room,{type:'new_order',order:alert});
          setTimeout(()=>{if(room.players[playerId]&&room.players[playerId].status==='support'){room.players[playerId].status='alive';broadcastAll(room,{type:'status_update',playerId,status:'alive',team:player.team});sendTo(ws,{type:'support_expired'});}},60000);
        }
        break;
      }
      case 'order':{
        if(!playerId||!roomCode)break;
        const room=rooms[roomCode];if(!room)break;
        const player=room.players[playerId];if(!player)break;
        const order={id:uuidv4(),from:player.callsign,team:player.team,text:msg.text.slice(0,200),priority:msg.priority||'normal',ts:Date.now(),rank:player.rank||'soldier',targetTeam:msg.targetTeam||null};
        room.orders.push(order);if(room.orders.length>300)room.orders.shift();
        if(msg.targetTeam==='all'&&player.rank==='commander')broadcastAll(room,{type:'new_order',order});
        else broadcastTeam(room,player.team,{type:'new_order',order});
        break;
      }
      case 'perk':{
        if(!playerId||!roomCode)break;
        const room=rooms[roomCode];if(!room)break;
        const player=room.players[playerId];if(!player)break;
        if(player.status==='dead'){sendTo(ws,{type:'perk_feedback',perk:msg.perk,message:'Cannot use perks while down.'});break;}
        const cfg=PERK_CONFIGS[msg.perk];if(!cfg)break;
        const result=cfg.effect(room,player);
        sendTo(ws,{type:'perk_feedback',perk:msg.perk,message:result.feedback});
        if(!result.cooldown)logEvent('perk_used',{roomCode,callsign:player.callsign,perk:msg.perk});
        break;
      }
      case 'objective':{
        if(!playerId||!roomCode)break;
        const room=rooms[roomCode];if(!room)break;
        const obj=room.objectives.find(o=>o.id===msg.id);
        if(obj){obj.done=msg.done;if(msg.done)obj.completedBy=room.players[playerId]?.callsign;broadcastAll(room,{type:'objective_update',id:msg.id,done:msg.done,completedBy:obj.completedBy});}
        if(room.gameMode==='Domination'&&msg.done){const t=room.players[playerId]?.team;if(t){room.domScore[t]=(room.domScore[t]||0)+1;broadcastAll(room,{type:'dom_score',score:room.domScore});}}
        if(room.gameMode==='Countdown'){const allDone=room.objectives.length>0&&room.objectives.every(o=>o.done);if(allDone)broadcastAll(room,{type:'game_complete',winner:room.players[playerId]?.team,reason:'All objectives complete!'});}
        break;
      }
      case 'kill_report':{
        if(!playerId||!roomCode)break;
        const room=rooms[roomCode];if(!room)break;
        const shooter=room.players[playerId];if(!shooter)break;
        shooter.kills=(shooter.kills||0)+1;
        if(shooter._username)recordStat(shooter._username,'kill');
        broadcastAll(room,{type:'kill_confirmed',shooter:shooter.callsign,target:msg.target,team:shooter.team});
        const kMsg={id:uuidv4(),from:'⚡ COMBAT',team:shooter.team,text:`💥 ${shooter.callsign} confirmed kill: ${msg.target}`,priority:'normal',ts:Date.now()};
        room.orders.push(kMsg);broadcastAll(room,{type:'new_order',order:kMsg});
        break;
      }
      case 'admin_observe':{
        const obsCode=(msg.room||'').toUpperCase().trim();
        const session=msg.token&&adminSessions.get(msg.token);
        if(!session){sendTo(ws,{type:'error',message:'Unauthorized'});break;}
        if(!canAccessRoom(session,obsCode)){sendTo(ws,{type:'error',message:'No access'});break;}
        const obsRoom=rooms[obsCode];if(!obsRoom){sendTo(ws,{type:'error',message:'Map not found'});break;}
        obsRoom.adminObservers.add(ws);roomCode=obsCode;playerId='__admin_'+uuidv4();
        sendTo(ws,{type:'init',playerId:'__admin__',roomCode:obsCode,room:{players:Object.values(obsRoom.players).map(playerPublic),orders:obsRoom.orders.slice(-100),objectives:obsRoom.objectives,zones:obsRoom.zones,mapTiles:obsRoom.mapTiles,gamePaused:obsRoom.gamePaused,roomName:obsRoom.name,gameMode:obsRoom.gameMode,gameModeConfig:obsRoom.gameModeConfig,gameTimer:obsRoom.gameTimer,safeZone:obsRoom.safeZone,domScore:obsRoom.domScore}});
        logEvent('admin_observe_start',{code:obsCode,admin:session.username});
        break;
      }
    }
  });
  ws.on('close',()=>{
    if(!playerId||!roomCode)return;
    const room=rooms[roomCode];if(!room)return;
    if(room.adminObservers)room.adminObservers.delete(ws);
    const player=room.players[playerId];
    if(player){const m={id:uuidv4(),from:'SYSTEM',text:`📴 ${player.callsign} disconnected.`,priority:'low',ts:Date.now()};room.orders.push(m);delete room.players[playerId];broadcastAll(room,{type:'player_left',playerId});broadcastAll(room,{type:'new_order',order:m});}
  });
  ws.on('error',()=>{});
});

// Public endpoints
app.get('/health',(_, res)=>res.json({status:'ok',rooms:Object.keys(rooms).length,players:Object.keys(playerAccounts).length,uptime:Math.floor(process.uptime())}));
app.get('/api/zone-types',(_, res)=>res.json(ZONE_TYPES));
app.get('/api/game-modes',(_, res)=>res.json(GAME_MODES));
app.get('/api/roles',(_, res)=>res.json(ALL_ROLES));
app.get('/api/maps',(_, res)=>res.json(Object.values(rooms).map(r=>({code:r.code,name:r.name,hasPassword:!!r.password,playerCount:Object.keys(r.players).length,redCount:Object.values(r.players).filter(p=>p.team==='red').length,blueCount:Object.values(r.players).filter(p=>p.team==='blue').length,allowedRoles:r.allowedRoles||null,roleLimits:r.roleLimits||null,gameMode:r.gameMode||'Standard',gameModeConfig:r.gameModeConfig||{}}))));
app.get('/api/leaderboard',(_, res)=>res.json(Object.values(playerStats).map(s=>({callsign:playerAccounts[s.username]?.callsign||s.username,username:s.username,rank:s.rank||'Recruit',xp:s.xp||0,kills:s.kills||0,deaths:s.deaths||0,revives:s.revives||0,gamesPlayed:s.gamesPlayed||0,wins:s.wins||0,kd:s.deaths>0?((s.kills||0)/s.deaths).toFixed(2):(s.kills||0).toFixed(2)})).sort((a,b)=>b.xp-a.xp).slice(0,50)));

// Player auth
const playerSessions = new Map();
function hashPass(p){return Buffer.from(p.split('').map((c,i)=>c.charCodeAt(0)^(i%7+13)).join(',')).toString('base64');}

app.post('/api/player/register',(req,res)=>{
  const{username,password,email,phone,address,callsign}=req.body;
  if(!username||!password)return res.status(400).json({error:'Username and password required'});
  if(password.length<6)return res.status(400).json({error:'Password must be at least 6 characters'});
  if(playerAccounts[username.toLowerCase()])return res.status(409).json({error:'Username already taken'});
  const account={username:username.toLowerCase(),displayName:callsign||username,passwordHash:hashPass(password),email:email||'',phone:phone||'',address:address||'',callsign:(callsign||username).toUpperCase().slice(0,12),avatar:null,bio:'',clubId:null,createdAt:Date.now(),lastLogin:null};
  playerAccounts[account.username]=account;
  getStats(account.username);
  persist('player-accounts',account.username,account).catch(()=>{});
  persist('player-stats',account.username,playerStats[account.username]).catch(()=>{});
  logEvent('player_registered',{username:account.username});
  const token=uuidv4();playerSessions.set(token,{username:account.username,callsign:account.callsign});
  setTimeout(()=>playerSessions.delete(token),24*60*60*1000);
  res.json({token,callsign:account.callsign,username:account.username});
});
app.post('/api/player/login',(req,res)=>{
  const{username,password}=req.body;
  const account=playerAccounts[username?.toLowerCase()];
  if(!account||account.passwordHash!==hashPass(password))return res.status(401).json({error:'Invalid username or password'});
  account.lastLogin=Date.now();persist('player-accounts',account.username,account).catch(()=>{});
  const token=uuidv4();playerSessions.set(token,{username:account.username,callsign:account.callsign,email:account.email});
  setTimeout(()=>playerSessions.delete(token),24*60*60*1000);
  logEvent('player_login',{username:account.username});
  res.json({token,callsign:account.callsign,username:account.username,email:account.email,phone:account.phone});
});
app.get('/api/player/me',(req,res)=>{
  const sess=playerSessions.get(req.headers['x-player-token']);
  if(!sess)return res.status(401).json({error:'Not logged in'});
  const account=playerAccounts[sess.username];if(!account)return res.status(404).json({error:'Not found'});
  const stats=getStats(sess.username);
  const club=account.clubId?clubs[account.clubId]:null;
  res.json({username:account.username,callsign:account.callsign,email:account.email,phone:account.phone,address:account.address,bio:account.bio||'',avatar:account.avatar||null,createdAt:account.createdAt,stats,club:club?{id:account.clubId,name:club.name,tag:club.tag}:null});
});
app.put('/api/player/me',(req,res)=>{
  const sess=playerSessions.get(req.headers['x-player-token']);
  if(!sess)return res.status(401).json({error:'Not logged in'});
  const account=playerAccounts[sess.username];if(!account)return res.status(404).json({error:'Not found'});
  const{callsign,email,phone,address,password,newPassword,bio}=req.body;
  if(password&&newPassword){if(account.passwordHash!==hashPass(password))return res.status(401).json({error:'Wrong current password'});account.passwordHash=hashPass(newPassword);}
  if(callsign){account.callsign=callsign.toUpperCase().slice(0,12);sess.callsign=account.callsign;}
  if(email!==undefined)account.email=email;if(phone!==undefined)account.phone=phone;if(address!==undefined)account.address=address;if(bio!==undefined)account.bio=bio.slice(0,200);
  persist('player-accounts',account.username,account).catch(()=>{});
  res.json({ok:true,callsign:account.callsign});
});
app.get('/api/player/profile/:username',(req,res)=>{
  const account=playerAccounts[req.params.username.toLowerCase()];
  if(!account)return res.status(404).json({error:'Not found'});
  const stats=getStats(req.params.username.toLowerCase());
  const club=account.clubId?clubs[account.clubId]:null;
  res.json({callsign:account.callsign,username:account.username,bio:account.bio||'',createdAt:account.createdAt,stats,club:club?{name:club.name,tag:club.tag}:null});
});

// Clubs
app.get('/api/clubs',(_, res)=>res.json(Object.values(clubs).map(c=>({id:c.id,name:c.name,tag:c.tag,description:c.description||'',memberCount:(c.members||[]).length,ownerId:c.ownerId,createdAt:c.createdAt}))));
app.post('/api/clubs',playerAuth,(req,res)=>{
  const{name,tag,description}=req.body;
  if(!name||!tag)return res.status(400).json({error:'Name and tag required'});
  if(tag.length>5)return res.status(400).json({error:'Tag max 5 chars'});
  if(Object.values(clubs).find(c=>c.tag.toUpperCase()===tag.toUpperCase()))return res.status(409).json({error:'Tag already in use'});
  const account=playerAccounts[req.playerSession.username];
  if(account.clubId)return res.status(400).json({error:'Already in a club. Leave first.'});
  const id=uuidv4();
  clubs[id]={id,name,tag:tag.toUpperCase(),description:description||'',ownerId:req.playerSession.username,members:[req.playerSession.username],createdAt:Date.now()};
  account.clubId=id;
  persist('clubs',id,clubs[id]).catch(()=>{});persist('player-accounts',account.username,account).catch(()=>{});
  res.json({ok:true,club:clubs[id]});
});
app.post('/api/clubs/:id/join',playerAuth,(req,res)=>{
  const club=clubs[req.params.id];if(!club)return res.status(404).json({error:'Club not found'});
  const account=playerAccounts[req.playerSession.username];
  if(account.clubId)return res.status(400).json({error:'Already in a club'});
  if(!club.members)club.members=[];club.members.push(req.playerSession.username);account.clubId=club.id;
  persist('clubs',club.id,club).catch(()=>{});persist('player-accounts',account.username,account).catch(()=>{});
  res.json({ok:true});
});
app.post('/api/clubs/:id/leave',playerAuth,(req,res)=>{
  const club=clubs[req.params.id];if(!club)return res.status(404).json({error:'Club not found'});
  const account=playerAccounts[req.playerSession.username];
  club.members=(club.members||[]).filter(m=>m!==req.playerSession.username);account.clubId=null;
  if(club.ownerId===req.playerSession.username&&club.members.length>0)club.ownerId=club.members[0];
  if(club.members.length===0){delete clubs[club.id];persistDel('clubs',club.id).catch(()=>{});}
  else persist('clubs',club.id,club).catch(()=>{});
  persist('player-accounts',account.username,account).catch(()=>{});
  res.json({ok:true});
});

// Admin auth
app.post('/api/admin/login',(req,res)=>{
  const{username,password}=req.body;let session=null;
  if(username===SUPER_ADMIN_USER&&password===SUPER_ADMIN_PASS)session={username,role:'super',managedSites:[]};
  else if(siteAdmins[username]&&siteAdmins[username].password===password)session={username,role:'site',managedSites:siteAdmins[username].sites||[],name:siteAdmins[username].name};
  if(!session){logEvent('admin_login_fail',{username,ip:req.ip});return res.status(401).json({error:'Invalid credentials'});}
  const token=uuidv4();adminSessions.set(token,session);setTimeout(()=>adminSessions.delete(token),8*60*60*1000);
  logEvent('admin_login',{username,role:session.role,ip:req.ip});
  res.json({token,role:session.role,username,name:session.name||username});
});
app.post('/api/admin/logout',adminAuth,(req,res)=>{adminSessions.delete(req.headers['x-admin-token']);res.json({ok:true});});
app.post('/api/admin/change-password',adminAuth,(req,res)=>{
  const sess=req.adminSession;const{currentPassword,newPassword}=req.body;
  if(!newPassword||newPassword.length<6)return res.status(400).json({error:'Min 6 characters'});
  if(sess.role==='super'){if(currentPassword!==SUPER_ADMIN_PASS)return res.status(401).json({error:'Wrong password'});process.env.ADMIN_PASS=newPassword;return res.json({ok:true});}
  const sa=siteAdmins[sess.username];if(!sa)return res.status(404).json({error:'Not found'});
  if(currentPassword!==sa.password)return res.status(401).json({error:'Wrong password'});
  sa.password=newPassword;persist('site-admins',sess.username,sa).catch(()=>{});res.json({ok:true});
});

// Site admins
app.get('/api/admin/site-admins',superAdminAuth,(_, res)=>res.json(Object.entries(siteAdmins).map(([u,d])=>({username:u,name:d.name,sites:d.sites}))));
app.post('/api/admin/site-admins',superAdminAuth,(req,res)=>{const{username,password,name,sites}=req.body;if(!username||!password)return res.status(400).json({error:'Required'});siteAdmins[username]={password,name:name||username,sites:sites||[]};persist('site-admins',username,siteAdmins[username]).catch(()=>{});logEvent('site_admin_created',{username});res.json({ok:true});});
app.put('/api/admin/site-admins/:username',superAdminAuth,(req,res)=>{const u=req.params.username;if(!siteAdmins[u])return res.status(404).json({error:'Not found'});const{password,name,sites}=req.body;if(password)siteAdmins[u].password=password;if(name)siteAdmins[u].name=name;if(sites)siteAdmins[u].sites=sites;persist('site-admins',u,siteAdmins[u]).catch(()=>{});res.json({ok:true});});
app.delete('/api/admin/site-admins/:username',superAdminAuth,(req,res)=>{delete siteAdmins[req.params.username];persistDel('site-admins',req.params.username).catch(()=>{});saveJSON('site-admins.json',siteAdmins);res.json({ok:true});});

// Rooms
app.get('/api/admin/rooms',adminAuth,(req,res)=>{const sess=req.adminSession;const list=Object.values(rooms).filter(r=>sess.role==='super'||sess.managedSites.includes(r.code));res.json(list.map(r=>({code:r.code,name:r.name,hasPassword:!!r.password,playerCount:Object.keys(r.players).length,redCount:Object.values(r.players).filter(p=>p.team==='red').length,blueCount:Object.values(r.players).filter(p=>p.team==='blue').length,players:Object.values(r.players).map(playerPublic),objectives:r.objectives,zones:r.zones,orderCount:r.orders.length,createdAt:r.createdAt,gamePaused:r.gamePaused,mapTiles:r.mapTiles,activeMapId:r.activeMapId,allowedRoles:r.allowedRoles,roleLimits:r.roleLimits||null,gameMode:r.gameMode||'Standard',gameModeConfig:r.gameModeConfig||{},gameTimer:r.gameTimer||null,safeZone:r.safeZone||null,domScore:r.domScore||{red:0,blue:0}})));});
app.post('/api/admin/rooms',adminAuth,(req,res)=>{
  const{code,name,password,gameMode,gameModeConfig}=req.body;
  const c=(code||uuidv4().slice(0,6)).toUpperCase();
  if(req.adminSession.role!=='super'&&rooms[c]&&!canAccessRoom(req.adminSession,c))return res.status(403).json({error:'Code in use'});
  const room=getOrCreateRoom(c,name||c,password||'');
  if(name)room.name=name;if(password!==undefined)room.password=password;
  if(gameMode){room.gameMode=gameMode;const defaults=DEFAULT_ROLE_LIMITS[gameMode];if(defaults&&Object.keys(defaults).length>0&&!room.roleLimits)room.roleLimits={...defaults};}
  if(gameModeConfig)room.gameModeConfig=gameModeConfig;
  if(req.adminSession.role==='site'){const sa=siteAdmins[req.adminSession.username];if(sa&&!sa.sites.includes(c)){sa.sites.push(c);persist('site-admins',req.adminSession.username,sa).catch(()=>{});}}
  persistRoomTemplate(room).catch(()=>{});
  res.json({code:room.code,name:room.name,gameMode:room.gameMode});
});
app.put('/api/admin/rooms/:code',adminAuth,(req,res)=>{
  const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});
  if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});
  const{name,password,allowedRoles,roleLimits,gameMode,gameModeConfig}=req.body;
  if(name!==undefined){room.name=name;broadcastAll(room,{type:'room_renamed',name});}
  if(password!==undefined)room.password=password;
  if(allowedRoles!==undefined)room.allowedRoles=allowedRoles;
  if(roleLimits!==undefined)room.roleLimits=roleLimits;
  if(gameMode!==undefined){room.gameMode=gameMode;broadcastAll(room,{type:'game_mode_changed',gameMode,gameModeConfig:gameModeConfig||{}});}
  if(gameModeConfig!==undefined)room.gameModeConfig=gameModeConfig;
  persistRoomTemplate(room).catch(()=>{});res.json({ok:true});
});
app.get('/api/admin/rooms/:code',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});res.json({code:room.code,name:room.name,hasPassword:!!room.password,players:Object.values(room.players).map(playerPublic),orders:room.orders,objectives:room.objectives,zones:room.zones,gamePaused:room.gamePaused,createdAt:room.createdAt,mapTiles:room.mapTiles,gameMode:room.gameMode,gameModeConfig:room.gameModeConfig,allowedRoles:room.allowedRoles,roleLimits:room.roleLimits});});
app.get('/api/admin/rooms/:code/live',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});res.json({players:Object.values(room.players).map(playerPublic),zones:room.zones,objectives:room.objectives,mapTiles:room.mapTiles,gamePaused:room.gamePaused,roomName:room.name,gameMode:room.gameMode,domScore:room.domScore,gameTimer:room.gameTimer,allowedRoles:room.allowedRoles,roleLimits:room.roleLimits});});
app.delete('/api/admin/rooms/:code',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});broadcastAll(room,{type:'kicked',reason:'Map closed by admin'});deleteRoomTemplate(req.params.code.toUpperCase()).catch(()=>{});delete rooms[req.params.code.toUpperCase()];logEvent('room_deleted',{code:req.params.code});res.json({ok:true});});
app.post('/api/admin/rooms/:code/pause',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});room.gamePaused=true;const msg={id:uuidv4(),from:'⭐ ADMIN',text:'⏸ GAME PAUSED — Hold all positions.',priority:'high',ts:Date.now()};room.orders.push(msg);broadcastAll(room,{type:'game_paused'});broadcastAll(room,{type:'new_order',order:msg});res.json({ok:true});});
app.post('/api/admin/rooms/:code/resume',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});room.gamePaused=false;const msg={id:uuidv4(),from:'⭐ ADMIN',text:'▶ GAME RESUMED — Engage!',priority:'high',ts:Date.now()};room.orders.push(msg);broadcastAll(room,{type:'game_resumed'});broadcastAll(room,{type:'new_order',order:msg});res.json({ok:true});});
app.post('/api/admin/rooms/:code/reset',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});Object.values(room.players).forEach(p=>{if(p._bleedTimer)clearTimeout(p._bleedTimer);p.status='alive';p.bleedingOut=false;p._bleedExpired=false;p.kills=0;p.deaths=0;p.revives=0;});room.domScore={red:0,blue:0};room.gameTimer=null;room.teamCooldowns={red:{},blue:{}};broadcastAll(room,{type:'game_reset'});const msg={id:uuidv4(),from:'⭐ ADMIN',text:'🔄 GAME RESET — All players respawned. Scores cleared.',priority:'high',ts:Date.now()};room.orders.push(msg);broadcastAll(room,{type:'new_order',order:msg});res.json({ok:true});});

// Timer
app.post('/api/admin/rooms/:code/timer',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});const{minutes,action}=req.body;if(action==='start'){const endsAt=Date.now()+(minutes||30)*60*1000;room.gameTimer={endsAt,startedAt:Date.now(),durationMs:(minutes||30)*60*1000};broadcastAll(room,{type:'game_timer_start',endsAt,durationMs:room.gameTimer.durationMs});const msg={id:uuidv4(),from:'⭐ ADMIN',text:`⏱ GAME TIMER STARTED — ${minutes||30} minutes!`,priority:'high',ts:Date.now()};room.orders.push(msg);broadcastAll(room,{type:'new_order',order:msg});setTimeout(()=>{if(room.gameTimer&&room.gameTimer.endsAt===endsAt){broadcastAll(room,{type:'game_timer_end'});const end={id:uuidv4(),from:'⭐ ADMIN',text:'⏱ TIME UP — Game over!',priority:'high',ts:Date.now()};room.orders.push(end);broadcastAll(room,{type:'new_order',order:end});}},(minutes||30)*60*1000);}else if(action==='stop'){room.gameTimer=null;broadcastAll(room,{type:'game_timer_end'});}res.json({ok:true});});

// Safezone
app.post('/api/admin/rooms/:code/safezone',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});room.safeZone=req.body.safeZone;broadcastAll(room,{type:'safezone_update',safeZone:room.safeZone});res.json({ok:true});});

// Objectives
app.post('/api/admin/rooms/:code/objectives',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});const obj={id:uuidv4(),text:req.body.text.slice(0,100),team:req.body.team||'all',lat:req.body.lat||null,lng:req.body.lng||null,done:false,createdAt:Date.now()};room.objectives.push(obj);broadcastAll(room,{type:'objective_added',objective:obj});persistRoomTemplate(room).catch(()=>{});res.json(obj);});
app.put('/api/admin/rooms/:code/objectives/:objId',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});const obj=room.objectives.find(o=>o.id===req.params.objId);if(!obj)return res.status(404).json({error:'Not found'});if(req.body.text!==undefined)obj.text=req.body.text.slice(0,100);if(req.body.team!==undefined)obj.team=req.body.team;if(req.body.lat!==undefined)obj.lat=req.body.lat;if(req.body.lng!==undefined)obj.lng=req.body.lng;if(req.body.done!==undefined)obj.done=req.body.done;broadcastAll(room,{type:'objective_updated',objective:obj});persistRoomTemplate(room).catch(()=>{});res.json(obj);});
app.delete('/api/admin/rooms/:code/objectives/:objId',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});room.objectives=room.objectives.filter(o=>o.id!==req.params.objId);broadcastAll(room,{type:'objective_removed',id:req.params.objId});persistRoomTemplate(room).catch(()=>{});res.json({ok:true});});

// Zones
app.post('/api/admin/rooms/:code/zones',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});const zone={id:uuidv4(),zoneType:req.body.zoneType||'custom',label:req.body.label||'Zone',shape:req.body.shape,latlngs:req.body.latlngs||[],center:req.body.center||null,radius:req.body.radius||null,color:ZONE_TYPES[req.body.zoneType]?.color||req.body.color||'#cc44ff',team:req.body.team||'all',createdBy:{callsign:req.adminSession.username},ts:Date.now()};room.zones.push(zone);broadcastAll(room,{type:'zone_added',zone});persistRoomTemplate(room).catch(()=>{});res.json(zone);});
app.delete('/api/admin/rooms/:code/zones/:zid',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});room.zones=room.zones.filter(z=>z.id!==req.params.zid);broadcastAll(room,{type:'zone_removed',id:req.params.zid});persistRoomTemplate(room).catch(()=>{});res.json({ok:true});});
app.delete('/api/admin/rooms/:code/zones',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});room.zones=[];broadcastAll(room,{type:'zones_cleared'});persistRoomTemplate(room).catch(()=>{});res.json({ok:true});});

// Saved maps
app.get('/api/admin/saved-maps',adminAuth,(req,res)=>{const sess=req.adminSession;const maps=Object.values(savedMaps).filter(m=>sess.role==='super'||sess.managedSites.includes(m.siteCode)||m.createdBy===sess.username);res.json(maps.map(m=>({id:m.id,name:m.name,gameType:m.gameType||'Standard',siteCode:m.siteCode,zoneCount:(m.zones||[]).length,objectiveCount:(m.objectives||[]).length,createdAt:m.createdAt,createdBy:m.createdBy,allowedRoles:m.allowedRoles||null,roleLimits:m.roleLimits||null})));});
app.post('/api/admin/saved-maps',adminAuth,(req,res)=>{const{name,siteCode,zones,objectives,gameType,allowedRoles,roleLimits}=req.body;if(!name)return res.status(400).json({error:'Name required'});if(req.adminSession.role!=='super'&&siteCode&&!req.adminSession.managedSites.includes(siteCode))return res.status(403).json({error:'No access to that site'});const map={id:uuidv4(),name,siteCode:siteCode||'',gameType:gameType||'Standard',zones:zones||[],objectives:objectives||[],allowedRoles:allowedRoles||null,roleLimits:roleLimits||(gameType&&DEFAULT_ROLE_LIMITS[gameType]&&Object.keys(DEFAULT_ROLE_LIMITS[gameType]).length?DEFAULT_ROLE_LIMITS[gameType]:null),createdBy:req.adminSession.username,createdAt:Date.now()};savedMaps[map.id]=map;persist('saved-maps',map.id,map).catch(()=>{});logEvent('map_saved',{name,by:req.adminSession.username});res.json(map);});
app.put('/api/admin/saved-maps/:id',adminAuth,(req,res)=>{const map=savedMaps[req.params.id];if(!map)return res.status(404).json({error:'Not found'});if(req.adminSession.role!=='super'&&map.siteCode&&!req.adminSession.managedSites.includes(map.siteCode))return res.status(403).json({error:'No access'});const{name,zones,objectives,gameType,allowedRoles,roleLimits}=req.body;if(name)map.name=name;if(zones)map.zones=zones;if(objectives)map.objectives=objectives;if(gameType)map.gameType=gameType;if(allowedRoles!==undefined)map.allowedRoles=allowedRoles;if(roleLimits!==undefined)map.roleLimits=roleLimits;map.updatedAt=Date.now();persist('saved-maps',map.id,map).catch(()=>{});res.json(map);});
app.delete('/api/admin/saved-maps/:id',adminAuth,(req,res)=>{const map=savedMaps[req.params.id];if(!map)return res.status(404).json({error:'Not found'});if(req.adminSession.role!=='super'&&map.siteCode&&!req.adminSession.managedSites.includes(map.siteCode))return res.status(403).json({error:'No access'});delete savedMaps[req.params.id];persistDel('saved-maps',req.params.id).catch(()=>{});saveJSON('saved-maps.json',savedMaps);res.json({ok:true});});

// Load map — auto-applies variant role config
app.post('/api/admin/rooms/:code/load-map/:mapId',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Room not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});const map=savedMaps[req.params.mapId];if(!map)return res.status(404).json({error:'Map not found'});room.zones=map.zones.map(z=>({...z,id:uuidv4(),ts:Date.now()}));room.objectives=map.objectives.map(o=>({...o,id:uuidv4(),done:false}));room.activeMapId=req.params.mapId;if(map.allowedRoles!==undefined)room.allowedRoles=map.allowedRoles;if(map.roleLimits!==undefined)room.roleLimits=map.roleLimits;if(map.gameType)room.gameMode=map.gameType;broadcastAll(room,{type:'map_loaded',zones:room.zones,objectives:room.objectives,mapName:map.name,gameMode:room.gameMode,roleLimits:room.roleLimits});persistRoomTemplate(room).catch(()=>{});logEvent('map_loaded',{room:room.code,map:map.name});res.json({ok:true,message:`Map "${map.name}" loaded with ${map.gameType||'Standard'} role config.`});});

// Admin perks / players
app.post('/api/admin/rooms/:code/kick/:pid',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});const player=room.players[req.params.pid];if(!player)return res.status(404).json({error:'Player not found'});sendTo(player.ws,{type:'kicked',reason:req.body.reason||'Removed by admin'});if(player.ws)player.ws.close();res.json({ok:true});});
app.post('/api/admin/rooms/:code/broadcast',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});const order={id:uuidv4(),from:'⭐ ADMIN',text:req.body.text.slice(0,200),priority:req.body.priority||'high',ts:Date.now()};room.orders.push(order);broadcastAll(room,{type:'new_order',order});res.json({ok:true});});
app.post('/api/admin/broadcast-all',superAdminAuth,(req,res)=>{for(const room of Object.values(rooms)){const order={id:uuidv4(),from:'⭐ ADMIN',text:req.body.text.slice(0,200),priority:'high',ts:Date.now()};room.orders.push(order);broadcastAll(room,{type:'new_order',order});}res.json({ok:true});});
app.post('/api/admin/rooms/:code/respawn-player',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});const player=room.players[req.body.playerId];if(!player)return res.status(404).json({error:'Player not found'});if(player._bleedTimer){clearTimeout(player._bleedTimer);player._bleedTimer=null;}player.status='alive';player.bleedingOut=false;player._bleedExpired=false;broadcastAll(room,{type:'status_update',playerId:player.id,status:'alive',team:player.team});sendTo(player.ws,{type:'respawn_zone_revive'});const msg={id:uuidv4(),from:'⭐ ADMIN',team:player.team,text:`🔄 ${player.callsign} respawned by admin.`,priority:'normal',ts:Date.now()};room.orders.push(msg);broadcastAll(room,{type:'new_order',order:msg});res.json({ok:true});});
app.post('/api/admin/rooms/:code/perk',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});const{perk,team,lat,lng}=req.body;switch(perk){case'intel_drop':{const enemies=Object.values(room.players).filter(p=>p.team!==team);broadcastTeam(room,team,{type:'uav_reveal',reveals:enemies.map(playerPublic),duration:30000,callsign:'ADMIN INTEL'});setTimeout(()=>broadcastTeam(room,team,{type:'uav_expired'}),30000);return res.json({ok:true,message:`Intel drop — ${enemies.length} contacts revealed.`});}case'blackout':{broadcastAll(room,{type:'blackout',duration:20000});setTimeout(()=>broadcastAll(room,{type:'blackout_end'}),20000);const msg={id:uuidv4(),from:'⭐ ADMIN',text:'⚫ BLACKOUT — All GPS maps offline for 20s!',priority:'high',ts:Date.now()};room.orders.push(msg);broadcastAll(room,{type:'new_order',order:msg});return res.json({ok:true,message:'Blackout deployed.'});}case'flare':{if(!lat||!lng)return res.status(400).json({error:'lat/lng required'});const zone={id:uuidv4(),zoneType:'custom',label:'🔴 ADMIN FLARE',shape:'circle',center:[lat,lng],radius:10,color:'#ff0000',latlngs:[],createdBy:{callsign:'ADMIN'},ts:Date.now()};room.zones.push(zone);broadcastAll(room,{type:'zone_added',zone});broadcastAll(room,{type:'perk_anim',perk:'flare',lat,lng,callsign:'ADMIN',team:'admin'});setTimeout(()=>{room.zones=room.zones.filter(z=>z.id!==zone.id);broadcastAll(room,{type:'zone_removed',id:zone.id});},120000);return res.json({ok:true,message:'Flare placed for 2 minutes.'});}case'ceasefire':{broadcastAll(room,{type:'ceasefire_signal'});const msg={id:uuidv4(),from:'⭐ ADMIN',text:'🕊 CEASEFIRE SIGNAL — All hostilities cease immediately!',priority:'high',ts:Date.now()};room.orders.push(msg);broadcastAll(room,{type:'new_order',order:msg});return res.json({ok:true,message:'Ceasefire signal sent.'});}case'eliminate_team':{Object.values(room.players).filter(p=>p.team===team).forEach(p=>{p.status='dead';broadcastAll(room,{type:'status_update',playerId:p.id,status:'dead',team:p.team});});return res.json({ok:true,message:`${team.toUpperCase()} team eliminated.`});}default:return res.status(400).json({error:'Unknown perk'});}});
app.post('/api/admin/rooms/:code/ceasefire-end',adminAuth,(req,res)=>{const room=rooms[req.params.code.toUpperCase()];if(!room)return res.status(404).json({error:'Not found'});if(!canAccessRoom(req.adminSession,room.code))return res.status(403).json({error:'No access'});broadcastAll(room,{type:'ceasefire_end'});const msg={id:uuidv4(),from:'⭐ ADMIN',text:'⚔ CEASEFIRE ENDED — Hostilities may resume!',priority:'high',ts:Date.now()};room.orders.push(msg);broadcastAll(room,{type:'new_order',order:msg});res.json({ok:true});});
app.get('/api/admin/events',adminAuth,(_, res)=>res.json(eventLog.slice(-200).reverse()));
app.get('/api/admin/player-accounts',superAdminAuth,(req,res)=>res.json(Object.values(playerAccounts).map(a=>({username:a.username,callsign:a.callsign,email:a.email,phone:a.phone,createdAt:a.createdAt,lastLogin:a.lastLogin,clubId:a.clubId,stats:playerStats[a.username]||null}))));
app.get('/api/admin/export',superAdminAuth,(_, res)=>{res.setHeader('Content-Disposition','attachment; filename="zgt-backup-'+Date.now()+'.json"');res.json({exportedAt:new Date().toISOString(),version:3,roomTemplates,savedMaps,siteAdmins:Object.fromEntries(Object.entries(siteAdmins).map(([k,v])=>[k,{...v,password:'[REDACTED]'}])),playerAccounts:Object.fromEntries(Object.entries(playerAccounts||{}).map(([k,v])=>[k,{...v,passwordHash:'[REDACTED]'}])),clubs,stats:{rooms:Object.keys(roomTemplates).length,maps:Object.keys(savedMaps).length,players:Object.keys(playerAccounts||{}).length,clubs:Object.keys(clubs).length}});});
app.post('/api/admin/import',superAdminAuth,async(req,res)=>{const data=req.body;if(!data||(data.version!==2&&data.version!==3))return res.status(400).json({error:'Invalid backup (requires v2/v3)'});let imported={rooms:0,maps:0,siteAdmins:0,players:0};if(data.roomTemplates){for(const[code,tmpl]of Object.entries(data.roomTemplates)){roomTemplates[code]=tmpl;await persist('room-templates',code,tmpl);if(!rooms[code]){const room=makeRoom(code,tmpl.name,tmpl.password);room.zones=tmpl.zones||[];room.objectives=tmpl.objectives||[];room.allowedRoles=tmpl.allowedRoles||null;room.roleLimits=tmpl.roleLimits||null;room.gameMode=tmpl.gameMode||'Standard';rooms[code]=room;}}saveJSON('room-templates.json',roomTemplates);imported.rooms=Object.keys(data.roomTemplates).length;}if(data.savedMaps){for(const[id,map]of Object.entries(data.savedMaps)){savedMaps[id]=map;await persist('saved-maps',id,map);}saveJSON('saved-maps.json',savedMaps);imported.maps=Object.keys(data.savedMaps).length;}if(data.siteAdmins){for(const[u,admin]of Object.entries(data.siteAdmins)){if(admin.password&&admin.password!=='[REDACTED]'){siteAdmins[u]=admin;await persist('site-admins',u,admin);}}saveJSON('site-admins.json',siteAdmins);imported.siteAdmins=Object.keys(data.siteAdmins).length;}if(data.playerAccounts){for(const[u,acct]of Object.entries(data.playerAccounts)){if(acct.passwordHash&&acct.passwordHash!=='[REDACTED]'){playerAccounts[u]=acct;await persist('player-accounts',u,acct);}}saveJSON('player-accounts.json',playerAccounts);imported.players=Object.keys(data.playerAccounts).length;}logEvent('data_imported',{imported,by:'super'});res.json({ok:true,imported});});

app.get('/admin*',(_, res)=>res.sendFile(path.join(__dirname,'../public/admin.html')));
app.get('*',(_, res)=>res.sendFile(path.join(__dirname,'../public/index.html')));

const PORT=process.env.PORT||3000;
initDB().then(()=>{
  server.listen(PORT,()=>{
    const storage=process.env.DATABASE_URL?'🐘 PostgreSQL':'📁 File storage';
    console.log(`🎯 Zulu's Game Tracker v2.0 — port ${PORT} — ${storage}`);
    console.log(`   Players: ${Object.keys(playerAccounts).length} | Maps: ${Object.keys(roomTemplates).length} | Saved: ${Object.keys(savedMaps).length} | Clubs: ${Object.keys(clubs).length}`);
  });
}).catch(err=>{console.error('Startup error:',err);process.exit(1);});
