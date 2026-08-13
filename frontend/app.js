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
    candleIntervalSeconds: 60,
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

  // Matches the button labels in #chart-interval-group (…30分, 1小時) so the
  // legend reads the same way the control does.
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
    // Subpanel pane height / legend visibility is owned by updateSubpanel()
    // (called from updateChart()) — this just gates the 布林通道/副圖 controls
    // themselves, which only make sense in K線 mode.
    $("chart-indicator-group").classList.toggle("hidden", state.chartMode !== "candle");
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
        updateChart(false); // routine tick — append, don't reset the user's zoom/pan
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
        updateChart(false); // only 均/SL/TP price lines change — don't reset zoom/pan
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
        updateChart();
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
    updateChart();
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

  // Explicit Asia/Taipei so this reads the same regardless of the viewer's
  // own timezone — matches taipeiClassify()'s assumption elsewhere.
  function fmtClock(ts) {
    return new Date(ts * 1000).toLocaleTimeString([], { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false });
  }

  // === Chart rendering (TradingView Lightweight Charts) ===================
  // Replaced a hand-rolled canvas renderer here — see git history before
  // this commit for the old drawChart()/drawSubpanel() implementation.
  // Two always-present series (candle/area) toggle `visible` for K線/線圖
  // instead of swapping series types (the library doesn't support that in
  // place). KD/MACD/RSI live in pane 1 (native multi-pane support), and
  // 現價/昨收/均/停損/停利 are native price lines rather than hand-drawn tags.
  let chart, candleSeries, areaSeries, maLineSeries, bbSeries, subSeries;
  const priceLineRefs = {}; // key -> { series, line } — see setPriceLine()

  function initChart() {
    const LWC = window.LightweightCharts;
    chart = LWC.createChart($("chart-container"), {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#8b96a5", fontSize: 11 },
      grid: { vertLines: { color: "#2a3140" }, horzLines: { color: "#2a3140" } },
      rightPriceScale: { borderColor: "#2a3140" },
      timeScale: { borderColor: "#2a3140", timeVisible: true, secondsVisible: false, tickMarkFormatter: (t) => fmtClock(t) },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      trackingMode: { exitMode: LWC.TrackingModeExitMode.OnNextTap },
      localization: { priceFormatter: (p) => fmt(p, 1) },
    });

    const noAutoLine = { priceLineVisible: false, lastValueVisible: false };
    candleSeries = chart.addSeries(LWC.CandlestickSeries, {
      upColor: COLOR_UP, downColor: COLOR_DOWN, borderUpColor: COLOR_UP, borderDownColor: COLOR_DOWN,
      wickUpColor: COLOR_UP, wickDownColor: COLOR_DOWN, ...noAutoLine,
    }, 0);
    areaSeries = chart.addSeries(LWC.AreaSeries, {
      lineColor: COLOR_UP, topColor: COLOR_UP + "33", bottomColor: COLOR_UP + "00", lineWidth: 2, ...noAutoLine,
    }, 0);

    maLineSeries = {};
    MA_STYLES.forEach((s) => {
      maLineSeries[s.period] = chart.addSeries(LWC.LineSeries, { color: s.color, lineWidth: 1, ...noAutoLine }, 0);
    });
    bbSeries = {
      upper: chart.addSeries(LWC.LineSeries, { color: "#7a88ad", lineWidth: 1, ...noAutoLine }, 0),
      mid: chart.addSeries(LWC.LineSeries, { color: "#5a6684", lineWidth: 1, ...noAutoLine }, 0),
      lower: chart.addSeries(LWC.LineSeries, { color: "#7a88ad", lineWidth: 1, ...noAutoLine }, 0),
    };

    subSeries = {
      kdK: chart.addSeries(LWC.LineSeries, { color: "#f2c94c", lineWidth: 1, ...noAutoLine }, 1),
      kdD: chart.addSeries(LWC.LineSeries, { color: "#64d8ff", lineWidth: 1, ...noAutoLine }, 1),
      rsi: chart.addSeries(LWC.LineSeries, { color: "#bb86fc", lineWidth: 1, ...noAutoLine }, 1),
      macdHist: chart.addSeries(LWC.HistogramSeries, { ...noAutoLine }, 1),
      macdDif: chart.addSeries(LWC.LineSeries, { color: "#f2c94c", lineWidth: 1, ...noAutoLine }, 1),
      macdSignal: chart.addSeries(LWC.LineSeries, { color: "#64d8ff", lineWidth: 1, ...noAutoLine }, 1),
    };
    chart.panes()[1].setHeight(0); // starts closed; updateSubpanel() opens it when a series is picked

    chart.subscribeCrosshairMove(handleCrosshairMove);
  }

  // Creates/updates/removes a price line, moving it between candleSeries and
  // areaSeries if the active series changed since the last call (switching
  // 線圖/K線 modes) — a price line belongs to one series in this library.
  function setPriceLine(key, series, options) {
    const entry = priceLineRefs[key] || (priceLineRefs[key] = { series: null, line: null });
    if (entry.line && entry.series !== series) {
      entry.series.removePriceLine(entry.line);
      entry.line = null;
    }
    if (options === null) {
      if (entry.line) entry.series.removePriceLine(entry.line);
      entry.line = null;
      entry.series = null;
      return;
    }
    if (entry.line) {
      entry.line.applyOptions(options);
    } else {
      entry.line = series.createPriceLine(options);
      entry.series = series;
    }
  }

  function priceLineStyle(color, title) {
    return {
      price: 0, color, lineWidth: 1, lineStyle: window.LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true, title, axisLabelColor: color, axisLabelTextColor: "#0b0f17",
    };
  }

  function toLinePoints(candles, values) {
    const out = [];
    for (let i = 0; i < candles.length; i++) {
      if (values[i] != null) out.push({ time: candles[i].t, value: values[i] });
    }
    return out;
  }

  // `structural` distinguishes two very different reasons to call this:
  //  - true:  the dataset's identity changed (session/mode/interval switch,
  //    indicator toggled, initial load) — full setData() rebuild, then
  //    fitContent() to frame it.
  //  - false: a routine live tick in the same context — append/patch just
  //    the latest point via update() and leave the time scale alone.
  // Calling setData()+fitContent() on every tick (the original approach)
  // meant Lightweight Charts' own zoom/pan/scroll — the whole reason to
  // stop hand-rolling a range selector — got reset every second or so.
  // Only the structural path may re-frame the view; ticks must not.
  function updateChart(structural = true) {
    if (!chart) return;
    const isCandle = state.chartMode === "candle";
    candleSeries.applyOptions({ visible: isCandle });
    areaSeries.applyOptions({ visible: !isCandle });
    Object.values(maLineSeries).forEach((s) => s.applyOptions({ visible: isCandle }));

    // Chart only ever shows one 日盤/夜盤 block at a time — the two sessions
    // are separated by multi-hour closed gaps, so connecting across them
    // would draw a misleading line/reference set. Within a session, the
    // full block is always handed to the chart now — Lightweight Charts'
    // own scroll/zoom is how the user picks a narrower range, not a
    // pre-filter on the data (see docs/trading-info-chart-spec.md).
    const sessionBlock = findSessionBlock(state.history, state.session);
    const sessionPoints = sessionBlock.points;
    const linePoints = sessionPoints;
    const candles = isCandle ? buildCandles(sessionPoints, state.candleIntervalSeconds) : [];

    const maSeries = isCandle
      ? MA_STYLES.map((s) => ({ period: s.period, color: s.color, values: sma(candles.map((c) => c.c), s.period) }))
      : [];

    const legendBits = [sessionLabelText(sessionBlock.blockKey, state.session)];
    if (isCandle) legendBits.push(`每根蠟燭 = ${minutesLabel(state.candleIntervalSeconds)}`);
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

    // update() only ever touches the last point of a series (appends if its
    // time is new, replaces if it matches the existing last bar) — skipped
    // entirely for null values (an indicator still in its warmup period)
    // since Lightweight Charts data points don't accept null.
    const updateLast = (series, point) => {
      if (point.value === null || point.value === undefined) return;
      series.update(point);
    };

    if (isCandle) {
      if (structural) {
        candleSeries.setData(candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })));
        maSeries.forEach((s) => maLineSeries[s.period].setData(toLinePoints(candles, s.values)));
        if (state.bbandsOn) {
          const bb = computeBollinger(candles);
          bbSeries.upper.setData(toLinePoints(candles, bb.upper));
          bbSeries.mid.setData(toLinePoints(candles, bb.mid));
          bbSeries.lower.setData(toLinePoints(candles, bb.lower));
        } else {
          // A hidden series (visible: false) still counts toward the shared
          // price scale's autoscale unless its data is also cleared.
          Object.values(bbSeries).forEach((s) => s.setData([]));
        }
        areaSeries.setData([]);
      } else if (candles.length) {
        const last = candles[candles.length - 1];
        candleSeries.update({ time: last.t, open: last.o, high: last.h, low: last.l, close: last.c });
        maSeries.forEach((s) => updateLast(maLineSeries[s.period], { time: last.t, value: s.values[s.values.length - 1] }));
        if (state.bbandsOn) {
          const bb = computeBollinger(candles);
          const i = candles.length - 1;
          updateLast(bbSeries.upper, { time: last.t, value: bb.upper[i] });
          updateLast(bbSeries.mid, { time: last.t, value: bb.mid[i] });
          updateLast(bbSeries.lower, { time: last.t, value: bb.lower[i] });
        }
      }
      Object.values(bbSeries).forEach((s) => s.applyOptions({ visible: state.bbandsOn }));
    } else {
      if (structural) {
        areaSeries.setData(linePoints.map((p) => ({ time: p.ts, value: p.price })));
      } else if (linePoints.length) {
        const last = linePoints[linePoints.length - 1];
        areaSeries.update({ time: last.ts, value: last.price });
      }
      // Color reflects gain/loss vs. 昨收 (previous same-type session's
      // close), matching how TW index/futures charts read — not just
      // whether the visible window happens to have crept up or down.
      if (linePoints.length) {
        const refPrice = sessionBlock.prevClose != null ? sessionBlock.prevClose : linePoints[0].price;
        const rising = linePoints[linePoints.length - 1].price >= refPrice;
        const color = rising ? COLOR_UP : COLOR_DOWN;
        areaSeries.applyOptions({ lineColor: color, topColor: color + "33", bottomColor: color + "00" });
      }
      if (structural) {
        candleSeries.setData([]);
        Object.values(maLineSeries).forEach((s) => s.setData([]));
        Object.values(bbSeries).forEach((s) => s.setData([]));
      }
      Object.values(bbSeries).forEach((s) => s.applyOptions({ visible: false }));
    }

    const plotData = isCandle ? candles : linePoints;
    if (!plotData.length) $("chart-tooltip").classList.add("hidden");
    $("chart-empty").classList.toggle("hidden", plotData.length > 0);
    $("chart-empty").textContent = `尚無${state.session === "night" ? "夜盤" : "日盤"}資料`;

    // 昨收/現價/均/停損/停利 as native price lines on whichever series is
    // currently visible (setPriceLine moves them over on a mode switch).
    // Price lines don't affect the time scale, so these always run — no
    // structural/tick distinction needed here.
    const activeSeries = isCandle ? candleSeries : areaSeries;
    setPriceLine("prevClose", activeSeries, sessionBlock.prevClose != null
      ? { ...priceLineStyle("#8b96a5", "昨收"), price: sessionBlock.prevClose }
      : null);

    if (state.lastTick && plotData.length) {
      const firstPrice = isCandle ? candles[0].c : linePoints[0].price;
      const refPrice = sessionBlock.prevClose != null ? sessionBlock.prevClose : firstPrice;
      const tagColor = state.lastTick.mid >= refPrice ? COLOR_UP : COLOR_DOWN;
      setPriceLine("current", activeSeries, { ...priceLineStyle(tagColor, ""), price: state.lastTick.mid });
    } else {
      setPriceLine("current", activeSeries, null);
    }

    const pos = state.position;
    // avg_price of 0 is never a real index price — a position stuck in that
    // state (e.g. a fill that slipped through before the feed had a real
    // quote) shouldn't put a price line at zero.
    const hasValidPosition = pos.qty !== 0 && pos.avg_price > 0;
    setPriceLine("avg", activeSeries, hasValidPosition ? { ...priceLineStyle("#4f8cff", "均"), price: pos.avg_price } : null);
    setPriceLine("sl", activeSeries, (hasValidPosition && pos.stop_loss != null && pos.stop_loss > 0)
      ? { ...priceLineStyle("#ff5c5c", "SL"), price: pos.stop_loss } : null);
    setPriceLine("tp", activeSeries, (hasValidPosition && pos.take_profit != null && pos.take_profit > 0)
      ? { ...priceLineStyle("#3ddc84", "TP"), price: pos.take_profit } : null);

    updateSubpanel(candles, structural);

    if (structural) chart.timeScale().fitContent();
  }

  // KD/MACD/RSI share one native pane (index 1), switched by a dropdown
  // rather than shown as simultaneous stacked panels — see
  // docs/trading-info-chart-spec.md P0-12.
  function updateSubpanel(candles, structural) {
    const mode = state.chartMode === "candle" ? state.subpanel : "off";
    const legend = $("chart-subpanel-legend");
    const pane1 = chart.panes()[1];
    if (pane1) pane1.setHeight(mode === "off" ? 0 : 110);

    subSeries.kdK.applyOptions({ visible: mode === "kd" });
    subSeries.kdD.applyOptions({ visible: mode === "kd" });
    subSeries.rsi.applyOptions({ visible: mode === "rsi" });
    subSeries.macdHist.applyOptions({ visible: mode === "macd" });
    subSeries.macdDif.applyOptions({ visible: mode === "macd" });
    subSeries.macdSignal.applyOptions({ visible: mode === "macd" });
    if (structural) {
      // A hidden series still counts toward pane 1's autoscale unless its
      // data is cleared too — wipe whichever indicator(s) aren't active.
      if (mode !== "kd") { subSeries.kdK.setData([]); subSeries.kdD.setData([]); }
      if (mode !== "rsi") subSeries.rsi.setData([]);
      if (mode !== "macd") { subSeries.macdHist.setData([]); subSeries.macdDif.setData([]); subSeries.macdSignal.setData([]); }
    }

    if (mode === "off" || candles.length < 2) {
      legend.innerHTML = "";
      legend.classList.add("hidden");
      return;
    }
    legend.classList.remove("hidden");

    const legendEntry = (color, text) => `<span style="color:${color};">${text}</span>`;
    const last = candles[candles.length - 1];
    const updateLast = (series, value) => {
      if (value == null) return;
      series.update({ time: last.t, value });
    };

    if (mode === "kd") {
      const { k, d } = computeKD(candles);
      if (structural) {
        subSeries.kdK.setData(toLinePoints(candles, k));
        subSeries.kdD.setData(toLinePoints(candles, d));
      } else {
        updateLast(subSeries.kdK, k[k.length - 1]);
        updateLast(subSeries.kdD, d[d.length - 1]);
      }
      const kt = lastTrend(k), dt = lastTrend(d);
      legend.innerHTML =
        legendEntry("#f2c94c", `K ${kt ? fmt(kt.value, 1) + kt.arrow : "--"}`) +
        " " +
        legendEntry("#64d8ff", `D ${dt ? fmt(dt.value, 1) + dt.arrow : "--"}`);
    } else if (mode === "rsi") {
      const rsi = computeRSI(candles);
      if (structural) subSeries.rsi.setData(toLinePoints(candles, rsi));
      else updateLast(subSeries.rsi, rsi[rsi.length - 1]);
      const t = lastTrend(rsi);
      legend.innerHTML = legendEntry("#bb86fc", `RSI ${t ? fmt(t.value, 1) + t.arrow : "--"}`);
    } else if (mode === "macd") {
      const { dif, macd, hist } = computeMACD(candles);
      if (structural) {
        subSeries.macdDif.setData(toLinePoints(candles, dif));
        subSeries.macdSignal.setData(toLinePoints(candles, macd));
        const histPoints = [];
        for (let i = 0; i < candles.length; i++) {
          if (hist[i] != null) histPoints.push({ time: candles[i].t, value: hist[i], color: hist[i] >= 0 ? COLOR_UP : COLOR_DOWN });
        }
        subSeries.macdHist.setData(histPoints);
      } else {
        updateLast(subSeries.macdDif, dif[dif.length - 1]);
        updateLast(subSeries.macdSignal, macd[macd.length - 1]);
        const h = hist[hist.length - 1];
        if (h != null) subSeries.macdHist.update({ time: last.t, value: h, color: h >= 0 ? COLOR_UP : COLOR_DOWN });
      }
      const dift = lastTrend(dif), macdt = lastTrend(macd);
      legend.innerHTML =
        legendEntry("#f2c94c", `DIF ${dift ? fmt(dift.value, 1) + dift.arrow : "--"}`) +
        " " +
        legendEntry("#64d8ff", `MACD ${macdt ? fmt(macdt.value, 1) + macdt.arrow : "--"}`);
    }
  }

  // Custom OHLC/price tooltip that follows the native crosshair — the
  // library draws the crosshair itself but leaves tooltip content to the
  // host page (see the "tooltips" tutorial this follows).
  function handleCrosshairMove(param) {
    const tip = $("chart-tooltip");
    if (!param.point || param.time === undefined) {
      tip.classList.add("hidden");
      return;
    }
    const isCandle = state.chartMode === "candle";
    const series = isCandle ? candleSeries : areaSeries;
    const data = param.seriesData.get(series);
    if (!data) {
      tip.classList.add("hidden");
      return;
    }
    tip.innerHTML = isCandle
      ? `<div>${fmtTime(param.time)}</div><div>開 ${fmt(data.open, 1)}&nbsp;&nbsp;高 ${fmt(data.high, 1)}</div><div>低 ${fmt(data.low, 1)}&nbsp;&nbsp;收 ${fmt(data.close, 1)}</div>`
      : `<div>${fmtTime(param.time)}</div><div>價格 ${fmt(data.value, 1)}</div>`;
    tip.classList.remove("hidden");
    const containerWidth = $("chart-container").clientWidth;
    const xx = param.point.x;
    tip.style.left = `${Math.max(4, xx > containerWidth - 130 ? xx - 120 : xx + 10)}px`;
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
  // No resize listener needed — the chart is created with autoSize: true.

  document.querySelectorAll(".chart-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.chartMode = btn.dataset.mode;
      document.querySelectorAll(".chart-mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
      $("chart-interval-group").classList.toggle("hidden", state.chartMode !== "candle");
      updateIndicatorVisibility();
      updateChart();
    });
  });

  document.querySelectorAll(".chart-interval-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.candleIntervalSeconds = Number(btn.dataset.interval) * 60;
      document.querySelectorAll(".chart-interval-btn").forEach((b) => b.classList.toggle("active", b === btn));
      updateChart();
    });
  });

  $("bbands-toggle").addEventListener("click", () => {
    state.bbandsOn = !state.bbandsOn;
    $("bbands-toggle").classList.toggle("active", state.bbandsOn);
    saveIndicatorPrefs();
    updateChart();
  });

  $("chart-subpanel-select").addEventListener("change", (e) => {
    state.subpanel = e.target.value;
    saveIndicatorPrefs();
    updateIndicatorVisibility();
    updateChart();
  });

  document.querySelectorAll(".chart-session-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.session = btn.dataset.session;
      state.sessionManual = true;
      syncSessionButtons();
      renderSessionStats();
      updateChart();
    });
  });

  document.querySelectorAll(".record-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => setRecordTab(btn.dataset.recordTab));
  });

  initChart();
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
