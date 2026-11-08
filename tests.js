/*
 * tests.js — 仕様書の数値が「文面どおり」に動くかを乱数なし条件で確かめる
 * 実行: node tests.js
 */
'use strict';
const Sim = require('./sim.js');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; failures.push(name + ': ' + e.message); console.log('FAIL ' + name + '\n     ' + e.message); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期待 ' + JSON.stringify(b) + ' / 実際 ' + JSON.stringify(a));
}
function ok(v, msg) { if (!v) throw new Error(msg || '期待が成り立たない'); }

// ---------- 道具：乱数の影響を消した「広間」を作る ----------
function arena(opts) {
  opts = opts || {};
  const s = Sim.newGame(opts.seed || 1, { startSkill: opts.startSkill });
  const rows = [];
  for (let y = 0; y < Sim.H; y++) {
    let r = '';
    for (let x = 0; x < Sim.W; x++) r += (x === 0 || y === 0 || x === Sim.W - 1 || y === Sim.H - 1) ? '#' : '.';
    rows.push(r);
  }
  s.map = rows;
  s.enemies = [];
  s.marks = {};
  s.shardsOnFloor = [];
  s.player.x = 10; s.player.y = 5;
  s.stairs = { x: 18, y: 9 };                 // 遠くに置いて邪魔にならないように
  s.chest = { x: 1, y: 1, opened: true, contents: { passive: null, upgrades: 0 } };
  if (opts.skills) s.player.skills = opts.skills.map(id => ({ id, lvl: 0, remaining: Sim.SKILLS[id].period }));
  return s;
}
function addEnemy(s, type, x, y) {
  const d = Sim.ENEMIES[type];
  const e = { id: 'e' + (s.nextId++), type, x, y, hp: d.hp, maxHp: d.hp, counter: d.skill ? d.skill.period : null };
  s.enemies.push(e);
  return e;
}
const move = (dx, dy) => ({ type: 'move', dx, dy });
const WAIT = { type: 'wait' };
function run(s, actions) { const all = []; for (const a of actions) all.push(...Sim.act(s, a)); return all; }
function repeat(s, action, n) { const all = []; for (let i = 0; i < n; i++) all.push(...Sim.act(s, action)); return all; }
// 左右に往復して歩数だけ稼ぐ（敵が居ない広間で使う）。pins を渡すと毎手、敵の位置を戻す
function walk(s, n, pins) {
  const all = [];
  for (let i = 0; i < n; i++) {
    all.push(...Sim.act(s, move(i % 2 === 0 ? 1 : -1, 0)));
    if (pins) for (const [e, x, y] of pins) { e.x = x; e.y = y; }
  }
  return all;
}

// ===================== プレイヤー =====================
test('プレイヤー：体力30・通常攻撃3・最初のスキルはほのお', () => {
  const s = Sim.newGame(1);
  eq(s.player.hp, 30); eq(s.player.maxHp, 30);
  eq(Sim.playerAtk(s), 3);
  eq(s.player.skills.length, 1); eq(s.player.skills[0].id, 'honoo'); eq(s.player.skills[0].remaining, 7);
  eq(s.player.passives.length, 0);
});

test('スキル表：発動までの歩数と威力が仕様書どおり', () => {
  const S = Sim.SKILLS;
  eq(S.honoo.period, 7);    eq(S.honoo.power, 4);    eq(S.honoo.radius, 1);
  eq(S.kaminari.period, 10); eq(S.kaminari.power, 7);
  eq(S.kaifuku.period, 12); eq(S.kaifuku.power, 4);
  eq(S.hayate.period, 5);   eq(S.hayate.power, 3);
  eq(S.gouka.period, 9);    eq(S.gouka.power, 6);    eq(S.gouka.radius, 2);
  eq(Sim.MAX_SKILLS, 3); eq(Sim.MAX_PASSIVES, 3);
});

test('敵表：体力・通常攻撃・スキルが仕様書どおり', () => {
  const E = Sim.ENEMIES;
  eq(E.rat.hp, 6); eq(E.rat.atk, 2); eq(E.rat.skill, null);
  eq(E.lizard.hp, 8); eq(E.lizard.atk, 2); eq(E.lizard.skill.period, 5); eq(E.lizard.skill.power, 4); eq(E.lizard.skill.range, 2);
  eq(E.caterpillar.hp, 10); eq(E.caterpillar.atk, 1); eq(E.caterpillar.skill.period, 7); eq(E.caterpillar.skill.power, 5);
});

