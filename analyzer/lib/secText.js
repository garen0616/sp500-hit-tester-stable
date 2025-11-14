import axios from 'axios';
import TurndownService from 'turndown';
import { getCache, setCache } from './cache.js';

const MDA_RETRY_ATTEMPTS = Number(process.env.SEC_MDA_RETRY_ATTEMPTS || 2);
const MDA_RETRY_DELAY_MS = Number(process.env.SEC_MDA_RETRY_DELAY_MS || 2000);

function sleep(ms){ return new Promise(resolve=>setTimeout(resolve, ms)); }

export async function fetchMDA(url, userAgent){
  const key = `sec_mda_${encodeURIComponent(url)}`;
  const cached = await getCache(key);
  if(cached) return cached;
  let lastErr;
  for(let attempt=1; attempt<=MDA_RETRY_ATTEMPTS; attempt++){
    try{
      const { data: html } = await axios.get(url,{ headers:{'User-Agent': userAgent}, timeout:30000 });
      const tds = new TurndownService();
      const lower = html.toLowerCase();
      const idx = lower.indexOf("management’s discussion and analysis")>=0
        ? lower.indexOf("management’s discussion and analysis")
        : lower.indexOf("management's discussion and analysis");
      const slice = idx>0 ? html.slice(idx, idx+15000) : html.slice(0,15000);
      const md = tds.turndown(slice).replace(/\s+\n/g,'\n').trim();
      await setCache(key, md);
      return md;
    }catch(err){
      lastErr = err;
      if(attempt < MDA_RETRY_ATTEMPTS){
        await sleep(MDA_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw new Error(`[SEC] fetchMDA failed: ${lastErr?.message || 'unknown error'}`);
}
