/* =====================================================
   script.js — Phần chạy trong trình duyệt của Cờ Caro
   Có 2 chế độ:
   - "local":  hai người luân phiên trên cùng một máy (không cần Internet)
   - "online": kết nối Socket.IO tới máy chủ qua Internet. Máy chủ là trọng tài,
               trình duyệt chỉ gửi yêu cầu và hiển thị trạng thái do máy chủ xác nhận.
   ===================================================== */
'use strict';

/* ---------- 1. Hằng số ---------- */
const SIZE = 15;
const WIN_LENGTH = 5;
const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const SESSION_KEY = 'caro-session';   // lưu trong sessionStorage: mỗi tab là một "người chơi" riêng

/* ---------- 2. Lấy các phần tử HTML ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  home: $('home'), game: $('game'),
  nameInput: $('nameInput'), codeInput: $('codeInput'),
  btnLocal: $('btnLocal'), btnCreate: $('btnCreate'), btnJoin: $('btnJoin'),
  homeMsg: $('homeMsg'), onlineNote: $('onlineNote'),
  board: $('board'), statusText: $('statusText'), netBanner: $('netBanner'),
  roomBox: $('roomBox'), roomCode: $('roomCode'), btnCopy: $('btnCopy'), connBadge: $('connBadge'),
  cardX: $('cardX'), cardO: $('cardO'), nameX: $('nameX'), nameO: $('nameO'),
  scoreX: $('scoreX'), scoreO: $('scoreO'),
  memberBox: $('memberBox'), memberList: $('memberList'), memberCount: $('memberCount'),
  spectatorNote: $('spectatorNote'), btnRestart: $('btnRestart'), btnLeave: $('btnLeave'),
  modal: $('modal'), modalTitle: $('modalTitle'), modalText: $('modalText'),
  modalRestart: $('modalRestart'), modalClose: $('modalClose'), toast: $('toast')
};

/* ---------- 3. Trạng thái trò chơi ---------- */
// "view" là mọi thứ giao diện cần để vẽ. Chế độ online nhận dữ liệu này từ máy chủ.
function newView() {
  return {
    mode: 'none',                          // 'none' | 'local' | 'online'
    board: Array(SIZE * SIZE).fill(null),  // mỗi ô: null, 'X' hoặc 'O'
    turn: 'X',
    result: null,                          // null | 'X' | 'O' | 'draw'
    winLine: [],
    lastMove: -1,
    scores: { X: 0, O: 0 },
    names: { X: 'Người chơi X', O: 'Người chơi O' },
    starter: 'X',                          // (local) ai đi trước
    status: 'playing',                     // (online) waiting | paused | playing | finished
    connection: 'connected',               // (online) connected | reconnecting
    myRole: null,                          // 'X' | 'O' | 'spectator' | 'both' (local)
    myId: null,
    members: [],
    code: ''
  };
}
let view = newView();
let myName = '';

/* ---------- 4. Hàm tiện ích ---------- */
let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2800);
}
function homeMessage(message) { el.homeMsg.textContent = message || ''; }

// Lưu thông tin phiên trong sessionStorage (bọc try/catch vì có trình duyệt chặn lưu trữ)
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)) || {}; } catch (e) { return {}; }
}
function saveSession(patch) {
  const data = Object.assign(loadSession(), patch);
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch (e) { /* bỏ qua */ }
}
function forgetRoom() {
  const data = loadSession();
  delete data.code;
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch (e) { /* bỏ qua */ }
}
function loadSavedName() { try { return localStorage.getItem('caro-name') || ''; } catch (e) { return ''; } }
function saveName(name) { try { localStorage.setItem('caro-name', name); } catch (e) { /* bỏ qua */ } }

