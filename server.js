// Minimal Node + Socket.IO authoritative room server
const express = require('express');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4000;

// In-memory rooms store (MVP only)
const rooms = new Map();

function createRoom(hostSocket, hostName) {
  const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
  const room = {
    roomId,
    hostSocketId: hostSocket.id,
    players: [],
    state: 'lobby',
    currentQuestion: null,
  };
  rooms.set(roomId, room);
  // add host as player
  const player = { id: hostSocket.id, name: hostName || 'Host', score: 0 };
  room.players.push(player);
  hostSocket.join(roomId);
  return room;
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('create_room', (data, cb) => {
    const room = createRoom(socket, data?.name);
    cb({ ok: true, roomId: room.roomId });
    io.to(room.roomId).emit('room_update', room);
  });

  socket.on('join_room', (data, cb) => {
    const { roomId, name } = data || {};
    const room = rooms.get(roomId);
    if (!room) {
      return cb({ ok: false, error: 'Room not found' });
    }
    const player = { id: socket.id, name: name || 'Player', score: 0 };
    room.players.push(player);
    socket.join(roomId);
    cb({ ok: true, room });
    io.to(roomId).emit('room_update', room);
  });

  socket.on('leave_room', (data, cb) => {
    const { roomId } = data || {};
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false });
    room.players = room.players.filter((p) => p.id !== socket.id);
    socket.leave(roomId);
    // if host left, promote a new host or dissolve
    if (room.hostSocketId === socket.id) {
      if (room.players.length > 0) room.hostSocketId = room.players[0].id;
      else rooms.delete(roomId);
    }
    io.to(roomId).emit('room_update', room);
    cb?.({ ok: true });
  });

  socket.on('start_game', (data, cb) => {
    const { roomId } = data || {};
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.hostSocketId !== socket.id) return cb({ ok: false, error: 'Only host' });
    room.state = 'running';
    // sample question
    const q = {
      id: uuidv4(),
      text: 'Which planet is known as the Red Planet?',
      choices: ['Earth', 'Mars', 'Jupiter', 'Venus'],
      correctIndex: 1,
      duration: 10, // seconds
    };
    room.currentQuestion = q;
    io.to(roomId).emit('question_start', { question: { id: q.id, text: q.text, choices: q.choices, duration: q.duration } });
    cb({ ok: true });
    // end question after duration
    setTimeout(() => {
      // reveal correct and clear currentQuestion
      io.to(roomId).emit('question_end', { questionId: q.id, correctIndex: q.correctIndex });
      room.currentQuestion = null;
      io.to(roomId).emit('score_update', { players: room.players });
    }, q.duration * 1000);
  });

  socket.on('answer', (data, cb) => {
    const { roomId, questionId, choiceIndex } = data || {};
    const room = rooms.get(roomId);
    if (!room || !room.currentQuestion || room.currentQuestion.id !== questionId) {
      return cb?.({ ok: false, error: 'No active question' });
    }
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return cb?.({ ok: false, error: 'Not in room' });
    // simple scoring: +100 correct, +0 wrong
    if (choiceIndex === room.currentQuestion.correctIndex) {
      player.score += 100;
    }
    cb?.({ ok: true });
    io.to(roomId).emit('score_update', { players: room.players });
  });

  socket.on('disconnect', () => {
    // remove from any room
    rooms.forEach((room) => {
      const existing = room.players.find((p) => p.id === socket.id);
      if (existing) {
        room.players = room.players.filter((p) => p.id !== socket.id);
        io.to(room.roomId).emit('room_update', room);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
