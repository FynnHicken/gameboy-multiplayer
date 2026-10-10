import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DIST_DIR = path.join(__dirname, 'dist');
const ROMS_DIR = path.join(__dirname, 'roms');

if (!fs.existsSync(ROMS_DIR)) {
  fs.mkdirSync(ROMS_DIR, { recursive: true });
}

// Alphanumeric alphabet: lowercase only, no 'o' (to avoid confusion with zero / 0)
// 25 lowercase letters + 10 digits = 35 chars
const CODE_ALPHABET = 'abcdefghijklmnpqrstuvwxyz0123456789';

function generateRoomCode(length = 4) {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
  }
  return result;
}

function normalizeRoomCode(raw) {
  return (raw || '').trim().toLowerCase().replace(/o/g, '0');
}

// Legacy game rooms map: roomCodeLower -> { id, host, guest, createdAt }
const gameRooms = new Map();

// Direct Auto-Link-Cable rooms map: roomCodeLower -> { id, clients: Map<ws, { playerId, joinedAt }>, createdAt }
const directLinkRooms = new Map();

// Active Party-Hub & Chat rooms map:
// roomCodeLower -> { code, clients: Set<ws>, players: Map<playerId, playerObj>, socketToPlayerId: Map<ws, playerId>, hostId, selectedRom, history: Array<msg> }
const chatRooms = new Map();

// MIME Types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gb': 'application/octet-stream',
  '.gbc': 'application/octet-stream',
  '.sav': 'application/octet-stream',
};

// HTTP Server
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname;
  try { pathname = decodeURIComponent(parsedUrl.pathname); } catch (e) { pathname = parsedUrl.pathname; }

  // Healthcheck endpoint
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      partyRooms: chatRooms.size,
      linkRooms: directLinkRooms.size + gameRooms.size,
      uptime: process.uptime()
    }));
    return;
  }

  // API: List ROMs
  if (pathname === '/api/roms' && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      const files = fs.readdirSync(ROMS_DIR).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return ext === '.gb' || ext === '.gbc';
      });
      const data = JSON.stringify(files);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Cache-Control': 'no-cache'
      });
      if (req.method === 'GET') res.end(data);
      else res.end();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: Download/Fetch ROM or Save
  if (pathname.startsWith('/api/roms/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const filename = path.basename(pathname);
    const filepath = path.join(ROMS_DIR, filename);
    if (fs.existsSync(filepath)) {
      const stat = fs.statSync(filepath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      if (req.method === 'GET') {
        fs.createReadStream(filepath).pipe(res);
      } else {
        res.end();
      }
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('ROM not found');
      return;
    }
  }

  // Static files in dist/
  let filePath = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);
  filePath = path.normalize(filePath);

  // Security check: ensure path is within DIST_DIR
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // Check if file exists, else fallback to index.html for SPA
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  const headers = { 'Content-Type': contentType };
  if (pathname.startsWith('/assets/') && !parsedUrl.searchParams.has('v')) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['Cache-Control'] = 'no-cache';
  }

  const stat = fs.statSync(filePath);
  headers['Content-Length'] = stat.size;

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
  } else {
    fs.createReadStream(filePath).pipe(res);
  }
});

// WebSocket Server for Game Boy Serial Link Cable (/ws)
const wssGame = new WebSocketServer({ noServer: true });

