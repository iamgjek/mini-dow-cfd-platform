# 小道瓊 CFD 模擬交易平台 (Mini Dow CFD Paper Trading Platform)

一個**完全模擬**的小道瓊 (Mini Dow / US30) CFD 練習交易平台。行情由本地隨機漫步引擎產生,下單、成交、部位、損益全部在記憶體中計算,**沒有連接任何真實券商或真實市場資料**,不會產生任何真實金錢往來。

> 為什麼是自建模擬,而不是接永豐 Shioaji API?Shioaji 只涵蓋台灣證交所股票與台灣期交所期貨/選擇權,SDK 中沒有海外期貨/CFD/道瓊的合約類別,無法用來取得或模擬小道瓊行情與下單。

## 功能

- 即時模擬報價(隨機漫步 + 買賣價差)
- **圖表**:線圖 / K 線(1 分鐘)切換、線圖分時區間選擇(5分/15分/30分/1小時,預設 15 分鐘)、滑鼠 hover 十字線 + OHLC/價格提示框、均價與停損/停利水平線疊圖(即使目前價格已經走出可視範圍也會自動擴大座標軸讓這些線保持可見)、X 軸時間刻度
- 市價單 / 限價單下單,買/賣方向切換(下單介面只保留方向/類型/口數,精簡明快)
- **停損 / 停利改為「部位管理」彈窗操作**:點擊「目前部位」卡片或委託單/成交紀錄裡標示「可編輯」的列即可開啟,裡面可調整停損/停利;彈窗只在打開當下讀取目前值,不會被每秒報價更新蓋掉正在輸入的內容
- **平倉支援「平倉此筆」與「全部平倉」兩種**:從委託單/成交紀錄某一筆點進去,可以只平掉那一筆的口數;從「目前部位」卡片點進去則只會看到「全部平倉」。當「這一筆」的口數已經涵蓋剩餘部位時,兩個按鈕會自動合併成一個,不會顯示兩個等價的重複選項
- 淨額部位模型(加碼會重新計算均價、反向下單會先平倉再反手)
- 保證金檢查(依可用淨值計算,曝險增加時若保證金不足會拒單)
- 帳戶餘額 / 淨值 / 未實現損益 / 已用保證金即時更新
- 委託單:未成交(PENDING)的限價單可以「取消」
- **委託單與成交紀錄只把「屬於目前未平倉部位」的那幾筆標上「可編輯」徽章並可點擊**(以部位的開倉時間 `opened_at` 為分界),已經平倉的歷史紀錄不會誤標成可操作
- WebSocket 即時推播,前端為純 HTML/CSS/JS(無框架、無需建置)
- **會員機制**:email/密碼註冊登入,session cookie 驗證,每個會員有各自獨立的模擬帳戶(餘額/部位/委託/成交都互相隔離);**新會員預設初始保證金為 1,000**(管理後台可調整,僅套用於之後新註冊的會員)
- **管理後台**:平台設定(新會員初始保證金)、會員列表、單一會員詳情(部位/委託/成交)、調整會員模擬餘額(含稽核紀錄)、停用/啟用會員、變更會員角色(user/admin)、平台總覽統計
- **Supabase Postgres 持久化**(會員、部位、委託、成交、餘額調整紀錄、平台設定),重啟伺服器/重新部署資料不會遺失

## 本地執行

```bash
cd mini-dow-cfd-platform
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 填入你的 Supabase Postgres 連線字串
uvicorn backend.main:app --reload
```

開啟瀏覽器造訪 http://localhost:8000,會先導向 `/login.html` 進行註冊/登入。

**第一個註冊的帳號會自動成為管理員**,可在右上角「管理後台」進入 `/admin.html`。

## 專案結構

