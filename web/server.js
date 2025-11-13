import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import compression from "compression";
import dayjs from "dayjs";
import XLSX from "xlsx";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(compression());
app.use(morgan("dev"));
app.use(express.static("public"));

const PORT = Number(process.env.PORT || 3002);
const ANALYZER_BASE = process.env.ANALYZER_BASE || "http://localhost:5001";
const STABLE = (process.env.FMP_STABLE_BASE || "https://financialmodelingprep.com/stable").replace(/\/$/, "");
const FMP_KEY = process.env.FMP_API_KEY || "";
const WORKERS = Number(process.env.WORKERS || 8);
const RETURN_WORKERS = Number(process.env.RETURN_WORKERS || 10);
let activeRun = null;

if (!FMP_KEY) console.warn("⚠️ 未設定 FMP_API_KEY；請在 web/.env 補上 FMP_API_KEY");

function createRunContext() {
  return {
    id: uuidv4(),
    cancelled: false,
    startedAt: Date.now(),
    tokenUsage: { prompt: 0, completion: 0, total: 0, cost: 0, calls: 0 }
  };
}

function runCancelledError() {
  const err = new Error("RUN_CANCELLED");
  err.code = "RUN_CANCELLED";
  return err;
}

function assertNotCancelled(ctx) {
  if (ctx?.cancelled) throw runCancelledError();
}

function applyUsage(ctx, usage) {
  if (!ctx || !usage) return;
  const tracker = ctx.tokenUsage;
  const prompt = Number(usage.prompt_tokens);
  const completion = Number(usage.completion_tokens);
  const total = Number(usage.total_tokens);
  const totalCost = Number(usage.total_cost);
  const inputCost = Number(usage.input_cost);
  const outputCost = Number(usage.output_cost);
  if (Number.isFinite(prompt)) tracker.prompt += prompt;
  if (Number.isFinite(completion)) tracker.completion += completion;
  if (Number.isFinite(total)) tracker.total += total;
  else if (Number.isFinite(prompt) || Number.isFinite(completion)) {
    tracker.total += (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0);
  }
  if (Number.isFinite(totalCost)) tracker.cost += totalCost;
  else if (Number.isFinite(inputCost) || Number.isFinite(outputCost)) {
    tracker.cost += (Number.isFinite(inputCost) ? inputCost : 0) + (Number.isFinite(outputCost) ? outputCost : 0);
  }
  tracker.calls += 1;
}

function summarizeTokenUsage(ctx) {
  if (!ctx) return null;
  const tracker = ctx.tokenUsage || {};
  const finishedAt = ctx.finishedAt || Date.now();
  const startedAt = ctx.startedAt || finishedAt;
  return {
    prompt: tracker.prompt || 0,
    completion: tracker.completion || 0,
    total: tracker.total || 0,
    cost: Number.isFinite(tracker.cost) ? Number(tracker.cost.toFixed(6)) : 0,
    calls: tracker.calls || 0,
    durationMs: Math.max(0, finishedAt - startedAt)
  };
}

