const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode-terminal');
const os = require('os');

const PORT = process.env.PORT || 3000;
const ROUND_SECONDS = 5 * 60;
const MIN_TEAMS = 2;
const MAX_TEAMS = 8;
const COLOR_PALETTE = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#34495e'
];

// お題バンク(進行役がロビーで追加・削除・選択できる)。サーバープロセス起動中のみ保持されるメモリ上の状態。
let questionBank = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'questions.json'), 'utf-8')
);
let nextQuestionId = Math.max(0, ...questionBank.map((q) => q.id)) + 1;
let selectedQuestionIds = new Set(questionBank.map((q) => q.id));
let gameQuestions = []; // host:start時点で選択されていたお題を、そのゲーム終了まで確定させたもの

function defaultTeamName(i) {
  return `チーム${String.fromCharCode(65 + i)}`; // A, B, C, ...
}

// チーム数・チーム名はラウンドをまたいで保持する設定値(ロビー中のみ変更可)
let config = {
  teamCount: 3,
  teamNames: [defaultTeamName(0), defaultTeamName(1), defaultTeamName(2)]
};

function buildTeams() {
  const teams = [];
  for (let i = 0; i < config.teamCount; i++) {
    teams.push({
      id: `t${i}`,
      name: config.teamNames[i] || defaultTeamName(i),
      color: COLOR_PALETTE[i % COLOR_PALETTE.length],
      players: [],
      answer: null,
      submitted: false,
      score: 0
    });
  }
  return teams;
}

let state = freshState();
let players = {}; // socketId -> { name, teamId }
let timerHandle = null;

function freshState() {
  return {
    phase: 'lobby', // lobby -> discussing -> locked -> revealed -> (discussing...) -> finished
    roundIndex: -1,
    totalRounds: 0, // host:start時に選択済みお題数で確定する
    currentQuestion: null,
    timer: { duration: ROUND_SECONDS, remaining: ROUND_SECONDS },
    teams: buildTeams(),
    history: [],
    lastResult: null
  };
}

function getTeam(teamId) {
  return state.teams.find((t) => t.id === teamId);
}

// 開示前は回答の中身を隠し、提出済みかどうかだけを見せる(せーの開示の緊張感を保つため)
function publicState() {
  const reveal = state.phase === 'revealed' || state.phase === 'finished';
  const teams = state.teams.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    players: t.players.map((p) => p.name),
    submitted: t.submitted,
    score: t.score,
    answer: reveal ? t.answer : null
  }));
  return {
    phase: state.phase,
    roundIndex: state.roundIndex,
    totalRounds: state.totalRounds,
    currentQuestion: state.currentQuestion,
    timer: state.timer,
    teams,
    history: state.history,
    lastResult: state.lastResult,
    config: { teamCount: config.teamCount, teamNames: state.teams.map((t) => t.name) },
    questionBank: questionBank.map((q) => ({ ...q, selected: selectedQuestionIds.has(q.id) }))
  };
}

function broadcast() {
  io.emit('state', publicState());
}

function assignTeam() {
  let best = state.teams[0];
  for (const t of state.teams) {
    if (t.players.length < best.players.length) best = t;
  }
  return best.id;
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
  if (state.teams.every((t) => t.submitted)) {
    lockRound();
  }
}

function beginRound(index) {
  state.roundIndex = index;
  state.currentQuestion = gameQuestions[index];
  state.phase = 'discussing';
  state.lastResult = null;
  for (const t of state.teams) {
    t.answer = null;
    t.submitted = false;
  }
  startRoundTimer();
  broadcast();
}