// "Token" là chìa khóa bí mật của tab này, giúp máy chủ nhận ra bạn khi tải lại trang hoặc kết nối lại
let sessionToken = null;
function randomToken() {
  const bytes = new Uint8Array(16);
  if (window.crypto && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function getToken() {
  if (sessionToken) return sessionToken;
  const saved = loadSession().token;
  sessionToken = /^[a-f0-9]{32}$/.test(saved || '') ? saved : randomToken();
  saveSession({ token: sessionToken });
  return sessionToken;
}

function getName() {
  const typed = el.nameInput.value.trim().slice(0, 16);
  return typed || 'Khách' + (100 + Math.floor(Math.random() * 900));
}
function prepareName() {
  myName = getName();
  el.nameInput.value = myName;
  saveName(myName);
  saveSession({ name: myName });
}

/* ---------- 5. Luật chơi: tìm đường thắng (dùng cho chế độ một máy) ---------- */
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

/* ---------- 6. Chế độ chơi trên một máy ---------- */
function startLocal() {
  view = newView();
  view.mode = 'local';
  view.myRole = 'both';
  view.names = { X: myName, O: 'Người chơi 2' };
  showGame();
  render();
}

function localMove(index) {
  if (view.result) { toast('Ván đã kết thúc. Bấm "Ván mới" để chơi tiếp.'); return; }
  if (view.board[index]) { toast('Ô này đã có quân cờ!'); return; }
  view.board[index] = view.turn;
  view.lastMove = index;
  const line = findWinLine(view.board, index);
  if (line.length) {
    view.result = view.turn;
    view.winLine = line;
    view.scores[view.turn] += 1;
  } else if (view.board.every(Boolean)) {
    view.result = 'draw';
  } else {
    view.turn = view.turn === 'X' ? 'O' : 'X';
  }
  render();
  if (view.result) openResult();
}

function localRestart() {
  view.starter = view.starter === 'X' ? 'O' : 'X';
  view.board = Array(SIZE * SIZE).fill(null);
  view.turn = view.starter;
  view.result = null;
  view.winLine = [];
  view.lastMove = -1;
  closeModal();
  render();
}

/* ---------- 7. Chế độ online: Socket.IO ---------- */
let socket = null;          // kết nối hiện tại
let pendingAction = null;   // việc cần làm ngay khi kết nối xong (tạo phòng, vào phòng...)

// Nếu mở trang trực tiếp từ tệp (file://) hoặc thư viện không tải được thì "io" không tồn tại
function onlineAvailable() { return typeof io === 'function'; }

function ensureSocket() {
  if (socket) return socket;
  // io() không có địa chỉ = kết nối về chính máy chủ đã phục vụ trang này (không cần nhập IP)
  socket = io({ autoConnect: false, reconnectionDelayMax: 5000 });
  socket.on('connect', onConnect);
  socket.on('disconnect', onDisconnect);
  socket.on('connect_error', onConnectError);
  socket.on('state', applyState);                       // trạng thái chính thức từ máy chủ
  socket.on('notice', (data) => { if (data && data.message) toast(data.message); });
  socket.on('room:closed', (data) => leaveToHome(data && data.message));
  return socket;
}

// Chạy một việc khi đã kết nối; nếu chưa thì kết nối trước
function runWhenConnected(action) {
  homeMessage('Đang kết nối máy chủ...');
  ensureSocket();
  if (socket.connected) { action(); return; }
  pendingAction = action;
  socket.connect();
}

function onConnect() {
  setConnection('connected');
  if (pendingAction) {
    const action = pendingAction;
    pendingAction = null;
    action();
    return;
  }
  // Kết nối lại sau khi mất mạng: tự vào lại phòng đang chơi bằng token cũ
  if (view.mode === 'online' && view.code) emitJoin(view.code, true);
}

function onDisconnect(reason) {
  if (view.mode !== 'online') return;
  if (reason === 'io server disconnect') {              // máy chủ chủ động ngắt
    leaveToHome('Bạn đã bị ngắt kết nối khỏi phòng.');
    return;
  }
  setConnection('reconnecting');                        // Socket.IO tự thử kết nối lại
}

function onConnectError() {
  if (view.mode === 'online') { setConnection('reconnecting'); return; }
  if (pendingAction) {
    pendingAction = null;
    homeMessage('Không kết nối được máy chủ. Hãy kiểm tra Internet rồi thử lại.');
    if (socket) socket.disconnect();                    // dừng tự thử lại khi đang ở trang chủ
  }
}

function setConnection(state) {
  view.connection = state;
  if (view.mode === 'online') render();
}

function emitCreate() {
  socket.emit('room:create', { name: myName, token: getToken() }, (res) => handleJoinResult(res, false));
}
function emitJoin(code, silent) {
  socket.emit('room:join', { code, name: myName, token: getToken() }, (res) => handleJoinResult(res, silent));
}

function handleJoinResult(res, silent) {
  if (!res || !res.ok) {
    const message = (res && res.message) || 'Không vào được phòng.';
    if (silent || view.mode === 'online') {
      leaveToHome(message);                             // vào lại thất bại: về trang chủ kèm lý do
    } else {
      homeMessage(message);
      if (socket) socket.disconnect();
    }
    return;
  }
  homeMessage('');
  view.myId = res.id;                                   // "id" công khai của mình; trạng thái đầy đủ sẽ đến ngay sau đó
  view.code = res.code;
  saveSession({ code: res.code, name: myName });
}

// Mọi thao tác trong ván (đánh cờ, ván mới) đều dùng chung cách xử lý kết quả này
function handleActionResult(res) {
  if (res && res.ok) return;
  if (res && res.code === 'NO_ROOM') { leaveToHome(res.message); return; }
  toast((res && res.message) || 'Thao tác không thành công.');
}

// Nhận trạng thái chính thức từ máy chủ và vẽ lại
function applyState(msg) {
  const me = msg.members.find((m) => m.id === view.myId);
  if (!me) return;                                      // trạng thái không dành cho mình
  const wasResult = view.result;
  const firstTime = view.mode !== 'online';
  view.mode = 'online';
  view.connection = 'connected';
  view.board = msg.board;
  view.turn = msg.turn;
  view.result = msg.result;
  view.winLine = msg.winLine || [];
  view.lastMove = msg.lastMove;
  view.scores = msg.scores;
  view.members = msg.members;
  view.code = msg.code;
  view.status = msg.status;
  view.myRole = me.role;
  const playerX = msg.members.find((m) => m.role === 'X');
  const playerO = msg.members.find((m) => m.role === 'O');
  view.names = { X: playerX ? playerX.name : 'Đang chờ...', O: playerO ? playerO.name : 'Đang chờ...' };
  if (firstTime) showGame();
  render();
  if (view.result && !wasResult) openResult();
  if (!view.result) closeModal();
}

function leaveToHome(message) {
  forgetRoom();
  pendingAction = null;
  view = newView();
  closeModal();
  el.game.classList.add('hidden');
  el.home.classList.remove('hidden');
  homeMessage(message || '');
  if (socket) socket.disconnect();
}

// Tải lại trang giữa trận: tự vào lại phòng cũ bằng mã phòng và token đã lưu
function tryResume() {
  const saved = loadSession();
  if (!saved.code || !onlineAvailable()) return;
  myName = saved.name || loadSavedName() || 'Khách';
  el.nameInput.value = myName;
  runWhenConnected(() => emitJoin(saved.code, true));
  homeMessage('Đang vào lại phòng ' + saved.code + '...');
}

/* ---------- 8. Vẽ giao diện ---------- */
function initBoard() {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < SIZE * SIZE; i++) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.dataset.i = i;
    cell.dataset.label = 'Hàng ' + (Math.floor(i / SIZE) + 1) + ', cột ' + ((i % SIZE) + 1);
    cell.setAttribute('aria-label', cell.dataset.label);
    fragment.appendChild(cell);
  }
  el.board.appendChild(fragment);
  el.board.addEventListener('click', (event) => {
    const cell = event.target.closest('.cell');
    if (cell) onCellClick(Number(cell.dataset.i));
  });
}

