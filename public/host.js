const socket = io();
const mainPanel = document.getElementById('mainPanel');
const roundLabel = document.getElementById('roundLabel');
let lastLobbyKey = null;
let latestState = null;
let joinInfo = null;

fetch('/api/join-info')
  .then((r) => r.json())
  .then((info) => {
    joinInfo = info;
    lastLobbyKey = null; // 取得完了後にロビー画面を再描画させる
    if (latestState) render(latestState);
  })
  .catch(() => {});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.max(sec, 0) % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function teamCard(team, options = {}) {
  const isWinner = options.winners && options.winners.includes(team.id);
  const showAnswer = options.showAnswer;
  const roster = team.players.length > 0 ? team.players.map(escapeHtml).join(', ') : '(まだ誰もいません)';
  return `
    <div class="team-card ${isWinner ? 'winner' : ''}" style="--team-color:${team.color}">
      <h3>${escapeHtml(team.name)} ${isWinner ? '<span class="badge">勝利</span>' : ''}</h3>
      <div class="muted">${roster}</div>
      <div class="score">${team.score} pt</div>
      ${showAnswer
        ? `<div class="answer-value">${team.answer === null ? '(未回答)' : team.answer}</div>`
        : `<div class="status ${team.submitted ? 'ok' : 'wait'}">${team.submitted ? '✔ 提出済み' : '… 検討中'}</div>`}
    </div>
  `;
}

function questionBankPanel(state) {
  const selectedCount = state.questionBank.filter((q) => q.selected).length;
  return `
    <div class="panel" style="margin-top:16px">
      <h3 style="margin-top:0">お題(全${state.questionBank.length}問中 ${selectedCount}問を選択中)</h3>
      <div style="max-height:280px;overflow-y:auto">
        ${state.questionBank.map((q) => `
          <label style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #333955;cursor:pointer">
            <input type="checkbox" class="question-toggle" data-qid="${q.id}" ${q.selected ? 'checked' : ''} style="width:auto" />
            <span style="flex:1">${escapeHtml(q.text)} <span class="muted">(${escapeHtml(q.unit)})</span></span>
            <button class="secondary question-delete" data-qid="${q.id}" style="width:auto;padding:6px 12px;font-size:14px">削除</button>
          </label>
        `).join('')}
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start">
        <input type="text" id="newQuestionText" placeholder="新しいお題の文章" style="flex:2;min-width:200px;margin-bottom:0" />
        <input type="text" id="newQuestionUnit" placeholder="単位(例: 個)" style="flex:1;min-width:100px;margin-bottom:0" />
        <button id="addQuestionBtn" style="width:auto;padding:12px 20px;white-space:nowrap">お題を追加</button>
      </div>
    </div>
  `;
}

function bindQuestionBankEvents() {
  mainPanel.querySelectorAll('.question-toggle').forEach((el) => {
    el.onchange = () => {
      socket.emit('host:toggleQuestion', { id: Number(el.dataset.qid), selected: el.checked });
    };
  });
  mainPanel.querySelectorAll('.question-delete').forEach((el) => {
    el.onclick = () => {
      socket.emit('host:deleteQuestion', { id: Number(el.dataset.qid) });
    };
  });
  document.getElementById('addQuestionBtn').onclick = () => {
    const text = document.getElementById('newQuestionText').value;
    const unit = document.getElementById('newQuestionUnit').value;
    if (!text.trim()) return;
    socket.emit('host:addQuestion', { text, unit });
    document.getElementById('newQuestionText').value = '';
    document.getElementById('newQuestionUnit').value = '';
  };
}

function joinInfoPanel() {
  if (!joinInfo) {
    return `<div class="panel center muted" style="margin-bottom:16px">参加用URLを読み込み中…</div>`;
  }
  return `
    <div class="panel" style="margin-bottom:16px">
      <p class="muted" style="margin:0 0 8px">参加者はこのURLにスマホでアクセスしてください:</p>
      <p class="center" style="word-break:break-all">
        <a href="${joinInfo.teamUrl}" target="_blank" style="color:var(--accent);font-weight:700">${escapeHtml(joinInfo.teamUrl)}</a>
      </p>
      <div class="center"><img src="${joinInfo.qrDataUrl}" alt="参加用QRコード" width="200" height="200" /></div>
      <button id="copyUrlBtn" class="secondary" style="margin-top:12px">URLをコピー</button>
    </div>
  `;
}

