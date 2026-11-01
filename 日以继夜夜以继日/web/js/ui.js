(function () {
  'use strict';

  var E = window.Engine, AI = window.AI, CARDS = window.CARDS;

  var G = null;
  var SEL = [];
  var PENDING = null;
  var HUMAN = 0;
  var N = 8;
  var DIFF = 'hard';
  var WILD = 0;        // 万能牌模组：0 = 关闭，1 = 开启（开启后每人整手 8 张全是万能牌）
  var PROFILE = [];
  var ACTIVE = null;   // 当前该谁行动。必须由 renderSeats 渲染，不能事后手动加类

  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function sum(cs) { var s = 0; for (var i = 0; i < cs.length; i++) s += cs[i].value; return s; }
  function imgPath(c) { return 'assets/cards/s_' + c.img; }
  function backPath() { return 'assets/cards/s_back_night.webp'; }

  function cardById(id) {
    for (var i = 0; i < CARDS.length; i++) if (CARDS[i].id === id) return CARDS[i];
    // 万能牌不进 CARDS（在 createGame 里临时生成），只能在实时对局状态里找。
    // 不做这层回退的话，选中万能牌后 cardById 返回 null → selCards 为空 →
    // 出价按钮（明拍/暗拍）永远 disabled，表现为「万能模式没法点出价」。
    if (G) {
      var live = [];
      G.players.forEach(function (p) {
        p.hand.forEach(function (c) { live.push(c); });
        if (p.bid) p.bid.cards.forEach(function (c) { live.push(c); });
      });
      G.goods.forEach(function (c) { live.push(c); });
      for (var j = 0; j < live.length; j++) if (live[j].id === id) return live[j];
    }
    return null;
  }
  function selCards() {
    var a = [];
    for (var i = 0; i < SEL.length; i++) { var c = cardById(SEL[i]); if (c) a.push(c); }
    return a;
  }
  function handOf(p) { return p.hand.slice().sort(function (a, b) { return a.value - b.value; }); }

  function log(html, cls) {
    var d = document.createElement('div');
    if (cls) d.className = cls;
    d.innerHTML = html;
    var box = $('log');
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 1600);
  }

  /* ------------------------------------------------------------ 渲染 */
  function cardHtml(c, cls) {
    if (c.wild) {
      return '<div class="card wild ' + (cls || '') + '" data-id="' + c.id + '">' +
        '<span class="val">' + c.value + '</span>' +
        '<img src="' + imgPath(c) + '" alt="' + esc(c.name) + '" loading="lazy">' +
        '<div class="cap">' + esc(c.name) + '</div></div>';
    }
    return '<div class="card ' + (cls || '') + '" data-id="' + c.id + '">' +
      '<span class="val">' + c.value + '</span>' +
      '<img src="' + imgPath(c) + '" alt="' + esc(c.name) + '" loading="lazy">' +
      '<div class="cap">' + esc(c.name) + '</div></div>';
  }
  function backHtml(v) {
    return '<div class="card"><span class="val">' + v + '</span>' +
      '<img src="' + backPath() + '" alt="暗牌"><div class="cap">暗置</div></div>';
  }

  function renderPips() {
    if (!G) return;
    var h = '';
    var R = G.cfg.rounds;          // 回合数是导出量：公共牌堆 ÷ 每回合商品数
    for (var i = 1; i <= R; i++) {
      var c = i < G.round ? 'done' : (i === G.round ? 'now' : '');
      h += '<div class="pip ' + c + '">' + i + '</div>';
    }
    $('pips').innerHTML = h;
  }

  function renderSeats() {
    var ps = G.players.slice().sort(function (a, b) { return a.seat - b.seat; });
    var h = '';
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      var isMe = (p.id === HUMAN);
      var cls = 'seat' + (isMe ? ' me' : '') + (p.folded ? ' folded' : '') +
        (p.id === ACTIVE ? ' active' : '');
      h += '<div class="' + cls + '" data-pid="' + p.id + '">';
      h += '<div class="seat-top"><span class="seat-name">' + esc(p.name) +
        '</span><span class="seat-hand">' + p.hand.length + ' 张</span></div>';

      h += '<div class="bidbox">';
      if (p.folded) {
        h += '<span class="bidchip fold">空过 · 拿最低</span>';
      } else if (!p.bid) {
        h += '<span class="bidchip wait">未出价</span>';
      } else if (p.bid.type === 'dark') {
        h += '<span class="bidchip dark">暗拍 · ' + p.bid.cards.length + ' 张（保密）</span>';
      } else {
        var mini = '';
        for (var k = 0; k < p.bid.cards.length; k++) {
          mini += '<span class="mini w">' + p.bid.cards[k].value + '</span>';
        }
        h += '<span class="bidchip">明拍 ' + sum(p.bid.cards) + '</span>';
        h += '<div class="minicards">' + mini + '</div>';
      }
      if (p.gained) {
        h += '<span class="bidchip" style="border-color:#2e6b5e;background:rgba(46,107,94,.22);color:#8fd8c6">+' +
          p.gained.card.value + ' ' + esc(p.gained.card.name) + '</span>';
      }
      h += '</div></div>';
    }
    $('seats').innerHTML = h;
  }

  /* 商品区同样增量渲染：牌没变就不重建 DOM。
     否则每次 render() 都会重播入场动画，画面反复闪一下。 */
  function renderGoods() {
    var box = $('goods');
    var sig = G.goods.map(function (c) { return c.id; }).join(',');
    if (box.getAttribute('data-sig') === sig) return;
    box.setAttribute('data-sig', sig);
    var h = '';
    if (!G.goods.length) {
      h = '<div style="color:#c9b891;font-size:13px;align-self:center">本回合商品已分配完毕</div>';
    } else {
      for (var i = 0; i < G.goods.length; i++) h += cardHtml(G.goods[i], 'win');
    }
    box.innerHTML = h;
  }

  /* 手牌增量渲染：牌没变时只切换选中态，避免重建 DOM 导致图片闪烁与点击失效。
     摆在面前的明牌组也一并列在最前：规则书允许把收回的旧牌与新牌重新组合。 */
  function renderHand() {
    var p = G.players[HUMAN];
    var hs = handOf(p);
    var bidCards = (p.bid && p.bid.type === 'open')
      ? p.bid.cards.slice().sort(function (a, b) { return a.value - b.value; })
      : [];
    var box = $('myhand');
    var sig = bidCards.map(function (c) { return c.id; }).join('|') + '#' +
      hs.map(function (c) { return c.id; }).join(',');
    if (box.getAttribute('data-sig') !== sig) {
      box.setAttribute('data-sig', sig);
      var h = '';
      for (var j = 0; j < bidCards.length; j++) h += cardHtml(bidCards[j], 'pick inbid');
      for (var i = 0; i < hs.length; i++) h += cardHtml(hs[i], 'pick');
      if (!h) h = '<div style="color:#c9b891;font-size:12px">手牌已空</div>';
      box.innerHTML = h;
    }
    var els = box.querySelectorAll('.card');
    for (var k = 0; k < els.length; k++) {
      els[k].classList.toggle('sel', SEL.indexOf(els[k].getAttribute('data-id')) >= 0);
    }
    $('handInfo').textContent = '共 ' + p.hand.length + ' 张' +
      (bidCards.length ? ' · 场上明牌 ' + sum(bidCards) + ' 点，可点选重组' : '') +
      ' · 计分取最大 ' + G.cfg.scoreN + ' 张';
  }

  function maxOpenNow() {
    var m = 0;
    G.players.forEach(function (q) {
      if (q.bid && q.bid.type === 'open') m = Math.max(m, sum(q.bid.cards));
    });
    return m;
  }

  function renderActs(interactive) {
    var acts = E.legalActions(G, HUMAN);
    var has = {};
    acts.forEach(function (a) { has[a.type] = true; });
    var p = G.players[HUMAN];
    var sc = selCards();
    var ss = sum(sc);

    function okFor(type, color, limit) {
      if (!has[type]) return false;
      if (!sc.length) return false;
      // 万能牌两线皆可用：与要求色相同或 wild 都合法
      for (var i = 0; i < sc.length; i++) if (sc[i].color !== color && !sc[i].wild) return false;
      if (limit != null && ss <= limit) return false;
      return true;
    }
    var limitOpen = 0, limitDark = 0;
    acts.forEach(function (a) {
      if (a.type === 'open') limitOpen = a.limit;
      if (a.type === 'toDark') limitDark = a.limit;
    });

    var defs = [
      { t: 'open', label: '明拍', color: 'white', limit: limitOpen },
      { t: 'dark', label: '暗拍', color: 'black', limit: null },
      { t: 'toDark', label: '明转暗', color: 'black', limit: limitDark },
      { t: 'fold', label: '空过', special: true },
      { t: 'pass', label: '放弃加价', special: true }
    ];
    var h = '';
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      var enabled;
      if (d.special) enabled = !!has[d.t];
      else enabled = okFor(d.t, d.color, d.limit);
      var cls = 'btn' + (d.t === 'open' ? ' gold' : '');
      h += '<button class="' + cls + '" data-act="' + d.t + '"' +
        (enabled && interactive ? '' : ' disabled') + '>' + d.label + '</button>';
    }
    $('acts').innerHTML = h;

    var msg = '';
    if (!interactive) {
      msg = '等待其他买家出价…';
    } else {
      msg = '当前全场最大明牌 <b>' + (maxOpenNow() || 0) + '</b>';
      if (sc.length) {
        var okW = sc.every(function (c) { return c.color === 'white' || c.wild; });
        var okB = sc.every(function (c) { return c.color === 'black' || c.wild; });
        msg += ' · 已选 <b>' + ss + '</b> 点（' +
          (okW && okB ? '万能牌·明暗通用' : okW ? '白' : okB ? '黑' : '混色不可用') + '）';
      } else if (p.hand.length) {
        msg += ' · 点击手牌选择要出的牌';
      } else {
        msg += ' · 手牌已空，只能空过保底';
      }
      if (has.open && limitOpen) msg += ' · 明拍须压过 <b>' + limitOpen + '</b>';
      if (has.toDark && limitDark) {
        msg += ' · 明转暗须大于自己的旧明牌 <b>' + limitDark + '</b>';
        var reuseable = sc.filter(function (c) {
          return p.bid && p.bid.type === 'open' &&
            p.bid.cards.some(function (b) { return b.id === c.id; });
        });
        if (reuseable.length) {
          msg += '（已复用场上 <b>' + reuseable.length + '</b> 张，还需补 ' +
            Math.max(0, limitDark + 1 - ss) + ' 点以上）';
        }
      }
      var liveOpp = G.players.filter(function (q) {
        if (q.id === HUMAN) return false;
        if (q.folded) return false;
        if (q.bid && (q.bid.type === 'dark' || q.passed)) return false;
        return true;
      }).length;
      if (!liveOpp) msg += ' · <b>其他买家都已放弃</b>，你可加价或放弃';
    }
    $('hint').innerHTML = msg;
  }

  function renderScore() {
    var rows = G.players.map(function (p) {
      return {
        p: p,
        net: E.netValue(G, p),
        top: E.topN(p, G.cfg.scoreN),
        initial: p.initialSum
      };
    });
    rows.sort(function (a, b) { return b.net - a.net; });
    var h = '<table class="score-table"><tr><th style="text-align:left">买家</th><th>初始</th><th>现值</th><th>净</th></tr>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var cls = (r.p.id === HUMAN ? 'me' : '') + (i === 0 ? ' top' : '');
      h += '<tr class="' + cls + '"><td class="nm">' + esc(r.p.name) + '</td><td>' +
        r.initial + '</td><td>' + r.top + '</td><td><b>' + (r.net > 0 ? '+' : '') + r.net + '</b></td></tr>';
    }
    h += '</table>';
    $('scorebox').innerHTML = h;
  }

  function render(interactive) {
    renderPips(); renderSeats(); renderGoods(); renderHand();
    renderActs(!!interactive); renderScore();
  }

  /* ------------------------------------------------------------ 交互 */
  $('myhand').addEventListener('click', function (e) {
    var el = e.target.closest('.card');
    if (!el || !PENDING) return;
    var id = el.getAttribute('data-id');
    var i = SEL.indexOf(id);
    if (i >= 0) SEL.splice(i, 1); else SEL.push(id);
    renderHand(); renderActs(true);
  });

  $('acts').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-act]');
    if (!b || b.disabled || !PENDING) return;
    var type = b.getAttribute('data-act');
    var done = false;
    if (type === 'fold') {
      var r = E.applyFold(G, HUMAN);
      if (r.ok) { log('<span class="me">你</span>空过，拿走最低商品', 'me'); done = true; }
    } else if (type === 'pass') {
      var r2 = E.applyPass(G, HUMAN);
      if (r2.ok) { log('<span class="me">你</span>不再加价', 'me'); done = true; }
    } else {
      var r3 = E.applyBid(G, HUMAN, type, SEL);
      if (r3.ok) {
        if (type === 'open') {
          log('<span class="me">你</span>明拍 <span class="hl">' + r3.value + '</span>', 'me');
        } else {
          // 暗牌保密：连自己的战报也只记张数，与桌面表现一致
          log('<span class="me">你</span>' + (type === 'dark' ? '暗拍' : '转为暗拍') +
            ' ' + SEL.length + ' 张（保密）', 'me');
        }
        done = true;
      } else {
        toast(r3.msg);
        return;
      }
    }
    if (!done) return;
    SEL = [];
    var f = PENDING; PENDING = null; f();
  });

  function waitHuman() {
    return new Promise(function (res) {
      PENDING = res;
      render(true);
      var p = G.players[HUMAN];
      if (p.bid) toast('轮到你了');
    });
  }

  /* ------------------------------------------------------------ 流程 */
  function aiName(i) { return AI.ROSTER[i % AI.ROSTER.length].name; }

  function newGame(n, diff) {
    N = n;
    if (diff) DIFF = diff;
    G = E.createGame(CARDS, n, { humanSeat: HUMAN, wild: !!WILD });
    G.players[HUMAN].name = '你';
    for (var i = 0; i < G.players.length; i++) {
      if (i !== HUMAN) G.players[i].name = aiName(i);
    }
    PROFILE = [];
    for (var j = 0; j < n; j++) PROFILE.push(AI.tune(AI.ROSTER[j % AI.ROSTER.length], DIFF));
    SEL = [];
    $('log').innerHTML = '';
    log('<span class="hl">开局</span> · ' + n + ' 人局 · 难度 ' + esc(AI.DIFFICULTY[DIFF].label) +
      ' · 每人 ' + G.cfg.handSize + ' 张起始资金' + (WILD ? ' · 万能牌模组：起手整手 8 张不分黑白，数值 1~' + G.cfg.wildMax + ' 每值恰好 2 张' : '') +
      ' · 公共牌堆 ' + G.deck.length + ' 张', 'hl');
    var cfg = G.cfg;
    log('数值范围 1~' + cfg.deckMax + (WILD ? '' : '（初始区 1~' + cfg.initMax + '）') + '· 共 ' +
      cfg.rounds + ' 回合 · 每回合 ' + cfg.goods + ' 件商品（= 人数）' +
      (cfg.strict ? '' : ' · 8 人适配口径'), 'r');
    render(false);
    return runGame();
  }

  async function runGame() {
    for (var r = 0; r < G.cfg.rounds; r++) {
      var info = E.startRound(G);
      render(false);
      var gs = info.goods.map(function (c) { return c.value + '(' + (c.color === 'white' ? '白' : '黑') + ')'; });
      log('<span class="hl">第 ' + G.round + ' 回合</span> 商品：' + gs.join(' ') +
        ' · 起始 ' + esc(info.starter.name), 'hl');
      await sleep(520);
      await runBidding();
      await doSettle();
    }
    showFinal();
  }

  async function runBidding() {
    var guard = 0;
    while (!E.biddingOver(G) && guard++ < 300) {
      var p = E.nextActor(G);
      if (!p) break;
      ACTIVE = p.id;
      if (p.id === HUMAN) {
        await waitHuman();                 // 内部 render(true) 会带上 active 高亮
      } else {
        render(false);
        await sleep(460);
        var d = AI.decide(G, p.id, PROFILE[p.id]);
        if (d.type === 'fold') {
          var rf = E.applyFold(G, p.id);
          log(esc(p.name) + ' 空过' + (rf.card ? '，拿走 ' + rf.card.value : ''));
        } else if (d.type === 'pass') {
          E.applyPass(G, p.id);
        } else {
          var rb = E.applyBid(G, p.id, d.type, d.cards);
          if (rb.ok) {
            var nm = d.type === 'open' ? '明拍' : (d.type === 'dark' ? '暗拍' : '转为暗拍');
            log(esc(p.name) + ' ' + nm + (d.type === 'dark' ? ' ' + d.cards.length + ' 张（保密）'
              : ' <span class="hl">' + rb.value + '</span>'));
          } else {
            E.applyPass(G, p.id);
          }
        }
      }
      render(false);
    }
    ACTIVE = null;
    renderSeats();
  }

  async function doSettle() {
    // 不清 gained：空过者的"拿最低"标签由 applyFold 写入，清掉会看不到。
    // 每回合的 gained 已由 startRound 统一重置。
    var res = E.settle(G);
    render(false);
    log('—— 结算：明拿白、暗拿黑 ——', 'hl');
    for (var i = 0; i < res.picks.length; i++) {
      var pk = res.picks[i];
      G.players[pk.pid].gained = { card: pk.card, via: pk.line };
      var how = pk.line === 'dark' ? '暗线' : (pk.line === 'open' ? '明线' : '比数值');
      log(esc(G.players[pk.pid].name) + '（' + how + '）拿走 <span class="hl">' +
        pk.card.value + '</span> ' + esc(pk.card.name),
        G.players[pk.pid].id === HUMAN ? 'me' : '');
      render(false);
      await sleep(230);
    }
    for (var j = 0; j < res.consumed.length; j++) {
      var c = res.consumed[j];
      log(esc(G.players[c.pid].name) + ' 的 ' + c.cards.length + ' 张出价牌本轮消耗', 'r');
    }
    await sleep(700);
  }

  function showFinal() {
    var rows = E.scoring(G);
    var h = '<h2>' + G.cfg.rounds + ' 次 拍 卖 结 束</h2><div class="sub">净价值 ＝ 终局手牌最大 ' +
      G.cfg.scoreN + ' 张之和 － 起始资金之和</div><div class="result-grid">';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      h += '<div class="r' + (r.id === HUMAN ? ' me' : '') + '">' +
        '<span class="n">' + (i + 1) + '. ' + esc(r.name) +
        '<br><span style="font-size:11px;color:#c9b891">' + r.top + ' − ' + r.initial + '</span></span>' +
        '<span class="v">' + (r.net > 0 ? '+' : '') + r.net + '</span></div>';
    }
    h += '</div>';
    var me = rows.filter(function (r) { return r.id === HUMAN; })[0];
    h += '<div class="note" style="text-align:center">' +
      (me.rank === 1 ? '<b>你赢下了这一局。</b>' : '你的名次：第 ' + me.rank + ' 名。') + '</div>';
    h += '<div class="cta"><button class="btn gold" id="dlgNew">再来一局</button></div>';
    showDialog(h);
    $('dlgNew').onclick = function () { hideDialog(); newGame(N, DIFF); };
  }

  /* ------------------------------------------------------------ 弹层 */
  function showDialog(html) { $('dialog').innerHTML = html; $('mask').classList.add('on'); }
  function hideDialog() { $('mask').classList.remove('on'); }

  function showSetup() {
    var h = '<h2>日 以 继 夜</h2><div class="sub" id="optSub"></div>';
    h += '<div class="note" id="optLead"></div>';
    h += '<div class="opt-cap">人 数</div>';
    h += '<div class="opt-row" id="optN">';
    var opts = [
      { n: 8, t: '1 人 + 7 AI' },
      { n: 7, t: '1 人 + 6 AI' },
      { n: 6, t: '1 人 + 5 AI' },
      { n: 5, t: '1 人 + 4 AI' }
    ];
    for (var i = 0; i < opts.length; i++) {
      h += '<div class="opt' + (opts[i].n === N ? ' on' : '') + '" data-n="' + opts[i].n + '">' +
        opts[i].t + '</div>';
    }
    h += '</div>';
    h += '<div class="opt-cap">难 度</div>';
    h += '<div class="opt-row" id="optD">';
    var dl = ['hard', 'normal', 'casual'];
    for (var d = 0; d < dl.length; d++) {
      h += '<div class="opt' + (dl[d] === DIFF ? ' on' : '') + '" data-d="' + dl[d] + '">' +
        esc(AI.DIFFICULTY[dl[d]].label) + '</div>';
    }
    h += '</div>';
    h += '<div class="opt-cap">万能牌模组</div>';
    h += '<div class="opt-row" id="optW">';
    var wl = [{ v: 0, t: '关' }, { v: 1, t: '开（每人 8 张起手）' }];
    for (var wi = 0; wi < wl.length; wi++) {
      h += '<div class="opt' + (wl[wi].v === WILD ? ' on' : '') + '" data-w="' + wl[wi].v + '">' +
        wl[wi].t + '</div>';
    }
    h += '</div>';
    h += '<div class="note" id="optNote"></div>';
    h += '<div class="cta"><button class="btn gold" id="dlgStart">开 始</button></div>';
    showDialog(h);

    function note() {
      var cfg = E.config(N);
      $('optSub').textContent = '末日市集 · ' + cfg.rounds + ' 次拍卖 · 净价值最高者活到最后';
      $('optLead').innerHTML = '你独自面对 <b>' + (N - 1) + '</b> 名买家。白牌明拍、黑牌暗拍，' +
        '出价越高越先挑货——但<b>全场最高明牌与所有暗牌都会被消耗</b>。';
      var hs = WILD ? 8 : cfg.handSize;
      var wildMax = 4 * N;
      var t = '起始资金每人 ' + hs + ' 张 · 数值 1~' + cfg.deckMax +
        ' · 公共牌堆 ' + ((cfg.deckMax - cfg.deckMin + 1) * 2) + ' 张';
      if (WILD) {
        t = '起始资金每人 <b>8 张万能牌</b>（不分黑白）· 数值 1~<b>' + wildMax +
          '</b>，<b>每个数值恰好 2 张</b>（共 ' + (wildMax * 2) + ' 张，洗牌发完）' +
          ' · 公共牌堆 ' + ((cfg.deckMax - cfg.deckMin + 1) * 2) + ' 张';
      }
      t += '<br>共 <b>' + cfg.rounds + '</b> 回合 · 每回合 <b>' + cfg.goods +
        '</b> 件商品（= 人数）· 计分取最大 <b>' + cfg.scoreN + '</b> 张';
      t += '<br><b>' + esc(AI.DIFFICULTY[DIFF].label) + '</b>：' + (N - 1) +
        ' 名对手实力完全对等（同一套实测最优参数）' +
        (DIFF === 'hard' ? '，硬核即出厂最强档（失误率 0），默认选中。'
          : '；本档让他们按 ' + Math.round(AI.DIFFICULTY[DIFF].blunder * 100) +
            '% 的概率故意挑最差选项，越往下越容易犯错。');
      if (!cfg.strict && !WILD) {
        t += '<br><b>8 人适配口径</b>：本套 112 张按规则书 16x 公式只够 7 人局。8 人局改为' +
          '每人 7 张起手（8×7 = 56，正好是初始区 1~28），公共牌堆 29~56 仍为 56 张；' +
          '守住「每回合商品数 = 人数 = 8」后，回合数 = 56 ÷ 8 = <b>7</b>。' +
          '规则书的「整局 8 回合」本就是「公共牌堆 ÷ 每回合商品数」的导出值，不是独立规则。';
      }
      $('optNote').innerHTML = t;
    }
    note();
    $('optN').addEventListener('click', function (e) {
      var el = e.target.closest('.opt');
      if (!el) return;
      N = +el.getAttribute('data-n');
      document.querySelectorAll('#optN .opt').forEach(function (x) { x.classList.remove('on'); });
      el.classList.add('on');
      note();
    });
    $('optD').addEventListener('click', function (e) {
      var el = e.target.closest('.opt');
      if (!el) return;
      DIFF = el.getAttribute('data-d');
      document.querySelectorAll('#optD .opt').forEach(function (x) { x.classList.remove('on'); });
      el.classList.add('on');
      note();
    });
    $('optW').addEventListener('click', function (e) {
      var el = e.target.closest('.opt');
      if (!el) return;
      WILD = +el.getAttribute('data-w');
      document.querySelectorAll('#optW .opt').forEach(function (x) { x.classList.remove('on'); });
      el.classList.add('on');
      note();
    });
    $('dlgStart').onclick = function () { hideDialog(); newGame(N, DIFF); };
  }

  function showRules() {
    var h = '<h2>规 则 速 查</h2><div class="sub">一句话：明拿白、暗拿黑，配不上就比数字</div>';
    h += '<div class="note">' +
      '<b>回合行动四选一</b><br>' +
      '<b>明拍</b>：打任意张白牌，整组替换，新组总和须压过他人最大明牌<br>' +
      '<b>暗拍</b>：仅面前无牌时可出黑牌，一口价，不可改、不可撤、不可转明<br>' +
      '<b>明转暗</b>：把明牌换成暗牌，新暗牌须大于自己的旧明牌<br>' +
      '<b>空过</b>：仅面前无牌，立即拿全场最低商品，本回合不再出价<br><br>' +
      '<b>取货</b>：暗最大取黑最大、暗第二取黑第二；明最大取白最大、明第二取白第二。<br>' +
      '场上场下颜色完全不同时，不区分颜色，按出价数字从大到小取最大。<br>' +
      '同价位：顺位靠前者拿价值较低的。<br><br>' +
      '<b>消耗</b>：全场最高明牌与全部暗牌本轮消耗；其余明牌收回手牌。<br>' +
      '<b>顺位</b>：第一场由起始资金最低者先手，此后由当前净价值最低者先手。<br>' +
      '<b>商品</b>：每回合亮出 x 件（x = 人数），8 次拍卖为规则书标准局（人数适配时回合数随之调整）。<br>' +
      '<b>计分</b>：净价值 ＝ 终局手牌最大 ' + (G ? G.cfg.scoreN : 8) + ' 张之和 － 起始资金之和。' +
      '</div>';
    h += '<div class="cta"><button class="btn" id="dlgClose">知道了</button></div>';
    showDialog(h);
    $('dlgClose').onclick = hideDialog;
  }

  function showScore() {
    if (!G) return;
    var rows = E.scoring(G);
    var h = '<h2>计 分 板</h2><div class="sub">第 ' + G.round + ' / ' + G.cfg.rounds + ' 回合</div>';
    h += '<table class="score-table" style="font-size:13px"><tr><th style="text-align:left">买家</th>' +
      '<th>手牌</th><th>起始</th><th>最大' + G.cfg.scoreN + '张</th><th>净价值</th></tr>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      h += '<tr class="' + (r.id === HUMAN ? 'me' : '') + '"><td class="nm">' + esc(r.name) +
        '</td><td>' + r.handCount + '</td><td>' + r.initial + '</td><td>' + r.top +
        '</td><td><b>' + (r.net > 0 ? '+' : '') + r.net + '</b></td></tr>';
    }
    h += '</table><div class="cta"><button class="btn" id="dlgClose2">关闭</button></div>';
    showDialog(h);
    $('dlgClose2').onclick = hideDialog;
  }

  $('btnRules').onclick = showRules;
  $('btnScore').onclick = showScore;
  $('btnNew').onclick = showSetup;
  $('mask').addEventListener('click', function (e) {
    if (e.target === $('mask') && G) hideDialog();
  });

  showSetup();
})();
