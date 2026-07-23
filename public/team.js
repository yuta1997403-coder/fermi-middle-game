const socket = io();
const mainPanel = document.getElementById('mainPanel');

let myTeamId = null;
let myTeamName = null;
let latestState = null;
let lastRenderKey = null;

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.max(sec, 0) % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function renderJoin() {
  mainPanel.innerHTML = `
    <p>チーム名を選ばず、あなたの名前だけ入力してください。人数が少ないチームに自動で割り振られます。</p>
    <input type="text" id="nameInput" placeholder="名前(ニックネーム可)" maxlength="20" />
    <button id="joinBtn">参加する</button>
  `;
  document.getElementById('joinBtn').onclick = () => {
    const name = document.getElementById('nameInput').value;
    socket.emit('player:join', { name });
  };
}

function render(state) {
  latestState = state;
  if (!myTeamId) {
    renderJoin();
    return;
  }

  const myTeam = state.teams.find((t) => t.id === myTeamId);
  if (!myTeam) return; // チーム再編成の直後、player:assignedの反映待ちで一瞬起こりうる
  const key = `${state.phase}:${state.roundIndex}`;

  // discussingフェーズはタイマー更新のため毎秒stateが飛んでくる。
  // 同じラウンドの間はinnerHTMLを丸ごと作り直さず部分更新にとどめ、
  // 入力欄の文字やフォーカスが毎秒消えてしまうのを防ぐ。
  if (state.phase === 'discussing' && lastRenderKey === key) {
    const timerEl = document.getElementById('timerDisplay');
    if (timerEl) {
      timerEl.textContent = formatTime(state.timer.remaining);
      timerEl.classList.toggle('warn', state.timer.remaining <= 30);
    }
    const statusEl = document.getElementById('submitStatus');
    if (statusEl) {
      statusEl.textContent = myTeam.submitted ? '✔ 提出済み(締切まで何度でも変更できます)' : 'まだ未提出です';
      statusEl.classList.toggle('ok', myTeam.submitted);
      statusEl.classList.toggle('wait', !myTeam.submitted);
    }
    return;
  }
  lastRenderKey = key;

  if (state.phase === 'lobby') {
    mainPanel.innerHTML = `
      <p>あなたは <strong style="color:${myTeam.color}">${myTeam.name}</strong> です。</p>
      <p class="muted">進行役がゲームを開始するまでお待ちください。</p>
      <p class="muted">同じチームのメンバー: ${myTeam.players.join(', ')}</p>
    `;
    return;
  }

  if (state.phase === 'discussing') {
    mainPanel.innerHTML = `
      <p><strong style="color:${myTeam.color}">${myTeam.name}</strong> として回答します</p>
      <div class="question">${state.currentQuestion.text}</div>
      <div id="timerDisplay" class="timer ${state.timer.remaining <= 30 ? 'warn' : ''}">${formatTime(state.timer.remaining)}</div>
      <input type="number" id="answerInput" placeholder="推定値を入力(単位:${state.currentQuestion.unit})" />
      <button id="submitBtn">チームの回答として送信</button>
      <p id="submitStatus" class="center ${myTeam.submitted ? 'status ok' : 'status wait'}">${myTeam.submitted ? '✔ 提出済み(締切まで何度でも変更できます)' : 'まだ未提出です'}</p>
    `;
    document.getElementById('submitBtn').onclick = () => {
      const value = document.getElementById('answerInput').value;
      if (value === '') return;
      socket.emit('player:submit', { value });
    };
    return;
  }

  if (state.phase === 'locked') {
    mainPanel.innerHTML = `
      <p><strong style="color:${myTeam.color}">${myTeam.name}</strong></p>
      <p class="center">回答受付終了。進行役が開示するまでお待ちください。</p>
    `;
    return;
  }

  if (state.phase === 'revealed') {
    const r = state.lastResult;
    const won = r.winners.includes(myTeamId);
    mainPanel.innerHTML = `
      <div class="question">${r.question.text}</div>
      <div class="teams-grid">
        ${Object.values(state.teams).map((t) => `
          <div class="team-card ${r.winners.includes(t.id) ? 'winner' : ''}" style="--team-color:${t.color}">
            <h3>${t.name} ${r.winners.includes(t.id) ? '<span class="badge">勝利</span>' : ''}</h3>
            <div class="answer-value">${t.answer === null ? '(未回答)' : t.answer}</div>
            <div class="score">${t.score} pt</div>
          </div>
        `).join('')}
      </div>
      <p class="center" style="font-size:20px;font-weight:700">${won ? 'このラウンドは勝利しました!' : '次のラウンドに期待しましょう'}</p>
    `;
    return;
  }

  if (state.phase === 'finished') {
    const ranked = Object.values(state.teams).sort((a, b) => b.score - a.score);
    mainPanel.innerHTML = `
      <h2 class="center">ゲーム終了</h2>
      <div class="teams-grid">
        ${ranked.map((t, i) => `
          <div class="team-card ${i === 0 ? 'winner' : ''}" style="--team-color:${t.color}">
            <h3>${t.name}</h3>
            <div class="score">${t.score} pt</div>
          </div>
        `).join('')}
      </div>
    `;
    return;
  }
}

socket.on('player:assigned', ({ teamId, teamName }) => {
  myTeamId = teamId;
  myTeamName = teamName;
  if (latestState) render(latestState);
});

socket.on('game:reset', () => {
  myTeamId = null;
  myTeamName = null;
  if (latestState) render(latestState);
});

socket.on('state', render);