```
backend/
  config.py         # 模擬商品參數(參考價、乘數、價差、保證金率...)
  db.py              # Postgres schema 與資料存取(users/sessions/positions/orders/trades),透過 psycopg 連線 Supabase
  auth.py            # 密碼雜湊(PBKDF2)、session cookie 簽發與驗證
  price_engine.py    # 隨機漫步報價產生器(全體會員共用同一組行情)
  engine.py          # 單一會員的下單撮合、部位、損益、保證金邏輯,寫入 Postgres
  engine_manager.py  # 依 user_id 管理多個 TradingEngine,並把行情 tick 分派給每個會員
  models.py          # Pydantic 資料模型
  main.py            # FastAPI REST + WebSocket(依會員區隔)、管理後台 API、前端靜態檔案
frontend/
  login.html / auth.js             # 註冊 / 登入
  index.html / app.js / style.css  # 交易儀表板
  admin.html / admin.js            # 管理後台
render.yaml / Procfile / runtime.txt  # 部署設定(Render 等支援常駐 process 的平台)
```

## 部署

這個 app 需要**常駐 process**(背景報價迴圈 + WebSocket 長連線),所以不能部署在 Vercel 這類 serverless 平台上 —— 報價不會動、WebSocket 會一直斷線重連。目前的部署組合是:

- **GitHub**:程式碼託管
- **Supabase**:Postgres 資料庫(取代原本的 SQLite)
- **Render**(或 Railway / Fly.io 等任何支援常駐 Python process 的平台):跑 FastAPI 後端,`render.yaml` 已經設好 build/start command

### 部署步驟

1. 推上 GitHub 後,到 Render 建立新的 **Web Service**,選這個 repo,它會讀到 `render.yaml` 自動帶入 build/start 指令
2. 到 Supabase 專案的 **Project Settings → Database → Connection string**,複製連線字串(建議用 Session pooler 或直連,因為這個 app 每個 process 只會開一條長駐連線,不需要 transaction-mode pooling)
3. 在 Render 的環境變數設定 `DATABASE_URL` 為上面複製的連線字串
4. Deploy,第一次啟動時 `init_db()` 會自動建好所有資料表(`CREATE TABLE IF NOT EXISTS`,已透過 Supabase MCP 先跑過一次)

### ⚠️ 安全性提醒:Row Level Security

Supabase 預設會把 `public` schema 底下的資料表透過 REST API(PostgREST)對外暴露。這個專案新建的 7 張表(`users`、`sessions`、`positions`、`orders`、`trades`、`settings`、`balance_adjustments`)目前 **RLS 是關閉的** —— 如果有人拿到這個 Supabase 專案的 anon/publishable key,可以直接用 REST API 讀寫這些表,完全繞過後端的登入驗證與保證金檢查邏輯。

這個 app 本身是透過 `DATABASE_URL` 直連 Postgres(不是走 Supabase 的 REST API/anon key),所以就算開啟 RLS 也不會擋到後端自己的存取。但**是否要開啟 RLS 由你決定**(直接開啟且沒配 policy 可能會擋到你之後想用 Supabase 客戶端函式庫做的其他存取),建議至少執行:

```sql
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_adjustments ENABLE ROW LEVEL SECURITY;
```

## 已知限制 / 之後可以擴充的方向

- 商品參數(參考價 42000、乘數 $5/點、價差 2 點、保證金率 5%)是示範用簡化假設,非真實市場數值
- 未串接任何真實行情或真實券商下單 API
- Session 用 httpOnly cookie,但 dev 模式下沒有強制 `Secure`/HTTPS,正式環境需自行加上反向代理 + HTTPS(Render 預設會提供 HTTPS)
- 資料庫存取目前是同步（blocking psycopg 呼叫）,適合示範/練習規模,大量併發會員需要換成非同步 DB 或加連線池
- 這個 Supabase 專案是跟使用者其他既有的 app 共用(裡面還有 `profiles`/`download_logs`/`tw_holdings`/`tw_prices` 等不相關的表),表名沒有衝突,但如果要完全隔離建議另開一個新專案
- 管理員可在管理後台的角色下拉選單直接調整其他會員的 user/admin 角色;無法變更自己的角色,也無法把最後一位 admin 降級,避免不小心把系統鎖死
