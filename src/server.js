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

const ADMIN_USER = process.env.ADMIN_USER || 'chriszulu';
const ADMIN_PASS = process.env.ADMIN_PASS || 'SwindonA1rsoft!';
const adminSessions = new Set();

const rooms = {};
const eventLog = [];

function logEvent(type, data) {
  eventLog.push({ type, data, ts: Date.now() });
  if (eventLog.length > 500) eventLog.shift();
}

// Zone type configs
const ZONE_TYPES = {
  respawn:   { label: 'Respawn Zone',    color: '#00cc66', fillOpacity: 0.15 },
  objective: { label: 'Objective',       color: '#ffaa00', fillOpacity: 0.2  },
  hazard:    { label: 'Hazard Zone',     color: '#ff2a2a', fillOpacity: 0.15 },
  safe:      { label: 'Safe Zone',       color: '#2a7fff', fillOpacity: 0.12 },
  boundary:  { label: 'Game Boundary',   color: '#e8c84a', fillOpacity: 0.05 },
  custom:    { label: 'Custom Zone',     color: '#cc44ff', fillOpacity: 0.15 },
};

function getOrCreateRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      code,
      players: {},
      orders: [
        { id: uuidv4(), from: 'SYSTEM', text: '🎯 Swindon Airsoft — Game room active. Stand by for orders.', priority: 'normal', ts: Date.now() }
      ],
      objectives: [
        { id: uuidv4(), text: 'Establish base position', done: false },
        { id: uuidv4(), text: 'Secure primary objective', done: false },
        { id: uuidv4(), text: 'Eliminate enemy HQ', done: false },
      ],
      zones: [],       // drawn map zones
      mapTiles: 'osm', // tile provider key
      createdAt: Date.now(),
      gamePaused: false,
    };
    logEvent('room_created', { code });
  }
  return rooms[code];
}

setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    const active = Object.values(room.players).some(p => p.ws && p.ws.readyState === WebSocket.OPEN);
    if (!active && now - room.createdAt > 600_000) {
      delete rooms[code];
      logEvent('room_expired', { code });
    }
  }
}, 600_000);

