import axios from 'axios';
import TurndownService from 'turndown';
import { getCache, setCache } from './cache.js';

export async function fetchMDA(url, userAgent){
  const key = `sec_mda_${encodeURIComponent(url)}`;
  const c = await getCache(key);
  if(c) return c;
  try{
    const {data:html} = await axios.get(url,{ headers:{'User-Agent': userAgent}, timeout:30000 });
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
    throw new Error(`[SEC] fetchMDA failed: ${err.message}`);
  }
}
