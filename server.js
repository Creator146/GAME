const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const MAX_NAME = 20;
const MAX_TOKEN = 20;
const MAX_ROOM_PLAYERS = 8;
const MAX_PUBLIC_PER_MODE = 200;

const clients = new Map(); // id -> ws
const rooms = new Map();   // code -> room
const publicQueues = new Map(); // mode -> [id]

function rid(){ return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function pid(){ return Math.random().toString(36).slice(2, 10); }
function isOpen(ws){ return !!ws && ws.readyState === 1; }
function send(ws, obj){ if(isOpen(ws)) ws.send(JSON.stringify(obj)); }
function sendTo(id, obj){ send(clients.get(id), obj); }
function safeText(v, maxLen){ return String(v || '').replace(/[^\w \-]/g, '').trim().slice(0, maxLen); }
function roomPlayerList(room){
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    skin: p.skin,
    title: p.title,
  }));
}
function broadcastRoom(room, obj, exceptId = null){
  for(const p of room.players){
    if(p.id !== exceptId) sendTo(p.id, obj);
  }
}
function broadcastRoomState(room){
  broadcastRoom(room, {
    type: 'room',
    code: room.code,
    mode: room.mode,
    hostId: room.hostId,
    players: roomPlayerList(room),
    roomType: room.roomType,
  });
}

function makeRoom(mode, roomType){
  let code = rid();
  while(rooms.has(code)) code = rid();
  const room = {
    code,
    roomType,
    mode,
    hostId: null,
    players: [],
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function removeFromQueues(id){
  for(const [mode, arr] of publicQueues.entries()){
    const idx = arr.indexOf(id);
    if(idx >= 0) arr.splice(idx, 1);
    if(arr.length === 0) publicQueues.delete(mode);
  }
}

function leaveCurrentRoom(id){
  const client = clients.get(id);
  if(!client) return;

  removeFromQueues(id);

  if(!client.roomCode) return;
  const room = rooms.get(client.roomCode);
  client.roomCode = null;
  if(!room) return;

  const idx = room.players.findIndex(p => p.id === id);
  if(idx >= 0) room.players.splice(idx, 1);

  if(room.players.length === 0){
    rooms.delete(room.code);
    return;
  }

  if(room.hostId === id){
    room.hostId = room.players[0].id;
    broadcastRoom(room, {
      type: 'host_changed',
      hostId: room.hostId,
      hostName: room.players[0].name,
      players: roomPlayerList(room),
      code: room.code,
      roomType: room.roomType,
    });
  }

  broadcastRoomState(room);
  broadcastRoom(room, { type: 'system', text: `${client.name || 'A player'} left ${room.code}` });
}

function joinRoom(client, room){
  leaveCurrentRoom(client.id);

  if(room.players.length >= MAX_ROOM_PLAYERS){
    send(client, { type: 'error', text: 'Room is full' });
    return;
  }

  client.roomCode = room.code;
  if(!room.hostId) room.hostId = client.id;

  room.players.push({
    id: client.id,
    name: client.name || 'Player',
    skin: client.skin || 'cyan',
    title: client.title || 'rookie',
  });

  broadcastRoomState(room);
  broadcastRoom(room, { type: 'system', text: `${client.name || 'A player'} joined ${room.code}` });
}

function queuePublic(client, mode){
  leaveCurrentRoom(client.id);

  const arr = publicQueues.get(mode) || [];
  while(arr.length > 0 && !clients.has(arr[0])) arr.shift();

  const otherId = arr.shift();
  if(otherId && clients.has(otherId)){
    const room = makeRoom(mode, 'public');
    joinRoom(clients.get(otherId), room);
    joinRoom(client, room);
  } else {
    if(arr.length >= MAX_PUBLIC_PER_MODE){
      send(client, { type: 'error', text: 'Queue is full, try again soon' });
      return;
    }
    arr.push(client.id);
    publicQueues.set(mode, arr);
    send(client, { type: 'queued', mode, count: arr.length });
  }
}

wss.on('connection', (ws) => {
  const id = pid();
  ws.id = id;
  ws.roomCode = null;
  ws.name = 'Player';
  ws.skin = 'cyan';
  ws.title = 'rookie';
  clients.set(id, ws);

  send(ws, { type: 'hello', id });

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if(msg.type === 'hello'){
      ws.name = safeText(msg.name || 'Player', MAX_NAME) || 'Player';
      ws.skin = safeText(msg.skin || 'cyan', MAX_TOKEN) || 'cyan';
      ws.title = safeText(msg.title || 'rookie', MAX_TOKEN) || 'rookie';
      return;
    }

    if(msg.type === 'queue_public') return queuePublic(ws, String(msg.mode || 'TAG').slice(0, 24));

    if(msg.type === 'create_private'){
      const room = makeRoom(String(msg.mode || 'TAG').slice(0, 24), 'private');
      joinRoom(ws, room);
      return;
    }

    if(msg.type === 'join_private'){
      const code = String(msg.code || '').trim().toUpperCase().slice(0, 8);
      const room = rooms.get(code);
      if(!room) return send(ws, { type: 'error', text: 'Room not found' });
      joinRoom(ws, room);
      return;
    }

    if(msg.type === 'leave_room') return leaveCurrentRoom(id);

    const room = rooms.get(ws.roomCode);
    if(!room) return;

    if(msg.type === 'start_mode'){
      if(room.hostId !== id) return;
      room.mode = String(msg.mode || room.mode).slice(0, 24);
      broadcastRoom(room, { type: 'start_mode', mode: room.mode, map: msg.map || null });
      return;
    }

    if(msg.type === 'input'){
      if(room.hostId && room.hostId !== id){
        sendTo(room.hostId, { type: 'host_input', id, input: msg.input || {} });
      }
      return;
    }

    if(msg.type === 'snapshot'){
      if(room.hostId !== id) return;
      broadcastRoom(room, { type: 'snapshot', snapshot: msg.snapshot }, id);
      return;
    }

    if(msg.type === 'vote'){
      if(room.hostId && room.hostId !== id){
        sendTo(room.hostId, { type: 'vote', id, index: msg.index | 0 });
      }
    }
  });

  ws.on('close', () => {
    leaveCurrentRoom(id);
    clients.delete(id);
    removeFromQueues(id);
  });

  ws.on('error', () => {
    // Avoid crashing the Node process on socket errors.
  });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Neon Online server running on http://${HOST}:${PORT}`);
});
