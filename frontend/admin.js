(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 2) => (n === null || n === undefined ? "--" : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
  const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString();

  let currentUserId = null;
  let currentAdminId = null;

  async function api(path, opts) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || res.statusText);
    }
    return res.json();
  }

  async function bootstrapAuth() {
    const res = await fetch("/api/auth/me");
    if (!res.ok) {
      window.location.href = "/login.html";
      return null;
    }
    const user = await res.json();
    if (user.role !== "admin") {
      window.location.href = "/";
      return null;
    }
    currentAdminId = user.id;
    $("avatar-btn").textContent = (user.display_name || user.email || "?").trim().charAt(0).toUpperCase();
    $("user-dropdown-name").textContent = `${user.display_name} · 管理員`;
    $("user-dropdown-email").textContent = user.email;
    return user;
  }

  async function loadSettings() {
    const s = await api("/api/admin/settings");
    $("setting-initial-balance").value = s.initial_balance;
  }

  async function saveSettings() {
    try {
      await api("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify({ initial_balance: Number($("setting-initial-balance").value) }),
      });
      const saved = $("settings-saved");
      saved.style.display = "inline";
      setTimeout(() => (saved.style.display = "none"), 2000);
    } catch (err) {
      alert(err.message);
    }
  }

  async function loadStats() {
    const s = await api("/api/admin/stats");
    $("stat-users").textContent = s.total_users;
    $("stat-balance").textContent = fmt(s.total_balance);
    $("stat-open").textContent = s.users_with_open_position;
    $("stat-exposure").textContent = s.total_open_contracts;
  }

  async function loadUsers() {
    const users = await api("/api/admin/users");
    const body = $("users-body");
    if (!users.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="9">尚無會員</td></tr>';
      return;
    }
    body.innerHTML = users
      .map((u) => {
        const isSelf = u.id === currentAdminId;
        const roleSelect = `<select class="mini-btn" data-role="${u.id}" ${isSelf ? "disabled title=\"無法變更自己的角色\"" : ""}>
          <option value="user" ${u.role === "user" ? "selected" : ""}>user</option>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>admin</option>
        </select>`;
        const statusBadge = u.is_active ? "" : '<span class="badge disabled">停用</span>';
        const upnl = u.account.unrealized_pnl;
        return `<tr class="clickable" data-id="${u.id}">
          <td style="text-align:left;">${u.email}</td>
          <td style="text-align:left;">${u.display_name}</td>
          <td>${roleSelect}</td>
          <td>${statusBadge || "正常"}</td>
          <td>${fmt(u.account.balance)}</td>
          <td>${fmt(u.account.equity)}</td>
          <td class="${upnl > 0 ? "up" : upnl < 0 ? "down" : ""}">${fmt(upnl)}</td>
          <td>${u.position_qty}</td>
          <td><button class="mini-btn" data-toggle="${u.id}" data-active="${u.is_active}" ${isSelf ? "disabled" : ""}>${u.is_active ? "停用" : "啟用"}</button></td>
        </tr>`;
      })
      .join("");

    body.querySelectorAll("tr[data-id]").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("[data-toggle]") || e.target.closest("[data-role]")) return;
        openDetail(tr.dataset.id);
      });
    });
    body.querySelectorAll("[data-toggle]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await api(`/api/admin/users/${btn.dataset.toggle}/toggle-active`, { method: "POST" });
          await loadUsers();
        } catch (err) {
          alert(err.message);
        }
      });
    });
    body.querySelectorAll("[data-role]").forEach((select) => {
      select.addEventListener("click", (e) => e.stopPropagation());
      select.addEventListener("change", async () => {
        const userId = select.dataset.role;
        const newRole = select.value;
        try {
          await api(`/api/admin/users/${userId}/set-role`, {
            method: "POST",
            body: JSON.stringify({ role: newRole }),
          });
          await loadUsers();
          await loadStats();
        } catch (err) {
          alert(err.message);
          await loadUsers();
        }
      });
    });
  }

  async function openDetail(userId) {
    currentUserId = userId;
    const d = await api(`/api/admin/users/${userId}`);
    $("detail-title").textContent = `${d.user.display_name} (${d.user.email})`;
    $("detail-account").innerHTML = `
      <div class="label">餘額</div><div class="value">${fmt(d.account.balance)}</div>
      <div class="label">淨值</div><div class="value">${fmt(d.account.equity)}</div>
      <div class="label">未實現損益</div><div class="value">${fmt(d.account.unrealized_pnl)}</div>
      <div class="label">已用保證金</div><div class="value">${fmt(d.account.used_margin)}</div>
      <div class="label">部位</div><div class="value">${d.position.qty === 0 ? "Flat" : `${d.position.qty > 0 ? "多" : "空"} ${Math.abs(d.position.qty)} @ ${fmt(d.position.avg_price, 1)}`}</div>
    `;
    $("adjust-amount").value = "";
    $("adjust-reason").value = "";
    $("adjust-error").textContent = "";

    $("detail-orders").innerHTML = d.orders.length
      ? d.orders
          .slice(0, 15)
          .map((o) => `<tr><td>${fmtTime(o.created_at)}</td><td class="${o.side === "BUY" ? "up" : "down"}">${o.side}</td><td>${o.qty}</td><td>${o.filled_price ? fmt(o.filled_price, 1) : o.limit_price ? fmt(o.limit_price, 1) : "MKT"}</td><td>${o.status}</td></tr>`)
          .join("")
      : '<tr class="empty-row"><td colspan="5">尚無委託</td></tr>';

    $("detail-trades").innerHTML = d.trades.length
      ? d.trades
          .slice(0, 15)
          .map((t) => `<tr><td>${fmtTime(t.ts)}</td><td class="${t.side === "BUY" ? "up" : "down"}">${t.side}</td><td>${t.qty}</td><td>${fmt(t.price, 1)}</td><td class="${t.realized_pnl > 0 ? "up" : t.realized_pnl < 0 ? "down" : ""}">${fmt(t.realized_pnl)}</td></tr>`)
          .join("")
      : '<tr class="empty-row"><td colspan="5">尚無成交</td></tr>';

    $("detail-modal").classList.remove("hidden");
  }

  async function submitAdjustment() {
    const amount = Number($("adjust-amount").value);
    if (!amount) {
      $("adjust-error").textContent = "請輸入非零金額";
      return;
    }
    try {
      await api(`/api/admin/users/${currentUserId}/adjust-balance`, {
        method: "POST",
        body: JSON.stringify({ amount, reason: $("adjust-reason").value || null }),
      });
      await openDetail(currentUserId);
      await loadUsers();
      await loadStats();
    } catch (err) {
      $("adjust-error").textContent = err.message;
    }
  }

  $("modal-close").addEventListener("click", () => $("detail-modal").classList.add("hidden"));
  $("detail-modal").addEventListener("click", (e) => {
    if (e.target.id === "detail-modal") $("detail-modal").classList.add("hidden");
  });
  $("adjust-submit").addEventListener("click", submitAdjustment);
  $("settings-save").addEventListener("click", saveSettings);
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

  bootstrapAuth().then((user) => {
    if (!user) return;
    loadSettings();
    loadStats();
    loadUsers();
    setInterval(() => {
      loadStats();
      loadUsers();
    }, 5000);
  });
})();
