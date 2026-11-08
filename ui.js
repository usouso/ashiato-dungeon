/*
 * ui.js — 画面側。sim.js が返すイベントを再生するだけで、ルールは持たない。
 *
 * クエリ引数:
 *   ?auto=1  自動プレイ（周期を読むボット）。最初から無音
 *   ?mute=1  最初から無音
 *   ?bg=1    タイマー（setInterval）で進める。裏タブでも止まらない
 *   ?seed=N  乱数の種を固定（やり直しても同じ種）
 */
(function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  const AUTO = qs.get('auto') === '1';
  const MUTE = qs.get('mute') === '1';
  const BG = qs.get('bg') === '1';
  const SEED_PARAM = qs.get('seed');
  const FIXED_SEED = SEED_PARAM !== null && SEED_PARAM !== '' && !isNaN(Number(SEED_PARAM));
  const AUTO_INTERVAL = 220;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  // ------------------------------------------------------------
  // 設定（音量・揺れ）。localStorage に保存。?mute / ?auto は保存しない
  // ------------------------------------------------------------
  const SETTINGS_KEY = 'ashiato.settings.v1';
  const ZUKAN_KEY = 'ashiato.zukan.v1';
  const settings = { volume: 0.3, shake: 'weak' };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved) { if (typeof saved.volume === 'number') settings.volume = saved.volume; if (saved.shake) settings.shake = saved.shake; }
  } catch (e) { /* 無視 */ }
  if (AUTO || MUTE) settings.volume = 0;
  function saveSettings() {
    if (AUTO || MUTE) return;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* 無視 */ }
  }
  let zukan = [];
  try { zukan = JSON.parse(localStorage.getItem(ZUKAN_KEY) || '[]') || []; } catch (e) { zukan = []; }
  function saveZukan() { try { localStorage.setItem(ZUKAN_KEY, JSON.stringify(zukan)); } catch (e) { /* 無視 */ } }

  // ------------------------------------------------------------
  // 音（Web Audio の合成音、2つだけ）
  // ------------------------------------------------------------
  const Sfx = (function () {
    let ctx = null, master = null;
    function ensure() {
      if (ctx) return true;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = settings.volume;
      master.connect(ctx.destination);
      return true;
    }
    function unlock() { if (ensure() && ctx.state === 'suspended') ctx.resume(); }
    function setVolume(v) { if (master) master.gain.value = v; }
    function tone(type, f0, f1, t0, dur, peak) {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t0);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);      // アタック強め
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);        // 残響ほどほど
      o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.02);
    }
    // 周期が迫る音：短い2音の上がり
    function approach() {
      if (settings.volume <= 0 || !ensure() || ctx.state !== 'running') return;
      const t = ctx.currentTime;
      tone('sine', 520, 520, t, 0.07, 0.5);
      tone('sine', 780, 780, t + 0.09, 0.09, 0.5);
    }
    // 発動音：低い打音＋高めの一撃。自分は高め、敵は低め
    function fire(who) {
      if (settings.volume <= 0 || !ensure() || ctx.state !== 'running') return;
      const t = ctx.currentTime;
      const base = who === 'enemy' ? 90 : 140;
      tone('triangle', base * 2.2, base, t, 0.18, 0.9);
      tone('square', base * 6, base * 3, t, 0.08, 0.25);
    }
    return { unlock, setVolume, approach, fire };
  })();

  // ------------------------------------------------------------
  // 状態
  // ------------------------------------------------------------
  let seed = FIXED_SEED ? (Number(SEED_PARAM) | 0) : ((Date.now() % 1000000) | 0);
  let S = Sim.newGame(seed);
  let logLines = [];
  const entEls = new Map();   // id → 要素
  let tileEls = [];           // [y][x]
  let mapEl, mapWrap;
  let autoTimer = null, autoRaf = null, autoLast = 0, autoPaused = false, autoEndTimer = null;
  const botRng = Bots.mulberry(seed * 31 + 7);

  function newGame(nextSeed) {
    seed = nextSeed;
    S = Sim.newGame(seed);
    logLines = [];
    entEls.forEach((e) => e.remove());
    entEls.clear();
    $('notice').classList.add('hidden');
    pushLog('フロア1。宝箱の中身と階段は見えている。敵の頭上の数字は発動までの残り歩数。', 'strong');
    buildMap();
    renderAll();
  }

  // ------------------------------------------------------------
  // 地図の組み立て
  // ------------------------------------------------------------
  // マスの大きさ：最小32px（頭上の残り歩数 13px と敵の文字が重ならない下限）。収まらない狭い画面では地図を横にスクロールする
  const TILE_MIN = 32, TILE_MAX = 44;
  function tileSize() {
    const avail = mapWrap.clientWidth - 12;
    return Math.max(TILE_MIN, Math.min(TILE_MAX, Math.floor(avail / Sim.W)));
  }
  function scrollToPlayer() {
    if (mapEl.offsetWidth <= mapWrap.clientWidth) return;
    const ts = tileSize();
    const target = (S.player.x + 0.5) * ts - mapWrap.clientWidth / 2;
    mapWrap.scrollLeft = Math.max(0, Math.min(mapEl.offsetWidth - mapWrap.clientWidth, target));
  }
  function buildMap() {
    mapEl.innerHTML = '';
    tileEls = [];
    for (let y = 0; y < Sim.H; y++) {
      const row = [];
      for (let x = 0; x < Sim.W; x++) {
        const t = el('div', 'tile ' + (S.map[y][x] === '#' ? 'wall' : 'floor'));
        mapEl.appendChild(t);
        row.push(t);
      }
      tileEls.push(row);
    }
    entEls.forEach((e) => e.remove());
    entEls.clear();
    applyTileSize();
  }
  function applyTileSize() {
    const ts = tileSize();
    mapEl.style.setProperty('--tile', ts + 'px');
    entEls.forEach((e, id) => place(e, Number(e.dataset.x), Number(e.dataset.y)));
  }
  function place(e, x, y) {
    const ts = tileSize();
    e.dataset.x = x; e.dataset.y = y;
    e.style.transform = 'translate(' + (x * ts) + 'px,' + (y * ts) + 'px)';
  }
  function ensureEnt(id, cls, glyph) {
    let e = entEls.get(id);
    if (e) return e;
    e = el('div', 'ent ' + cls);
    e.dataset.id = id;
    const body = el('div', 'body', glyph);
    e.appendChild(body);
    mapEl.appendChild(e);
    entEls.set(id, e);
    return e;
  }

  // ------------------------------------------------------------
  // 描画
  // ------------------------------------------------------------
  function renderAll() {
    renderTop();
    renderMarks();
    renderEntities();
    renderSkills();
    renderPassives();
    renderEnemies();
    renderLog();
    renderZukan();
    renderOverlay();
  }

  function renderTop() {
    $('floor-num').textContent = S.floor;
    $('hp-num').textContent = S.player.hp;
    $('hp-max').textContent = S.player.maxHp;
    const fill = $('hp-fill');
    fill.style.width = Math.max(0, Math.min(100, S.player.hp / S.player.maxHp * 100)) + '%';
    fill.classList.toggle('low', S.player.hp <= S.player.maxHp * 0.3);
    $('shard-num').textContent = S.player.shards;
    $('step-num').textContent = S.steps;
    $('floor-info').textContent = S.chest.opened
      ? 'このフロアの宝箱は開けた。階段（階）に乗ると「帰る／潜る」を選べる。'
      : 'このフロアの目玉：宝箱（宝）の中身は「' + Sim.chestLabel(S) + '」。歩いて乗ると開く。';
  }

  function renderMarks() {
    const life = Sim.markLife(S);
    for (let y = 0; y < Sim.H; y++) for (let x = 0; x < Sim.W; x++) {
      const t = tileEls[y][x];
      const old = t.querySelector('.mark');
      const m = S.marks[x + ',' + y];
      if (!m) { if (old) old.remove(); continue; }
      const mk = old || el('div', 'mark');
      mk.className = 'mark ' + m.kind;
      mk.style.opacity = String(Math.max(0.15, 1 - m.age / life));
      if (!old) t.appendChild(mk);
    }
  }

  function renderEntities() {
    const alive = new Set();
    // 階段・宝箱・かけら
    const st = ensureEnt('stairs', 'stairs', '階'); place(st, S.stairs.x, S.stairs.y); alive.add('stairs');
    const ch = ensureEnt('chest', 'chest', '宝'); place(ch, S.chest.x, S.chest.y); alive.add('chest');
    ch.classList.toggle('opened', S.chest.opened);
    ch.title = S.chest.opened ? '開けた宝箱' : '宝箱：' + Sim.chestLabel(S);
    S.shardsOnFloor.forEach((sh) => {
      const id = 'shard' + sh.x + '_' + sh.y;
      const e = ensureEnt(id, 'shard', '✦'); place(e, sh.x, sh.y); alive.add(id);
      e.firstChild.textContent = sh.n > 1 ? '✦' + sh.n : '✦';
    });
    // 敵
    for (const en of S.enemies) {
      const d = Sim.ENEMIES[en.type];
      const e = ensureEnt(en.id, 'enemy ' + en.type, d.glyph);
      if (!e.querySelector('.cd')) {
        e.appendChild(el('div', 'egauge')).appendChild(el('div'));
        e.appendChild(el('div', 'cd'));
        e.appendChild(el('div', 'hpbar')).appendChild(el('div'));
      }
      place(e, en.x, en.y);
      alive.add(en.id);
      const cd = e.querySelector('.cd'), eg = e.querySelector('.egauge');
      if (d.skill) {
        cd.textContent = en.counter;
        cd.className = 'cd' + (en.counter <= 1 ? ' danger' : '');
        eg.className = 'egauge' + (en.counter <= 1 ? ' danger' : '');
        eg.firstChild.style.width = (en.counter / d.skill.period * 100) + '%';
        eg.style.display = '';
        e.classList.toggle('fx-warn', en.counter === 1);
      } else {
        cd.className = 'cd none';
        eg.style.display = 'none';
      }
      e.querySelector('.hpbar').firstChild.style.width = (en.hp / en.maxHp * 100) + '%';
    }
    // 自分
    const pl = ensureEnt('player', 'player', '自'); place(pl, S.player.x, S.player.y); alive.add('player');
    scrollToPlayer();
    // 消えたもの
    for (const [id, e] of Array.from(entEls.entries())) {
      if (!alive.has(id)) {
        if (e.classList.contains('fx-die')) continue; // 消える演出中
        e.remove(); entEls.delete(id);
      }
    }
  }

  function gaugeHtml(ratio, cls) {
    const g = el('div', 'gauge');
    const f = el('div', 'gauge-fill ' + cls);
    f.style.width = Math.max(0, Math.min(100, ratio * 100)) + '%';
    g.appendChild(f);
    return g;
  }

  function renderSkills() {
    const ul = $('skill-list');
    ul.innerHTML = '';
    for (const sk of S.player.skills) {
      const def = Sim.SKILLS[sk.id];
      const period = Sim.periodOf(S, def);
      const li = el('li');
      const head = el('div', 'head');
      head.appendChild(el('span', 'name', Sim.skillLabel(sk)));
      head.appendChild(el('span', 'num', '残り ' + sk.remaining + ' 歩'));
      li.appendChild(head);
      li.appendChild(el('div', 'sub', Sim.skillDesc(sk) + '（' + period + '歩ごと）'));
      li.appendChild(gaugeHtml(1 - sk.remaining / period, 'cd'));
      ul.appendChild(li);
    }
    for (let i = S.player.skills.length; i < Sim.MAX_SKILLS; i++) ul.appendChild(el('li', 'empty', '（空き）'));
  }

  function renderPassives() {
    const ul = $('passive-list');
    ul.innerHTML = '';
    for (const id of S.player.passives) {
      const d = Sim.PASSIVES[id];
      const li = el('li');
      li.appendChild(el('span', 'name', d.name));
      li.appendChild(el('div', 'sub', d.desc));
      ul.appendChild(li);
    }
    for (let i = S.player.passives.length; i < Sim.MAX_PASSIVES; i++) ul.appendChild(el('li', 'empty', '（空き）'));
  }

  function renderEnemies() {
    const ul = $('enemy-list');
    ul.innerHTML = '';
    const list = S.enemies.slice().sort((a, b) => Sim.manhattan(S.player.x, S.player.y, a.x, a.y) - Sim.manhattan(S.player.x, S.player.y, b.x, b.y));
    if (!list.length) ul.appendChild(el('li', 'empty', 'このフロアの敵はいない'));
    for (const en of list) {
      const d = Sim.ENEMIES[en.type];
      const li = el('li' + '');
      const danger = d.skill && en.counter <= 1;
      if (danger) li.classList.add('danger');
      const head = el('div', 'head');
      const name = el('span', 'name');
      name.appendChild(el('span', 'swatch ' + en.type));
      name.appendChild(document.createTextNode(d.name));
      head.appendChild(name);
      head.appendChild(el('span', 'num' + (danger ? ' danger' : ''), d.skill ? '残り ' + en.counter + ' 歩' : 'スキルなし'));
      li.appendChild(head);
      const dist = Sim.manhattan(S.player.x, S.player.y, en.x, en.y);
      const sub = d.skill
        ? d.skill.name + '（' + d.skill.period + '歩ごと・' + d.skill.power + '）　体力 ' + en.hp + '/' + en.maxHp + '　距離 ' + dist
        : 'かみつき ' + d.atk + '　体力 ' + en.hp + '/' + en.maxHp + '　距離 ' + dist;
      li.appendChild(el('div', 'sub', sub));
      if (d.skill) li.appendChild(gaugeHtml(1 - en.counter / d.skill.period, 'ecd' + (danger ? ' danger' : '')));
      // 体力のゲージは地図のマスの下に出ている（一覧には数字だけ）。一覧を低く保ち、地図と同じ画面に収めるため
      ul.appendChild(li);
    }
  }

  function pushLog(text, cls) {
    logLines.push({ text, cls: cls || '' });
    if (logLines.length > 80) logLines.shift();
  }
  function renderLog() {
    const ol = $('log');
    ol.innerHTML = '';
    for (const l of logLines) ol.appendChild(el('li', l.cls, l.text));
    ol.scrollTop = ol.scrollHeight;
  }

  function renderZukan() {
    const z = $('zukan');
    z.innerHTML = '';
    const found = zukan.indexOf('gouka') >= 0 || S.discoveries.indexOf('gouka') >= 0;
    z.appendChild(el('div', found ? 'strong' : 'dim', found
      ? 'ごうか：ほのお+2 ＋ ちから で宝箱を開けると進化（9歩ごと・周囲2マス・6）'
      : '？？？：ある条件で宝箱を開けると、スキルが進化する'));
  }

  // ------------------------------------------------------------
  // 重ねる画面
  // ------------------------------------------------------------
  function renderOverlay() {
    const ov = $('overlay'), dg = $('dialog');
    dg.innerHTML = '';
    if (S.phase === 'play') { ov.classList.add('hidden'); return; }
    ov.classList.remove('hidden');
    if (S.phase === 'levelup') {
      dg.appendChild(el('h2', '', 'レベルアップ！ 1つ選ぶ'));
      const box = el('div', 'choices');
      S.choices.forEach((c, i) => {
        const b = el('button', 'choice');
        b.type = 'button';
        const lab = el('div', 'c-label');
        lab.appendChild(el('span', 'c-key', String(i + 1)));
        lab.appendChild(document.createTextNode(c.label));
        b.appendChild(lab);
        b.appendChild(el('div', 'c-sub', c.sub));
        b.appendChild(el('div', 'c-desc', c.desc));
        b.addEventListener('click', () => doAction({ type: 'choose', index: i }));
        box.appendChild(b);
      });
      dg.appendChild(box);
    } else if (S.phase === 'stairs') {
      dg.appendChild(el('h2', '', 'フロア' + S.floor + 'の階段'));
      dg.appendChild(el('p', '', '帰れば、ここまでの成果で冒険は成功。潜れば次のフロアへ（深いほど宝箱の中身が良い）。'));
      dg.appendChild(el('p', 'dim', '体力 ' + S.player.hp + '/' + S.player.maxHp + '　倒した敵 ' + S.player.kills + '　スキル ' + S.player.skills.map(Sim.skillLabel).join('・')));
      const row = el('div', 'row');
      const b1 = el('button', 'btn primary', '潜る（1）'); b1.type = 'button';
      b1.addEventListener('click', () => doAction({ type: 'stairs', choice: 'descend' }));
      const b2 = el('button', 'btn', '帰る（2）'); b2.type = 'button';
      b2.addEventListener('click', () => doAction({ type: 'stairs', choice: 'leave' }));
      row.appendChild(b1); row.appendChild(b2);
      dg.appendChild(row);
    } else if (S.phase === 'dead') {
      dg.appendChild(el('h2', '', 'フロア' + S.floor + 'で倒れた'));
      dg.appendChild(el('p', 'cause', '死因：' + S.deathCause));
      dg.appendChild(el('p', '', S.deathBySkill
        ? '発動の直前（残り1歩）に射程の中にいた。残り歩数を見て、1歩はなれるか、先に叩くか。'
        : 'かみつきで削られた。隣にいる間は毎手かまれる。'));
      dg.appendChild(summaryList());
      const row = el('div', 'row');
      const b = el('button', 'btn primary', 'もう一度（R）'); b.type = 'button';
      b.addEventListener('click', restart);
      row.appendChild(b);
      dg.appendChild(row);
    } else if (S.phase === 'clear') {
      dg.appendChild(el('h2', '', S.result === 'escaped' ? '最深部から帰還！' : 'フロア' + S.floor + 'から帰還'));
      dg.appendChild(summaryList());
      const row = el('div', 'row');
      const b = el('button', 'btn primary', 'もう一度（R）'); b.type = 'button';
      b.addEventListener('click', restart);
      row.appendChild(b);
      dg.appendChild(row);
    }
  }
  function summaryList() {
    const ul = el('ul', 'summary');
    ul.appendChild(el('li', '', '到達フロア：' + S.floor + ' / 3'));
    ul.appendChild(el('li', '', '倒した敵：' + S.player.kills + '　歩数：' + S.steps + '　手数：' + S.turn));
    ul.appendChild(el('li', '', 'スキル：' + S.player.skills.map(Sim.skillLabel).join('・')));
    ul.appendChild(el('li', '', 'パッシブ：' + (S.player.passives.map(id => Sim.PASSIVES[id].name).join('・') || 'なし')));
    if (S.discoveries.length) ul.appendChild(el('li', 'strong', '進化を見つけた：ごうか'));
    return ul;
  }

  // ------------------------------------------------------------
  // イベントの再生（演出・音・ログ）
  // ------------------------------------------------------------
  function shake(level) {
    if (settings.shake === 'off') return;
    const cls = settings.shake === 'mid' && level === 'mid' ? 'fx-shake-mid' : 'fx-shake-weak';
    mapWrap.classList.remove('fx-shake-weak', 'fx-shake-mid');
    void mapWrap.offsetWidth;
    mapWrap.classList.add(cls);
  }
  function flashOnce() {
    mapWrap.classList.remove('fx-flash'); void mapWrap.offsetWidth; mapWrap.classList.add('fx-flash');
  }
  function pulse(id, cls) {
    const e = entEls.get(id); if (!e) return;
    e.classList.remove(cls); void e.offsetWidth; e.classList.add(cls);
  }
  function burst(cx, cy, radius, cls, kind) {
    const ts = tileSize();
    const b = el('div', 'fx-burst ' + (cls || ''));
    let x0, y0, w, h;
    if (kind === 'cross') { // 隣（上下左右）
      x0 = cx - 1; y0 = cy - 1; w = 3; h = 3; b.style.borderRadius = '50%';
    } else {
      x0 = cx - radius; y0 = cy - radius; w = 2 * radius + 1; h = w;
    }
    b.style.left = (x0 * ts) + 'px'; b.style.top = (y0 * ts) + 'px';
    b.style.width = (w * ts) + 'px'; b.style.height = (h * ts) + 'px';
    mapEl.appendChild(b);
    b.addEventListener('animationend', () => b.remove());
  }

  function playEvents(events) {
    let flashed = false, approached = false;
    for (const ev of events) {
      const text = Sim.describe(ev);
      switch (ev.t) {
        case 'attack': pulse(ev.target, 'fx-hit'); pushLog(text); break;
        case 'hit': pulse(ev.target, 'fx-hit'); break;
        case 'die': {
          const e = entEls.get(ev.target);
          if (e) { e.classList.add('fx-die'); setTimeout(() => { e.remove(); if (entEls.get(ev.target) === e) entEls.delete(ev.target); }, 380); }
          pushLog(text, 'strong');
          break;
        }
        case 'skill':
          if (ev.who === 'player') {
            const def = Sim.SKILLS[ev.skill];
            if (def.kind === 'area') burst(S.player.x, S.player.y, def.radius, '', 'square');
            else if (def.kind === 'adjacent') burst(S.player.x, S.player.y, 1, '', 'cross');
            else if (def.kind === 'heal') { burst(S.player.x, S.player.y, 0, 'heal', 'square'); pulse('player', 'fx-hit'); }
            else if (ev.hits.length) { const h = ev.hits[0]; burst(h.x, h.y, 0, '', 'square'); }
            if (!flashed) { flashOnce(); flashed = true; }
            shake('weak');
            Sfx.fire('player');
            pushLog(text, 'strong');
          } else {
            const e = entEls.get(ev.target);
            if (ev.type === 'lizard') {
              if (ev.leapTo && e) { e.classList.add('fx-leap'); place(e, ev.leapTo.x, ev.leapTo.y); setTimeout(() => e.classList.remove('fx-leap'), 260); }
              burst(ev.leapTo ? ev.leapTo.x : (e ? Number(e.dataset.x) : S.player.x), ev.leapTo ? ev.leapTo.y : (e ? Number(e.dataset.y) : S.player.y), 0, 'enemy', 'square');
            } else if (ev.type === 'caterpillar' && e) {
              burst(Number(e.dataset.x), Number(e.dataset.y), 1, 'enemy', 'square');
            }
            if (ev.hit) shake('mid');
            Sfx.fire('enemy');
            pushLog(text, ev.hit ? 'bad' : '');
          }
          break;
        case 'eattack': pushLog(text, 'bad'); break;
        case 'hurt': pulse('player', 'fx-hurt'); if (!ev.bySkill) shake('weak'); break;
        case 'warn':
          if (ev.who === 'enemy' && !approached && Sim.manhattan(S.player.x, S.player.y, ev.x, ev.y) <= 5) { Sfx.approach(); approached = true; }
          break;
        case 'evolve':
          if (zukan.indexOf('gouka') < 0) { zukan.push('gouka'); saveZukan(); }
          showNotice('進化！ ほのお → ごうか（9歩ごと・周囲2マスの敵全員に6）　— クリックで閉じる');
          flashed || (flashOnce(), flashed = true);
          shake('mid');
          Sfx.fire('player');
          pushLog(text, 'strong');
          break;
        case 'floor':
          buildMap();
          pushLog(text, 'strong');
          pushLog('宝箱の中身：' + Sim.chestLabel(S) + '。敵 ' + S.enemies.length + ' 体。');
          break;
        case 'chest': pushLog('宝箱を開けた：' + (ev.got.join('・') || '（空）'), 'strong'); break;
        case 'death': pushLog(text, 'bad'); break;
        case 'clear': case 'levelup': case 'stairs': case 'pickup': case 'gain': case 'wait':
          if (text) pushLog(text, ev.t === 'wait' ? '' : 'strong');
          break;
        default:
          if (text) pushLog(text);
      }
    }
  }
  function showNotice(text) {
    const n = $('notice');
    n.textContent = text;
    n.classList.remove('hidden');
  }

  // ------------------------------------------------------------
  // 入力
  // ------------------------------------------------------------
  function doAction(a) {
    if (!a) return;
    const events = Sim.act(S, a);
    if (!events.length) return;
    playEvents(events);
    renderAll();
  }
  function restart() {
    if (autoEndTimer) { clearTimeout(autoEndTimer); autoEndTimer = null; }
    newGame(FIXED_SEED ? seed : seed + 1);
  }

  const KEYS = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
    k: [0, -1], j: [0, 1], h: [-1, 0], l: [1, 0],
  };
  document.addEventListener('keydown', (e) => {
    Sfx.unlock();
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (!$('settings').classList.contains('hidden')) { if (e.key === 'Escape') closeSettings(); return; }
    if (S.phase === 'play') {
      const d = KEYS[e.key];
      if (d) { e.preventDefault(); doAction({ type: 'move', dx: d[0], dy: d[1] }); return; }
      if (e.key === ' ' || e.key === '.' || e.key === 'z') { e.preventDefault(); doAction({ type: 'wait' }); return; }
    } else if (S.phase === 'levelup') {
      const n = Number(e.key);
      if (n >= 1 && n <= S.choices.length) { e.preventDefault(); doAction({ type: 'choose', index: n - 1 }); }
    } else if (S.phase === 'stairs') {
      if (e.key === '1') doAction({ type: 'stairs', choice: 'descend' });
      if (e.key === '2') doAction({ type: 'stairs', choice: 'leave' });
    } else if (S.phase === 'dead' || S.phase === 'clear') {
      if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') restart();
    }
  });
  document.addEventListener('pointerdown', () => Sfx.unlock(), { passive: true });

  // ------------------------------------------------------------
  // 設定画面
  // ------------------------------------------------------------
  function openSettings() {
    $('opt-volume').value = Math.round(settings.volume * 100);
    $('opt-volume-num').textContent = Math.round(settings.volume * 100);
    $('opt-shake').value = settings.shake;
    $('settings').classList.remove('hidden');
  }
  function closeSettings() { $('settings').classList.add('hidden'); }
  function applyShakeClass() { document.body.classList.toggle('no-shake', settings.shake === 'off'); }

  // ------------------------------------------------------------
  // 自動プレイ
  // ------------------------------------------------------------
  function autoStep() {
    if (autoPaused) return;
    if (S.phase === 'dead' || S.phase === 'clear') {
      if (!autoEndTimer) autoEndTimer = setTimeout(() => { autoEndTimer = null; newGame(FIXED_SEED ? seed : seed + 1); }, 2500);
      return;
    }
    const a = Bots.decide('reader', S, botRng);
    doAction(a);
  }
  function startAuto() {
    if (BG) {
      autoTimer = setInterval(autoStep, AUTO_INTERVAL);
    } else {
      const loop = (ts) => {
        if (ts - autoLast >= AUTO_INTERVAL) { autoLast = ts; autoStep(); }
        autoRaf = requestAnimationFrame(loop);
      };
      autoRaf = requestAnimationFrame(loop);
    }
  }
  function stopAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (autoRaf) { cancelAnimationFrame(autoRaf); autoRaf = null; }
  }

  // ------------------------------------------------------------
  // 起動
  // ------------------------------------------------------------
  function init() {
    mapEl = $('map');
    mapWrap = $('map-wrap');
    applyShakeClass();

    document.querySelectorAll('.dpad .dir').forEach((b) => {
      b.addEventListener('click', () => { Sfx.unlock(); doAction({ type: 'move', dx: Number(b.dataset.dx), dy: Number(b.dataset.dy) }); });
    });
    $('btn-wait').addEventListener('click', () => { Sfx.unlock(); doAction({ type: 'wait' }); });
    $('btn-settings').addEventListener('click', openSettings);
    $('btn-settings-close').addEventListener('click', closeSettings);
    $('opt-volume').addEventListener('input', (e) => {
      settings.volume = Number(e.target.value) / 100;
      $('opt-volume-num').textContent = e.target.value;
      Sfx.setVolume(settings.volume);
      saveSettings();
    });
    $('opt-shake').addEventListener('change', (e) => { settings.shake = e.target.value; applyShakeClass(); saveSettings(); });
    $('notice').addEventListener('click', () => $('notice').classList.add('hidden'));
    window.addEventListener('resize', applyTileSize);

    newGame(seed);
    if (AUTO) {
      document.querySelector('.help').textContent = '自動プレイ中（?auto=1）。音は出ない。';
      startAuto();
    }

    // 確認用（Playwright から使う）
    window.__game = {
      get state() { return S; },
      act: doAction,
      render: renderAll,
      playEvents,
      restart: (sd) => newGame(sd === undefined ? seed : sd),
      pauseAuto: () => { autoPaused = true; },
      resumeAuto: () => { autoPaused = false; },
      stopAuto,
      settings,
      seed: () => seed,
      Sim, Bots,
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
