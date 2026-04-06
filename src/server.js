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
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Credentials ───────────────────────────────────────────────────
const SUPER_ADMIN_USER = process.env.ADMIN_USER || 'chriszulu';
const SUPER_ADMIN_PASS = process.env.ADMIN_PASS || 'SwindonA1rsoft!';
const adminSessions = new Map();

// ════════════════════════════════════════════════════════════════════
// DATABASE LAYER
// Uses PostgreSQL (Railway add-on) when DATABASE_URL is set,
// otherwise falls back to JSON files so local dev still works.
// ════════════════════════════════════════════════════════════════════
let db = null; // pg Pool, or null if using file fallback

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

// ── In-memory caches (always used, DB is the source of truth) ─────
const siteAdmins = {};
const savedMaps = {};
const roomTemplates = {};
const playerAccounts = {};

// ── DB helpers ────────────────────────────────────────────────────
async function dbGet(key) {
  if (!db) return null;
  try {
    const r = await db.query('SELECT value FROM kv_store WHERE key=$1', [key]);
    return r.rows.length ? JSON.parse(r.rows[0].value) : null;
  } catch { return null; }
}

async function dbSet(key, value) {
  if (!db) return;
  try {
    await db.query(
      'INSERT INTO kv_store(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=$2, updated_at=NOW()',
      [key, JSON.stringify(value)]
    );
  } catch (e) { console.error('DB write error:', e.message); }
}

async function dbDel(key) {
  if (!db) return;
  try { await db.query('DELETE FROM kv_store WHERE key=$1', [key]); } catch {}
}

// ── Unified save: writes to DB (if available) AND file fallback ───
async function persist(collection, key, data) {
  const dbKey = collection + ':' + key;
  await dbSet(dbKey, data);
  // Always maintain file fallback too
  const fileMap = { 'site-admins': siteAdmins, 'saved-maps': savedMaps, 'room-templates': roomTemplates, 'player-accounts': playerAccounts };
  if (fileMap[collection]) saveJSON(collection + '.json', fileMap[collection]);
}

async function persistDel(collection, key) {
  await dbDel(collection + ':' + key);
  const fileMap = { 'site-admins': siteAdmins, 'saved-maps': savedMaps, 'room-templates': roomTemplates, 'player-accounts': playerAccounts };
  if (fileMap[collection]) saveJSON(collection + '.json', fileMap[collection]);
}

// ── DB schema init ────────────────────────────────────────────────
async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('ℹ No DATABASE_URL — using file storage (set up Railway Postgres for persistence)');
    loadFileData();
    return;
  }
  try {
    const { Pool } = require('pg');
    db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    // Create table if it doesn't exist
    await db.query(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ PostgreSQL connected');
    await loadDBData();
  } catch (e) {
    console.error('DB init failed:', e.message, '— falling back to file storage');
    db = null;
    loadFileData();
  }
}

// ── Load all data from DB into memory caches ──────────────────────
async function loadDBData() {
  try {
    const r = await db.query('SELECT key, value FROM kv_store');
    for (const row of r.rows) {
      const [collection, ...keyParts] = row.key.split(':');
      const key = keyParts.join(':');
      const val = JSON.parse(row.value);
      if (collection === 'site-admins') siteAdmins[key] = val;
      else if (collection === 'saved-maps') savedMaps[key] = val;
      else if (collection === 'room-templates') roomTemplates[key] = val;
      else if (collection === 'player-accounts') playerAccounts[key] = val;
    }
    console.log(`♻ Loaded from DB: ${Object.keys(siteAdmins).length} admins, ${Object.keys(savedMaps).length} saved maps, ${Object.keys(roomTemplates).length} maps, ${Object.keys(playerAccounts).length} players`);
    restoreRooms();
  } catch (e) {
    console.error('DB load failed:', e.message);
    loadFileData();
  }
}

// ── Load from JSON files (fallback when no DB) ────────────────────
function loadFileData() {
  Object.assign(siteAdmins, loadJSON('site-admins.json', {}));
  Object.assign(savedMaps, loadJSON('saved-maps.json', {}));
  Object.assign(roomTemplates, loadJSON('room-templates.json', {}));
  Object.assign(playerAccounts, loadJSON('player-accounts.json', {}));
  console.log(`♻ Loaded from files: ${Object.keys(siteAdmins).length} admins, ${Object.keys(savedMaps).length} saved maps, ${Object.keys(roomTemplates).length} maps, ${Object.keys(playerAccounts).length} players`);
  restoreRooms();
}

// ── Restore in-memory room objects from templates ─────────────────
function restoreRooms() {
  Object.entries(roomTemplates).forEach(([code, tmpl]) => {
    const room = makeRoom(code, tmpl.name, tmpl.password);
    room.zones = tmpl.zones || [];
    room.objectives = tmpl.objectives || [];
    room.allowedRoles = tmpl.allowedRoles || null;
    rooms[code] = room;
    console.log(`  🗺 Restored: ${tmpl.name} (${code})`);
  });
}

// ── Active in-memory state ────────────────────────────────────────
const rooms = {};
const eventLog = [];

