const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.AUTH_SECRET || 'aethermon-secret-key-change-in-prod';
const DATA_FILE = path.join(__dirname, 'data', 'accounts.json');

if (!fs.existsSync(path.dirname(DATA_FILE))) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to read DB:', err);
  }
  return { accounts: {} };
}

function saveDB(db) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, s, 100000, 64, 'sha512').toString('hex');
  return { salt: s, hash };
}

function signToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).u;
  } catch {
    return null;
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/api/register', (req, res) => {
  const { username, password, saveState } = req.body || {};
  const cleanUser = String(username || '').trim().toLowerCase();
  if (cleanUser.length < 2 || String(password || '').length < 4) {
    return res.status(400).json({ error: '账号或密码长度不足' });
  }
  const db = loadDB();
  if (db.accounts[cleanUser]) {
    return res.status(409).json({ error: '该账号已被注册' });
  }
  const { salt, hash } = hashPassword(password);
  db.accounts[cleanUser] = {
    username: cleanUser,
    salt,
    hash,
    saveState: saveState || null,
    updatedAt: Date.now()
  };
  saveDB(db);
  res.json({ token: signToken(cleanUser), saveState: db.accounts[cleanUser].saveState });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const cleanUser = String(username || '').trim().toLowerCase();
  const db = loadDB();
  const rec = db.accounts[cleanUser];
  if (!rec) return res.status(404).json({ error: '账号不存在' });
  const check = hashPassword(String(password || ''), rec.salt);
  if (check.hash !== rec.hash) return res.status(401).json({ error: '密码错误' });
  res.json({ token: signToken(cleanUser), saveState: rec.saveState });
});

app.post('/api/save', (req, res) => {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  const user = verifyToken(auth);
  if (!user) return res.status(401).json({ error: '未授权访问' });
  const db = loadDB();
  if (!db.accounts[user]) return res.status(404).json({ error: '账号不存在' });
  db.accounts[user].saveState = req.body.saveState;
  db.accounts[user].updatedAt = Date.now();
  saveDB(db);
  res.json({ ok: true, updatedAt: db.accounts[user].updatedAt });
});

// Real-Time Socket.io Multiplayer Matchmaking & Room Relay
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = new Map();
const matchQueue = [];

io.on('connection', (socket) => {
  socket.on('room:create', ({ rule, nickname, team }) => {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    rooms.set(code, {
      code,
      rule: rule || 'flat50_3v3',
      hostSocket: socket.id,
      hostName: nickname,
      hostTeam: team,
      guestSocket: null,
      actions: {}
    });
    socket.join(code);
    socket.emit('room:created', { code, rule });
  });

  socket.on('room:join', ({ code, nickname, team }) => {
    const c = String(code || '').toUpperCase();
    const room = rooms.get(c);
    if (!room || room.guestSocket) {
      socket.emit('room:error', { message: '房间不存在或已满员' });
      return;
    }
    room.guestSocket = socket.id;
    room.guestName = nickname;
    room.guestTeam = team;
    socket.join(c);
    io.to(room.hostSocket).emit('battle:start', {
      code: c,
      isHost: true,
      rule: room.rule,
      peerName: nickname,
      peerTeam: team
    });
    io.to(room.guestSocket).emit('battle:start', {
      code: c,
      isHost: false,
      rule: room.rule,
      peerName: room.hostName,
      peerTeam: room.hostTeam
    });
  });

  socket.on('queue:join', ({ nickname, elo, team }) => {
    const idx = matchQueue.findIndex(p => p.socketId !== socket.id);
    if (idx >= 0) {
      const opp = matchQueue.splice(idx, 1)[0];
      const code = 'M_' + Math.random().toString(36).slice(2, 8).toUpperCase();
      rooms.set(code, {
        code,
        rule: 'flat50_3v3',
        hostSocket: opp.socketId,
        guestSocket: socket.id,
        actions: {}
      });
      socket.join(code);
      const oppSock = io.sockets.sockets.get(opp.socketId);
      if (oppSock) oppSock.join(code);
      io.to(opp.socketId).emit('battle:start', { code, isHost: true, rule: 'flat50_3v3', peerName: nickname, peerTeam: team });
      socket.emit('battle:start', { code, isHost: false, rule: 'flat50_3v3', peerName: opp.nickname, peerTeam: opp.team });
    } else {
      matchQueue.push({ socketId: socket.id, nickname, elo: elo || 1000, team });
      socket.emit('queue:waiting');
    }
  });

  socket.on('battle:action', ({ code, turn, action }) => {
    const room = rooms.get(code);
    if (!room) return;
    const role = socket.id === room.hostSocket ? 'host' : 'guest';
    room.actions[role] = action;
    if (room.actions.host && room.actions.guest) {
      const seed = Math.floor(Math.random() * 2147483647);
      io.to(code).emit('battle:commit', {
        turn,
        hostAction: room.actions.host,
        guestAction: room.actions.guest,
        seed
      });
      room.actions = {};
    }
  });

  socket.on('battle:switch', ({ code, target }) => {
    socket.to(code).emit('battle:peer_switch', { target });
  });

  socket.on('battle:emote', ({ code, text }) => {
    socket.to(code).emit('battle:emote', { text });
  });

  socket.on('disconnect', () => {
    const qIdx = matchQueue.findIndex(p => p.socketId === socket.id);
    if (qIdx >= 0) matchQueue.splice(qIdx, 1);
    for (const [code, room] of rooms.entries()) {
      if (room.hostSocket === socket.id || room.guestSocket === socket.id) {
        socket.to(code).emit('battle:peer_left');
        rooms.delete(code);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`AetherMon Arena Server running at http://localhost:${PORT}`);
});
