import fetch from 'node-fetch';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
(async()=>{
  const res = await fetch(`${BASE}/api/analyze`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ticker:'NVDA', date:'2025-11-08'})
  });
  const j = await res.json();
  console.log(JSON.stringify(j,null,2));
  if(j.error){ console.error('❌', j.error); process.exit(1); }
  if(!j.analysis) { console.error('⚠️ LLM 無輸出'); process.exit(1); }
  console.log('✅ 自我測試完成');
})();
