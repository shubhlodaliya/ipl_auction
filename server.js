const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;

// Room voice state:
// roomCode => { participants: Map(teamId -> participant), muted: Map(teamId -> boolean) }
const voiceRooms = new Map();

function getOrCreateRoom(roomCode) {
  if (!voiceRooms.has(roomCode)) {
    voiceRooms.set(roomCode, {
      participants: new Map(),
      muted: new Map()
    });
  }
  return voiceRooms.get(roomCode);
}

function serializeRoom(roomState) {
  const participants = {};
  for (const [teamId, p] of roomState.participants.entries()) {
    participants[teamId] = {
      teamId,
      ownerName: p.ownerName,
      short: p.short,
      joinedAt: p.joinedAt,
      isHost: !!p.isHost
    };
  }

  const muted = {};
  for (const [teamId, value] of roomState.muted.entries()) {
    if (value) muted[teamId] = true;
  }

  return { participants, muted };
}

function emitVoiceState(roomCode) {
  const roomState = voiceRooms.get(roomCode);
  if (!roomState) {
    io.to(`voice:${roomCode}`).emit('voice:state', { participants: {}, muted: {} });
    return;
  }

  io.to(`voice:${roomCode}`).emit('voice:state', serializeRoom(roomState));
}

function leaveVoiceRoom(socket) {
  const data = socket.data.voice;
  if (!data || !data.roomCode || !data.teamId) return;

  const roomCode = data.roomCode;
  const teamId = data.teamId;
  const roomState = voiceRooms.get(roomCode);
  if (!roomState) return;

  const participant = roomState.participants.get(teamId);
  if (participant && participant.socketId === socket.id) {
    roomState.participants.delete(teamId);
    roomState.muted.delete(teamId);
  }

  if (roomState.participants.size === 0) {
    voiceRooms.delete(roomCode);
  }

  socket.leave(`voice:${roomCode}`);
  socket.data.voice = null;
  emitVoiceState(roomCode);
}

io.on('connection', (socket) => {
  socket.on('voice:join', (payload = {}) => {
    try {
      const roomCode = String(payload.roomCode || '').trim();
      const teamId = String(payload.teamId || '').trim();
      const ownerName = String(payload.ownerName || 'Player').slice(0, 60);
      const short = String(payload.short || teamId || 'TEAM').slice(0, 20);
      const isHost = !!payload.isHost;

      if (!roomCode || !teamId) {
        socket.emit('voice:error', { message: 'Invalid room join payload.' });
        return;
      }

      // Ensure old mapping is cleared when rejoining.
      leaveVoiceRoom(socket);

      const roomState = getOrCreateRoom(roomCode);
      roomState.participants.set(teamId, {
        socketId: socket.id,
        ownerName,
        short,
        joinedAt: Date.now(),
        isHost
      });

      socket.join(`voice:${roomCode}`);
      socket.data.voice = { roomCode, teamId };
      emitVoiceState(roomCode);
    } catch (err) {
      socket.emit('voice:error', { message: 'Failed to join voice room.' });
    }
  });

  socket.on('voice:leave', () => {
    leaveVoiceRoom(socket);
  });

  socket.on('voice:signal', (payload = {}) => {
    const from = socket.data.voice;
    if (!from || !from.roomCode || !from.teamId) return;

    const roomState = voiceRooms.get(from.roomCode);
    if (!roomState) return;

    const targetTeamId = String(payload.targetTeamId || '').trim();
    if (!targetTeamId || targetTeamId === from.teamId) return;

    const targetParticipant = roomState.participants.get(targetTeamId);
    if (!targetParticipant || !targetParticipant.socketId) return;

    io.to(targetParticipant.socketId).emit('voice:signal', {
      fromTeamId: from.teamId,
      description: payload.description || null,
      candidate: payload.candidate || null,
      at: Date.now()
    });
  });

  socket.on('voice:host-mute', (payload = {}) => {
    const from = socket.data.voice;
    if (!from || !from.roomCode || !from.teamId) return;

    const roomState = voiceRooms.get(from.roomCode);
    if (!roomState) return;

    const actor = roomState.participants.get(from.teamId);
    if (!actor || !actor.isHost) return;

    const targetTeamId = String(payload.targetTeamId || '').trim();
    if (!targetTeamId || !roomState.participants.has(targetTeamId)) return;

    const muted = !!payload.muted;
    if (muted) roomState.muted.set(targetTeamId, true);
    else roomState.muted.delete(targetTeamId);

    emitVoiceState(from.roomCode);
  });

  socket.on('disconnect', () => {
    leaveVoiceRoom(socket);
  });
});

app.use(express.static(ROOT_DIR));

server.listen(PORT, () => {
  console.log(`IPL Auction server running on http://localhost:${PORT}`);
});
