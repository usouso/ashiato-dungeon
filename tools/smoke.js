// 手早い動作確認用：seed を渡して 1 フロアを文字で表示し、適当に動かしてログを出す
// 使い方: node tools/smoke.js [seed] [turns]
const Sim = require('../sim.js');
const seed = Number(process.argv[2] || 1);
const maxTurns = Number(process.argv[3] || 60);
const s = Sim.newGame(seed);

function draw(s) {
  const rows = s.map.map(r => r.split(''));
  for (const k of Object.keys(s.marks)) {
    const [x, y] = k.split(',').map(Number);
    const m = s.marks[k];
    rows[y][x] = m.kind === 'blood' ? '~' : m.kind === 'player' ? ',' : '`';
  }
  for (const sh of s.shardsOnFloor) rows[sh.y][sh.x] = '*';
  rows[s.stairs.y][s.stairs.x] = '>';
  if (!s.chest.opened) rows[s.chest.y][s.chest.x] = '$';
  for (const e of s.enemies) rows[e.y][e.x] = Sim.ENEMIES[e.type].glyph[0];
  rows[s.player.y][s.player.x] = '@';
  return rows.map(r => r.join('')).join('\n');
}

console.log(draw(s));
console.log('player', s.player.x, s.player.y, 'stairs', s.stairs, 'chest', Sim.chestLabel(s));
console.log(s.enemies.map(e => `${e.type}@${e.x},${e.y} hp${e.hp} c${e.counter}`).join(' | '));
let turns = 0;
while (s.phase !== 'dead' && s.phase !== 'clear' && turns < maxTurns) {
  const acts = Sim.legalActions(s);
  const a = acts[(turns * 7) % acts.length];
  const ev = Sim.act(s, a);
  turns++;
  for (const e of ev) { const d = Sim.describe(e); if (d) console.log(turns, d); }
}
console.log(draw(s));
console.log('phase', s.phase, 'hp', s.player.hp, 'turn', s.turn, 'steps', s.steps, 'marks', Object.keys(s.marks).length);
console.log('skills', s.player.skills, 'passives', s.player.passives);
