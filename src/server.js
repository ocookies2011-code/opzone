const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Credentials ───────────────────────────────────────────────────
const SUPER_ADMIN_USER = process.env.ADMIN_USER || 'chriszulu';
const SUPER_ADMIN_PASS = process.env.ADMIN_PASS || 'SwindonA1rsoft!';
const adminSessions = new Map(); // token → { username, role, managedSites }
const siteAdmins = {}; // username → { password, sites: [siteCode], name }

// ── Persistent storage (in-memory, survives per process) ──────────
const savedMaps = {}; // mapId → { id, name, siteCode, zones, objectives, createdBy, createdAt }
const rooms = {};     // roomCode → room object
const eventLog = [];

function logEvent(type, data) {
  eventLog.push({ type, data, ts: Date.now() });
  if (eventLog.length > 1000) eventLog.shift();
}

const ZONE_TYPES = {
  respawn_red:  { label: 'Red Respawn',    color: '#ff4444', fillOpacity: 0.18 },
  respawn_blue: { label: 'Blue Respawn',   color: '#4488ff', fillOpacity: 0.18 },
  objective:    { label: 'Objective',      color: '#ffaa00', fillOpacity: 0.20 },
  hazard:       { label: 'Hazard Zone',    color: '#ff2a2a', fillOpacity: 0.15 },
  safe:         { label: 'Safe Zone',      color: '#00cc66', fillOpacity: 0.12 },
  boundary:     { label: 'Game Boundary',  color: '#e8c84a', fillOpacity: 0.05 },
  custom:       { label: 'Custom Zone',    color: '#cc44ff', fillOpacity: 0.15 },
};

function makeRoom(code, name, password) {
  return {
    code,
    name: name || code,
    password: password || '',
    players: {},
    adminObservers: new Set(),
    orders: [
      { id: uuidv4(), from: 'SYSTEM', text: `🎯 Swindon Airsoft — ${name||code} is active. Stand by.`, priority: 'normal', ts: Date.now() }
    ],
    objectives: [],
    zones: [],
    mapTiles: 'osm',
    activeMapId: null,
    createdAt: Date.now(),
    gamePaused: false,
    uavActive: {},
  };
}

function getOrCreateRoom(code, name, password) {
  if (!rooms[code]) {
    rooms[code] = makeRoom(code, name, password);
    logEvent('room_created', { code, name });
  }
  return rooms[code];
}

// Room cleanup
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    const active = Object.values(room.players).some(p => p.ws && p.ws.readyState === WebSocket.OPEN);
    if (!active && now - room.createdAt > 3600_000) {
      delete rooms[code];
      logEvent('room_expired', { code });
    }
  }
}, 600_000);

