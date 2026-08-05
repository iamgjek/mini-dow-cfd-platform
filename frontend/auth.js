(() => {
  const $ = (id) => document.getElementById(id);
  let mode = "login";

  function setMode(next) {
    mode = next;
    const isRegister = mode === "register";
    $("form-title").textContent = isRegister ? "註冊新帳戶" : "登入";
    $("field-display-name").style.display = isRegister ? "block" : "none";
    $("submit-btn").textContent = isRegister ? "註冊" : "登入";
    $("switch-text").textContent = isRegister ? "已經有帳戶?" : "還沒有帳戶?";
    $("switch-link").textContent = isRegister ? "登入" : "註冊新帳戶";
    $("auth-error").classList.add("hidden");
  }

  async function submit() {
    const errEl = $("auth-error");
    errEl.classList.add("hidden");
    const email = $("email").value.trim();
    const password = $("password").value;
    const path = mode === "register" ? "/api/auth/register" : "/api/auth/login";
    const body = { email, password };
    if (mode === "register") body.display_name = $("display-name").value.trim();

    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "發生錯誤");
      window.location.href = "/";
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove("hidden");
    }
  }

  $("switch-link").addEventListener("click", () => setMode(mode === "login" ? "register" : "login"));
  $("submit-btn").addEventListener("click", submit);
  $("password").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  setMode("login");
})();
