# Zulu's Game Tracker 🎯
**Real-Time Airsoft Tactical Intelligence**  
*Built by Chris Zulu · Swindon Airsoft*

---

## Quick Start

```bash
npm install
npm start
# Open http://localhost:3000
```

**Default Super Admin:** `chriszulu` / `SwindonA1rsoft!`  
*Change via `ADMIN_USER` and `ADMIN_PASS` environment variables.*

---

## Railway Deployment (Persistent Data)

> **⚠️ Critical:** Railway's filesystem resets on every deploy. Without a volume, all maps and accounts are lost on update.

### Setup steps:
1. Deploy to Railway as normal
2. In Railway dashboard → your service → **Settings** → **Add Volume**
3. Set mount path: `/app/data`
4. Add environment variable: `DATA_DIR=/app/data`
5. Redeploy — data now survives all future updates

### Before updating without a volume:
Use **Admin Panel → Data Backup → Export Full Backup** to download all data, then re-import after deploying.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `ADMIN_USER` | `chriszulu` | Super admin username |
| `ADMIN_PASS` | `SwindonA1rsoft!` | Super admin password |
| `DATA_DIR` | `./data` | Path for persistent storage |

---

## Player Guide

### Getting Started
1. Open the app on your phone browser
2. **Register** an account (recommended) or join as a Guest
3. Select your map from the home screen
4. Choose your callsign, role, and team
5. Tap **DEPLOY TO BATTLEFIELD**
6. Grant GPS permission when prompted — this is required for tracking

### Staying Tracked When Screen Locks
The app uses multiple strategies to keep your position updating:
- **Keep screen on** — the app requests a wake lock to prevent screen lock
- **Background heartbeat** — sends position every 8 seconds even when backgrounded  
- **Service Worker** — caches your last position so it's sent immediately when you unlock
- **On iOS:** Use "Add to Home Screen" (Safari → Share → Add to Home Screen) for best background performance
- **On Android:** Allow "Background App Refresh" for your browser in settings

---

## Tactical Perks — Full Guide

All perks except **Hack** are **team-wide cooldowns** — once used, no one on your team can use that perk until it resets.

### 📡 UAV Scan
**What it does:** Launches a drone that scans a 30-metre radius around you. All enemies within range have their exact positions revealed to your team for 20 seconds.

**Team cooldown:** 60 seconds  
**Tip:** Use when you suspect enemies are nearby. The sweep only covers 30m so get close before activating.  
**Enemy warning:** The other team receives an alert that a UAV is active — they'll know to move.

---

### ⚡ EMP Blast  
**What it does:** Fires an electromagnetic pulse that scrambles the GPS display of all enemies within 100 metres. Their positions appear in random incorrect locations on your team's map for 30 seconds.

**Team cooldown:** 4 minutes 30 seconds  
**Tip:** Use in CQB or when pushing an objective — the enemy won't know you're coming.  
**Range:** 100 metres radius from your position.

---

### 💨 Smoke Screen  
**What it does:** Deploys a smoke cloud at your position. Visible on everyone's map as a grey zone for 30 seconds.

**Team cooldown:** 3 minutes  
**Tip:** Use to cover a push, an extraction, or to confuse enemy positions.  
**Note:** The smoke zone appears on both teams' maps — it's a visual indicator, not actual concealment.

---

### 💻 Intel Hack *(Personal Cooldown)*  
**What it does:** Hacks into enemy comms and reveals one random enemy's exact position — **only to you** — for 10 seconds.

**Personal cooldown:** 2 minutes 30 seconds *(each player has their own timer)*  
**Tip:** Use when you need to locate a specific threat before pushing.  
**Target notice:** The hacked player receives a warning that they've been compromised.

---

### 🩹 Medkit  
**What it does:** Revives all downed teammates within 10 metres of your position instantly.

**Team cooldown:** 2 minutes  
**Tip:** Stand next to your downed teammate before using — range is tight at 10m.  
**Note:** You must be within 10 metres. Check the map to find your downed teammate's position.

---

### 🚁 Air Support  
**What it does:** Calls in an air strike on your location. Creates a 10-metre hazard zone and broadcasts a warning to all players to clear the area. Zone lasts 60 seconds.

**Team cooldown:** 4 minutes  
**Tip:** Best used on objectives or known enemy positions — it signals your intent so use tactically.  
**Warning:** Broadcasts to ALL players, including enemies.

---

## Bleed-Out System

When you tap **"🚨 I AM DOWN — MEDIC NEEDED"**:

1. A **2-minute countdown** starts on your screen
2. Your marker on everyone's map shows a **flashing 🆘 SOS indicator**
3. An alert is broadcast to your team
4. Your status panel shows the bleed-out timer

