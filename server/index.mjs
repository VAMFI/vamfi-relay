import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, join, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, id, timestamp, active } from './store.mjs';
import { Runtime, problem } from './runtime.mjs';
import { CodexAdapter } from './adapters/codex.mjs';
import { codexCommand } from './codex-command.mjs';
import { validateRequest, redact } from './security.mjs';
import { previewSkill } from './skills.mjs';
import { demoSnapshot } from './demo.mjs';
import { serviceIdentity } from './service.mjs';
import { CodexCatalog } from './catalog.mjs';
import { HandoffService } from './handoff.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};
export async function createApp(options={}) {
  const workspace=options.workspace || process.env.RELAY_WORKSPACE || join(root,'workspace');
  const dataDir=options.dataDir || process.env.RELAY_DATA_DIR || join(homedir(),'.local','state','vamfi-relay');
  const store=new Store(dataDir,workspace);
  let adapter;
  try{adapter=options.adapter || new CodexAdapter({cwd:root,command:await codexCommand()});}catch(error){store.close();throw error;}
  const runtime=new Runtime(store,adapter);
  // Discovery owns a separate process: a stalled history read cannot terminate executing work.
  const catalog=options.catalog || new CodexCatalog({store,adapter:options.catalogAdapter || new CodexAdapter({cwd:root,command:await codexCommand()}),codexHome:options.codexHome});
  runtime.catalog=catalog;
  const handoff=new HandoffService({catalog,runtime});
  const identity=serviceIdentity(dataDir);
  const clients=new Set();
  let streamTimer;
  const broadcast=()=>{
    streamTimer=undefined; const message=`event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`;
    for(const client of clients)if(!client.destroyed)client.write(message);
  };
  store.onChange=()=>{if(!streamTimer)streamTimer=setTimeout(broadcast,80);};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control','no-store');
    const json=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(redact(body)));};
    try {
      validateRequest(req,server.address().port);
      const url=new URL(req.url,'http://127.0.0.1');
      if(req.method==='GET' && url.pathname==='/api/state')return json(200,store.snapshot());
      if(req.method==='GET' && url.pathname==='/api/codex/catalog')return json(200,await catalog.list({query:url.searchParams.get('query') || '',projectKey:url.searchParams.get('projectKey') || '',archived:url.searchParams.get('archived')==='true'}));
      if(req.method==='GET' && url.pathname==='/api/codex/memory')return json(200,await catalog.memory());
      const sourceChat=url.pathname.match(/^\/api\/codex\/threads\/([\w-]+)$/);
      if(req.method==='GET' && sourceChat)return json(200,await catalog.detail(sourceChat[1]));
      if(req.method==='GET' && url.pathname==='/api/demo')return json(200,demoSnapshot());
      if(req.method==='GET' && url.pathname==='/api/health')return json(200,{ok:true,version:store.state.meta.version,...identity,stopping:runtime.closing,activeTasks:store.state.tasks.filter(active).length});
      if(req.method==='GET' && url.pathname==='/api/events') {
        if(clients.size>=20)throw problem(429,'Too many open dashboard connections.');
        res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});
        res.write(`event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`);clients.add(res);
        const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),20000);
        req.on('close',()=>{clearInterval(heartbeat);clients.delete(res);});return;
      }
      if(req.method==='GET' && url.pathname==='/api/export') {
        const date=url.searchParams.get('date');
        const parsed=new Date(`${date}T00:00:00Z`);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==date)throw problem(400,'Choose a valid date in YYYY-MM-DD format.');
        const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:store.state.meta.timezone,year:'numeric',month:'2-digit',day:'2-digit'});
        const onDay=iso=>typeof iso==='string' && Number.isFinite(Date.parse(iso)) && formatter.format(new Date(iso))===date;
        const events=store.state.events.filter(e=>onDay(e.createdAt));
        const ids=new Set([...events,...store.state.messages.filter(m=>onDay(m.createdAt))].map(record=>record.taskId).filter(Boolean));
        for(const task of store.state.tasks)if([task.createdAt,task.startedAt,task.completedAt].some(onDay))ids.add(task.id);
        // Include the original request for cross-day outcomes without following cycles.
        const byId=new Map(store.state.tasks.map(task=>[task.id,task]));
        for(const taskId of ids){const parent=byId.get(taskId)?.parentTaskId;if(parent && byId.has(parent))ids.add(parent);}
        const tasks=store.state.tasks.filter(task=>ids.has(task.id));
        const report={product:'Vamfi Relay',date,timezone:store.state.meta.timezone,exportedAt:timestamp(),projects:store.state.projects,workItems:store.state.workItems,tasks,messages:store.state.messages.filter(m=>ids.has(m.taskId)),events};
        res.setHeader('Content-Disposition',`attachment; filename="relay-${date}.json"`);return json(200,report);
      }
      if(req.method==='POST') {
        if(!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))throw problem(415,'Use application/json.');
        const chunks=[];let bytes=0;
        for await(const part of req){bytes+=part.length;if(bytes>131072)throw problem(413,'Request body is too large.');chunks.push(part);}
        const raw=Buffer.concat(chunks).toString('utf8');
        let body;try{body=JSON.parse(raw || '{}');}catch{throw problem(400,'Invalid JSON.');}
        if(!body || Array.isArray(body) || typeof body!=='object')throw problem(400,'Expected a JSON object.');
        if(url.pathname==='/api/service/stop') {
          if(typeof options.onShutdown!=='function')throw problem(409,'Shutdown is managed by the application that started this service.');
          if(body.instanceId!==identity.instanceId)throw problem(409,'The service instance changed. Refresh status before stopping it.');
          if(body.stopRunning!==undefined && typeof body.stopRunning!=='boolean')throw problem(400,'stopRunning must be a boolean.');
          if(store.state.tasks.some(active) && body.stopRunning!==true)throw problem(409,'Unfinished work exists. Use stop --stop-running to interrupt execution and hold the queue.');
          runtime.closing=true;
          res.once('finish',()=>setImmediate(options.onShutdown));
          return json(202,{stopping:true,instanceId:identity.instanceId});
        }
        if(url.pathname==='/api/connect'){await runtime.connect();return json(200,store.snapshot());}
        if(url.pathname==='/api/codex/refresh') {
          if(Object.keys(body).some(key=>!['loadMore','archived'].includes(key)) || ['loadMore','archived'].some(key=>key in body && typeof body[key]!=='boolean'))throw problem(400,'Supply boolean catalog refresh options.');
          return json(200,await catalog.list({refresh:body.loadMore!==true,loadMore:body.loadMore===true,archived:body.archived===true}));
        }
        if(url.pathname==='/api/codex/handoff')return json(202,await handoff.continue(body));
        if(url.pathname==='/api/settings'){await runtime.settings(body);return json(200,store.snapshot());}
        if(url.pathname==='/api/chat')return json(202,await runtime.chat(body.text,body.skillIds));
        if(url.pathname==='/api/projects')return json(201,await runtime.board.registerProject(body));
        const project=url.pathname.match(/^\/api\/projects\/([\w-]+)$/);
        if(project)return json(200,runtime.updateProject(project[1],body));
        if(url.pathname==='/api/work')return json(201,runtime.board.createWork(body));
        const workRun=url.pathname.match(/^\/api\/work\/([\w-]+)\/run$/);
        if(workRun)return json(202,runtime.startProject(workRun[1],body.instructions));
        const planStart=url.pathname.match(/^\/api\/work\/([\w-]+)\/plan\/start$/);
        if(planStart)return json(202,runtime.startPlan(planStart[1],body));
        const plan=url.pathname.match(/^\/api\/work\/([\w-]+)\/plan$/);
        if(plan)return json(200,runtime.board.setPlan(plan[1],body));
        const resume=url.pathname.match(/^\/api\/work\/([\w-]+)\/resume$/);
        if(resume)return json(202,runtime.resumeWork(resume[1],body));
        const notes=url.pathname.match(/^\/api\/work\/([\w-]+)\/notes$/);
        if(notes)return json(201,runtime.board.addNote(notes[1],body));
        const work=url.pathname.match(/^\/api\/work\/([\w-]+)$/);
        if(work)return json(200,await runtime.updateWork(work[1],body));
        const cancel=url.pathname.match(/^\/api\/tasks\/([\w-]+)\/cancel$/);
        if(cancel){await runtime.cancel(cancel[1]);return json(200,store.snapshot());}
        const approval=url.pathname.match(/^\/api\/approvals\/([\w-]+)$/);
        if(approval){await runtime.approve(approval[1],body.decision);return json(200,store.snapshot());}
        if(url.pathname==='/api/skills/preview')return json(200,previewSkill(body.content));
        if(url.pathname==='/api/skills') {
          const preview=previewSkill(body.content);
          if(body.reviewed!==true || preview.hash!==body.hash)throw problem(400,'Review this exact document before importing it.');
          if(preview.blocked)throw problem(400,'This document contains blocked content. Remove it before importing.');
          if(store.state.skills.some(s=>s.name===preview.name))throw problem(409,'A skill with this name already exists.');
          const skill={id:id(),...preview,enabled:false,createdAt:timestamp()};
          store.change(s=>{s.skills.push(skill);store.event('skill','Skill reviewed and saved',skill.name);});return json(201,skill);
        }
        const skillPath=url.pathname.match(/^\/api\/skills\/([\w-]+)$/);
        if(skillPath) {
          if(typeof body.enabled!=='boolean')throw problem(400,'enabled must be a boolean.');
          const skill=store.state.skills.find(s=>s.id===skillPath[1]);if(!skill)throw problem(404,'Skill not found.');
          store.change(s=>{s.skills.find(x=>x.id===skill.id).enabled=body.enabled;store.event('skill',`Skill ${body.enabled?'enabled':'disabled'}`,skill.name);});return json(200,store.snapshot());
        }
        throw problem(404,'Endpoint not found.');
      }
      if(url.pathname.startsWith('/api/'))throw problem(404,'Endpoint not found.');
      if(req.method!=='GET' && req.method!=='HEAD')throw problem(405,'Method not allowed.');
      const dist=join(root,'dist');let target=resolve(dist,'.'+decodeURIComponent(url.pathname));
      if(target!==dist && !target.startsWith(dist+sep))throw problem(403,'Path not allowed.');
      if(target===dist || !(await stat(target).catch(()=>null))?.isFile())target=join(dist,'index.html');
      if(!types[extname(target)])throw problem(404,'File not found.');
      const content=await readFile(target).catch(()=>null);
      if(!content)throw problem(503,'Build the interface with npm run build, then reload.');
      res.writeHead(200,{'Content-Type':types[extname(target)]});res.end(req.method==='HEAD'?undefined:content);
    } catch(e) { if(!res.headersSent)json(e.statusCode || 500,{error:e.statusCode?e.message:'The local service could not complete the request. Check the connection and retry.'});else res.end(); }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  let closing;
  const close=()=>closing ||= (async()=>{
    clearTimeout(streamTimer);store.onChange=null;for(const client of clients)client.end();
    // Keep the service and writer lock when provider exit cannot be confirmed.
    // A second instance must not start while old execution may still be alive.
    await runtime.close();
    await catalog.close();
    try{await new Promise(resolve=>server.close(resolve));}finally{store.close();}
  })().catch(error=>{closing=null;throw error;});
  return {server,store,runtime,catalog,close};
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const port=Number(process.env.RELAY_PORT || 4318);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('RELAY_PORT must be 1024–65535.');
  const app=await createApp({onShutdown:()=>stop()});
  app.server.listen(port,'127.0.0.1',()=>console.log(`Vamfi Relay: http://127.0.0.1:${port}`));
  app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'Port is in use. Choose another RELAY_PORT.':'Could not start the local server.');process.exitCode=1;app.close().catch(()=>{console.error('The local service could not close cleanly. Inspect state before restarting.');});});
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;try{await app.close();process.exit(0);}catch{stopping=false;console.error('Shutdown was not confirmed. The service retains its state lock; inspect it before retrying stop.');process.exitCode=1;}};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