async function persistRoomTemplate(room) {
  roomTemplates[room.code] = {
    name: room.name, password: room.password,
    zones: room.zones, objectives: room.objectives,
    allowedRoles: room.allowedRoles,
    roleLimits: room.roleLimits,
    createdAt: room.createdAt,
  };
  await persist('room-templates', room.code, roomTemplates[room.code]);
}

async function deleteRoomTemplate(code) {
  delete roomTemplates[code];
  await persistDel('room-templates', code);
  saveJSON('room-templates.json', roomTemplates);
}

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
  boundary:     { label: 'Game Boundary',  color: '#e8c84a', fillOpacity: 0.00 },
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
    allowedRoles: null, // null = all roles allowed; array = restricted list
    roleLimits: null,   // null = unlimited; obj like {Medic:3, Sniper:5} = capped per role
    activeMapId: null,
    createdAt: Date.now(),
    gamePaused: false,
    uavActive: {},
    teamCooldowns: { red: {}, blue: {} },  // perk → expiry timestamp
    empScramble: {},                         // team → { active, timeout }
  };
}

function getOrCreateRoom(code, name, password) {
  if (!rooms[code]) {
    rooms[code] = makeRoom(code, name, password);
    logEvent('room_created', { code, name });
  }
  return rooms[code];
}

