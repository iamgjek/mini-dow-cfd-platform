# 微小台指模擬交易平台 (Micro TAIEX Futures Paper Trading Platform)

一個**真實行情、模擬下單**的微小台指(Micro TAIEX Futures,代碼 `TFFITMQ+`)練習交易平台。報價來自第三方 TF 市場即時 TCP 行情 feed(真實市場資料),但下單、成交、部位、損益全部在本地/資料庫計算,**沒有連接任何真實券商下單通道**,不會產生任何真實金錢往來。

> 這個平台原本是完全模擬的「小道瓊 CFD」(連行情都是隨機漫步產生的),後來因為拿到一組真實的 TF 市場行情帳號,改成串接真實台指報價 —— 詳見下方「行情資料來源」。目前使用的商品也從小台指換成了微小台指。

## 功能

- **真實即時報價**:透過 TCP Socket 連線第三方 TF 市場行情伺服器,即時接收微小台指(`TFFITMQ+`)報價,包含真實五檔買賣價量(不用像過去那樣自己合成價差)
- **圖表**:線圖 / K 線(1 分鐘)切換、線圖分時區間選擇(5分/15分/30分/1小時,預設 15 分鐘,依真實時間戳計算,不假設固定的報價頻率)、滑鼠 hover 十字線 + OHLC/價格提示框、均價與停損/停利水平線疊圖(即使目前價格已經走出可視範圍也會自動擴大座標軸讓這些線保持可見)、X 軸時間刻度
- 市價單 / 限價單下單,買/賣方向切換(下單介面只保留方向/類型/口數,精簡明快)
- **停損 / 停利改為「部位管理」彈窗操作**:點擊「目前部位」卡片或委託單/成交紀錄裡標示「可編輯」的列即可開啟,裡面可調整停損/停利;彈窗只在打開當下讀取目前值,不會被報價更新蓋掉正在輸入的內容
- **平倉支援「平倉此筆」與「全部平倉」兩種**:從委託單/成交紀錄某一筆點進去,可以只平掉那一筆的口數;從「目前部位」卡片點進去則只會看到「全部平倉」。當「這一筆」的口數已經涵蓋剩餘部位時,兩個按鈕會自動合併成一個,不會顯示兩個等價的重複選項
- 淨額部位模型(加碼會重新計算均價、反向下單會先平倉再反手)
- 保證金檢查(依可用淨值計算,曝險增加時若保證金不足會拒單)
- 帳戶餘額 / 淨值 / 未實現損益 / 已用保證金即時更新
- 委託單:未成交(PENDING)的限價單可以「取消」
- **委託單與成交紀錄只把「屬於目前未平倉部位」的那幾筆標上「可編輯」徽章並可點擊**(以部位的開倉時間 `opened_at` 為分界),已經平倉的歷史紀錄不會誤標成可操作
- WebSocket 即時推播,前端為純 HTML/CSS/JS(無框架、無需建置)
- **會員機制**:email/密碼註冊登入,session cookie 驗證,每個會員有各自獨立的模擬帳戶(餘額/部位/委託/成交都互相隔離);**新會員預設初始保證金為 NT$500,000**(管理後台可調整,僅套用於之後新註冊的會員)
- **管理後台**:平台設定(新會員初始保證金)、會員列表、單一會員詳情(部位/委託/成交)、調整會員模擬餘額(含稽核紀錄)、停用/啟用會員、變更會員角色(user/admin)、平台總覽統計
- **Supabase Postgres 持久化**(會員、部位、委託、成交、餘額調整紀錄、平台設定),重啟伺服器/重新部署資料不會遺失

## 行情資料來源

`backend/price_engine.py` 會用 asyncio 開一條長駐 TCP 連線到第三方行情伺服器,連上後送出登入字串(`;uz=2;utf8=1;wt1=0;m=TF;u=<帳號>;p=<密碼>;`),伺服器會持續推送 TF 市場**所有**商品的報價(換行分隔的 `{...}` CSV 格式),程式只挑出設定的商品代碼(預設 `TFFITMQ+` 微小台指 2026-08 合約)更新價格、寫入歷史、廣播給所有連線中的會員。斷線會自動重連(指數退避),並每 2 分鐘重送一次登入字串當心跳。

這個 feed 目前觀察到的相關商品代碼(同一交易所,規格大小不同):

| 代碼 | 名稱 | 官方乘數 |
|---|---|---|
| `TFFITX1` | 台指期(大台指,當月) | NT$200/點 |
| `TFFIMTX8` | 小台指(當月,自動轉倉) | NT$50/點 |
| `TFFITM1` | 微台指(當月,自動轉倉) | NT$10/點 |
| `TFFITMQ+` | 微台指(2026-08 合約,**目前使用**) | NT$10/點 |

