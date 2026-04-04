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
  if (eventLog.length > 1000) eventLog.shift();
}

const ZONE_TYPES = {
  respawn:   { label: 'Respawn Zone',  color: '#00cc66', fillOpacity: 0.15 },
  objective: { label: 'Objective',     color: '#ffaa00', fillOpacity: 0.20 },
  hazard:    { label: 'Hazard Zone',   color: '#ff2a2a', fillOpacity: 0.15 },
  safe:      { label: 'Safe Zone',     color: '#2a7fff', fillOpacity: 0.12 },
  boundary:  { label: 'Game Boundary', color: '#e8c84a', fillOpacity: 0.05 },
  custom:    { label: 'Custom Zone',   color: '#cc44ff', fillOpacity: 0.15 },
};

function getOrCreateRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      code,
      players: {},         // id → player obj
      activeEffects: {},   // playerId → { uavBlinded: bool, empBlocked: bool, ... }
      orders: [
        { id: uuidv4(), from: 'SYSTEM', text: '🎯 Swindon Airsoft — Game room active. Stand by for orders.', priority: 'normal', ts: Date.now() }
      ],
      objectives: [
        { id: uuidv4(), text: 'Establish base position', done: false },
        { id: uuidv4(), text: 'Secure primary objective', done: false },
        { id: uuidv4(), text: 'Eliminate enemy HQ', done: false },
      ],
      zones: [],
      mapTiles: 'osm',
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