test('ちから：通常攻撃＋1（3→4）', () => {
  const s = arena();
  s.player.passives.push('chikara');
  eq(Sim.playerAtk(s), 4);
  const e = addEnemy(s, 'rat', 11, 5);
  Sim.act(s, move(1, 0));
  eq(e.hp, 2);
});

test('はやあし：発動までの歩数－1、最低3歩', () => {
  const s = arena();
  s.player.passives.push('hayaashi');
  eq(Sim.periodOf(s, Sim.SKILLS.honoo), 6);
  eq(Sim.periodOf(s, Sim.SKILLS.kaminari), 9);
  eq(Sim.periodOf(s, Sim.SKILLS.kaifuku), 11);
  eq(Sim.periodOf(s, Sim.SKILLS.hayate), 4);
  eq(Sim.periodOf(s, { period: 3 }), 3, '3歩のものは3のまま');
  eq(Sim.periodOf(s, { period: 4 }), 3);
  const t = arena();
  eq(Sim.periodOf(t, Sim.SKILLS.honoo), 7, 'はやあし無しなら元のまま');
});

test('いのち：最大体力＋10、取ったときに10回復', () => {
  const s = arena();
  s.player.hp = 15;
  s.phase = 'levelup';
  s.choices = [{ kind: 'passive', id: 'inochi' }];
  Sim.act(s, { type: 'choose', index: 0 });
  eq(s.player.maxHp, 40); eq(s.player.hp, 25);
  eq(s.phase, 'play');
});

// ===================== 歩数と発動 =====================
test('歩くと自分のスキルも敵の周期も1減る', () => {
  const s = arena();
  const e = addEnemy(s, 'lizard', 15, 9);
  Sim.act(s, move(1, 0));
  eq(s.player.skills[0].remaining, 6); eq(e.counter, 4); eq(s.steps, 1); eq(s.turn, 1);
});

test('待つと敵の周期は進むが、自分のスキルの残りは減らない', () => {
  const s = arena();
  const e = addEnemy(s, 'lizard', 15, 9);
  Sim.act(s, WAIT);
  eq(s.player.skills[0].remaining, 7); eq(e.counter, 4); eq(s.steps, 0); eq(s.turn, 1);
});

test('隣の敵を攻撃しても1歩として数える（両方の残りが減る）', () => {
  const s = arena();
  const e = addEnemy(s, 'lizard', 11, 5);
  const ev = Sim.act(s, move(1, 0));
  ok(ev.some(v => v.t === 'attack' && v.amount === 3), '攻撃イベント');
  eq(e.hp, 5);
  eq(s.player.skills[0].remaining, 6); eq(e.counter, 4);
  eq(s.player.x, 10, '敵がいるマスには進まない');
});

test('壁に進もうとしても手番は進まない', () => {
  const s = arena();
  s.player.x = 1; s.player.y = 1;
  const ev = Sim.act(s, move(-1, 0));
  eq(ev.length, 0); eq(s.turn, 0); eq(s.player.skills[0].remaining, 7);
});

test('ほのお：7歩目に自動発動、周囲1マス（斜め含む）の敵全員に4、残りは7に戻る', () => {
  const s = arena();
  // 6歩分、敵の居ないところで歩く（敵は遠くに置かない：ここでは無し）
  walk(s, 6);
  eq(s.player.skills[0].remaining, 1);
  // 7歩目の着地点 (11,5) の周囲に敵を置く
  const a = addEnemy(s, 'rat', 12, 5);          // 隣
  const b = addEnemy(s, 'caterpillar', 12, 6);  // 斜め
  const c = addEnemy(s, 'caterpillar', 13, 5);  // 距離2（当たらない）
  c.counter = 99; b.counter = 99;
  const ev = Sim.act(s, move(1, 0));
  const sk = ev.find(v => v.t === 'skill' && v.who === 'player');
  ok(sk && sk.skill === 'honoo', 'ほのお発動イベント');
  eq(sk.hits.length, 2);
  eq(a.hp, 2); eq(b.hp, 6); eq(c.hp, 10);
  eq(s.player.skills[0].remaining, 7);
  eq(s.steps, 7);
});

