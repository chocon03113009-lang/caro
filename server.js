/**
 * server.js — Máy chủ Cờ Caro Online (Node.js + Socket.IO)
 *
 * Vai trò:
 *  1) Phục vụ trang web trong thư mục public/ (index.html, style.css, script.js).
 *  2) Quản lý phòng chơi và đồng bộ bàn cờ theo thời gian thực qua Socket.IO.
 *
 * Nguyên tắc quan trọng: MÁY CHỦ LÀ TRỌNG TÀI.
 *  - Trình duyệt chỉ gửi "yêu cầu" (ví dụ: tôi muốn đánh ô số 112).
 *  - Máy chủ tự kiểm tra vai trò, lượt đi, ô trống, người thắng... rồi gửi trạng thái
 *    chính thức cho cả phòng. Trình duyệt không thể tự đổi vai trò hay điểm số.
 *
 * Dữ liệu phòng chỉ nằm trong bộ nhớ (RAM): khởi động lại máy chủ thì mọi phòng mất.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

/* ---------- 1. Cấu hình (có thể đổi bằng biến môi trường) ---------- */
const PORT = process.env.PORT || 3000;               // Render/Railway tự cấp PORT
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';   // để trống = chỉ cho phép cùng nguồn (an toàn nhất)
const SIZE = 15;                                     // bàn cờ 15 x 15
const WIN_LENGTH = 5;
const MAX_MEMBERS = 10;                              // tối đa 10 người mỗi phòng
const MAX_ROOMS = 300;                               // giới hạn để máy chủ nhỏ không bị quá tải
const PLAYER_GRACE_MS = 60 * 1000;                   // người chơi mất kết nối: giữ chỗ 60 giây
const SPECTATOR_GRACE_MS = 20 * 1000;                // khán giả mất kết nối: giữ chỗ 20 giây
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;             // phòng không hoạt động 2 giờ thì xóa
const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // bỏ I, O, 0, 1 cho khỏi nhầm
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;              // "chìa khóa phiên" do trình duyệt tạo

