import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const TARGET_DIRS = [
  path.join(ROOT, 'cache'),
  path.join(ROOT, 'data'),
  path.join(ROOT, 'analysis')
];

async function emptyDirectory(dir){
  try{
    const stats = await fs.stat(dir);
    if(!stats.isDirectory()) return;
  }catch(err){
    if(err.code === 'ENOENT') return;
    throw err;
  }

  const entries = await fs.readdir(dir);
  await Promise.all(entries.map(entry=>{
    const fullPath = path.join(dir, entry);
    return fs.rm(fullPath, { recursive:true, force:true });
  }));
}

async function main(){
  for(const dir of TARGET_DIRS){
    await emptyDirectory(dir);
  }
  console.log('[cleanData] cache/data directories wiped');
}

main().catch(err=>{
  console.error('[cleanData] failed:', err);
  process.exitCode = 1;
});
