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

// ── In-memory state ──────────────────────────────────────────────
const rooms = {}; // roomCode -> { players: {}, orders: [], objectives: [] }

function getOrCreateRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      code,
      players: {},
      orders: [
        { id: uuidv4(), from: 'CMD', text: 'Welcome to the battlefield. Await further orders.', priority: 'normal', ts: Date.now() }
      ],
      objectives: [
        { id: uuidv4(), text: 'Establish base position', done: false },
        { id: uuidv4(), text: 'Secure primary objective', done: false },
        { id: uuidv4(), text: 'Eliminate enemy HQ', done: false },
      ],
      createdAt: Date.now()
    };
  }
  return rooms[code];
}

// Clean empty rooms every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    const hasActivePlayers = Object.values(room.players).some(p => p.ws && p.ws.readyState === WebSocket.OPEN);
    if (!hasActivePlayers && now - room.createdAt > 600_000) {
      delete rooms[code];
    }
  }
}, 600_000);

// ── Broadcast helpers ─────────────────────────────────────────────
function broadcast(room, msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  for (const player of Object.values(room.players)) {
    if (player.ws && player.ws !== excludeWs && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(data);
    }
  }
}

function broadcastAll(room, msg) {
  broadcast(room, msg, null);
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function roomSnapshot(room) {
  return {
    players: Object.values(room.players).map(p => ({
      id: p.id,
      callsign: p.callsign,
      team: p.team,
      role: p.role,
      status: p.status,
      lat: p.lat,
      lng: p.lng,
      heading: p.heading,
      lastSeen: p.lastSeen,
      rank: p.rank,
    })),
    orders: room.orders.slice(-50),
    objectives: room.objectives,
  };
}

// ── WebSocket handler ─────────────────────────────────────────────
wss.on('connection', (ws) => {
  let playerId = null;
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── JOIN ──────────────────────────────────────────────────
      case 'join': {
        roomCode = (msg.room || 'DEFAULT').toUpperCase().trim();
        const room = getOrCreateRoom(roomCode);
        playerId = uuidv4();

        const player = {
          id: playerId,
          callsign: (msg.callsign || 'SOLDIER').toUpperCase().slice(0, 12),
          team: msg.team || 'alpha',
          role: msg.role || 'Assault',
          rank: msg.rank || 'Private',
          status: 'alive',
          lat: null,
          lng: null,
          heading: 0,
          lastSeen: Date.now(),
          ws,
        };
        room.players[playerId] = player;

        // Send full snapshot to joiner
        sendTo(ws, { type: 'init', playerId, room: roomSnapshot(room), roomCode });

        // Notify others
        broadcast(room, {
          type: 'player_joined',
          player: { id: playerId, callsign: player.callsign, team: player.team, role: player.role, rank: player.rank, status: 'alive', lat: null, lng: null, heading: 0, lastSeen: Date.now() }
        }, ws);

        // System message
        const joinOrder = { id: uuidv4(), from: 'SYSTEM', text: `📡 ${player.callsign} has joined the battlefield.`, priority: 'low', ts: Date.now() };
        room.orders.push(joinOrder);
        broadcastAll(room, { type: 'new_order', order: joinOrder });

        console.log(`[${roomCode}] ${player.callsign} joined (${Object.keys(room.players).length} players)`);
        break;
      }

      // ── GPS LOCATION UPDATE ───────────────────────────────────
      case 'location': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode];
        if (!room) break;
        const player = room.players[playerId];
        if (!player) break;

        player.lat = msg.lat;
        player.lng = msg.lng;
        player.heading = msg.heading || 0;
        player.lastSeen = Date.now();

        broadcast(room, {
          type: 'location_update',
          playerId,
          lat: msg.lat,
          lng: msg.lng,
          heading: msg.heading || 0,
          lastSeen: player.lastSeen,
        }, ws);
        break;
      }

      // ── STATUS CHANGE ─────────────────────────────────────────
      case 'status': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode];
        if (!room) break;
        const player = room.players[playerId];
        if (!player) break;

        player.status = msg.status;
        broadcastAll(room, { type: 'status_update', playerId, status: msg.status });

        if (msg.status === 'medic') {
          const alert = { id: uuidv4(), from: player.callsign, text: `🚨 MEDIC NEEDED — ${player.callsign} is down and requires assistance!`, priority: 'high', ts: Date.now() };
          room.orders.push(alert);
          broadcastAll(room, { type: 'new_order', order: alert });
        }
        break;
      }

      // ── SEND ORDER / MESSAGE ──────────────────────────────────
      case 'order': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode];
        if (!room) break;
        const player = room.players[playerId];
        if (!player) break;

        const order = {
          id: uuidv4(),
          from: player.callsign,
          text: msg.text.slice(0, 200),
          priority: msg.priority || 'normal',
          ts: Date.now(),
        };
        room.orders.push(order);
        if (room.orders.length > 200) room.orders.shift();
        broadcastAll(room, { type: 'new_order', order });
        break;
      }

      // ── OBJECTIVE TOGGLE ──────────────────────────────────────
      case 'objective': {
        if (!playerId || !roomCode) break;
        const room = rooms[roomCode];
        if (!room) break;
        const obj = room.objectives.find(o => o.id === msg.id);
        if (obj) {
          obj.done = msg.done;
          broadcastAll(room, { type: 'objective_update', id: msg.id, done: msg.done });
        }
        break;
      }

      // ── PING (keepalive) ──────────────────────────────────────
      case 'ping': {
        sendTo(ws, { type: 'pong' });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!playerId || !roomCode) return;
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[playerId];
    if (player) {
      const leaveMsg = { id: uuidv4(), from: 'SYSTEM', text: `📴 ${player.callsign} has left the battlefield.`, priority: 'low', ts: Date.now() };
      room.orders.push(leaveMsg);
      delete room.players[playerId];
      broadcast(room, { type: 'player_left', playerId });
      broadcastAll(room, { type: 'new_order', order: leaveMsg });
      console.log(`[${roomCode}] ${player.callsign} disconnected`);
    }
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

// ── REST endpoints ─────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));

app.get('/rooms/:code', (req, res) => {
  const room = rooms[req.params.code.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ code: room.code, playerCount: Object.keys(room.players).length });
});

// Catch-all → serve index.html
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎯 Tactical server running on port ${PORT}`));