function broadcast(room, msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  for (const p of Object.values(room.players)) {
    if (p.ws && p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}
function broadcastAll(room, msg) { broadcast(room, msg, null); }
function sendTo(ws, msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

function playerPublic(p) {
  return {
    id: p.id, callsign: p.callsign, team: p.team, role: p.role, rank: p.rank,
    status: p.status, lat: p.lat, lng: p.lng, heading: p.heading,
    lastSeen: p.lastSeen, joinedAt: p.joinedAt,
  };
}

function roomSnapshot(room) {
  return {
    players: Object.values(room.players).map(playerPublic),
    orders: room.orders.slice(-50),
    objectives: room.objectives,
    zones: room.zones,
    mapTiles: room.mapTiles,
    gamePaused: room.gamePaused,
  };
}

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || !adminSessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ══════════════════════════════════════════════════════════════════
// WEBSOCKET
// ══════════════════════════════════════════════════════════════════
wss.on('connection', (ws) => {
  let playerId = null;
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join': {
        roomCode = (msg.room || 'DEFAULT').toUpperCase().trim();
        const room = getOrCreateRoom(roomCode);
        playerId = uuidv4();
        const team = ['red', 'blue'].includes(msg.team) ? msg.team : 'red';
        const player = {
          id: playerId,
          callsign: (msg.callsign || 'SOLDIER').toUpperCase().slice(0, 12),
          team, role: msg.role || 'Assault', rank: 'Private',
          status: 'alive', lat: null, lng: null, heading: 0,
          lastSeen: Date.now(), joinedAt: Date.now(), ws,
        };
        room.players[playerId] = player;
        sendTo(ws, { type: 'init', playerId, room: roomSnapshot(room), roomCode });
        broadcast(room, { type: 'player_joined', player: playerPublic(player) }, ws);
        const joinMsg = { id: uuidv4(), from: 'SYSTEM', text: `📡 ${player.callsign} [${team.toUpperCase()} TEAM] has joined.`, priority: 'low', ts: Date.now() };
        room.orders.push(joinMsg);
        broadcastAll(room, { type: 'new_order', order: joinMsg });
        logEvent('player_joined', { roomCode, callsign: player.callsign, team });
        break;
      }

      case 'location': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const player = room.players[playerId]; if (!player) break;
        player.lat = msg.lat; player.lng = msg.lng;
        player.heading = msg.heading || 0; player.lastSeen = Date.now();
        broadcast(room, { type: 'location_update', playerId, lat: msg.lat, lng: msg.lng, heading: msg.heading || 0, lastSeen: player.lastSeen }, ws);
        break;
      }

      case 'status': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const player = room.players[playerId]; if (!player) break;
        player.status = msg.status;
        broadcastAll(room, { type: 'status_update', playerId, status: msg.status });
        if (msg.status === 'medic') {
          const alert = { id: uuidv4(), from: player.callsign, text: `🚨 MEDIC NEEDED — ${player.callsign} (${player.team.toUpperCase()} TEAM) requires immediate assistance!`, priority: 'high', ts: Date.now() };
          room.orders.push(alert);
          broadcastAll(room, { type: 'new_order', order: alert });
        }
        if (msg.status === 'support') {
          const alert = { id: uuidv4(), from: player.callsign, text: `⚡ SUPPORT REQUESTED — ${player.callsign} (${player.team.toUpperCase()} TEAM) needs backup!`, priority: 'high', ts: Date.now() };
          room.orders.push(alert);
          broadcastAll(room, { type: 'new_order', order: alert });
        }
        logEvent('status_change', { roomCode, callsign: player.callsign, status: msg.status });
        break;
      }

      case 'order': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const player = room.players[playerId]; if (!player) break;
        const order = { id: uuidv4(), from: player.callsign, team: player.team, text: msg.text.slice(0, 200), priority: msg.priority || 'normal', ts: Date.now() };
        room.orders.push(order); if (room.orders.length > 200) room.orders.shift();
        broadcastAll(room, { type: 'new_order', order });
        break;
      }

      // ── PERK USED — broadcast map animation to all ────────────────
      case 'perk': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const player = room.players[playerId]; if (!player) break;
        const perkMsg = { id: uuidv4(), from: player.callsign, text: `[PERK] ${msg.label} used by ${player.callsign}`, priority: 'normal', ts: Date.now() };
        room.orders.push(perkMsg);
        broadcastAll(room, {
          type: 'perk_event',
          perk: msg.perk,
          label: msg.label,
          lat: player.lat,
          lng: player.lng,
          playerId,
          callsign: player.callsign,
          team: player.team,
          ts: Date.now(),
        });
        broadcastAll(room, { type: 'new_order', order: perkMsg });
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

      // ── ZONE DRAW (from player, relayed to all) ───────────────────
      case 'zone_add': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const zone = {
          id: uuidv4(),
          zoneType: msg.zoneType || 'custom',
          label: msg.label || 'Zone',
          shape: msg.shape,   // 'polygon' | 'circle'
          latlngs: msg.latlngs || [],
          center: msg.center || null,
          radius: msg.radius || null,
          color: ZONE_TYPES[msg.zoneType]?.color || '#cc44ff',
          createdBy: playerPublic({ ...room.players[playerId] }),
          ts: Date.now(),
        };
        room.zones.push(zone);
        broadcastAll(room, { type: 'zone_added', zone });
        break;
      }

      case 'zone_remove': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        room.zones = room.zones.filter(z => z.id !== msg.id);
        broadcastAll(room, { type: 'zone_removed', id: msg.id });
        break;
      }

      case 'ping': sendTo(ws, { type: 'pong' }); break;
    }
  });

  ws.on('close', () => {
    if (!playerId || !roomCode) return;
    const room = rooms[roomCode]; if (!room) return;
    const player = room.players[playerId];
    if (player) {
      const msg = { id: uuidv4(), from: 'SYSTEM', text: `📴 ${player.callsign} has left the battlefield.`, priority: 'low', ts: Date.now() };
      room.orders.push(msg);
      delete room.players[playerId];
      broadcast(room, { type: 'player_left', playerId });
      broadcastAll(room, { type: 'new_order', order: msg });
      logEvent('player_left', { roomCode, callsign: player.callsign });
    }
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

// ══════════════════════════════════════════════════════════════════
// REST — Public
// ══════════════════════════════════════════════════════════════════
app.get('/health', (_, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length, uptime: Math.floor(process.uptime()) }));
app.get('/api/zone-types', (_, res) => res.json(ZONE_TYPES));

// ══════════════════════════════════════════════════════════════════
// REST — Admin Auth
// ══════════════════════════════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = uuidv4();
    adminSessions.add(token);
    setTimeout(() => adminSessions.delete(token), 8 * 60 * 60 * 1000);
    logEvent('admin_login', { username, ip: req.ip });
    return res.json({ token });
  }
  logEvent('admin_login_fail', { username, ip: req.ip });
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/admin/logout', adminAuth, (req, res) => {
  adminSessions.delete(req.headers['x-admin-token']);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// REST — Admin: Rooms