// Room cleanup — only removes rooms that are NOT admin-persisted templates
setInterval(() => {
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    // Never auto-delete rooms that have a persisted template (admin created)
    if (roomTemplates[code]) continue;
    const active = Object.values(room.players).some(p => p.ws && p.ws.readyState === WebSocket.OPEN);
    if (!active) {
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

// ── Team cooldown check ───────────────────────────────────────────
// hackCd is per-player; all others are team-wide
function checkTeamCooldown(room, team, perk) {
  const cd = room.teamCooldowns[team][perk];
  if (cd && Date.now() < cd) {
    const rem = Math.ceil((cd - Date.now()) / 1000);
    return rem; // seconds remaining
  }
  return 0;
}
function setTeamCooldown(room, team, perk, seconds) {
  room.teamCooldowns[team][perk] = Date.now() + seconds * 1000;
  // Broadcast cooldown start so all team members lock the button
  broadcastTeam(room, team, { type: 'team_cooldown', perk, seconds, endsAt: room.teamCooldowns[team][perk] });
}

// ── Revive helper (used by medic proximity + medkit) ──────────────
function revivePlayer(room, target, byCallsign) {
  if (target.status === 'alive') return;
  // If bleed-out timer expired, player must reach respawn zone — medic cannot revive
  if (target._bleedExpired) {
    sendTo(target.ws, { type: 'revive_blocked', reason: 'Bleed-out expired — reach your respawn zone.' });
    return;
  }
  if (target._bleedTimer) { clearTimeout(target._bleedTimer); target._bleedTimer = null; }
  target.status = 'alive';
  target.bleedingOut = false;
  broadcastAll(room, { type: 'status_update', playerId: target.id, status: 'alive', team: target.team });
  sendTo(target.ws, { type: 'revived', by: byCallsign });
  const ord = { id: uuidv4(), from: byCallsign, team: target.team, text: `🩹 ${byCallsign} revived ${target.callsign}!`, priority: 'normal', ts: Date.now() };
  room.orders.push(ord); broadcastAll(room, { type: 'new_order', order: ord });
}

// ── Bleed-out: called when a player is set to 'dead' ─────────────
const BLEED_OUT_MS = 120000; // 2 minutes

function startBleedOut(room, player) {
  if (player._bleedTimer) clearTimeout(player._bleedTimer);
  player.bleedingOut = true;
  player._bleedExpired = false;
  broadcastAll(room, { type: 'bleed_start', playerId: player.id, duration: BLEED_OUT_MS });
  sendTo(player.ws, { type: 'you_are_bleeding', duration: BLEED_OUT_MS });
  player._bleedTimer = setTimeout(() => {
    player._bleedTimer = null;
    player.bleedingOut = false;
    player._bleedExpired = true; // medic can no longer revive — must reach respawn zone
    if (player.status !== 'alive') {
      const respawnType = player.team === 'red' ? 'respawn_red' : 'respawn_blue';
      const respawns = room.zones.filter(z => z.zoneType === respawnType);
      // Tell player they are now permanently dead until reaching respawn zone
      sendTo(player.ws, { type: 'bleed_expired', respawnZones: respawns });
      const ord = { id: uuidv4(), from: 'SYSTEM', team: player.team,
        text: `💀 ${player.callsign} bled out — must reach respawn zone to rejoin!`, priority: 'high', ts: Date.now() };
      room.orders.push(ord); broadcastAll(room, { type: 'new_order', order: ord });
    }
  }, BLEED_OUT_MS);
}

// ── Medic proximity scanner (runs every 3s per room) ─────────────
function startMedicScanner(room) {
  if (room._medicScanInterval) return;
  room._medicScanInterval = setInterval(() => {
    const players = Object.values(room.players);
    const MEDIC_RADIUS = 5; // metres
    players.forEach(medic => {
      if (medic.role !== 'Medic' || !medic.lat || medic.status !== 'alive') return;
      players.forEach(downed => {
        if (downed.team !== medic.team || downed.id === medic.id) return;
        if (downed.status === 'alive' || !downed.lat || downed._bleedExpired) return;
        const dist = haversine(medic.lat, medic.lng, downed.lat, downed.lng);
        if (dist <= MEDIC_RADIUS) {
          revivePlayer(room, downed, medic.callsign);
        }
      });
    });
  }, 3000);
}

const PERK_CONFIGS = {
  // COOLDOWNS (team-wide seconds): uav=60, emp=270, smoke=180, hack=150(per-player), medkit=120, air=240
  uav: {
    teamCd: 60,
    effect(room, caster) {
      const team = caster.team;
      const rem = checkTeamCooldown(room, team, 'uav');
      if (rem) return { feedback: `UAV on cooldown — ${rem}s remaining.`, cooldown: true };
      if (!caster.lat) return { feedback: 'No GPS — UAV needs your location.' };

      // Find enemies within 30m radius of caster
      const enemies = Object.values(room.players).filter(p =>
        p.team !== team && p.lat && haversine(caster.lat, caster.lng, p.lat, p.lng) <= 30
      );
      setTeamCooldown(room, team, 'uav', 60);
      if (!room.uavActive) room.uavActive = {};
      room.uavActive[team] = true;

      const UAV_DUR = 20000;
      broadcastTeam(room, team, {
        type: 'uav_reveal', reveals: enemies.map(playerPublic),
        duration: UAV_DUR, callsign: caster.callsign,
        casterLat: caster.lat, casterLng: caster.lng
      });
      // Send continuous UAV animation to own team only
      broadcastTeam(room, team, { type: 'perk_anim_persist', perk: 'uav', lat: caster.lat, lng: caster.lng, duration: UAV_DUR, callsign: caster.callsign, team });

      // Alert enemy team (no position info)
      const et = team === 'red' ? 'blue' : 'red';
      const warn = { id: uuidv4(), from: 'INTEL', team: et, text: '📡 UAV SCAN DETECTED — Enemy surveillance active! Move now!', priority: 'high', ts: Date.now() };
      room.orders.push(warn); broadcastTeam(room, et, { type: 'new_order', order: warn });

      setTimeout(() => {
        if (room.uavActive) room.uavActive[team] = false;
        broadcastTeam(room, team, { type: 'uav_expired' });
      }, UAV_DUR);

      logEvent('perk_uav', { room: room.code, caster: caster.callsign, hits: enemies.length });
      return { feedback: `UAV scanning 30m — ${enemies.length} contact(s) revealed for 20s.` };
    }
  },

  emp: {
    teamCd: 270, // 4m30s
    effect(room, caster) {
      const team = caster.team;
      const rem = checkTeamCooldown(room, team, 'emp');
      if (rem) return { feedback: `EMP on cooldown — ${rem}s remaining.`, cooldown: true };
      if (!caster.lat) return { feedback: 'No GPS — EMP requires location.' };

      const EMP_DUR = 30000; // 30s scramble
      const enemies = Object.values(room.players).filter(p =>
        p.team !== team && p.lat && haversine(caster.lat, caster.lng, p.lat, p.lng) <= 100
      );
      setTeamCooldown(room, team, 'emp', 270);

      if (!room.empScramble) room.empScramble = {};
      const et = team === 'red' ? 'blue' : 'red';

      // Scramble enemy locations on maps — send fake randomised positions
      enemies.forEach(e => {
        sendTo(e.ws, { type: 'emp_scramble_start', duration: EMP_DUR, from: caster.callsign });
      });
      // Tell the caster's team to show scrambled enemy markers
      broadcastTeam(room, team, { type: 'emp_scramble_enemies', duration: EMP_DUR, enemyTeam: et });
      // Visual animation to own team only
      broadcastTeam(room, team, { type: 'perk_anim', perk: 'emp', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team });

      setTimeout(() => {
        enemies.forEach(e => sendTo(e.ws, { type: 'emp_scramble_end' }));
        broadcastTeam(room, team, { type: 'emp_scramble_done', enemyTeam: et });
      }, EMP_DUR);

      logEvent('perk_emp', { room: room.code, caster: caster.callsign, hit: enemies.length });
      return { feedback: enemies.length ? `EMP hit ${enemies.length} enemies — scrambling their positions for 30s.` : 'EMP deployed — no enemies in range.' };
    }
  },

  smoke: {
    teamCd: 180, // 3 minutes
    effect(room, caster) {
      const team = caster.team;
      const rem = checkTeamCooldown(room, team, 'smoke');
      if (rem) return { feedback: `Smoke on cooldown — ${rem}s remaining.`, cooldown: true };
      if (!caster.lat) return { feedback: 'No GPS for smoke.' };
      setTeamCooldown(room, team, 'smoke', 180);

      const SMOKE_DUR = 30000;
      const zone = {
        id: uuidv4(), zoneType: 'custom', label: `💨 SMOKE — ${caster.callsign}`,
        shape: 'circle', center: [caster.lat, caster.lng], radius: 15,
        color: '#888888', fillOpacity: 0.6, latlngs: [],
        createdBy: { callsign: caster.callsign }, ts: Date.now(), isSmoke: true,
      };
      room.zones.push(zone);
      broadcastAll(room, { type: 'zone_added', zone });
      // Persistent smoke animation to own team only
      broadcastTeam(room, team, { type: 'perk_anim_persist', perk: 'smoke', lat: caster.lat, lng: caster.lng, duration: SMOKE_DUR, callsign: caster.callsign, team });

      setTimeout(() => {
        room.zones = room.zones.filter(z => z.id !== zone.id);
        broadcastAll(room, { type: 'zone_removed', id: zone.id });
        broadcastTeam(room, team, { type: 'perk_anim_end', perk: 'smoke' });
      }, SMOKE_DUR);

      return { feedback: 'Smoke screen deployed for 30s.' };
    }
  },

  hack: {
    // PER-PLAYER cooldown (150s = 2m30s) — handled client-side, enforced here via player flag
    playerCd: 150,
    effect(room, caster) {
      const now = Date.now();
      if (caster._hackCooldownUntil && now < caster._hackCooldownUntil) {
        const rem = Math.ceil((caster._hackCooldownUntil - now) / 1000);
        return { feedback: `Hack on cooldown — ${rem}s remaining.`, cooldown: true };
      }
      const enemies = Object.values(room.players).filter(p => p.team !== caster.team && p.lat);
      if (!enemies.length) return { feedback: 'No targets with GPS signal.' };

      caster._hackCooldownUntil = now + 150000;
      // Notify only caster of their personal cooldown
      sendTo(caster.ws, { type: 'player_cooldown', perk: 'hack', seconds: 150, endsAt: caster._hackCooldownUntil });

      const target = enemies[Math.floor(Math.random() * enemies.length)];
      sendTo(caster.ws, { type: 'hack_reveal', target: playerPublic(target), duration: 10000 });
      // Only tell the target they were hacked — NOT the caster's team
      sendTo(target.ws, { type: 'hack_detected', from: caster.callsign });
      // Animation to caster only
      sendTo(caster.ws, { type: 'perk_anim', perk: 'hack', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team: caster.team });

      logEvent('perk_hack', { room: room.code, caster: caster.callsign, target: target.callsign });
      return { feedback: `Hacked: ${target.callsign} revealed for 10s.` };
    }
  },

  medkit: {
    teamCd: 120, // 2 minutes
    effect(room, caster) {
      const team = caster.team;
      const rem = checkTeamCooldown(room, team, 'medkit');
      if (rem) return { feedback: `Medkit on cooldown — ${rem}s remaining.`, cooldown: true };
      if (!caster.lat) return { feedback: 'No GPS — cannot locate teammates.' };
      setTeamCooldown(room, team, 'medkit', 120);

      const MEDKIT_RADIUS = 10; // metres
      const downed = Object.values(room.players).filter(p =>
        p.team === team && p.id !== caster.id && p.status !== 'alive' && p.lat &&
        haversine(caster.lat, caster.lng, p.lat, p.lng) <= MEDKIT_RADIUS
      );
      downed.forEach(p => revivePlayer(room, p, caster.callsign + ' (MEDKIT)'));
      // Animation to own team only
      broadcastTeam(room, team, { type: 'perk_anim', perk: 'medkit', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team });

      logEvent('perk_medkit', { room: room.code, caster: caster.callsign, revived: downed.length });
      return { feedback: downed.length ? `Medkit revived ${downed.length} teammate(s) within ${MEDKIT_RADIUS}m.` : `No downed teammates within ${MEDKIT_RADIUS}m.` };
    }
  },

  air: {
    teamCd: 240, // 4 minutes
    effect(room, caster) {
      const team = caster.team;
      const rem = checkTeamCooldown(room, team, 'air');
      if (rem) return { feedback: `Air support on cooldown — ${rem}s remaining.`, cooldown: true };
      if (!caster.lat) return { feedback: 'No GPS for air support.' };
      setTeamCooldown(room, team, 'air', 240);

      const zone = {
        id: uuidv4(), zoneType: 'hazard', label: `🚁 SUPPRESSION FIRE — ${caster.callsign}`,
        shape: 'circle', center: [caster.lat, caster.lng], radius: 10, // 10m radius
        color: '#ff6600', latlngs: [], createdBy: { callsign: caster.callsign }, ts: Date.now(),
      };
      room.zones.push(zone);
      broadcastAll(room, { type: 'zone_added', zone });
      broadcastTeam(room, team, { type: 'perk_anim', perk: 'air', lat: caster.lat, lng: caster.lng, callsign: caster.callsign, team });
      const ord = { id: uuidv4(), from: '⭐ AIR CMD', team, text: `🚁 AIR SUPPORT — Suppression fire at ${caster.callsign}'s position! Enemies in zone are pinned!`, priority: 'high', ts: Date.now() };
      room.orders.push(ord); broadcastAll(room, { type: 'new_order', order: ord });
      setTimeout(() => {
        room.zones = room.zones.filter(z => z.id !== zone.id);
        broadcastAll(room, { type: 'zone_removed', id: zone.id });
      }, 60000);

      logEvent('perk_air', { room: room.code, caster: caster.callsign });
      return { feedback: 'Air support called — 10m danger zone marked for 60s.' };
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
        const reqRole = msg.role || 'Assault';
        // Check role limit
        if (room.roleLimits && room.roleLimits[reqRole] !== undefined) {
          const currentCount = Object.values(room.players).filter(p => p.role === reqRole).length;
          if (currentCount >= room.roleLimits[reqRole]) {
            sendTo(ws, { type: 'error', code: 'ROLE_FULL', message: `${reqRole} slots are full (${room.roleLimits[reqRole]} max). Choose another role.` });
            break;
          }
        }
        const player = { id: playerId, callsign: (msg.callsign||'SOLDIER').toUpperCase().slice(0,12), team, role: reqRole, status: 'alive', lat: null, lng: null, heading: 0, lastSeen: Date.now(), joinedAt: Date.now(), ws };
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
        // ── Respawn zone check — if dead+expired and inside respawn zone, auto-revive ──
        if (player.status === 'dead' && player._bleedExpired && msg.lat && msg.lng) {
          const respawnType = player.team === 'red' ? 'respawn_red' : 'respawn_blue';
          const inZone = room.zones.filter(z => z.zoneType === respawnType).some(z => {
            if (z.shape === 'circle' && z.center) return haversine(msg.lat, msg.lng, z.center[0], z.center[1]) <= z.radius;
            return false; // polygon respawn zones not supported for auto-detect yet
          });
          if (inZone) {
            player._bleedExpired = false;
            player.status = 'alive';
            broadcastAll(room, { type: 'status_update', playerId: player.id, status: 'alive', team: player.team });
            sendTo(player.ws, { type: 'respawn_zone_revive' });
            const ord = { id: uuidv4(), from: 'SYSTEM', team: player.team,
              text: `🔄 ${player.callsign} reached respawn zone — back in action!`, priority: 'normal', ts: Date.now() };
            room.orders.push(ord); broadcastAll(room, { type: 'new_order', order: ord });
          }
        }
        break;
      }

      case 'status': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode]; if (!room) break;
        const player = room.players[playerId]; if (!player) break;
        // Only allow medic and support from client — 'dead' removed (medic now triggers bleed-out)
        // 'alive' is server-automated via revive/bleed-out
        const allowedStatuses = ['medic', 'support'];
        if (!allowedStatuses.includes(msg.status)) break;
        const prev = player.status;
        player.status = msg.status;
        broadcastAll(room, { type: 'status_update', playerId, status: msg.status, team: player.team });

        if (msg.status === 'medic' && prev !== 'dead') {
          // MEDIC NEEDED = player is down — trigger 2-min bleed-out
          player.status = 'dead'; // internal status is 'dead' for medic-scanner
          broadcastAll(room, { type: 'status_update', playerId, status: 'dead', team: player.team });
          startBleedOut(room, player);
          startMedicScanner(room);
          const alert = { id: uuidv4(), from: player.callsign, team: player.team,
            text: `🚨 MEDIC NEEDED — ${player.callsign} (${player.team.toUpperCase()}) is down! 2 minutes!`, priority: 'high', ts: Date.now() };
          room.orders.push(alert); broadcastAll(room, { type: 'new_order', order: alert });
          // Tell the downed player to start the bleed-out UI
          sendTo(ws, { type: 'you_are_bleeding', duration: 120000 });
        }

        if (msg.status === 'support') {
          const alert = { id: uuidv4(), from: player.callsign, team: player.team,
            text: `⚡ SUPPORT NEEDED — ${player.callsign} (${player.team.toUpperCase()}) needs backup!`, priority: 'high', ts: Date.now() };
          room.orders.push(alert); broadcastAll(room, { type: 'new_order', order: alert });
          // Auto-reset support status to alive after 60 seconds
          setTimeout(() => {
            if (room.players[playerId] && room.players[playerId].status === 'support') {
              room.players[playerId].status = 'alive';
              broadcastAll(room, { type: 'status_update', playerId, status: 'alive', team: player.team });
              sendTo(ws, { type: 'support_expired' });
            }
          }, 60000);
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
        if (player.status === 'dead') { sendTo(ws, { type: 'perk_feedback', perk: msg.perk, message: 'Cannot use perks while down.' }); break; }
        const cfg = PERK_CONFIGS[msg.perk]; if (!cfg) break;
        const result = cfg.effect(room, player);
        sendTo(ws, { type: 'perk_feedback', perk: msg.perk, message: result.feedback });
        if (!result.cooldown) logEvent('perk_used', { roomCode, callsign: player.callsign, perk: msg.perk });
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
    allowedRoles: r.allowedRoles || null,
    roleLimits: r.roleLimits || null,
  })));
});

