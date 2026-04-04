# 🎯 TACTICAL — Airsoft GPS Tracker

Real-time multiplayer airsoft/paintball/MilSim tactical tracker with live GPS.

## Features

- 📡 **Live GPS tracking** — real device location via browser Geolocation API
- 🗺️ **Interactive map** — Leaflet.js with OpenStreetMap tiles (dark military style)
- 👥 **Real-time squad** — WebSocket-powered live player positions & statuses
- 📻 **Comms / Orders** — send sitreps and orders with priority levels
- ⚡ **Perks** — UAV, EMP, Hack, Smoke, Medkit, Air Support with cooldowns
- 🔫 **Loadout** — replica management
- 🏠 **Game rooms** — join any room with a code, multiple games simultaneously
- 📱 **Mobile-first** — PWA-ready, works on phones on the field

## Deploy to Railway

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/tactical-airsoft
git push -u origin main
```

### 2. Deploy on Railway
1. Go to [railway.app](https://railway.app) → **New Project**
2. Select **Deploy from GitHub repo**
3. Pick your repo → Railway auto-detects Node.js
4. Click **Deploy** — done!

### 3. Get your URL
Railway gives you a URL like `https://tactical-airsoft-production.up.railway.app`

> ⚠️ **HTTPS is required for GPS on mobile browsers.** Railway provides HTTPS automatically.

## Local Development

```bash
npm install
npm run dev
# Open http://localhost:3000
```

## How to Use

1. Share your Railway URL with your team
2. Everyone opens the URL on their phone
3. Enter callsign, team, role, and the **same room code**
4. Hit **DEPLOY** — GPS starts, you appear on each other's maps live!

## Architecture

```
Browser (GPS + WebSocket)
        │
        ▼
Express + WebSocket Server (Node.js)
        │
        ├── In-memory room state (players, orders, objectives)
        └── Broadcasts location updates to all room members
```

No database required — everything is in-memory per session.
For persistent data (stats, loadouts), add a PostgreSQL Railway plugin.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | 3000    | Server port (Railway sets this automatically) |

## Room Codes

- Rooms are created automatically when the first player joins
- Share the same code with your whole team
- Codes are case-insensitive
- Empty rooms are cleaned up after 10 minutes of inactivity