test('かみなり：10歩目に、いちばん近い敵1体だけに7', () => {
  const s = arena({ skills: ['kaminari'] });
  const near = addEnemy(s, 'caterpillar', 10, 8);  // 距離3（9歩後の着地 (11,5) からは4）
  const far = addEnemy(s, 'caterpillar', 17, 5);   // 距離7（着地 (11,5) からは6）
  near.counter = far.counter = 99;
  walk(s, 9, [[near, 10, 8], [far, 17, 5]]);
  eq(s.player.skills[0].remaining, 1);
  eq(s.player.x + ',' + s.player.y, '11,5');
  Sim.act(s, move(-1, 0)); // 10歩目、着地 (10,5)
  eq(near.hp, 3); eq(far.hp, 10);
  eq(s.player.skills[0].remaining, 10);
});

test('かいふくの風：12歩目に体力を4回復（最大を超えない）', () => {
  const s = arena({ skills: ['kaifuku'] });
  s.player.hp = 20;
  walk(s, 12);
  eq(s.player.hp, 24);
  eq(s.player.skills[0].remaining, 12);
  s.player.hp = 29;
  walk(s, 12);
  eq(s.player.hp, 30, '上限は最大体力');
});

test('はやての刃：5歩目に隣（上下左右）の敵全員に3。斜めには当たらない', () => {
  const s = arena({ skills: ['hayate'] });
  walk(s, 4);
  eq(s.player.x + ',' + s.player.y, '10,5');
  // 5歩目の着地点は (9,5)
  const a = addEnemy(s, 'caterpillar', 9, 4);
  const b = addEnemy(s, 'caterpillar', 9, 6);
  const c = addEnemy(s, 'caterpillar', 10, 6); // 斜め
  a.counter = b.counter = c.counter = 99;
  Sim.act(s, move(-1, 0));
  eq(a.hp, 7); eq(b.hp, 7); eq(c.hp, 10);
  eq(s.player.skills[0].remaining, 5);
});

test('強化：1回ごとに威力＋2（ほのお 4→6→8）※仕様書に無い値', () => {
  const s = arena();
  eq(Sim.powerOf({ id: 'honoo', lvl: 0 }), 4);
  eq(Sim.powerOf({ id: 'honoo', lvl: 1 }), 6);
  eq(Sim.powerOf({ id: 'honoo', lvl: 2 }), 8);
  eq(Sim.skillLabel({ id: 'honoo', lvl: 2 }), 'ほのお+2');
  eq(Sim.skillDesc({ id: 'honoo', lvl: 2 }), '周囲1マスの敵全員に8');
});

// ===================== 敵 =====================
test('かみつきネズミ：隣で2ダメージ、スキルなし', () => {
  const s = arena();
  const e = addEnemy(s, 'rat', 11, 5);
  const ev = Sim.act(s, WAIT);
  ok(ev.some(v => v.t === 'eattack' && v.amount === 2));
  eq(s.player.hp, 28); eq(e.counter, null);
});

test('とびつきトカゲ：5手目に2マス先から飛びついて4。隣に移動する', () => {
  const s = arena();
  const e = addEnemy(s, 'lizard', 12, 5); // 距離2
  // 4手待つ（残り 4,3,2,1）。トカゲは近づいてくるので毎回位置を戻す
  for (let i = 0; i < 4; i++) { Sim.act(s, WAIT); e.x = 12; e.y = 5; }
  eq(e.counter, 1);
  const ev = Sim.act(s, WAIT);
  const sk = ev.find(v => v.t === 'skill' && v.who === 'enemy');
  ok(sk && sk.hit, '飛びつきが当たる');
  eq(s.player.hp, 26);
  eq(Sim.manhattan(e.x, e.y, s.player.x, s.player.y), 1, '隣に飛びついている');
  eq(e.counter, 5, '残りは5に戻る');
});

test('とびつきトカゲ：3マス離れていれば飛びつきは届かない（空振り）', () => {
  const s = arena();
  const e = addEnemy(s, 'lizard', 13, 5); // 距離3
  for (let i = 0; i < 4; i++) { Sim.act(s, WAIT); e.x = 13; e.y = 5; }
  const ev = Sim.act(s, WAIT);
  const sk = ev.find(v => v.t === 'skill' && v.who === 'enemy');
  ok(sk && !sk.hit, '空振りイベント');
  eq(s.player.hp, 30);
  eq(e.counter, 5);
});