// ════════════════════════════════════════════════════════════════════
// REST — Player Accounts
// ════════════════════════════════════════════════════════════════════
// playerAccounts loaded in initDB/loadFileData above
const playerSessions = new Map(); // token → { username, ...profile }

// Simple password hash (XOR + base64 — good enough for local airsoft app)
function hashPass(p) { return Buffer.from(p.split('').map((c,i)=>c.charCodeAt(0)^(i%7+13)).join(',')).toString('base64'); }

app.post('/api/player/register', (req, res) => {
  const { username, password, email, phone, address, callsign } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (playerAccounts[username.toLowerCase()]) return res.status(409).json({ error: 'Username already taken' });
  const account = {
    username: username.toLowerCase(), displayName: callsign || username,
    passwordHash: hashPass(password),
    email: email || '', phone: phone || '', address: address || '',
    callsign: (callsign || username).toUpperCase().slice(0,12),
    createdAt: Date.now(), lastLogin: null,
  };
  playerAccounts[account.username] = account;
  persist('player-accounts', account.username, account);
  logEvent('player_registered', { username: account.username });
  const token = uuidv4();
  playerSessions.set(token, { username: account.username, callsign: account.callsign });
  setTimeout(() => playerSessions.delete(token), 24 * 60 * 60 * 1000);
  res.json({ token, callsign: account.callsign, username: account.username });
});

