import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STATS_PATH = path.join(DATA_DIR, 'usage_stats.json');
const MAX_HISTORY = 20;

function readStats(){
  try{
    const raw = fs.readFileSync(STATS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.history = Array.isArray(parsed.history) ? parsed.history : [];
    return parsed;
  }catch{
    return { history: [], avgPrompt: 0, lastPrompt: 0 };
  }
}

function writeStats(stats){
  try{
    fs.writeFileSync(STATS_PATH, JSON.stringify(stats));
  }catch(err){
    console.warn('[usageMonitor] write failed', err.message);
  }
}

export function recordUsage(usage){
  if(!usage || !Number.isFinite(usage.prompt_tokens)) return;
  const stats = readStats();
  stats.history.push({
    prompt: usage.prompt_tokens,
    completion: usage.completion_tokens || 0,
    total: usage.total_tokens || (usage.prompt_tokens + (usage.completion_tokens || 0)),
    ts: Date.now()
  });
  stats.history = stats.history.slice(-MAX_HISTORY);
  const sumPrompt = stats.history.reduce((sum,item)=>sum + (item.prompt || 0), 0);
  stats.avgPrompt = stats.history.length ? sumPrompt / stats.history.length : usage.prompt_tokens;
  stats.lastPrompt = usage.prompt_tokens;
  writeStats(stats);
}

export function getAdaptiveLimits({ defaultFilings, defaultNews }){
  const stats = readStats();
  const avg = stats.avgPrompt || 0;
  const last = stats.lastPrompt || 0;
  let maxFilings = defaultFilings;
  let newsLimit = defaultNews;
  if(avg && last > Math.max(avg * 1.5, 8000)){
    maxFilings = Math.max(1, Math.floor(defaultFilings * 0.5));
    newsLimit = Math.max(2, Math.floor(defaultNews * 0.6));
  }
  return { maxFilings, newsLimit };
}
