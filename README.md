# SP500 Hit Tester (Stable)

這個專案把 **S&P500 命中率測試器（web）** 與 **美股個股整合分析服務（analyzer）** 放在同一份 repo 中，提供一套可以批次回測、統計 BUY/SELL 準確度並且由 LLM 產出投資結論的工具。根目錄的 `npm` scripts 會同時啟動兩個服務：

| 路徑 | 說明 |
| --- | --- |
| `web/` | 以 FMP Stable API 取資料、串接 analyzer API，提供回測流程與前端頁面 |
| `analyzer/` | 整合 SEC / Finnhub / FMP / OpenAI，負責 `/api/analyze` 這個核心分析 API |

## 需求

- Node.js 18+（Zeabur / Docker 也相同）
- npm 9+
- FMP / Finnhub / SEC / OpenAI 等 API 金鑰（見下方環境變數）

## 安裝

```bash
# 1. 安裝根目錄腳本所需的 concurrently
npm install

# 2. 為各子專案安裝依賴
(cd analyzer && npm install)
(cd web && npm install)

# 3. 複製範例環境變數
cp analyzer/.env.example analyzer/.env
cp web/.env.example web/.env   # 若不存在可自行建立
```

> `analyzer/.env` 及 `web/.env` 只用於本機開發，正式環境請改設平台提供的環境變數以避免秘鑰外洩。

## 關鍵環境變數

| 服務 | 變數 | 說明 |
| --- | --- | --- |
| web | `PORT` | 對外服務的 HTTP 連接埠，Zeabur 會自動指定 |
| web | `ANALYZER_BASE` | 指向 analyzer API，例如 `http://127.0.0.1:5001` |
| web | `FMP_API_KEY` / `FMP_STABLE_BASE` | 讀取 FMP stable API 所需金鑰與 base URL |
| web | `WORKERS` / `RETURN_WORKERS` | 併發 worker 數，依 Zeabur 配額調整 |
| analyzer | `PORT` 或 `ANALYZER_PORT` | Analyzer 內部 HTTP 連接埠（預設 5001） |
| analyzer | `SEC_USER_AGENT` / `SEC_API_KEY` | SEC API 需求 |
| analyzer | `FINNHUB_KEY` / `FMP_API_KEY` / `ALPHAVANTAGE_KEY` | 第三方數據來源 |
| analyzer | `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_MODEL_SECONDARY` | LLM 設定 |
| analyzer | `REALTIME_RESULT_TTL_HOURS` 等 | 調整快取與 LLM 參數，可視需要設定 |

## 本機開發

```bash
# 1. 啟動 Analyzer（會讀取 analyzer/.env）
(cd analyzer && npm run dev)

# 2. 另開終端啟動 web（讀取 web/.env）
(cd web && npm run dev)

# 或者直接在根目錄一次啟動
npm run dev
```

- 預設 `analyzer` 會聽在 `http://localhost:5001`，`web` 則在 `http://localhost:3002`。
- `web` 呼叫 `/api/run-test` 會自動向 analyzer 的 `/api/analyze` 索取 BUY/SELL/HOLD 與目標價，再與 FMP 價格序列比對是否命中。

## 部署到 Zeabur

Zeabur 允許在同一個服務觸發多個 Node.js 程序，只要最終有一個綁定 Zeabur 指定的 `PORT` 即可。這個 repo 的 `npm start` 會讓：

1. `web` 服務綁定 Zeabur 提供的 `PORT`（對外入口）；
2. `analyzer` 另外綁在容器內部的 `ANALYZER_PORT`（預設 5001），`web` 透過 `ANALYZER_BASE=http://127.0.0.1:5001` 呼叫。

部署步驟：

1. 在 Zeabur 建立專案並連結 GitHub repo `garen0616/sp500-hit-tester-stable`。
2. 建議設定：
   - Runtime: Node.js 20
   - Install command: `npm install && (cd analyzer && npm install) && (cd web && npm install)`
   - Build command: _留空_
   - Start command: `npm run start`
3. 新增環境變數（依照實際金鑰）：
   - `ANALYZER_PORT=5001`
   - `ANALYZER_BASE=http://127.0.0.1:5001`
   - `SEC_USER_AGENT=your-app/1.0 (email@example.com)`
   - `SEC_API_KEY=...`
   - `FINNHUB_KEY=...`
   - `FMP_API_KEY=...`
   - `OPENAI_API_KEY=...`
   - 其他選填：`FMP_STABLE_BASE`、`ALPHAVANTAGE_KEY`、`REALTIME_RESULT_TTL_HOURS`…
4. 部署後，Zeabur 控制台提供的 URL 就會指向 `web` 介面；web 內部所有分析請求會打到同容器的 analyzer，無需額外網路設定。

## 健康檢查 & 驗證

- `GET /api/meta`：由 `web` 服務提供，可確認 S&P 500 清單是否成功取得。
- `POST /api/run-test`：主流程，需傳入開始/結束日期與選股策略；回傳 JSON 包含摘要與 CSV。
- `POST ${ANALYZER_BASE}/api/analyze`：Analyzer 核心 API，可在部署後用 `curl` 送 `{ "ticker":"NVDA", "date":"2024-11-01" }` 驗證。

若 Zeabur 部署後能成功在前端頁面觸發測試並下載結果，即視為部署完成。