app.post('/api/player/login', (req, res) => {
  const { username, password } = req.body;
  const account = playerAccounts[username?.toLowerCase()];
  if (!account || account.passwordHash !== hashPass(password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  account.lastLogin = Date.now();
  persist('player-accounts', account.username, account);
  const token = uuidv4();
  playerSessions.set(token, { username: account.username, callsign: account.callsign, email: account.email });
  setTimeout(() => playerSessions.delete(token), 24 * 60 * 60 * 1000);
  logEvent('player_login', { username: account.username });
  res.json({ token, callsign: account.callsign, username: account.username, email: account.email, phone: account.phone });
});

app.get('/api/player/me', (req, res) => {
  const token = req.headers['x-player-token'];
  const sess = token && playerSessions.get(token);
  if (!sess) return res.status(401).json({ error: 'Not logged in' });
  const account = playerAccounts[sess.username];
  if (!account) return res.status(404).json({ error: 'Account not found' });
  res.json({ username: account.username, callsign: account.callsign, email: account.email, phone: account.phone, address: account.address, createdAt: account.createdAt });
});

app.put('/api/player/me', (req, res) => {
  const token = req.headers['x-player-token'];
  const sess = token && playerSessions.get(token);
  if (!sess) return res.status(401).json({ error: 'Not logged in' });
  const account = playerAccounts[sess.username];
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const { callsign, email, phone, address, password, newPassword } = req.body;
  if (password && newPassword) {
    if (account.passwordHash !== hashPass(password)) return res.status(401).json({ error: 'Wrong current password' });
    account.passwordHash = hashPass(newPassword);
  }
  if (callsign) { account.callsign = callsign.toUpperCase().slice(0,12); sess.callsign = account.callsign; }
  if (email !== undefined) account.email = email;
  if (phone !== undefined) account.phone = phone;
  if (address !== undefined) account.address = address;
  persist('player-accounts', account.username, account);
  res.json({ ok: true, callsign: account.callsign });
});

// Admin: view all player accounts
app.get('/api/admin/player-accounts', superAdminAuth, (req, res) => {
  const accounts = Object.values(playerAccounts).map(a => ({
    username: a.username, callsign: a.callsign, email: a.email,
    phone: a.phone, createdAt: a.createdAt, lastLogin: a.lastLogin,
  }));
  res.json(accounts);
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

// Super admin password change
app.post('/api/admin/change-password', adminAuth, (req, res) => {
  const sess = req.adminSession;
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  if (sess.role === 'super') {
    if (currentPassword !== SUPER_ADMIN_PASS) return res.status(401).json({ error: 'Wrong current password' });
    // Update env override — note: in-memory only, set via env var for persistence
    process.env.ADMIN_PASS = newPassword;
    logEvent('super_admin_pw_change', { by: sess.username });
    return res.json({ ok: true, note: 'Password updated for this session. Set ADMIN_PASS env var to make permanent.' });
  }
  // Site admin
  const sa = siteAdmins[sess.username];
  if (!sa) return res.status(404).json({ error: 'Admin not found' });
  if (currentPassword !== sa.password) return res.status(401).json({ error: 'Wrong current password' });
  sa.password = newPassword;
  persist('site-admins', sess.username, sa);
  logEvent('admin_pw_change', { username: sess.username });
  res.json({ ok: true });
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
  persist('site-admins', username, siteAdmins[username]);
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
  persist('site-admins', u, siteAdmins[u]);
  res.json({ ok: true });
});

app.delete('/api/admin/site-admins/:username', superAdminAuth, (req, res) => {
  const _delSA=req.params.username; delete siteAdmins[_delSA]; persistDel('site-admins',_delSA); saveJSON('site-admins.json',siteAdmins); res.json({ ok: true });
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
    allowedRoles: r.allowedRoles,
    roleLimits: r.roleLimits || null,
  })));
});

