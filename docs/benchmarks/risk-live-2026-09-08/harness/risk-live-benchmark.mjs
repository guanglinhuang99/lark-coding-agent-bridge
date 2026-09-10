#!/usr/bin/env node
// Read-only real-client query benchmark. No bot transport, AI replacement, or business writes.
import { readFileSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { runIntentChain, runCalculationOnly } from './risk-live-intent-chain.mjs';
import { stringifyEvidenceForPath } from './public-evidence.mjs';
const args = process.argv.slice(2);
const opt = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const collectInputFailures = args.includes('--collect-input-failures');
const maxCollectedAttempts = 40;
const isCollectableInputFailure = row => !row?.success && row.errorCategory === 'normalized-input-mismatch';
const classifyPair = pair => {
 const consistent = pair.length === 2 && pair.every(r => r.success) && pair[0].resultHash === pair[1].resultHash && pair[0].inputHash === pair[1].inputHash;
 const collectableInputFailure = !consistent && pair.length === 2 && pair.some(isCollectableInputFailure) && pair.every(r => r.success || isCollectableInputFailure(r));
 return {consistent,collectableInputFailure};
};
if (args.includes('--self-test')) {
 const usable = [{success:true,resultHash:'business',inputHash:'input'},{success:true,resultHash:'business',inputHash:'input'}];
 const inputFailure = [{success:false,errorCategory:'normalized-input-mismatch'},{success:true,resultHash:'business',inputHash:'input'}];
 const hardFailure = [{success:false,errorCategory:'network'},{success:true,resultHash:'business',inputHash:'input'}];
 const businessMismatch = [{success:true,resultHash:'before',inputHash:'input'},{success:true,resultHash:'after',inputHash:'input'}];
 if (!classifyPair(usable).consistent || !classifyPair(inputFailure).collectableInputFailure || classifyPair(hardFailure).collectableInputFailure || classifyPair(businessMismatch).collectableInputFailure) throw Error('Collection logic self-test failed');
 console.log(JSON.stringify({mode:'self-test',status:'pass',collectable:'normalized-input-mismatch only',maxAttempts:maxCollectedAttempts}));
 process.exit(0);
}
if (args.includes('--help')) {
 console.log('node docs/benchmarks/risk-live-2026-09-08/harness/risk-live-benchmark.mjs --root <isolated before/after parent> --python <python> --service <backend> --data <versions.json> --out <new output dir> [--samples 30] [--cold 3] [--securities] [--cases <private cases.json>] [--collect-input-failures]'); process.exit(0);
}
process.env.PYTHONDONTWRITEBYTECODE='1';
for(const key of ['POST_TRADE_HISTORY_DB','PORTFOLIO_MARKET_CACHE','PINS_CACHE_DIR','PINS_DATA_DIR'])if(process.env[key])throw Error(`Preflight: inherited ${key} must be unset so each bridge uses its isolated state directory`);
const root = resolve(opt('--root', '/private/tmp/wecom-live-20260908'));
const out = resolve(opt('--out', join(root, 'query-live')));
const python = opt('--python', process.env.WECOM_RISK_PYTHON);
const service = opt('--service', process.env.WECOM_RISK_SERVICE_DIR);
const dataPath = opt('--data', join(root, 'data-versions.json'));
const N = Number(opt('--samples', '30')), coldN = Number(opt('--cold', '3'));
if (!python || !service || !existsSync(dataPath) || !Number.isInteger(N) || N < 1 || !Number.isInteger(coldN) || coldN < 0) throw Error('Preflight: require python, service, data versions and valid sample counts');
if (collectInputFailures && N > maxCollectedAttempts) throw Error(`Preflight: --collect-input-failures supports at most ${maxCollectedAttempts} target pairs`);
if (existsSync(out)) throw Error('Output already exists; choose a new directory');
const versions = { before: 'f00d635b36536dccac7ebeb73235e7dcf584d49b', after: '6d28a6a673b3d400f3d30e15018b5a5621d545cf' };
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
for (const [v, sha] of Object.entries(versions)) {
 if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: join(root, v), encoding: 'utf8' }).trim() !== sha) throw Error(`Wrong ${v} commit`);
 if (execFileSync('git', ['diff', 'HEAD', '--', 'src'], {cwd: join(root,v), encoding:'utf8'}).trim()) throw Error(`Modified ${v} source`);
}
if (hash(readFileSync(join(root,'before/pnpm-lock.yaml'),'utf8')) !== hash(readFileSync(join(root,'after/pnpm-lock.yaml'),'utf8'))) throw Error('Different lockfiles');
mkdirSync(out,{recursive:true});
const dataVersion = JSON.parse(readFileSync(dataPath,'utf8'));
const constructors = {};
const calculationOnly=args.includes('--calculation-cases');
const casesPath=opt('--calculation-cases',opt('--cases',null));
const caseConfig=casesPath?JSON.parse(readFileSync(casesPath,'utf8')):null;
if (collectInputFailures && (!caseConfig || calculationOnly)) throw Error('Preflight: --collect-input-failures requires intent --cases');
if(caseConfig&&!calculationOnly&&!args.includes('--preflight-only')){
 const homes=caseConfig.ai?.codexHomes;
 if(!Array.isArray(caseConfig.cases)||!homes||homes.before===homes.after||!['before','after'].every(v=>resolve(homes[v]??'').startsWith(root+'/')&&existsSync(join(homes[v],'config.toml'))))throw Error('Case preflight: require distinct isolated Codex homes under acceptance root and config.toml in each');
 if(hash(readFileSync(join(homes.before,'config.toml'),'utf8'))!==hash(readFileSync(join(homes.after,'config.toml'),'utf8')))throw Error('Different AI configurations');
}
const apis={};
for (const v of Object.keys(versions)) {
 const bundle = join(out,`${v}-client.mjs`);
 let entry=join(root,v,'src/wecom/risk/client.ts');
 if(caseConfig&&!calculationOnly){
  entry=join(out,`${v}-entry.ts`);
  const modules=['wecom/risk/client','wecom/risk/intent','wecom/risk/router','wecom/risk/parser','wecom/risk/card','agent/codex/adapter','bridge/run-executor','bridge/process-pool','bridge/active-runs','wecom/agent-runtime'];
  writeFileSync(entry,modules.map(m=>`export * from ${JSON.stringify(join(root,v,'src',m+'.ts'))};`).join('\n'));
 }
 const require = createRequire(join(root,v,'package.json'));
 const esbuild = createRequire(require.resolve('tsup')).resolve('esbuild');
 execFileSync(join(dirname(esbuild),'../bin/esbuild'),[entry,'--bundle','--platform=node','--format=esm',"--banner:js=import {createRequire as __cr} from 'node:module'; const require=__cr(import.meta.url);",`--outfile=${bundle}`],{stdio:'pipe'});
 apis[v]=await import(pathToFileURL(bundle));
 constructors[v] = apis[v].RiskDirectClient;
}
if(args.includes('--preflight-only')){console.log('Source bundles loaded; no service or AI calls made');process.exit(0);}
let sequence = 0;
function client(v) {
 const stateDir = join(out,'state',`${v}-${++sequence}`);
 const c = new constructors[v]({pythonPath:python,serviceDir:resolve(service),stateDir,bridgePath:join(root,v,'src/wecom/risk/direct_bridge.py'),workers:4,timeoutMs:180000,startupTimeoutMs:30000});
 const call = c.call.bind(c), start = c.ensureStarted.bind(c);
 let metrics = {methods:{}, startupMs:null};
 c.call = async (method,...rest) => { metrics.methods[method]=(metrics.methods[method]??0)+1; return call(method,...rest); };
 c.ensureStarted = async () => { const fresh=!c.ready&&!c.startPromise, t=performance.now(); try{return await start();}finally{if(fresh)metrics.startupMs=performance.now()-t;} };
 return {c,reset(){metrics={methods:{},startupMs:null};},get metrics(){return metrics;}};
}
const rows=[],pairChecks=[],scenarioTargets=new Map();
async function sample(v,scenario,pair,holder,fn,cacheState) {
 holder.reset(); const utc=new Date().toISOString(),t=performance.now();
 const caseMatch=/^(?:intent|calculation)_case_(\d+)$/.exec(scenario);
 const anonymousCase=caseMatch?caseConfig?.cases[Number(caseMatch[1])]:{scenario};
 const row={version:v,commit:versions[v],scenario,pair,caseId:hash(anonymousCase??{scenario}).slice(0,12),utc,dataVersion,cacheState,success:false,errorCategory:null,aiCalls:0,backendRequests:null,totalMs:null,stages:{startup:null,ai:null,preparation:null,securityCandidates:null,calculation:null,queue:null,display:null},humanWaitMs:null,resultHash:null};
 try {const value=await fn(holder.c,v); if(value?.chainMetrics){const m=value.chainMetrics;row.aiCalls=m.aiCalls;row.usage=m.usage??[];row.stages.ai=m.aiMs??null;row.stages.preparation=m.preparationMs;row.stages.calculation=m.calculationMs;row.stages.display=m.displayMs;row.inputHash=m.inputHash;row.draftHash=m.draftHash;row.displayHash=m.displayHash;row.dataDate=m.dataDate;row.baselineHash=m.baselineHash;row.baselineMetricsHash=m.baselineMetricsHash;row.backendRunIdHash=m.backendRunIdHash;row.netAssets=m.netAssets;row.backendTimings=m.backendTimings;row.confirmationChecks=m.confirmationChecks;row.excludedNonBusinessPaths=m.excludedNonBusinessPaths;row.resultHash=m.businessHash;row.success=true;}else {if(!Array.isArray(value)||value.length===0)throw Error('EmptyQueryResult');row.resultHash=hash(value);row.success=true;}}catch(e){const known=['EmptyQueryResult','NormalizedInputMismatch','CalculationMissingOrRejected','CalculationNotSuccessful','UnresolvedConfirmation','CandidateSelectionUnresolved','CorrectionNeedsConfirmationState','RealAiRunError','RealAiTimeout'];row.errorCategory=e.code??(known.includes(e.message)?e.message:e.name)??'Error';if(e.chainMetrics){row.aiCalls=e.chainMetrics.aiCalls;row.usage=e.chainMetrics.usage??[];row.stages.ai=e.chainMetrics.aiMs;row.inputHash=e.chainMetrics.inputHash;row.actualInputHash=e.chainMetrics.actualInputHash;row.missingInputFields=e.chainMetrics.missingInputFields;row.dataDate=e.chainMetrics.dataDate;row.baselineHash=e.chainMetrics.baselineHash;row.baselineMetricsHash=e.chainMetrics.baselineMetricsHash;row.backendRunIdHash=e.chainMetrics.backendRunIdHash;row.netAssets=e.chainMetrics.netAssets;row.backendTimings=e.chainMetrics.backendTimings;}else if(scenario.startsWith('intent_'))row.aiCalls=null;}
 row.totalMs=performance.now()-t;row.backendRequests=holder.metrics.methods;row.stages.startup=holder.metrics.startupMs;
 rows.push(row);const samplePath=join(out,'samples.jsonl');appendFileSync(samplePath,stringifyEvidenceForPath(samplePath,row)+'\n');return row;
}
const order=i=>i%2?['after','before']:['before','after'];
async function paired(scenario,count,holders,fn,cacheState,clear=false){
 const collectionEnabled=collectInputFailures&&caseConfig&&!calculationOnly;
 const maxAttempts=collectionEnabled?maxCollectedAttempts:count;
 scenarioTargets.set(scenario,count);
 let usablePairs=0,attempts=0;
 while(attempts<maxAttempts&&(!collectionEnabled||usablePairs<count)){
  const i=attempts++;
  const pair=[];
  for(const v of order(i)){
   const h=holders?.[v]??client(v);
   if(clear&&typeof h.c.clearLookupCache==='function')h.c.clearLookupCache();
   try{pair.push(await sample(v,scenario,i,h,fn,cacheState));}finally{if(!holders)await h.c.close();}
  }
  const {consistent,collectableInputFailure}=classifyPair(pair);
  const failureCategories={};
  for(const row of pair)if(!row.success){const category=row.errorCategory??'unknown';failureCategories[category]=(failureCategories[category]??0)+1;}
  pairChecks.push({scenario,pair:i,consistent,usable:consistent,collectableInputFailure,failureCategories});
  appendFileSync(join(out,'pairs.jsonl'),JSON.stringify({scenario,pair:i,consistent,usable:consistent,collectableInputFailure,failureCategories})+'\n');
  if(consistent){usablePairs++;continue;}
  if(collectionEnabled&&collectableInputFailure)continue;
  throw Error(`Business result mismatch or query failure: ${scenario} pair ${i}; samples retained`);
 }
 if(collectionEnabled&&usablePairs<count)throw Error(`Input-failure collection stopped: ${scenario} reached ${usablePairs}/${count} usable pairs in ${attempts}/${maxAttempts} attempts; samples retained`);
}
const holders={before:client('before'),after:client('after')};
let failure=null;
try{
 if(!args.includes('--only-distinct')&&!args.includes('--only-distinct-products')&&!args.includes('--only-cases')){
 await paired('products_first_process',coldN,null,c=>c.listProducts(),'new process and isolated state; shared server cache uncontrolled');
 await paired('products_warmup',1,holders,c=>c.listProducts(),'new persistent clients');
 await paired('products_repeat',N,holders,c=>c.listProducts(),'persistent client; after application cache warm');
 await paired('products_concurrent_same_miss',N,holders,c=>Promise.all(Array.from({length:8},()=>c.listProducts())),'application lookup cache cleared; persistent backend warm',true);
 }
 if(args.includes('--securities')||args.includes('--only-distinct')){
  if(!args.includes('--only-distinct')){
  await paired('security_repeat',N,holders,c=>c.searchSecurities('100115.SZ'),'persistent client; first sample lookup miss');
  await paired('security_concurrent_same_miss',N,holders,c=>Promise.all(Array.from({length:8},()=>c.searchSecurities('100115.SZ'))),'application lookup cache cleared; backend cache uncontrolled',true);
  }
  const codes=['100115.SZ','260201.IB','600519.SH','510300.SH','113050.SH','012680248.IB','113052.SH','019115.SH'];
  await paired('security_concurrent_distinct',N,holders,c=>Promise.all(codes.map(x=>c.searchSecurities(x))),'8 distinct queries, 8 calls; application cache cleared',true);
 }
 if(args.includes('--only-distinct-products')){
  const products={};
  await paired('products_warmup',1,holders,async(c,v)=>{products[v]=await c.listProducts();return products[v];},'first product lookup, separate from distinct-query timing');
  await paired('restrictions_concurrent_distinct',N,holders,(c,v)=>Promise.all(products[v].slice(0,8).map(p=>c.getRestrictions(p))),'8 different products; persistent backend; restrictions always called');
 }
 if(caseConfig){
  for(const [i,c] of caseConfig.cases.entries())await paired(`${calculationOnly?'calculation':'intent'}_case_${i}`,c.samples??N,c.freshClient?null:holders,async(service,v)=>({chainMetrics:calculationOnly?await runCalculationOnly(service,c):await runIntentChain(apis[v],service,c,{...caseConfig.ai,codexHome:caseConfig.ai.codexHomes?.[v]},join(out,'state',v+'-intent'))}),c.freshClient?'new client process and isolated state':'persistent clients; explicit fixture confirmation for intent path, no platform');
 }
}catch(e){failure=String(e.message);process.exitCode=1;}finally{await Promise.all(Object.values(holders).map(h=>h.c.close()));}
const stat=xs=>{const a=xs.slice().sort((x,y)=>x-y);return a.length?{median:a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2,p95:a[Math.ceil(a.length*.95)-1]}:{median:null,p95:null};};
const summary={kind:caseConfig?'real-client-query-and-preapproved-local-calculation':'real-client-read-only-query',versions,dataVersion,node:process.version,python,service:resolve(service),workers:4,timeoutMs:180000,startupTimeoutMs:30000,failure,collection:{enabled:collectInputFailures,targetUsablePairs:collectInputFailures?N:null,maxAttempts:collectInputFailures?maxCollectedAttempts:null,policy:collectInputFailures?'continue only when every failed row is normalized-input-mismatch; stop for all other failures or mismatches':'fail-fast'},observability:'backendRequests counts client call invocations, not database executions. Missing stages=null (unobserved). No platform transport is exercised. Direct calculation cases do not exercise intent or confirmation. Optional intent cases exercise source confirmation registries and real AI only when authorized; lifecycle is tested separately.',scenarios:{}};
const planned=args.includes('--only-cases')?(caseConfig?.cases.map((_,i)=>`${calculationOnly?'calculation':'intent'}_case_${i}`)??[]):args.includes('--only-distinct-products')?['products_warmup','restrictions_concurrent_distinct']:args.includes('--only-distinct')?['security_concurrent_distinct']:['products_first_process','products_warmup','products_repeat','products_concurrent_same_miss',...(args.includes('--securities')?['security_repeat','security_concurrent_same_miss','security_concurrent_distinct']:[]),...(caseConfig?caseConfig.cases.map((_,i)=>`${calculationOnly?'calculation':'intent'}_case_${i}`):[])];
for(const s of new Set([...planned,...rows.map(r=>r.scenario)])){
 const checks=pairChecks.filter(p=>p.scenario===s),usablePairs=checks.filter(p=>p.consistent).length,pairFailures=checks.filter(p=>!p.consistent).length,failureCategories={};
 for(const check of checks)for(const [category,count] of Object.entries(check.failureCategories??{}))failureCategories[category]=(failureCategories[category]??0)+count;
 const by={};for(const v of Object.keys(versions)){const a=rows.filter(r=>r.scenario===s&&r.version===v),ok=a.filter(r=>r.success);by[v]={n:a.length,success:ok.length,failures:a.length-ok.length,successRate:ok.length/a.length,...stat(ok.map(r=>r.totalMs)),backendRequests:a.reduce((n,r)=>n+Object.values(r.backendRequests).reduce((x,y)=>x+y,0),0)};}
 const targetUsablePairs=scenarioTargets.get(s)??(collectInputFailures?N:null),collectionComplete=!collectInputFailures||usablePairs>=targetUsablePairs;
 const b=by.before.median,a=by.after.median;summary.scenarios[s]={attempts:checks.length,targetUsablePairs,usablePairs,failures:pairFailures,failureCategories,businessConsistent:checks.length>0&&checks.every(p=>p.consistent),usablePairConsistency:usablePairs>0&&checks.filter(p=>p.consistent).every(p=>p.consistent),status:by.before.n===0&&by.after.n===0?'not-run':collectionComplete?'sampled':'failed',...by,absoluteReductionMs:b!==null&&a!==null?b-a:null,reductionPercent:b&&a!==null?100*(1-a/b):null};
}
const summaryPath=join(out,'summary.json');writeFileSync(summaryPath,stringifyEvidenceForPath(summaryPath,summary,2)+'\n');console.log(JSON.stringify(summary,null,2));