`TFFITMQ+` 是固定月份的合約代碼,不會像 `TFFIMTX8`/`TFFITM1` 那樣自動轉倉——合約到期後要手動把 `TF_SYMBOL` 換成下個月的代碼,行情才會繼續更新。

要換成別的合約,改環境變數 `TF_SYMBOL` 並同步調整 `backend/config.py` 的 `CONTRACT_MULTIPLIER` 即可。

⚠️ **這組帳號是免費試用帳號,試用期到 2026-09-05 23:59:59 為止**,之後這組帳密會失效,行情會停止更新(不影響已有資料,只是不會再有新報價)。

## 本地執行

```bash
cd mini-dow-cfd-platform
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 填入 Supabase Postgres 連線字串 + TF_USERNAME/TF_PASSWORD
uvicorn backend.main:app --reload
```

開啟瀏覽器造訪 http://localhost:8000,會先導向 `/login.html` 進行註冊/登入。

**第一個註冊的帳號會自動成為管理員**,可在右上角「管理後台」進入 `/admin.html`。

## 專案結構

```
backend/
  config.py         # 商品參數(乘數、保證金率...)+ 行情 feed 連線設定(host/port/帳密/商品代碼)
  db.py              # Postgres schema 與資料存取(users/sessions/positions/orders/trades),透過 psycopg 連線 Supabase
  auth.py            # 密碼雜湊(PBKDF2)、session cookie 簽發與驗證
  price_engine.py    # TF 市場即時行情 TCP client(全體會員共用同一組行情)
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

這個 app 需要**常駐 process**(背景行情 TCP 連線 + WebSocket 長連線),所以不能部署在 Vercel 這類 serverless 平台上 —— 報價不會動、WebSocket 會一直斷線重連。目前的部署組合是:

- **GitHub**:程式碼託管 — https://github.com/iamgjek/mini-dow-cfd-platform
- **Supabase**:Postgres 資料庫(取代原本的 SQLite)
- **Render**(或 Railway / Fly.io 等任何支援常駐 Python process 的平台):跑 FastAPI 後端,`render.yaml` 已經設好 build/start command — https://mini-dow-cfd-platform.onrender.com

### 部署步驟

1. 推上 GitHub 後,到 Render 建立新的 **Blueprint**(不是 Web Service —— repo 裡已經有 `render.yaml`,選 Blueprint 會自動讀出來),選這個 repo
2. Render 會提示填三個環境變數(`render.yaml` 裡標了 `sync: false`,故意留給你手動填):
   - `DATABASE_URL`:Supabase 專案 → Project Settings → Database → Connection string(建議用 Session pooler 或直連,因為這個 app 每個 process 只會開一條長駐連線,不需要 transaction-mode pooling)
   - `TF_USERNAME` / `TF_PASSWORD`:行情 feed 的帳密
3. Deploy,第一次啟動時 `init_db()` 會自動建好所有資料表(`CREATE TABLE IF NOT EXISTS`)

### Row Level Security

Supabase 預設會把 `public` schema 底下的資料表透過 REST API(PostgREST)對外暴露。這個專案的 7 張表(`users`、`sessions`、`positions`、`orders`、`trades`、`settings`、`balance_adjustments`)**已經開啟 RLS**(沒有另外加 policy)—— 這個 app 本身透過 `DATABASE_URL` 直連 Postgres 不受影響,但也代表現在還沒有辦法透過 Supabase 的 anon key/客戶端函式庫存取這些表,之後如果要加這種存取方式需要自己補 policy。

## 已知限制 / 之後可以擴充的方向

- 保證金模型是簡化的「名目價值 × 5%」,不是交易所公告的固定金額原始保證金表,僅供示範
- 只串接了行情(唯讀),**沒有串接任何真實券商下單 API**,所有下單/成交/部位都是本地計算的模擬
- 行情 feed 是第三方免費試用帳號,**2026-09-05 之後會失效**,且供應商穩定性/資料正確性不受本專案控制
- Session 用 httpOnly cookie,但 dev 模式下沒有強制 `Secure`/HTTPS,正式環境需自行加上反向代理 + HTTPS(Render 預設會提供 HTTPS)
- 資料庫存取目前是同步（blocking psycopg 呼叫）,適合示範/練習規模,大量併發會員需要換成非同步 DB 或加連線池
- 這個 Supabase 專案是跟使用者其他既有的 app 共用(裡面還有 `profiles`/`download_logs`/`tw_holdings`/`tw_prices` 等不相關的表),表名沒有衝突,但如果要完全隔離建議另開一個新專案
- 管理員可在管理後台的角色下拉選單直接調整其他會員的 user/admin 角色;無法變更自己的角色,也無法把最後一位 admin 降級,避免不小心把系統鎖死