app.post('/api/admin/rooms', adminAuth, (req, res) => {
  const { code, name, password } = req.body;
  const c = (code || uuidv4().slice(0,6)).toUpperCase();
  // Site admins: can create new maps (auto-assigned to them) but cannot take over another admin's map
  if (req.adminSession.role !== 'super' && rooms[c] && !canAccessRoom(req.adminSession, c)) {
    return res.status(403).json({ error: 'Map code already in use by another site.' });
  }
  const room = getOrCreateRoom(c, name||c, password||'');
  if (name) room.name = name;
  if (password !== undefined) room.password = password;
  // If site admin, auto-assign this room to their managed sites
  if (req.adminSession.role === 'site') {
    const sa = siteAdmins[req.adminSession.username];
    if (sa && !sa.sites.includes(c)) { sa.sites.push(c); persist('site-admins', req.adminSession.username, sa); }
  }
  persistRoomTemplate(room).catch(()=>{});
  res.json({ code: room.code, name: room.name });
});

app.put('/api/admin/rooms/:code', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  const { name, password } = req.body;
  if (name !== undefined) { room.name = name; broadcastAll(room, { type: 'room_renamed', name }); }
  if (password !== undefined) room.password = password;
  if (req.body.allowedRoles !== undefined) room.allowedRoles = req.body.allowedRoles;
  if (req.body.roleLimits !== undefined) room.roleLimits = req.body.roleLimits;
  persistRoomTemplate(room).catch(()=>{});
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
  deleteRoomTemplate(req.params.code.toUpperCase()).catch(()=>{});
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
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
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
  persistRoomTemplate(room).catch(()=>{});
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
  persistRoomTemplate(room).catch(()=>{});
  res.json(obj);
});

