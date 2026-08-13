(() => {
  const state = {
    side: "BUY",
    history: [],
    account: null,
    position: { qty: 0, avg_price: 0 },
    orders: [],
    trades: [],
    multiplier: 5,
    chartMode: "line",
    lineRangeSeconds: 15 * 60,
    candleIntervalSeconds: 60,
    // 0 means "show the whole session" (no lookback filter applied).
    candleRangeSeconds: 0,
    hoverIndex: null,
    // Set by clicking/tapping a point on the chart; overrides hoverIndex so
    // the crosshair/tooltip stays put after the mouse leaves or a touch
    // ends (touch devices have no hover state to fall back on).
    pinnedIndex: null,
    lastLayout: null,
    positionModalOpen: false,
    modalRecordQty: null,
    recordTab: "holdings",
    lastTick: null,
    // 台指期日盤/夜盤: which session the chart is currently showing.
    // Auto-follows the live session until the user manually picks one.
    session: "day",
    sessionManual: false,
    // Technical indicators (K線 only). Bollinger overlays the main chart;
    // subpanel is a single switchable panel (KD/MACD/RSI), not simultaneous
    // multiple panels — see docs/trading-info-chart-spec.md P0-11/P0-12.
    bbandsOn: false,
    subpanel: "off", // "off" | "kd" | "macd" | "rsi"
  };

  // Taiwan market convention is the reverse of the US one used elsewhere in
  // web dev: red = 漲 (up), green = 跌 (down).
  const COLOR_UP = "#ff5c5c";
  const COLOR_DOWN = "#3ddc84";

  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 2) => (n === null || n === undefined ? "--" : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
  const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString();

  // --- 台指期日盤/夜盤 session classification -----------------------------
  // Day session: 08:45–13:45 Taipei time. Night session: 15:00–next 05:00
  // (crosses midnight, so its "trading day" is keyed off the evening it
  // started). Everything else is market-closed and shouldn't appear in the
  // feed at all, but is handled defensively.
  const taipeiFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  function taipeiDateKey(ts) {
    const parts = taipeiFormatter.formatToParts(new Date(ts * 1000));
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  function taipeiClassify(ts) {
    const parts = taipeiFormatter.formatToParts(new Date(ts * 1000));
    const get = (t) => parts.find((p) => p.type === t).value;
    const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
    const minutesOfDay = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
    if (minutesOfDay >= 525 && minutesOfDay < 825) return { session: "day", blockKey: `day-${dateKey}` };
    if (minutesOfDay >= 900) return { session: "night", blockKey: `night-${dateKey}` };
    if (minutesOfDay < 300) return { session: "night", blockKey: `night-${taipeiDateKey(ts - 12 * 3600)}` };
    return { session: "closed", blockKey: null };
  }

  function sessionLabelText(blockKey, sessionType) {
    if (!blockKey) return sessionType === "night" ? "夜盤" : "日盤";
    const [, m, d] = blockKey.slice(blockKey.indexOf("-") + 1).split("-");
    return sessionType === "night" ? `夜盤 ${m}/${d} 15:00起` : `日盤 ${m}/${d}`;
  }

  // Matches the button labels in #chart-range-group / #chart-interval-group
  // (…30分, 1小時) so the legend reads the same way the control does.
  function minutesLabel(sec) {
    const m = sec / 60;
    return m === 60 ? "1小時" : `${m}分`;
  }

  // Points carry a cached {session, blockKey} (set once when they enter
  // state.history) so scanning the history for a session's boundaries is
  // plain property comparison, not a fresh Intl call per point per redraw.
  function findSessionBlock(historyArr, sessionType) {
    let blockKey = null, endIdx = -1;
    for (let i = historyArr.length - 1; i >= 0; i--) {
      if (historyArr[i].session === sessionType) {
        blockKey = historyArr[i].blockKey;
        endIdx = i;
        break;
      }
    }
    if (blockKey === null) return { points: [], prevClose: null, blockKey: null };

    let startIdx = endIdx;
    for (let i = endIdx; i >= 0; i--) {
      if (historyArr[i].session !== sessionType || historyArr[i].blockKey !== blockKey) break;
      startIdx = i;
    }

    let prevClose = null;
    for (let i = startIdx - 1; i >= 0; i--) {
      if (historyArr[i].session === sessionType && historyArr[i].blockKey !== blockKey) {
        prevClose = historyArr[i].price;
        break;
      }
    }

    return { points: historyArr.slice(startIdx, endIdx + 1), prevClose, blockKey };
  }

  function syncSessionButtons() {
    document.querySelectorAll(".chart-session-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.session === state.session);
    });
  }

  // Quote-header badge + 開/高/低 for whichever session is currently shown —
  // shares the same `state.session` and `findSessionBlock` the chart legend
  // already uses, so the two never disagree on which session is "current".
  function renderSessionStats() {
    $("session-badge").textContent = state.session === "night" ? "夜盤" : "日盤";
    const points = findSessionBlock(state.history, state.session).points;
    if (!points.length) {
      $("price-open").textContent = "--";
      $("price-high").textContent = "--";
      $("price-low").textContent = "--";
      return;
    }
    const prices = points.map((p) => p.price);
    $("price-open").textContent = fmt(points[0].price, 1);
    $("price-high").textContent = fmt(Math.max(...prices), 1);
    $("price-low").textContent = fmt(Math.min(...prices), 1);
  }

  // Only fired when the session flips automatically (not from a manual
  // 日盤/夜盤 button click) — a real-time price feed doesn't announce a
  // session boundary any other way, so without this the quote/chart would
  // just look "stuck" for a moment right at the handover.
  let sessionToastTimer = null;
  function showSessionToast(text) {
    const el = $("session-toast");
    el.textContent = text;
    el.classList.add("visible");
    clearTimeout(sessionToastTimer);
    sessionToastTimer = setTimeout(() => el.classList.remove("visible"), 3000);
  }

  const INDICATOR_PREFS_KEY = "chartIndicators";

  function loadIndicatorPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem(INDICATOR_PREFS_KEY));
      if (!prefs) return;
      if (typeof prefs.bbandsOn === "boolean") state.bbandsOn = prefs.bbandsOn;
      if (["off", "kd", "macd", "rsi"].includes(prefs.subpanel)) state.subpanel = prefs.subpanel;
    } catch {
      // malformed/absent localStorage entry — keep the defaults
    }
  }

  function saveIndicatorPrefs() {
    localStorage.setItem(INDICATOR_PREFS_KEY, JSON.stringify({ bbandsOn: state.bbandsOn, subpanel: state.subpanel }));
  }

  // K線-only controls (布林通道 toggle + 副圖 select) only make sense in
  // candle mode; the subpanel additionally only shows when a series is
  // actually selected. Called whenever chartMode or subpanel changes.
  function updateIndicatorVisibility() {
    const isCandle = state.chartMode === "candle";
    $("chart-indicator-group").classList.toggle("hidden", !isCandle);
    $("chart-subpanel-wrap").classList.toggle("hidden", !isCandle || state.subpanel === "off");
  }

  async function bootstrapAuth() {
    const res = await fetch("/api/auth/me");
    if (!res.ok) {
      window.location.href = "/login.html";
      return null;
    }
    const user = await res.json();
    $("avatar-btn").textContent = (user.display_name || user.email || "?").trim().charAt(0).toUpperCase();
    $("user-dropdown-name").textContent = user.display_name;
    $("user-dropdown-email").textContent = user.email;
    $("admin-link").classList.toggle("hidden", user.role !== "admin");
    return user;
  }

  $("avatar-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const dropdown = $("user-dropdown");
    const willShow = dropdown.classList.contains("hidden");
    dropdown.classList.toggle("hidden", !willShow);
    $("avatar-btn").setAttribute("aria-expanded", String(willShow));
  });
  document.addEventListener("click", (e) => {
    const menu = document.querySelector(".user-menu");
    if (menu && !menu.contains(e.target)) {
      $("user-dropdown").classList.add("hidden");
      $("avatar-btn").setAttribute("aria-expanded", "false");
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => $("status-dot").classList.add("connected");
    ws.onclose = () => {
      $("status-dot").classList.remove("connected");
      setTimeout(connect, 1500);
    };
    ws.onerror = () => ws.close();

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      handleMessage(msg);
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "snapshot": {
        const d = msg.data;
        $("instrument-name").textContent = d.instrument.name;
        $("instrument-symbol").textContent = d.instrument.symbol;
        state.multiplier = d.instrument.multiplier;
        setSide(state.side);
        state.history = d.history.map((p) => Object.assign({}, p, taipeiClassify(p.ts)));
        state.session = state.history.length ? state.history[state.history.length - 1].session : "day";
        if (state.session === "closed") state.session = "day";
        state.sessionManual = false;
        syncSessionButtons();
        renderSessionStats();
        if (d.tick && d.tick.mid) renderPrice(d.tick);
        state.account = d.account;
        state.position = d.position;
        state.orders = d.orders;
        state.trades = d.trades;
        renderAll();
        break;
      }
      case "tick": {
        const info = taipeiClassify(msg.data.ts);
        state.history.push({ ts: msg.data.ts, price: msg.data.mid, session: info.session, blockKey: info.blockKey });
        if (state.history.length > 20000) state.history.shift(); // keep in sync with backend MAX_TICK_HISTORY
        if (!state.sessionManual && info.session !== "closed" && info.session !== state.session) {
          state.session = info.session;
          syncSessionButtons();
          showSessionToast(info.session === "night" ? "已轉為夜盤" : "已轉為日盤");
        }
        renderSessionStats(); // 開/高/低 can extend on every tick, not just on session change
        renderPrice(msg.data);
        drawChart();
        renderHoldings(); // live unrealized P&L per lot depends on the current price
        break;
      }
      case "account":
        state.account = msg.data;
        renderAccount();
        renderPosition();
        break;
      case "position":
        state.position = msg.data;
        renderPosition();
        renderOrders();
        renderHoldings();
        renderHistory();
        drawChart();
        break;
      case "order": {
        const idx = state.orders.findIndex((o) => o.id === msg.data.id);
        if (idx >= 0) state.orders[idx] = msg.data;
        else state.orders.unshift(msg.data);
        renderOrders();
        if (msg.data.status === "REJECTED") {
          $("order-error").textContent = `下單失敗: ${msg.data.reject_reason || "unknown"}`;
        }
        break;
      }
      // Monthly contract rollover: the backend force-closed every open
      // position and switched which feed symbol it tracks. Its tick
      // history was cleared server-side too (different contract, different
      // price series), so mirror that here rather than let the chart keep
      // showing the expired contract's prices under the new symbol's label.
      case "instrument": {
        $("instrument-name").textContent = msg.data.name;
        $("instrument-symbol").textContent = msg.data.symbol;
        state.multiplier = msg.data.multiplier;
        setSide(state.side);
        state.history = [];
        state.session = "day";
        state.sessionManual = false;
        syncSessionButtons();
        renderSessionStats();
        state.lastTick = null;
        $("price-mid").textContent = "--";
        $("price-bid").textContent = "--";
        $("price-ask").textContent = "--";
        $("price-chg").textContent = "--";
        $("price-chg").className = "chg";
        renderDepth(null);
        drawChart();
        break;
      }
      case "trade":
        state.trades.unshift(msg.data);
        renderHoldings();
        renderHistory();
        break;
    }
  }

  function renderAll() {
    renderAccount();
    renderPosition();
    renderOrders();
    renderHoldings();
    renderHistory();
    drawChart();
  }

  // 五檔委買委賣 — bar width scaled to the largest quantity currently shown
  // across both sides, so relative size at a glance means something.
  function renderDepth(tick) {
    const wrap = $("depth-ladder");
    if (!tick || !tick.ask_levels || !tick.ask_levels.length || !tick.bid_levels || !tick.bid_levels.length) {
      wrap.innerHTML = '<div class="depth-empty">尚無五檔資料</div>';
      return;
    }
    const maxQty = Math.max(1, ...tick.bid_levels.map((l) => l[1]), ...tick.ask_levels.map((l) => l[1]));
    const row = (level, cls) => {
      const [price, qty] = level;
      const pct = Math.round((qty / maxQty) * 100);
      return `<div class="depth-row ${cls}"><span class="depth-bar" style="width:${pct}%"></span><span class="depth-price">${fmt(price, 1)}</span><span class="depth-qty">${qty}</span></div>`;
    };
    // Farthest ask at the top, best ask just above the gap, best bid just
    // below it, farthest bid at the bottom — the usual depth-ladder order.
    const asksTopDown = [...tick.ask_levels].reverse();
    wrap.innerHTML =
      `<div class="depth-side">${asksTopDown.map((l) => row(l, "ask")).join("")}</div>` +
      `<div class="depth-mid-gap"></div>` +
      `<div class="depth-side">${tick.bid_levels.map((l) => row(l, "bid")).join("")}</div>`;
  }

  function renderPrice(tick) {
    state.lastTick = tick;
    $("price-mid").textContent = fmt(tick.mid, 1);
    $("price-bid").textContent = fmt(tick.bid, 1);
    $("price-ask").textContent = fmt(tick.ask, 1);
    renderDepth(tick);

    const chgEl = $("price-chg");
    const info = taipeiClassify(tick.ts);
    const prevClose = info.session === "closed" ? null : findSessionBlock(state.history, info.session).prevClose;
    if (prevClose == null) {
      chgEl.textContent = "--";
      chgEl.className = "chg";
      return;
    }
    const delta = tick.mid - prevClose;
    const pct = (delta / prevClose) * 100;
    const dir = delta > 0 ? "up" : delta < 0 ? "down" : "";
    const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "";
    chgEl.textContent = `${arrow} ${fmt(Math.abs(delta), 1)} (${delta >= 0 ? "+" : "-"}${fmt(Math.abs(pct), 2)}%)`;
    chgEl.className = "chg " + dir;
  }

  function renderAccount() {
    const a = state.account;
    if (!a) return;
    $("acc-balance").textContent = fmt(a.balance);
    $("acc-equity").textContent = fmt(a.equity);
    $("acc-used-margin").textContent = fmt(a.used_margin);
    $("acc-free-margin").textContent = fmt(a.free_margin);
    const upnlEl = $("acc-upnl");
    upnlEl.textContent = fmt(a.unrealized_pnl);
    upnlEl.className = "value " + (a.unrealized_pnl > 0 ? "up" : a.unrealized_pnl < 0 ? "down" : "");
  }

  function positionRiskLabel(p) {
    if (p.stop_loss == null && p.take_profit == null) return "未設定";
    const sl = p.stop_loss != null ? `SL ${fmt(p.stop_loss, 1)}` : "SL --";
    const tp = p.take_profit != null ? `TP ${fmt(p.take_profit, 1)}` : "TP --";
    return `${sl} / ${tp}`;
  }

  function renderPosition() {
    const p = state.position;
    const hasPos = p && p.qty !== 0;
    $("position-empty").classList.toggle("hidden", hasPos);
    $("position-detail").classList.toggle("hidden", !hasPos);
    if (!hasPos) {
      if (state.positionModalOpen) hidePositionModal();
      return;
    }
    const dir = p.qty > 0 ? "多 Long" : "空 Short";
    $("pos-side-qty").textContent = `${dir} ${Math.abs(p.qty)}`;
    $("pos-avg").textContent = fmt(p.avg_price, 1);
    const upnl = state.account ? state.account.unrealized_pnl : 0;
    const upnlEl = $("pos-upnl");
    upnlEl.textContent = fmt(upnl);
    upnlEl.className = "value " + (upnl > 0 ? "up" : upnl < 0 ? "down" : "");
    $("pos-sl-tp").textContent = positionRiskLabel(p);

    if (state.positionModalOpen) renderPositionModalStats();
  }

  function renderPositionModalStats() {
    const p = state.position;
    const dir = p.qty > 0 ? "多 Long" : "空 Short";
    $("modal-pos-side-qty").textContent = `${dir} ${Math.abs(p.qty)}`;
    $("modal-pos-avg").textContent = fmt(p.avg_price, 1);
    const upnl = state.account ? state.account.unrealized_pnl : 0;
    const upnlEl = $("modal-pos-upnl");
    upnlEl.textContent = fmt(upnl);
    upnlEl.className = "value " + (upnl > 0 ? "up" : upnl < 0 ? "down" : "");

    const allBtn = $("modal-pos-close-all");
    allBtn.textContent = `全部平倉 (${Math.abs(p.qty)} 口)`;

    const recordBtn = $("modal-pos-close-record");
    if (state.modalRecordQty != null) {
      const clamped = Math.min(state.modalRecordQty, Math.abs(p.qty));
      recordBtn.textContent = `平倉此筆 (${clamped} 口)`;
      // Once this fill's quantity covers the whole remaining position,
      // "this record" and "all" are the same action — just show one button.
      recordBtn.classList.toggle("hidden", clamped >= Math.abs(p.qty));
    } else {
      recordBtn.classList.add("hidden");
    }
  }

  // recordQty: the quantity tied to the specific order/trade row the user
  // clicked (if any) — lets the modal offer a "just close this fill" option
  // alongside closing the whole position. Opened from the position summary
  // card itself, there's no single record in play, so it's omitted.
  function openPositionModal(recordQty = null) {
    if (state.position.qty === 0) return;
    $("modal-pos-error").textContent = "";
    $("modal-pos-sl").value = state.position.stop_loss ?? "";
    $("modal-pos-tp").value = state.position.take_profit ?? "";
    state.positionModalOpen = true;
    state.modalRecordQty = recordQty;
    renderPositionModalStats();
    $("position-modal").classList.remove("hidden");
  }

  function hidePositionModal() {
    state.positionModalOpen = false;
    $("position-modal").classList.add("hidden");
  }

  // A fill (order or trade) still belongs to the *currently open* position
  // when it happened at/after that position's opened_at — i.e. it hasn't
  // been closed out yet, so it's still meaningful to jump into "manage
  // position" from it. Anything before that cutoff is already-settled
  // history and shouldn't look actionable.
  function openPositionCutoff() {
    return state.position && state.position.qty !== 0 ? state.position.opened_at : null;
  }

  function wireEditableRows(body) {
    body.querySelectorAll("tr.clickable").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("[data-cancel]")) return;
        const qty = tr.dataset.qty ? Number(tr.dataset.qty) : null;
        openPositionModal(qty);
      });
    });
  }

  // Orders table is pure history + the ability to cancel a still-pending
  // order — no click-to-manage-position affordance here (that lives on the
  // position card and the trades table instead).
  function renderOrders() {
    const body = $("orders-body");
    if (!state.orders.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="7">尚無委託</td></tr>';
      return;
    }
    body.innerHTML = state.orders
      .slice(0, 30)
      .map((o) => {
        const price = o.status === "FILLED" ? fmt(o.filled_price, 1) : o.limit_price ? fmt(o.limit_price, 1) : "MKT";
        const cancelBtn = o.status === "PENDING" ? `<button class="mini-btn" data-cancel="${o.id}">取消</button>` : "";
        return `<tr>
          <td>${fmtTime(o.created_at)}</td>
          <td class="${o.side === "BUY" ? "up" : "down"}">${o.side}</td>
          <td>${o.order_type}</td>
          <td>${o.qty}</td>
          <td>${price}</td>
          <td>${o.status}</td>
          <td>${cancelBtn}</td>
        </tr>`;
      })
      .join("");

    body.querySelectorAll("[data-cancel]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        cancelOrder(btn.dataset.cancel);
      });
    });
  }

  // The price to mark an open lot at, matching the backend's own
  // account_snapshot logic: longs mark at bid (what you'd get selling out),
  // shorts at ask (what you'd pay to buy back).
  function markPriceForPosition() {
    if (!state.lastTick || state.position.qty === 0) return null;
    return state.position.qty > 0 ? state.lastTick.bid : state.lastTick.ask;
  }

  // 庫存: the fills that make up the currently open position — same
  // "editable" cutoff as before, just given its own tab instead of being
  // mixed into the full trade list. Each row's P&L is unrealized (marked to
  // the live price), since none of these fills have closed anything yet.
  function renderHoldings() {
    const body = $("holdings-body");
    const cutoff = openPositionCutoff();
    const holdings = cutoff != null ? state.trades.filter((t) => t.ts >= cutoff) : [];
    if (!holdings.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="6">尚無庫存</td></tr>';
      return;
    }
    const mark = markPriceForPosition();
    body.innerHTML = holdings
      .slice(0, 30)
      .map((t) => {
        const direction = t.side === "BUY" ? 1 : -1;
        const upnl = mark != null ? (mark - t.price) * t.qty * direction * state.multiplier : null;
        const upnlClass = upnl > 0 ? "up" : upnl < 0 ? "down" : "";
        return `<tr class="clickable" data-qty="${t.qty}">
          <td>${fmtTime(t.ts)}</td>
          <td class="${t.side === "BUY" ? "up" : "down"}">${t.side}</td>
          <td>${t.qty}</td>
          <td>${fmt(t.price, 1)}</td>
          <td class="${upnlClass}">${upnl == null ? "--" : fmt(upnl)}</td>
          <td><span class="badge editable">可編輯</span></td>
        </tr>`;
      })
      .join("");

    wireEditableRows(body);
  }

  // 歷史紀錄: everything before the current position's opened_at cutoff —
  // already closed out, so realized P&L is meaningful and there's nothing
  // left to manage (not clickable).
  function renderHistory() {
    const body = $("history-body");
    const cutoff = openPositionCutoff();
    const history = state.trades.filter((t) => cutoff == null || t.ts < cutoff);
    if (!history.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="5">尚無歷史紀錄</td></tr>';
      return;
    }
    body.innerHTML = history
      .slice(0, 30)
      .map(
        (t) => `<tr>
          <td>${fmtTime(t.ts)}</td>
          <td class="${t.side === "BUY" ? "up" : "down"}">${t.side}</td>
          <td>${t.qty}</td>
          <td>${fmt(t.price, 1)}</td>
          <td class="${t.realized_pnl > 0 ? "up" : t.realized_pnl < 0 ? "down" : ""}">${fmt(t.realized_pnl)}</td>
        </tr>`
      )
      .join("");
  }

  function setRecordTab(tab) {
    state.recordTab = tab;
    document.querySelectorAll(".record-tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.recordTab === tab);
    });
    document.querySelectorAll(".record-tab-content").forEach((el) => {
      el.classList.toggle("hidden", el.id !== `record-tab-${tab}`);
    });
  }

  // MA5/10/20 are the conventional trio on a candlestick chart; colors are
  // picked to stay legible against both the red/green candles and the blue
  // avg-price / gray 昨收 overlay lines.
  const MA_STYLES = [
    { period: 5, color: "#f2c94c" },
    { period: 10, color: "#bb86fc" },
    { period: 20, color: "#64d8ff" },
  ];

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  // Standard EMA, seeded with a plain SMA over the first `period` values
  // (the conventional way to start an EMA without a longer runway of data).
  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let sum = 0, prev = null;
    for (let i = 0; i < values.length; i++) {
      if (i < period - 1) {
        sum += values[i];
        continue;
      }
      if (i === period - 1) {
        sum += values[i];
        prev = sum / period;
      } else {
        prev = values[i] * k + prev * (1 - k);
      }
      out[i] = prev;
    }
    return out;
  }

  // Runs `ema` on the non-null tail of a series (e.g. MACD's DIF line,
  // which is null until both its underlying EMAs have warmed up) and pads
  // the result back out to the original length.
  function emaOnTail(values, period) {
    const out = new Array(values.length).fill(null);
    const firstValid = values.findIndex((v) => v != null);
    if (firstValid === -1) return out;
    ema(values.slice(firstValid), period).forEach((v, i) => { out[firstValid + i] = v; });
    return out;
  }

  // KD (隨機指標). Defaults 9,3,3 match docs/chart-technical-indicators-spec.md.
  function computeKD(candles, rsvPeriod = 9, kSmooth = 3, dSmooth = 3) {
    const k = new Array(candles.length).fill(null);
    const d = new Array(candles.length).fill(null);
    let prevK = 50, prevD = 50; // conventional neutral seed for the first calculable bar
    for (let i = rsvPeriod - 1; i < candles.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - rsvPeriod + 1; j <= i; j++) {
        hh = Math.max(hh, candles[j].h);
        ll = Math.min(ll, candles[j].l);
      }
      const rsv = hh === ll ? 50 : ((candles[i].c - ll) / (hh - ll)) * 100;
      prevK = (prevK * (kSmooth - 1) + rsv) / kSmooth;
      prevD = (prevD * (dSmooth - 1) + prevK) / dSmooth;
      k[i] = prevK;
      d[i] = prevD;
    }
    return { k, d };
  }

  // MACD. Defaults 12,26,9. `macd` here is the 訊號線/signal line (EMA of
  // DIF) — matches the naming in docs/chart-technical-indicators-spec.md.
  function computeMACD(candles, fast = 12, slow = 26, signal = 9) {
    const closes = candles.map((c) => c.c);
    const emaFast = ema(closes, fast);
    const emaSlow = ema(closes, slow);
    const dif = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null));
    const macd = emaOnTail(dif, signal);
    const hist = dif.map((v, i) => (v != null && macd[i] != null ? v - macd[i] : null));
    return { dif, macd, hist };
  }

  // RSI, Wilder's smoothing. Default period 14.
  function computeRSI(candles, period = 14) {
    const closes = candles.map((c) => c.c);
    const out = new Array(closes.length).fill(null);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      const gain = Math.max(change, 0), loss = Math.max(-change, 0);
      if (i < period) {
        avgGain += gain;
        avgLoss += loss;
        continue;
      }
      if (i === period) {
        avgGain = (avgGain + gain) / period;
        avgLoss = (avgLoss + loss) / period;
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
      }
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  // Bollinger Bands. Default 20-period SMA ± 2 standard deviations.
  function computeBollinger(candles, period = 20, mult = 2) {
    const closes = candles.map((c) => c.c);
    const mid = sma(closes, period);
    const upper = new Array(closes.length).fill(null);
    const lower = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
      let sumSq = 0;
      for (let j = i - period + 1; j <= i; j++) sumSq += (closes[j] - mid[i]) ** 2;
      const sd = Math.sqrt(sumSq / period);
      upper[i] = mid[i] + mult * sd;
      lower[i] = mid[i] - mult * sd;
    }
    return { mid, upper, lower };
  }

  // Last non-null value in a series (e.g. an MA) plus an arrow comparing it
  // to the previous non-null value — used for legend readouts. Returns null
  // if the series has no data yet (still in its warmup period).
  function lastTrend(values) {
    let lastIdx = -1;
    for (let i = values.length - 1; i >= 0; i--) {
      if (values[i] != null) { lastIdx = i; break; }
    }
    if (lastIdx === -1) return null;
    let prevIdx = -1;
    for (let i = lastIdx - 1; i >= 0; i--) {
      if (values[i] != null) { prevIdx = i; break; }
    }
    const value = values[lastIdx];
    const prev = prevIdx === -1 ? null : values[prevIdx];
    const arrow = prev == null ? "" : value > prev ? "▲" : value < prev ? "▼" : "";
    return { value, arrow };
  }

  // Values with `null` gaps (the MA warmup period) break the line rather
  // than drawing a misleading segment down to zero.
  function drawSeriesLine(ctx, xFn, yFn, values, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    let started = false;
    values.forEach((v, i) => {
      if (v == null) {
        started = false;
        return;
      }
      const px = xFn(i), py = yFn(v);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    });
    ctx.stroke();
  }

  function buildCandles(points, intervalSec) {
    const bins = new Map();
    for (const p of points) {
      const t0 = Math.floor(p.ts / intervalSec) * intervalSec;
      let bin = bins.get(t0);
      if (!bin) {
        bin = { t: t0, o: p.price, h: p.price, l: p.price, c: p.price };
        bins.set(t0, bin);
      } else {
        bin.h = Math.max(bin.h, p.price);
        bin.l = Math.min(bin.l, p.price);
        bin.c = p.price;
      }
    }
    return Array.from(bins.values()).sort((a, b) => a.t - b.t);
  }

  // x is a time scale now (not evenly spaced by index), so hit-testing a
  // mouse pixel back to "which point" needs a nearest-timestamp search
  // rather than a direct proportional index calculation.
  function findNearestIndexByTime(timestamps, t) {
    let lo = 0, hi = timestamps.length - 1;
    if (t <= timestamps[0]) return 0;
    if (t >= timestamps[hi]) return hi;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (timestamps[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(timestamps[lo - 1] - t) <= Math.abs(timestamps[lo] - t)) return lo - 1;
    return lo;
  }

  function fmtClock(ts) {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Rounds a rough tick spacing to a "nice" 1/2/5 × 10ⁿ step, so axis
  // labels land on numbers a human would pick rather than an arbitrary
  // division of the visible range into N equal parts.
  function niceStep(roughStep) {
    if (!(roughStep > 0)) return 1;
    const exp = Math.floor(Math.log10(roughStep));
    const base = Math.pow(10, exp);
    const frac = roughStep / base;
    const niceFrac = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
    return niceFrac * base;
  }

  // Candidate spacings for X-axis ticks, in seconds: 1/5/10/15/30 min,
  // 1/2/4 hour — covers everything from a 5-minute line-chart window up to
  // a full ~14h night session shown "全部".
  const TIME_TICK_STEPS = [60, 300, 600, 900, 1800, 3600, 7200, 14400];
  const TAIPEI_OFFSET_SECONDS = 8 * 3600;

  // Picks a step that lands 4~6 ticks in [tStart, tEnd], then aligns them to
  // real clock boundaries (on the minute/hour) instead of splitting the
  // visible range into N even-but-arbitrary slices. Taiwan is fixed UTC+8
  // with no DST, so aligning to local clock boundaries is just arithmetic —
  // no need to round-trip through the Intl formatter taipeiClassify() uses.
  function niceTimeTicks(tStart, tEnd) {
    const span = tEnd - tStart || 1;
    let step = TIME_TICK_STEPS[TIME_TICK_STEPS.length - 1];
    for (const candidate of TIME_TICK_STEPS) {
      if (span / candidate <= 6) {
        step = candidate;
        break;
      }
    }
    const ticks = [];
    let t = Math.ceil((tStart + TAIPEI_OFFSET_SECONDS) / step) * step - TAIPEI_OFFSET_SECONDS;
    for (; t <= tEnd; t += step) {
      if (t >= tStart) ticks.push(t);
    }
    return ticks;
  }

  // Nudges labels that would render too close together in Y apart, while
  // leaving each item's reference line at its true price height (`y`) —
  // only the label's own position (`labelY`) moves. Mutates and returns
  // `items`, sorted top-to-bottom.
  function declutterLabels(items, minGap) {
    items.sort((a, b) => a.y - b.y);
    items.forEach((it) => { it.labelY = it.y; });
    for (let i = 1; i < items.length; i++) {
      if (items[i].labelY - items[i - 1].labelY < minGap) {
        items[i].labelY = items[i - 1].labelY + minGap;
      }
    }
    return items;
  }

  // A solid, boxed label pinned to the right axis — used for 現價/昨收 so
  // they read at a glance instead of blending into the plain-text overlay
  // labels used for 均價/停損/停利 (drawOverlayLine). `labelY` may differ
  // from `yy` (the line's true height) when declutterLabels nudged it.
  function drawPriceTag(ctx, plotW, yy, labelY, color, label) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(plotW, yy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "10px sans-serif";
    const boxW = ctx.measureText(label).width + 8, boxH = 14;
    ctx.fillStyle = color;
    ctx.fillRect(plotW, labelY - boxH / 2, boxW, boxH);
    ctx.fillStyle = "#0b0f17";
    ctx.textBaseline = "middle";
    ctx.fillText(label, plotW + 4, labelY + 1);
    ctx.textBaseline = "alphabetic";
  }

  function drawOverlayLine(ctx, plotW, yy, labelY, color, label) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(plotW, yy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = "10px sans-serif";
    ctx.fillText(label, 4, labelY - 3);
  }

  function updateTooltip(isCandle, point, xx, w) {
    const tip = $("chart-tooltip");
    if (isCandle) {
      tip.innerHTML = `<div>${fmtTime(point.t)}</div><div>開 ${fmt(point.o, 1)}&nbsp;&nbsp;高 ${fmt(point.h, 1)}</div><div>低 ${fmt(point.l, 1)}&nbsp;&nbsp;收 ${fmt(point.c, 1)}</div>`;
    } else {
      tip.innerHTML = `<div>${fmtTime(point.ts)}</div><div>價格 ${fmt(point.price, 1)}</div>`;
    }
    tip.classList.remove("hidden");
    tip.style.left = `${Math.max(4, xx > w - 130 ? xx - 120 : xx + 10)}px`;
  }

  function drawChart() {
    const canvas = $("chart");
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);

    const isCandle = state.chartMode === "candle";
    // Chart only ever shows one 日盤/夜盤 block at a time — the two sessions
    // are separated by multi-hour closed gaps, so connecting across them
    // (or letting a 2h candle lookback bleed into the prior session) would
    // draw a misleading line/reference set.
    const sessionBlock = findSessionBlock(state.history, state.session);
    const sessionPoints = sessionBlock.points;

    // Real quotes don't arrive on a steady 1-tick/sec cadence, so windows are
    // cut by actual timestamp rather than array-index count.
    const lastTs = sessionPoints.length ? sessionPoints[sessionPoints.length - 1].ts : null;
    const linePoints = lastTs === null ? [] : sessionPoints.filter((p) => p.ts >= lastTs - state.lineRangeSeconds);
    const candleSourcePoints =
      state.candleRangeSeconds > 0 && lastTs !== null
        ? sessionPoints.filter((p) => p.ts >= lastTs - state.candleRangeSeconds)
        : sessionPoints;
    const candles = isCandle ? buildCandles(candleSourcePoints, state.candleIntervalSeconds) : null;

    // The most recent bar's time window may not have closed yet — flag it so
    // it isn't mistaken for a settled candle.
    const nowSec = Date.now() / 1000;
    const lastCandleLive =
      isCandle && candles.length > 0 && nowSec < candles[candles.length - 1].t + state.candleIntervalSeconds;

    // Computed up here (rather than down by the other chart-derived series)
    // so the legend can show each MA's live value/arrow next to its dot.
    const maSeries = isCandle
      ? MA_STYLES.map((s) => ({ period: s.period, color: s.color, values: sma(candles.map((c) => c.c), s.period) }))
      : [];

    const legendBits = [sessionLabelText(sessionBlock.blockKey, state.session)];
    if (isCandle) legendBits.push(`每根蠟燭 = ${minutesLabel(state.candleIntervalSeconds)}`);
    if (lastCandleLive) legendBits.push("最新K棒尚未收盤");
    $("chart-legend").innerHTML =
      legendBits.join(" · ") +
      (isCandle
        ? maSeries
            .map((s) => {
              const trend = lastTrend(s.values);
              const text = trend ? `MA${s.period} ${fmt(trend.value, 1)}${trend.arrow}` : `MA${s.period}`;
              return ` <span style="color:${s.color};">● ${text}</span>`;
            })
            .join("")
        : "");

    const plotData = isCandle ? candles : linePoints;
    if (!plotData || plotData.length < 2) {
      $("chart-tooltip").classList.add("hidden");
      state.lastLayout = null;
      ctx.fillStyle = "#8b96a5";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`尚無${state.session === "night" ? "夜盤" : "日盤"}資料`, w / 2, h / 2);
      ctx.textAlign = "left";
      clearSubpanel(); // otherwise it'd keep showing the previous session's stale render
      return;
    }

    const marginRight = 52, marginBottom = 22, marginTop = 6;
    const plotW = w - marginRight, plotH = h - marginBottom - marginTop;
    const n = plotData.length;

    // Real ticks don't arrive on a steady cadence — a burst of updates
    // shouldn't visually stretch that stretch of time out relative to a
    // quiet period. x is placed by actual elapsed time, not by point
    // index/count, so the axis stays a true (if non-uniformly sampled)
    // time scale; a gap in trading shows as blank space rather than
    // silently pulling its neighbors together.
    const tOf = (i) => (isCandle ? candles[i].t : linePoints[i].ts);
    const tStart = tOf(0);
    const tSpan = tOf(n - 1) - tStart || 1;
    const xOfTime = (t) => ((t - tStart) / tSpan) * plotW;
    const x = (i) => xOfTime(tOf(i));

    state.lastLayout = { n, plotW, isCandle, tStart, tSpan, ts: plotData.map((_, i) => tOf(i)) };

    const values = isCandle ? candles.flatMap((c) => [c.h, c.l]) : linePoints.map((p) => p.price);
    maSeries.forEach((s) => s.values.forEach((v) => { if (v != null) values.push(v); }));
    // Computed here (not down by the candle-drawing code) so the bands are
    // included when sizing the Y-axis range — otherwise they'd get clipped
    // whenever price hugs one edge of the visible range.
    const bbands = isCandle && state.bbandsOn ? computeBollinger(candles) : null;
    if (bbands) {
      [bbands.upper, bbands.lower].forEach((series) => series.forEach((v) => { if (v != null) values.push(v); }));
    }
    if (sessionBlock.prevClose != null) values.push(sessionBlock.prevClose);
    // avg_price of 0 is never a real index price — a position stuck in that
    // state (e.g. a fill that slipped through before the feed had a real
    // quote) shouldn't be able to blow the whole axis out to zero.
    const hasValidPosition = state.position.qty !== 0 && state.position.avg_price > 0;
    if (hasValidPosition) {
      values.push(state.position.avg_price);
      if (state.position.stop_loss != null && state.position.stop_loss > 0) values.push(state.position.stop_loss);
      if (state.position.take_profit != null && state.position.take_profit > 0) values.push(state.position.take_profit);
    }
    const min = Math.min(...values), max = Math.max(...values);
    const pad = (max - min) * 0.12 || 1;
    const lo = min - pad, hi = max + pad;

    const y = (v) => marginTop + plotH - ((v - lo) / (hi - lo)) * plotH;

    // Y-axis ticks land on "nice" round numbers (1/2/5 × 10ⁿ apart) instead
    // of splitting [lo, hi] into a fixed 4 equal — and usually decimal-ugly
    // — slices.
    const yStep = niceStep((hi - lo) / 4);
    ctx.strokeStyle = "#2a3140";
    ctx.lineWidth = 1;
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#8b96a5";
    for (let v = Math.ceil(lo / yStep) * yStep; v <= hi; v += yStep) {
      const yy = y(v);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.fillText(fmt(v, 1), plotW + 4, yy + 3);
    }

    // X-axis ticks land on real clock boundaries (see niceTimeTicks) rather
    // than an even split of the visible time range. The bands between
    // alternating ticks get a faint fill first (bottom layer), then
    // gridlines + labels on top, all still before candles/line are drawn.
    const xTicks = niceTimeTicks(tStart, tOf(n - 1));
    const xBoundaries = [0, ...xTicks.map(xOfTime), plotW];
    for (let k = 0; k < xBoundaries.length - 1; k++) {
      if (k % 2 === 1) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.025)";
        ctx.fillRect(xBoundaries[k], marginTop, xBoundaries[k + 1] - xBoundaries[k], plotH);
      }
    }
    xTicks.forEach((t) => {
      const xx = xOfTime(t);
      ctx.strokeStyle = "#2a3140";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xx, marginTop);
      ctx.lineTo(xx, marginTop + plotH);
      ctx.stroke();
      ctx.fillStyle = "#8b96a5";
      ctx.font = "11px sans-serif";
      ctx.fillText(fmtClock(t), Math.min(Math.max(xx - 18, 0), plotW - 34), h - 4);
    });

    if (isCandle) {
      // Width per candle is derived from time-per-pixel now that x is a
      // real time scale, not from plotW/n — a gap in trading shouldn't
      // make surrounding candles balloon to fill the freed-up space.
      const pixelsPerInterval = (plotW / tSpan) * state.candleIntervalSeconds;
      const candleW = Math.max(1, Math.min(12, pixelsPerInterval * 0.7));
      const wickWidth = Math.max(1, Math.min(1.6, candleW * 0.14));
      candles.forEach((c, i) => {
        const xx = Math.round(x(i));
        const up = c.c >= c.o;
        const color = up ? COLOR_UP : COLOR_DOWN;
        const isLive = lastCandleLive && i === candles.length - 1;
        ctx.strokeStyle = color;
        ctx.fillStyle = isLive ? color + "66" : color;
        ctx.lineWidth = wickWidth;
        ctx.setLineDash(isLive ? [2, 2] : []);
        ctx.beginPath();
        ctx.moveTo(xx, y(c.h));
        ctx.lineTo(xx, y(c.l));
        ctx.stroke();
        const bodyTop = Math.round(y(Math.max(c.o, c.c)));
        const bodyBottom = Math.round(y(Math.min(c.o, c.c)));
        const bodyH = Math.max(1.5, bodyBottom - bodyTop);
        ctx.fillRect(xx - candleW / 2, bodyTop, candleW, bodyH);
        if (isLive) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.strokeRect(xx - candleW / 2, bodyTop, candleW, bodyH);
        }
        ctx.setLineDash([]);
      });
      maSeries.forEach((s) => drawSeriesLine(ctx, x, y, s.values, s.color));
      if (bbands) {
        drawSeriesLine(ctx, x, y, bbands.upper, "#7a88ad");
        drawSeriesLine(ctx, x, y, bbands.mid, "#5a6684");
        drawSeriesLine(ctx, x, y, bbands.lower, "#7a88ad");
      }
    } else {
      // Color reflects gain/loss vs. 昨收 (previous same-type session's
      // close), matching how TW index/futures charts read — not just
      // whether the visible window happens to have crept up or down.
      const refPrice = sessionBlock.prevClose != null ? sessionBlock.prevClose : linePoints[0].price;
      const rising = linePoints[linePoints.length - 1].price >= refPrice;
      ctx.strokeStyle = rising ? COLOR_UP : COLOR_DOWN;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      linePoints.forEach((p, i) => {
        const px = x(i), py = y(p.price);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      ctx.fillStyle = rising ? COLOR_UP + "22" : COLOR_DOWN + "22";
      ctx.lineTo(x(n - 1), marginTop + plotH);
      ctx.lineTo(x(0), marginTop + plotH);
      ctx.closePath();
      ctx.fill();
    }

    // 昨收/現價 share the boxed-tag style on the right axis; collected first
    // and run through declutterLabels so two close values don't print
    // overlapping text (P1-4) — the dashed line itself still lands at the
    // exact price height, only the label may be nudged.
    const tagItems = [];
    if (sessionBlock.prevClose != null && sessionBlock.prevClose >= lo && sessionBlock.prevClose <= hi) {
      tagItems.push({ y: y(sessionBlock.prevClose), color: "#8b96a5", label: `昨收 ${fmt(sessionBlock.prevClose, 1)}` });
    }
    if (state.lastTick && state.lastTick.mid >= lo && state.lastTick.mid <= hi) {
      // Colored by gain/loss vs 昨收 (or the session's first point when
      // there's no 昨收 yet), same reference the line-mode fill color uses.
      const refPrice = sessionBlock.prevClose != null ? sessionBlock.prevClose : plotData[0][isCandle ? "c" : "price"];
      const tagColor = state.lastTick.mid >= refPrice ? COLOR_UP : COLOR_DOWN;
      tagItems.push({ y: y(state.lastTick.mid), color: tagColor, label: fmt(state.lastTick.mid, 1) });
    }
    declutterLabels(tagItems, 16).forEach((it) => drawPriceTag(ctx, plotW, it.y, it.labelY, it.color, it.label));

    // 均價/停損/停利 — same declutter treatment, plain-text style on the left.
    const pos = state.position;
    const overlayItems = [];
    const maybeAddOverlay = (value, color, label, visible) => {
      if (visible && value != null && value >= lo && value <= hi) overlayItems.push({ y: y(value), color, label });
    };
    maybeAddOverlay(pos.avg_price, "#4f8cff", `均 ${fmt(pos.avg_price, 1)}`, hasValidPosition);
    maybeAddOverlay(pos.stop_loss, "#ff5c5c", `SL ${fmt(pos.stop_loss, 1)}`, hasValidPosition && pos.stop_loss != null && pos.stop_loss > 0);
    maybeAddOverlay(pos.take_profit, "#3ddc84", `TP ${fmt(pos.take_profit, 1)}`, hasValidPosition && pos.take_profit != null && pos.take_profit > 0);
    declutterLabels(overlayItems, 14).forEach((it) => drawOverlayLine(ctx, plotW, it.y, it.labelY, it.color, it.label));

    const activeIndex = state.pinnedIndex !== null ? state.pinnedIndex : state.hoverIndex;
    if (activeIndex !== null && activeIndex < n) {
      const i = activeIndex;
      const point = isCandle ? candles[i] : linePoints[i];
      const v = isCandle ? point.c : point.price;
      const xx = x(i), yy = y(v);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "#8b96a5";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xx, marginTop);
      ctx.lineTo(xx, marginTop + plotH);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#e6e9ef";
      ctx.beginPath();
      ctx.arc(xx, yy, 3, 0, Math.PI * 2);
      ctx.fill();

      updateTooltip(isCandle, point, xx, w);
    } else {
      $("chart-tooltip").classList.add("hidden");
    }

    if (isCandle) drawSubpanel(candles, tStart, tSpan);
  }

  function clearSubpanel() {
    const canvas = $("chart-subpanel");
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    $("chart-subpanel-legend").innerHTML = "";
  }

  // KD/MACD/RSI share one panel, switched by a dropdown rather than shown
  // as simultaneous stacked panels — see docs/trading-info-chart-spec.md
  // P0-12. Reuses the main chart's time mapping (tStart/tSpan) so the two
  // canvases' X axes line up pixel-for-pixel.
  function drawSubpanel(candles, tStart, tSpan) {
    if (state.subpanel === "off") return;
    const canvas = $("chart-subpanel");
    const legend = $("chart-subpanel-legend");
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const w = rect.width, h = rect.height;
    ctx.clearRect(0, 0, w, h);

    if (candles.length < 2) {
      legend.innerHTML = "";
      return;
    }

    const marginRight = 52, marginTop = 6, marginBottom = 4;
    const plotW = w - marginRight, plotH = h - marginTop - marginBottom;
    const xAt = (i) => ((candles[i].t - tStart) / tSpan) * plotW;

    const drawRefLine = (yy) => {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "#2a3140";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const legendEntry = (color, text) => `<span style="color:${color};">${text}</span>`;

    if (state.subpanel === "kd") {
      const { k, d } = computeKD(candles);
      const yFn = (v) => marginTop + plotH - (v / 100) * plotH;
      [20, 50, 80].forEach((v) => drawRefLine(yFn(v)));
      drawSeriesLine(ctx, xAt, yFn, k, "#f2c94c");
      drawSeriesLine(ctx, xAt, yFn, d, "#64d8ff");
      const kt = lastTrend(k), dt = lastTrend(d);
      legend.innerHTML =
        legendEntry("#f2c94c", `K ${kt ? fmt(kt.value, 1) + kt.arrow : "--"}`) +
        " " +
        legendEntry("#64d8ff", `D ${dt ? fmt(dt.value, 1) + dt.arrow : "--"}`);
    } else if (state.subpanel === "rsi") {
      const rsi = computeRSI(candles);
      const yFn = (v) => marginTop + plotH - (v / 100) * plotH;
      [30, 50, 70].forEach((v) => drawRefLine(yFn(v)));
      drawSeriesLine(ctx, xAt, yFn, rsi, "#bb86fc");
      const t = lastTrend(rsi);
      legend.innerHTML = legendEntry("#bb86fc", `RSI ${t ? fmt(t.value, 1) + t.arrow : "--"}`);
    } else if (state.subpanel === "macd") {
      const { dif, macd, hist } = computeMACD(candles);
      const finite = [...dif, ...macd, ...hist].filter((v) => v != null).map(Math.abs);
      const maxAbs = finite.length ? Math.max(...finite) : 1;
      const lo = -maxAbs * 1.1 || -1, hi = maxAbs * 1.1 || 1;
      const yFn = (v) => marginTop + plotH - ((v - lo) / (hi - lo)) * plotH;
      drawRefLine(yFn(0));
      const pixelsPerInterval = (plotW / tSpan) * state.candleIntervalSeconds;
      const barW = Math.max(1, Math.min(10, pixelsPerInterval * 0.6));
      hist.forEach((v, i) => {
        if (v == null) return;
        const xx = xAt(i);
        const top = yFn(Math.max(v, 0));
        const bottom = yFn(Math.min(v, 0));
        ctx.fillStyle = v >= 0 ? COLOR_UP : COLOR_DOWN;
        ctx.fillRect(xx - barW / 2, top, barW, Math.max(1, bottom - top));
      });
      drawSeriesLine(ctx, xAt, yFn, dif, "#f2c94c");
      drawSeriesLine(ctx, xAt, yFn, macd, "#64d8ff");
      const dift = lastTrend(dif), macdt = lastTrend(macd);
      legend.innerHTML =
        legendEntry("#f2c94c", `DIF ${dift ? fmt(dift.value, 1) + dift.arrow : "--"}`) +
        " " +
        legendEntry("#64d8ff", `MACD ${macdt ? fmt(macdt.value, 1) + macdt.arrow : "--"}`);
    }
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || res.statusText);
    }
    return res.json();
  }

  function setSide(side) {
    state.side = side;
    $("tab-buy").classList.toggle("active", side === "BUY");
    $("tab-sell").classList.toggle("active", side === "SELL");
    const submitBtn = $("submit-order");
    submitBtn.classList.toggle("buy", side === "BUY");
    submitBtn.classList.toggle("sell", side === "SELL");
    submitBtn.textContent = `${side === "BUY" ? "Buy" : "Sell"} ${$("instrument-symbol").textContent}`;
  }

  function toggleLimitField() {
    const isLimit = $("order-type").value === "LIMIT";
    $("limit-price-field").classList.toggle("hidden", !isLimit);
  }

  async function submitOrder() {
    $("order-error").textContent = "";
    const body = {
      side: state.side,
      order_type: $("order-type").value,
      qty: Number($("order-qty").value),
      limit_price: $("order-type").value === "LIMIT" ? Number($("limit-price").value) : null,
      stop_loss: null,
      take_profit: null,
    };
    try {
      await api("/api/orders", { method: "POST", body: JSON.stringify(body) });
    } catch (err) {
      $("order-error").textContent = err.message;
    }
  }

  async function cancelOrder(id) {
    try {
      await api(`/api/orders/${id}`, { method: "DELETE" });
    } catch (err) {
      console.error(err);
    }
  }

  // qty=null closes the whole position; otherwise closes just that many
  // contracts. hidePositionModal() isn't called here — a partial close
  // leaves the position open, so renderPosition() deciding whether to keep
  // the modal open (based on the fresh position it receives over the
  // websocket) is the single source of truth, not this call site.
  async function submitClosePosition(qty) {
    $("modal-pos-error").textContent = "";
    try {
      await api("/api/position/close", { method: "POST", body: JSON.stringify({ qty }) });
    } catch (err) {
      $("modal-pos-error").textContent = err.message;
    }
  }

  async function submitUpdateRisk() {
    $("modal-pos-error").textContent = "";
    const stop_loss = $("modal-pos-sl").value ? Number($("modal-pos-sl").value) : null;
    const take_profit = $("modal-pos-tp").value ? Number($("modal-pos-tp").value) : null;
    try {
      await api("/api/position/risk", { method: "PUT", body: JSON.stringify({ stop_loss, take_profit }) });
    } catch (err) {
      $("modal-pos-error").textContent = err.message;
    }
  }

  $("tab-buy").addEventListener("click", () => setSide("BUY"));
  $("tab-sell").addEventListener("click", () => setSide("SELL"));
  $("order-type").addEventListener("change", toggleLimitField);
  $("submit-order").addEventListener("click", submitOrder);
  $("position-detail").addEventListener("click", () => openPositionModal());
  $("modal-pos-close-all").addEventListener("click", () => submitClosePosition(null));
  $("modal-pos-close-record").addEventListener("click", () => {
    if (state.modalRecordQty == null) return;
    submitClosePosition(Math.min(state.modalRecordQty, Math.abs(state.position.qty)));
  });
  $("modal-pos-update-risk").addEventListener("click", submitUpdateRisk);
  $("position-modal-close").addEventListener("click", hidePositionModal);
  $("position-modal").addEventListener("click", (e) => {
    if (e.target.id === "position-modal") hidePositionModal();
  });
  window.addEventListener("resize", drawChart);

  document.querySelectorAll(".chart-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.chartMode = btn.dataset.mode;
      document.querySelectorAll(".chart-mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
      $("chart-range-group").classList.toggle("hidden", state.chartMode !== "line");
      $("chart-interval-group").classList.toggle("hidden", state.chartMode !== "candle");
      $("chart-candle-range-group").classList.toggle("hidden", state.chartMode !== "candle");
      updateIndicatorVisibility();
      drawChart();
    });
  });

  document.querySelectorAll(".chart-interval-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.candleIntervalSeconds = Number(btn.dataset.interval) * 60;
      document.querySelectorAll(".chart-interval-btn").forEach((b) => b.classList.toggle("active", b === btn));
      drawChart();
    });
  });

  document.querySelectorAll(".chart-candle-range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.candleRangeSeconds = Number(btn.dataset.candleRange) * 60;
      document.querySelectorAll(".chart-candle-range-btn").forEach((b) => b.classList.toggle("active", b === btn));
      drawChart();
    });
  });

  $("bbands-toggle").addEventListener("click", () => {
    state.bbandsOn = !state.bbandsOn;
    $("bbands-toggle").classList.toggle("active", state.bbandsOn);
    saveIndicatorPrefs();
    drawChart();
  });

  $("chart-subpanel-select").addEventListener("change", (e) => {
    state.subpanel = e.target.value;
    saveIndicatorPrefs();
    updateIndicatorVisibility();
    drawChart();
  });

  document.querySelectorAll(".chart-session-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.session = btn.dataset.session;
      state.sessionManual = true;
      syncSessionButtons();
      renderSessionStats();
      drawChart();
    });
  });

  document.querySelectorAll(".chart-range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.lineRangeSeconds = Number(btn.dataset.range) * 60;
      document.querySelectorAll(".chart-range-btn").forEach((b) => b.classList.toggle("active", b === btn));
      drawChart();
    });
  });
  document.querySelector(`.chart-range-btn[data-range="15"]`).classList.add("active");

  const chartCanvas = $("chart");
  // Shared by mouse hover, click-to-pin, and touch: maps a viewport x
  // coordinate to the nearest plotted point's index.
  function indexFromClientX(clientX) {
    const rect = chartCanvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const { plotW, tStart, tSpan, ts } = state.lastLayout;
    const frac = Math.min(Math.max(mx / plotW, 0), 1);
    return findNearestIndexByTime(ts, tStart + frac * tSpan);
  }

  chartCanvas.addEventListener("mousemove", (e) => {
    // A pinned point (from a click) freezes the crosshair/tooltip until the
    // user unpins it — plain hover shouldn't fight with that.
    if (!state.lastLayout || state.pinnedIndex !== null) return;
    state.hoverIndex = indexFromClientX(e.clientX);
    drawChart();
  });
  chartCanvas.addEventListener("mouseleave", () => {
    if (state.pinnedIndex !== null) return;
    state.hoverIndex = null;
    drawChart();
  });
  chartCanvas.addEventListener("click", (e) => {
    if (!state.lastLayout) return;
    const idx = indexFromClientX(e.clientX);
    // Clicking the already-pinned point unpins it; clicking elsewhere on
    // the chart moves the pin there.
    state.pinnedIndex = state.pinnedIndex === idx ? null : idx;
    drawChart();
  });
  // Touch devices have no hover state, so a touch pins the tooltip directly
  // (rather than mirroring mousemove's live-preview-then-clear behavior) —
  // it stays visible after the finger lifts, same as a click.
  const handleChartTouch = (e) => {
    if (!state.lastLayout) return;
    const touch = e.touches[0];
    if (!touch) return;
    state.pinnedIndex = indexFromClientX(touch.clientX);
    drawChart();
    e.preventDefault();
  };
  chartCanvas.addEventListener("touchstart", handleChartTouch, { passive: false });
  chartCanvas.addEventListener("touchmove", handleChartTouch, { passive: false });
  document.addEventListener("click", (e) => {
    if (state.pinnedIndex !== null && !chartCanvas.contains(e.target)) {
      state.pinnedIndex = null;
      drawChart();
    }
  });

  document.querySelectorAll(".record-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => setRecordTab(btn.dataset.recordTab));
  });

  loadIndicatorPrefs();
  $("bbands-toggle").classList.toggle("active", state.bbandsOn);
  $("chart-subpanel-select").value = state.subpanel;
  updateIndicatorVisibility();

  setSide("BUY");
  toggleLimitField();
  bootstrapAuth().then((user) => {
    if (user) connect();
  });
})();