// ══════════════════════════════════════════════════════════════════
app.get('/api/admin/rooms', adminAuth, (_, res) => {
  res.json(Object.values(rooms).map(r => ({
    code: r.code,
    playerCount: Object.keys(r.players).length,
    redCount: Object.values(r.players).filter(p => p.team === 'red').length,
    blueCount: Object.values(r.players).filter(p => p.team === 'blue').length,
    players: Object.values(r.players).map(playerPublic),
    objectives: r.objectives,
    zones: r.zones,
    orderCount: r.orders.length,
    createdAt: r.createdAt,
    gamePaused: r.gamePaused,
    mapTiles: r.mapTiles,
  })));
});

app.get('/api/admin/rooms/:code', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ code: room.code, players: Object.values(room.players).map(playerPublic), orders: room.orders, objectives: room.objectives, zones: room.zones, gamePaused: room.gamePaused, createdAt: room.createdAt, mapTiles: room.mapTiles });
});

app.delete('/api/admin/rooms/:code', adminAuth, (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms[code]; if (!room) return res.status(404).json({ error: 'Not found' });
  broadcastAll(room, { type: 'kicked', reason: 'Room closed by admin' });
  delete rooms[code];
  logEvent('room_deleted', { code });
  res.json({ ok: true });
});

app.post('/api/admin/rooms', adminAuth, (req, res) => {
  const code = (req.body.code || uuidv4().slice(0,6)).toUpperCase();
  const room = getOrCreateRoom(code);
  res.json({ code: room.code });
});

app.post('/api/admin/rooms/:code/pause', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  room.gamePaused = true;
  const msg = { id: uuidv4(), from: '⭐ ADMIN', text: '⏸ GAME PAUSED — Hold all positions.', priority: 'high', ts: Date.now() };
  room.orders.push(msg); broadcastAll(room, { type: 'game_paused' }); broadcastAll(room, { type: 'new_order', order: msg });
  logEvent('game_paused', { code: room.code }); res.json({ ok: true });
});

app.post('/api/admin/rooms/:code/resume', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  room.gamePaused = false;
  const msg = { id: uuidv4(), from: '⭐ ADMIN', text: '▶ GAME RESUMED — Engage!', priority: 'high', ts: Date.now() };
  room.orders.push(msg); broadcastAll(room, { type: 'game_resumed' }); broadcastAll(room, { type: 'new_order', order: msg });
  logEvent('game_resumed', { code: room.code }); res.json({ ok: true });
});

app.post('/api/admin/rooms/:code/reset', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  Object.values(room.players).forEach(p => { p.status = 'alive'; });
  const msg = { id: uuidv4(), from: '⭐ ADMIN', text: '🔄 All players RESPAWNED. Game reset!', priority: 'high', ts: Date.now() };
  room.orders.push(msg); broadcastAll(room, { type: 'game_reset' }); broadcastAll(room, { type: 'new_order', order: msg });
  logEvent('game_reset', { code: room.code }); res.json({ ok: true });
});

