import { readFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const scenario = JSON.parse(readFileSync('scenario.json','utf8'));
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const notice = (method, params) => send({method:'notification',params:{method,params}});
let sequence=0; const sessions=new Map();
createInterface({input:process.stdin}).on('line',line=>{
  const call=JSON.parse(line); appendFileSync('wire.jsonl',line+'\n');
  const {id,method,params:p}=call;
  const reply=result=>send({id,result});
  if(method==='connect') return reply({version:scenario.version || '0.23.0',qualified:scenario.qualified!==false});
  if(method==='thread/start' || method==='thread/resume') {
    if(scenario.openTimeout)return;
    const sid=p.id || `hermes:local-${++sequence}`; sessions.set(sid,p);
    return reply({id:sid,workspace:scenario.scopeMismatch?'/wrong':p.workspace,permissionMode:'read-only',qualified:true});
  }
  if(method==='turn/start') {
    const turnId=`admission-${p.runId}`, common={threadId:p.threadId,runId:p.runId,turnId};
    if(scenario.malformed)return process.stdout.write('invalid private token\n');
    if(scenario.oversize)return process.stdout.write('x'.repeat(1024*1024+1));
    if(scenario.exit)return process.exit(0);
    if(!scenario.lostAck)reply({id:turnId});
    notice('turn/started',{...common,turn:{id:turnId}});
    if(scenario.pending || scenario.lostAck)return;
    notice('item/agentMessage/delta',{...common,delta:'Verified '});
    notice('item/completed',{...common,item:{type:'agentMessage',text:'Verified result'}});
    notice('turn/completed',{...common,turn:{id:turnId,status:'completed'}});
    notice('turn/completed',{...common,turn:{id:turnId,status:'completed'}});
    return;
  }
  if(method==='turn/recover')return reply({threadId:p.threadId,runId:p.runId,turnId:p.turnId || `admission-${p.runId}`,state:scenario.recovery || 'completed',result:'Recovered result'});
  if(method==='turn/interrupt'){
    if(scenario.finishDuringCancel){
      notice('turn/completed',{threadId:p.threadId,runId:p.runId,turn:{id:p.turnId,status:'completed'}});
      return send({id,error:{uncertain:false}});
    }
    return reply({turnId:p.turnId,state:scenario.cancelUnknown?'unknown':'interrupted'});
  }
  if(method==='close'){reply({closed:true});return;}
  send({id,error:{uncertain:false}});
}).on('close',()=>process.exit(0));
