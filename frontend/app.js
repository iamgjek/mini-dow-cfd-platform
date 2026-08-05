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
    hoverIndex: null,
    lastLayout: null,
    positionModalOpen: false,
    modalRecordQty: null,
  };

  const CANDLE_INTERVAL_SECONDS = 60;

  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 2) => (n === null || n === undefined ? "--" : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
  const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString();

  async function bootstrapAuth() {
    const res = await fetch("/api/auth/me");
    if (!res.ok) {
      window.location.href = "/login.html";
      return null;
    }
    const user = await res.json();
    $("header-user").innerHTML = `<strong>${user.display_name}</strong> · ${user.email}`;
    $("admin-link").classList.toggle("hidden", user.role !== "admin");
    return user;
  }

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
        state.history = d.history;
        state.account = d.account;
        state.position = d.position;
        state.orders = d.orders;
        state.trades = d.trades;
        renderAll();
        break;
      }
      case "tick": {
        state.history.push({ ts: msg.data.ts, price: msg.data.mid });
        if (state.history.length > 3600) state.history.shift();
        renderPrice(msg.data);
        drawChart();
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
        renderTrades();
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
      case "trade":
        state.trades.unshift(msg.data);
        renderTrades();
        break;
    }
  }

  function renderAll() {
    renderAccount();
    renderPosition();
    renderOrders();
    renderTrades();
    drawChart();
  }

  function renderPrice(tick) {
    $("price-mid").textContent = fmt(tick.mid, 1);
    $("price-bid").textContent = fmt(tick.bid, 1);
    $("price-ask").textContent = fmt(tick.ask, 1);
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

  function renderTrades() {
    const body = $("trades-body");
    if (!state.trades.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="6">尚無成交</td></tr>';
      return;
    }
    const cutoff = openPositionCutoff();
    body.innerHTML = state.trades
      .slice(0, 30)
      .map((t) => {
        const editable = cutoff != null && t.ts >= cutoff;
        const hint = editable ? '<span class="badge editable">可編輯</span>' : "";
        const qtyAttr = editable ? ` data-qty="${t.qty}"` : "";
        return `<tr class="${editable ? "clickable" : ""}"${qtyAttr}>
          <td>${fmtTime(t.ts)}</td>
          <td class="${t.side === "BUY" ? "up" : "down"}">${t.side}</td>
          <td>${t.qty}</td>
          <td>${fmt(t.price, 1)}</td>
          <td class="${t.realized_pnl > 0 ? "up" : t.realized_pnl < 0 ? "down" : ""}">${fmt(t.realized_pnl)}</td>
          <td>${hint}</td>
        </tr>`;
      })
      .join("");

    wireEditableRows(body);
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
    const linePoints = state.history.slice(-state.lineRangeSeconds);
    const candles = isCandle ? buildCandles(state.history.slice(-3600), CANDLE_INTERVAL_SECONDS) : null;
    const plotData = isCandle ? candles : linePoints;
    if (!plotData || plotData.length < 2) return;

    const marginRight = 52, marginBottom = 22, marginTop = 6;
    const plotW = w - marginRight, plotH = h - marginBottom - marginTop;
    const n = plotData.length;
    state.lastLayout = { n, plotW, isCandle };

    const values = isCandle ? candles.flatMap((c) => [c.h, c.l]) : linePoints.map((p) => p.price);
    if (state.position.qty !== 0) {
      values.push(state.position.avg_price);
      if (state.position.stop_loss != null) values.push(state.position.stop_loss);
      if (state.position.take_profit != null) values.push(state.position.take_profit);
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
      const candleW = Math.max(2, Math.min(10, (plotW / n) * 0.6));
      candles.forEach((c, i) => {
        const xx = x(i);
        const up = c.c >= c.o;
        ctx.strokeStyle = up ? "#3ddc84" : "#ff5c5c";
        ctx.fillStyle = up ? "#3ddc84" : "#ff5c5c";
        ctx.beginPath();
        ctx.moveTo(xx, y(c.h));
        ctx.lineTo(xx, y(c.l));
        ctx.stroke();
        const bodyTop = y(Math.max(c.o, c.c));
        const bodyBottom = y(Math.min(c.o, c.c));
        ctx.fillRect(xx - candleW / 2, bodyTop, candleW, Math.max(1, bodyBottom - bodyTop));
      });
    } else {
      const rising = linePoints[linePoints.length - 1].price >= linePoints[0].price;
      ctx.strokeStyle = rising ? "#3ddc84" : "#ff5c5c";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      linePoints.forEach((p, i) => {
        const px = x(i), py = y(p.price);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      ctx.fillStyle = rising ? "#3ddc8422" : "#ff5c5c22";
      ctx.lineTo(x(n - 1), marginTop + plotH);
      ctx.lineTo(x(0), marginTop + plotH);
      ctx.closePath();
      ctx.fill();
    }

    const pos = state.position;
    drawOverlayLine(ctx, plotW, y, lo, hi, pos.avg_price, "#4f8cff", `均 ${fmt(pos.avg_price, 1)}`, pos.qty !== 0);
    drawOverlayLine(ctx, plotW, y, lo, hi, pos.stop_loss, "#ff5c5c", `SL ${fmt(pos.stop_loss, 1)}`, pos.qty !== 0 && pos.stop_loss != null);
    drawOverlayLine(ctx, plotW, y, lo, hi, pos.take_profit, "#3ddc84", `TP ${fmt(pos.take_profit, 1)}`, pos.qty !== 0 && pos.take_profit != null);

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

    $("chart-legend").textContent = isCandle ? "每根蠟燭 = 60 秒" : "";
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

  setSide("BUY");
  toggleLimitField();
  bootstrapAuth().then((user) => {
    if (user) connect();
  });
})();