// ── Broadcast helpers ─────────────────────────────────────────────
function sendTo(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastTeam(room, team, msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  for (const p of Object.values(room.players)) {
    if (team && p.team !== team) continue;
    if (p.ws && p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
  // Admin observers always get everything
  if (room.adminObservers) {
    for (const ows of room.adminObservers) {
      if (ows !== excludeWs && ows.readyState === WebSocket.OPEN) ows.send(data);
    }
  }
}
function broadcastAll(room, msg, excludeWs = null) { broadcastTeam(room, null, msg, excludeWs); }

function playerPublic(p) {
  return { id: p.id, callsign: p.callsign, team: p.team, role: p.role,
           status: p.status, lat: p.lat, lng: p.lng, heading: p.heading,
           lastSeen: p.lastSeen, joinedAt: p.joinedAt };
}

function roomSnapshotForTeam(room, viewerTeam) {
  const uavActive = room.uavActive && room.uavActive[viewerTeam];
  return {
    players: Object.values(room.players).map(p => {
      const pub = playerPublic(p);
      if (p.team !== viewerTeam && !uavActive) { pub.lat = null; pub.lng = null; }
      return pub;
    }),
    orders: room.orders.slice(-50),
    objectives: room.objectives,
    zones: room.zones,
    mapTiles: room.mapTiles,
    gamePaused: room.gamePaused,
    roomName: room.name,
  };
}

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const session = token && adminSessions.get(token);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  req.adminSession = session;
  next();
}

function superAdminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const session = token && adminSessions.get(token);
  if (!session || session.role !== 'super') return res.status(403).json({ error: 'Super admin only' });
  req.adminSession = session;
  next();
}

// Check if admin can access a specific room/site
function canAccessRoom(session, roomCode) {
  if (session.role === 'super') return true;
  return session.managedSites && session.managedSites.includes(roomCode);
}

// ════════════════════════════════════════════════════════════════════
// PERK ENGINE
// ════════════════════════════════════════════════════════════════════
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const PERK_CONFIGS = {
  uav: {
    effect(room, caster) {
      const team = caster.team;
      const enemies = Object.values(room.players).filter(p => p.team !== team);
      if (!enemies.length) return { feedback: 'No enemy targets in range.' };
      if (!room.uavActive) room.uavActive = {};
      room.uavActive[team] = true;
      broadcastTeam(room, team, { type: 'uav_reveal', reveals: enemies.map(playerPublic), duration: 20000, callsign: caster.callsign });
      broadcastTeam(room, team, { type: 'perk_anim', perk: 'uav', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team });
      const et = team === 'red' ? 'blue' : 'red';
      broadcastTeam(room, et, { type: 'perk_anim', perk: 'uav', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team });
      const warn = { id: uuidv4(), from: 'INTEL', team: et, text: `📡 UAV SCAN DETECTED — Change position immediately!`, priority: 'high', ts: Date.now() };
      room.orders.push(warn); broadcastTeam(room, et, { type: 'new_order', order: warn });
      setTimeout(() => { if (room.uavActive) room.uavActive[team] = false; broadcastTeam(room, team, { type: 'uav_expired' }); }, 20000);
      logEvent('perk_uav', { room: room.code, caster: caster.callsign });
      return { feedback: `UAV active — ${enemies.length} enemy contact(s) revealed for 20s.` };
    }
  },
  emp: {
    effect(room, caster) {
      if (!caster.lat) return { feedback: 'No GPS — EMP requires location.' };
      const enemies = Object.values(room.players).filter(p => p.team !== caster.team && p.lat && haversine(caster.lat, caster.lng, p.lat, p.lng) <= 100);
      enemies.forEach(e => {
        e.empBlocked = true;
        sendTo(e.ws, { type: 'emp_hit', duration: 15000, from: caster.callsign });
        setTimeout(() => { e.empBlocked = false; sendTo(e.ws, { type: 'emp_cleared' }); }, 15000);
      });
      broadcastAll(room, { type: 'perk_anim', perk: 'emp', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team: caster.team });
      return { feedback: enemies.length ? `EMP hit ${enemies.length} enemies within 100m for 15s.` : 'EMP deployed — no enemies in range.' };
    }
  },
  smoke: {
    effect(room, caster) {
      if (!caster.lat) return { feedback: 'No GPS for smoke.' };
      const zone = { id: uuidv4(), zoneType: 'custom', label: `💨 SMOKE — ${caster.callsign}`, shape: 'circle', center: [caster.lat, caster.lng], radius: 25, color: '#aaaaaa', latlngs: [], createdBy: { callsign: caster.callsign }, ts: Date.now() };
      room.zones.push(zone);
      broadcastAll(room, { type: 'zone_added', zone });
      broadcastAll(room, { type: 'perk_anim', perk: 'smoke', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team: caster.team });
      setTimeout(() => { room.zones = room.zones.filter(z => z.id !== zone.id); broadcastAll(room, { type: 'zone_removed', id: zone.id }); }, 30000);
      return { feedback: 'Smoke screen for 30s.' };
    }
  },
  hack: {
    effect(room, caster) {
      const enemies = Object.values(room.players).filter(p => p.team !== caster.team && p.lat);
      if (!enemies.length) return { feedback: 'No targets with GPS signal.' };
      const target = enemies[Math.floor(Math.random() * enemies.length)];
      sendTo(caster.ws, { type: 'hack_reveal', target: playerPublic(target), duration: 10000 });
      sendTo(target.ws, { type: 'hack_detected', from: caster.callsign });
      broadcastTeam(room, caster.team, { type: 'perk_anim', perk: 'hack', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team: caster.team });
      return { feedback: `Hacked: ${target.callsign} revealed for 10s.` };
    }
  },
  medkit: {
    effect(room, caster) {
      if (!caster.lat) return { feedback: 'No GPS — cannot locate teammates.' };
      const downed = Object.values(room.players).filter(p => p.team === caster.team && p.id !== caster.id && p.status !== 'alive' && p.lat && haversine(caster.lat, caster.lng, p.lat, p.lng) <= 30);
      downed.forEach(p => { p.status = 'alive'; broadcastAll(room, { type: 'status_update', playerId: p.id, status: 'alive', team: p.team }); sendTo(p.ws, { type: 'revived', by: caster.callsign }); });
      broadcastAll(room, { type: 'perk_anim', perk: 'medkit', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team: caster.team });
      if (downed.length) { const ord = { id: uuidv4(), from: caster.callsign, team: caster.team, text: `🩹 ${caster.callsign} revived ${downed.map(p=>p.callsign).join(', ')}!`, priority: 'normal', ts: Date.now() }; room.orders.push(ord); broadcastAll(room, { type: 'new_order', order: ord }); }
      return { feedback: downed.length ? `Revived ${downed.length} teammate(s).` : 'No downed teammates within 30m.' };
    }
  },
  air: {
    effect(room, caster) {
      if (!caster.lat) return { feedback: 'No GPS for air support.' };
      const zone = { id: uuidv4(), zoneType: 'hazard', label: `🚁 AIR STRIKE — ${caster.callsign}`, shape: 'circle', center: [caster.lat, caster.lng], radius: 60, color: '#ff6600', latlngs: [], createdBy: { callsign: caster.callsign }, ts: Date.now() };
      room.zones.push(zone);
      broadcastAll(room, { type: 'zone_added', zone });
      broadcastAll(room, { type: 'perk_anim', perk: 'air', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team: caster.team });
      const ord = { id: uuidv4(), from: '⭐ AIR CMD', team: caster.team, text: `🚁 AIR SUPPORT inbound at ${caster.callsign}'s position! ALL UNITS CLEAR!`, priority: 'high', ts: Date.now() };
      room.orders.push(ord); broadcastAll(room, { type: 'new_order', order: ord });
      setTimeout(() => { room.zones = room.zones.filter(z => z.id !== zone.id); broadcastAll(room, { type: 'zone_removed', id: zone.id }); }, 60000);
      return { feedback: 'Air support called — danger zone marked for 60s.' };
    }
  },
};

// ════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ════════════════════════════════════════════════════════════════════
wss.on('connection', (ws) => {
  let playerId = null;
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join': {
        const code = (msg.room || '').toUpperCase().trim();
        const room = rooms[code];
        if (!room) { sendTo(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Map not found.' }); break; }
        // Password check
        if (room.password && room.password !== msg.password) {
          sendTo(ws, { type: 'error', code: 'WRONG_PASSWORD', message: 'Incorrect password.' }); break;
        }
        roomCode = code;
        playerId = uuidv4();
        const team = ['red','blue'].includes(msg.team) ? msg.team : 'red';
        const player = { id: playerId, callsign: (msg.callsign||'SOLDIER').toUpperCase().slice(0,12), team, role: msg.role||'Assault', status: 'alive', lat: null, lng: null, heading: 0, lastSeen: Date.now(), joinedAt: Date.now(), ws };
        room.players[playerId] = player;
        sendTo(ws, { type: 'init', playerId, room: roomSnapshotForTeam(room, team), roomCode });
        broadcastTeam(room, team, { type: 'player_joined', player: playerPublic(player) }, ws);
        const et = team === 'red' ? 'blue' : 'red';
        broadcastTeam(room, et, { type: 'enemy_count_update', redCount: Object.values(room.players).filter(p=>p.team==='red').length, blueCount: Object.values(room.players).filter(p=>p.team==='blue').length });
        const jm = { id: uuidv4(), from: 'SYSTEM', text: `📡 ${player.callsign} [${team.toUpperCase()}] joined.`, priority: 'low', ts: Date.now() };
        room.orders.push(jm); broadcastAll(room, { type: 'new_order', order: jm });
        logEvent('player_joined', { roomCode, callsign: player.callsign, team });
        break;
      }

      case 'location': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const player = room.players[playerId]; if (!player) break;
        player.lat = msg.lat; player.lng = msg.lng; player.heading = msg.heading||0; player.lastSeen = Date.now();
        const locMsg = { type: 'location_update', playerId, lat: msg.lat, lng: msg.lng, heading: msg.heading||0, lastSeen: player.lastSeen };
        broadcastTeam(room, player.team, locMsg, ws);
        const et = player.team === 'red' ? 'blue' : 'red';
        if (room.uavActive && room.uavActive[et]) broadcastTeam(room, et, locMsg);
        break;
      }

      case 'status': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const player = room.players[playerId]; if (!player) break;
        player.status = msg.status;
        broadcastAll(room, { type: 'status_update', playerId, status: msg.status, team: player.team });
        if (msg.status === 'medic' || msg.status === 'support') {
          const txt = msg.status === 'medic' ? `🚨 MEDIC NEEDED — ${player.callsign} (${player.team.toUpperCase()}) requires assistance!` : `⚡ SUPPORT NEEDED — ${player.callsign} (${player.team.toUpperCase()}) needs backup!`;
          const alert = { id: uuidv4(), from: player.callsign, team: player.team, text: txt, priority: 'high', ts: Date.now() };
          room.orders.push(alert); broadcastAll(room, { type: 'new_order', order: alert });
        }
        break;
      }

      case 'order': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const player = room.players[playerId]; if (!player) break;
        const order = { id: uuidv4(), from: player.callsign, team: player.team, text: msg.text.slice(0,200), priority: msg.priority||'normal', ts: Date.now() };
        room.orders.push(order); if (room.orders.length > 200) room.orders.shift();
        broadcastAll(room, { type: 'new_order', order });
        break;
      }

      case 'perk': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const player = room.players[playerId]; if (!player) break;
        const cfg = PERK_CONFIGS[msg.perk]; if (!cfg) break;
        const result = cfg.effect(room, player);
        sendTo(ws, { type: 'perk_feedback', perk: msg.perk, message: result.feedback });
        logEvent('perk_used', { roomCode, callsign: player.callsign, perk: msg.perk });
        break;
      }

      case 'objective': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const obj = room.objectives.find(o => o.id === msg.id);
        if (obj) { obj.done = msg.done; broadcastAll(room, { type: 'objective_update', id: msg.id, done: msg.done }); }
        break;
      }

      case 'admin_observe': {
        const obsCode = (msg.room||'').toUpperCase().trim();
        const session = msg.token && adminSessions.get(msg.token);
        if (!session) { sendTo(ws, { type: 'error', message: 'Unauthorized' }); break; }
        if (!canAccessRoom(session, obsCode)) { sendTo(ws, { type: 'error', message: 'No access to this map' }); break; }
        const obsRoom = rooms[obsCode];
        if (!obsRoom) { sendTo(ws, { type: 'error', message: 'Map not found' }); break; }
        obsRoom.adminObservers.add(ws);
        roomCode = obsCode; playerId = '__admin_' + uuidv4();
        sendTo(ws, { type: 'init', playerId: '__admin__', roomCode: obsCode, room: {
          players: Object.values(obsRoom.players).map(playerPublic),
          orders: obsRoom.orders.slice(-50), objectives: obsRoom.objectives,
          zones: obsRoom.zones, mapTiles: obsRoom.mapTiles, gamePaused: obsRoom.gamePaused, roomName: obsRoom.name,
        }});
        logEvent('admin_observe_start', { code: obsCode, admin: session.username });
        break;
      }

      case 'ping': sendTo(ws, { type: 'pong' }); break;
    }
  });

  ws.on('close', () => {
    for (const r of Object.values(rooms)) { if (r.adminObservers) r.adminObservers.delete(ws); }
    if (!playerId || playerId.startsWith('__admin_') || !roomCode) return;
    const room = rooms[roomCode]; if (!room) return;
    const player = room.players[playerId];
    if (player) {
      const m = { id: uuidv4(), from: 'SYSTEM', text: `📴 ${player.callsign} left.`, priority: 'low', ts: Date.now() };
      room.orders.push(m); delete room.players[playerId];
      broadcastAll(room, { type: 'player_left', playerId });
      broadcastAll(room, { type: 'new_order', order: m });
    }
  });

  ws.on('error', () => {});
});

