/*
 * sim.js — ルール側（画面を持たない）
 *
 * 「1手ごとに何が起きたか」をイベントの配列で返す。画面側(ui.js)はそれを再生するだけ。
 * Node でもブラウザでもそのまま読み込める（ビルド不要）。
 * 数値はすべて docs/試作仕様書.md 3章の初期値をそのまま使う。
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------
  // データ（仕様書 3章の表をそのまま）
  // ---------------------------------------------------------------
  const W = 20;
  const H = 11;

  const SKILLS = {
    honoo:    { id: 'honoo',    name: 'ほのお',       period: 7,  power: 4, kind: 'area',     radius: 1, desc: '周囲1マスの敵全員に{p}' },
    kaminari: { id: 'kaminari', name: 'かみなり',     period: 10, power: 7, kind: 'nearest',             desc: 'いちばん近い敵1体に{p}' },
    kaifuku:  { id: 'kaifuku',  name: 'かいふくの風', period: 12, power: 4, kind: 'heal',                desc: '自分の体力を{p}回復' },
    hayate:   { id: 'hayate',   name: 'はやての刃',   period: 5,  power: 3, kind: 'adjacent',            desc: '隣の敵全員に{p}' },
    // 進化先（試作では1つだけ）
    gouka:    { id: 'gouka',    name: 'ごうか',       period: 9,  power: 6, kind: 'area',     radius: 2, desc: '周囲2マスの敵全員に{p}', evolved: true },
  };
  const BASIC_SKILL_IDS = ['honoo', 'kaminari', 'kaifuku', 'hayate'];

  const PASSIVES = {
    chikara:   { id: 'chikara',   name: 'ちから',       desc: '通常攻撃＋1' },
    hayaashi:  { id: 'hayaashi',  name: 'はやあし',     desc: 'スキルの歩数－1（最低3）' },
    inochi:    { id: 'inochi',    name: 'いのち',       desc: '最大体力＋10' },
    mejirushi: { id: 'mejirushi', name: 'めじるし読み', desc: '痕跡が残る歩数が2倍' },
  };
  const PASSIVE_IDS = ['chikara', 'hayaashi', 'inochi', 'mejirushi'];

  const ENEMIES = {
    rat:         { id: 'rat',         name: 'かみつきネズミ', glyph: 'ネ', hp: 6,  atk: 2, skill: null },
    lizard:      { id: 'lizard',      name: 'とびつきトカゲ', glyph: 'ト', hp: 8,  atk: 2, skill: { name: '飛びつき', period: 5, power: 4, range: 2 } },
    caterpillar: { id: 'caterpillar', name: 'ほのおイモムシ', glyph: 'イ', hp: 10, atk: 1, skill: { name: '炎',       period: 7, power: 5 } },
  };

  const PLAYER_HP = 30;
  const PLAYER_ATK = 3;
  const MAX_SKILLS = 3;
  const MAX_PASSIVES = 3;
  const SHARDS_PER_LEVEL = 3;
  const MARK_LIFE = 20;        // 痕跡が消えるまでの歩数
  const UPGRADE_STEP = 2;      // 強化1回ごとの威力＋（仕様書に無い値。REPORT.md に明記）
  const MIN_PERIOD = 3;        // はやあしの下限
  const CHASE_RANGE = 8;       // 敵が追いかけ始める距離（仕様書に無い値）
  const FLEE_RATIO = 1 / 3;    // 体力がこれ以下で逃げる（仕様書に無い値。血痕を読む場面を作るため）
  const FLOORS = 3;

  // フロアごとの敵の配置（仕様書に無い値。深いほど多く）
  const FLOOR_ENEMIES = {
    1: ['rat', 'rat', 'lizard'],
    2: ['rat', 'lizard', 'lizard', 'caterpillar'],
    3: ['rat', 'lizard', 'lizard', 'caterpillar', 'caterpillar'],
  };

  // ---------------------------------------------------------------
  // 乱数（seed 固定。mulberry32）
  // ---------------------------------------------------------------
  function rand(s) {
    let t = (s.rngState = (s.rngState + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function ri(s, n) { return Math.floor(rand(s) * n); }
  function pick(s, arr) { return arr[ri(s, arr.length)]; }
  function shuffle(s, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = ri(s, i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // ---------------------------------------------------------------
  // 小道具
  // ---------------------------------------------------------------
  const DIRS4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  function key(x, y) { return x + ',' + y; }
  function manhattan(ax, ay, bx, by) { return Math.abs(ax - bx) + Math.abs(ay - by); }
  function chebyshev(ax, ay, bx, by) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }
  function inBounds(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }
  function passable(s, x, y) { return inBounds(x, y) && s.map[y][x] === '.'; }
  function enemyAt(s, x, y) { return s.enemies.find(e => e.x === x && e.y === y) || null; }
  function occupied(s, x, y) { return (s.player.x === x && s.player.y === y) || !!enemyAt(s, x, y); }

  function hasPassive(s, id) { return s.player.passives.indexOf(id) >= 0; }
  function periodOf(s, skillDef) {
    const base = skillDef.period;
    return hasPassive(s, 'hayaashi') ? Math.max(MIN_PERIOD, base - 1) : base;
  }
  function powerOf(skill) { return SKILLS[skill.id].power + UPGRADE_STEP * skill.lvl; }
  function markLife(s) { return hasPassive(s, 'mejirushi') ? MARK_LIFE * 2 : MARK_LIFE; }
  function playerAtk(s) { return PLAYER_ATK + (hasPassive(s, 'chikara') ? 1 : 0); }

  function skillLabel(skill) {
    const d = SKILLS[skill.id];
    return d.name + (skill.lvl > 0 ? '+' + skill.lvl : '');
  }
  function skillDesc(skill) {
    return SKILLS[skill.id].desc.replace('{p}', String(powerOf(skill)));
  }

  // ---------------------------------------------------------------
  // フロア生成（部屋3つ＋通路の単純な形）
  // ---------------------------------------------------------------
  function genFloor(s) {
    const map = [];
    for (let y = 0; y < H; y++) map.push(Array(W).fill('#'));
    const xRanges = [[1, 5], [8, 12], [14, 18]];
    const rooms = [];
    for (const [x0, x1] of xRanges) {
      const h = 3 + ri(s, 3);                 // 3..5
      const y0 = 1 + ri(s, (H - 2) - h + 1);  // 1..(H-2-h+1)
      const y1 = y0 + h - 1;
      rooms.push({ x0, x1, y0, y1, cx: Math.floor((x0 + x1) / 2), cy: Math.floor((y0 + y1) / 2) });
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) map[y][x] = '.';
    }
    for (let i = 0; i < rooms.length - 1; i++) {
      const a = rooms[i], b = rooms[i + 1];
      for (let x = a.cx; x <= b.cx; x++) map[a.cy][x] = '.';
      const yA = Math.min(a.cy, b.cy), yB = Math.max(a.cy, b.cy);
      for (let y = yA; y <= yB; y++) map[y][b.cx] = '.';
    }
    s.map = map.map(r => r.join(''));
    s.rooms = rooms;

    const roomTiles = (r) => {
      const t = [];
      for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) t.push([x, y]);
      return t;
    };
    const start = pick(s, roomTiles(rooms[0]));
    s.player.x = start[0]; s.player.y = start[1];
    const stairs = pick(s, roomTiles(rooms[2]));
    s.stairs = { x: stairs[0], y: stairs[1] };
    const chest = pick(s, roomTiles(rooms[1]));
    s.chest = { x: chest[0], y: chest[1], opened: false, contents: genChestContents(s) };

    // 敵は部屋2・3に置く（入った瞬間に全部見える。部屋1には置かない）
    s.enemies = [];
    const cand = shuffle(s, roomTiles(rooms[1]).concat(roomTiles(rooms[2])))
      .filter(([x, y]) => !(x === s.chest.x && y === s.chest.y) && !(x === s.stairs.x && y === s.stairs.y));
    const types = FLOOR_ENEMIES[s.floor] || FLOOR_ENEMIES[3];
    types.forEach((type, i) => {
      const [x, y] = cand[i];
      const d = ENEMIES[type];
      s.enemies.push({ id: 'e' + (s.nextId++), type, x, y, hp: d.hp, maxHp: d.hp, counter: d.skill ? d.skill.period : null });
    });
    s.shardsOnFloor = [];
    s.marks = {};
  }

  // 宝箱の中身（目玉）。深いほど良い：1F=パッシブ1 / 2F=パッシブ＋強化1 / 3F=パッシブ＋強化2
  function genChestContents(s) {
    const notOwned = PASSIVE_IDS.filter(id => !hasPassive(s, id));
    const c = { passive: null, upgrades: s.floor - 1 };
    if (notOwned.length && s.player.passives.length < MAX_PASSIVES) c.passive = pick(s, notOwned);
    else c.upgrades += 1;
    return c;
  }

  // ---------------------------------------------------------------
  // ゲーム開始
  // ---------------------------------------------------------------
  function newGame(seed, opts) {
    opts = opts || {};
    const s = {
      seed: seed | 0,
      rngState: (seed | 0) ^ 0x9E3779B9,
      floor: 1,
      turn: 0,      // 待つも含めた手数
      steps: 0,     // 歩いた＋攻撃した回数（スキルの歩数）
      phase: 'play',
      nextId: 1,
      player: {
        x: 0, y: 0, hp: PLAYER_HP, maxHp: PLAYER_HP,
        skills: [], passives: [], shards: 0, kills: 0,
      },
      enemies: [], map: [], rooms: [], stairs: null, chest: null, shardsOnFloor: [], marks: {},
      choices: null, result: null, deathCause: null, discoveries: [],
      stats: { damageTaken: 0, skillFires: {}, skillDamage: {}, skillHeal: 0, waits: 0, chests: 0, levelUps: 0 },
    };
    const startSkill = opts.startSkill || 'honoo';
    s.player.skills.push({ id: startSkill, lvl: 0, remaining: SKILLS[startSkill].period });
    genFloor(s);
    return s;
  }

  // ---------------------------------------------------------------
  // ダメージ・死亡
  // ---------------------------------------------------------------
  function dropShard(s, x, y) {
    const sh = s.shardsOnFloor.find(o => o.x === x && o.y === y);
    if (sh) sh.n += 1; else s.shardsOnFloor.push({ x, y, n: 1 });
  }

  function damageEnemy(s, e, amount, source, ev) {
    e.hp -= amount;
    ev.push({ t: 'hit', target: e.id, type: e.type, x: e.x, y: e.y, amount, source });
    if (e.hp <= 0) {
      s.enemies = s.enemies.filter(o => o !== e);
      dropShard(s, e.x, e.y);
      s.player.kills += 1;
      ev.push({ t: 'die', target: e.id, type: e.type, name: ENEMIES[e.type].name, x: e.x, y: e.y });
      return true;
    }
    return false;
  }

  function damagePlayer(s, amount, cause, ev) {
    s.player.hp -= amount;
    s.stats.damageTaken += amount;
    ev.push({ t: 'hurt', amount, cause: cause.text, bySkill: !!cause.bySkill });
    if (s.player.hp <= 0) {
      s.player.hp = 0;
      s.phase = 'dead';
      s.result = 'dead';
      s.deathCause = cause.text + '（' + amount + 'ダメージ）';
      s.deathBySkill = !!cause.bySkill;
      ev.push({ t: 'death', cause: s.deathCause, bySkill: !!cause.bySkill });
    }
  }

  // ---------------------------------------------------------------
  // プレイヤーのスキル発動
  // ---------------------------------------------------------------
  function fireSkill(s, skill, ev) {
    const def = SKILLS[skill.id];
    const p = powerOf(skill);
    const px = s.player.x, py = s.player.y;
    const e = { t: 'skill', who: 'player', skill: skill.id, name: skillLabel(skill), hits: [], heal: 0 };
    s.stats.skillFires[skill.id] = (s.stats.skillFires[skill.id] || 0) + 1;
    let targets = [];
    if (def.kind === 'area') {
      targets = s.enemies.filter(o => chebyshev(px, py, o.x, o.y) <= def.radius);
    } else if (def.kind === 'adjacent') {
      targets = s.enemies.filter(o => manhattan(px, py, o.x, o.y) === 1);
    } else if (def.kind === 'nearest') {
      let best = null, bd = Infinity;
      for (const o of s.enemies) { const d = manhattan(px, py, o.x, o.y); if (d < bd) { bd = d; best = o; } }
      if (best) targets = [best];
    } else if (def.kind === 'heal') {
      const before = s.player.hp;
      s.player.hp = Math.min(s.player.maxHp, s.player.hp + p);
      e.heal = s.player.hp - before;
      s.stats.skillHeal += e.heal;
    }
    ev.push(e);
    for (const o of targets.slice()) {
      e.hits.push({ target: o.id, type: o.type, x: o.x, y: o.y, amount: p });
      s.stats.skillDamage[skill.id] = (s.stats.skillDamage[skill.id] || 0) + p;
      damageEnemy(s, o, p, 'skill:' + skill.id, ev);
    }
  }

  // ---------------------------------------------------------------
  // 敵の行動
  // ---------------------------------------------------------------
  function bfsFromPlayer(s) {
    const dist = [];
    for (let y = 0; y < H; y++) dist.push(Array(W).fill(Infinity));
    const q = [[s.player.x, s.player.y]];
    dist[s.player.y][s.player.x] = 0;
    while (q.length) {
      const [x, y] = q.shift();
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx, ny = y + dy;
        if (passable(s, nx, ny) && dist[ny][nx] === Infinity) { dist[ny][nx] = dist[y][x] + 1; q.push([nx, ny]); }
      }
    }
    return dist;
  }

  function moveEnemy(s, e, nx, ny, ev) {
    const wounded = e.hp < e.maxHp;
    s.marks[key(e.x, e.y)] = { kind: wounded ? 'blood' : 'enemy', age: 0, by: e.type };
    ev.push({ t: 'emove', target: e.id, type: e.type, from: { x: e.x, y: e.y }, to: { x: nx, y: ny }, blood: wounded });
    e.x = nx; e.y = ny;
  }

  function freeNeighbors(s, e) {
    const out = [];
    for (const [dx, dy] of DIRS4) {
      const nx = e.x + dx, ny = e.y + dy;
      if (passable(s, nx, ny) && !occupied(s, nx, ny)) out.push([nx, ny]);
    }
    return out;
  }

  function enemyFireSkill(s, e, ev) {
    const d = ENEMIES[e.type];
    const sk = d.skill;
    const px = s.player.x, py = s.player.y;
    const out = { t: 'skill', who: 'enemy', target: e.id, type: e.type, name: d.name, skill: sk.name, hit: false, amount: sk.power, hits: [] };
    if (e.type === 'lizard') {
      // 5歩ごと：2マス先から飛びついて4
      const dist = manhattan(px, py, e.x, e.y);
      if (dist <= sk.range) {
        if (dist > 1) {
          // プレイヤーの隣で空いているマスに飛びつく（自分に最も近い方）
          let best = null, bd = Infinity;
          for (const [dx, dy] of DIRS4) {
            const nx = px + dx, ny = py + dy;
            if (passable(s, nx, ny) && !occupied(s, nx, ny)) {
              const dd = manhattan(e.x, e.y, nx, ny);
              if (dd < bd) { bd = dd; best = [nx, ny]; }
            }
          }
          if (best) { out.leapTo = { x: best[0], y: best[1] }; moveEnemy(s, e, best[0], best[1], ev); }
        }
        out.hit = true;
        ev.push(out);
        damagePlayer(s, sk.power, { text: d.name + 'の' + sk.name, bySkill: true }, ev);
        return;
      }
      ev.push(out); // 空振り
      return;
    }
    if (e.type === 'caterpillar') {
      // 7歩ごと：周囲1マスに炎5（他の敵にも当たる）
      ev.push(out);
      if (chebyshev(px, py, e.x, e.y) <= 1) {
        out.hit = true;
        damagePlayer(s, sk.power, { text: d.name + 'の' + sk.name, bySkill: true }, ev);
      }
      for (const o of s.enemies.slice()) {
        if (o !== e && chebyshev(o.x, o.y, e.x, e.y) <= 1) {
          out.hits.push({ target: o.id, type: o.type, amount: sk.power });
          damageEnemy(s, o, sk.power, 'enemy:' + e.type, ev);
        }
      }
      return;
    }
    ev.push(out);
  }

  function enemyAct(s, e, dist, ev) {
    const d = ENEMIES[e.type];
    // 周期：プレイヤーの1手ごとに残りが減る。0で発動して元に戻る
    if (d.skill) {
      e.counter -= 1;
      if (e.counter <= 0) {
        e.counter = d.skill.period;
        enemyFireSkill(s, e, ev);
        return;
      }
      if (e.counter === 1) ev.push({ t: 'warn', who: 'enemy', target: e.id, type: e.type, x: e.x, y: e.y });
    }
    const px = s.player.x, py = s.player.y;
    const here = dist[e.y][e.x];
    // 隣なら通常攻撃
    if (manhattan(px, py, e.x, e.y) === 1) {
      ev.push({ t: 'eattack', target: e.id, type: e.type, amount: d.atk });
      damagePlayer(s, d.atk, { text: d.name + 'のかみつき' }, ev);
      return;
    }
    const free = freeNeighbors(s, e);
    if (!free.length) return;
    const flees = e.type !== 'caterpillar' && e.hp <= e.maxHp * FLEE_RATIO;
    if (flees) {
      let best = null, bd = here;
      for (const [nx, ny] of free) { const dd = dist[ny][nx]; if (dd > bd) { bd = dd; best = [nx, ny]; } }
      if (best) moveEnemy(s, e, best[0], best[1], ev);
      return;
    }
    if (e.type === 'lizard') {
      // 新しい自分（プレイヤー）の足跡の方向へ寄ってくる
      let best = null, ba = Infinity;
      for (const [nx, ny] of free) {
        const m = s.marks[key(nx, ny)];
        if (m && m.kind === 'player' && m.age < ba) { ba = m.age; best = [nx, ny]; }
      }
      if (best) { moveEnemy(s, e, best[0], best[1], ev); return; }
    }
    const range = e.type === 'caterpillar' ? 6 : CHASE_RANGE;
    if (here <= range) {
      let best = null, bd = here;
      for (const [nx, ny] of free) { const dd = dist[ny][nx]; if (dd < bd) { bd = dd; best = [nx, ny]; } }
      if (best) moveEnemy(s, e, best[0], best[1], ev);
      return;
    }
    // 遠いときはうろうろ（イモムシはじっとしている）
    if (e.type !== 'caterpillar' && rand(s) < 0.5) {
      const [nx, ny] = pick(s, free);
      moveEnemy(s, e, nx, ny, ev);
    }
  }

  function enemyPhase(s, ev) {
    const dist = bfsFromPlayer(s);
    for (const e of s.enemies.slice()) {
      if (s.phase !== 'play') return;
      if (s.enemies.indexOf(e) < 0) continue; // イモムシの炎などで死んだ
      enemyAct(s, e, dist, ev);
    }
  }

  function ageMarks(s) {
    const life = markLife(s);
    for (const k of Object.keys(s.marks)) {
      s.marks[k].age += 1;
      if (s.marks[k].age >= life) delete s.marks[k];
    }
  }

  // ---------------------------------------------------------------
  // レベルアップ・宝箱・進化
  // ---------------------------------------------------------------
  function genChoices(s) {
    const p = s.player;
    const pool = [];
    if (p.skills.length < MAX_SKILLS) {
      for (const id of BASIC_SKILL_IDS) if (!p.skills.some(k => k.id === id)) pool.push({ kind: 'skill', id });
    }
    if (p.passives.length < MAX_PASSIVES) {
      for (const id of PASSIVE_IDS) if (!hasPassive(s, id)) pool.push({ kind: 'passive', id });
    }
    for (const k of p.skills) pool.push({ kind: 'upgrade', id: k.id });
    return shuffle(s, pool).slice(0, 3).map(c => Object.assign(c, describeChoice(s, c)));
  }

  function describeChoice(s, c) {
    if (c.kind === 'skill') {
      const d = SKILLS[c.id];
      return { label: d.name, sub: '新しいスキル／' + periodOf(s, d) + '歩ごと', desc: d.desc.replace('{p}', String(d.power)) };
    }
    if (c.kind === 'passive') {
      const d = PASSIVES[c.id];
      return { label: d.name, sub: '新しいパッシブ', desc: d.desc };
    }
    const sk = s.player.skills.find(k => k.id === c.id);
    const next = { id: c.id, lvl: sk.lvl + 1 };
    return { label: skillLabel(sk) + ' を強化', sub: skillLabel(next) + ' になる', desc: skillDesc(sk) + ' → ' + skillDesc(next) };
  }

  function applyPassive(s, id, ev) {
    s.player.passives.push(id);
    if (id === 'inochi') {
      s.player.maxHp += 10;
      s.player.hp = Math.min(s.player.maxHp, s.player.hp + 10);
    }
    if (id === 'hayaashi') {
      for (const k of s.player.skills) k.remaining = Math.min(k.remaining, periodOf(s, SKILLS[k.id]));
    }
    ev.push({ t: 'gain', kind: 'passive', id, name: PASSIVES[id].name });
  }

  function applyChoice(s, c, ev) {
    if (c.kind === 'skill') {
      s.player.skills.push({ id: c.id, lvl: 0, remaining: periodOf(s, SKILLS[c.id]) });
      ev.push({ t: 'gain', kind: 'skill', id: c.id, name: SKILLS[c.id].name });
    } else if (c.kind === 'passive') {
      applyPassive(s, c.id, ev);
    } else if (c.kind === 'upgrade') {
      upgradeSkill(s, c.id, ev);
    }
  }

  function upgradeSkill(s, id, ev) {
    const sk = s.player.skills.find(k => k.id === id);
    if (!sk) return;
    sk.lvl += 1;
    ev.push({ t: 'gain', kind: 'upgrade', id, name: skillLabel(sk) });
  }

  function openChest(s, ev) {
    const c = s.chest;
    c.opened = true;
    s.stats.chests += 1;
    const got = [];
    if (c.contents.passive && s.player.passives.length < MAX_PASSIVES && !hasPassive(s, c.contents.passive)) {
      applyPassive(s, c.contents.passive, ev);
      got.push(PASSIVES[c.contents.passive].name);
    }
    for (let i = 0; i < c.contents.upgrades; i++) {
      const target = s.player.skills.find(k => k.id === 'honoo' || k.id === 'gouka') || s.player.skills[0];
      if (target) { upgradeSkill(s, target.id, ev); got.push(skillLabel(target)); }
    }
    ev.push({ t: 'chest', got });
    // 進化：「ほのお」を2回強化し、「ちから」を持った状態で宝箱を開ける → ごうか
    const honoo = s.player.skills.find(k => k.id === 'honoo');
    if (honoo && honoo.lvl >= 2 && hasPassive(s, 'chikara')) {
      honoo.id = 'gouka';
      honoo.lvl = 0;
      honoo.remaining = periodOf(s, SKILLS.gouka);
      if (s.discoveries.indexOf('gouka') < 0) s.discoveries.push('gouka');
      ev.push({ t: 'evolve', from: 'honoo', to: 'gouka', name: SKILLS.gouka.name });
    }
  }

  function chestLabel(s) {
    const c = s.chest.contents;
    const parts = [];
    if (c.passive) parts.push(PASSIVES[c.passive].name);
    if (c.upgrades > 0) {
      const target = s.player.skills.find(k => k.id === 'honoo' || k.id === 'gouka') || s.player.skills[0];
      parts.push((target ? SKILLS[target.id].name : 'スキル') + '強化' + (c.upgrades > 1 ? '×' + c.upgrades : ''));
    }
    return parts.join('＋');
  }

  // ---------------------------------------------------------------
  // 1手
  // ---------------------------------------------------------------
  function act(s, action) {
    const ev = [];
    if (s.phase === 'levelup') {
      if (action.type !== 'choose') return ev;
      const c = s.choices[action.index];
      if (!c) return ev;
      applyChoice(s, c, ev);
      s.choices = null;
      s.phase = 'play';
      // 続けてレベルアップ（かけらが溜まっている）
      checkLevelUp(s, ev);
      return ev;
    }
    if (s.phase === 'stairs') {
      if (action.type !== 'stairs') return ev;
      if (action.choice === 'leave') {
        s.phase = 'clear'; s.result = 'returned';
        ev.push({ t: 'clear', result: 'returned', floor: s.floor });
      } else if (action.choice === 'descend') {
        s.floor += 1;
        genFloor(s);
        s.phase = 'play';
        ev.push({ t: 'floor', floor: s.floor });
      }
      return ev;
    }
    if (s.phase !== 'play') return ev;

    const p = s.player;
    let stepped = false;
    if (action.type === 'move') {
      const nx = p.x + action.dx, ny = p.y + action.dy;
      if (!passable(s, nx, ny)) return ev; // 壁：手番は進まない
      const e = enemyAt(s, nx, ny);
      if (e) {
        const dmg = playerAtk(s);
        ev.push({ t: 'attack', target: e.id, type: e.type, amount: dmg, dir: { dx: action.dx, dy: action.dy } });
        damageEnemy(s, e, dmg, 'attack', ev);
      } else {
        s.marks[key(p.x, p.y)] = { kind: 'player', age: 0 };
        ev.push({ t: 'move', from: { x: p.x, y: p.y }, to: { x: nx, y: ny } });
        p.x = nx; p.y = ny;
      }
      stepped = true;
    } else if (action.type === 'wait') {
      s.stats.waits += 1;
      ev.push({ t: 'wait' });
    } else {
      return ev;
    }
    s.turn += 1;

    // 自分のスキル：歩く・攻撃で残りが減り、0で発動
    if (stepped) {
      s.steps += 1;
      for (const sk of p.skills) {
        sk.remaining -= 1;
        if (sk.remaining <= 0) {
          sk.remaining = periodOf(s, SKILLS[sk.id]);
          fireSkill(s, sk, ev);
        } else if (sk.remaining === 1) {
          ev.push({ t: 'warn', who: 'player', skill: sk.id });
        }
      }
    }

    // かけらを拾う
    const shIdx = s.shardsOnFloor.findIndex(o => o.x === p.x && o.y === p.y);
    if (shIdx >= 0) {
      const sh = s.shardsOnFloor[shIdx];
      p.shards += sh.n;
      s.shardsOnFloor.splice(shIdx, 1);
      ev.push({ t: 'pickup', n: sh.n, shards: p.shards });
    }
    // 宝箱
    if (s.chest && !s.chest.opened && p.x === s.chest.x && p.y === s.chest.y) openChest(s, ev);
    // 階段：乗った瞬間に選ぶ（この手は敵は動かない）
    if (p.x === s.stairs.x && p.y === s.stairs.y) {
      ageMarks(s);
      if (s.floor >= FLOORS) {
        s.phase = 'clear'; s.result = 'escaped';
        ev.push({ t: 'clear', result: 'escaped', floor: s.floor });
      } else {
        s.phase = 'stairs';
        ev.push({ t: 'stairs', floor: s.floor });
      }
      return ev;
    }

    // 敵の手番
    enemyPhase(s, ev);
    ageMarks(s);
    if (s.phase === 'play') checkLevelUp(s, ev);
    return ev;
  }

  function checkLevelUp(s, ev) {
    if (s.player.shards >= SHARDS_PER_LEVEL) {
      s.player.shards -= SHARDS_PER_LEVEL;
      s.stats.levelUps += 1;
      s.choices = genChoices(s);
      s.phase = 'levelup';
      ev.push({ t: 'levelup', choices: s.choices });
    }
  }

  // 取れる行動（ボット用）
  function legalActions(s) {
    if (s.phase === 'levelup') return s.choices.map((_, i) => ({ type: 'choose', index: i }));
    if (s.phase === 'stairs') return [{ type: 'stairs', choice: 'descend' }, { type: 'stairs', choice: 'leave' }];
    if (s.phase !== 'play') return [];
    const out = [{ type: 'wait' }];
    for (const [dx, dy] of DIRS4) {
      if (passable(s, s.player.x + dx, s.player.y + dy)) out.push({ type: 'move', dx, dy });
    }
    return out;
  }

  // ---------------------------------------------------------------
  // イベントを日本語の1行にする（画面のログとテスト用）
  // ---------------------------------------------------------------
  function describe(ev) {
    const en = (t) => ENEMIES[t] ? ENEMIES[t].name : t;
    switch (ev.t) {
      case 'move': return null;
      case 'wait': return '待った';
      case 'attack': return en(ev.type) + 'に' + ev.amount + 'のダメージ';
      case 'hit': return null;
      case 'die': return en(ev.type) + 'を倒した。かけらが落ちた';
      case 'skill':
        if (ev.who === 'player') {
          if (ev.heal !== undefined && SKILLS[ev.skill].kind === 'heal') return ev.name + '発動！ 体力が' + ev.heal + '回復';
          if (!ev.hits.length) return ev.name + '発動！ …当たる敵がいない';
          return ev.name + '発動！ ' + ev.hits.map(h => en(h.type) + 'に' + h.amount).join('、');
        }
        if (ev.type === 'lizard') return ev.name + 'の' + ev.skill + '！ ' + (ev.hit ? ev.amount + 'のダメージ' : '届かなかった');
        if (ev.type === 'caterpillar') {
          const parts = [];
          if (ev.hit) parts.push('自分に' + ev.amount);
          for (const h of ev.hits) parts.push(en(h.type) + 'に' + h.amount);
          return ev.name + 'の' + ev.skill + '！ ' + (parts.length ? parts.join('、') : '誰にも当たらなかった');
        }
        return ev.name + 'の' + ev.skill;
      case 'eattack': return en(ev.type) + 'のかみつき。' + ev.amount + 'のダメージ';
      case 'hurt': return null;
      case 'death': return '倒れた。死因：' + ev.cause;
      case 'pickup': return 'かけらを拾った（' + ev.shards + '/3）';
      case 'levelup': return 'レベルアップ！ 1つ選ぶ';
      case 'gain':
        if (ev.kind === 'skill') return 'スキル「' + ev.name + '」を覚えた';
        if (ev.kind === 'passive') return 'パッシブ「' + ev.name + '」を得た';
        return '「' + ev.name + '」に強化した';
      case 'chest': return '宝箱を開けた';
      case 'evolve': return '進化！ ほのお → ごうか（9歩ごと・周囲2マス・6）';
      case 'stairs': return '階段に着いた。帰る？ 潜る？';
      case 'floor': return 'フロア' + ev.floor + 'に降りた';
      case 'clear': return ev.result === 'escaped' ? '最深部から帰還した！' : 'フロア' + ev.floor + 'から帰った';
      case 'warn': return null;
      case 'emove': return null;
      default: return null;
    }
  }

  const Sim = {
    W, H, SKILLS, PASSIVES, ENEMIES, BASIC_SKILL_IDS, PASSIVE_IDS,
    PLAYER_HP, PLAYER_ATK, MAX_SKILLS, MAX_PASSIVES, SHARDS_PER_LEVEL, MARK_LIFE, UPGRADE_STEP, MIN_PERIOD, FLOORS,
    newGame, act, legalActions, describe,
    periodOf, powerOf, playerAtk, markLife, skillLabel, skillDesc, chestLabel, hasPassive,
    manhattan, chebyshev, passable, enemyAt, bfsFromPlayer,
    _internal: { genChoices, openChest, fireSkill, enemyAct, ageMarks, rand },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
  else root.Sim = Sim;
})(typeof globalThis !== 'undefined' ? globalThis : this);