app.delete('/api/admin/rooms/:code/objectives/:objId', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  room.objectives = room.objectives.filter(o => o.id !== req.params.objId);
  broadcastAll(room, { type: 'objective_removed', id: req.params.objId });
  persistRoomTemplate(room).catch(()=>{});
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
  persistRoomTemplate(room).catch(()=>{});
  res.json(zone);
});

app.delete('/api/admin/rooms/:code/zones/:zid', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  room.zones = room.zones.filter(z => z.id !== req.params.zid);
  broadcastAll(room, { type: 'zone_removed', id: req.params.zid });
  persistRoomTemplate(room).catch(()=>{});
  res.json({ ok: true });
});

app.delete('/api/admin/rooms/:code/zones', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  room.zones = []; broadcastAll(room, { type: 'zones_cleared' });
  persistRoomTemplate(room).catch(()=>{});
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// REST — Saved Maps (named map templates with zones + objectives)
// ════════════════════════════════════════════════════════════════════
app.get('/api/admin/saved-maps', adminAuth, (req, res) => {
  const sess = req.adminSession;
  const maps = Object.values(savedMaps).filter(m => sess.role === 'super' || sess.managedSites.includes(m.siteCode) || m.createdBy === sess.username);
  res.json(maps.map(m => ({ id: m.id, name: m.name, gameType: m.gameType||'Standard', siteCode: m.siteCode, zoneCount: (m.zones||[]).length, objectiveCount: (m.objectives||[]).length, createdAt: m.createdAt, createdBy: m.createdBy })));
});

app.post('/api/admin/saved-maps', adminAuth, (req, res) => {
  const { name, siteCode, zones, objectives } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  // Site admins can only save templates for their assigned maps
  if (req.adminSession.role !== 'super' && siteCode && !req.adminSession.managedSites.includes(siteCode)) {
    return res.status(403).json({ error: 'No access to that site' });
  }
  const map = { id: uuidv4(), name, siteCode: siteCode||'', gameType: req.body.gameType||'Standard', zones: zones||[], objectives: objectives||[], createdBy: req.adminSession.username, createdAt: Date.now() };
  savedMaps[map.id] = map;
  persist('saved-maps', map.id, map);
  logEvent('map_saved', { name, by: req.adminSession.username });
  res.json(map);
});

app.put('/api/admin/saved-maps/:id', adminAuth, (req, res) => {
  const map = savedMaps[req.params.id]; if (!map) return res.status(404).json({ error: 'Not found' });
  if (req.adminSession.role !== 'super' && map.siteCode && !req.adminSession.managedSites.includes(map.siteCode)) {
    return res.status(403).json({ error: 'No access' });
  }
  const { name, zones, objectives } = req.body;
  if (name) map.name = name;
  if (zones) map.zones = zones;
  if (objectives) map.objectives = objectives;
  map.updatedAt = Date.now();
  persist('saved-maps', map.id, map);
  res.json(map);
});

app.delete('/api/admin/saved-maps/:id', adminAuth, (req, res) => {
  const map = savedMaps[req.params.id]; if (!map) return res.status(404).json({ error: 'Not found' });
  if (req.adminSession.role !== 'super' && map.siteCode && !req.adminSession.managedSites.includes(map.siteCode)) {
    return res.status(403).json({ error: 'No access' });
  }
  const _delSM=req.params.id; delete savedMaps[_delSM]; persistDel('saved-maps',_delSM); saveJSON('saved-maps.json',savedMaps); res.json({ ok: true });
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
  persistRoomTemplate(room).catch(()=>{});
  logEvent('map_loaded', { room: room.code, map: map.name, by: req.adminSession.username });
  res.json({ ok: true, message: `Map "${map.name}" loaded.` });
});

// ════════════════════════════════════════════════════════════════════
// REST — Players, Broadcast, Admin Perks, Event Log
// ════════════════════════════════════════════════════════════════════
// Respawn a single player
app.post('/api/admin/rooms/:code/respawn-player', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()]; if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  const player = room.players[req.body.playerId]; if (!player) return res.status(404).json({ error: 'Player not found' });
  if (player._bleedTimer) { clearTimeout(player._bleedTimer); player._bleedTimer = null; }
  player.status = 'alive'; player.bleedingOut = false; player._bleedExpired = false;
  broadcastAll(room, { type: 'status_update', playerId: player.id, status: 'alive', team: player.team });
  sendTo(player.ws, { type: 'respawn_zone_revive' });
  const msg = { id: uuidv4(), from: '⭐ ADMIN', team: player.team, text: `🔄 ${player.callsign} respawned by admin.`, priority: 'normal', ts: Date.now() };
  room.orders.push(msg); broadcastAll(room, { type: 'new_order', order: msg });
  logEvent('player_respawned', { code: room.code, callsign: player.callsign, by: req.adminSession.username });
  res.json({ ok: true });
});

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