// ════════════════════════════════════════════════════════════════════
// REST — Public
// ════════════════════════════════════════════════════════════════════
app.get('/health', (_, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length, uptime: Math.floor(process.uptime()) }));
app.get('/api/zone-types', (_, res) => res.json(ZONE_TYPES));

// Public: list available maps (rooms) for the home page
app.get('/api/maps', (_, res) => {
  res.json(Object.values(rooms).map(r => ({
    code: r.code, name: r.name, hasPassword: !!r.password,
    playerCount: Object.keys(r.players).length,
    redCount: Object.values(r.players).filter(p=>p.team==='red').length,
    blueCount: Object.values(r.players).filter(p=>p.team==='blue').length,
  })));
});

// ════════════════════════════════════════════════════════════════════
// REST — Auth
// ════════════════════════════════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  let session = null;
  if (username === SUPER_ADMIN_USER && password === SUPER_ADMIN_PASS) {
    session = { username, role: 'super', managedSites: [] };
  } else if (siteAdmins[username] && siteAdmins[username].password === password) {
    session = { username, role: 'site', managedSites: siteAdmins[username].sites || [], name: siteAdmins[username].name };
  }
  if (!session) { logEvent('admin_login_fail', { username, ip: req.ip }); return res.status(401).json({ error: 'Invalid credentials' }); }
  const token = uuidv4();
  adminSessions.set(token, session);
  setTimeout(() => adminSessions.delete(token), 8 * 60 * 60 * 1000);
  logEvent('admin_login', { username, role: session.role, ip: req.ip });
  res.json({ token, role: session.role, username, name: session.name||username });
});