// ── Broadcast helpers ─────────────────────────────────────────────
function sendTo(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Send to all players of a specific team (or all if team=null)
function broadcastTeam(room, team, msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  for (const p of Object.values(room.players)) {
    if (team && p.team !== team) continue;
    if (p.ws && p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(data);
    }
  }
  // Also forward EVERYTHING to admin observers (they see all data unfiltered)
  if (room.adminObservers) {
    for (const ows of room.adminObservers) {
      if (ows !== excludeWs && ows.readyState === WebSocket.OPEN) {
        ows.send(data);
      }
    }
  }
}
function broadcastAll(room, msg) { broadcastTeam(room, null, msg); }
function broadcastAllExcept(room, msg, excludeWs) { broadcastTeam(room, null, msg, excludeWs); }

function playerPublic(p) {
  return {
    id: p.id, callsign: p.callsign, team: p.team, role: p.role,
    status: p.status, lat: p.lat, lng: p.lng, heading: p.heading,
    lastSeen: p.lastSeen, joinedAt: p.joinedAt,
    empBlocked: p.empBlocked || false,
  };
}

// Build snapshot filtered for a specific viewer team
// - Own team: full positions
// - Enemy team: hidden unless UAV is active for viewer's team
function roomSnapshotForTeam(room, viewerTeam, uavActive) {
  return {
    players: Object.values(room.players).map(p => {
      const pub = playerPublic(p);
      if (p.team !== viewerTeam && !uavActive) {
        // Hide enemy position
        pub.lat = null; pub.lng = null; pub.heading = 0;
      }
      return pub;
    }),
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

// ════════════════════════════════════════════════════════════════════
// PERK ENGINE — server-side effects
// ════════════════════════════════════════════════════════════════════

const PERK_CONFIGS = {
  // ── Player perks ────────────────────────────────────────────────
  uav: {
    name: 'UAV Scan',
    desc: 'Reveals ALL enemy positions to your team for 20 seconds',
    cooldown: 60,
    effect(room, caster) {
      const team = caster.team;
      const enemies = Object.values(room.players).filter(p => p.team !== team);
      if (!enemies.length) return { feedback: 'No enemy targets in range.' };

      // Set room-level UAV flag so ongoing location_update messages get forwarded
      if (!room.uavActive) room.uavActive = {};
      room.uavActive[team] = true;

      // Send enemy positions to entire caster team NOW
      const reveals = enemies.map(e => playerPublic(e));
      broadcastTeam(room, team, {
        type: 'uav_reveal',
        reveals,
        duration: 20000,
        callsign: caster.callsign,
      });

      // Send animation to caster team
      broadcastTeam(room, team, {
        type: 'perk_anim',
        perk: 'uav',
        lat: caster.lat, lng: caster.lng,
        callsign: caster.callsign,
        team: caster.team,
      });

      // Notify enemies they're being scanned (but don't tell them positions)
      const enemyTeam = team === 'red' ? 'blue' : 'red';
      broadcastTeam(room, enemyTeam, {
        type: 'perk_anim',
        perk: 'uav',
        lat: caster.lat, lng: caster.lng,
        callsign: caster.callsign,
        team: caster.team,
      });
      const scanAlert = { id: uuidv4(), from: 'INTEL', team: enemyTeam, text: `📡 UAV SCAN DETECTED — Enemy surveillance active! Change position now!`, priority: 'high', ts: Date.now() };
      room.orders.push(scanAlert);
      broadcastTeam(room, enemyTeam, { type: 'new_order', order: scanAlert });

      // Clear UAV flag after 20 seconds
      setTimeout(() => {
        if (room.uavActive) room.uavActive[team] = false;
        broadcastTeam(room, team, { type: 'uav_expired' });
      }, 20000);

      logEvent('perk_uav', { room: room.code, caster: caster.callsign, team, enemies: enemies.length });
      return { feedback: `UAV scanning — ${enemies.length} enemy contact(s) revealed to your team for 20s.` };
    }
  },

  emp: {
    name: 'EMP Blast',
    desc: 'Blinds nearby enemies — hides their GPS map for 15 seconds',
    cooldown: 90,
    effect(room, caster) {
      if (!caster.lat) return { feedback: 'No GPS signal — EMP requires location.' };
      const RADIUS_M = 100; // 100 metre radius
      const enemies = Object.values(room.players).filter(p => {
        if (p.team === caster.team || !p.lat) return false;
        return haversine(caster.lat, caster.lng, p.lat, p.lng) <= RADIUS_M;
      });

      enemies.forEach(e => {
        e.empBlocked = true;
        sendTo(e.ws, { type: 'emp_hit', duration: 15000, from: caster.callsign });
        setTimeout(() => {
          e.empBlocked = false;
          sendTo(e.ws, { type: 'emp_cleared' });
        }, 15000);
      });

      // Visual for everyone
      broadcastAll(room, { type: 'perk_anim', perk: 'emp', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team: caster.team });
      logEvent('perk_emp', { room: room.code, caster: caster.callsign, hit: enemies.length });
      return { feedback: enemies.length ? `EMP hit ${enemies.length} enemy/enemies within ${RADIUS_M}m — their map is scrambled for 15s.` : 'EMP deployed — no enemies in range.' };
    }
  },

  smoke: {
    name: 'Smoke Screen',
    desc: 'Drops a smoke zone on your position — visible to all on the map',
    cooldown: 30,
    effect(room, caster) {
      if (!caster.lat) return { feedback: 'No GPS signal for smoke deployment.' };
      const zone = {
        id: uuidv4(), zoneType: 'custom', label: `💨 SMOKE — ${caster.callsign}`,
        shape: 'circle', center: [caster.lat, caster.lng], radius: 25,
        color: '#aaaaaa', latlngs: [], createdBy: { callsign: caster.callsign }, ts: Date.now(),
        smokeExpiry: Date.now() + 30000,
      };
      room.zones.push(zone);
      broadcastAll(room, { type: 'zone_added', zone });
      broadcastAll(room, { type: 'perk_anim', perk: 'smoke', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team: caster.team });
      // Auto-remove smoke after 30s
      setTimeout(() => {
        room.zones = room.zones.filter(z => z.id !== zone.id);
        broadcastAll(room, { type: 'zone_removed', id: zone.id });
      }, 30000);
      logEvent('perk_smoke', { room: room.code, caster: caster.callsign });
      return { feedback: 'Smoke screen deployed — visible on map for 30s.' };
    }
  },

  hack: {
    name: 'Intel Hack',
    desc: 'Temporarily reveals one random enemy\'s exact position',
    cooldown: 120,
    effect(room, caster) {
      const enemies = Object.values(room.players).filter(p => p.team !== caster.team && p.lat);
      if (!enemies.length) return { feedback: 'No enemy targets with GPS signal.' };

      const target = enemies[Math.floor(Math.random() * enemies.length)];
      // Send target to caster only
      sendTo(caster.ws, {
        type: 'hack_reveal',
        target: playerPublic(target),
        duration: 10000,
      });
      // Notify target they were hacked
      sendTo(target.ws, { type: 'hack_detected', from: caster.callsign });
      // Visual for caster team
      broadcastTeam(room, caster.team, { type: 'perk_anim', perk: 'hack', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team: caster.team });
      logEvent('perk_hack', { room: room.code, caster: caster.callsign, target: target.callsign });
      return { feedback: `Hacked: ${target.callsign} position revealed to you for 10s.` };
    }
  },

  medkit: {
    name: 'Medkit',
    desc: 'Revives all downed teammates within 30 metres',
    cooldown: 45,
    effect(room, caster) {
      if (!caster.lat) return { feedback: 'No GPS signal — cannot locate teammates.' };
      const downed = Object.values(room.players).filter(p => {
        if (p.team !== caster.team || p.id === caster.id || p.status === 'alive' || !p.lat) return false;
        return haversine(caster.lat, caster.lng, p.lat, p.lng) <= 30;
      });

      downed.forEach(p => {
        p.status = 'alive';
        broadcastAll(room, { type: 'status_update', playerId: p.id, status: 'alive' });
        sendTo(p.ws, { type: 'revived', by: caster.callsign });
      });

      broadcastAll(room, { type: 'perk_anim', perk: 'medkit', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team: caster.team });
      if (downed.length) {
        const order = { id: uuidv4(), from: caster.callsign, team: caster.team, text: `🩹 ${caster.callsign} revived ${downed.map(p => p.callsign).join(', ')}!`, priority: 'normal', ts: Date.now() };
        room.orders.push(order); broadcastAll(room, { type: 'new_order', order });
      }
      logEvent('perk_medkit', { room: room.code, caster: caster.callsign, revived: downed.length });
      return { feedback: downed.length ? `Revived ${downed.length} teammate(s).` : 'No downed teammates within 30m.' };
    }
  },

  air: {
    name: 'Air Support',
    desc: 'Marks a danger zone at your position — warns friendlies, appears on all maps',
    cooldown: 180,
    effect(room, caster) {
      if (!caster.lat) return { feedback: 'No GPS signal for air support targeting.' };
      const zone = {
        id: uuidv4(), zoneType: 'hazard', label: `🚁 AIR STRIKE — ${caster.callsign}`,
        shape: 'circle', center: [caster.lat, caster.lng], radius: 60,
        color: '#ff6600', latlngs: [], createdBy: { callsign: caster.callsign }, ts: Date.now(),
      };
      room.zones.push(zone);
      broadcastAll(room, { type: 'zone_added', zone });
      broadcastAll(room, { type: 'perk_anim', perk: 'air', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team: caster.team });
      const order = { id: uuidv4(), from: '⭐ AIR CMD', team: caster.team, text: `🚁 AIR SUPPORT inbound on ${caster.callsign}'s position! ALL UNITS CLEAR THE AREA!`, priority: 'high', ts: Date.now() };
      room.orders.push(order); broadcastAll(room, { type: 'new_order', order });
      setTimeout(() => { room.zones = room.zones.filter(z => z.id !== zone.id); broadcastAll(room, { type: 'zone_removed', id: zone.id }); }, 60000);
      logEvent('perk_air', { room: room.code, caster: caster.callsign });
      return { feedback: 'Air support called — danger zone marked for 60s.' };
    }
  },
};

// ── Admin-only perks ──────────────────────────────────────────────
const ADMIN_PERK_CONFIGS = {
  god_eye: {
    name: '👁 God\'s Eye',
    desc: 'Reveals ALL players from BOTH teams to admin map for 60s. Players unaware.',
    cooldown: 0,
  },
  intel_drop: {
    name: '📦 Intel Drop',
    desc: 'Sends all enemy positions to ONE team for 30 seconds',
    cooldown: 0,
  },
  blackout: {
    name: '⚫ Blackout',
    desc: 'Disables GPS map display for ALL players for 20s — total chaos',
    cooldown: 0,
  },
  flare: {
    name: '🔴 Flare',
    desc: 'Drops a visible flare marker on the map at a clicked position',
    cooldown: 0,
  },
  ceasefire: {
    name: '🕊 Ceasefire Signal',
    desc: 'Plays a visual ceasefire animation across all maps and alerts all players',
    cooldown: 0,
  },
};

// Haversine distance in metres
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ════════════════════════════════════════════════════════════════════
wss.on('connection', (ws) => {
  let playerId = null;
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── JOIN ──────────────────────────────────────────────────────
      case 'join': {
        roomCode = (msg.room || 'DEFAULT').toUpperCase().trim();
        const room = getOrCreateRoom(roomCode);
        playerId = uuidv4();
        const team = ['red', 'blue'].includes(msg.team) ? msg.team : 'red';

        // Check if any UAV is active for this player's team
        const uavActive = room.uavActive && room.uavActive[team];

        const player = {
          id: playerId,
          callsign: (msg.callsign || 'SOLDIER').toUpperCase().slice(0, 12),
          team, role: msg.role || 'Assault',
          status: 'alive', lat: null, lng: null, heading: 0,
          lastSeen: Date.now(), joinedAt: Date.now(),
          empBlocked: false, ws,
        };
        room.players[playerId] = player;

        // Send team-filtered snapshot
        sendTo(ws, { type: 'init', playerId, room: roomSnapshotForTeam(room, team, uavActive), roomCode });

        // Notify same team of new player joining
        broadcastTeam(room, team, { type: 'player_joined', player: playerPublic(player) }, ws);
        // Notify enemy team (no position data)
        const enemyTeam = team === 'red' ? 'blue' : 'red';
        broadcastTeam(room, enemyTeam, {
          type: 'enemy_count_update',
          redCount: Object.values(room.players).filter(p => p.team === 'red').length,
          blueCount: Object.values(room.players).filter(p => p.team === 'blue').length,
        });

        const joinMsg = { id: uuidv4(), from: 'SYSTEM', text: `📡 ${player.callsign} [${team.toUpperCase()} TEAM] has joined.`, priority: 'low', ts: Date.now() };
        room.orders.push(joinMsg);
        broadcastAll(room, { type: 'new_order', order: joinMsg });
        logEvent('player_joined', { roomCode, callsign: player.callsign, team });
        break;
      }

      // ── LOCATION — team-filtered broadcast ────────────────────────
      case 'location': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const player = room.players[playerId]; if (!player) break;

        player.lat = msg.lat; player.lng = msg.lng;
        player.heading = msg.heading || 0; player.lastSeen = Date.now();

        const locMsg = { type: 'location_update', playerId, lat: msg.lat, lng: msg.lng, heading: msg.heading || 0, lastSeen: player.lastSeen };

        // Send to own team always
        broadcastTeam(room, player.team, locMsg, ws);

        // Send to enemy ONLY if UAV is active for that team revealing this player
        const enemyTeam = player.team === 'red' ? 'blue' : 'red';
        if (room.uavActive && room.uavActive[enemyTeam]) {
          broadcastTeam(room, enemyTeam, locMsg);
        }
        break;
      }

      // ── STATUS ────────────────────────────────────────────────────
      case 'status': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const player = room.players[playerId]; if (!player) break;
        player.status = msg.status;
        // Status visible to all (it appears in squad list but not map unless team)
        broadcastAll(room, { type: 'status_update', playerId, status: msg.status, team: player.team });
        if (msg.status === 'medic') {
          const alert = { id: uuidv4(), from: player.callsign, team: player.team, text: `🚨 MEDIC NEEDED — ${player.callsign} (${player.team.toUpperCase()}) requires immediate assistance!`, priority: 'high', ts: Date.now() };
          room.orders.push(alert); broadcastAll(room, { type: 'new_order', order: alert });
        }
        if (msg.status === 'support') {
          const alert = { id: uuidv4(), from: player.callsign, team: player.team, text: `⚡ SUPPORT REQUESTED — ${player.callsign} (${player.team.toUpperCase()}) needs backup!`, priority: 'high', ts: Date.now() };
          room.orders.push(alert); broadcastAll(room, { type: 'new_order', order: alert });
        }
        logEvent('status_change', { roomCode, callsign: player.callsign, status: msg.status });
        break;
      }

      // ── ORDER / COMMS ─────────────────────────────────────────────
      case 'order': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const player = room.players[playerId]; if (!player) break;
        const order = { id: uuidv4(), from: player.callsign, team: player.team, text: msg.text.slice(0, 200), priority: msg.priority || 'normal', ts: Date.now() };
        room.orders.push(order); if (room.orders.length > 200) room.orders.shift();
        broadcastAll(room, { type: 'new_order', order });
        break;
      }

      // ── PERK ─────────────────────────────────────────────────────
      case 'perk': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const player = room.players[playerId]; if (!player) break;
        const config = PERK_CONFIGS[msg.perk];
        if (!config) break;

        const result = config.effect(room, player);
        // Send effect feedback to caster
        sendTo(ws, { type: 'perk_feedback', perk: msg.perk, message: result.feedback || 'Perk deployed.' });

        logEvent('perk_used', { roomCode, callsign: player.callsign, perk: msg.perk });
        break;
      }

      // ── OBJECTIVE ────────────────────────────────────────────────
      case 'objective': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const obj = room.objectives.find(o => o.id === msg.id);
        if (obj) { obj.done = msg.done; broadcastAll(room, { type: 'objective_update', id: msg.id, done: msg.done }); }
        break;
      }

      // ── ZONE ADD ─────────────────────────────────────────────────
      case 'zone_add': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const zone = {
          id: uuidv4(), zoneType: msg.zoneType || 'custom', label: msg.label || 'Zone',
          shape: msg.shape, latlngs: msg.latlngs || [], center: msg.center || null,
          radius: msg.radius || null, color: ZONE_TYPES[msg.zoneType]?.color || '#cc44ff',
          createdBy: { callsign: room.players[playerId]?.callsign || '?' }, ts: Date.now(),
        };
        room.zones.push(zone);
        broadcastAll(room, { type: 'zone_added', zone });
        break;
      }

      case 'zone_remove': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        if (msg.id === '__all__') { room.zones = []; broadcastAll(room, { type: 'zones_cleared' }); }
        else { room.zones = room.zones.filter(z => z.id !== msg.id); broadcastAll(room, { type: 'zone_removed', id: msg.id }); }
        break;
      }

      case 'ping': sendTo(ws, { type: 'pong' }); break;

      // ── ADMIN OBSERVER — full unfiltered data ────────────────────
      case 'admin_observe': {
        const observeCode = (msg.room || '').toUpperCase().trim();
        // Validate admin token
        if (!msg.token || !adminSessions.has(msg.token)) {
          sendTo(ws, { type: 'error', message: 'Unauthorized' });
          break;
        }
        const observeRoom = rooms[observeCode];
        if (!observeRoom) { sendTo(ws, { type: 'error', message: 'Room not found' }); break; }

        // Send full unfiltered snapshot
        sendTo(ws, {
          type: 'init',
          playerId: '__admin__',
          roomCode: observeCode,
          room: {
            players: Object.values(observeRoom.players).map(playerPublic),
            orders: observeRoom.orders.slice(-50),
            objectives: observeRoom.objectives,
            zones: observeRoom.zones,
            mapTiles: observeRoom.mapTiles,
            gamePaused: observeRoom.gamePaused,
          },
        });

        // Register this ws as an admin observer for the room so it gets broadcasts
        if (!observeRoom.adminObservers) observeRoom.adminObservers = new Set();
        observeRoom.adminObservers.add(ws);
        roomCode = observeCode; // so close handler cleans up
        playerId = '__admin_' + uuidv4(); // unique placeholder
        logEvent('admin_observe_start', { code: observeCode });
        break;
      }
    }
  });

  ws.on('close', () => {
    // Clean up admin observer registration from any room
    for (const r of Object.values(rooms)) {
      if (r.adminObservers) r.adminObservers.delete(ws);
    }
    // Skip cleanup for admin observer sessions
    if (!playerId || playerId.startsWith('__admin_') || !roomCode) return;
    const room = rooms[roomCode]; if (!room) return;
    const player = room.players[playerId];
    if (player) {
      const m = { id: uuidv4(), from: 'SYSTEM', text: `📴 ${player.callsign} has left the battlefield.`, priority: 'low', ts: Date.now() };
      room.orders.push(m);
      delete room.players[playerId];
      broadcastAll(room, { type: 'player_left', playerId });
      broadcastAll(room, { type: 'new_order', order: m });
      logEvent('player_left', { roomCode, callsign: player.callsign });
    }
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

// ════════════════════════════════════════════════════════════════════
// REST — Public
// ════════════════════════════════════════════════════════════════════
app.get('/health', (_, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length, uptime: Math.floor(process.uptime()) }));
app.get('/api/zone-types', (_, res) => res.json(ZONE_TYPES));

// ════════════════════════════════════════════════════════════════════
// REST — Admin Auth
// ════════════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════════
// REST — Admin: Full map data (all teams visible)
// ════════════════════════════════════════════════════════════════════
app.get('/api/admin/rooms/:code/live', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  // Admin sees EVERYTHING
  res.json({
    players: Object.values(room.players).map(playerPublic),
    zones: room.zones,
    objectives: room.objectives,
    mapTiles: room.mapTiles,
    gamePaused: room.gamePaused,
    orders: room.orders.slice(-20),
  });
});