// WebSocket Server for Party-Hub & Live Chat (/chat)
const wssChat = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (parsedUrl.pathname === '/ws') {
    wssGame.handleUpgrade(request, socket, head, (ws) => {
      wssGame.emit('connection', ws, request);
    });
  } else if (parsedUrl.pathname === '/chat' || parsedUrl.pathname === '/party-ws') {
    wssChat.handleUpgrade(request, socket, head, (ws) => {
      wssChat.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Helper: Sync Direct Link-Cable Room status
function syncDirectLinkRoom(roomKey) {
  const room = directLinkRooms.get(roomKey);
  if (!room) return;

  // Clean up closed sockets
  for (const [clientWs] of room.clients.entries()) {
    if (clientWs.readyState !== WebSocket.OPEN) {
      room.clients.delete(clientWs);
    }
  }

  if (room.clients.size === 0) {
    directLinkRooms.delete(roomKey);
    updatePartyLinkState(roomKey, false, 0);
    return;
  }

  const activeSockets = Array.from(room.clients.keys());
  const isPaired = activeSockets.length >= 2;

  activeSockets.forEach((clientWs, idx) => {
    try {
      clientWs.send(JSON.stringify({
        type: isPaired ? 'LINK_PAIRED' : 'LINK_WAITING',
        room: roomKey,
        role: idx === 0 ? 'host' : 'guest',
        peers: activeSockets.length
      }));
    } catch (e) {}
  });

  updatePartyLinkState(roomKey, isPaired, activeSockets.length);
}

function updatePartyLinkState(roomKey, isPaired, connectedCount) {
  const chatRoom = chatRooms.get(roomKey);
  if (!chatRoom) return;
  chatRoom.linkPaired = isPaired;
  chatRoom.linkCount = connectedCount;
  broadcastRoster(roomKey);
}

// --- Game Boy Netplay Handlers (/ws) ---
wssGame.on('connection', (ws, request) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const roomParam = parsedUrl.searchParams.get('room');
  const isDirect = parsedUrl.searchParams.get('direct') === '1';
  const playerId = parsedUrl.searchParams.get('playerId') || ('anon_' + Math.random().toString(36).slice(2, 7));

  // --- NEW: Treffen-style Persistent Auto-Link-Cable Mode (direct=1) ---
  if (isDirect && roomParam) {
    const roomKey = normalizeRoomCode(roomParam);
    let room = directLinkRooms.get(roomKey);
    if (!room) {
      room = {
        id: roomKey,
        clients: new Map(),
        createdAt: Date.now()
      };
      directLinkRooms.set(roomKey, room);
    }

    // If same playerId is reconnecting, remove old socket first
    for (const [oldWs, meta] of room.clients.entries()) {
      if (meta.playerId === playerId || oldWs.readyState !== WebSocket.OPEN) {
        room.clients.delete(oldWs);
        try { oldWs.close(1000, 'Replaced by new session'); } catch (e) {}
      }
    }

    // If room already has 2 other active players, reject 3rd link cable client
    if (room.clients.size >= 2) {
      ws.send(JSON.stringify({ type: 'LINK_FULL', room: roomKey }));
      ws.close(4003, 'Link cable already has 2 players');
      return;
    }

    room.clients.set(ws, { playerId, joinedAt: Date.now() });
    console.log(`[Direct Link-Cable] Player "${playerId}" connected in room "${roomKey}" (${room.clients.size}/2)`);

    syncDirectLinkRoom(roomKey);

    ws.on('message', (message, isBinary) => {
      if (isBinary) {
        // Relay binary serial bytes to the peer in the room
        for (const [peerWs] of room.clients.entries()) {
          if (peerWs !== ws && peerWs.readyState === WebSocket.OPEN) {
            peerWs.send(message, { binary: true });
          }
        }
      } else {
        try {
          const data = JSON.parse(message.toString());
          if (data.type === 'PING' && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'PONG' }));
          }
        } catch (e) {}
      }
    });

    ws.on('close', () => {
      room.clients.delete(ws);
      console.log(`[Direct Link-Cable] Player "${playerId}" disconnected from room "${roomKey}"`);
      syncDirectLinkRoom(roomKey);
    });

    ws.on('error', () => {
      room.clients.delete(ws);
      syncDirectLinkRoom(roomKey);
    });

    return;
  }

  // --- LEGACY gebeh UI WebSocket Mode ---
  if (!roomParam) {
    // HOST: Creating a new room
    let roomId = generateRoomCode(4);
    while (gameRooms.has(roomId)) {
      roomId = generateRoomCode(4);
    }

    const roomKey = roomId;
    const room = {
      id: roomId,
      host: ws,
      guest: null,
      createdAt: Date.now()
    };
    gameRooms.set(roomKey, room);
    console.log(`[Game Room Created] Host created code: "${roomId}" (active: ${gameRooms.size})`);

    ws.send(roomId);

    ws.on('message', (message, isBinary) => {
      if (room.guest && room.guest.readyState === WebSocket.OPEN) {
        room.guest.send(message, { binary: isBinary });
      }
    });

    ws.on('close', () => {
      console.log(`[Host Left] Game room closed: "${roomId}"`);
      if (room.guest && room.guest.readyState === WebSocket.OPEN) {
        room.guest.close(1000, 'Host disconnected');
      }
      gameRooms.delete(roomKey);
    });

    ws.on('error', (err) => {
      console.error(`[Host Error ${roomId}]:`, err.message);
    });

  } else {
    // GUEST: Joining an existing room
    let roomKey = normalizeRoomCode(roomParam);
    let room = gameRooms.get(roomKey);

    if (!room) {
      console.warn(`[Join Failed] Room not found: "${roomParam}"`);
      ws.close(4004, 'Room not found');
      return;
    }

    if (room.guest) {
      console.warn(`[Join Failed] Room is full: "${roomParam}"`);
      ws.close(4003, 'Room is full');
      return;
    }

    room.guest = ws;
    console.log(`[Player Joined] Guest joined room: "${room.id}"! Pairing established.`);

    // Send empty binary frame to signal that guest is connected
    try {
      room.host.send(Buffer.alloc(0), { binary: true });
    } catch (e) {
      console.error(`[Error notifying host]:`, e);
    }

    ws.on('message', (message, isBinary) => {
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.send(message, { binary: isBinary });
      }
    });

    ws.on('close', () => {
      console.log(`[Guest Left] Guest left room: "${room.id}"`);
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.close(1000, 'Guest disconnected');
      }
      gameRooms.delete(roomKey);
    });

    ws.on('error', (err) => {
      console.error(`[Guest Error ${room.id}]:`, err.message);
    });
  }
});