app.post('/api/admin/logout', adminAuth, (req, res) => {
  adminSessions.delete(req.headers['x-admin-token']); res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// REST — Site Admins (super only)
// ════════════════════════════════════════════════════════════════════
app.get('/api/admin/site-admins', superAdminAuth, (_, res) => {
  res.json(Object.entries(siteAdmins).map(([u, d]) => ({ username: u, name: d.name, sites: d.sites })));
});

app.post('/api/admin/site-admins', superAdminAuth, (req, res) => {
  const { username, password, name, sites } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  siteAdmins[username] = { password, name: name||username, sites: sites||[] };
  logEvent('site_admin_created', { username, createdBy: req.adminSession.username });
  res.json({ ok: true });
});

app.put('/api/admin/site-admins/:username', superAdminAuth, (req, res) => {
  const u = req.params.username;
  if (!siteAdmins[u]) return res.status(404).json({ error: 'Not found' });
  const { password, name, sites } = req.body;
  if (password) siteAdmins[u].password = password;
  if (name) siteAdmins[u].name = name;
  if (sites) siteAdmins[u].sites = sites;
  res.json({ ok: true });
});

app.delete('/api/admin/site-admins/:username', superAdminAuth, (req, res) => {
  delete siteAdmins[req.params.username]; res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// REST — Maps/Rooms CRUD
// ════════════════════════════════════════════════════════════════════
app.get('/api/admin/rooms', adminAuth, (req, res) => {
  const sess = req.adminSession;
  const list = Object.values(rooms).filter(r => sess.role === 'super' || sess.managedSites.includes(r.code));
  res.json(list.map(r => ({
    code: r.code, name: r.name, hasPassword: !!r.password,
    playerCount: Object.keys(r.players).length,
    redCount: Object.values(r.players).filter(p=>p.team==='red').length,
    blueCount: Object.values(r.players).filter(p=>p.team==='blue').length,
    players: Object.values(r.players).map(playerPublic),
    objectives: r.objectives, zones: r.zones, orderCount: r.orders.length,
    createdAt: r.createdAt, gamePaused: r.gamePaused, mapTiles: r.mapTiles, activeMapId: r.activeMapId,
  })));
});

app.post('/api/admin/rooms', adminAuth, (req, res) => {
  const { code, name, password } = req.body;
  const c = (code || uuidv4().slice(0,6)).toUpperCase();
  if (!canAccessRoom(req.adminSession, c) && req.adminSession.role !== 'super') return res.status(403).json({ error: 'No access' });
  const room = getOrCreateRoom(c, name||c, password||'');
  if (name) room.name = name;
  if (password !== undefined) room.password = password;
  // If site admin, auto-assign this room to their managed sites
  if (req.adminSession.role === 'site') {
    const sa = siteAdmins[req.adminSession.username];
    if (sa && !sa.sites.includes(c)) sa.sites.push(c);
  }
  res.json({ code: room.code, name: room.name });
});

app.put('/api/admin/rooms/:code', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  const { name, password } = req.body;
  if (name !== undefined) { room.name = name; broadcastAll(room, { type: 'room_renamed', name }); }
  if (password !== undefined) room.password = password;
  res.json({ ok: true });
});

app.get('/api/admin/rooms/:code', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  res.json({ code: room.code, name: room.name, hasPassword: !!room.password, players: Object.values(room.players).map(playerPublic), orders: room.orders, objectives: room.objectives, zones: room.zones, gamePaused: room.gamePaused, createdAt: room.createdAt, mapTiles: room.mapTiles });
});

app.get('/api/admin/rooms/:code/live', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  res.json({ players: Object.values(room.players).map(playerPublic), zones: room.zones, objectives: room.objectives, mapTiles: room.mapTiles, gamePaused: room.gamePaused, roomName: room.name });
});

app.delete('/api/admin/rooms/:code', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  broadcastAll(room, { type: 'kicked', reason: 'Map closed by admin' });
  delete rooms[req.params.code.toUpperCase()];
  logEvent('room_deleted', { code: req.params.code }); res.json({ ok: true });
});