// Ceasefire end — admin clicks Continue
app.post('/api/admin/rooms/:code/ceasefire-end', adminAuth, (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Not found' });
  if (!canAccessRoom(req.adminSession, room.code)) return res.status(403).json({ error: 'No access' });
  broadcastAll(room, { type: 'ceasefire_end' });
  const msg = { id: uuidv4(), from: '⭐ ADMIN', text: '⚔ CEASEFIRE ENDED — Hostilities may resume!', priority: 'high', ts: Date.now() };
  room.orders.push(msg); broadcastAll(room, { type: 'new_order', order: msg });
  res.json({ ok: true });
});

app.get('/api/admin/events', adminAuth, (_, res) => res.json(eventLog.slice(-100).reverse()));

// ════════════════════════════════════════════════════════════════════
// REST — Data Export / Import (super admin only — for backup/restore)
// ════════════════════════════════════════════════════════════════════
app.get('/api/admin/export', superAdminAuth, (_, res) => {
  // Export everything in one JSON blob for backup
  const exportData = {
    exportedAt: new Date().toISOString(),
    version: 2,
    roomTemplates,
    savedMaps,
    siteAdmins: Object.fromEntries(Object.entries(siteAdmins).map(([k,v]) => [k, {...v, password: '[REDACTED]'}])),
    playerAccounts: Object.fromEntries(
      Object.entries(playerAccounts || {}).map(([k,v]) => [k, { ...v, passwordHash: '[REDACTED]' }])
    ),
    stats: {
      rooms: Object.keys(roomTemplates).length,
      maps: Object.keys(savedMaps).length,
      siteAdmins: Object.keys(siteAdmins).length,
      players: Object.keys(playerAccounts || {}).length,
    }
  };
  res.setHeader('Content-Disposition', 'attachment; filename="zgt-backup-' + Date.now() + '.json"');
  res.json(exportData);
});

// Full backup including passwords (for migration between servers)
app.get('/api/admin/export-full', superAdminAuth, (_, res) => {
  const exportData = {
    exportedAt: new Date().toISOString(),
    version: 2,
    roomTemplates, savedMaps, siteAdmins,
    playerAccounts: playerAccounts || {},
  };
  res.setHeader('Content-Disposition', 'attachment; filename="zgt-full-backup-' + Date.now() + '.json"');
  res.json(exportData);
  logEvent('data_exported', { by: 'super', at: new Date().toISOString() });
});

app.post('/api/admin/import', superAdminAuth, async (req, res) => {
  const data = req.body;
  if (!data || data.version !== 2) return res.status(400).json({ error: 'Invalid backup file. Must be a ZGT v2 export.' });
  let imported = { rooms: 0, maps: 0, siteAdmins: 0, players: 0 };

  if (data.roomTemplates) {
    for (const [code, tmpl] of Object.entries(data.roomTemplates)) {
      roomTemplates[code] = tmpl;
      await persist('room-templates', code, tmpl);
      if (!rooms[code]) {
        const room = makeRoom(code, tmpl.name, tmpl.password);
        room.zones = tmpl.zones || []; room.objectives = tmpl.objectives || [];
        room.allowedRoles = tmpl.allowedRoles || null;
        room.roleLimits = tmpl.roleLimits || null;
        rooms[code] = room;
      }
    }
    saveJSON('room-templates.json', roomTemplates);
    imported.rooms = Object.keys(data.roomTemplates).length;
  }
  if (data.savedMaps) {
    for (const [id, map] of Object.entries(data.savedMaps)) {
      savedMaps[id] = map; await persist('saved-maps', id, map);
    }
    saveJSON('saved-maps.json', savedMaps);
    imported.maps = Object.keys(data.savedMaps).length;
  }
  if (data.siteAdmins) {
    for (const [u, admin] of Object.entries(data.siteAdmins)) {
      siteAdmins[u] = admin; await persist('site-admins', u, admin);
    }
    saveJSON('site-admins.json', siteAdmins);
    imported.siteAdmins = Object.keys(data.siteAdmins).length;
  }
  if (data.playerAccounts) {
    for (const [u, acct] of Object.entries(data.playerAccounts)) {
      playerAccounts[u] = acct; await persist('player-accounts', u, acct);
    }
    saveJSON('player-accounts.json', playerAccounts);
    imported.players = Object.keys(data.playerAccounts).length;
  }
  logEvent('data_imported', { imported, by: 'super' });
  res.json({ ok: true, imported });
});

// ════════════════════════════════════════════════════════════════════
// Serve
// ════════════════════════════════════════════════════════════════════
app.get('/admin*', (_, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;

// Initialise DB then start server
initDB().then(() => {
  server.listen(PORT, () => {
    const storage = process.env.DATABASE_URL ? '🐘 PostgreSQL' : '📁 File storage';
    console.log(`🎯 Zulu's Game Tracker — port ${PORT} — ${storage}`);
  });
}).catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});
