import fetch from 'node-fetch';
import dayjs from 'dayjs';
import fs from 'fs';

const API_BASE = process.env.BACKTEST_API || 'http://localhost:3000';
const FMP_KEY = process.env.FMP_API_KEY || process.env.FMP_KEY || 'TDc1M5BjkEmnB57iOmmfvi8QdBdRLYFA';
const OUTPUT_DIR = process.env.BACKTEST_OUTPUT_DIR || 'output';
const OUTPUT_JSON = `${OUTPUT_DIR}/backtest.json`;
const OUTPUT_CSV = `${OUTPUT_DIR}/backtest.csv`;
const MAX_ACTUAL_LOOKAHEAD_DAYS = Number(process.env.BACKTEST_ACTUAL_LOOKAHEAD_DAYS || 7);
const BASELINE_START = process.env.BACKTEST_START_DATE || '2024-01-01';
const BASELINE_END = process.env.BACKTEST_END_DATE || '2025-11-01';
const TICKERS = (process.env.BACKTEST_TICKERS || 'NVDA,AAPL,MSFT,AMZN,GOOGL').split(',').map(s=>s.trim()).filter(Boolean);

function* generateMonthlyDates(startStr, endStr){
  let cursor = dayjs(startStr);
  const end = dayjs(endStr);
  while(!cursor.isAfter(end)){
    yield cursor.format('YYYY-MM-DD');
    cursor = cursor.add(1,'month');
  }
}

function classifyRating(rating){
  if(!rating) return null;
  const text = rating.toString().toLowerCase();
  if(/(buy|long|outperform|overweight|accumulate|增持|買)/.test(text)) return 'bullish';
  if(/(sell|short|underperform|reduce|減持|賣)/.test(text)) return 'bearish';
  if(/(hold|neutral|market perform|equal weight|觀望|持有)/.test(text)) return 'neutral';
  return null;
}

function resolveBandPct(action, segment){
  const band = action?.target_band || {};
  const candidates = [
    Number(band.band_pct),
    Math.abs(Number(band.upper_pct)),
    Math.abs(Number(band.lower_pct))
  ].filter(val=>Number.isFinite(val) && val>0);
  if(candidates.length) return Math.max(...candidates);
  if((segment || '').toLowerCase() === 'small_cap') return 0.07;
  return 0.05;
}

