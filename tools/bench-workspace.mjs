import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, outgoingEdges } from '../src/js/model.js';
const base = JSON.parse(await fs.readFile(new URL('../demo/stress-overview.sfproj', import.meta.url), 'utf8'));
const demo = JSON.parse(await fs.readFile(new URL('../demo/demo-project.json', import.meta.url), 'utf8'));
export function fixture(kind) {
  const project = structuredClone(base);
  if (kind === '1000') {
    for (let i = project.nodes.length; i < 1000; i++) {
      project.nodes.push({...structuredClone(project.nodes[0]), id:'bench_'+i, next:i===999?'':'bench_'+(i+1), position:{x:(i%40)*300,y:Math.floor(i/40)*160}});
    }
  }
  if (kind === 'media') {
    const image = Object.values(demo.media)[0];
    for (let i=0;i<100;i++) { const id='bench_media_'+i; project.media[id]={...image,id};project.nodes[i].media=[id];project.nodes[i].previewId=id; }
  }
  return project;
}
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'sf-bench-'));
try {
  for(const kind of ['201','1000','media']){
    const project=fixture(kind), store=new Store();store.setProject(project);
    const words=['склад','Марк','коридор'];
    const edit=[],save=[],search=[];
    const measure=async(fn,arr)=>{const t=performance.now();await fn();arr.push(performance.now()-t);};
    global.gc?.();const memoryBefore=process.memoryUsage().heapUsed;
    for(let i=0;i<24;i++){
      const n=store.project.nodes[i];
      await measure(()=>store.apply([{op:'updateNode',id:n.id,patch:{title:'Измерение '+i}}]),edit);
      await measure(()=>store.project.nodes.filter(n=>(n.text||'').toLowerCase().includes(words[i%3].toLowerCase())),search);
      await measure(()=>fs.writeFile(path.join(temp,'bench.sfproj'),JSON.stringify(store.project,null,2)),save);
    }
    for(let i=0;i<12;i++)store.undo();
    global.gc?.();
    function median(a){return +a.slice(4).sort((a,b)=>a-b)[10].toFixed(3)}
    console.log(JSON.stringify({kind,nodes:project.nodes.length,edges:project.nodes.reduce((s,n)=>s+outgoingEdges(project,n.id).length,0),bytes:Buffer.byteLength(JSON.stringify(project)),rounds:20,editMs:median(edit),searchMs:median(search),serializeWriteMs:median(save),heapDeltaMB:+((process.memoryUsage().heapUsed-memoryBefore)/1048576).toFixed(2)}));
  }
}finally{await fs.rm(temp,{recursive:true,force:true});}