test('ほのおイモムシ：7手目に周囲1マス（斜め含む）へ炎5。他の敵にも当たる', () => {
  const s = arena();
  const c = addEnemy(s, 'caterpillar', 11, 6); // 斜め隣
  const r = addEnemy(s, 'rat', 12, 7);         // イモムシの斜め隣
  const far = addEnemy(s, 'rat', 15, 9);
  for (let i = 0; i < 6; i++) { Sim.act(s, WAIT); c.x = 11; c.y = 6; r.x = 12; r.y = 7; far.x = 15; far.y = 9; }
  eq(c.counter, 1);
  const hpBefore = s.player.hp;
  const ev = Sim.act(s, WAIT);
  const sk = ev.find(v => v.t === 'skill' && v.who === 'enemy' && v.type === 'caterpillar');
  ok(sk && sk.hit, '炎が自分に当たる');
  eq(hpBefore - s.player.hp, 5, '炎5（発動の手はかみつかない）');
  eq(r.hp, 1, 'ネズミも炎で5受ける');
  eq(far.hp, 6, '遠いネズミは無傷');
  eq(c.counter, 7);
});

test('ほのおイモムシ：2マス離れていれば炎は当たらない', () => {
  const s = arena();
  const c = addEnemy(s, 'caterpillar', 12, 5);
  for (let i = 0; i < 6; i++) { Sim.act(s, WAIT); c.x = 12; c.y = 5; }
  Sim.act(s, WAIT);
  eq(s.player.hp, 30);
});

test('残り歩数が1になった手で warn イベントが出る（迫る音の合図）', () => {
  const s = arena();
  const e = addEnemy(s, 'lizard', 15, 9);
  let ev = [];
  for (let i = 0; i < 4; i++) { ev = Sim.act(s, WAIT); e.x = 15; e.y = 9; }
  ok(ev.some(v => v.t === 'warn' && v.who === 'enemy'), '敵の残り1で warn');
  const t = arena();
  walk(t, 5);
  const ev2 = Sim.act(t, move(1, 0));
  ok(ev2.some(v => v.t === 'warn' && v.who === 'player'), '自分の残り1で warn');
});

// ===================== 痕跡 =====================
test('足跡：自分の足跡は20歩で消える。めじるし読みで40歩', () => {
  const s = arena();
  Sim.act(s, move(1, 0));
  const k = '10,5';
  ok(s.marks[k] && s.marks[k].kind === 'player', '離れたマスに足跡');
  repeat(s, WAIT, 18);
  ok(s.marks[k], '19手目まで残っている');
  repeat(s, WAIT, 1);
  ok(!s.marks[k], '20手目で消える');

  const t = arena();
  t.player.passives.push('mejirushi');
  eq(Sim.markLife(t), 40);
  Sim.act(t, move(1, 0));
  repeat(t, WAIT, 38);
  ok(t.marks[k], '39手目まで残っている');
  repeat(t, WAIT, 1);
  ok(!t.marks[k], '40手目で消える');
});

test('痕跡：敵が通った場所に足跡。傷を負った敵が動くと血痕', () => {
  const s = arena();
  const e = addEnemy(s, 'rat', 14, 5);
  Sim.act(s, WAIT);                 // ネズミが近づく
  ok(s.marks['14,5'] && s.marks['14,5'].kind === 'enemy', '無傷なら足跡');
  e.hp = 4;
  const from = e.x + ',' + e.y;
  Sim.act(s, WAIT);
  ok(s.marks[from] && s.marks[from].kind === 'blood', '傷ついていれば血痕');
});

test('とびつきトカゲは、新しい自分の足跡の方向へ寄ってくる', () => {
  const s = arena();
  // プレイヤーが (10,5)→(11,5)→(12,5)→(13,5) と歩く。足跡は 10,5(古い) 11,5 12,5(新しい)
  const e = addEnemy(s, 'lizard', 9, 5); // プレイヤーの後ろ（最初の足跡 10,5 に隣接）
  e.counter = 99;
  Sim.act(s, move(1, 0)); // 10,5 に足跡。トカゲは追跡距離内なので足跡 10,5 へ
  eq(e.x + ',' + e.y, '10,5');
  Sim.act(s, move(1, 0)); // 11,5 に足跡
  eq(e.x + ',' + e.y, '11,5');
  // 古い足跡と新しい足跡が両方隣にあるとき、新しい方へ
  const t = arena();
  t.marks['9,9'] = { kind: 'player', age: 10 };
  t.marks['11,9'] = { kind: 'player', age: 2 };
  const f = addEnemy(t, 'lizard', 10, 9);
  f.counter = 99;
  Sim.act(t, WAIT);
  eq(f.x + ',' + f.y, '11,9');
});

