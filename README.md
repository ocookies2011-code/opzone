# OpZone v2 — Airsoft Game Day Manager

Real-time airsoft management: live GPS, respawn zones, AirTag support, deaths tracking, QR joining.

---

## Run locally (on your laptop at the airsoft site)

**Requirements:** Node.js — download free at https://nodejs.org

```bash
node server.js
```

Then open:
- Admin → http://localhost:3000/admin
- Players connect via your local IP → http://192.168.X.X:3000/player

**Find your local IP:**
- Windows: open CMD → `ipconfig` → look for IPv4 Address
- Mac: System Settings → Wi-Fi → Details → IP Address

Players on the same WiFi or phone hotspot can join using that IP.

---

## Deploy to the internet (Railway — free)

This lets players join from anywhere, not just local WiFi.

### Step 1 — Put code on GitHub

1. Go to https://github.com and create a free account
2. Click **New repository** → name it `opzone` → click **Create**
3. On your computer, open a terminal in the opzone2 folder and run:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/opzone.git
git push -u origin main
```

### Step 2 — Deploy on Railway

1. Go to https://railway.app → sign up with your GitHub account
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `opzone` repository
4. Railway auto-detects Node.js and runs `node server.js`
5. Click **Settings** → **Networking** → **Generate Domain**
6. You'll get a URL like `https://opzone-production.up.railway.app`

That's your permanent public URL — share it with players!

### Step 3 — Share with players

Admin URL: `https://your-app.up.railway.app/admin`
Player URL: `https://your-app.up.railway.app/player`

The QR code in the Admin → Join tab will automatically use the correct URL.

---

## Features

| Feature | Details |
|---|---|
| **Live GPS** | Real phone GPS, updates every few seconds |
| **QR code joining** | Scan to join — code auto-fills |
| **Draw respawn zones** | Click on map to place Alpha/Bravo/Boundary zones |
| **Deaths (not kills)** | Deaths counted when player reaches respawn zone OR admin adds manually |
| **AirTag / tracker support** | Add tracker players, update location manually from Find My |
| **Edit players** | Admin can change name and team at any time |
| **Game timer** | Set a fixed duration — game auto-ends when time runs out |
| **Boundary alerts** | Red flash + warning if player leaves game area |
| **Broadcast alerts** | Send messages to all players instantly |
| **Hit log** | Full timestamped log of every death and respawn |
| **Satellite map** | Toggle street / satellite view |
| **Game over screen** | Shows on player phones when timer ends |

---

## AirTag Notes

Apple AirTags and Google Find My devices don't broadcast GPS to the internet directly — they work through their respective apps. To use them with OpZone:

1. Add the player as a tracker in Admin → Players → Add tracker
2. Open Apple Find My / Google Find My Device on your admin phone
3. Find the tracker's location shown on the map
4. Go back to OpZone Admin → Players → tap "Update GPS" next to that player
5. Enter the coordinates shown in Find My
6. Repeat periodically throughout the game

**Tip:** The coordinates shown in Find My app are usually in the format `lat, lng` — just copy them in.

---

## How deaths are counted

Deaths are ONLY counted in two ways:
1. An eliminated player physically walks to their team's respawn zone on the map (automatic)
2. Admin manually taps "+1 death" on the Players tab

The **"Mark dead"** button just marks the player as currently dead — it does NOT count a death until they reach the respawn zone.