// Game controls
app.post('/api/admin/rooms/:code/pause', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  room.gamePaused = true;
  const msg = { id: uuidv4(), from: '⭐ ADMIN', text: '⏸ GAME PAUSED — Hold all positions.', priority: 'high', ts: Date.now() };
  room.orders.push(msg); broadcastAll(room, { type: 'game_paused' }); broadcastAll(room, { type: 'new_order', order: msg });
  res.json({ ok: true });
});
app.post('/api/admin/rooms/:code/resume', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  room.gamePaused = false;
  const msg = { id: uuidv4(), from: '⭐ ADMIN', text: '▶ GAME RESUMED — Engage!', priority: 'high', ts: Date.now() };
  room.orders.push(msg); broadcastAll(room, { type: 'game_resumed' }); broadcastAll(room, { type: 'new_order', order: msg });
  res.json({ ok: true });
});
app.post('/api/admin/rooms/:code/reset', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  Object.values(room.players).forEach(p => { p.status = 'alive'; });
  const msg = { id: uuidv4(), from: '⭐ ADMIN', text: '🔄 All players RESPAWNED.', priority: 'high', ts: Date.now() };
  room.orders.push(msg); broadcastAll(room, { type: 'game_reset' }); broadcastAll(room, { type: 'new_order', order: msg });
  res.json({ ok: true });
});

