const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const sessions = {};
const sseClients = {};

// ── helpers ───────────────────────────────────────────────────────────────────
function uid(len=4){ return crypto.randomBytes(len).toString('hex').toUpperCase(); }

function broadcast(code, event, data){
  (sseClients[code]||[]).forEach(r=>{ try{ r.write(`event:${event}\ndata:${JSON.stringify(data)}\n\n`); }catch(e){} });
}

function haversine(lat1,lng1,lat2,lng2){
  const R=6371000, d2r=Math.PI/180;
  const dLat=(lat2-lat1)*d2r, dLng=(lng2-lng1)*d2r;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*d2r)*Math.cos(lat2*d2r)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function checkRespawns(session){
  let changed=false;
  session.players.forEach(p=>{
    if(!p.dead||!p.lat) return;
    session.zones.filter(z=>z.type===p.team).forEach(z=>{
      if(haversine(p.lat,p.lng,z.lat,z.lng)<=z.radius){
        p.dead=false;
        p.deaths++;
        const entry={ time:Date.now(), player:p.name, team:p.team, type:'respawn', note:`${p.name} reached ${z.label} — death counted` };
        session.hitLog.push(entry);
        if(p.team==='alpha') session.scores.bravo++; else session.scores.alpha++;
        broadcast(session.code,'respawn',{ playerId:p.id, player:p.name, team:p.team, log:entry });
        changed=true;
      }
    });
    // boundary check
    session.zones.filter(z=>z.type==='boundary').forEach(z=>{
      const outside=haversine(p.lat,p.lng,z.lat,z.lng)>z.radius;
      if(outside&&!p.outOfBounds){ p.outOfBounds=true; broadcast(session.code,'boundary',{ playerId:p.id, player:p.name }); }
      else if(!outside){ p.outOfBounds=false; }
    });
  });
  if(changed) broadcast(session.code,'state',buildState(session));
}

function buildState(session){
  return {
    code:session.code, running:session.running, gameSeconds:session.gameSeconds,
    gameDuration:session.gameDuration, mode:session.mode, scores:session.scores,
    zones:session.zones.map(z=>({id:z.id,type:z.type,lat:z.lat,lng:z.lng,radius:z.radius,label:z.label,polygon:z.polygon||null})),
    players:session.players.map(p=>({
      id:p.id,name:p.name,team:p.team,dead:p.dead,deaths:p.deaths,
      lat:p.lat,lng:p.lng,outOfBounds:p.outOfBounds,lastSeen:p.lastSeen,
      type:p.type||'player', airtag:p.airtag||null
    })),
    hitLog:session.hitLog.slice(-100),
    roundNum:session.roundNum,
  };
}

// ── static files ──────────────────────────────────────────────────────────────
const MIME={ html:'text/html', js:'text/javascript', css:'text/css', json:'application/json', ico:'image/x-icon' };
function serveFile(res,filePath){
  const ext=path.extname(filePath).slice(1);
  fs.readFile(filePath,(err,data)=>{
    if(err){ res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200,{ 'Content-Type':MIME[ext]||'text/plain','Cache-Control':'no-cache' });
    res.end(data);
  });
}
function json(res,data,status=200){
  res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
  res.end(JSON.stringify(data));
}
function parseBody(req){ return new Promise(ok=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ try{ok(JSON.parse(b));}catch(e){ok({});} }); }); }