// 全チームの回答の平均値に最も近いチームが勝利。
// チーム数が3のときはこれは「中央値のチームが勝利」と数学的に同じ結果になるが
// (平均は最小値と最大値の間に収まり、中央値は他の2値より必ず平均に近いため)、
// チーム数を可変にしても破綻しないよう常に平均最近傍方式で判定する。
function revealRound() {
  clearTimer();
  const entries = state.teams.map((t) => ({
    id: t.id,
    value: t.answer === null ? 0 : t.answer
  }));
  const mean = entries.reduce((sum, e) => sum + e.value, 0) / entries.length;
  const minDeviation = Math.min(...entries.map((e) => Math.abs(e.value - mean)));
  const winners = entries
    .filter((e) => Math.abs(e.value - mean) === minDeviation)
    .map((e) => e.id);

  for (const id of winners) {
    getTeam(id).score += 1;
  }

  const answers = {};
  for (const t of state.teams) answers[t.id] = t.answer;

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

// 現在参加中の全プレイヤーを、新しいチーム構成に均等に振り直す
function reassignAllPlayers() {
  const allPlayers = Object.entries(players).map(([socketId, p]) => ({ socketId, name: p.name }));
  for (const t of state.teams) t.players = [];
  for (const p of allPlayers) {
    const teamId = assignTeam();
    players[p.socketId] = { name: p.name, teamId };
    getTeam(teamId).players.push({ socketId: p.socketId, name: p.name });
    io.to(p.socketId).emit('player:assigned', { teamId, teamName: getTeam(teamId).name });
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
    getTeam(teamId).players.push({ socketId: socket.id, name: trimmed });
    socket.join(`team:${teamId}`);
    socket.emit('player:assigned', { teamId, teamName: getTeam(teamId).name });
    broadcast();
  });

  socket.on('player:submit', ({ value }) => {
    const player = players[socket.id];
    if (!player) return;
    if (state.phase !== 'discussing') return;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) return;
    const team = getTeam(player.teamId);
    team.answer = num;
    team.submitted = true;
    broadcast();
    maybeAutoLock();
  });

  socket.on('host:setTeamCount', ({ count }) => {
    if (state.phase !== 'lobby') return;
    const n = Math.round(Number(count));
    if (!Number.isFinite(n) || n < MIN_TEAMS || n > MAX_TEAMS) return;
    const oldNames = state.teams.map((t) => t.name);
    config.teamCount = n;
    config.teamNames = Array.from({ length: n }, (_, i) => oldNames[i] || defaultTeamName(i));
    state.teams = buildTeams();
    reassignAllPlayers();
    broadcast();
  });

  socket.on('host:setTeamName', ({ teamId, name }) => {
    if (state.phase !== 'lobby') return;
    const trimmed = (name || '').trim().slice(0, 20);
    if (!trimmed) return;
    const team = getTeam(teamId);
    if (!team) return;
    team.name = trimmed;
    const idx = state.teams.indexOf(team);
    config.teamNames[idx] = trimmed;
    broadcast();
  });

  socket.on('host:addQuestion', ({ text, unit }) => {
    if (state.phase !== 'lobby') return;
    const trimmedText = (text || '').trim().slice(0, 200);
    if (!trimmedText) return;
    const trimmedUnit = (unit || '').trim().slice(0, 20);
    const q = { id: nextQuestionId++, text: trimmedText, unit: trimmedUnit };
    questionBank.push(q);
    selectedQuestionIds.add(q.id);
    broadcast();
  });

  socket.on('host:deleteQuestion', ({ id }) => {
    if (state.phase !== 'lobby') return;
    questionBank = questionBank.filter((q) => q.id !== id);
    selectedQuestionIds.delete(id);
    broadcast();
  });

  socket.on('host:toggleQuestion', ({ id, selected }) => {
    if (state.phase !== 'lobby') return;
    if (selected) selectedQuestionIds.add(id);
    else selectedQuestionIds.delete(id);
    broadcast();
  });

  socket.on('host:start', () => {
    if (state.phase !== 'lobby') return;
    gameQuestions = questionBank.filter((q) => selectedQuestionIds.has(q.id));
    if (gameQuestions.length === 0) return;
    state.totalRounds = gameQuestions.length;
    beginRound(0);
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
    const team = getTeam(player.teamId);
    if (team) team.players = team.players.filter((p) => p.socketId !== socket.id);
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