function canPlayNow() {
  if (view.result) return false;
  if (view.mode === 'local') return true;
  return view.mode === 'online' && view.connection === 'connected'
    && view.status === 'playing' && view.myRole === view.turn;
}

function onCellClick(index) {
  if (view.mode === 'local') { localMove(index); return; }
  if (view.mode !== 'online') return;
  // Kiểm tra sơ bộ để báo lỗi nhanh. Máy chủ vẫn kiểm tra lại toàn bộ.
  if (view.connection !== 'connected') { toast('Đang mất kết nối, hãy chờ kết nối lại.'); return; }
  if (view.result) { toast('Ván đã kết thúc. Bấm "Ván mới" để chơi tiếp.'); return; }
  if (view.myRole === 'spectator') { toast('Bạn đang theo dõi trận đấu.'); return; }
  if (view.status === 'waiting') { toast('Đang chờ đủ 2 người chơi.'); return; }
  if (view.status === 'paused') { toast('Đối thủ đang mất kết nối. Hãy chờ họ quay lại.'); return; }
  if (view.myRole !== view.turn) { toast('Chưa tới lượt của bạn!'); return; }
  if (view.board[index]) { toast('Ô này đã có quân cờ!'); return; }
  socket.emit('game:move', { index }, handleActionResult);   // chờ máy chủ xác nhận rồi mới hiện quân cờ
}