// ── server ────────────────────────────────────────────────────────────────────
const server=http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if(req.method==='OPTIONS'){ res.writeHead(204); res.end(); return; }

  const url=new URL(req.url,`http://localhost:${PORT}`);
  const p=url.pathname;

  // Static
  if(p==='/'||p==='/admin'||p==='/admin/') return serveFile(res,path.join(__dirname,'admin/index.html'));
  if(p==='/player'||p==='/player/') return serveFile(res,path.join(__dirname,'player/index.html'));
  if(p.match(/\.(js|css|html|ico)$/)&&!p.includes('..')) return serveFile(res,path.join(__dirname,p.slice(1)));

  // SSE
  if(p==='/events'){
    const code=url.searchParams.get('code');
    if(!code||!sessions[code]){ json(res,{error:'invalid'},404); return; }
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
    res.write(`event:state\ndata:${JSON.stringify(buildState(sessions[code]))}\n\n`);
    if(!sseClients[code]) sseClients[code]=[];
    sseClients[code].push(res);
    req.on('close',()=>{ sseClients[code]=(sseClients[code]||[]).filter(r=>r!==res); });
    return;
  }

  // API
  if(p==='/api/create'&&req.method==='POST'){
    const code=uid(3);
    sessions[code]={
      code, running:false, gameSeconds:0, gameDuration:0,
      mode:'Team Deathmatch', scores:{alpha:0,bravo:0}, roundNum:1,
      players:[], zones:[], hitLog:[], zoneIdCounter:0, timerRef:null,
    };
    json(res,{code});
    return;
  }

  if(p==='/api/join'&&req.method==='POST'){
    const b=await parseBody(req);
    const s=sessions[b.code];
    if(!s){ json(res,{error:'Game not found'},404); return; }
    const existing=s.players.find(x=>x.id===b.playerId);
    if(existing){ json(res,{player:existing,state:buildState(s)}); return; }
    const player={ id:uid(), name:b.name, team:b.team, dead:false, deaths:0,
      lat:null, lng:null, outOfBounds:false, lastSeen:null, type:'player' };
    s.players.push(player);
    broadcast(s.code,'state',buildState(s));
    json(res,{player,state:buildState(s)});
    return;
  }

  if(p==='/api/addairtag'&&req.method==='POST'){
    const b=await parseBody(req);
    const s=sessions[b.code];
    if(!s){ json(res,{error:'no session'},404); return; }
    const player={ id:uid(), name:b.name, team:b.team, dead:false, deaths:0,
      lat:b.lat||null, lng:b.lng||null, outOfBounds:false, lastSeen:null,
      type:'airtag', airtag:{ brand:b.brand||'apple', note:b.note||'' } };
    s.players.push(player);
    broadcast(s.code,'state',buildState(s));
    json(res,{player,state:buildState(s)});
    return;
  }

  if(p==='/api/updateairtag'&&req.method==='POST'){
    const b=await parseBody(req);
    const s=sessions[b.code];
    if(!s){ json(res,{error:'no session'},404); return; }
    const player=s.players.find(x=>x.id===b.playerId);
    if(!player){ json(res,{error:'not found'},404); return; }
    player.lat=b.lat; player.lng=b.lng; player.lastSeen=Date.now();
    checkRespawns(s);
    broadcast(s.code,'location',{id:player.id,lat:b.lat,lng:b.lng,dead:player.dead});
    json(res,{ok:true});
    return;
  }

  if(p==='/api/location'&&req.method==='POST'){
    const b=await parseBody(req);
    const s=sessions[b.code];
    if(!s){ json(res,{error:'no session'},404); return; }
    const player=s.players.find(x=>x.id===b.playerId);
    if(!player){ json(res,{error:'not found'},404); return; }
    player.lat=b.lat; player.lng=b.lng; player.lastSeen=Date.now();
    checkRespawns(s);
    broadcast(s.code,'location',{id:player.id,lat:b.lat,lng:b.lng,dead:player.dead,outOfBounds:player.outOfBounds});
    json(res,{ok:true});
    return;
  }

  if(p==='/api/markdead'&&req.method==='POST'){
    const b=await parseBody(req);
    const s=sessions[b.code];
    if(!s){ json(res,{error:'no session'},404); return; }
    const player=s.players.find(x=>x.id===b.playerId);
    if(!player){ json(res,{error:'not found'},404); return; }
    player.dead=true;
    const entry={ time:Date.now(), player:player.name, team:player.team, type:'death', note:`${player.name} marked dead by admin` };
    s.hitLog.push(entry);
    broadcast(s.code,'state',buildState(s));
    json(res,{ok:true});
    return;
  }

  if(p==='/api/adddeath'&&req.method==='POST'){
    // Admin manually counts a death without marking dead
    const b=await parseBody(req);
    const s=sessions[b.code];
    if(!s){ json(res,{error:'no session'},404); return; }
    const player=s.players.find(x=>x.id===b.playerId);
    if(!player){ json(res,{error:'not found'},404); return; }
    player.deaths++;
    if(player.team==='alpha') s.scores.bravo++; else s.scores.alpha++;
    const entry={ time:Date.now(), player:player.name, team:player.team, type:'death', note:`${player.name} — death added by admin` };
    s.hitLog.push(entry);
    broadcast(s.code,'state',buildState(s));
    json(res,{ok:true});
    return;
  }

  if(p==='/api/forcerespawn'&&req.method==='POST'){
    const b=await parseBody(req);
    const s=sessions[b.code];
    if(!s){ json(res,{error:'no session'},404); return; }
    const player=s.players.find(x=>x.id===b.playerId);
    if(player){ player.dead=false; player.outOfBounds=false; broadcast(s.code,'state',buildState(s)); }
    json(res,{ok:true});
    return;
  }

  if(p==='/api/editplayer'&&req.method==='POST'){
    const b=await parseBody(req);
    const s=sessions[b.code];
    if(!s){ json(res,{error:'no session'},404); return; }
    const player=s.players.find(x=>x.id===b.playerId);
    if(!player){ json(res,{error:'not found'},404); return; }
    if(b.name) player.name=b.name.trim();
    if(b.team) player.team=b.team;
    broadcast(s.code,'state',buildState(s));
    json(res,{ok:true,player});
    return;
  }

  if(p==='/api/removeplayer'&&req.method==='POST'){
    const b=await parseBody(req);
    const s=sessions[b.code];
    if(!s){ json(res,{error:'no session'},404); return; }
    s.players=s.players.filter(x=>x.id!==b.playerId);
    broadcast(s.code,'state',buildState(s));
    json(res,{ok:true});
    return;
  }

  if(p==='/api/zone'&&req.method==='POST'){
    const b=await parseBody(req);
    const s=sessions[b.code];
    if(!s){ json(res,{error:'no session'},404); return; }
    const labels={alpha:'Alpha Respawn',bravo:'Bravo Respawn',boundary:'Boundary'};
    const zone={ id:++s.zoneIdCounter, type:b.type, lat:b.lat, lng:b.lng,
      radius:b.radius||(b.type==='boundary'?150:40), label:labels[b.type]||b.type,
      polygon:b.polygon||null };
    s.zones.push(zone);
    broadcast(s.code,'state',buildState(s));
    json(res,{ok:true,zone});
    return;
  }

  if(p==='/api/removezone'&&req.method==='POST'){
    const b=await parseBody(req);
    const s=sessions[b.code];
    if(!s){ json(res,{error:'no session'},404); return; }
    s.zones=s.zones.filter(z=>z.id!==b.zoneId);
    broadcast(s.code,'state',buildState(s));
    json(res,{ok:true});
    return;
  }

  if(p==='/api/control'&&req.method==='POST'){
    const b=await parseBody(req);
    const s=sessions[b.code];
    if(!s){ json(res,{error:'no session'},404); return; }
    if(b.action==='start'&&!s.running){
      s.running=true;
      s.timerRef=setInterval(()=>{
        s.gameSeconds++;
        broadcast(s.code,'timer',{seconds:s.gameSeconds,duration:s.gameDuration});
        // Auto-stop when duration reached
        if(s.gameDuration>0&&s.gameSeconds>=s.gameDuration){
          s.running=false; clearInterval(s.timerRef);
          broadcast(s.code,'gameover',{scores:s.scores});
          broadcast(s.code,'state',buildState(s));
        }
      },1000);
    } else if(b.action==='stop'&&s.running){
      s.running=false; clearInterval(s.timerRef);
    } else if(b.action==='reset'){
      s.running=false; clearInterval(s.timerRef);
      s.gameSeconds=0; s.scores={alpha:0,bravo:0}; s.roundNum=1; s.hitLog=[];
      s.players.forEach(p=>{ p.dead=false; p.deaths=0; p.outOfBounds=false; });
    } else if(b.action==='nextround'){
      s.roundNum++; s.gameSeconds=0;
      s.players.forEach(p=>{ p.dead=false; p.outOfBounds=false; });
    } else if(b.action==='setmode'){
      s.mode=b.mode;
    } else if(b.action==='setduration'){
      s.gameDuration=b.seconds||0;
    }
    broadcast(s.code,'state',buildState(s));
    json(res,{ok:true});
    return;
  }

  if(p==='/api/alert'&&req.method==='POST'){
    const b=await parseBody(req);
    const s=sessions[b.code];
    if(!s){ json(res,{error:'no session'},404); return; }
    broadcast(s.code,'alert',{message:b.message,time:Date.now()});
    json(res,{ok:true});
    return;
  }

  if(p==='/api/state'){
    const code=url.searchParams.get('code');
    const s=sessions[code];
    if(!s){ json(res,{error:'not found'},404); return; }
    json(res,buildState(s));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT,'0.0.0.0',()=>{
  console.log(`\n🎯 OpZone running → http://localhost:${PORT}`);
  console.log(`   Admin  → http://localhost:${PORT}/admin`);
  console.log(`   Player → http://localhost:${PORT}/player\n`);
});