function cancelActiveRun() {
  if (activeRun) {
    activeRun.cancelled = true;
    return true;
  }
  return false;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function buildDates(startDate, endDate, interval) {
  const s = dayjs(startDate), e = dayjs(endDate);
  const out = [];
  let d = s;
  while (d.isBefore(e) || d.isSame(e, "day")) {
    out.push(d.format("YYYY-MM-DD"));
    if (interval === "week") d = d.add(1, "week");
    else if (interval === "quarter") d = d.add(3, "month");
    else d = d.add(1, "month");
  }
  return out;
}

async function fmp(path, params = {}, retry = 1) {
  const url = new URL(`${STABLE}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, String(v));
  url.searchParams.set("apikey", FMP_KEY);
  const res = await fetch(url, { headers: { "Accept":"application/json" } });
  if (!res.ok) {
    if (retry > 0) { await sleep(600); return fmp(path, params, retry - 1); }
    const text = await res.text();
    throw new Error(`FMP ${res.status} ${url}: ${text.slice(0,200)}`);
  }
  return res.json();
}

function closeOnOrBefore(series, ymd) {
  if (!Array.isArray(series) || !series.length) return NaN;
  let lo = 0, hi = series.length - 1, ans = NaN;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= ymd) { ans = series[mid].close; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return ans;
}

async function getSP500() {
  const data = await fmp("sp500-constituent");
  const rows = Array.isArray(data) ? data : [];
  return rows.map(r => ({ symbol: String(r.symbol).toUpperCase(), sector: r.sector || "" }));
}

async function getDailyFull(symbol) {
  // /stable/historical-price-eod/full?symbol=XXX
  const data = await fmp("historical-price-eod/full", { symbol });
  const hist = Array.isArray(data?.historical) ? data.historical : (Array.isArray(data) ? data : []);
  return hist
    .map(r => ({ date: r.date, close: Number(r.close ?? r.adjClose) }))
    .filter(r => r.date && Number.isFinite(r.close))
    .sort((a,b) => (a.date < b.date ? -1 : 1));
}

async function getDailyMapForTickers(tickers, runCtx) {
  const map = {};
  let idx = 0;
  async function worker() {
    while (true) {
      assertNotCancelled(runCtx);
      const i = idx++;
      if (i >= tickers.length) break;
      const sym = tickers[i];
      try { map[sym] = await getDailyFull(sym); } catch { map[sym] = []; }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  return map;
}

async function rankByReturn(tickers, from, to, runCtx) {
  const out = [];
  let idx = 0;
  async function worker() {
    while (true) {
      assertNotCancelled(runCtx);
      const i = idx++;
      if (i >= tickers.length) break;
      const sym = tickers[i];
      try {
        const series = await getDailyFull(sym);
        const s = series.filter(r => r.date >= from && r.date <= to);
        if (!s.length) continue;
        const p0 = s[0].close, p1 = s[s.length-1].close;
        if (Number.isFinite(p0) && Number.isFinite(p1)) out.push({ symbol: sym, ret: (p1 - p0) / p0 });
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: RETURN_WORKERS }, worker));
  out.sort((a,b) => b.ret - a.ret);
  return out;
}

async function rankByMarketCapLatest(tickers, runCtx) {
  // /stable/market-capitalization-batch?symbols=...
  const chunk = (arr, n) => Array.from({length: Math.ceil(arr.length/n)}, (_,i)=>arr.slice(i*n, i*n+n));
  const rows = [];
  for (const grp of chunk(tickers, 150)) {
    assertNotCancelled(runCtx);
    const d = await fmp("market-capitalization-batch", { symbols: grp.join(",") });
    for (const r of (Array.isArray(d) ? d : [])) {
      const cap = Number(r.marketCap ?? r.marketcap ?? r.market_cap);
      if (r.symbol && Number.isFinite(cap)) rows.push({ symbol: String(r.symbol).toUpperCase(), cap });
    }
  }
  rows.sort((a,b)=> (b.cap||0)-(a.cap||0));
  return rows;
}

async function rankByMarketCapAsOf(tickers, asOfYmd, runCtx) {
  // /stable/historical-market-capitalization?symbol=XXX 取「<= asOf」最近一筆
  let idx = 0;
  const out = [];
  async function worker() {
    while (true) {
      assertNotCancelled(runCtx);
      const i = idx++;
      if (i >= tickers.length) break;
      const sym = tickers[i];
      try {
        const d = await fmp("historical-market-capitalization", { symbol: sym });
        const arr = Array.isArray(d) ? d : [];
        arr.sort((a,b)=> (a.date < b.date ? -1 : 1));
        let cap = null;
        for (let j = arr.length - 1; j >= 0; j--) {
          if (arr[j].date <= asOfYmd) { cap = Number(arr[j].marketCap ?? arr[j].marketcap); break; }
        }
        if (Number.isFinite(cap)) out.push({ symbol: sym, cap });
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: RETURN_WORKERS }, worker));
  out.sort((a,b)=> (b.cap||0)-(a.cap||0));
  return out;
}

function normalizeDecision(s) {
  const t = String(s || "").toUpperCase();
  if (t.includes("BUY") || t.includes("買")) return "BUY";
  if (t.includes("SELL") || t.includes("賣")) return "SELL";
  if (t.includes("HOLD") || t.includes("中性") || t.includes("NEUTRAL")) return "HOLD";
  return "UNKNOWN";
}

const decisionCache = new Map();
async function getDecision(ticker, date, runCtx) {
  const key = `${ticker}|${date}`;
  if (decisionCache.has(key)) {
    const cached = decisionCache.get(key);
    if (typeof cached === "string") {
      const payload = { rating: cached, target: null, usage: null };
      decisionCache.set(key, payload);
      return payload;
    }
    return cached;
  }
  const res = await fetch(`${ANALYZER_BASE}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ ticker, date })
  });
  if (!res.ok) {
    const textBody = await res.text().catch(()=> "");
    throw new Error(`Analyzer ${res.status} ${res.statusText || ''}: ${textBody.slice(0,200)}`);
  }
  const j = await res.json().catch(()=> ({}));
  const rating = normalizeDecision(
    j?.analysis?.action?.rating || j?.analysis?.rating || j?.analysis?.action || j?.analysis
  );
  const rawTarget = Number(j?.analysis?.action?.target_price ?? j?.analysis?.target_price);
  const target = Number.isFinite(rawTarget) ? rawTarget : null;
  const usage = j?.llm_usage || j?.analysis?.__usage || null;
  if (usage) applyUsage(runCtx, usage);
  const payload = { rating, target, usage };
  decisionCache.set(key, payload);
  return payload;
}

