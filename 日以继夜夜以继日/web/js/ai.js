/* AI 对手决策 —— 只用公开信息 + 自己的手牌，不偷看任何暗牌
 *
 * 决策模型（三件事，缺一不可）：
 *   ① 出价决定名次：明线按明拍出价降序取货、暗线按暗拍出价降序取货，
 *      所以「能拿到第几档货」必须由自己的出价估算，不能默认拿头名。
 *   ② 期望值 = 拿货收益 − 被消耗的代价 × 概率。
 *      明拍只有守住「全场最高明牌」才会被消耗，被别人反超则整组收回手牌、照样按名次拿货；
 *      暗拍无论名次必定消耗。
 *   ③ 候选必须覆盖整个出价区间：只枚举小组合会永远不敢重注。
 *
 * 可调性格参数：
 *   skill      决策精度（同时决定抬价上限，防止互相无限加价）
 *   beta       明线信念：单个未表态对手「压不过我」的乐观度（0.45 悲观 ~ 0.95 自信）
 *   darkScale  暗拍名次标尺：越小越敢重注暗拍抢头名
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.AI = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var MAX_COMBO = 4;      // 单次出价最多组合几张（控制搜索规模）
  var CAND_LIMIT = 30;    // 参与评估的候选组合上限

  var DEFAULT_SKILL = 0.80;       // 抬价上限（2 + round(skill*1.2) 次）
  var DEFAULT_BETA = 0.86;        // 明线信念：新配置下实测最优（旧配置是 0.76）
  var DEFAULT_DARK_SCALE = 1.0;   // 暗拍名次标尺

  function sum(cards) {
    var s = 0;
    for (var i = 0; i < cards.length; i++) s += cards[i].value;
    return s;
  }

  /* 手牌中最大 n 张之和 */
  function topN(hand, n) {
    var v = [];
    for (var i = 0; i < hand.length; i++) v.push(hand[i].value);
    v.sort(function (a, b) { return b - a; });
    var s = 0;
    for (var j = 0; j < Math.min(n, v.length); j++) s += v[j];
    return s;
  }

  /* 枚举大小 1..maxK 的子集 */
  function subsets(cards, maxK, cb) {
    var n = cards.length, k = Math.min(maxK, n), idx = [];
    (function rec(start, depth) {
      if (depth > k) return;
      for (var i = start; i < n; i++) {
        idx.push(i);
        cb(idx.map(function (t) { return cards[t]; }));
        rec(i + 1, depth + 1);
        idx.pop();
      }
    })(0, 1);
  }

  /* 从升序数组里均匀抽 k 个：覆盖「刚好够」到「重注」整段，而不是只取最小的几个 */
  function sampleEven(arr, k) {
    if (arr.length <= k) return arr;
    var out = [];
    for (var i = 0; i < k; i++) out.push(arr[Math.round(i * (arr.length - 1) / (k - 1))]);
    return out;
  }

  function without(hand, out) {
    var ids = {};
    for (var i = 0; i < out.length; i++) ids[out[i].id] = 1;
    var r = [];
    for (var j = 0; j < hand.length; j++) if (!ids[hand[j].id]) r.push(hand[j]);
    return r;
  }

  /* 拿到 gain 之后，计分口径（最大 H 张之和）的提升 */
  function gainValue(hand, gain, H) {
    if (!gain) return 0;
    return topN(hand.concat([gain]), H) - topN(hand, H);
  }

  /* 这组牌若被消耗，计分口径的损失。不在最大 H 张里的牌，损失为 0 */
  function burnCost(hand, out, H) {
    return topN(hand, H) - topN(without(hand, out), H);
  }

  /* 商品区某色第 rank 档（1 起，降序）；不足则取该色最小 */
  function nthGoods(goods, color, rank) {
    var pool = goods.filter(function (c) { return c.color === color; })
      .sort(function (a, b) { return b.value - a.value; });
    if (!pool.length) return null;
    return pool[Math.min(Math.max(rank, 1) - 1, pool.length - 1)];
  }

  function lowestGoods(goods) {
    if (!goods.length) return null;
    var lo = goods[0];
    for (var i = 1; i < goods.length; i++) if (goods[i].value < lo.value) lo = goods[i];
    return lo;
  }

  /* 他人最大明牌 */
  function otherOpenMax(g, pid) {
    var m = 0;
    g.players.forEach(function (q) {
      if (q.id !== pid && q.bid && q.bid.type === 'open') m = Math.max(m, sum(q.bid.cards));
    });
    return m;
  }

  /* 已知明拍中，出价严格高于 s 的人数 */
  function knownAbove(g, pid, s) {
    var n = 0;
    g.players.forEach(function (q) {
      if (q.id === pid) return;
      if (q.bid && q.bid.type === 'open' && sum(q.bid.cards) > s) n++;
    });
    return n;
  }

  /* 还能加价的对手数（未空过、未锁定、未放弃） */
  function liveOpponents(g, pid) {
    var n = 0;
    g.players.forEach(function (q) {
      if (q.id === pid || q.folded) return;
      if (q.bid && q.bid.type === 'dark') return;
      if (q.bid && q.passed) return;
      n++;
    });
    return n;
  }

  /* ------------------------------------------------------------ 主决策 */
  function decide(g, pid, opt) {
    opt = opt || {};
    var E = root.Engine || (typeof require === 'function' ? require('./engine.js') : null);
    var p = g.players[pid];
    // 计分口径（_probe_ai.js / _sweep_ai.js 实测结论）：
    // scoreH:true（按 scoreN=8 计价值）反而比 scoreH:false（按 handSize=7）更差（t≈-8）。
    // 本经济里"花牌"代价极高，7 张口径恰好更克制、更少过度加价，故默认保持 false
    // （即出厂已验证的最强口径）；scoreH:true 仅留作对照开关。
    var scoreH = opt.scoreH == null ? false : opt.scoreH;
    var H = scoreH ? g.cfg.scoreN : g.cfg.handSize;
    var acts = E.legalActions(g, pid);
    if (!acts.length) return { type: 'pass' };

    var skill = opt.skill == null ? DEFAULT_SKILL : opt.skill;
    var beta = opt.beta == null ? DEFAULT_BETA : opt.beta;
    var darkScale = opt.darkScale == null ? DEFAULT_DARK_SCALE : opt.darkScale;

    /* —— 候选优化（默认全关；_probe_ai.js 单独开关测效，确认有 pooled t 显著增益才并入默认）——
       roundAware 末期加权：回合越靠后，收益权重上调、消耗权重下调。
       deckAware  牌堆稀缺感知：当前拍卖最高货 ≥ 牌堆剩余最高值时，这批货就是剩余最好的，加码。
       openReal   明线对手现实化：live 含大量会放弃/空过的对手，按经验系数收缩，避免过度悲观。 */
    var roundAware = opt.roundAware == null ? false : opt.roundAware;
    var deckAware = opt.deckAware == null ? false : opt.deckAware;
    var openReal = opt.openReal == null ? false : opt.openReal;
    var openRealF = opt.openRealF == null ? 0.6 : opt.openRealF;

    var has = {};
    acts.forEach(function (a) { has[a.type] = true; });

    var otherMax = otherOpenMax(g, pid);
    var isTopOpen = !!(p.bid && p.bid.type === 'open' && sum(p.bid.cards) > otherMax);
    var live = liveOpponents(g, pid);
    // 明线对手现实化：收缩 live，避免过度悲观（多数 live 对手本回合并不会真来压价）
    var effLive = openReal ? Math.max(1, Math.round(live * openRealF)) : live;

    // 收敛上限：真人不会无限互相加价；已是明线第一也不必再加（只会扩大消耗面）
    var maxRaise = 2 + Math.round(skill * 1.2);
    if (p.raises >= maxRaise) { has.open = false; has.dark = false; has.toDark = false; }
    if (isTopOpen) has.open = false;

    var best = { type: has.fold ? 'fold' : 'pass', score: -1e9, cards: [] };
    var worst = null;                       // 本轮评估中最差的可选行动（难度档"失误"时用）
    function consider(cand) {
      if (cand.score > best.score) best = cand;
      if (!worst || cand.score < worst.score) worst = cand;
    }
    // 守住明线头名的概率：effLive 个未表态对手全都压不过我
    var pHold = effLive === 0 ? 1 : Math.pow(beta, effLive);

    // 末期加权系数（回合越靠后越敢重注、越不心疼消耗）
    var ca = roundAware ? 0.30 * (g.round / Math.max(1, g.cfg.rounds)) : 0;
    var gk = 1 + ca;     // 收益权重
    var bk = 1 - ca;     // 消耗权重
    // 牌堆稀缺感知：当前拍卖最高货已经 ≥ 牌堆剩余最高值 → 这批就是剩余最好的，加码
    if (deckAware) {
      var futTop = 0;
      for (var fi = 0; fi < g.deck.length; fi++) futTop = Math.max(futTop, g.deck[fi].value);
      var curTop = 0;
      for (var gi = 0; gi < g.goods.length; gi++) curTop = Math.max(curTop, g.goods[gi].value);
      var scar = Math.max(0, Math.min(0.35, (curTop - futTop) / 56 + 0.08));
      gk *= (1 + scar);
    }
    // 收益/消耗连续权重（_probe_ai.js 网格扫描用）：直接调 gain/burn 权衡
    var gainW = opt.gainW == null ? 1 : opt.gainW;
    var burnW = opt.burnW == null ? 1 : opt.burnW;

    /* ---- 明拍：出价决定名次；只有守住头名才会被消耗 ---- */
    if (has.open) {
      var pool = null, limit = 0;
      acts.forEach(function (a) { if (a.type === 'open') { pool = a.pool; limit = a.limit; } });
      var cands = [];
      subsets(pool || [], MAX_COMBO, function (combo) {
        var s = sum(combo);
        if (s > limit) cands.push({ combo: combo, s: s });
      });
      cands.sort(function (a, b) { return a.s - b.s; });
      cands = sampleEven(cands, CAND_LIMIT);

      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        var expAbove = knownAbove(g, pid, c.s) + effLive * (1 - beta);
        var w = nthGoods(g.goods, 'white', 1 + Math.round(expAbove)) || lowestGoods(g.goods);
        var g1 = gainValue(p.hand, w, H);
        var b1 = burnCost(p.hand, c.combo, H);
        // 张数越多、消耗面越大，轻微惩罚
        var sc = gainW * gk * g1 - pHold * burnW * bk * b1 - (c.combo.length - 1) * 0.25;
        consider({ type: 'open', score: sc, cards: c.combo.map(function (x) { return x.id; }) });
      }
    }

    /* ---- 暗拍：一口价必定消耗；出价越高名次越前、拿到越好的黑货 ---- */
    if (has.dark) {
      var blacks = p.hand.filter(function (c) { return c.color === 'black' || c.wild; });
      var dc = [];
      subsets(blacks, MAX_COMBO, function (combo) { dc.push(combo); });
      dc.sort(function (a, b) { return sum(a) - sum(b); });
      dc = sampleEven(dc, CAND_LIMIT);
      var rivals = Math.max(1, live);
      for (var j = 0; j < dc.length; j++) {
        var s2 = sum(dc[j]);
        var rank2 = 1 + Math.round(rivals * (1 - s2 / (s2 + darkScale)));
        var w2 = nthGoods(g.goods, 'black', rank2) || lowestGoods(g.goods);
        var sc2 = gainW * gk * gainValue(p.hand, w2, H) - burnW * bk * burnCost(p.hand, dc[j], H);
        consider({ type: 'dark', score: sc2, cards: dc[j].map(function (x) { return x.id; }) });
      }
    }

    /* ---- 明转暗：旧明牌收回保住，新暗牌必定消耗 ---- */
    if (has.toDark) {
      var bl2 = p.hand.filter(function (c) { return c.color === 'black' || c.wild; });
      var lim2 = 0;
      acts.forEach(function (a) { if (a.type === 'toDark') lim2 = a.limit; });
      var tc = [];
      subsets(bl2, MAX_COMBO, function (combo) { if (sum(combo) > lim2) tc.push(combo); });
      tc.sort(function (a, b) { return sum(a) - sum(b); });
      tc = sampleEven(tc, CAND_LIMIT);
      var rivals2 = Math.max(1, live);
      for (var m = 0; m < tc.length; m++) {
        var s3 = sum(tc[m]);
        var rank3 = 1 + Math.round(rivals2 * (1 - s3 / (s3 + darkScale)));
        var w3 = nthGoods(g.goods, 'black', rank3) || lowestGoods(g.goods);
        var sc3 = gainW * gk * gainValue(p.hand, w3, H) - burnW * bk * burnCost(p.hand, tc[m], H);
        consider({ type: 'toDark', score: sc3, cards: tc[m].map(function (x) { return x.id; }) });
      }
    }

    /* ---- 空过：白拿全场最低商品，零消耗，保底选项 ---- */
    if (has.fold) {
      var lo = lowestGoods(g.goods);
      var sc4 = lo ? gainW * gk * gainValue(p.hand, lo, H) : -0.5;
      consider({ type: 'fold', score: sc4, cards: [] });
    }

    /* ---- 放弃加价：保住已出的牌参与排序；守着头名则会被消耗 ---- */
    if (has.pass && p.bid) {
      var bs = sum(p.bid.cards);
      var expA = knownAbove(g, pid, bs) + effLive * (1 - beta);
      var gp = nthGoods(g.goods, p.bid.type === 'open' ? 'white' : 'black', 1 + Math.round(expA))
        || lowestGoods(g.goods);
      var gm = gainValue(p.hand, gp, H);
      var bm = p.bid.type === 'dark'
        ? burnCost(p.hand, p.bid.cards, H)
        : pHold * burnCost(p.hand, p.bid.cards, H);
      var sc5 = gainW * gk * gm - burnW * bk * bm;
      consider({ type: 'pass', score: sc5, cards: [] });
    }

    /* 难度档「失误」：按概率故意挑本轮最差的那个合法行动。
       硬核档 blunder = 0 → 永远取最优，也就是所有对手都处于最高水平。
       这是难度阶梯唯一有效的旋钮：实测 beta / darkScale 微调只能拉开 +1.9~+4.1
       的净价值差（t 仅 2~4），撑不起"两两显著"的档位差。 */
    var blunder = opt.blunder == null ? 0 : opt.blunder;
    if (worst && blunder > 0) {
      // 优先用外部注入的 rng：否则会和牌堆共用 g.rng，使 A/B 对照互相污染
      var rnd = opt.rng || g.rng || Math.random;
      if (rnd() < blunder) return worst;
    }

    return best;
  }

  /* 七名对手：**全部使用同一套实测最优参数，实力完全对等**——不存在谁强谁弱。
     名字不同只是观感；参数一律取自 BEST，谁都不会比谁差。
     （若要人机难度差异，走 tune() 按档位整体缩放，而不是让某个对手偷偷变笨。）

     参数来源：8 人局配置改为「每回合 8 件商品（= 人数）、共 7 回合」后，
     原最优 beta 0.76 不再最优，用 _tune.js 在同一套牌上重标：
       beta 0.86 vs 0.76 → 净价值 +7.72（t=11.00），平均名次 4.350 vs 4.650
       beta 0.84 / 0.88 分别为 +7.47 / +6.62，峰在 0.86（平台区 0.84~0.88）。
     darkScale 在 0.5~2.2 区间实测无显著差异（|t|<2.5），取 1.0；低于 0.3 显著变差。 */
  var BEST = { skill: DEFAULT_SKILL, beta: DEFAULT_BETA, darkScale: DEFAULT_DARK_SCALE };
  var ROSTER = ['铁秤', '锈刃', '夜枭', '灰狼', '算盘', '拾荒者', '油商'].map(function (nm) {
    return { name: nm, skill: BEST.skill, beta: BEST.beta, darkScale: BEST.darkScale };
  });

  /* 难度档 = **决策失误率**。硬核 0 失误，等于出厂最强档（所有对手同水平）；
     标准 / 休闲以一定概率故意挑当前最差的那个合法行动，越往下越容易犯错。

     为什么不用 beta / darkScale 做难度：实测（_diff.js）这两项在 8 人局新配置下
     只能拉开 +1.9 ~ +4.1 的净价值差（t 约 2~4），远不足以构成稳定的档位差。
     失误率是单调、可控且效应显著的旋钮。 */
  var DIFFICULTY = {
    casual: { label: '休闲', blunder: 0.22 },
    normal: { label: '标准', blunder: 0.08 },
    hard: { label: '硬核', blunder: 0 }
  };

  /* 按难度调整某个对手：只改失误率，不改任何评估参数 */
  function tune(base, diff) {
    var d = DIFFICULTY[diff] || DIFFICULTY.normal;
    return {
      name: base.name, skill: base.skill,
      beta: base.beta, darkScale: base.darkScale,
      blunder: d.blunder
    };
  }

  return {
    decide: decide,
    ROSTER: ROSTER,
    DIFFICULTY: DIFFICULTY,
    tune: tune,
    topN: topN,
    sum: sum
  };
});
