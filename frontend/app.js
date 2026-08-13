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
    hoverIndex: null,
    lastLayout: null,
    positionModalOpen: false,
    modalRecordQty: null,
    recordTab: "holdings",
    lastTick: null,
    // 台指期日盤/夜盤: which session the chart is currently showing.
    // Auto-follows the live session until the user manually picks one.
    session: "day",
    sessionManual: false,
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
        }
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
        state.lastTick = null;
        $("price-mid").textContent = "--";
        $("price-bid").textContent = "--";
        $("price-ask").textContent = "--";
        $("price-chg").textContent = "--";
        $("price-chg").className = "chg";
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

  function renderPrice(tick) {
    state.lastTick = tick;
    $("price-mid").textContent = fmt(tick.mid, 1);
    $("price-bid").textContent = fmt(tick.bid, 1);
    $("price-ask").textContent = fmt(tick.ask, 1);

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

  function fmtClock(ts) {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function drawOverlayLine(ctx, plotW, yFn, lo, hi, value, color, label, visible) {
    if (!visible || value === null || value === undefined || value < lo || value > hi) return;
    const yy = yFn(value);
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
    ctx.fillText(label, 4, yy - 3);
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
    const candles = isCandle ? buildCandles(sessionPoints, state.candleIntervalSeconds) : null;

    // The most recent bar's time window may not have closed yet — flag it so
    // it isn't mistaken for a settled candle.
    const nowSec = Date.now() / 1000;
    const lastCandleLive =
      isCandle && candles.length > 0 && nowSec < candles[candles.length - 1].t + state.candleIntervalSeconds;

    const legendBits = [sessionLabelText(sessionBlock.blockKey, state.session)];
    if (isCandle) legendBits.push(`每根蠟燭 = ${minutesLabel(state.candleIntervalSeconds)}`);
    if (lastCandleLive) legendBits.push("最新K棒尚未收盤");
    $("chart-legend").innerHTML =
      legendBits.join(" · ") +
      (isCandle ? MA_STYLES.map((s) => ` <span style="color:${s.color};">● MA${s.period}</span>`).join("") : "");

    const plotData = isCandle ? candles : linePoints;
    if (!plotData || plotData.length < 2) {
      $("chart-tooltip").classList.add("hidden");
      state.lastLayout = null;
      ctx.fillStyle = "#8b96a5";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`尚無${state.session === "night" ? "夜盤" : "日盤"}資料`, w / 2, h / 2);
      ctx.textAlign = "left";
      return;
    }

    const marginRight = 52, marginBottom = 22, marginTop = 6;
    const plotW = w - marginRight, plotH = h - marginBottom - marginTop;
    const n = plotData.length;
    state.lastLayout = { n, plotW, isCandle };

    const maSeries = isCandle
      ? MA_STYLES.map((s) => ({ color: s.color, values: sma(candles.map((c) => c.c), s.period) }))
      : [];

    const values = isCandle ? candles.flatMap((c) => [c.h, c.l]) : linePoints.map((p) => p.price);
    maSeries.forEach((s) => s.values.forEach((v) => { if (v != null) values.push(v); }));
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

    const x = (i) => (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = (v) => marginTop + plotH - ((v - lo) / (hi - lo)) * plotH;
    const tOf = (i) => (isCandle ? candles[i].t : linePoints[i].ts);

    ctx.strokeStyle = "#2a3140";
    ctx.lineWidth = 1;
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#8b96a5";
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      const yy = y(v);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.fillText(fmt(v, 1), plotW + 4, yy + 3);
    }

    const labelCount = Math.min(5, n);
    for (let k = 0; k < labelCount; k++) {
      const idx = Math.round((k / (labelCount - 1 || 1)) * (n - 1));
      const xx = x(idx);
      ctx.fillText(fmtClock(tOf(idx)), Math.min(Math.max(xx - 18, 0), plotW - 34), h - 4);
    }

    if (isCandle) {
      const candleW = Math.max(1, Math.min(12, (plotW / n) * 0.7));
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

    drawOverlayLine(ctx, plotW, y, lo, hi, sessionBlock.prevClose, "#8b96a5", `昨收 ${fmt(sessionBlock.prevClose, 1)}`, sessionBlock.prevClose != null);

    const pos = state.position;
    drawOverlayLine(ctx, plotW, y, lo, hi, pos.avg_price, "#4f8cff", `均 ${fmt(pos.avg_price, 1)}`, hasValidPosition);
    drawOverlayLine(ctx, plotW, y, lo, hi, pos.stop_loss, "#ff5c5c", `SL ${fmt(pos.stop_loss, 1)}`, hasValidPosition && pos.stop_loss != null && pos.stop_loss > 0);
    drawOverlayLine(ctx, plotW, y, lo, hi, pos.take_profit, "#3ddc84", `TP ${fmt(pos.take_profit, 1)}`, hasValidPosition && pos.take_profit != null && pos.take_profit > 0);

    if (state.hoverIndex !== null && state.hoverIndex < n) {
      const i = state.hoverIndex;
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

  document.querySelectorAll(".chart-session-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.session = btn.dataset.session;
      state.sessionManual = true;
      syncSessionButtons();
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
  chartCanvas.addEventListener("mousemove", (e) => {
    if (!state.lastLayout) return;
    const rect = chartCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const { n, plotW } = state.lastLayout;
    const idx = Math.round((mx / plotW) * (n - 1));
    state.hoverIndex = Math.min(Math.max(idx, 0), n - 1);
    drawChart();
  });
  chartCanvas.addEventListener("mouseleave", () => {
    state.hoverIndex = null;
    drawChart();
  });

  document.querySelectorAll(".record-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => setRecordTab(btn.dataset.recordTab));
  });

  setSide("BUY");
  toggleLimitField();
  bootstrapAuth().then((user) => {
    if (user) connect();
  });
})();
