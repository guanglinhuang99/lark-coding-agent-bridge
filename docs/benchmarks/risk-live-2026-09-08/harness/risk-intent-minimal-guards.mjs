// Real-model negative cases. Read-only normalization, then a trapped calculation boundary.
import {readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [bundle,configFile,casesFile,out]=process.argv.slice(2);
mkdirSync(out,{recursive:false});
const api=await import(pathToFileURL(bundle)), cfg=JSON.parse(readFileSync(configFile)), cases=JSON.parse(readFileSync(casesFile)).cases;
if(cfg.ai.model!=='gpt-5.5')throw Error('Expected authorized test model');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const agent=new api.CodexAdapter({binary:cfg.ai.binary,profileStateDir:out,codexHome:cfg.ai.codexHomes.after,purpose:'risk-intent',sandbox:'read-only'});
const client=new api.RiskDirectClient({pythonPath:cfg.runtime.python,serviceDir:cfg.runtime.service,stateDir:out+'/backend',bridgePath:cfg.runtime.bridge,workers:1,timeoutMs:180000,startupTimeoutMs:30000});
const executor=new api.RunExecutor({agent,pool:new api.ProcessPool(()=>1,{maxQueued:1,queueTimeoutMs:180000}),activeRuns:new api.ActiveRuns()});
const rows=[];
try{
for(const c of cases){
 const row={caseId:c.caseId,utc:new Date().toISOString(),success:false,calculationCalls:0,model:cfg.ai.model};
 let run,timer;
 try{
  run=await api.startWeComAgentRun(executor,{runId:randomUUID(),prompt:api.buildRiskIntentPrompt(c.text),cwd:cfg.ai.cwd,model:cfg.ai.model,reasoningEffort:'low',sandbox:'read-only'},randomUUID());
  timer=setTimeout(()=>run.stop(),120000);let output='';
  for await(const e of run.events){if(e.type==='final_text')output=e.content;if(e.type==='usage')row.usage=e;if(e.type==='error')throw Error('model-error');}
  const draft=api.parseRiskIntentOutputPartial(output,c.text);row.draftHash=hash(draft);
  const state=await api.normalizeRiskDraft(c.text,draft,client);row.stage=state.stage;
  if(state.stage==='confirm'){
   if(state.product!==c.expectedProduct||state.security?.code!==c.expectedSecurityCode)throw Error('master-data-mismatch');
   // Any service method call fails the guard before reaching a real backend.
   const trapped=new Proxy({}, {get:()=>async()=>{row.calculationCalls++;throw Error('unexpected-service-call');}});
   const router=new api.WeComRiskRouter(trapped);
   const result=await router.executeConfirmed(state);
   row.routeIntent=result.intent;
   if(row.calculationCalls!==0||result.intent!=='risk-error')throw Error('invalid-input-was-executable');
  }
  row.success=true;
 }catch(e){row.errorCategory=e.message;process.exitCode=1;}
 finally{clearTimeout(timer);if(run&&!await run.waitForExit(1500))await run.stop();}
 rows.push(row);appendFileSync(out+'/samples.jsonl',JSON.stringify(row)+'\n');
}
}finally{await client.close();}
writeFileSync(out+'/summary.json',JSON.stringify({model:cfg.ai.model,n:rows.length,passed:rows.filter(x=>x.success).length,failed:rows.filter(x=>!x.success).length,calculationCalls:rows.reduce((s,x)=>s+x.calculationCalls,0),boundary:'Real AI and master-data normalization; actual router with trapped service, no formal calculation or platform callback'},null,2));