// ===================== 入手・成長 =====================
test('敵を倒すとかけらが落ち、拾って3個でレベルアップ（候補3つ）', () => {
  const s = arena();
  const e = addEnemy(s, 'rat', 11, 5);
  e.hp = 3;
  let ev = Sim.act(s, move(1, 0));
  ok(ev.some(v => v.t === 'die'), '倒した');
  eq(s.shardsOnFloor.length, 1); eq(s.shardsOnFloor[0].x, 11);
  s.player.shards = 2;
  ev = Sim.act(s, move(1, 0));
  ok(ev.some(v => v.t === 'pickup'), '拾った');
  eq(s.phase, 'levelup');
  eq(s.choices.length, 3);
  eq(s.player.shards, 0);
  for (const c of s.choices) { ok(c.label && c.desc, '候補に表示文がある'); }
  Sim.act(s, { type: 'choose', index: 0 });
  eq(s.phase, 'play');
});

test('スキルは最大3つ：3つ持っていると新しいスキルは候補に出ない', () => {
  const s = arena({ skills: ['honoo', 'kaminari', 'hayate'] });
  for (let i = 0; i < 20; i++) {
    const ch = Sim._internal.genChoices(s);
    ok(ch.every(c => c.kind !== 'skill'), '新しいスキルが候補に出た');
  }
});

test('進化：ほのお+2 と ちから を持って宝箱を開けると ごうか（9歩・周囲2マス・6）', () => {
  const s = arena();
  s.player.skills[0].lvl = 2;
  s.player.passives.push('chikara');
  s.chest = { x: 11, y: 5, opened: false, contents: { passive: null, upgrades: 0 } };
  const ev = Sim.act(s, move(1, 0));
  ok(ev.some(v => v.t === 'evolve' && v.to === 'gouka'), '進化イベント');
  const sk = s.player.skills[0];
  eq(sk.id, 'gouka'); eq(sk.lvl, 0); eq(sk.remaining, 9);
  eq(Sim.powerOf(sk), 6);
  ok(s.discoveries.indexOf('gouka') >= 0, '図鑑に残る');
  // 周囲2マスに当たる。9歩歩いた着地点は (12,5)
  const a = addEnemy(s, 'caterpillar', 14, 7); // (12,5) から縦横とも2 → 周囲2マス
  const b = addEnemy(s, 'caterpillar', 15, 5); // 距離3 → 当たらない
  a.counter = b.counter = 99;
  walk(s, 9, [[a, 14, 7], [b, 15, 5]]);
  eq(s.player.x + ',' + s.player.y, '12,5');
  eq(a.hp, 4); eq(b.hp, 10);
});

test('進化の条件が欠けていると進化しない（ちから無し／強化1回）', () => {
  const s = arena();
  s.player.skills[0].lvl = 2;
  s.chest = { x: 11, y: 5, opened: false, contents: { passive: null, upgrades: 0 } };
  Sim.act(s, move(1, 0));
  eq(s.player.skills[0].id, 'honoo', 'ちから無し');
  const t = arena();
  t.player.skills[0].lvl = 1;
  t.player.passives.push('chikara');
  t.chest = { x: 11, y: 5, opened: false, contents: { passive: null, upgrades: 0 } };
  Sim.act(t, move(1, 0));
  eq(t.player.skills[0].id, 'honoo', '強化1回');
});

test('宝箱：1フロアに1つ。中身は入った時点で見える（ラベルがある）', () => {
  const s = Sim.newGame(3);
  ok(s.chest && !s.chest.opened);
  ok(Sim.chestLabel(s).length > 0, '中身のラベル');
  ok(s.chest.contents.passive, '1Fの目玉はパッシブ');
  eq(s.chest.contents.upgrades, 0);
});

// ===================== フロアと終了 =====================
test('階段：1Fでは「帰る／潜る」を選ぶ。帰ると成功として終了', () => {
  const s = arena();
  s.stairs = { x: 11, y: 5 };
  const ev = Sim.act(s, move(1, 0));
  eq(s.phase, 'stairs');
  ok(ev.some(v => v.t === 'stairs'));
  Sim.act(s, { type: 'stairs', choice: 'leave' });
  eq(s.phase, 'clear'); eq(s.result, 'returned'); eq(s.floor, 1);
});

