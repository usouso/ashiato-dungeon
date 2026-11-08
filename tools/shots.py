#!/usr/bin/env python
"""
画面確認：スクリーンショットを screenshots/ に保存し、文字の重なり・はみ出し・小さい文字を検査する。

使い方（Python venv は ~/workspace/.venv-pw、Chromium は ~/.cache/ms-playwright）:
  ~/workspace/.venv-pw/bin/python tools/shots.py

index.html を file:// で開く（ビルド不要・サーバ不要）。結果は screenshots/check.json と標準出力。
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'screenshots')
URL = 'file://' + os.path.join(ROOT, 'index.html')
SEED = 7

VIEWPORTS = {
    'pc': {'width': 1280, 'height': 800},
    'sp': {'width': 390, 'height': 844},
}

# ページ内で動かす検査。文字の矩形を集め、重なり／画面外／小さい文字を数える
CHECK_JS = r"""
() => {
  const vw = innerWidth;
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const s = n.textContent.trim();
    if (!s) continue;
    const el = n.parentElement;
    if (!el || el.closest('.hidden') || el.closest('script') || el.closest('style')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const b of range.getClientRects()) {
      if (b.width <= 0 || b.height <= 0) continue;
      texts.push({ el, text: s.slice(0, 40), l: b.left, t: b.top, r: b.right, b: b.bottom,
                   font: parseFloat(cs.fontSize), inOverlay: !!el.closest('.overlay') });
    }
  }
  const issues = [];
  for (const t of texts) {
    if (t.font < 13) issues.push({ kind: 'small-font', text: t.text, size: t.font });
    if (t.l < -1 || t.r > vw + 1) issues.push({ kind: 'offscreen-x', text: t.text, l: Math.round(t.l), r: Math.round(t.r), vw });
    // overflow:hidden の親からはみ出していないか
    let p = t.el.parentElement;
    while (p && p !== document.body) {
      const pcs = getComputedStyle(p);
      if (pcs.overflow !== 'visible' || pcs.overflowX !== 'visible' || pcs.overflowY !== 'visible') {
        const pb = p.getBoundingClientRect();
        if (pcs.overflowX !== 'auto' && pcs.overflowX !== 'scroll' && (t.l < pb.left - 1 || t.r > pb.right + 1))
          issues.push({ kind: 'clipped-x', text: t.text, parent: p.id || p.className });
        if (pcs.overflowY !== 'auto' && pcs.overflowY !== 'scroll' && (t.t < pb.top - 1 || t.b > pb.bottom + 1))
          issues.push({ kind: 'clipped-y', text: t.text, parent: p.id || p.className });
        break;
      }
      p = p.parentElement;
    }
  }
  const anyOverlay = texts.some(t => t.inOverlay);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (anyOverlay && a.inOverlay !== b.inOverlay) continue; // 重ねる画面の下の文字は隠れていてよい
      const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (w > 2 && h > 2) issues.push({ kind: 'overlap', a: a.text, b: b.text, w: Math.round(w), h: Math.round(h) });
    }
  }
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) issues.push({ kind: 'page-hscroll', scrollWidth: de.scrollWidth, clientWidth: de.clientWidth });
  return { texts: texts.length, issues };
}
"""


def shot(page, name, results):
    path = os.path.join(OUT, name + '.png')
    page.screenshot(path=path, full_page=True)
    res = page.evaluate(CHECK_JS)
    res['name'] = name
    results.append(res)
    flag = 'OK ' if not res['issues'] else 'NG '
    print(f"{flag}{name}: 文字 {res['texts']} 個, 問題 {len(res['issues'])} 件")
    for it in res['issues'][:8]:
        print('    ', json.dumps(it, ensure_ascii=False))


def run():
    os.makedirs(OUT, exist_ok=True)
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for vp_name, vp in VIEWPORTS.items():
            ctx = browser.new_context(viewport=vp, device_scale_factor=1)
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

            # 1. 開始直後
            page.goto(f'{URL}?seed={SEED}&mute=1')
            page.wait_for_function('window.__game && window.__game.state')
            shot(page, f'{vp_name}-01-start', results)

            # 2. 自動プレイの途中（?auto=1）
            page.goto(f'{URL}?seed={SEED}&auto=1')
            page.wait_for_function('window.__game && window.__game.state')
            time.sleep(4.0)
            page.evaluate('window.__game.pauseAuto()')
            time.sleep(0.4)
            shot(page, f'{vp_name}-02-auto', results)
            # 自動プレイを続けて、途中の数か所でも検査（文字の重なりは動いている最中に出やすい）
            page.evaluate('window.__game.resumeAuto()')
            for k in range(3):
                time.sleep(2.0)
                page.evaluate('window.__game.pauseAuto()')
                time.sleep(0.3)
                shot(page, f'{vp_name}-02-auto-{k + 1}', results)
                page.evaluate('window.__game.resumeAuto()')
            page.evaluate('window.__game.stopAuto()')

            # 3. レベルアップの画面
            page.goto(f'{URL}?seed={SEED}&mute=1')
            page.wait_for_function('window.__game && window.__game.state')
            page.evaluate("""() => {
              const g = window.__game, s = g.state;
              s.player.shards = 3;
              s.choices = g.Sim._internal.genChoices(s);
              s.phase = 'levelup';
              g.render();
            }""")
            shot(page, f'{vp_name}-03-levelup', results)
            page.evaluate("window.__game.act({type:'choose', index:0})")

            # 4. 階段の画面
            page.evaluate("""() => {
              const g = window.__game, s = g.state;
              s.phase = 'stairs'; g.render();
            }""")
            shot(page, f'{vp_name}-04-stairs', results)

            # 5. 死亡の画面（トカゲの飛びつきで倒れる）
            page.evaluate("""() => {
              const g = window.__game, s = g.state;
              s.phase = 'play';
              s.player.hp = 3;
              s.enemies = [];
              const d = g.Sim.ENEMIES.lizard;
              const free = [[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy]) => [s.player.x+dx*2, s.player.y+dy*2]).find(([x,y]) => g.Sim.passable(s,x,y));
              const [x,y] = free || [s.player.x, s.player.y];
              s.enemies.push({ id:'ez', type:'lizard', x, y, hp:d.hp, maxHp:d.hp, counter:1 });
              g.render();
              g.act({type:'wait'});
            }""")
            shot(page, f'{vp_name}-05-dead', results)

            # 6. 帰還の画面
            page.evaluate("""() => {
              const g = window.__game, s = g.state;
              g.restart(7); const t = g.state; t.phase = 'clear'; t.result = 'escaped'; t.floor = 3; g.render();
            }""")
            shot(page, f'{vp_name}-06-clear', results)

            # 7. 設定
            page.evaluate("() => { const g = window.__game; g.restart(7); }")
            page.click('#btn-settings')
            shot(page, f'{vp_name}-07-settings', results)
            page.click('#btn-settings-close')

            if errors:
                results.append({'name': f'{vp_name}-console', 'texts': 0, 'issues': [{'kind': 'console-error', 'text': e} for e in errors]})
                print(f'NG {vp_name}: コンソールのエラー {len(errors)} 件')
                for e in errors[:5]:
                    print('    ', e)
            ctx.close()
        browser.close()

    with open(os.path.join(OUT, 'check.json'), 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    total = sum(len(r['issues']) for r in results)
    print(f'\n合計 {len(results)} 画面、問題 {total} 件 → screenshots/check.json')
    return 0 if total == 0 else 1


if __name__ == '__main__':
    sys.exit(run())
