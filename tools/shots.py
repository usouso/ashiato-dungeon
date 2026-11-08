#!/usr/bin/env python
"""
画面確認：スクリーンショットを screenshots/ に保存し、文字の重なり・はみ出し・小さい文字を検査する。

使い方（Python venv は ~/workspace/.venv-pw、Chromium は ~/.cache/ms-playwright）:
  ~/workspace/.venv-pw/bin/python tools/shots.py            # 結果は screenshots/check.json
  ~/workspace/.venv-pw/bin/python tools/shots.py 名前.json  # 結果ファイル名を変える（修正前後の比較用）

index.html を file:// で開く（ビルド不要・サーバ不要）。

検査の決め事（修正ラウンド1で見直し。Codex 指摘3）
- 数えるのは「実際に画面に見えている部分」だけ。
  - 横は画面幅の中だけ（ページの縦スクロールで見える範囲は全部見える扱い）。
  - overflow が visible でない親（ログの欄、地図の横スクロール領域など）の箱で切り取る。
    切り取って何も残らない文字（スクロールで隠れた行、横スクロール領域の外側）は数えない。
  - 重ねる画面（レベルアップ・設定など）が開いているときは、その背後の文字は数えない。
- 旧検査（矩形をそのまま比べる）で出ていた件数も同時に数え、見える範囲では問題にならなかったものを
  「誤検知」として理由つきで別に記録する（falsePositives）。REPORT の「実害／誤検知」の内訳の根拠。
- 遊んでいる最中の画面（02-*）では、スクロールせずに「地図」「敵の頭上の残り歩数」「操作ボタン」が
  同じ画面に入っているかも検査する（not-in-first-screen）。
- 自動プレイ中の画面は、時間待ちではなく「周期を読むボット」を決まった手数だけ進めて撮る（毎回同じ画面）。
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
BOT_RNG_SEED = 123
PLAY_STEPS = [20, 15, 15, 15]   # 02-auto, 02-auto-1, -2, -3 の手数（累積 20, 35, 50, 65）

VIEWPORTS = {
    'pc': {'width': 1280, 'height': 800},
    'sp': {'width': 390, 'height': 844},
}

# ページ内で動かす検査
CHECK_JS = r"""
() => {
  const vw = innerWidth, vh = innerHeight;
  const inter = (a, b) => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
  const empty = (r) => r.r - r.l <= 0 || r.b - r.t <= 0;
  const overlayOpen = Array.from(document.querySelectorAll('.overlay'))
    .some(o => !o.classList.contains('hidden') && getComputedStyle(o).display !== 'none');

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
    const inOverlay = !!el.closest('.overlay');
    // 切り取る親（overflow が visible でないもの）を集める
    const clips = [];
    let p = el.parentElement;
    while (p && p !== document.body) {
      const pcs = getComputedStyle(p);
      if (pcs.overflow !== 'visible' || pcs.overflowX !== 'visible' || pcs.overflowY !== 'visible') {
        const pb = p.getBoundingClientRect();
        clips.push({
          el: p,
          box: { l: pb.left + p.clientLeft, t: pb.top + p.clientTop, r: pb.left + p.clientLeft + p.clientWidth, b: pb.top + p.clientTop + p.clientHeight },
          scrollX: pcs.overflowX === 'auto' || pcs.overflowX === 'scroll',
          scrollY: pcs.overflowY === 'auto' || pcs.overflowY === 'scroll',
        });
      }
      p = p.parentElement;
    }
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const b of range.getClientRects()) {
      if (b.width <= 0 || b.height <= 0) continue;
      const raw = { l: b.left, t: b.top, r: b.right, b: b.bottom };
      let vis = inter(raw, { l: 0, t: -Infinity, r: vw, b: Infinity });
      let reason = empty(vis) ? 'outside-viewport-x' : null;
      for (const c of clips) {
        if (reason) break;
        vis = inter(vis, c.box);
        if (empty(vis)) reason = (c.scrollX || c.scrollY) ? 'hidden-by-scroll' : 'clipped-by-parent';
      }
      if (!reason && overlayOpen && !inOverlay) reason = 'behind-modal';
      texts.push({ el, text: s.slice(0, 40), raw, vis, reason, font: parseFloat(cs.fontSize), inOverlay, clips });
    }
  }

  const issues = [];
  const falsePositives = [];
  const visible = texts.filter(t => !t.reason);

  for (const t of texts) {
    // 小さい文字（見えているものだけ）
    if (!t.reason && t.font < 13) issues.push({ kind: 'small-font', text: t.text, size: t.font });
    // 画面の横幅からはみ出す文字。横スクロールできる親の中なら、スクロールで見えるので誤検知
    if (t.raw.l < -1 || t.raw.r > vw + 1) {
      const inHScroll = t.clips.some(c => c.scrollX);
      if (inHScroll || t.reason === 'behind-modal') falsePositives.push({ kind: 'offscreen-x', text: t.text, reason: inHScroll ? 'inside-hscroll' : t.reason });
      else issues.push({ kind: 'offscreen-x', text: t.text, l: Math.round(t.raw.l), r: Math.round(t.raw.r), vw });
    }
    // スクロールできない overflow の親からはみ出していないか（いちばん近い切り取る親で見る）
    const c = t.clips[0];
    if (c && !t.reason) {
      if (!c.scrollX && (t.raw.l < c.box.l - 1 || t.raw.r > c.box.r + 1)) issues.push({ kind: 'clipped-x', text: t.text, parent: c.el.id || c.el.className });
      if (!c.scrollY && (t.raw.t < c.box.t - 1 || t.raw.b > c.box.b + 1)) issues.push({ kind: 'clipped-y', text: t.text, parent: c.el.id || c.el.className });
    }
  }

  // 重なり：見えている部分同士で比べる。旧検査（矩形そのまま）で出るものは誤検知として別に数える
  const anyOverlay = texts.some(t => t.inOverlay);
  const ovl = (a, b) => ({ w: Math.min(a.r, b.r) - Math.max(a.l, b.l), h: Math.min(a.b, b.b) - Math.max(a.t, b.t) });
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const legacySkip = anyOverlay && a.inOverlay !== b.inOverlay;
      const rawO = ovl(a.raw, b.raw);
      const legacyHit = !legacySkip && rawO.w > 2 && rawO.h > 2;
      let realHit = false, visO = null;
      if (!a.reason && !b.reason) {
        visO = ovl(a.vis, b.vis);
        realHit = visO.w > 2 && visO.h > 2;
      }
      if (realHit) issues.push({ kind: 'overlap', a: a.text, b: b.text, w: Math.round(visO.w), h: Math.round(visO.h) });
      else if (legacyHit) falsePositives.push({ kind: 'overlap', a: a.text, b: b.text, reason: a.reason || b.reason || 'visible-parts-dont-overlap' });
    }
  }

  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) issues.push({ kind: 'page-hscroll', scrollWidth: de.scrollWidth, clientWidth: de.clientWidth });

  // 遊んでいる最中：地図・敵の頭上の残り歩数・操作ボタンが、スクロールなしで同じ画面に入っているか
  let firstScreen = null;
  if (!overlayOpen && window.__game && window.__game.state.phase === 'play') {
    firstScreen = {};
    const inView = (r) => r.top >= -1 && r.bottom <= vh + 1;
    const check = (what, r) => { firstScreen[what] = inView(r); if (!inView(r)) issues.push({ kind: 'not-in-first-screen', what, top: Math.round(r.top), bottom: Math.round(r.bottom), vh }); };
    check('地図', document.querySelector('#map-wrap').getBoundingClientRect());
    check('操作ボタン', document.querySelector('.dpad').getBoundingClientRect());
    const cds = Array.from(document.querySelectorAll('.ent .cd'))
      .filter(c => !c.classList.contains('none') && getComputedStyle(c).display !== 'none' && c.textContent.trim());
    firstScreen['敵の残り歩数（頭上）の個数'] = cds.length;
    if (cds.length) {
      const shown = cds.filter(c => inView(c.getBoundingClientRect()));
      firstScreen['敵の残り歩数（頭上）'] = shown.length === cds.length;
      if (shown.length !== cds.length) issues.push({ kind: 'not-in-first-screen', what: '敵の残り歩数（頭上）', shown: shown.length, total: cds.length });
    }
  }

  return { texts: texts.length, visibleTexts: visible.length, issues, falsePositives, firstScreen, viewport: { w: vw, h: vh } };
}
"""


def shot(page, name, results, viewport_too=False):
    page.screenshot(path=os.path.join(OUT, name + '.png'), full_page=True)
    if viewport_too:
        page.screenshot(path=os.path.join(OUT, name + '-view.png'), full_page=False)
    res = page.evaluate(CHECK_JS)
    res['name'] = name
    results.append(res)
    flag = 'OK ' if not res['issues'] else 'NG '
    print(f"{flag}{name}: 文字 {res['texts']} 個（見えている {res['visibleTexts']}）, 実害 {len(res['issues'])} 件, 誤検知 {len(res['falsePositives'])} 件")
    for it in res['issues'][:8]:
        print('    ', json.dumps(it, ensure_ascii=False))


def step_bot(page, n):
    """周期を読むボットを n 手進める（決まった乱数なので毎回同じ画面になる）"""
    page.evaluate("""(n) => {
      const g = window.__game;
      if (!window.__rng) window.__rng = g.Bots.mulberry(%d);
      for (let i = 0; i < n; i++) {
        const a = g.Bots.decide('reader', g.state, window.__rng);
        if (!a) break;
        g.act(a);
      }
      // レベルアップ・階段の選択で止まっていたら、遊んでいる最中の画面になるまで進める（最大5手）
      for (let i = 0; i < 5 && g.state.phase !== 'play'; i++) {
        const a = g.Bots.decide('reader', g.state, window.__rng);
        if (!a) break;
        g.act(a);
      }
    }""" % BOT_RNG_SEED, n)
    time.sleep(0.5)  # 動きの演出（最長 .38s）が終わるのを待つ


def run(out_name):
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
            shot(page, f'{vp_name}-01-start', results, viewport_too=True)

            # 2. 遊んでいる途中（ボットを決まった手数だけ進める。文字の重なりは動いている最中に出やすい）
            for k, steps in enumerate(PLAY_STEPS):
                step_bot(page, steps)
                phase = page.evaluate('window.__game.state.phase')
                print(f'    （{vp_name}: {sum(PLAY_STEPS[:k + 1])} 手目, phase={phase}, floor={page.evaluate("window.__game.state.floor")}）')
                shot(page, f'{vp_name}-02-auto' + ('' if k == 0 else f'-{k}'), results, viewport_too=True)

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
                results.append({'name': f'{vp_name}-console', 'texts': 0, 'visibleTexts': 0, 'issues': [{'kind': 'console-error', 'text': e} for e in errors], 'falsePositives': []})
                print(f'NG {vp_name}: コンソールのエラー {len(errors)} 件')
                for e in errors[:5]:
                    print('    ', e)
            ctx.close()
        browser.close()

    total = sum(len(r['issues']) for r in results)
    fp_total = sum(len(r['falsePositives']) for r in results)
    by_kind = {}
    for r in results:
        for it in r['issues']:
            by_kind[it['kind']] = by_kind.get(it['kind'], 0) + 1
    fp_by_reason = {}
    for r in results:
        for it in r['falsePositives']:
            k = it['kind'] + '/' + it['reason']
            fp_by_reason[k] = fp_by_reason.get(k, 0) + 1
    summary = {'screens': len(results), 'issues': total, 'issuesByKind': by_kind, 'falsePositives': fp_total, 'falsePositivesByReason': fp_by_reason}
    with open(os.path.join(OUT, out_name), 'w', encoding='utf-8') as f:
        json.dump({'summary': summary, 'screens': results}, f, ensure_ascii=False, indent=1)
    print(f'\n合計 {len(results)} 画面、実害 {total} 件 {json.dumps(by_kind, ensure_ascii=False)}、誤検知 {fp_total} 件 {json.dumps(fp_by_reason, ensure_ascii=False)} → screenshots/{out_name}')
    return 0 if total == 0 else 1


if __name__ == '__main__':
    sys.exit(run(sys.argv[1] if len(sys.argv) > 1 else 'check.json'))