// --- Party-Hub & Live Chat Handlers (/chat) ---
function getOrCreateChatRoom(roomKey) {
  let chatRoom = chatRooms.get(roomKey);
  if (!chatRoom) {
    chatRoom = {
      code: roomKey,
      clients: new Set(),
      players: new Map(),
      socketToPlayerId: new Map(),
      hostId: null,
      selectedRom: null,
      linkPaired: false,
      linkCount: 0,
      history: []
    };
    chatRooms.set(roomKey, chatRoom);
  }
  return chatRoom;
}

function ensureRoomHost(chatRoom) {
  if (chatRoom.hostId && chatRoom.players.has(chatRoom.hostId)) {
    return chatRoom.hostId;
  }
  const sorted = Array.from(chatRoom.players.values()).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  chatRoom.hostId = sorted.length > 0 ? sorted[0].id : null;
  return chatRoom.hostId;
}

function broadcastRoster(roomKey) {
  const chatRoom = chatRooms.get(roomKey);
  if (!chatRoom) return;

  ensureRoomHost(chatRoom);
  const playerList = Array.from(chatRoom.players.values()).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  playerList.forEach(p => {
    p.isHost = (p.id === chatRoom.hostId);
  });

  broadcastChat(roomKey, {
    type: 'ROSTER_SYNC',
    room: roomKey,
    hostId: chatRoom.hostId,
    selectedRom: chatRoom.selectedRom,
    linkPaired: !!chatRoom.linkPaired,
    linkCount: chatRoom.linkCount || 0,
    players: playerList
  });
}