test('階段：潜ると次のフロア。3フロア目の階段で帰還', () => {
  const s = arena();
  s.stairs = { x: 11, y: 5 };
  Sim.act(s, move(1, 0));
  Sim.act(s, { type: 'stairs', choice: 'descend' });
  eq(s.floor, 2); eq(s.phase, 'play');
  ok(s.enemies.length > 0, '新しいフロアに敵がいる');
  eq(Sim.FLOORS, 3);
  s.floor = 3;
  s.map = arena().map; s.enemies = []; s.player.x = 10; s.player.y = 5; s.stairs = { x: 11, y: 5 };
  Sim.act(s, move(1, 0));
  eq(s.phase, 'clear'); eq(s.result, 'escaped');
});

test('死んだら死因が1行で残る', () => {
  const s = arena();
  s.player.hp = 2;
  addEnemy(s, 'rat', 11, 5);
  const ev = Sim.act(s, WAIT);
  eq(s.phase, 'dead');
  eq(s.deathCause, 'かみつきネズミのかみつき（2ダメージ）');
  ok(ev.some(v => v.t === 'death'));
  eq(Sim.act(s, WAIT).length, 0, '死後は何も起きない');
});

test('死因：トカゲの飛びつきで死ぬと bySkill が立つ（周期読み違えの表示に使う）', () => {
  const s = arena();
  s.player.hp = 4;
  const e = addEnemy(s, 'lizard', 12, 5);
  for (let i = 0; i < 4; i++) { Sim.act(s, WAIT); e.x = 12; e.y = 5; }
  Sim.act(s, WAIT);
  eq(s.phase, 'dead');
  eq(s.deathCause, 'とびつきトカゲの飛びつき（4ダメージ）');
  eq(s.deathBySkill, true);
});

test('seed を固定すると同じフロアになる。違う seed なら違う', () => {
  const a = Sim.newGame(42), b = Sim.newGame(42), c = Sim.newGame(43);
  eq(a.map.join('|'), b.map.join('|'));
  eq(JSON.stringify(a.enemies), JSON.stringify(b.enemies));
  eq(a.player.x + ',' + a.player.y, b.player.x + ',' + b.player.y);
  ok(a.map.join('|') !== c.map.join('|') || JSON.stringify(a.enemies) !== JSON.stringify(c.enemies), '違う seed');
});

test('フロア生成：部屋3つ＋通路。開始地点から階段・宝箱へ歩いて行ける', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const s = Sim.newGame(seed);
    eq(s.rooms.length, 3, 'seed ' + seed);
    const dist = Sim.bfsFromPlayer(s);
    ok(dist[s.stairs.y][s.stairs.x] < Infinity, 'seed ' + seed + ' 階段に届かない');
    ok(dist[s.chest.y][s.chest.x] < Infinity, 'seed ' + seed + ' 宝箱に届かない');
    for (const e of s.enemies) ok(dist[e.y][e.x] < Infinity && dist[e.y][e.x] > 1, 'seed ' + seed + ' 敵の位置');
    eq(s.enemies.length, 3, 'seed ' + seed + ' 1Fの敵は3体');
  }
});

test('イベントの説明文：主な出来事が日本語1行になる', () => {
  eq(Sim.describe({ t: 'wait' }), '待った');
  eq(Sim.describe({ t: 'attack', type: 'rat', amount: 3 }), 'かみつきネズミに3のダメージ');
  eq(Sim.describe({ t: 'skill', who: 'player', skill: 'honoo', name: 'ほのお', hits: [{ type: 'rat', amount: 4 }], heal: 0 }), 'ほのお発動！ かみつきネズミに4');
  eq(Sim.describe({ t: 'skill', who: 'enemy', type: 'lizard', name: 'とびつきトカゲ', skill: '飛びつき', hit: false }), 'とびつきトカゲの飛びつき！ 届かなかった');
  eq(Sim.describe({ t: 'death', cause: 'X（4ダメージ）' }), '倒れた。死因：X（4ダメージ）');
});

// ===================== まとめ =====================
console.log('\n' + passed + ' 件 合格 / ' + failed + ' 件 不合格');
if (failed) { console.log(failures.join('\n')); process.exit(1); }