// ---- API ----

app.get("/api/meta", async (_req, res) => {
  try {
    const rows = await getSP500();
    const sectors = Array.from(new Set(rows.map(r=>r.sector).filter(Boolean))).sort();
    res.json({ sectors, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/run-test", async (req, res) => {
  if (activeRun && !activeRun.finishedAt) {
    return res.status(429).json({ error: "已有測試在執行，請先停止或等待完成" });
  }
  const runCtx = createRunContext();
  activeRun = runCtx;
  const finalize = () => {
    runCtx.finishedAt = Date.now();
    if (activeRun === runCtx) activeRun = null;
  };
  req.on("aborted", () => {
    if (!runCtx.finishedAt) runCtx.cancelled = true;
  });

  try {
    const {
      startDate, endDate,
      interval = "month",
      selector = {
        type: "return", // return | mcap_latest | mcap_asof | manual
        from: "", to: "", asOf: "", topN: 50, sectors: [], tickers: ""
      }
    } = req.body || {};

    if (!startDate || !endDate) {
      finalize();
      return res.status(400).json({ error: "startDate / endDate 必填" });
    }
    const boundaries = buildDates(startDate, endDate, interval);
    if (boundaries.length < 2) {
      finalize();
      return res.status(400).json({ error: "至少需要兩個邊界（開始 + 下一期）" });
    }

    assertNotCancelled(runCtx);

    // 1) 取得 S&P500 清單並依 sector 過濾（若 selector.type=manual 則略過）
    let spx = await getSP500();
    if (Array.isArray(selector.sectors) && selector.sectors.length) {
      const allow = new Set(selector.sectors);
      spx = spx.filter(r => allow.has(r.sector));
    }
    let universe = spx.map(r => r.symbol);

    // 2) 選股
    let chosen = [];
    const topN = Math.max(1, Math.min(Number(selector.topN || 50), 500));
    if (selector.type === "manual") {
      chosen = String(selector.tickers||"")
        .split(/[ ,\n\t]+/)
        .map(s=>s.toUpperCase().trim()).filter(Boolean);
    } else if (selector.type === "return") {
      const from = selector.from || startDate;
      const to = selector.to || endDate;
      const ranked = await rankByReturn(universe, from, to, runCtx);
      chosen = ranked.slice(0, topN).map(x=>x.symbol);
    } else if (selector.type === "mcap_latest") {
      const ranked = await rankByMarketCapLatest(universe, runCtx);
      chosen = ranked.slice(0, topN).map(x=>x.symbol);
    } else if (selector.type === "mcap_asof") {
      const asOf = selector.asOf || endDate;
      const ranked = await rankByMarketCapAsOf(universe, asOf, runCtx);
      chosen = ranked.slice(0, topN).map(x=>x.symbol);
    } else {
      finalize();
      return res.status(400).json({ error: "未知的 selector.type" });
    }

    assertNotCancelled(runCtx);

    // 3) 一次抓所有待測股票的全區間日線
    const closeMap = await getDailyMapForTickers(chosen, runCtx);
    assertNotCancelled(runCtx);
    const pairs = boundaries.slice(0,-1).map((d,i)=> [d, boundaries[i+1]]);

    // 4) 逐期計算：每個起始日叫一次 analyzer 拿 BUY/SELL/HOLD，價格用 FMP（stable）
    const details = [];
    const summaryRows = [];
    let allActionable = 0, allHits = 0, allBuy = 0, allBuyHits = 0, allSell = 0, allSellHits = 0;

    for (const sym of chosen) {
      assertNotCancelled(runCtx);
      const series = closeMap[sym] || [];
      let actionable=0, hits=0, buy=0, buyHits=0, sell=0, sellHits=0;

      for (const [d0, d1] of pairs) {
        assertNotCancelled(runCtx);
        const decision = await getDecision(sym, d0, runCtx);
        const rating = decision?.rating || "UNKNOWN";
        const targetPrice = Number.isFinite(decision?.target) ? decision.target : null;
        const p0 = closeOnOrBefore(series, d0);
        const p1 = closeOnOrBefore(series, d1);
        const hasPrices = Number.isFinite(p0) && Number.isFinite(p1);

        if (rating === "BUY") {
          actionable++; buy++;
          const hit = hasPrices && p1 > p0; if (hit) { hits++; buyHits++; }
          details.push({ ticker: sym, date: d0, nextDate: d1, rating, targetPrice, p0, p1, hit: hit ? "HIT":"MISS" });
        } else if (rating === "SELL") {
          actionable++; sell++;
          const hit = hasPrices && p1 < p0; if (hit) { hits++; sellHits++; }
          details.push({ ticker: sym, date: d0, nextDate: d1, rating, targetPrice, p0, p1, hit: hit ? "HIT":"MISS" });
        } else {
          details.push({ ticker: sym, date: d0, nextDate: d1, rating, targetPrice, p0, p1, hit: "" });
        }
      }

      allActionable += actionable; allHits += hits;
      allBuy += buy; allBuyHits += buyHits;
      allSell += sell; allSellHits += sellHits;

      summaryRows.push({
        ticker: sym,
        actionable, hits, hitRate: actionable ? hits/actionable : null,
        buy, buyHits, buyHitRate: buy ? buyHits/buy : null,
        sell, sellHits, sellHitRate: sell ? sellHits/sell : null
      });
    }

    const overall = {
      actionable: allActionable, hits: allHits, hitRate: allActionable ? allHits/allActionable : null,
      buy: allBuy, buyHits: allBuyHits, buyHitRate: allBuy ? allBuyHits/allBuy : null,
      sell: allSell, sellHits: allSellHits, sellHitRate: allSell ? allSellHits/allSell : null
    };

    // 5) 產 Excel
    const wb = XLSX.utils.book_new();
    const sumAoA = [["Ticker","Actionable","Hits","Hit Rate","Buy","Buy Hits","Buy Hit Rate","Sell","Sell Hits","Sell Hit Rate"]];
    for (const r of summaryRows) {
      sumAoA.push([
        r.ticker, r.actionable, r.hits,
        r.hitRate!=null ? (r.hitRate*100).toFixed(2)+"%" : "",
        r.buy, r.buyHits,
        r.buyHitRate!=null ? (r.buyHitRate*100).toFixed(2)+"%" : "",
        r.sell, r.sellHits,
        r.sellHitRate!=null ? (r.sellHitRate*100).toFixed(2)+"%" : ""
      ]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sumAoA), "Summary");

    const detAoA = [["Ticker","Date","Next Date","Rating","Target Price","Price@Date","Price@Next","Hit"]];
    for (const d of details) {
      detAoA.push([d.ticker, d.date, d.nextDate, d.rating, d.targetPrice ?? "", d.p0, d.p1, d.hit]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detAoA), "Details");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    const fileId = uuidv4();
    _mem.set(fileId, buf);

    const payload = {
      selector, boundaries, chosen, overall, summary: summaryRows,
      downloadUrl: `/api/download/${fileId}`,
      tokenUsage: summarizeTokenUsage(runCtx)
    };
    finalize();
    res.json(payload);
  } catch (e) {
    const usage = summarizeTokenUsage(runCtx);
    finalize();
    if (e?.code === "RUN_CANCELLED") {
      return res.status(409).json({ error: "執行已被停止", cancelled: true, tokenUsage: usage });
    }
    console.error(e);
    res.status(500).json({ error: String(e?.message || e), tokenUsage: usage });
  }
});

app.post("/api/run-test/stop", (_req, res) => {
  const runId = activeRun?.id || null;
  const cancelled = cancelActiveRun();
  res.json({ ok: true, cancelled, runId });
});

const _mem = new Map();
app.get("/api/download/:id", (req,res)=>{
  const buf = _mem.get(req.params.id);
  if (!buf) return res.status(404).send("Not Found");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="sp500-hit-results-${req.params.id}.xlsx"`);
  res.send(buf);
});

app.listen(PORT, () => {
  console.log(`▶ Tester (stable-only) on http://localhost:${PORT}`);
  console.log(`ANALYZER_BASE=${ANALYZER_BASE}`);
});