// ── Map tile override ─────────────────────────────────────────────
app.post('/api/admin/rooms/:code/map', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  room.mapTiles = req.body.tiles || 'osm';
  broadcastAll(room, { type: 'map_tiles_changed', tiles: room.mapTiles });
  res.json({ ok: true });
});

// ── Admin zone management ─────────────────────────────────────────
app.post('/api/admin/rooms/:code/zones', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  const zone = {
    id: uuidv4(),
    zoneType: req.body.zoneType || 'custom',
    label: req.body.label || 'Zone',
    shape: req.body.shape,
    latlngs: req.body.latlngs || [],
    center: req.body.center || null,
    radius: req.body.radius || null,
    color: ZONE_TYPES[req.body.zoneType]?.color || '#cc44ff',
    createdBy: { callsign: 'ADMIN' },
    ts: Date.now(),
  };
  room.zones.push(zone);
  broadcastAll(room, { type: 'zone_added', zone });
  res.json(zone);
});

app.delete('/api/admin/rooms/:code/zones/:zoneId', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  room.zones = room.zones.filter(z => z.id !== req.params.zoneId);
  broadcastAll(room, { type: 'zone_removed', id: req.params.zoneId });
  res.json({ ok: true });
});

app.delete('/api/admin/rooms/:code/zones', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  room.zones = [];
  broadcastAll(room, { type: 'zones_cleared' });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// REST — Admin: Players
// ══════════════════════════════════════════════════════════════════
app.post('/api/admin/rooms/:code/kick/:pid', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  const player = room.players[req.params.pid]; if (!player) return res.status(404).json({ error: 'Player not found' });
  sendTo(player.ws, { type: 'kicked', reason: req.body.reason || 'Removed by admin' });
  if (player.ws) player.ws.close();
  logEvent('player_kicked', { code: room.code, callsign: player.callsign }); res.json({ ok: true });
});

app.post('/api/admin/rooms/:code/player/:pid/status', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  const player = room.players[req.params.pid]; if (!player) return res.status(404).json({ error: 'Player not found' });
  player.status = req.body.status;
  broadcastAll(room, { type: 'status_update', playerId: player.id, status: player.status });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// REST — Admin: Objectives
// ══════════════════════════════════════════════════════════════════
app.post('/api/admin/rooms/:code/objectives', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  const obj = { id: uuidv4(), text: req.body.text.slice(0, 100), done: false };
  room.objectives.push(obj); broadcastAll(room, { type: 'objective_added', objective: obj });
  res.json(obj);
});

app.delete('/api/admin/rooms/:code/objectives/:objId', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  room.objectives = room.objectives.filter(o => o.id !== req.params.objId);
  broadcastAll(room, { type: 'objective_removed', id: req.params.objId });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// REST — Admin: Broadcast
// ══════════════════════════════════════════════════════════════════
app.post('/api/admin/rooms/:code/broadcast', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  const order = { id: uuidv4(), from: '⭐ ADMIN', text: req.body.text.slice(0, 200), priority: req.body.priority || 'high', ts: Date.now() };
  room.orders.push(order); broadcastAll(room, { type: 'new_order', order });
  logEvent('admin_broadcast', { code: room.code, text: order.text }); res.json({ ok: true });
});

app.post('/api/admin/broadcast-all', adminAuth, (req, res) => {
  for (const room of Object.values(rooms)) {
    const order = { id: uuidv4(), from: '⭐ ADMIN', text: req.body.text.slice(0, 200), priority: 'high', ts: Date.now() };
    room.orders.push(order); broadcastAll(room, { type: 'new_order', order });
  }
  logEvent('admin_broadcast_all', { text: req.body.text }); res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// REST — Admin: Event Log
// ══════════════════════════════════════════════════════════════════
app.get('/api/admin/events', adminAuth, (_, res) => res.json(eventLog.slice(-100).reverse()));

// ══════════════════════════════════════════════════════════════════
// Serve Pages
// ══════════════════════════════════════════════════════════════════
app.get('/admin*', (_, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎯 Swindon Airsoft Tactical — port ${PORT}`));