// ════════════════════════════════════════════════════════════════════
// REST — Admin Perks
// ════════════════════════════════════════════════════════════════════
app.post('/api/admin/rooms/:code/perk', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const { perk, team, lat, lng } = req.body;

  switch (perk) {

    // 👁 God's Eye — admin can see all, doesn't affect players
    case 'god_eye':
      // Just return full data — admin already has it via /live
      logEvent('admin_perk_god_eye', { code: room.code });
      res.json({ ok: true, message: 'God\'s Eye active — use the admin map to see all players.' });
      break;

    // 📦 Intel Drop — reveal all enemies to one team for 30s
    case 'intel_drop': {
      if (!team) return res.status(400).json({ error: 'team required' });
      const enemyTeam = team === 'red' ? 'blue' : 'red';
      const enemies = Object.values(room.players).filter(p => p.team === enemyTeam && p.lat);
      if (!room.uavActive) room.uavActive = {};
      room.uavActive[team] = true;

      broadcastTeam(room, team, {
        type: 'uav_reveal',
        reveals: enemies.map(playerPublic),
        duration: 30000,
        callsign: '⭐ ADMIN INTEL',
      });
      const ord = { id: uuidv4(), from: '⭐ ADMIN', team: null, text: `📦 INTEL DROP — ${team.toUpperCase()} TEAM receives enemy positions for 30s!`, priority: 'high', ts: Date.now() };
      room.orders.push(ord); broadcastAll(room, { type: 'new_order', order: ord });

      setTimeout(() => {
        if (room.uavActive) room.uavActive[team] = false;
        broadcastTeam(room, team, { type: 'uav_expired' });
      }, 30000);

      logEvent('admin_perk_intel_drop', { code: room.code, team });
      res.json({ ok: true, message: `Intel dropped to ${team.toUpperCase()} — ${enemies.length} enemies revealed for 30s.` });
      break;
    }

    // ⚫ Blackout — all players' maps go black for 20s
    case 'blackout': {
      broadcastAll(room, { type: 'blackout', duration: 20000 });
      const ord = { id: uuidv4(), from: '⭐ ADMIN', team: null, text: '⚫ BLACKOUT — All GPS systems disrupted for 20 seconds!', priority: 'high', ts: Date.now() };
      room.orders.push(ord); broadcastAll(room, { type: 'new_order', order: ord });
      setTimeout(() => broadcastAll(room, { type: 'blackout_end' }), 20000);
      logEvent('admin_perk_blackout', { code: room.code });
      res.json({ ok: true, message: 'Blackout deployed — all player GPS maps scrambled for 20s.' });
      break;
    }

    // 🔴 Flare — drop a visible flare marker at lat/lng
    case 'flare': {
      if (!lat || !lng) return res.status(400).json({ error: 'lat/lng required' });
      const zone = {
        id: uuidv4(), zoneType: 'custom', label: '🔴 ADMIN FLARE',
        shape: 'circle', center: [lat, lng], radius: 15,
        color: '#ff0000', latlngs: [], createdBy: { callsign: 'ADMIN' }, ts: Date.now(),
      };
      room.zones.push(zone);
      broadcastAll(room, { type: 'zone_added', zone });
      broadcastAll(room, { type: 'perk_anim', perk: 'flare', lat, lng, callsign: 'ADMIN', team: 'admin' });
      const ord = { id: uuidv4(), from: '⭐ ADMIN', team: null, text: `🔴 FLARE deployed — check the map!`, priority: 'high', ts: Date.now() };
      room.orders.push(ord); broadcastAll(room, { type: 'new_order', order: ord });
      setTimeout(() => { room.zones = room.zones.filter(z => z.id !== zone.id); broadcastAll(room, { type: 'zone_removed', id: zone.id }); }, 120000);
      logEvent('admin_perk_flare', { code: room.code, lat, lng });
      res.json({ ok: true, message: 'Flare deployed — visible on all maps for 2 min.' });
      break;
    }

    // 🕊 Ceasefire — visual + audio alert across all maps
    case 'ceasefire': {
      broadcastAll(room, { type: 'ceasefire_signal' });
      const ord = { id: uuidv4(), from: '⭐ ADMIN', team: null, text: '🕊 CEASEFIRE SIGNAL — All units stop, weapons down, await admin instruction.', priority: 'high', ts: Date.now() };
      room.orders.push(ord); broadcastAll(room, { type: 'new_order', order: ord });
      logEvent('admin_perk_ceasefire', { code: room.code });
      res.json({ ok: true, message: 'Ceasefire signal sent to all players.' });
      break;
    }

    // 💀 Mass Elimination — eliminate an entire team
    case 'eliminate_team': {
      if (!team) return res.status(400).json({ error: 'team required' });
      Object.values(room.players).filter(p => p.team === team).forEach(p => {
        p.status = 'dead';
        broadcastAll(room, { type: 'status_update', playerId: p.id, status: 'dead', team: p.team });
      });
      const ord = { id: uuidv4(), from: '⭐ ADMIN', team: null, text: `💀 ${team.toUpperCase()} TEAM has been eliminated!`, priority: 'high', ts: Date.now() };
      room.orders.push(ord); broadcastAll(room, { type: 'new_order', order: ord });
      logEvent('admin_perk_eliminate', { code: room.code, team });
      res.json({ ok: true, message: `${team.toUpperCase()} team eliminated.` });
      break;
    }

    default:
      res.status(400).json({ error: 'Unknown perk' });
  }
});

