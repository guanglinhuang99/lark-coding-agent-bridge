// Compare the original optimized adapter with its context-only patch on gpt-5.5.
// Private case/config text and model sessions stay outside the repository.
import {readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {runIntentChain} from './risk-live-intent-chain.mjs';
const [configPath,baselineBundle,patchedBundle,out]=process.argv.slice(2);
if(!out)throw Error('Usage: config baseline-bundle patched-bundle new-output-directory');
mkdirSync(out,{recursive:false});
const cfg=JSON.parse(readFileSync(configPath));
if(cfg.ai.model!=='gpt-5.5')throw Error('This acceptance requires gpt-5.5');
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const apis={baseline:await import(pathToFileURL(baselineBundle)),patched:await import(pathToFileURL(patchedBundle))};
const rows=[],clients={};
writeFileSync(out+'/environment.json',JSON.stringify({model:cfg.ai.model,reasoningEffort:'low',baselineBundleHash:digest(baselineBundle),patchedBundleHash:digest(patchedBundle),configHash:digest(configPath),order:'AB/BA',kind:'context-patch-on-optimized-source; not original before/after benchmark'},null,2));
for(const v of Object.keys(apis))clients[v]=new apis[v].RiskDirectClient({pythonPath:cfg.runtime.python,serviceDir:cfg.runtime.service,stateDir:out+'/state/'+v,bridgePath:cfg.runtime.bridge,workers:4,timeoutMs:180000,startupTimeoutMs:30000});
let failure=null;
try{
for(let scenario=0;scenario<cfg.cases.length;scenario++){
 const c=cfg.cases[scenario];
 for(let pair=0;pair<(c.samples??3);pair++){
  const group=[];
  for(const v of pair%2?['patched','baseline']:['baseline','patched']){
   const t=performance.now();const row={version:v,scenario,pair,utc:new Date().toISOString(),success:false};
   try{const m=await runIntentChain(apis[v],clients[v],c,{...cfg.ai,codexHome:cfg.ai.codexHomes[v==='baseline'?'before':'after'],purpose:v==='patched'?'risk-intent':cfg.baselinePurpose,reasoningEffort:'low'},out+'/state/'+v);
    Object.assign(row,{success:true,totalMs:performance.now()-t,aiCalls:m.aiCalls,aiMs:m.aiMs,usage:m.usage,inputHash:m.inputHash,businessHash:m.businessHash,confirmationChecks:m.confirmationChecks,dataDate:m.dataDate});
   }catch(e){Object.assign(row,{totalMs:performance.now()-t,errorCategory:e.code??e.name,aiCalls:e.chainMetrics?.aiCalls,usage:e.chainMetrics?.usage});}
   rows.push(row);group.push(row);appendFileSync(out+'/samples.jsonl',JSON.stringify(row)+'\n');
  }
  if(!group.every(r=>r.success)||group[0].inputHash!==group[1].inputHash||group[0].businessHash!==group[1].businessHash)throw Error('Paired acceptance failed; records retained');
 }
}
}catch(e){failure=e.message;process.exitCode=1;}
finally{await Promise.all(Object.values(clients).map(c=>c.close()));}
writeFileSync(out+'/summary.json',JSON.stringify({model:cfg.ai.model,failure,rows:rows.length,passed:rows.filter(r=>r.success).length,failed:rows.filter(r=>!r.success).length},null,2));