// Map tiles
app.post('/api/admin/rooms/:code/map-tiles', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  room.mapTiles = req.body.tiles || 'osm';
  broadcastAll(room, { type: 'map_tiles_changed', tiles: room.mapTiles });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// REST — Objectives (full CRUD with name, team, position)
// ════════════════════════════════════════════════════════════════════
app.get('/api/admin/rooms/:code/objectives', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  res.json(room.objectives);
});

app.post('/api/admin/rooms/:code/objectives', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  const obj = {
    id: uuidv4(),
    text: (req.body.text || 'Objective').slice(0, 100),
    team: req.body.team || 'all',   // 'red' | 'blue' | 'all'
    lat: req.body.lat || null,
    lng: req.body.lng || null,
    done: false,
    createdAt: Date.now(),
  };
  room.objectives.push(obj);
  broadcastAll(room, { type: 'objective_added', objective: obj });
  res.json(obj);
});

app.put('/api/admin/rooms/:code/objectives/:objId', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  const obj = room.objectives.find(o => o.id === req.params.objId);
  if (!obj) return res.status(404).json({ error: 'Objective not found' });
  if (req.body.text !== undefined) obj.text = req.body.text.slice(0, 100);
  if (req.body.team !== undefined) obj.team = req.body.team;
  if (req.body.lat !== undefined) obj.lat = req.body.lat;
  if (req.body.lng !== undefined) obj.lng = req.body.lng;
  if (req.body.done !== undefined) obj.done = req.body.done;
  broadcastAll(room, { type: 'objective_updated', objective: obj });
  res.json(obj);
});