app.get('/api/admin/perks', adminAuth, (_, res) => res.json(ADMIN_PERK_CONFIGS));

// ════════════════════════════════════════════════════════════════════
// REST — Admin: Rooms CRUD
// ════════════════════════════════════════════════════════════════════
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

app.post('/api/admin/rooms/:code/map', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  room.mapTiles = req.body.tiles || 'osm';
  broadcastAll(room, { type: 'map_tiles_changed', tiles: room.mapTiles });
  res.json({ ok: true });
});

// Zone management
app.post('/api/admin/rooms/:code/zones', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  const zone = { id: uuidv4(), zoneType: req.body.zoneType || 'custom', label: req.body.label || 'Zone', shape: req.body.shape, latlngs: req.body.latlngs || [], center: req.body.center || null, radius: req.body.radius || null, color: ZONE_TYPES[req.body.zoneType]?.color || '#cc44ff', createdBy: { callsign: 'ADMIN' }, ts: Date.now() };
  room.zones.push(zone); broadcastAll(room, { type: 'zone_added', zone });
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
  room.zones = []; broadcastAll(room, { type: 'zones_cleared' });
  res.json({ ok: true });
});

// Players
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
  broadcastAll(room, { type: 'status_update', playerId: player.id, status: player.status, team: player.team });
  res.json({ ok: true });
});

// Objectives
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

// Broadcast
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

app.get('/api/admin/events', adminAuth, (_, res) => res.json(eventLog.slice(-100).reverse()));

// Serve
app.get('/admin*', (_, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎯 Swindon Airsoft Tactical v4 — port ${PORT}`));