function statusMessage() {
  if (view.result === 'draw') return 'Hòa! Bàn cờ đã đầy.';
  if (view.result) return view.names[view.result] + ' (' + view.result + ') đã thắng!';
  if (view.mode === 'online' && view.status === 'waiting') return 'Đang chờ đủ 2 người chơi. Hãy chia sẻ mã phòng.';
  if (view.mode === 'online' && view.status === 'paused') {
    const away = view.members.find((m) => m.role !== 'spectator' && !m.connected);
    return 'Tạm dừng: đang chờ ' + (away ? away.name : 'đối thủ') + ' kết nối lại...';
  }
  const turnText = 'Lượt của ' + view.names[view.turn] + ' (' + view.turn + ')';
  return view.mode === 'online' && view.myRole === view.turn ? turnText + ': tới bạn!' : turnText;
}

function render() {
  // Bàn cờ: chỉ cập nhật ô thay đổi để hiệu ứng chạy đúng một lần
  const cells = el.board.children;
  const winSet = new Set(view.winLine);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const mark = view.board[i] || '';
    if (cell.dataset.mark !== mark) {
      cell.dataset.mark = mark;
      cell.classList.toggle('x', mark === 'X');
      cell.classList.toggle('o', mark === 'O');
      cell.classList.toggle('filled', mark !== '');
      cell.classList.remove('placed');
      if (mark) cell.classList.add('placed');
      cell.setAttribute('aria-label', cell.dataset.label + (mark ? ': ' + mark : ''));
    }
    cell.classList.toggle('last', i === view.lastMove);
    cell.classList.toggle('win', winSet.has(i));
  }
  el.board.classList.toggle('locked', !canPlayNow());

  // Trạng thái, thẻ người chơi, điểm
  el.statusText.textContent = statusMessage();
  el.nameX.textContent = view.names.X;
  el.nameO.textContent = view.names.O;
  el.scoreX.textContent = view.scores.X;
  el.scoreO.textContent = view.scores.O;
  const online = view.mode === 'online';
  const playing = !view.result && (!online || view.status === 'playing');
  el.cardX.classList.toggle('active', playing && view.turn === 'X');
  el.cardO.classList.toggle('active', playing && view.turn === 'O');

  // Phần riêng của chế độ online
  const offline = online && view.connection !== 'connected';
  el.roomBox.classList.toggle('hidden', !online);
  el.memberBox.classList.toggle('hidden', !online);
  el.spectatorNote.classList.toggle('hidden', !(online && view.myRole === 'spectator'));
  el.btnRestart.classList.toggle('hidden', online && view.myRole === 'spectator');
  el.netBanner.classList.toggle('hidden', !offline);
  el.netBanner.textContent = offline ? 'Mất kết nối. Đang thử kết nối lại... Đừng đóng trang này.' : '';
  el.connBadge.textContent = !online ? 'Chơi trên một máy' : offline ? 'Mất kết nối' : 'Đã kết nối';
  el.connBadge.classList.toggle('online', online && !offline);
  el.connBadge.classList.toggle('offline', offline);
  if (online) {
    el.roomCode.textContent = view.code;
    renderMembers();
  }
}