app.delete('/api/admin/rooms/:code/objectives/:objId', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  room.objectives = room.objectives.filter(o => o.id !== req.params.objId);
  broadcastAll(room, { type: 'objective_removed', id: req.params.objId });
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// REST — Zones (admin only — players can no longer draw)
// ════════════════════════════════════════════════════════════════════
app.post('/api/admin/rooms/:code/zones', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  const zone = {
    id: uuidv4(), zoneType: req.body.zoneType||'custom', label: req.body.label||'Zone',
    shape: req.body.shape, latlngs: req.body.latlngs||[], center: req.body.center||null,
    radius: req.body.radius||null, color: ZONE_TYPES[req.body.zoneType]?.color||req.body.color||'#cc44ff',
    team: req.body.team||'all',
    createdBy: { callsign: req.adminSession.username }, ts: Date.now(),
  };
  room.zones.push(zone); broadcastAll(room, { type: 'zone_added', zone });
  res.json(zone);
});

app.delete('/api/admin/rooms/:code/zones/:zid', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  room.zones = room.zones.filter(z => z.id !== req.params.zid);
  broadcastAll(room, { type: 'zone_removed', id: req.params.zid }); res.json({ ok: true });
});

app.delete('/api/admin/rooms/:code/zones', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  room.zones = []; broadcastAll(room, { type: 'zones_cleared' }); res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// REST — Saved Maps (named map templates with zones + objectives)
// ════════════════════════════════════════════════════════════════════
app.get('/api/admin/saved-maps', adminAuth, (req, res) => {
  const sess = req.adminSession;
  const maps = Object.values(savedMaps).filter(m => sess.role === 'super' || sess.managedSites.includes(m.siteCode) || m.createdBy === sess.username);
  res.json(maps.map(m => ({ id: m.id, name: m.name, siteCode: m.siteCode, zoneCount: (m.zones||[]).length, objectiveCount: (m.objectives||[]).length, createdAt: m.createdAt, createdBy: m.createdBy })));
});

app.post('/api/admin/saved-maps', adminAuth, (req, res) => {
  const { name, siteCode, zones, objectives } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const map = { id: uuidv4(), name, siteCode: siteCode||'', zones: zones||[], objectives: objectives||[], createdBy: req.adminSession.username, createdAt: Date.now() };
  savedMaps[map.id] = map;
  logEvent('map_saved', { name, by: req.adminSession.username });
  res.json(map);
});

app.put('/api/admin/saved-maps/:id', adminAuth, (req, res) => {
  const map = savedMaps[req.params.id]; if (!map) return res.status(404).json({ error: 'Not found' });
  const { name, zones, objectives } = req.body;
  if (name) map.name = name;
  if (zones) map.zones = zones;
  if (objectives) map.objectives = objectives;
  map.updatedAt = Date.now();
  res.json(map);
});

app.delete('/api/admin/saved-maps/:id', adminAuth, (req, res) => {
  delete savedMaps[req.params.id]; res.json({ ok: true });
});

// Load a saved map into a room
app.post('/api/admin/rooms/:code/load-map/:mapId', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  const map = savedMaps[req.params.mapId]; if (!map) return res.status(404).json({ error: 'Map not found' });
  room.zones = map.zones.map(z => ({ ...z, id: uuidv4(), ts: Date.now() }));
  room.objectives = map.objectives.map(o => ({ ...o, id: uuidv4(), done: false }));
  room.activeMapId = req.params.mapId;
  broadcastAll(room, { type: 'map_loaded', zones: room.zones, objectives: room.objectives, mapName: map.name });
  logEvent('map_loaded', { room: room.code, map: map.name, by: req.adminSession.username });
  res.json({ ok: true, message: `Map "${map.name}" loaded.` });
});

// ════════════════════════════════════════════════════════════════════
// REST — Players, Broadcast, Admin Perks, Event Log
// ════════════════════════════════════════════════════════════════════
app.post('/api/admin/rooms/:code/kick/:pid', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  const player = room.players[req.params.pid]; if (!player) return res.status(404).json({ error: 'Player not found' });
  sendTo(player.ws, { type: 'kicked', reason: req.body.reason||'Removed by admin' });
  if (player.ws) player.ws.close();
  res.json({ ok: true });
});