**How to survive:**
- A **Medic role player** within 5 metres will automatically revive you (scanner runs every 3 seconds)
- A teammate uses the **Medkit perk** within 10 metres
- You reach a **Respawn Zone** for your team colour before the timer expires

**If the timer reaches zero:**  
You auto-respawn. The game sends you back to your team's respawn zone.

---

## Status Buttons

| Button | Effect |
|---|---|
| **🚨 I AM DOWN — MEDIC NEEDED** | Starts bleed-out countdown. Alerts team. |
| **◈ NEED SUPPORT** | Broadcasts support request. Auto-clears after 60 seconds. |

> **Alive status is automatic** — you cannot set yourself alive. It happens when a medic reaches you, medkit is used, or bleed-out timer expires.

---

## Roles

| Role | Icon | Description |
|---|---|---|
| **Assault** | ⚔ | General infantry. Standard play. |
| **Sniper** | 🎯 | Long-range support. Slower movement expected. |
| **Support** | 🛡 | Heavy weapon / suppression. |
| **Medic** | ✚ | Can auto-revive downed teammates within 5m. |
| **Scout** | 👁 | Recon. Fast movement. |
| **Commander** | ⭐ | Team leader. Coordinates objectives. |

> **Note:** Admins can restrict which roles are available per map. You'll only see allowed roles when selecting.

---

## Admin Perks (Admin Panel Only)

These are deployed by the game admin from the Admin Panel → Admin Perks section.

| Perk | Effect |
|---|---|
| **👁 God's Eye** | Shows all players from both teams on the admin live map. Players are unaware. |
| **📦 Intel Drop** | Reveals all enemy positions to one specific team for 30 seconds. |
| **⚫ Blackout** | Disables all GPS maps for every player for 20 seconds. Total chaos. |
| **🔴 Flare Drop** | Admin places a visible flare marker on the map. Visible to all players for 2 minutes. |
| **🕊 Ceasefire** | Shows a ceasefire overlay on all player screens until admin clicks Continue. |
| **💀 Mass Eliminate** | Sets an entire team's status to Dead. Used for out-of-bounds rulings. |

---

## Map Zones

| Zone | Colour | Meaning |
|---|---|---|
| 🟥 Red Respawn | Red | Red team respawn area |
| 🟦 Blue Respawn | Blue | Blue team respawn area |
| 🟡 Objective | Orange | Capture / hold point |
| 🔴 Hazard | Bright red | Danger area — avoid |
| 🟢 Safe Zone | Green | No engagement area |
| 🟡 Boundary | Yellow | Game boundary — out of bounds beyond this |

---

## Frequently Asked Questions

**Q: My position isn't updating on the map**  
A: Check GPS is enabled in your browser settings. Tap the GPS indicator (bottom-right of map) to see accuracy. Move outside if accuracy is poor. Make sure you granted location permission.

**Q: GPS stops working when I lock my screen**  
A: This is an iOS/Android browser limitation. Solutions: (1) Keep screen on — the app requests wake lock automatically. (2) Add to Home Screen on iOS for better background access. (3) Turn your screen brightness down instead of locking it.

**Q: I can't use a perk — the button is greyed out**  
A: Either you're bleeding out (perks are disabled), or your team's cooldown for that perk is active. Wait for the timer to count down. Hack has a personal timer; all other perks are shared with your team.

**Q: The Medic Needed button is disabled**  
A: You're already bleeding out. Wait for a medic or the auto-respawn timer.

**Q: I can't see my teammates on the map**  
A: They may not have GPS signal yet. Check the Squad tab — it shows status for your full team. Enemy positions are always hidden unless UAV is active.

**Q: The zone editor map won't load**  
A: Click away from Zone Editor and back again. The map initialises when the view becomes visible. Make sure you have a map selected in the dropdown.

**Q: My account data was wiped after an update**  
A: The server needs a Railway Volume for data to persist. See the Data Backup section in the Admin Panel for setup instructions, or use Export/Import to manually back up before deploying.

**Q: Can I use this without internet?**  
A: No — the app requires a live server connection. The Service Worker caches the app itself, but GPS tracking and game state require an active WebSocket connection to the server.

**Q: How accurate is the GPS?**  
A: Typically 3–10 metres outdoors with a clear sky. Accuracy degrades under tree cover and inside buildings. The accuracy figure is shown on the map screen (bottom right) and on the Status tab.

---

## Architecture

- **Server:** Node.js + Express + `ws` WebSocket server
- **Client:** Vanilla JS + Leaflet.js (no framework)
- **GPS:** `navigator.geolocation.watchPosition` with wake lock
- **Background:** Service Worker + 8s heartbeat interval
- **Storage:** JSON files in `/data/` directory
- **Deployment:** Railway.app (add volume for persistence)

---

*Zulu's Game Tracker — Built by Chris Zulu for Swindon Airsoft*