/* ---------- 2. Máy chủ web: chỉ phục vụ đúng các tệp được phép ---------- */
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = {
  'index.html': 'text/html; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'script.js': 'text/javascript; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/healthz') {                      // đường dẫn để dịch vụ hosting kiểm tra máy chủ còn sống
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  const fileName = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  // Danh sách cho phép giúp chặn kiểu tấn công đọc trộm tệp khác (ví dụ ../server.js)
  if (!Object.prototype.hasOwnProperty.call(STATIC_FILES, fileName)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Không tìm thấy trang');
    return;
  }
  fs.readFile(path.join(PUBLIC_DIR, fileName), (error, data) => {
    if (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Lỗi đọc tệp');
      return;
    }
    res.writeHead(200, { 'Content-Type': STATIC_FILES[fileName], 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

/* ---------- 3. Socket.IO ---------- */
const io = new Server(server, {
  maxHttpBufferSize: 2000,                           // chặn gói dữ liệu quá lớn
  cors: CORS_ORIGIN ? { origin: CORS_ORIGIN.split(',').map((s) => s.trim()) } : undefined
});

/* ---------- 4. Dữ liệu phòng (trong RAM) ---------- */
const rooms = new Map();   // mã phòng -> phòng
let nextMemberId = 1;      // id công khai của thành viên (khác với token bí mật)

function createRoom() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  const room = {
    code,
    members: new Map(),          // token -> thành viên { token, id, name, role, socketId, connected, timer }
    scores: { X: 0, O: 0 },
    starter: 'X',
    lastActive: Date.now()
  };
  resetBoard(room);
  rooms.set(code, room);
  return room;
}

function resetBoard(room) {
  room.board = Array(SIZE * SIZE).fill(null);
  room.turn = room.starter;
  room.result = null;            // null | 'X' | 'O' | 'draw'
  room.winLine = [];
  room.lastMove = -1;
}

const listMembers = (room) => [...room.members.values()];
const seatedPlayer = (room, role) => listMembers(room).find((m) => m.role === role);

// Trạng thái ván: waiting (thiếu người) | paused (có người chơi mất kết nối) | playing | finished
function computeStatus(room) {
  if (room.result) return 'finished';
  const x = seatedPlayer(room, 'X');
  const o = seatedPlayer(room, 'O');
  if (!x || !o) return 'waiting';
  if (!x.connected || !o.connected) return 'paused';
  return 'playing';
}

function findWinLine(board, index) {
  const symbol = board[index];
  if (!symbol) return [];
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  for (const [dRow, dCol] of DIRECTIONS) {
    const line = [index];
    for (const sign of [1, -1]) {
      let r = row + dRow * sign;
      let c = col + dCol * sign;
      while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r * SIZE + c] === symbol) {
        line.push(r * SIZE + c);
        r += dRow * sign;
        c += dCol * sign;
      }
    }
    if (line.length >= WIN_LENGTH) return line;
  }
  return [];
}

/* ---------- 5. Gửi dữ liệu cho cả phòng ---------- */
// Ảnh chụp trạng thái phòng. KHÔNG chứa token (token là bí mật của từng người).
function snapshot(room) {
  return {
    code: room.code,
    status: computeStatus(room),
    board: room.board,
    turn: room.turn,
    result: room.result,
    winLine: room.winLine,
    lastMove: room.lastMove,
    scores: room.scores,
    members: listMembers(room).map((m) => ({ id: m.id, name: m.name, role: m.role, connected: m.connected }))
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  io.to(room.code).emit('state', snapshot(room));
}
function notify(room, message) { io.to(room.code).emit('notice', { message }); }

/* ---------- 6. Thêm, nối lại và xóa thành viên ---------- */
function attachSocket(socket, room, member) {
  socket.join(room.code);               // "phòng" của Socket.IO: dùng để phát tin cho cả phòng
  socket.data.code = room.code;
  socket.data.token = member.token;
  member.socketId = socket.id;
  member.connected = true;
  clearTimeout(member.timer);
  member.timer = null;
}

function addMember(socket, room, token, name) {
  const role = !seatedPlayer(room, 'X') ? 'X' : !seatedPlayer(room, 'O') ? 'O' : 'spectator';
  const member = { token, id: nextMemberId++, name, role, socketId: null, connected: true, timer: null };
  room.members.set(token, member);
  if (role !== 'spectator') room.scores[role] = 0;   // điểm gắn với chỗ ngồi: người mới vào thì tính lại
  attachSocket(socket, room, member);
  return member;
}

// Xóa hẳn một thành viên (tự rời phòng hoặc mất kết nối quá lâu)
function removeMember(room, member, message) {
  clearTimeout(member.timer);
  room.members.delete(member.token);
  if (room.members.size === 0) { rooms.delete(room.code); return; }   // phòng trống thì xóa
  let extra = '';
  if (member.role !== 'spectator') {
    // Người chơi rời đi: khán giả đang online sớm nhất được xếp vào chỗ trống
    const heir = listMembers(room).find((m) => m.role === 'spectator' && m.connected);
    if (heir) {
      heir.role = member.role;
      room.scores[member.role] = 0;
      extra = ' ' + heir.name + ' được xếp vào quân ' + member.role + '.';
    }
  }
  notify(room, message + extra);
  broadcast(room);
}

// Tìm phòng và thành viên ứng với kết nối này
function lookup(socket) {
  const room = rooms.get(socket.data.code);
  const member = room ? room.members.get(socket.data.token) : null;
  return { room, member };
}

/* ---------- 7. Kiểm tra dữ liệu đầu vào và giới hạn tần suất ---------- */
function cleanName(name) {
  const text = typeof name === 'string'
    ? name.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16)
    : '';
  return text || 'Khách';
}

function normalizeCode(code) {
  const text = typeof code === 'string' ? code.trim().toUpperCase() : '';
  return /^[A-Z0-9]{4,8}$/.test(text) ? text : null;
}

// Xô token: tối đa 10 thao tác dồn, về lâu dài 5 thao tác/giây cho mỗi kết nối
function allowAction(socket) {
  const now = Date.now();
  const bucket = socket.data.bucket || (socket.data.bucket = { tokens: 10, last: now });
  bucket.tokens = Math.min(10, bucket.tokens + (now - bucket.last) / 200);
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function reply(ack, data) { if (typeof ack === 'function') ack(data); }
function fail(ack, message, code) { reply(ack, { ok: false, message, code }); }

/* ---------- 8. Xử lý sự kiện từ trình duyệt ---------- */
function handleCreate(socket, payload, ack) {
  const data = payload && typeof payload === 'object' ? payload : {};
  if (!TOKEN_PATTERN.test(data.token)) return fail(ack, 'Phiên chơi không hợp lệ. Hãy tải lại trang.');
  if (socket.data.code) return fail(ack, 'Bạn đang ở trong một phòng.');
  if (rooms.size >= MAX_ROOMS) return fail(ack, 'Máy chủ đang có quá nhiều phòng. Hãy thử lại sau.');
  const room = createRoom();
  const member = addMember(socket, room, data.token, cleanName(data.name));
  reply(ack, { ok: true, code: room.code, id: member.id });   // trả lời trước để trình duyệt biết "id" của mình
  broadcast(room);
}

function handleJoin(socket, payload, ack) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const code = normalizeCode(data.code);
  if (!code) return fail(ack, 'Mã phòng gồm 4 đến 8 chữ cái hoặc số.');
  if (!TOKEN_PATTERN.test(data.token)) return fail(ack, 'Phiên chơi không hợp lệ. Hãy tải lại trang.');
  if (socket.data.code) return fail(ack, 'Bạn đang ở trong một phòng.');

  const room = rooms.get(code);
  if (!room) {
    // Chống dò mã phòng: sai quá nhiều lần thì ngắt kết nối
    socket.data.misses = (socket.data.misses || 0) + 1;
    if (socket.data.misses >= 8) socket.disconnect(true);
    return fail(ack, 'Không tìm thấy phòng. Phòng có thể đã đóng hoặc máy chủ vừa khởi động lại.', 'NO_ROOM');
  }

  const existing = room.members.get(data.token);
  if (existing) {
    // NỐI LẠI: cùng token nghĩa là cùng một người (tải lại trang hoặc vừa mất mạng)
    if (existing.connected && existing.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existing.socketId);
      if (oldSocket) {
        oldSocket.data.code = null;      // xóa liên kết để sự kiện disconnect của kết nối cũ không làm gì
        oldSocket.data.token = null;
        oldSocket.emit('notice', { message: 'Bạn đã mở phòng này ở nơi khác.' });
        oldSocket.disconnect(true);
      }
    }
    const wasAway = !existing.connected;
    attachSocket(socket, room, existing);
    if (wasAway) notify(room, existing.name + ' đã kết nối lại.');
    reply(ack, { ok: true, code: room.code, id: existing.id });
    broadcast(room);
    return undefined;
  }

  if (room.members.size >= MAX_MEMBERS) return fail(ack, 'Phòng đã đủ ' + MAX_MEMBERS + ' người.');
  const member = addMember(socket, room, data.token, cleanName(data.name));
  reply(ack, { ok: true, code: room.code, id: member.id });
  notify(room, member.name + (member.role === 'spectator' ? ' vào xem trận đấu.' : ' vào phòng, chơi quân ' + member.role + '.'));
  broadcast(room);
  return undefined;
}

function handleMove(socket, payload, ack) {
  const { room, member } = lookup(socket);
  if (!room || !member) return fail(ack, 'Bạn chưa vào phòng hoặc phòng đã đóng.', 'NO_ROOM');
  // Vai trò lấy từ DỮ LIỆU CỦA MÁY CHỦ, không tin bất cứ thứ gì trình duyệt tự khai
  if (member.role === 'spectator') return fail(ack, 'Khán giả không được đánh cờ.');
  if (room.result) return fail(ack, 'Ván đã kết thúc. Hãy bấm "Ván mới".');
  const status = computeStatus(room);
  if (status === 'waiting') return fail(ack, 'Đang chờ đủ 2 người chơi.');
  if (status === 'paused') return fail(ack, 'Đối thủ đang mất kết nối. Hãy chờ họ quay lại.');
  if (member.role !== room.turn) return fail(ack, 'Chưa tới lượt của bạn!');
  const index = payload && payload.index;
  if (!Number.isInteger(index) || index < 0 || index >= SIZE * SIZE) return fail(ack, 'Nước đi không hợp lệ.');
  if (room.board[index]) return fail(ack, 'Ô này đã có quân cờ!');

  room.board[index] = member.role;
  room.lastMove = index;
  const line = findWinLine(room.board, index);
  if (line.length) {
    room.result = member.role;
    room.winLine = line;
    room.scores[member.role] += 1;
  } else if (room.board.every(Boolean)) {
    room.result = 'draw';
  } else {
    room.turn = room.turn === 'X' ? 'O' : 'X';
  }
  reply(ack, { ok: true });
  broadcast(room);
  return undefined;
}

function handleRestart(socket, payload, ack) {
  const { room, member } = lookup(socket);
  if (!room || !member) return fail(ack, 'Bạn chưa vào phòng hoặc phòng đã đóng.', 'NO_ROOM');
  if (member.role === 'spectator') return fail(ack, 'Chỉ người chơi mới được bắt đầu ván mới.');
  if (!room.result) return fail(ack, 'Ván đang diễn ra. Hãy chơi xong ván này trước.');
  room.starter = room.starter === 'X' ? 'O' : 'X';   // đổi người đi trước mỗi ván
  resetBoard(room);
  reply(ack, { ok: true });
  notify(room, member.name + ' bắt đầu ván mới.');
  broadcast(room);
}

function handleLeave(socket, payload, ack) {
  const { room, member } = lookup(socket);
  if (room && member) {
    socket.leave(room.code);
    socket.data.code = null;
    socket.data.token = null;
    removeMember(room, member, member.name + ' đã rời phòng.');
  }
  reply(ack, { ok: true });
}

// Mất kết nối: KHÔNG xóa ngay mà giữ chỗ một lúc để người chơi kịp quay lại
function handleDisconnect(socket) {
  const { room, member } = lookup(socket);
  if (!room || !member || member.socketId !== socket.id) return;
  member.connected = false;
  const waitMs = member.role === 'spectator' ? SPECTATOR_GRACE_MS : PLAYER_GRACE_MS;
  if (member.role !== 'spectator') {
    notify(room, member.name + ' mất kết nối. Đang chờ kết nối lại (tối đa ' + waitMs / 1000 + ' giây)...');
  }
  member.timer = setTimeout(() => {
    const stillThere = rooms.get(room.code) === room && room.members.get(member.token) === member;
    if (stillThere && !member.connected) {
      removeMember(room, member, member.name + ' mất kết nối quá lâu nên đã rời phòng.');
    }
  }, waitMs);
  broadcast(room);
}

io.on('connection', (socket) => {
  // Bọc mỗi sự kiện: giới hạn tần suất và bắt lỗi bất ngờ để máy chủ không bị sập
  const on = (eventName, handler) => {
    socket.on(eventName, (payload, ack) => {
      if (typeof payload === 'function') { ack = payload; payload = null; }   // trình duyệt gửi thiếu dữ liệu
      if (!allowAction(socket)) return fail(ack, 'Bạn thao tác quá nhanh, hãy chậm lại một chút.');
      try {
        return handler(socket, payload, ack);
      } catch (error) {
        console.error('Lỗi khi xử lý ' + eventName + ':', error);
        return fail(ack, 'Máy chủ gặp lỗi. Hãy thử lại.');
      }
    });
  };
  on('room:create', handleCreate);
  on('room:join', handleJoin);
  on('game:move', handleMove);
  on('game:restart', handleRestart);
  on('room:leave', handleLeave);
  socket.on('disconnect', () => handleDisconnect(socket));
});

/* ---------- 9. Dọn dẹp và tắt máy chủ ---------- */
// Cứ 10 phút xóa các phòng bị bỏ quên quá lâu
const cleaner = setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (now - room.lastActive > ROOM_IDLE_MS) {
      for (const member of room.members.values()) clearTimeout(member.timer);
      io.to(room.code).emit('room:closed', { message: 'Phòng đã đóng vì không hoạt động quá lâu.' });
      rooms.delete(room.code);
    }
  }
}, 10 * 60 * 1000);
cleaner.unref();

// Hosting gửi SIGTERM khi khởi động lại/triển khai: đóng gọn gàng rồi thoát
process.on('SIGTERM', () => {
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

server.listen(PORT, () => {
  console.log('Cờ Caro đang chạy tại http://localhost:' + PORT);
});
