export function demoSnapshot() {
  const now=new Date();
  const at=(day,hour,minute=0)=>{const d=new Date(now);d.setDate(d.getDate()-day);d.setHours(hour,minute,0,0);return d.toISOString();};
  const threads=[{id:'sample-main',parentId:null,title:'Main conversation',role:'coordinator',status:'idle',createdAt:at(6,9),updatedAt:at(0,11),workspace:'/projects/atlas'}];
  const tasks=[],messages=[],events=[];
  const requests=[
    ['Review the onboarding experience','I reviewed the onboarding flow. The sign-up form can explain password requirements before submission, and the welcome screen should offer a clear next step.'],
    ['Find why the activity page feels slow','The activity list rerenders every row on filter changes. A memoized row and a stable selector are the next bounded changes to test.'],
    ['Plan the next release with two independent reviews','Both reviewers have returned. The release plan now has a small implementation slice, keyboard QA, and a verified rollback checklist.'],
  ];
  for(let day=6;day>=0;day--){
    const count=day===0?3:(day%3)+1;
    for(let i=0;i<count;i++){
      const [title,result]=requests[i%3],taskId=`sample-task-${day}-${i}`;
      const task={id:taskId,threadId:'sample-main',parentTaskId:null,title,prompt:title,kind:'request',status:'completed',createdAt:at(day,9+i),startedAt:at(day,9+i),completedAt:at(day,9+i,4),result,tokens:1500+(i*420)};
      tasks.push(task);
      messages.push({id:`${taskId}-u`,threadId:'sample-main',taskId,role:'user',text:title,createdAt:task.createdAt,status:'complete'},{id:`${taskId}-a`,threadId:'sample-main',taskId,role:'assistant',text:result,createdAt:task.completedAt,status:'complete',phase:'final_answer'});
      events.push({id:`${taskId}-e`,threadId:'sample-main',taskId,type:'completed',title:'Request completed',detail:result,createdAt:task.completedAt});
    }
  }
  for(const [i,title,result] of [[0,'Accessibility review','Keyboard order is logical. Add an accessible label to the icon-only activity filter.'],[1,'Release readiness','The release checklist needs a database snapshot and a post-release smoke test.']]){
    const threadId=`sample-worker-${i}`,taskId=`sample-worker-task-${i}`;
    threads.push({id:threadId,parentId:'sample-main',title,role:'worker',status:'idle',createdAt:at(0,11,1),updatedAt:at(0,11,3),workspace:'/projects/atlas'});
    tasks.push({id:taskId,threadId,parentTaskId:'sample-task-0-2',title,prompt:title,kind:'worker',status:'completed',createdAt:at(0,11,1),startedAt:at(0,11,1),completedAt:at(0,11,3),result,tokens:820+i*100});
    events.push({id:`${taskId}-e`,threadId,taskId,type:'delegation',title:'Background review completed',detail:title,createdAt:at(0,11,3)});
    messages.push({id:`${taskId}-a`,threadId,taskId,role:'assistant',text:result,status:'complete',createdAt:at(0,11,3)});
  }
  const projects=[
    {id:'sample-atlas',name:'Atlas',workspace:'/projects/atlas',permissionMode:'read-only',threadId:'sample-atlas-thread',createdAt:at(6,9),updatedAt:at(0,11)},
    {id:'sample-fieldnotes',name:'Fieldnotes',workspace:'/projects/fieldnotes',permissionMode:'workspace-write',threadId:'sample-fieldnotes-thread',createdAt:at(5,9),updatedAt:at(0,12)},
  ];
  for(const project of projects) threads.push({id:project.threadId,parentId:null,title:project.name,role:'project',status:'idle',createdAt:project.createdAt,updatedAt:project.updatedAt,workspace:project.workspace});
  const workItems=[
    {id:'sample-goal-onboarding',projectId:'sample-atlas',title:'Make onboarding easier to follow',objective:'Review the first-run experience and establish a clear, accessible path to the first useful action.',nextAction:'Review the proposed welcome-screen copy and keyboard findings.',status:'needs_review',createdAt:at(3,9),updatedAt:at(0,10,18),completedAt:null,evidence:[]},
    {id:'sample-goal-performance',projectId:'sample-atlas',title:'Keep the activity feed responsive',objective:'Identify the cause of slow filtering and agree on a small, measurable improvement.',nextAction:'Compare the row-render trace with the proposed stable selector.',status:'active',createdAt:at(4,9),updatedAt:at(0,10),completedAt:null,evidence:[]},
    {id:'sample-goal-release',projectId:'sample-fieldnotes',title:'Prepare the next release',objective:'Assemble a reviewable release package with current checks and a rollback plan.',nextAction:'Provide the local test fixture that the release check requires.',status:'blocked',createdAt:at(2,9),updatedAt:at(0,11,25),completedAt:null,evidence:[]},
    {id:'sample-goal-docs',projectId:'sample-fieldnotes',title:'Clarify the contributor guide',objective:'Give a new contributor a concise, verified path from checkout to a passing local check.',nextAction:'Inspect the current setup steps and list anything that needs verification.',status:'planned',createdAt:at(1,9),updatedAt:at(0,9),completedAt:null,evidence:[]},
    {id:'sample-goal-done',projectId:'sample-atlas',title:'Document the support handoff',objective:'Record the support route and verified diagnostic steps in one short handoff.',nextAction:'',status:'completed',createdAt:at(5,9),updatedAt:at(0,9,30),completedAt:at(0,9,30),completionNote:'Sample review: the handoff was read and its support route and diagnostic steps were checked.',evidence:[]},
    {id:'sample-goal-paused',projectId:'sample-fieldnotes',title:'Explore a new reading view',objective:'Compare a focused reading layout against the existing document view.',nextAction:'Resume after the release package is reviewed.',status:'paused',createdAt:at(5,11),updatedAt:at(1,11),completedAt:null,evidence:[]},
  ];
  const exampleRuns=[
    ['sample-goal-onboarding',0,10,'completed','The copy and keyboard review is ready for human inspection. No goal has been marked complete.'],
    ['sample-goal-performance',1,14,'completed','The trace isolates repeated row renders. The proposed selector needs a measured comparison before accepting it.'],
    ['sample-goal-release',0,11,'failed','The required local test fixture is missing. Supply it before continuing the release check.'],
    ['sample-goal-done',1,15,'completed','The support handoff document and diagnostic checklist are ready to review.'],
    ['sample-goal-paused',3,13,'completed','Two reading-layout alternatives were outlined; the work is currently paused.'],
  ];
  for(const [workId,day,hour,status,result] of exampleRuns){
    const work=workItems.find(item=>item.id===workId),project=projects.find(item=>item.id===work.projectId),taskId=`${workId}-run`;
    const task={id:taskId,threadId:project.threadId,parentTaskId:null,projectId:project.id,workId,workspace:project.workspace,permissionMode:project.permissionMode,title:work.title,prompt:work.objective,kind:'project',status,createdAt:at(day,hour),startedAt:at(day,hour),completedAt:at(day,hour,18),result:status==='completed'?result:'',...(status==='failed'?{error:result}:{}),tokens:1800};
    tasks.push(task);
    work.evidence.push({taskId,summary:result,status,createdAt:task.completedAt});
    events.push({id:`${taskId}-started`,threadId:task.threadId,taskId,workId,projectId:project.id,type:'project_started',title:'Project run started',detail:work.title,createdAt:task.startedAt},{id:`${taskId}-finished`,threadId:task.threadId,taskId,workId,projectId:project.id,type:status==='failed'?'project_failed':'project_completed',title:status==='failed'?'Project run needs attention':'Project evidence ready',detail:result,createdAt:task.completedAt});
    messages.push({id:`${taskId}-notification`,threadId:'sample-main',taskId,workId,projectId:project.id,channel:'master',source:'project',role:'system',text:`Sample project update · ${project.name}\n${work.title}\n${result}`,createdAt:task.completedAt,status:'complete'});
  }
  for(const work of workItems) Object.assign(work,{notes:[],plan:null,planHistory:[],recoveryRequired:false});
  for (const [index, workId] of ['sample-goal-onboarding','sample-goal-performance','sample-goal-release'].entries()) {
    const work=workItems.find(item=>item.id===workId);
    events.push({id:`sample-request-link-${index}`,type:'work_request',title:'Request linked to goal',taskId:`sample-task-0-${index}`,threadId:'sample-main',workId,projectId:work.projectId,createdAt:at(0,9+index)});
  }
  for (const task of tasks.filter(item=>item.kind==='worker')) {
    Object.assign(task,{workId:'sample-goal-release',projectId:'sample-fieldnotes',workspace:'/projects/fieldnotes',permissionMode:'read-only'});
    Object.assign(threads.find(thread=>thread.id===task.threadId),{projectId:'sample-fieldnotes',workspace:'/projects/fieldnotes',permissionMode:'read-only'});
  }
  const performance=workItems.find(item=>item.id==='sample-goal-performance');
  const profileTask=tasks.find(item=>item.id==='sample-goal-performance-run');
  const profileCheckpoint={state:'ready',summary:'Sample agent report: the render trace is recorded and ready for a bounded comparison. This is not independent verification.',createdAt:profileTask.completedAt,source:'agent_report'};
  Object.assign(profileTask,{planId:'sample-plan-performance',stepId:'sample-perf-profile',checkpoint:profileCheckpoint});
  const queuedTask={id:'sample-perf-queued',threadId:'sample-atlas-thread',parentTaskId:null,projectId:'sample-atlas',workId:performance.id,workspace:'/projects/atlas',permissionMode:'read-only',title:'Compare the proposed selector',prompt:'Inspect the proposed selector and compare its expected behavior with the recorded trace. Report a ready or blocked checkpoint.',kind:'project',status:'queued',queueState:'waiting',queueReason:'Sample queue entry: waiting for a provider connection.',planId:'sample-plan-performance',stepId:'sample-perf-compare',createdAt:at(0,10,5),startedAt:null,completedAt:null,result:''};
  tasks.push(queuedTask);
  performance.plan={id:'sample-plan-performance',status:'running',createdAt:at(2,10),updatedAt:at(0,10,5),approvedAt:at(1,13),approvedPermissionMode:'read-only',autoContinue:true,steps:[
    {id:'sample-perf-profile',title:'Inspect the render trace',instructions:'Inspect the existing trace without changing files. Summarize the repeated work and report a ready or blocked checkpoint.',status:'finished',taskId:profileTask.id,attemptIds:[profileTask.id],checkpoint:profileCheckpoint},
    {id:'sample-perf-compare',title:'Compare the proposed selector',instructions:queuedTask.prompt,status:'queued',taskId:queuedTask.id,attemptIds:[queuedTask.id],checkpoint:null},
  ]};
  performance.planHistory=[{id:'sample-plan-performance-draft-1',status:'draft',createdAt:at(3,10),updatedAt:at(2,10),approvedAt:null,approvedPermissionMode:null,autoContinue:false,steps:[{id:'sample-perf-old',title:'Inspect the activity feed',instructions:'Inspect the feed and propose a bounded profiling plan. Do not edit files.',status:'pending',taskId:null,attemptIds:[],checkpoint:null}]}];
  const paused=workItems.find(item=>item.id==='sample-goal-paused');
  const outlineTask=tasks.find(item=>item.id==='sample-goal-paused-run');
  const outlineCheckpoint={state:'ready',summary:'Sample agent report: two layouts are outlined. A separate accessibility review remains.',createdAt:outlineTask.completedAt,source:'agent_report'};
  Object.assign(outlineTask,{planId:'sample-plan-reading',stepId:'sample-reading-outline',checkpoint:outlineCheckpoint});
  const recoveryCheckpoint={state:'blocked',summary:'Sample recovery record: the service stopped before a terminal provider result was recorded. Inspect the attempt before authorizing a retry.',createdAt:at(1,11),source:'system_recovery'};
  const interruptedTask={id:'sample-reading-interrupted',threadId:'sample-fieldnotes-thread',parentTaskId:null,projectId:'sample-fieldnotes',workId:paused.id,workspace:'/projects/fieldnotes',permissionMode:'workspace-write',title:'Review reading-view accessibility',prompt:'Inspect keyboard navigation and readable spacing for both proposed layouts. Record a ready or blocked checkpoint.',kind:'project',status:'interrupted',queueState:null,planId:'sample-plan-reading',stepId:'sample-reading-review',createdAt:at(1,10),startedAt:at(1,10),completedAt:at(1,11),result:'',error:'Sample service recovery: the attempt ended without a terminal provider result.',checkpoint:recoveryCheckpoint};
  tasks.push(interruptedTask);
  paused.recoveryRequired=true;
  paused.nextAction='Inspect the interrupted attempt, then explicitly authorize retrying the unfinished review.';
  paused.plan={id:'sample-plan-reading',status:'paused',createdAt:at(4,9),updatedAt:at(1,11),approvedAt:at(3,12),approvedPermissionMode:'workspace-write',autoContinue:true,steps:[
    {id:'sample-reading-outline',title:'Outline two reading layouts',instructions:'Outline two layouts for the current document view and report a ready or blocked checkpoint.',status:'finished',taskId:outlineTask.id,attemptIds:[outlineTask.id],checkpoint:outlineCheckpoint},
    {id:'sample-reading-review',title:'Review reading-view accessibility',instructions:interruptedTask.prompt,status:'interrupted',taskId:interruptedTask.id,attemptIds:[interruptedTask.id],checkpoint:recoveryCheckpoint},
  ]};
  paused.evidence.push({taskId:interruptedTask.id,status:'interrupted',summary:interruptedTask.error,createdAt:interruptedTask.completedAt});
  messages.push({id:'sample-recovery-notification',threadId:'sample-main',taskId:interruptedTask.id,workId:paused.id,projectId:paused.projectId,channel:'master',source:'project',role:'system',text:'Sample recovery update · Fieldnotes\nThe reading-view review was interrupted. Finished steps remain recorded; retry needs your explicit acknowledgment.',createdAt:interruptedTask.completedAt,status:'complete'});
  const heldGoal={id:'sample-goal-held',projectId:'sample-atlas',title:'Check the small-screen navigation',objective:'Review the current navigation layout on a narrow viewport and record concrete findings.',nextAction:'Resume the saved review when ready.',status:'paused',createdAt:at(1,12),updatedAt:at(0,8),completedAt:null,evidence:[],notes:[],planHistory:[],recoveryRequired:true};
  const heldTask={id:'sample-navigation-held',threadId:'sample-atlas-thread',parentTaskId:null,projectId:'sample-atlas',workId:heldGoal.id,workspace:'/projects/atlas',permissionMode:'read-only',title:heldGoal.title,prompt:'Inspect the navigation at a narrow viewport without changing files. Report findings and a ready or blocked checkpoint.',kind:'project',status:'queued',queueState:'held',queueReason:'Sample recovery: this queued step never started and waits for explicit resume.',planId:'sample-plan-navigation',stepId:'sample-navigation-review',createdAt:at(1,12),startedAt:null,completedAt:null,result:''};
  heldGoal.plan={id:'sample-plan-navigation',status:'paused',createdAt:at(1,11),updatedAt:at(0,8),approvedAt:at(1,12),approvedPermissionMode:'read-only',autoContinue:false,steps:[{id:'sample-navigation-review',title:'Review narrow-screen navigation',instructions:heldTask.prompt,status:'queued',taskId:heldTask.id,attemptIds:[heldTask.id],checkpoint:null}]};
  workItems.push(heldGoal); tasks.push(heldTask);
  const docs=workItems.find(item=>item.id==='sample-goal-docs');
  docs.plan={id:'sample-plan-contributor-draft',status:'draft',createdAt:at(0,9),updatedAt:at(0,9),approvedAt:null,approvedPermissionMode:null,autoContinue:false,steps:[{id:'sample-docs-inspect',title:'Inspect the current contributor setup',instructions:'Read the contributor setup guide and identify steps needing verification. Do not edit files. Report a ready or blocked checkpoint.',status:'pending',taskId:null,attemptIds:[],checkpoint:null},{id:'sample-docs-propose',title:'Propose a concise setup checklist',instructions:'Use the inspected guide to propose a concise checklist and label every unverified step. Report a ready or blocked checkpoint.',status:'pending',taskId:null,attemptIds:[],checkpoint:null}]};
  const onboarding=workItems.find(item=>item.id==='sample-goal-onboarding');
  onboarding.notes.push({id:'sample-note-external',text:'Sample external update: the copy suggestions were discussed outside Relay. This note does not represent a provider run or verify the goal outcome.',source:'external_update',createdAt:at(0,12)});
  events.push({id:'sample-queue-event',workId:performance.id,taskId:queuedTask.id,projectId:performance.projectId,type:'queue',title:'Reviewed step queued',detail:queuedTask.queueReason,createdAt:queuedTask.createdAt},{id:'sample-held-event',workId:heldGoal.id,taskId:heldTask.id,projectId:heldGoal.projectId,type:'recovery',title:'Queued work held for recovery',detail:heldTask.queueReason,createdAt:at(0,8)});
  events.push({id:'sample-reviewed-completion',workId:'sample-goal-done',projectId:'sample-atlas',type:'work_reviewed',title:'Goal reviewed and marked done',detail:workItems.find(item=>item.id==='sample-goal-done').completionNote,createdAt:at(0,9,30)});
  messages.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  return {schemaVersion:3,meta:{version:'0.4.0',now:now.toISOString(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,sample:true},connection:{provider:'codex',status:'disconnected',message:'Sample workspace — no agent is running.'},settings:{workspace:'/projects/atlas',permissionMode:'read-only',maxWorkers:2,defaultProjectId:'sample-atlas'},coordinatorWorkspace:'/projects/atlas',projects,workItems,mainThreadId:'sample-main',threads,tasks,messages,events,approvals:[],skills:[{id:'sample-skill',name:'clear-handoffs',description:'Turn verified work into a concise handoff.',content:'---\nname: clear-handoffs\ndescription: Turn verified work into a concise handoff.\n---\nReport the result, evidence, limitations, and next action.',hash:'sample',warnings:[],enabled:true,createdAt:at(3,9)}]};
}
