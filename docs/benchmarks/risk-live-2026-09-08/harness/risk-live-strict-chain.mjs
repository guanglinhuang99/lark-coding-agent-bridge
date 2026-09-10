// Candidate-only live strict-parser acceptance. AI is disabled before adapter creation.
import {readFileSync,writeFileSync,mkdirSync,existsSync,appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {runIntentChain} from './risk-live-intent-chain.mjs';
import {stringifyEvidenceForPath} from './public-evidence.mjs';
const arg=(k)=>process.argv[process.argv.indexOf(k)+1];
for(const k of ['--root','--cases','--out'])if(!process.argv.includes(k))throw Error('Missing '+k);
const root=resolve(arg('--root')),out=resolve(arg('--out')),after=join(root,'after');
if(existsSync(out))throw Error('Output exists');
const commit='6d28a6a673b3d400f3d30e15018b5a5621d545cf';
if(execFileSync('git',['rev-parse','HEAD'],{cwd:after,encoding:'utf8'}).trim()!==commit)throw Error('Wrong candidate');
execFileSync('git',['diff','--exit-code','HEAD','--','src'],{cwd:after,stdio:'pipe'});
for(const k of ['POST_TRADE_HISTORY_DB','PORTFOLIO_MARKET_CACHE','PINS_CACHE_DIR','PINS_DATA_DIR'])if(process.env[k])throw Error('Inherited state override '+k);
process.env.PYTHONDONTWRITEBYTECODE='1';
const config=JSON.parse(readFileSync(arg('--cases'),'utf8'));
mkdirSync(out,{recursive:true});
const entry=join(out,'entry.ts'),bundle=join(out,'candidate.mjs');
writeFileSync(entry,['client','intent','router','parser','card'].map(m=>`export * from ${JSON.stringify(join(after,'src/wecom/risk',m+'.ts'))};`).join('\n'));
const req=createRequire(join(after,'package.json')),esbuild=createRequire(req.resolve('tsup')).resolve('esbuild');
execFileSync(join(dirname(esbuild),'../bin/esbuild'),[entry,'--bundle','--platform=node','--format=esm','--banner:js=import {createRequire as __cr} from "node:module"; const require=__cr(import.meta.url);',`--outfile=${bundle}`],{stdio:'pipe'});
const api=await import(pathToFileURL(bundle));
const client=new api.RiskDirectClient({pythonPath:config.python,serviceDir:config.service,stateDir:join(out,'state'),bridgePath:join(after,'src/wecom/risk/direct_bridge.py'),workers:4,timeoutMs:180000,startupTimeoutMs:30000});
let methods={};const call=client.call.bind(client);client.call=async(method,...args)=>{methods[method]=(methods[method]??0)+1;return call(method,...args);};
const rows=[];
try{
 for(let i=0;i<config.cases.length;i++){
  const c=config.cases[i];methods={};const utc=new Date().toISOString(),t=performance.now();let metrics,error;
  try{metrics=await runIntentChain(api,client,c,{allowAI:false},join(out,'state'));}catch(e){error=e.code??e.name;metrics=e.chainMetrics??null;}
  const passed=c.expectFallback?error==='ai-fallback-required-not-executed'&&!methods.calculate_pretrade:!error;
  const row={commit,caseId:`strict-${i}`,utc,status:passed?'pass':'failed',expectedFallback:!!c.expectFallback,errorCategory:error??null,totalMs:performance.now()-t,backendRequests:methods,metrics};
  rows.push(row);const samplePath=join(out,'samples.jsonl');appendFileSync(samplePath,stringifyEvidenceForPath(samplePath,row)+'\n');
  if(!passed)break;
 }
}finally{await client.close();}
const summary={kind:'candidate-only-live-strict-chain',aiRequests:0,complete:rows.length===config.cases.length,pass:rows.every(x=>x.status==='pass'),samples:rows.length,planned:config.cases.length,notRun:config.cases.length-rows.length,evidenceBoundary:'Real fixed candidate parser, client, confirmation registry and calculation. Expected fallback only proves handoff is required; no real AI, platform callback or before/after performance comparison.'};
const summaryPath=join(out,'summary.json');writeFileSync(summaryPath,stringifyEvidenceForPath(summaryPath,summary,2)+'\n');console.log(JSON.stringify(summary));
if(!summary.complete||!summary.pass)process.exitCode=1;