app.post('/api/admin/rooms/:code/broadcast', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  const order = { id: uuidv4(), from: '⭐ ADMIN', text: req.body.text.slice(0,200), priority: req.body.priority||'high', ts: Date.now() };
  room.orders.push(order); broadcastAll(room, { type: 'new_order', order });
  res.json({ ok: true });
});

app.post('/api/admin/broadcast-all', superAdminAuth, (req, res) => {
  for (const room of Object.values(rooms)) {
    const order = { id: uuidv4(), from: '⭐ ADMIN', text: req.body.text.slice(0,200), priority: 'high', ts: Date.now() };
    room.orders.push(order); broadcastAll(room, { type: 'new_order', order });
  }
  res.json({ ok: true });
});

app.post('/api/admin/rooms/:code/perk', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  const { perk, team, lat, lng } = req.body;
  switch (perk) {
    case 'intel_drop': {
      const enemies = Object.values(room.players).filter(p => p.team !== team);
      const reveals = enemies.map(playerPublic);
      broadcastTeam(room, team, { type: 'uav_reveal', reveals, duration: 30000, callsign: 'ADMIN INTEL' });
      setTimeout(() => broadcastTeam(room, team, { type: 'uav_expired' }), 30000);
      return res.json({ ok: true, message: `Intel drop — ${enemies.length} contacts revealed to ${team.toUpperCase()} for 30s.` });
    }
    case 'blackout': {
      broadcastAll(room, { type: 'blackout', duration: 20000 });
      setTimeout(() => broadcastAll(room, { type: 'blackout_end' }), 20000);
      const msg = { id: uuidv4(), from: '⭐ ADMIN', text: '⚫ BLACKOUT — All GPS maps offline for 20s!', priority: 'high', ts: Date.now() };
      room.orders.push(msg); broadcastAll(room, { type: 'new_order', order: msg });
      return res.json({ ok: true, message: 'Blackout deployed for 20s.' });
    }
    case 'flare': {
      if (!lat || !lng) return res.status(400).json({ error: 'lat/lng required' });
      const zone = { id: uuidv4(), zoneType: 'custom', label: '🔴 ADMIN FLARE', shape: 'circle', center: [lat, lng], radius: 10, color: '#ff0000', latlngs: [], createdBy: { callsign: 'ADMIN' }, ts: Date.now() };
      room.zones.push(zone); broadcastAll(room, { type: 'zone_added', zone });
      broadcastAll(room, { type: 'perk_anim', perk: 'flare', lat, lng, callsign: 'ADMIN', team: 'admin' });
      setTimeout(() => { room.zones = room.zones.filter(z => z.id !== zone.id); broadcastAll(room, { type: 'zone_removed', id: zone.id }); }, 120000);
      return res.json({ ok: true, message: 'Flare placed for 2 minutes.' });
    }
    case 'ceasefire': {
      broadcastAll(room, { type: 'ceasefire_signal' });
      const msg = { id: uuidv4(), from: '⭐ ADMIN', text: '🕊 CEASEFIRE SIGNAL — All hostilities cease immediately!', priority: 'high', ts: Date.now() };
      room.orders.push(msg); broadcastAll(room, { type: 'new_order', order: msg });
      return res.json({ ok: true, message: 'Ceasefire signal sent to all players.' });
    }
    case 'eliminate_team': {
      Object.values(room.players).filter(p => p.team === team).forEach(p => { p.status = 'dead'; broadcastAll(room, { type: 'status_update', playerId: p.id, status: 'dead', team: p.team }); });
      return res.json({ ok: true, message: `${team.toUpperCase()} team eliminated.` });
    }
    default: return res.status(400).json({ error: 'Unknown perk' });
  }
});

app.get('/api/admin/events', adminAuth, (_, res) => res.json(eventLog.slice(-100).reverse()));

// ════════════════════════════════════════════════════════════════════
// Serve
// ════════════════════════════════════════════════════════════════════
app.get('/admin*', (_, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎯 Swindon Airsoft Tactical v5 — port ${PORT}`));
