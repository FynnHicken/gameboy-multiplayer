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

// Active game rooms map: roomCodeLower -> { id, host, guest, createdAt }
const gameRooms = new Map();

// Active chat rooms map: roomCodeLower -> { clients: Set<ws>, history: Array<msg> }
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
};

// HTTP Server
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname;
  try { pathname = decodeURIComponent(parsedUrl.pathname); } catch (e) { pathname = parsedUrl.pathname; }

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

  // API: Download/Fetch ROM
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
  if (pathname.startsWith('/assets/')) {
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

// WebSocket Server for Live Chat (/chat)
const wssChat = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (parsedUrl.pathname === '/ws') {
    wssGame.handleUpgrade(request, socket, head, (ws) => {
      wssGame.emit('connection', ws, request);
    });
  } else if (parsedUrl.pathname === '/chat') {
    wssChat.handleUpgrade(request, socket, head, (ws) => {
      wssChat.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// --- Game Boy Netplay Handlers (/ws) ---
wssGame.on('connection', (ws, request) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const roomParam = parsedUrl.searchParams.get('room');

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

    // Send room code as text to host
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
    let roomKey = roomParam.trim().toLowerCase();
    let room = gameRooms.get(roomKey);

    // If not found and input had 'o', also try replacing 'o' with '0'
    if (!room && roomKey.includes('o')) {
      const altKey = roomKey.replace(/o/g, '0');
      if (gameRooms.has(altKey)) {
        room = gameRooms.get(altKey);
        roomKey = altKey;
      }
    }

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

// --- Live Chat Handlers (/chat) ---
wssChat.on('connection', (ws, request) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const roomParam = parsedUrl.searchParams.get('room') || 'lobby';
  const nameParam = parsedUrl.searchParams.get('name') || 'Spieler';
  const roomKey = roomParam.trim().toLowerCase();

  let chatRoom = chatRooms.get(roomKey);
  if (!chatRoom) {
    chatRoom = { clients: new Set(), history: [] };
    chatRooms.set(roomKey, chatRoom);
  }

  ws.roomKey = roomKey;
  ws.playerName = nameParam;
  chatRoom.clients.add(ws);

  // Send recent history to newly joined player
  if (chatRoom.history.length > 0) {
    ws.send(JSON.stringify({ type: 'history', messages: chatRoom.history }));
  }

  // Broadcast join notification
  const joinMsg = {
    type: 'system',
    text: `${nameParam} ist dem Chat beigetreten!`,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
  broadcastChat(roomKey, joinMsg);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'chat' && msg.text && msg.text.trim().length > 0) {
        const item = {
          type: 'chat',
          sender: msg.sender || ws.playerName,
          text: msg.text.trim().slice(0, 500),
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        chatRoom.history.push(item);
        if (chatRoom.history.length > 50) chatRoom.history.shift();
        broadcastChat(roomKey, item);
      }
    } catch (e) {
      console.error('[Chat Error]:', e);
    }
  });

  ws.on('close', () => {
    chatRoom.clients.delete(ws);
    const leaveMsg = {
      type: 'system',
      text: `${ws.playerName} hat den Chat verlassen.`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    broadcastChat(roomKey, leaveMsg);
    if (chatRoom.clients.size === 0) {
      chatRooms.delete(roomKey);
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
  console.log(`🎮 Game Boy Multiplayer Netplay Server Started`);
  console.log(`🚀 Listening on http://${HOST}:${PORT}`);
  console.log(`🔑 Alphanumeric room codes (4 chars, no 'o', lowercase)`);
  console.log(`💬 Live Chat enabled on /chat`);
  console.log(`📁 Web Root: ${DIST_DIR}`);
  console.log(`💾 ROMs Dir: ${ROMS_DIR}`);
  console.log(`===============================================`);
});
