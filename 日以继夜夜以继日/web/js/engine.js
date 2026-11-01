/* 规则引擎 —— 严格对应《日以继夜 夜以继日》规则书第三/四/五/六/七章 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_VALUE = 56;          // 牌组数值上限（112 张 = 56 值 x 2 色）
  var SCORE_N = 8;             // 第七章：计分取手牌中最大的 8 张（与人数无关，恒定 8）
  var WILD_HAND = 8;           // 万能牌模组：开启时每人整手 8 张全是万能牌（替代正常起手牌）

  /* 人数配置（第八章 · 牌值范围与人数适配）
     规则书原始口径（x 人）：
       牌堆数值 1~8x，每种数值 1 白 1 黑，共 16x 张
       初始资金区 数值 1~4x（8x 张），每人 8 张，全部发完
       公共牌堆 数值 4x+1~8x（8x 张），每回合抽 x 张
     ★ 「整局 8 回合」不是独立规则，而是 公共牌堆 8x ÷ 每回合 x = 8 的导出量。
       所以适配时只要守住「每回合商品数 = 玩家数」这条硬约束，回合数就随之变化。

     8 人局（本套只有 112 张，16x = 112 只够 x = 7）：
       数值 1~28（56 张）作初始区 → 每人 7 张，8×7 = 56 全部发完
       数值 29~56（56 张）作公共牌堆
       每回合抽 8 张（= 玩家数）→ 回合数 = 56 / 8 = 7
     3~7 人局完全走规则书原值：每人 8 张、每回合 = 人数、8 回合。 */
  function config(x) {
    var hand = x <= 7 ? 8 : 7;
    var initMax = x <= 7 ? 4 * x : 28;
    var deckMax = x <= 7 ? 8 * x : MAX_VALUE;
    var deckCards = (deckMax - initMax) * 2;   // 公共牌堆张数 = 数值个数 × 2 色
    return {
      players: x,
      handSize: hand,                          // 每人起始资金张数
      initMax: initMax,
      deckMin: initMax + 1,
      deckMax: deckMax,
      goods: x,                                // 商品数恒等于玩家数
      rounds: Math.floor(deckCards / x),        // 导出：公共牌堆够支撑几个回合
      scoreN: SCORE_N,
      strict: x <= 7
    };
  }

  function shuffle(a, rng) {
    var r = rng || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function sum(cards) {
    var s = 0;
    for (var i = 0; i < cards.length; i++) s += cards[i].value;
    return s;
  }

  /* ---------------------------------------------------------------- 建立对局 */
  function createGame(cards, playerCount, opts) {
    opts = opts || {};
    var cfg = config(playerCount);
    cfg.wild = !!opts.wild;                // 万能牌模组：开启后每人整手 8 张全是万能牌（默认 false = 关闭）
    // 万能牌模组的数值范围：1~4n，每值 2 张 → 池子 = 8n 张，每人 8 张恰好发完。
    // 与正常模式「初始区 1~4n、每值 1白1黑、共 8n 张、每人 8 张发完」完全平行。
    // n=8 时数值到 32（美术图 s_wild_01..32），比正常 8 人局的 initMax=28 略大。
    cfg.wildMax = 4 * playerCount;
    var rng = opts.rng || Math.random;

    var initPool = cards.filter(function (c) { return c.value <= cfg.initMax; });
    var deckPool = cards.filter(function (c) {
      return c.value >= cfg.deckMin && c.value <= cfg.deckMax;
    });

    shuffle(initPool, rng);
    shuffle(deckPool, rng);

    var players = [];
    for (var i = 0; i < playerCount; i++) {
      players.push({
        id: i,
        name: (opts.names && opts.names[i]) || ('玩家' + (i + 1)),
        isAI: !(opts.humanSeat === i),
        seat: i,
        hand: [],
        bid: null,          // { type:'open'|'dark', cards:[] }
        passed: false,      // 面前有牌且不再加价
        folded: false,      // 空过
        initialSum: 0,
        lastBidValue: 0,    // 上一场出价（含空过记 0），用于并列起始玩家
        lastGain: 0,        // 上一场拿到的商品价值（无商品可得记 0），起始玩家判定用
        raises: 0,          // 本回合已出价次数（含首次），用于限制无限抬价
        gained: null
      });
    }

    if (cfg.wild) {
      // 万能牌模组：每人整手 WILD_HAND(8) 张全是万能牌，替代正常起手牌。
      // 万能牌 = 不分黑白（明暗两线皆可用），但点数仍是正常起手点数（1~wildMax=4n），绝非 56。
      // 发牌规则：每个数值 1~wildMax 各 2 张（共 8n 张），整体洗牌后依次发给每人 8 张，
      // 恰好发完、全值域覆盖，与正常初始区的「每人 8 张、发完不剩」守恒口径一致。
      cfg.handSize = WILD_HAND;
      var wildPool = [];
      for (var v = 1; v <= cfg.wildMax; v++) {
        for (var c = 0; c < 2; c++) {
          wildPool.push({
            id: 'wild_' + v + '_' + c,
            value: v,                     // 正常起手点数，非 56
            color: 'wild', wild: true,
            name: '万能牌', img: 'wild_' + String(v).padStart(2, '0') + '.webp'  // 对角拼贴美术（img 带后缀）
          });
        }
      }
      shuffle(wildPool, rng);
      var wi = 0;
      for (var wk = 0; wk < WILD_HAND; wk++) {
        for (var wj = 0; wj < playerCount; wj++) {
          players[wj].hand.push(wildPool[wi++]);
        }
      }
    } else {
      var k = 0;
      for (var p = 0; p < cfg.handSize; p++) {
        for (var q = 0; q < playerCount; q++) {
          players[q].hand.push(initPool[k++]);
        }
      }
    }
    players.forEach(function (pl) { pl.initialSum = sum(pl.hand); });

    // 座位可选按初始点数从低到高排列（第三章）。
    // 注意：只写 seat 字段，绝不重排 players 数组——数组下标必须恒等于 player.id，
    // 否则所有 g.players[pid] 取数都会错位。
    var byInit = players.slice().sort(function (a, b) { return a.initialSum - b.initialSum; });
    byInit.forEach(function (pl, i) { pl.seat = i; });

    return {
      cfg: cfg,
      players: players,
      deck: deckPool,
      goods: [],
      round: 0,
      startSeat: 0,
      turnOrder: [],
      cursor: 0,
      phase: 'ready',
      log: [],
      rng: rng,
      consumed: [],
      history: []
    };
  }

  /* 手牌中价值最大的 n 张之和（第七章） */
  function topN(player, n) {
    var v = player.hand.map(function (c) { return c.value; });
    v.sort(function (a, b) { return b - a; });
    var s = 0;
    for (var i = 0; i < Math.min(n, v.length); i++) s += v[i];
    return s;
  }

  function netValue(g, p) {
    return topN(p, g.cfg.scoreN) - p.initialSum;
  }

  /* ------------------------------------------------- 起始玩家（第五章 · 座位与起始玩家）
     第一场：初始点数最低者。
     此后每场：上一场「拿到最低拍品」的玩家，即上一场获益最少的人先手。
     注意判定依据是「上一场获得的商品价值」，不是净价值，也不是手牌价值。 */
  function pickStarter(g) {
    var ps = g.players;
    if (g.round === 0) {
      var best = ps[0];
      for (var i = 1; i < ps.length; i++) {
        if (ps[i].initialSum < best.initialSum) best = ps[i];
      }
      return best;
    }
    // 之后：上一场拿到最低商品者先手；并列则上一场出价最低者优先；仍并列按座位
    var cands = ps.slice().sort(function (a, b) {
      var d = a.lastGain - b.lastGain;
      if (d !== 0) return d;
      d = a.lastBidValue - b.lastBidValue;
      if (d !== 0) return d;
      return a.seat - b.seat;
    });
    return cands[0];
  }

  /* ------------------------------------------------- 4.1 展示商品 */
  function startRound(g) {
    g.round++;
    g.phase = 'goods';
    var st = pickStarter(g);        // 必须在清空 lastGain 之前取用上一场结果
    g.players.forEach(function (p) {
      p.bid = null; p.passed = false; p.folded = false;
      p.gained = null; p.raises = 0; p.lastGain = 0;
    });

    var n = g.cfg.goods;
    var drawn = [];
    for (var i = 0; i < n && g.deck.length; i++) drawn.push(g.deck.pop());
    g.goods = drawn;

    g.startSeat = st.seat;
    // 行动顺位：从起始玩家开始按座位轮转。turnOrder 存 player.id（不是座位号）
    var np = g.players.length;
    var order = [];
    for (var j = 0; j < np; j++) {
      var wantSeat = (st.seat + j) % np;
      for (var m = 0; m < np; m++) {
        if (g.players[m].seat === wantSeat) { order.push(g.players[m].id); break; }
      }
    }
    g.turnOrder = order;
    g.cursor = 0;
    g.phase = 'bid';
    return { goods: drawn, starter: st };
  }

  /* ------------------------------------------------- 出价合法性 */
  function maxOpenOther(g, pid) {
    var m = 0;
    g.players.forEach(function (p) {
      if (p.id === pid) return;
      if (p.bid && p.bid.type === 'open') m = Math.max(m, sum(p.bid.cards));
    });
    return m;
  }

  function maxOpenAll(g) {
    var m = 0;
    g.players.forEach(function (p) {
      if (p.bid && p.bid.type === 'open') m = Math.max(m, sum(p.bid.cards));
    });
    return m;
  }

  /* 明拍可用的白牌池。
     规则书 P.6：明拍是"整组替换，旧牌全部收回手牌，新组可以由收回的旧牌与新牌重新组合"。
     因此替换时，摆在面前的旧明牌组同样属于可再选范围，不能只认手牌。 */
  function openPool(p) {
    var pool = p.hand.filter(function (c) { return c.color === 'white' || c.wild; });
    if (p.bid && p.bid.type === 'open') pool = pool.concat(p.bid.cards);
    return pool;
  }

  /* 返回该玩家当前可选的行动（第四章四选一） */
  function legalActions(g, pid) {
    var p = g.players[pid];
    var acts = [];
    if (p.folded) return acts;
    if (p.bid && p.bid.type === 'dark') return acts;   // 暗牌一口价，锁定
    // 已选择"放弃/不出价" → 本回合等待结算，不再有出价权（P.8）
    if (p.bid && p.passed) return acts;

    // 暗拍候选池：手牌里的黑牌/万能牌 + 场上明牌里的万能牌。
    // 规则书 P.6「整组替换」：收回的旧牌可与新牌重新组合。万能牌不分黑白，
    // 故场上那组万能明牌同样能参与转暗重组；普通模式下白牌不进暗线（保持原行为）。
    var blacks = p.hand.filter(function (c) { return c.color === 'black' || c.wild; });
    if (p.bid && p.bid.type === 'open') {
      blacks = blacks.concat(p.bid.cards.filter(function (c) { return c.wild; }));
    }

    // 明拍：面前无暗牌即可出白牌（整组替换）；新组总和须压过他人最大明牌
    if (!p.bid || p.bid.type === 'open') {
      var limit = maxOpenOther(g, pid);
      var whites = openPool(p);
      if (whites.length) acts.push({ type: 'open', limit: limit, pool: whites });
    }
    // 暗拍：仅面前无牌时可出
    if (!p.bid && blacks.length) acts.push({ type: 'dark', pool: blacks });
    // 明转暗：面前是明牌，新暗牌须大于自己的旧明牌
    if (p.bid && p.bid.type === 'open' && blacks.length) {
      acts.push({ type: 'toDark', limit: sum(p.bid.cards), pool: blacks });
    }
    // 空过：仅面前无牌
    if (!p.bid) acts.push({ type: 'fold' });
    // 放弃/不出价：面前已有牌
    if (p.bid) acts.push({ type: 'pass' });
    return acts;
  }

  function canAct(p) {
    if (p.folded) return false;
    if (p.bid && p.bid.type === 'dark') return false;   // 暗拍后即锁定
    return true;
  }

  /* 选牌校验：给定牌 id 列表，检查是否合法 */
  function validateBid(g, pid, type, ids) {
    var p = g.players[pid];
    ids = ids || [];
    var acts = legalActions(g, pid);
    var act = null;
    for (var i = 0; i < acts.length; i++) if (acts[i].type === type) act = acts[i];
    if (!act) return { ok: false, msg: '此行动当前不可选' };

    var chosen = [], seen = {};
    for (var j = 0; j < ids.length; j++) {
      if (seen[ids[j]]) return { ok: false, msg: '同一张牌不能重复选择' };
      seen[ids[j]] = true;
      var c = null;
      for (var h = 0; h < act.pool.length; h++) {
        if (act.pool[h].id === ids[j]) { c = act.pool[h]; break; }
      }
      if (!c) return { ok: false, msg: '这张牌不在可选范围内' };
      chosen.push(c);
    }
    if (!chosen.length) return { ok: false, msg: '至少要出一张牌' };

    var want = type === 'open' ? 'white' : 'black';
    for (var k = 0; k < chosen.length; k++) {
      if (chosen[k].color !== want && !chosen[k].wild) {
        return { ok: false, msg: type === 'open' ? '明拍只能用白牌' : '暗拍只能用黑牌' };
      }
    }
    var s = sum(chosen);
    if (act.limit != null && s <= act.limit) {
      if (type === 'open') return { ok: false, msg: '总和须压过他人最大明牌（当前 ' + act.limit + '）' };
      return { ok: false, msg: '新暗牌须大于自己的旧明牌（' + act.limit + '）' };
    }
    return { ok: true, cards: chosen, value: s };
  }

  /* 执行出价 */
  function applyBid(g, pid, type, ids) {
    var v = validateBid(g, pid, type, ids);
    if (!v.ok) return v;
    var p = g.players[pid];
    // 明拍替换：旧组全部收回手牌
    if (p.bid) {
      p.hand = p.hand.concat(p.bid.cards);
      p.bid = null;
    }
    for (var i = 0; i < v.cards.length; i++) {
      var idx = p.hand.indexOf(v.cards[i]);
      if (idx >= 0) p.hand.splice(idx, 1);
    }
    p.bid = { type: type === 'toDark' ? 'dark' : type, cards: v.cards };
    p.passed = false;
    p.raises++;
    return { ok: true, value: v.value };
  }

  function applyPass(g, pid) {
    var p = g.players[pid];
    if (!p.bid) return { ok: false, msg: '面前无牌不能放弃，只能出牌或空过' };
    p.passed = true;
    return { ok: true };
  }

  /* 空过：立即拿走商品区最低的一张（第五章） */
  function applyFold(g, pid) {
    var p = g.players[pid];
    if (p.bid) return { ok: false, msg: '面前有牌不能空过' };
    if (!g.goods.length) { p.folded = true; return { ok: true, card: null }; }
    var lo = g.goods[0], li = 0;
    for (var i = 1; i < g.goods.length; i++) {
      if (g.goods[i].value < lo.value) { lo = g.goods[i]; li = i; }
    }
    g.goods.splice(li, 1);
    p.hand.push(lo);
    p.folded = true;
    p.gained = { card: lo, via: 'fold' };
    p.lastGain = lo.value;
    return { ok: true, card: lo };
  }

  /* 拍卖是否结束：每人要么已出牌并放弃，要么已空过，要么暗牌锁定 */
  function biddingOver(g) {
    for (var i = 0; i < g.players.length; i++) {
      var p = g.players[i];
      if (p.folded) continue;
      if (p.bid && p.bid.type === 'dark') continue;
      if (p.bid && p.passed) continue;
      return false;
    }
    return true;
  }

  function nextActor(g) {
    var n = g.players.length, guard = 0;
    while (guard++ < n * 4) {
      var idx = g.turnOrder[g.cursor % n];
      var p = g.players[idx];
      g.cursor++;
      if (!canAct(p)) continue;
      if (p.bid && p.passed) continue;
      return p;
    }
    return null;
  }

  /* ------------------------------------------------- 4.3 按序拿商品 */
  function settle(g) {
    g.phase = 'settle';
    var result = { picks: [], remain: [], consumed: [] };

    // 商品按颜色分堆，各自降序
    var whiteGoods = g.goods.filter(function (c) { return c.color === 'white'; })
      .sort(function (a, b) { return b.value - a.value; });
    var blackGoods = g.goods.filter(function (c) { return c.color === 'black'; })
      .sort(function (a, b) { return b.value - a.value; });

    // 出价分组：数值降序；同价位时顺位靠后者先取（拿价值较高的）
    function rank(list) {
      return list.slice().sort(function (a, b) {
        if (b.value !== a.value) return b.value - a.value;
        return b.seat - a.seat;
      });
    }
    var opens = [], darks = [];
    g.players.forEach(function (p) {
      if (!p.bid) return;
      var e = { p: p, value: sum(p.bid.cards), seat: p.seat, type: p.bid.type };
      (p.bid.type === 'open' ? opens : darks).push(e);
    });
    opens = rank(opens);
    darks = rank(darks);

    var pending = opens.concat(darks);
    var taken = {};

    function take(bidder, card, line) {
      bidder.p.hand.push(card);
      bidder.p.gained = { card: card, via: line };
      bidder.p.lastGain = card.value;
      result.picks.push({ pid: bidder.p.id, card: card, line: line });
      taken[bidder.p.id] = true;
    }
    function popFrom(pool, card) {
      var i = pool.indexOf(card);
      if (i >= 0) pool.splice(i, 1);
    }
    function removePending(b) {
      var i = pending.indexOf(b);
      if (i >= 0) pending.splice(i, 1);
    }

    // 第一条 · 同色相取：暗线取黑货、明线取白货，两条线互不影响
    var progress = true;
    while (progress) {
      progress = false;
      // 暗线
      for (var d = 0; d < darks.length; d++) {
        var bd = darks[d];
        if (taken[bd.p.id] || !blackGoods.length) continue;
        var c1 = blackGoods.shift();
        take(bd, c1, 'dark');
        removePending(bd);
        progress = true;
        break;
      }
      // 明线
      for (var o = 0; o < opens.length; o++) {
        var bo = opens[o];
        if (taken[bo.p.id] || !whiteGoods.length) continue;
        var c2 = whiteGoods.shift();
        take(bo, c2, 'open');
        removePending(bo);
        progress = true;
        break;
      }
      // 清理已取走的
      darks = darks.filter(function (b) { return !taken[b.p.id]; });
      opens = opens.filter(function (b) { return !taken[b.p.id]; });
    }

    // 第二条 · 颜色完全不同时：剩余出价统一按数值降序，取剩余商品中最大的
    var restGoods = whiteGoods.concat(blackGoods)
      .sort(function (a, b) { return b.value - a.value; });
    pending = rank(pending);
    for (var k = 0; k < pending.length && restGoods.length; k++) {
      take(pending[k], restGoods.shift(), 'value');
    }

    // 剩余商品 = restGoods 中未被取走的部分。
    // 注意不能用 whiteGoods/blackGoods 重新拼接：兜底阶段 shift 的是 restGoods，
    // 原数组仍是完整列表，那样会让已取走的牌再被洗回牌堆、凭空多牌。
    result.remain = restGoods;

    // 4.4 消耗：全场最高明牌 + 所有暗牌本轮消耗；其余明牌收回手牌
    var maxOpen = maxOpenAll(g);
    g.players.forEach(function (p) {
      if (!p.bid) { p.lastBidValue = 0; return; }   // 空过 / 本场未出价，记 0
      var s = sum(p.bid.cards);
      p.lastBidValue = s;
      if (p.bid.type === 'dark' || (p.bid.type === 'open' && s === maxOpen)) {
        g.consumed = g.consumed.concat(p.bid.cards);
        result.consumed.push({ pid: p.id, cards: p.bid.cards.slice() });
      } else {
        p.hand = p.hand.concat(p.bid.cards);
      }
      p.bid = null;
    });

    // 未被选走的商品洗回公共牌堆
    if (result.remain.length) {
      shuffle(result.remain, g.rng);
      for (var r = 0; r < result.remain.length; r++) g.deck.unshift(result.remain[r]);
    }
    g.goods = [];
    return result;
  }

  /* ------------------------------------------------- 第七章 计分 */
  function scoring(g) {
    var rows = g.players.map(function (p) {
      return {
        id: p.id, name: p.name,
        initial: p.initialSum,
        top: topN(p, g.cfg.scoreN),
        net: netValue(g, p),
        handCount: p.hand.length,
        isAI: p.isAI
      };
    });
    rows.sort(function (a, b) {
      if (b.net !== a.net) return b.net - a.net;
      if (b.top !== a.top) return b.top - a.top;
      return a.id - b.id;
    });
    rows.forEach(function (r, i) { r.rank = i + 1; });
    g.phase = 'over';
    return rows;
  }

  return {
    MAX_VALUE: MAX_VALUE,
    SCORE_N: SCORE_N,
    config: config,
    createGame: createGame,
    startRound: startRound,
    legalActions: legalActions,
    validateBid: validateBid,
    applyBid: applyBid,
    applyPass: applyPass,
    applyFold: applyFold,
    canAct: canAct,
    biddingOver: biddingOver,
    nextActor: nextActor,
    settle: settle,
    scoring: scoring,
    sum: sum,
    topN: topN,
    netValue: netValue,
    shuffle: shuffle
  };
});
