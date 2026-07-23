const socket = io();
const mainPanel = document.getElementById('mainPanel');
const roundLabel = document.getElementById('roundLabel');

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.max(sec, 0) % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function teamCard(team, options = {}) {
  const isWinner = options.winners && options.winners.includes(team.id);
  const showAnswer = options.showAnswer;
  return `
    <div class="team-card ${isWinner ? 'winner' : ''}" style="--team-color:${team.color}">
      <h3>${team.name} ${isWinner ? '<span class="badge">勝利</span>' : ''}</h3>
      <div class="muted">${team.players.length > 0 ? team.players.join(', ') : '(まだ誰もいません)'}</div>
      <div class="score">${team.score} pt</div>
      ${showAnswer
        ? `<div class="answer-value">${team.answer === null ? '(未回答)' : team.answer}</div>`
        : `<div class="status ${team.submitted ? 'ok' : 'wait'}">${team.submitted ? '✔ 提出済み' : '… 検討中'}</div>`}
    </div>
  `;
}

function render(state) {
  roundLabel.textContent = state.phase === 'finished'
    ? 'ゲーム終了'
    : state.roundIndex >= 0
      ? `第${state.roundIndex + 1}問 / 全${state.totalRounds}問`
      : '準備中';

  if (state.phase === 'lobby') {
    mainPanel.innerHTML = `
      <p>各チームはスマホで参加用URLにアクセスしてください(サーバー起動時にターミナルへ表示されたQRコード/URL)。</p>
      <div class="teams-grid">
        ${Object.values(state.teams).map((t) => teamCard(t)).join('')}
      </div>
      <div style="margin-top:24px">
        <button id="startBtn">ゲーム開始</button>
      </div>
    `;
    document.getElementById('startBtn').onclick = () => socket.emit('host:start');
    return;
  }

  if (state.phase === 'discussing' || state.phase === 'locked') {
    const warn = state.timer.remaining <= 30;
    mainPanel.innerHTML = `
      <div class="question">${state.currentQuestion.text}</div>
      <div class="timer ${warn ? 'warn' : ''}">${formatTime(state.timer.remaining)}</div>
      <div class="teams-grid">
        ${Object.values(state.teams).map((t) => teamCard(t)).join('')}
      </div>
      <div style="margin-top:24px">
        ${state.phase === 'discussing'
          ? `<button id="lockBtn" class="secondary">今すぐ締め切る</button>`
          : `<button id="revealBtn">せーので開示する</button>`}
      </div>
    `;
    if (state.phase === 'discussing') {
      document.getElementById('lockBtn').onclick = () => socket.emit('host:lockNow');
    } else {
      document.getElementById('revealBtn').onclick = () => socket.emit('host:reveal');
    }
    return;
  }

  if (state.phase === 'revealed') {
    const r = state.lastResult;
    mainPanel.innerHTML = `
      <div class="question">${r.question.text}</div>
      <div class="teams-grid">
        ${Object.values(state.teams).map((t) => teamCard(t, { winners: r.winners, showAnswer: true })).join('')}
      </div>
      <p class="center muted">中央値(=平均に一番近い値)を出したチームの勝利。単位:${r.question.unit}</p>
      <div style="margin-top:24px">
        <button id="nextBtn">${state.roundIndex + 1 >= state.totalRounds ? '最終結果へ' : '次の問題へ'}</button>
      </div>
    `;
    document.getElementById('nextBtn').onclick = () => socket.emit('host:next');
    return;
  }

  if (state.phase === 'finished') {
    const ranked = Object.values(state.teams).sort((a, b) => b.score - a.score);
    const topScore = ranked[0].score;
    mainPanel.innerHTML = `
      <h2 class="center">最終結果</h2>
      <div class="teams-grid">
        ${ranked.map((t) => teamCard(t, { winners: t.score === topScore ? [t.id] : [] })).join('')}
      </div>
      <div style="margin-top:24px">
        <button id="resetBtn" class="secondary">もう一度遊ぶ(リセット)</button>
      </div>
    `;
    document.getElementById('resetBtn').onclick = () => {
      if (confirm('スコアと参加者をリセットして最初からやり直します。よろしいですか?')) {
        socket.emit('host:reset');
      }
    };
    return;
  }
}

socket.on('state', render);