async function callApi(path, payload){
  const res = await fetch(`${API_BASE}${path}`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if(!res.ok){
    const text = await res.text();
    throw new Error(`${path} ${res.status} ${text}`);
  }
  return res.json();
}

async function fetchActualPrice(symbol, targetDate){
  let cursor = dayjs(targetDate);
  for(let attempt=0; attempt<=MAX_ACTUAL_LOOKAHEAD_DAYS; attempt++){
    const queryDate = cursor.format('YYYY-MM-DD');
    const url = new URL('https://financialmodelingprep.com/stable/historical-price-eod/light');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('from', queryDate);
    url.searchParams.set('to', queryDate);
    url.searchParams.set('apikey', FMP_KEY);
    try{
      const res = await fetch(url);
      if(!res.ok){
        throw new Error(String(res.status));
      }
      const data = await res.json();
      const rows = Array.isArray(data?.historical) ? data.historical : Array.isArray(data) ? data : [];
      if(rows.length){
        const match = rows.find(r=>r.date===queryDate) || rows[0];
        const price = match?.close ?? match?.price ?? match?.open;
        if(Number.isFinite(price)) return { price, asOf: queryDate };
      }
    }catch(err){
      console.warn('[fetchActualPrice]', symbol, queryDate, err.message);
    }
    cursor = cursor.add(1,'day');
  }
  return { price: null, asOf: null };
}

async function fetchMonthlyRange(symbol, baselineDate){
  const monthStart = dayjs(baselineDate).add(1,'month').startOf('month');
  const monthEnd = monthStart.endOf('month');
  const url = new URL('https://financialmodelingprep.com/stable/historical-price-eod/light');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('from', monthStart.format('YYYY-MM-DD'));
  url.searchParams.set('to', monthEnd.format('YYYY-MM-DD'));
  url.searchParams.set('apikey', FMP_KEY);
  try{
    const res = await fetch(url);
    if(!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const rows = Array.isArray(data?.historical) ? data.historical : Array.isArray(data) ? data : [];
    let monthHigh = null;
    let monthLow = null;
    rows.forEach(row=>{
      const high = Number(row.high ?? row.close ?? row.price);
      const low = Number(row.low ?? row.close ?? row.price);
      if(Number.isFinite(high)) monthHigh = monthHigh==null ? high : Math.max(monthHigh, high);
      if(Number.isFinite(low)) monthLow = monthLow==null ? low : Math.min(monthLow, low);
    });
    const rangeMid = (monthHigh!=null && monthLow!=null) ? (monthHigh + monthLow) / 2 : null;
    return { monthHigh, monthLow, rangeMid };
  }catch(err){
    console.warn('[fetchMonthlyRange]', symbol, baselineDate, err.message);
    return { monthHigh:null, monthLow:null, rangeMid:null };
  }
}

function appendRow(rows, row){
  rows.push(row);
  fs.mkdirSync(OUTPUT_DIR,{recursive:true});
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(rows,null,2));
}

function exportCsv(rows){
  const header = 'ticker,baselineDate,nextDate,rating,target,actual,actual_date,delta_pct,baseline_price,month_high,month_low,range_mid,close_hit,range_mid_hit,intramonth_hit,hold_accuracy,hold_band_pct,hold_drift_flag\n';
  const data = rows.map(r=>[
    r.ticker,
    r.baselineDate,
    r.nextDate,
    r.rating || '',
    r.target ?? '',
    r.actual ?? '',
    r.actualDate || '',
    r.delta!=null ? r.delta.toFixed(2) : '',
    r.baselinePrice ?? '',
    r.monthHigh ?? '',
    r.monthLow ?? '',
    r.rangeMid ?? '',
    r.closeHit ?? '',
    r.rangeMidHit ?? '',
    r.intramonthHit ?? '',
    r.holdAccuracy ?? '',
    r.holdBandPct ?? '',
    r.holdDriftFlag ?? ''
  ].join(','));
  fs.writeFileSync(OUTPUT_CSV, header + data.join('\n'));
}

async function main(){
  let rows = [];
  if(fs.existsSync(OUTPUT_JSON)){
    try{ rows = JSON.parse(fs.readFileSync(OUTPUT_JSON,'utf8')); }
    catch{ rows = []; }
  }
  const processed = new Set(rows.map(r=>`${r.ticker}_${r.baselineDate}`));

  const baselineDates = Array.from(generateMonthlyDates(BASELINE_START, BASELINE_END));
  for(const ticker of TICKERS){
    for(const baselineDate of baselineDates){
      const key = `${ticker}_${baselineDate}`;
      if(processed.has(key)) continue;
      try{
        await callApi('/api/reset-cache',{ ticker, date: baselineDate });
        const analysis = await callApi('/api/analyze',{ ticker, date: baselineDate });
        const action = analysis?.analysis?.action || {};
        const target = Number(action.target_price) ?? null;
        const rating = action.rating || null;
        const profile = analysis?.analysis?.profile || {};
        const baselinePrice = Number(analysis?.inputs?.price?.value ?? analysis?.fetched?.finnhub_summary?.quote?.c ?? null);
        const direction = classifyRating(rating);
        const bandPct = resolveBandPct(action, profile.segment);
        const nextDate = dayjs(baselineDate).add(1,'month').format('YYYY-MM-DD');
        const [{ price: actual, asOf: actualDate }, rangeStats] = await Promise.all([
          fetchActualPrice(ticker, nextDate),
          fetchMonthlyRange(ticker, baselineDate)
        ]);
        const delta = (actual!=null && target!=null)
          ? ((actual - target) / target) * 100
          : null;
        const monthHigh = rangeStats.monthHigh!=null ? Number(rangeStats.monthHigh.toFixed(2)) : null;
        const monthLow = rangeStats.monthLow!=null ? Number(rangeStats.monthLow.toFixed(2)) : null;
        const rangeMid = rangeStats.rangeMid!=null ? Number(rangeStats.rangeMid.toFixed(2)) : null;
        const closeHit = (()=>{
          if(actual==null || baselinePrice==null) return null;
          if(direction === 'bullish') return actual >= baselinePrice;
          if(direction === 'bearish') return actual <= baselinePrice;
          if(direction === 'neutral' && Number.isFinite(bandPct)){
            return Math.abs((actual - baselinePrice) / baselinePrice) <= bandPct;
          }
          return null;
        })();
        const rangeMidHit = (()=>{
          if(rangeMid==null || baselinePrice==null) return null;
          if(direction === 'bullish') return rangeMid >= baselinePrice;
          if(direction === 'bearish') return rangeMid <= baselinePrice;
          if(direction === 'neutral' && Number.isFinite(bandPct)){
            return Math.abs((rangeMid - baselinePrice) / baselinePrice) <= bandPct;
          }
          return null;
        })();
        const intramonthHit = (()=>{
          if(target==null) return null;
          if(direction === 'bullish'){
            return monthHigh!=null ? monthHigh >= target : null;
          }
          if(direction === 'bearish'){
            return monthLow!=null ? monthLow <= target : null;
          }
          return null;
        })();
        const holdAccuracy = direction === 'neutral' ? closeHit : null;
        const holdDriftFlag = direction === 'neutral' && actual!=null && baselinePrice!=null
          ? Math.abs((actual - baselinePrice) / baselinePrice) > 0.10
          : false;
        const row = {
          ticker,
          baselineDate,
          nextDate,
          rating,
          target,
          actual,
          actualDate,
          delta,
          rationale: action.rationale || '',
          baselinePrice,
          monthHigh,
          monthLow,
          rangeMid,
          closeHit,
          rangeMidHit,
          intramonthHit,
          holdAccuracy,
          holdBandPct: Number.isFinite(bandPct) ? bandPct : null,
          holdDriftFlag
        };
        appendRow(rows, row);
        processed.add(key);
        console.log('[backtest] stored', ticker, baselineDate, 'target', target, 'actual', actual, '@', actualDate);
        await new Promise(r=>setTimeout(r, 200));
      }catch(err){
        console.warn('[backtest] failed', ticker, baselineDate, err.message);
      }
    }
  }
  exportCsv(rows);
  console.log('Backtest completed. Rows:', rows.length);
}

main();
