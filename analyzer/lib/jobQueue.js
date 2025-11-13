const queue = [];
let processing = false;

async function processQueue(){
  if(processing) return;
  processing = true;
  while(queue.length){
    const job = queue.shift();
    try{
      const result = await job.fn();
      job.resolve(result);
    }catch(err){
      job.reject(err);
    }
  }
  processing = false;
}

export function enqueueJob(fn){
  if(typeof fn !== 'function') return Promise.reject(new Error('Job must be a function'));
  return new Promise((resolve,reject)=>{
    queue.push({ fn, resolve, reject });
    processQueue();
  });
}