function bindJoinInfoEvents() {
  const btn = document.getElementById('copyUrlBtn');
  if (!btn || !joinInfo) return;
  btn.onclick = () => {
    navigator.clipboard.writeText(joinInfo.teamUrl).then(() => {
      btn.textContent = 'コピーしました!';
      setTimeout(() => { btn.textContent = 'URLをコピー'; }, 1500);
    });
  };
}

function render(state) {
  latestState = state;
  roundLabel.textContent = state.phase === 'finished'
    ? 'ゲーム終了'
    : state.roundIndex >= 0
      ? `第${state.roundIndex + 1}問 / 全${state.totalRounds}問`
      : '準備中';

  if (state.phase === 'lobby') {
    const lobbyKey = JSON.stringify({
      count: state.config.teamCount,
      names: state.config.teamNames,
      bank: state.questionBank
    });

    if (lastLobbyKey === lobbyKey) {
      // チーム構成・お題バンクが変わっていなければ、参加者名簿だけ差し替えて
      // 入力中かもしれないテキスト欄(チーム名・新規お題)には触れない
      state.teams.forEach((t) => {
        const el = document.getElementById(`roster-${t.id}`);
        if (el) el.textContent = t.players.length > 0 ? t.players.join(', ') : '(まだ誰もいません)';
      });
      return;
    }
    lastLobbyKey = lobbyKey;

    const selectedCount = state.questionBank.filter((q) => q.selected).length;

    mainPanel.innerHTML = `
      ${joinInfoPanel()}
      <div>
        <label>チーム数(2〜8):
          <input type="number" id="teamCountInput" min="2" max="8" value="${state.config.teamCount}" style="width:70px;display:inline-block" />
        </label>
        <button id="applyCountBtn" class="secondary" style="width:auto;display:inline-block;margin-left:8px;padding:8px 16px">チーム数を適用</button>
      </div>
      <div class="teams-grid" style="margin-top:16px">
        ${state.teams.map((t) => `
          <div class="team-card" style="--team-color:${t.color}">
            <input type="text" class="team-name-input" data-team-id="${t.id}" value="${escapeHtml(t.name)}" maxlength="20" />
            <div class="muted" id="roster-${t.id}">${t.players.length > 0 ? t.players.map(escapeHtml).join(', ') : '(まだ誰もいません)'}</div>
          </div>
        `).join('')}
      </div>
      ${questionBankPanel(state)}
      <div style="margin-top:24px">
        <button id="startBtn" ${selectedCount === 0 ? 'disabled' : ''}>${selectedCount === 0 ? 'お題を1問以上選択してください' : 'ゲーム開始'}</button>
      </div>
    `;
    document.getElementById('applyCountBtn').onclick = () => {
      const count = document.getElementById('teamCountInput').value;
      socket.emit('host:setTeamCount', { count });
    };
    mainPanel.querySelectorAll('.team-name-input').forEach((input) => {
      input.onchange = () => {
        socket.emit('host:setTeamName', { teamId: input.dataset.teamId, name: input.value });
      };
    });
    bindQuestionBankEvents();
    bindJoinInfoEvents();
    const startBtn = document.getElementById('startBtn');
    if (!startBtn.disabled) startBtn.onclick = () => socket.emit('host:start');
    return;
  }
  lastLobbyKey = null;

  if (state.phase === 'discussing' || state.phase === 'locked') {
    const warn = state.timer.remaining <= 30;
    mainPanel.innerHTML = `
      <div class="question">${escapeHtml(state.currentQuestion.text)}</div>
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
      <div class="question">${escapeHtml(r.question.text)}</div>
      <div class="teams-grid">
        ${Object.values(state.teams).map((t) => teamCard(t, { winners: r.winners, showAnswer: true })).join('')}
      </div>
      <p class="center muted">全チームの回答の平均値に最も近いチームの勝利。単位:${escapeHtml(r.question.unit)}</p>
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