wssChat.on('connection', (ws, request) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const roomParam = parsedUrl.searchParams.get('room') || 'lobby';
  const nameParam = parsedUrl.searchParams.get('name') || 'Spieler';
  const avatarParam = parsedUrl.searchParams.get('avatar') || '🎮';
  const colorParam = parsedUrl.searchParams.get('color') || '#48c78e';
  const playerIdParam = parsedUrl.searchParams.get('playerId') || ('p_' + Math.random().toString(36).slice(2, 8));
  const roomKey = normalizeRoomCode(roomParam) || 'lobby';

  const chatRoom = getOrCreateChatRoom(roomKey);

  ws.roomKey = roomKey;
  ws.playerName = nameParam;
  ws.playerId = playerIdParam;
  chatRoom.clients.add(ws);

  // Send recent chat history to newly joined player
  if (chatRoom.history.length > 0) {
    ws.send(JSON.stringify({ type: 'history', messages: chatRoom.history }));
  }

  // Register initial player entry if not already in roster
  const isNewPlayer = !chatRoom.players.has(playerIdParam);
  const existing = chatRoom.players.get(playerIdParam);
  const playerObj = {
    id: playerIdParam,
    name: nameParam,
    avatar: avatarParam,
    color: colorParam,
    isHost: false,
    isReady: existing ? existing.isReady : true,
    rom: existing ? existing.rom : null,
    emulatorReady: existing ? existing.emulatorReady : false,
    joinedAt: existing ? existing.joinedAt : Date.now(),
    lastSeen: Date.now()
  };

  chatRoom.players.set(playerIdParam, playerObj);
  chatRoom.socketToPlayerId.set(ws, playerIdParam);
  ensureRoomHost(chatRoom);

  if (isNewPlayer) {
    const joinMsg = {
      type: 'system',
      text: `${avatarParam} ${nameParam} ist der Party beigetreten!`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    broadcastChat(roomKey, joinMsg);
  }

  broadcastRoster(roomKey);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'JOIN':
        case 'UPDATE_USER': {
          const u = msg.user || {};
          const pid = u.id || ws.playerId;
          const prev = chatRoom.players.get(pid);
          const updated = {
            id: pid,
            name: (u.name || ws.playerName || 'Spieler').slice(0, 20),
            avatar: u.avatar || (prev && prev.avatar) || '🎮',
            color: u.color || (prev && prev.color) || '#48c78e',
            isHost: pid === chatRoom.hostId,
            isReady: u.isReady !== undefined ? !!u.isReady : (prev ? prev.isReady : true),
            rom: u.rom !== undefined ? u.rom : (prev ? prev.rom : null),
            emulatorReady: u.emulatorReady !== undefined ? !!u.emulatorReady : (prev ? prev.emulatorReady : false),
            joinedAt: prev ? prev.joinedAt : Date.now(),
            lastSeen: Date.now()
          };
          ws.playerId = pid;
          ws.playerName = updated.name;
          chatRoom.players.set(pid, updated);
          chatRoom.socketToPlayerId.set(ws, pid);
          if (updated.rom && pid === chatRoom.hostId) {
            chatRoom.selectedRom = updated.rom;
          }
          broadcastRoster(roomKey);
          break;
        }

        case 'HEARTBEAT': {
          const pid = msg.playerId || ws.playerId;
          const p = chatRoom.players.get(pid);
          if (p) p.lastSeen = Date.now();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'PONG' }));
          }
          break;
        }

        case 'READY_TOGGLE': {
          const pid = msg.playerId || ws.playerId;
          const p = chatRoom.players.get(pid);
          if (p) {
            p.isReady = msg.isReady !== undefined ? !!msg.isReady : !p.isReady;
            broadcastRoster(roomKey);
          }
          break;
        }

        case 'TRANSFER_HOST': {
          const senderId = chatRoom.socketToPlayerId.get(ws) || ws.playerId;
          if (senderId === chatRoom.hostId && msg.targetPlayerId && chatRoom.players.has(msg.targetPlayerId)) {
            chatRoom.hostId = msg.targetPlayerId;
            const newHost = chatRoom.players.get(msg.targetPlayerId);
            broadcastChat(roomKey, {
              type: 'HOST_TRANSFERRED',
              newHostId: msg.targetPlayerId,
              newHostName: newHost ? newHost.name : 'Mitspieler'
            });
            broadcastChat(roomKey, {
              type: 'system',
              text: `👑 ${newHost ? newHost.avatar + ' ' + newHost.name : 'Mitspieler'} ist jetzt Party-Host!`,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            broadcastRoster(roomKey);
          }
          break;
        }

        case 'SELECT_ROM': {
          const senderId = chatRoom.socketToPlayerId.get(ws) || ws.playerId;
          const p = chatRoom.players.get(senderId);
          if (p) p.rom = msg.rom;
          if (senderId === chatRoom.hostId || !chatRoom.selectedRom) {
            chatRoom.selectedRom = msg.rom;
          }
          broadcastRoster(roomKey);
          break;
        }

        case 'PARTY_LAUNCH_ROM': {
          const senderId = chatRoom.socketToPlayerId.get(ws) || ws.playerId;
          const p = chatRoom.players.get(senderId);
          if (msg.rom) {
            chatRoom.selectedRom = msg.rom;
            broadcastChat(roomKey, {
              type: 'PARTY_LAUNCH_ROM',
              rom: msg.rom,
              initiatedBy: p ? `${p.avatar} ${p.name}` : ws.playerName
            });
            broadcastChat(roomKey, {
              type: 'system',
              text: `🚀 ${p ? p.avatar + ' ' + p.name : ws.playerName} startet "${msg.rom}" für die Party!`,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            broadcastRoster(roomKey);
          }
          break;
        }

        case 'chat': {
          if (msg.text && msg.text.trim().length > 0) {
            const p = chatRoom.players.get(ws.playerId);
            const item = {
              type: 'chat',
              sender: msg.sender || (p ? p.name : ws.playerName),
              avatar: msg.avatar || (p ? p.avatar : '🎮'),
              color: msg.color || (p ? p.color : '#38bdf8'),
              text: msg.text.trim().slice(0, 500),
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
            chatRoom.history.push(item);
            if (chatRoom.history.length > 50) chatRoom.history.shift();
            broadcastChat(roomKey, item);
          }
          break;
        }
      }
    } catch (e) {
      console.error('[Party/Chat Error]:', e);
    }
  });

  ws.on('close', () => {
    chatRoom.clients.delete(ws);
    const pid = chatRoom.socketToPlayerId.get(ws) || ws.playerId;
    chatRoom.socketToPlayerId.delete(ws);

    // Check if player still has another open socket in this room
    let stillConnected = false;
    for (const [, otherPid] of chatRoom.socketToPlayerId.entries()) {
      if (otherPid === pid) {
        stillConnected = true;
        break;
      }
    }

    if (!stillConnected && pid) {
      const leavingPlayer = chatRoom.players.get(pid);
      chatRoom.players.delete(pid);
      if (leavingPlayer) {
        broadcastChat(roomKey, {
          type: 'PLAYER_LEFT',
          playerId: pid,
          name: leavingPlayer.name,
          avatar: leavingPlayer.avatar
        });
        broadcastChat(roomKey, {
          type: 'system',
          text: `${leavingPlayer.avatar || '👋'} ${leavingPlayer.name} hat die Party verlassen.`,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }
    }

    if (chatRoom.clients.size === 0) {
      chatRooms.delete(roomKey);
    } else {
      ensureRoomHost(chatRoom);
      broadcastRoster(roomKey);
    }
  });
});

function broadcastChat(roomKey, messageObj) {
  const room = chatRooms.get(roomKey);
  if (!room) return;
  const payload = JSON.stringify(messageObj);
  room.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Keepalive interval every 15s to prevent timeouts through proxies / NAT
const interval = setInterval(() => {
  wssGame.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
  wssChat.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

wssGame.on('close', () => clearInterval(interval));

server.listen(PORT, HOST, () => {
  console.log(`===============================================`);
  console.log(`🎮 Game Boy Multiplayer & Party-Hub Server`);
  console.log(`🚀 Listening on http://${HOST}:${PORT}`);
  console.log(`🔑 Alphanumeric room codes (4 chars, no 'o', lowercase)`);
  console.log(`🎉 Treffen-inspired Party Roster & Auto Link-Cable enabled`);
  console.log(`💬 Live Chat & Party Sync enabled on /chat`);
  console.log(`📁 Web Root: ${DIST_DIR}`);
  console.log(`💾 ROMs Dir: ${ROMS_DIR}`);
  console.log(`===============================================`);
});
