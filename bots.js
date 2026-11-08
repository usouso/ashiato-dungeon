/*
 * bots.js — ボット（Node の検証にも、ブラウザの自動プレイ ?auto=1 にも使う）
 *
 *   random : 何も考えないボット（取れる行動から等確率で選ぶ）
 *   waiter : 待ち中心のボット（隣に敵がいれば叩く。それ以外は8割「待つ」、2割だけ階段へ1歩）
 *   greedy : 周期を読まないボット（近い敵へ寄って叩く→宝箱→階段。敵の残り歩数は見ない。隣の敵のかみつきだけ避ける）
 *   reader : 周期を読むボット（greedy と同じ好みだが、次の手で発動する敵スキルの射程に入らない。比較用）
 *
 * 実行: node bots.js            … 各ボット 500 回（seed 1..500）を回して Markdown の表を出す
 *       node bots.js 100        … 回数を変える
 */
(function (root) {
  'use strict';
  const Sim = (typeof require === 'function') ? require('./sim.js') : root.Sim;

  function mulberry(seed) {
    let a = seed | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const DIRS4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  function bfsFrom(s, sx, sy) {
    const dist = [];
    for (let y = 0; y < Sim.H; y++) dist.push(Array(Sim.W).fill(Infinity));
    const q = [[sx, sy]];
    dist[sy][sx] = 0;
    while (q.length) {
      const [x, y] = q.shift();
      for (const [dx, dy] of DIRS4) {
        const nx = x + dx, ny = y + dy;
        if (Sim.passable(s, nx, ny) && dist[ny][nx] === Infinity) { dist[ny][nx] = dist[y][x] + 1; q.push([nx, ny]); }
      }
    }
    return dist;
  }

  // 目的地：近い敵（6歩以内）→ 開いていない宝箱 → 階段
  function goalOf(s) {
    const p = s.player;
    let best = null, bd = Infinity;
    for (const e of s.enemies) { const d = Sim.manhattan(p.x, p.y, e.x, e.y); if (d < bd) { bd = d; best = e; } }
    if (best && bd <= 6) return { x: best.x, y: best.y, kind: 'enemy' };
    if (s.chest && !s.chest.opened) return { x: s.chest.x, y: s.chest.y, kind: 'chest' };
    return { x: s.stairs.x, y: s.stairs.y, kind: 'stairs' };
  }

  // 次の手で発動する敵スキルが、そのマスに当たるか
  function skillDangerAt(s, x, y) {
    let d = 0;
    for (const e of s.enemies) {
      const def = Sim.ENEMIES[e.type];
      if (!def.skill || e.counter !== 1) continue;
      if (e.type === 'lizard' && Sim.manhattan(e.x, e.y, x, y) <= def.skill.range) d += def.skill.power;
      if (e.type === 'caterpillar' && Sim.chebyshev(e.x, e.y, x, y) <= 1) d += def.skill.power;
    }
    return d;
  }
  function meleeDangerAt(s, x, y) {
    let d = 0;
    for (const e of s.enemies) if (Sim.manhattan(e.x, e.y, x, y) === 1) d += Sim.ENEMIES[e.type].atk;
    return d;
  }
  // 自分のスキルが次の1歩で発動するとき、そのマスから何体に当たるか（威力の合計）
  function ownSkillGainAt(s, x, y) {
    let g = 0;
    for (const sk of s.player.skills) {
      if (sk.remaining !== 1) continue;
      const def = Sim.SKILLS[sk.id];
      const p = Sim.powerOf(sk);
      if (def.kind === 'area') g += p * s.enemies.filter(e => Sim.chebyshev(e.x, e.y, x, y) <= def.radius).length;
      else if (def.kind === 'adjacent') g += p * s.enemies.filter(e => Sim.manhattan(e.x, e.y, x, y) === 1).length;
      else if (def.kind === 'nearest') g += s.enemies.some(e => Sim.manhattan(e.x, e.y, x, y) <= def.range) ? p : 0;
      else if (def.kind === 'heal') g += Math.min(p, s.player.maxHp - s.player.hp);
    }
    return g;
  }

  function scoreActions(s, readCycle) {
    const p = s.player;
    const goal = goalOf(s);
    const dist = bfsFrom(s, goal.x, goal.y);
    const out = [];
    for (const a of Sim.legalActions(s)) {
      let x = p.x, y = p.y, gain = 0;
      if (a.type === 'move') {
        const e = Sim.enemyAt(s, p.x + a.dx, p.y + a.dy);
        if (e) {
          const dmg = Sim.playerAtk(s);
          gain += Math.min(dmg, e.hp) + (e.hp <= dmg ? 4 : 0);
        } else { x += a.dx; y += a.dy; }
        gain += ownSkillGainAt(s, x, y);
      }
      let danger = meleeDangerAt(s, x, y);
      if (readCycle) danger += skillDangerAt(s, x, y);
      const hpWeight = p.hp <= 8 ? 4 : p.hp <= 15 ? 2.5 : 1.5;
      const progress = dist[y][x] === Infinity ? 50 : dist[y][x];
      const score = gain - danger * hpWeight - progress * 0.6 + (a.type === 'wait' ? -0.2 : 0);
      out.push({ a, score });
    }
    return out;
  }

  function bestOf(scored, rng) {
    let best = -Infinity;
    for (const o of scored) if (o.score > best) best = o.score;
    const ties = scored.filter(o => o.score >= best - 1e-9);
    return ties[Math.floor(rng() * ties.length)].a;
  }

  // レベルアップの選び方
  function chooseLevelUp(s, rng, policy) {
    const ch = s.choices;
    if (policy && policy.onlySkill) {
      // 「特定スキルだけ」：その強化があれば取る。無ければパッシブ。新しいスキルは取らない
      let i = ch.findIndex(c => c.kind === 'upgrade' && c.id === policy.onlySkill);
      if (i < 0) i = ch.findIndex(c => c.kind === 'passive');
      if (i < 0) i = ch.findIndex(c => c.kind === 'upgrade');
      if (i < 0) i = 0;
      return { type: 'choose', index: i };
    }
    return { type: 'choose', index: Math.floor(rng() * ch.length) };
  }

  const BOTS = {
    random: {
      name: '何も考えない',
      choose(s, rng) {
        const acts = Sim.legalActions(s);
        return acts[Math.floor(rng() * acts.length)];
      },
    },
    waiter: {
      name: '待ち中心',
      choose(s, rng) {
        const p = s.player;
        for (const [dx, dy] of DIRS4) if (Sim.enemyAt(s, p.x + dx, p.y + dy)) return { type: 'move', dx, dy };
        if (rng() < 0.8) return { type: 'wait' };
        const dist = bfsFrom(s, s.stairs.x, s.stairs.y);
        let best = null, bd = dist[p.y][p.x];
        for (const [dx, dy] of DIRS4) {
          const nx = p.x + dx, ny = p.y + dy;
          if (Sim.passable(s, nx, ny) && dist[ny][nx] < bd) { bd = dist[ny][nx]; best = { type: 'move', dx, dy }; }
        }
        return best || { type: 'wait' };
      },
    },
    greedy: {
      name: '周期を読まない',
      choose(s, rng) { return bestOf(scoreActions(s, false), rng); },
    },
    reader: {
      name: '周期を読む（比較用）',
      choose(s, rng) { return bestOf(scoreActions(s, true), rng); },
    },
  };

  // 1手ぶんの行動を決める（フェーズも面倒を見る）
  function decide(botId, s, rng, policy) {
    if (s.phase === 'levelup') return chooseLevelUp(s, rng, policy);
    if (s.phase === 'stairs') return { type: 'stairs', choice: 'descend' }; // ボットは常に潜る（到達フロアを測るため）
    if (s.phase !== 'play') return null;
    return BOTS[botId].choose(s, rng);
  }

  function runOne(botId, seed, opts) {
    opts = opts || {};
    const s = Sim.newGame(seed, { startSkill: opts.startSkill });
    const rng = mulberry(seed * 7919 + 13);
    const maxTurns = opts.maxTurns || 800;
    let guard = 0;
    while (s.phase !== 'dead' && s.phase !== 'clear' && s.turn < maxTurns && guard < maxTurns * 3) {
      guard++;
      const a = decide(botId, s, rng, opts.policy);
      if (!a) break;
      Sim.act(s, a);
    }
    return {
      result: s.phase === 'clear' ? 'escaped' : s.phase === 'dead' ? 'dead' : 'timeout',
      floor: s.floor, kills: s.player.kills, turns: s.turn, steps: s.steps, hp: s.player.hp,
      damageTaken: s.stats.damageTaken, deathBySkill: !!s.deathBySkill, deathCause: s.deathCause,
      skillFires: s.stats.skillFires, skillDamage: s.stats.skillDamage, skillHeal: s.stats.skillHeal,
      waits: s.stats.waits, skills: s.player.skills.map(k => k.id), passives: s.player.passives.slice(),
      evolved: s.discoveries.indexOf('gouka') >= 0,
    };
  }

  function summarize(rows) {
    const n = rows.length;
    const cnt = (f) => rows.filter(f).length;
    const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / n;
    const deaths = rows.filter(r => r.result === 'dead');
    const dmg = {}, fires = {};
    for (const r of rows) {
      for (const k of Object.keys(r.skillDamage)) dmg[k] = (dmg[k] || 0) + r.skillDamage[k];
      for (const k of Object.keys(r.skillFires)) fires[k] = (fires[k] || 0) + r.skillFires[k];
    }
    return {
      n,
      winRate: cnt(r => r.result === 'escaped') / n,
      deadRate: cnt(r => r.result === 'dead') / n,
      timeoutRate: cnt(r => r.result === 'timeout') / n,
      meanFloor: mean(r => r.floor),
      floor3Rate: cnt(r => r.floor >= 3) / n,
      meanKills: mean(r => r.kills),
      meanTurns: mean(r => r.turns),
      meanDamage: mean(r => r.damageTaken),
      waitRatio: mean(r => r.turns ? r.waits / r.turns : 0),
      deathBySkillRate: deaths.length ? deaths.filter(r => r.deathBySkill).length / deaths.length : 0,
      evolvedRate: cnt(r => r.evolved) / n,
      skillDamage: dmg, skillFires: fires,
    };
  }

  function runMany(botId, n, opts) {
    const rows = [];
    for (let seed = 1; seed <= n; seed++) rows.push(runOne(botId, seed, opts));
    return summarize(rows);
  }

  const pct = (v) => (v * 100).toFixed(1) + '%';
  const f1 = (v) => v.toFixed(1);
  const f2 = (v) => v.toFixed(2);

  function main() {
    const n = Number(process.argv[2] || 500);
    const lines = [];
    const L = (t) => { lines.push(t); console.log(t); };

    L('## ボット検証（各 ' + n + ' 回、seed 1..' + n + '、開始スキル＝ほのお、階段では常に潜る）');
    L('');
    L('| ボット | 帰還率(3F踏破) | 死亡率 | 手数切れ | 平均到達フロア | 3F到達率 | 平均撃破 | 平均手数 | 平均被ダメ | 待ち割合 | 死因がスキル | 進化率 |');
    L('|---|---|---|---|---|---|---|---|---|---|---|---|');
    const results = {};
    for (const id of ['random', 'waiter', 'greedy', 'reader']) {
      const r = runMany(id, n);
      results[id] = r;
      L('| ' + BOTS[id].name + ' | ' + pct(r.winRate) + ' | ' + pct(r.deadRate) + ' | ' + pct(r.timeoutRate) + ' | ' + f2(r.meanFloor) + ' | ' + pct(r.floor3Rate) + ' | ' + f1(r.meanKills) + ' | ' + f1(r.meanTurns) + ' | ' + f1(r.meanDamage) + ' | ' + pct(r.waitRatio) + ' | ' + pct(r.deathBySkillRate) + ' | ' + pct(r.evolvedRate) + ' |');
    }
    L('');
    L('判定1「待ち続けるだけが一番得」：待ち中心ボットの帰還率・平均到達フロアが、周期を読まないボットより高ければ赤信号。');
    const w = results.waiter, g = results.greedy, rd = results.reader;
    L('- 待ち中心 ' + pct(w.winRate) + ' / ' + f2(w.meanFloor) + 'F　vs　周期を読まない ' + pct(g.winRate) + ' / ' + f2(g.meanFloor) + 'F　→ ' + (w.winRate > g.winRate || w.meanFloor > g.meanFloor ? '**赤信号（待ちが得）**' : '問題なし（待ちは得ではない）'));
    L('判定2「残り歩数を読むと変わるか」：周期を読むボットが読まないボットより良ければ、残り歩数の情報に意味がある。');
    L('- 周期を読む ' + pct(rd.winRate) + ' / ' + f2(rd.meanFloor) + 'F / 被ダメ ' + f1(rd.meanDamage) + '　vs　読まない ' + pct(g.winRate) + ' / ' + f2(g.meanFloor) + 'F / 被ダメ ' + f1(g.meanDamage) + '　→ ' + (rd.winRate > g.winRate && rd.meanDamage < g.meanDamage ? '読む方が得（情報に意味がある）' : '**差が出ていない（要検討）**'));
    L('');

    L('### 特定スキルだけが常に得か（周期を読まないボット、開始スキルを変え、レベルアップではそのスキルの強化を最優先・新スキルは取らない）');
    L('');
    L('| 開始スキル | 帰還率 | 死亡率 | 平均到達フロア | 平均撃破 | 平均被ダメ | そのスキルの発動回数/回 | そのスキルの与ダメ/回 |');
    L('|---|---|---|---|---|---|---|---|');
    const perSkill = {};
    for (const id of Sim.BASIC_SKILL_IDS) {
      const r = runMany('greedy', n, { startSkill: id, policy: { onlySkill: id } });
      perSkill[id] = r;
      const fires = (r.skillFires[id] || 0) / n;
      const dmg = id === 'kaifuku' ? '(回復)' : f1((r.skillDamage[id] || 0) / n);
      L('| ' + Sim.SKILLS[id].name + ' | ' + pct(r.winRate) + ' | ' + pct(r.deadRate) + ' | ' + f2(r.meanFloor) + ' | ' + f1(r.meanKills) + ' | ' + f1(r.meanDamage) + ' | ' + f1(fires) + ' | ' + dmg + ' |');
    }
    const wins = Sim.BASIC_SKILL_IDS.map(id => perSkill[id].winRate);
    const maxW = Math.max.apply(null, wins), minW = Math.min.apply(null, wins);
    const bestId = Sim.BASIC_SKILL_IDS[wins.indexOf(maxW)];
    L('');
    L('判定3「特定スキルだけが常に得」：帰還率の最大と最小の差が大きい（目安 15 ポイント超）なら赤信号。');
    L('- 最大 ' + Sim.SKILLS[bestId].name + ' ' + pct(maxW) + '、最小 ' + pct(minW) + '、差 ' + ((maxW - minW) * 100).toFixed(1) + 'pt → ' + ((maxW - minW) > 0.15 ? '**赤信号（' + Sim.SKILLS[bestId].name + 'だけが得）**' : '問題なし'));
    L('');
    L('### 周期を読むボットでも同じ比較');
    L('');
    L('| 開始スキル | 帰還率 | 死亡率 | 平均到達フロア | 平均被ダメ |');
    L('|---|---|---|---|---|');
    for (const id of Sim.BASIC_SKILL_IDS) {
      const r = runMany('reader', n, { startSkill: id, policy: { onlySkill: id } });
      L('| ' + Sim.SKILLS[id].name + ' | ' + pct(r.winRate) + ' | ' + pct(r.deadRate) + ' | ' + f2(r.meanFloor) + ' | ' + f1(r.meanDamage) + ' |');
    }
    return lines;
  }

  const Bots = { BOTS, decide, runOne, runMany, summarize, mulberry, main };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Bots;
    if (require.main === module) main();
  } else {
    root.Bots = Bots;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
