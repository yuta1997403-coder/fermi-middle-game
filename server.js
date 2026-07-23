const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode-terminal');
const os = require('os');

const PORT = process.env.PORT || 3000;
const ROUND_SECONDS = 5 * 60;

const questions = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'questions.json'), 'utf-8')
);

const TEAM_META = {
  A: { name: 'チームA', color: '#e74c3c' },
  B: { name: 'チームB', color: '#3498db' },
  C: { name: 'チームC', color: '#2ecc71' }
};
const TEAM_IDS = ['A', 'B', 'C'];

let state = freshState();
let players = {}; // socketId -> { name, teamId }
let timerHandle = null;

function freshState() {
  const teams = {};
  for (const id of TEAM_IDS) {
    teams[id] = {
      id,
      name: TEAM_META[id].name,
      color: TEAM_META[id].color,
      players: [],
      answer: null,
      submitted: false,
      score: 0
    };
  }
  return {
    phase: 'lobby', // lobby -> discussing -> locked -> revealed -> (discussing...) -> finished
    roundIndex: -1,
    totalRounds: questions.length,
    currentQuestion: null,
    timer: { duration: ROUND_SECONDS, remaining: ROUND_SECONDS },
    teams,
    history: [],
    lastResult: null
  };
}

// 開示前は回答の中身を隠し、提出済みかどうかだけを見せる(せーの開示の緊張感を保つため)
function publicState() {
  const reveal = state.phase === 'revealed' || state.phase === 'finished';
  const teams = {};
  for (const id of TEAM_IDS) {
    const t = state.teams[id];
    teams[id] = {
      id: t.id,
      name: t.name,
      color: t.color,
      players: t.players.map((p) => p.name),
      submitted: t.submitted,
      score: t.score,
      answer: reveal ? t.answer : null
    };
  }
  return {
    phase: state.phase,
    roundIndex: state.roundIndex,
    totalRounds: state.totalRounds,
    currentQuestion: state.currentQuestion,
    timer: state.timer,
    teams,
    history: state.history,
    lastResult: state.lastResult
  };
}

function broadcast() {
  io.emit('state', publicState());
}

function assignTeam() {
  let best = TEAM_IDS[0];
  for (const id of TEAM_IDS) {
    if (state.teams[id].players.length < state.teams[best].players.length) {
      best = id;
    }
  }
  return best;
}

function clearTimer() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

function startRoundTimer() {
  clearTimer();
  state.timer = { duration: ROUND_SECONDS, remaining: ROUND_SECONDS };
  timerHandle = setInterval(() => {
    state.timer.remaining -= 1;
    if (state.timer.remaining <= 0) {
      lockRound();
    } else {
      broadcast();
    }
  }, 1000);
}

function lockRound() {
  clearTimer();
  state.phase = 'locked';
  broadcast();
}

function maybeAutoLock() {
  if (TEAM_IDS.every((id) => state.teams[id].submitted)) {
    lockRound();
  }
}

function beginRound(index) {
  state.roundIndex = index;
  state.currentQuestion = questions[index];
  state.phase = 'discussing';
  state.lastResult = null;
  for (const id of TEAM_IDS) {
    state.teams[id].answer = null;
    state.teams[id].submitted = false;
  }
  startRoundTimer();
  broadcast();
}

function revealRound() {
  clearTimer();
  const entries = TEAM_IDS.map((id) => ({
    id,
    value: state.teams[id].answer === null ? 0 : state.teams[id].answer
  })).sort((a, b) => a.value - b.value);

  // 中央値(=3チームの場合は必ず平均値に最も近い値)のチームが勝者。
  // 同値タイの場合は、中央値と同じ値を出した全チームを勝者として扱う。
  const medianValue = entries[1].value;
  const winners = entries.filter((e) => e.value === medianValue).map((e) => e.id);

  for (const id of winners) {
    state.teams[id].score += 1;
  }

  const answers = {};
  for (const id of TEAM_IDS) answers[id] = state.teams[id].answer;

  const result = {
    round: state.roundIndex,
    question: state.currentQuestion,
    answers,
    winners
  };
  state.history.push(result);
  state.lastResult = result;
  state.phase = 'revealed';
  broadcast();
}

function nextOrFinish() {
  const next = state.roundIndex + 1;
  if (next >= state.totalRounds) {
    state.phase = 'finished';
    broadcast();
  } else {
    beginRound(next);
  }
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
  socket.emit('state', publicState());

  socket.on('player:join', ({ name }) => {
    const trimmed = (name || '').trim().slice(0, 20) || '名無し';
    const teamId = assignTeam();
    players[socket.id] = { name: trimmed, teamId };
    state.teams[teamId].players.push({ socketId: socket.id, name: trimmed });
    socket.join(`team:${teamId}`);
    socket.emit('player:assigned', { teamId, teamName: TEAM_META[teamId].name });
    broadcast();
  });

  socket.on('player:submit', ({ value }) => {
    const player = players[socket.id];
    if (!player) return;
    if (state.phase !== 'discussing') return;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return;
    const team = state.teams[player.teamId];
    team.answer = num;
    team.submitted = true;
    broadcast();
    maybeAutoLock();
  });

  socket.on('host:start', () => {
    if (state.phase === 'lobby') {
      beginRound(0);
    }
  });

  socket.on('host:lockNow', () => {
    if (state.phase === 'discussing') lockRound();
  });

  socket.on('host:reveal', () => {
    if (state.phase === 'locked') revealRound();
  });

  socket.on('host:next', () => {
    if (state.phase === 'revealed') nextOrFinish();
  });

  socket.on('host:reset', () => {
    clearTimer();
    state = freshState();
    players = {};
    io.emit('game:reset');
    broadcast();
  });

  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (!player) return;
    const team = state.teams[player.teamId];
    team.players = team.players.filter((p) => p.socketId !== socket.id);
    delete players[socket.id];
    broadcast();
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log(`フェルミ推定ミドルゲーム サーバー起動 (port ${PORT})`);

  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (publicUrl) {
    console.log(`進行役の画面: ${publicUrl}/host.html`);
    console.log(`参加者用URL: ${publicUrl}/team.html`);
    qrcode.generate(`${publicUrl}/team.html`, { small: true });
    console.log('');
    return;
  }

  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  console.log('進行役の画面(共有ディスプレイ用):');
  console.log(`  http://localhost:${PORT}/host.html`);
  addresses.forEach((addr) => {
    const teamUrl = `http://${addr}:${PORT}/team.html`;
    console.log('');
    console.log(`同じWi-Fi内の参加者はこちらにアクセス: ${teamUrl}`);
    qrcode.generate(teamUrl, { small: true });
  });
  console.log('');
});