function renderMembers() {
  el.memberCount.textContent = view.members.length;
  const items = view.members.map((member) => {
    const li = document.createElement('li');
    li.classList.toggle('off', !member.connected);
    const dot = document.createElement('span');
    dot.className = 'dot' + (member.connected ? '' : ' off');
    dot.title = member.connected ? 'Đang kết nối' : 'Mất kết nối';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = member.name + (member.id === view.myId ? ' (bạn)' : '');   // textContent: an toàn trước mã độc
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = member.role === 'spectator' ? 'Khán giả' : 'Quân ' + member.role;
    li.append(dot, name, role);
    return li;
  });
  el.memberList.replaceChildren(...items);
}

/* ---------- 9. Hộp thoại kết quả ---------- */
function openResult() {
  let title;
  let text;
  if (view.result === 'draw') {
    title = 'Hòa!';
    text = 'Bàn cờ đã đầy mà chưa ai đủ 5 quân.';
  } else if (view.mode === 'online' && view.myRole === view.result) {
    title = 'Bạn đã thắng!';
    text = 'Chúc mừng ' + view.names[view.result] + ' với 5 quân liên tiếp.';
  } else if (view.mode === 'online' && view.myRole !== 'spectator') {
    title = 'Bạn đã thua';
    text = view.names[view.result] + ' đã xếp đủ 5 quân. Chơi lại để gỡ nhé!';
  } else {
    title = view.names[view.result] + ' thắng!';
    text = 'Quân ' + view.result + ' xếp đủ 5 quân liên tiếp.';
  }
  el.modalTitle.textContent = title;
  el.modalText.textContent = text;
  el.modalRestart.classList.toggle('hidden', view.mode === 'online' && view.myRole === 'spectator');
  el.modal.classList.remove('hidden');
  el.modalRestart.focus();
}
function closeModal() { el.modal.classList.add('hidden'); }

/* ---------- 10. Chuyển màn hình và các nút ---------- */
function showGame() { el.home.classList.add('hidden'); el.game.classList.remove('hidden'); }

function restartGame() {
  if (view.mode === 'local') { localRestart(); return; }
  if (view.mode === 'online') socket.emit('game:restart', {}, handleActionResult);
}

function leaveGame() {
  if (view.mode !== 'online' || !socket || !socket.connected) { leaveToHome(''); return; }
  // Báo máy chủ để thoát ngay (không bị giữ chỗ như khi mất mạng), rồi về trang chủ
  let finished = false;
  const finish = () => { if (!finished) { finished = true; leaveToHome(''); } };
  socket.emit('room:leave', {}, finish);
  setTimeout(finish, 1500);
}

el.btnLocal.addEventListener('click', () => { homeMessage(''); prepareName(); startLocal(); });

el.btnCreate.addEventListener('click', () => {
  prepareName();
  runWhenConnected(emitCreate);
});

el.btnJoin.addEventListener('click', () => {
  const code = el.codeInput.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) { homeMessage('Mã phòng gồm 4 đến 8 chữ cái hoặc số.'); return; }
  prepareName();
  runWhenConnected(() => emitJoin(code, false));
});

el.codeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') el.btnJoin.click(); });
el.btnRestart.addEventListener('click', restartGame);
el.modalRestart.addEventListener('click', restartGame);
el.modalClose.addEventListener('click', closeModal);
el.btnLeave.addEventListener('click', leaveGame);

el.btnCopy.addEventListener('click', async () => {
  const link = location.origin + location.pathname + '?room=' + view.code;
  try {
    await navigator.clipboard.writeText(link);
    toast('Đã sao chép đường dẫn phòng. Gửi cho bạn bè nhé!');
  } catch (error) {
    toast('Không sao chép được. Mã phòng: ' + view.code);
  }
});

/* ---------- 11. Khởi động ---------- */
initBoard();
el.nameInput.value = loadSavedName();
const roomFromLink = new URLSearchParams(location.search).get('room');   // mở từ đường dẫn mời bạn bè
if (roomFromLink) el.codeInput.value = roomFromLink.toUpperCase().slice(0, 8);
if (!onlineAvailable()) {
  el.btnCreate.disabled = true;
  el.btnJoin.disabled = true;
  el.onlineNote.classList.remove('hidden');
}
render();
tryResume();
