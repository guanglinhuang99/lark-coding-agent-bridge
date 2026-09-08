// Real adapters and confirmation registries; no platform SDK connection.
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const digest=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const fail=(code,metrics)=>Object.assign(new Error(code),{code,chainMetrics:metrics});
const isBatchExpected=testCase=>Array.isArray(testCase?.expected?.actions);
const isBatchState=state=>Array.isArray(state?.draft?.transactions);
function comparableAction(action){
 if(!action||typeof action!=='object')return null;
 const out={};
 if(action.type!==undefined)out.type=action.type;
 if(action.market!==undefined)out.market=action.market;
 if(action.amount!==undefined)out.amount=action.amount;
 const quantity=action.quantity??action.shares;
 if(quantity!==undefined)out.quantity=quantity;
 if(action.security_name!==undefined)out.securityCode=action.security_name;
 if(action.days!==undefined)out.days=action.days;
 return out;
}
function parsedAmount(api,text){
 return typeof api.confirmedRiskAmount==='function'?api.confirmedRiskAmount(text??''):undefined;
}
function comparableDraftAction(api,draft){
 const amount=parsedAmount(api,draft?.amountText);
 if(!amount||!draft)return undefined;
 const action={};
 if(draft.action!==undefined)action.type=draft.action;
 if(draft.market!==undefined)action.market=draft.market;
 if(amount.amount!==undefined)action.amount=amount.amount;
 if(amount.quantity!==undefined)action.quantity=amount.quantity;
 if(draft.resolvedSecurity?.code!==undefined)action.securityCode=draft.resolvedSecurity.code;
 if(draft.days!==undefined)action.days=draft.days;
 return action;
}
function normalizedInput(api,state,testCase){
 if(isBatchExpected(testCase)){
  if(!isBatchState(state))return undefined;
  const actions=state.draft.transactions.map(item=>comparableDraftAction(api,item));
  return actions.every(Boolean)?{product:state.product,actions}:undefined;
 }
 if(isBatchState(state))return undefined;
 if(typeof api.confirmedRiskAmount==='function'){
  const action=comparableDraftAction(api,{...state.draft,resolvedSecurity:state.security});
  return action?{product:state.product,...action}:undefined;
 }
 const parsed=api.parseRiskMessage(api.canonicalCommand(state),[state.product]);
 return {product:state.product,type:state.draft.action,market:state.draft.market,...(parsed.amount!==undefined?{amount:parsed.amount}:{}),...(parsed.quantity!==undefined?{quantity:parsed.quantity}:{}),...(state.draft.days!==undefined?{days:state.draft.days}:{}),...(state.security?{securityCode:state.security.code}:{} )};
}
function expectedServiceAction(expected){
 const {product:_product,securityCode,quantity,...rest}=expected;
 const quantityField=quantity!==undefined
  ? (expected.type==='subscription'||expected.type==='redemption'?{shares:quantity}:{quantity})
  : {};
 return {...rest,...(securityCode?{security_name:securityCode}:{}),...quantityField};
}
export async function runIntentChain(api, service, testCase, config, stateDir) {
 if(testCase.approvedForLocalCalculation!==true||!testCase.expected||!testCase.text)throw Error('InvalidPrivateCase');
 if(config.allowAI!==false&&(!config.model||!config.binary||!config.cwd||!config.codexHome))throw Error('MissingRealAiConfiguration');
 const agent=config.allowAI===false?null:new api.CodexAdapter({binary:config.binary,purpose:config.purpose,profileStateDir:join(stateDir,'ai'),codexHome:config.codexHome,inheritCodexHome:false,ignoreUserConfig:false,ignoreRules:false,sandbox:'read-only'});
 const executor=agent?new api.RunExecutor({agent,pool:new api.ProcessPool(()=>1,{maxQueued:1,queueTimeoutMs:180000}),activeRuns:new api.ActiveRuns()}):null;
 const metrics={aiCalls:0,aiMs:0,usage:[],preparationMs:null,calculationMs:null,displayMs:null,inputHash:null,businessHash:null,displayHash:null,confirmationChecks:[],backendTimings:null,dataDate:null,baselineHash:null,netAssets:null,preConfirmationCalculationCalls:0,calculationCalls:0,excludedNonBusinessPaths:['$.timings']};
 const prepareStart=performance.now();
 async function analyze(previous,correction){
  if(config.allowAI===false)throw fail('ai-fallback-required-not-executed',metrics);
  metrics.aiCalls++;const t=performance.now();let run,timedOut=false,timer;
  try{
   run=await api.startWeComAgentRun(executor,{runId:randomUUID(),prompt:api.buildRiskIntentPrompt(testCase.text,previous,correction),cwd:config.cwd,model:config.model,reasoningEffort:config.reasoningEffort,sandbox:'read-only'},randomUUID());
   timer=setTimeout(()=>{timedOut=true;void run.stop();},config.timeoutMs??180000);
   let output='';
   for await(const e of run.events){if(e.type==='usage')metrics.usage.push(e);if(e.type==='text')output+=e.delta??'';if(e.type==='final_text')output=e.content??output;if(e.type==='error')throw fail(timedOut?'ai-timeout':'ai-run-error',metrics);}
   await run.waitForExit(1500).catch(()=>false);
   if(timedOut)throw fail('ai-timeout',metrics);
   return api.parseRiskIntentOutputPartial(output,correction?`${testCase.text} ${correction}`:testCase.text);
  }finally{clearTimeout(timer);metrics.aiMs+=performance.now()-t;}
 }
 function confirmation(state){
  const registry=new api.RiskSelectionTaskRegistry(),intentRegistry=new api.RiskIntentStateRegistry();
  const taskId=randomUUID(),key=randomUUID(),expiresAt=Date.now()+300000;
  const selection=api.buildIntentSelection(state,expiresAt);
  // Actual card rendering and callback task registry used by the WeCom CLI.
  api.buildRiskSelectionCard(selection,taskId);
  registry.register(taskId,key,selection);intentRegistry.registerTask(taskId,key,state,expiresAt);
  if(registry.resolve(taskId,'wrong-conversation','confirm').status!=='mismatch')throw fail('confirmation-context-regression',metrics);
  if(registry.resolve(taskId,key,'invalid-option').status!=='invalid')throw fail('confirmation-option-regression',metrics);
  const selected=registry.resolve(taskId,key,'confirm');
  if(selected.status!=='selected'||selected.option.value!=='__confirm__'||intentRegistry.getTask(taskId)!==state)throw fail('confirmation-resolution-regression',metrics);
  intentRegistry.deleteTask(taskId);
  if(registry.resolve(taskId,key,'confirm').status!=='missing')throw fail('duplicate-confirmation-regression',metrics);
  registry.register('expired',key,{...selection,expiresAt:Date.now()-1});
  if(registry.resolve('expired',key,'confirm').status!=='expired')throw fail('expired-confirmation-regression',metrics);
  metrics.confirmationChecks.push('rendered','context-rejected','invalid-option-rejected','selected-once','duplicate-rejected','expired-rejected');
 }
 let originalCalculate=service.calculatePretrade;
 let confirmed=false;
 service.calculatePretrade=async(...args)=>{
  if(!confirmed){metrics.preConfirmationCalculationCalls++;throw fail('calculation-before-confirmation',metrics);}
  return originalCalculate.call(service,...args);
 };
 try{
  let state=api.resolveInitialRiskIntent?await api.resolveInitialRiskIntent(testCase.text,service,()=>analyze()):await api.normalizeRiskDraft(testCase.text,await analyze(),service);
  for(const reply of testCase.selections??[]){
   if(reply&&typeof reply==='object'&&typeof reply.text==='string'){
    const next=await api.applyDirectRiskIntentInput(state,reply.text,service);
    if(!next)throw fail('freeform-clarification-unresolved',metrics);
    state=next;metrics.confirmationChecks.push('explicit-freeform-clarification-applied');continue;
   }
  if(state.stage==='account'||state.stage==='security'){
    const selection=api.buildIntentSelection(state,Date.now()+300000),registry=new api.RiskSelectionTaskRegistry(),id=randomUUID(),key=randomUUID();
    const option=selection.options.find(x=>x.value===reply||(state.stage==='security'&&x.value?.startsWith('{')&&JSON.parse(x.value).code===reply));
    if(!option)throw fail('candidate-not-found',metrics);
    registry.register(id,key,selection);const resolved=registry.resolve(id,key,option.key);
    if(resolved.status!=='selected')throw fail('candidate-selection-rejected',metrics);
    metrics.confirmationChecks.push('actual-candidate-option-selected');
    if(state.stage==='account'){
     const product=resolved.option.value;
     state=await api.normalizeSecurity(state.originalText,{...state.draft,accountQuery:product},product,service);
    }
   else {
    const security=JSON.parse(resolved.option.value);
    if(typeof api.selectRiskIntentSecurity==='function')state=await api.selectRiskIntentSecurity(state,security,service);
    else if(isBatchState(state)){
     const index=state.transactionIndex;
     if(index===undefined||!state.draft.transactions[index])throw fail('candidate-selection-rejected',metrics);
     const transactions=state.draft.transactions.map((item,i)=>i===index?{...item,resolvedSecurity:security}:item);
     state=await api.normalizeSecurity(state.originalText,{...state.draft,transactions},state.product,service);
    }else {
     if(!state.draft.action||!state.draft.amountText)throw fail('candidate-missing-fields',metrics);
     state={...state,stage:'confirm',security};
    }
   }
   }else{const next=await api.applyDirectRiskIntentInput(state,reply,service);if(!next)throw fail('candidate-unresolved',metrics);state=next;}
  }
  for(const correction of testCase.corrections??[]){
   if(state.stage!=='confirm')throw fail('correction-needs-confirmation',metrics);
   // Exercise invalidation of an actual prior card/task when a correction replaces it.
   const prior=state, correctionRegistry=new api.RiskSelectionTaskRegistry(), correctionStates=new api.RiskIntentStateRegistry(), correctionKey=randomUUID(), priorId=randomUUID(), nextId=randomUUID(), expiry=Date.now()+300000;
   correctionRegistry.register(priorId,correctionKey,api.buildIntentSelection(prior,expiry));
   correctionStates.registerTask(priorId,correctionKey,prior,expiry);
   const simple=api.applySimpleRiskCorrection?.(state,correction);
   state=simple??await api.normalizeRiskDraft(testCase.text,api.mergeRiskIntentDraft(state.draft,await analyze(state.draft,correction),correction),service);
   correctionRegistry.register(nextId,correctionKey,api.buildIntentSelection(state,expiry));
   correctionStates.registerTask(nextId,correctionKey,state,expiry);
   if(correctionRegistry.resolve(priorId,correctionKey,'confirm').status!=='missing'||correctionStates.getTask(priorId)!==undefined)throw fail('stale-correction-confirmation-regression',metrics);
   correctionStates.deleteTask(nextId);
   metrics.confirmationChecks.push('prior-correction-card-invalidated');
  }
  if(state.stage!=='confirm')throw fail('unresolved-confirmation',metrics);
  const input=normalizedInput(api,state,testCase);
  metrics.inputHash=input?digest(input):null;metrics.draftHash=digest(state.draft);
  if(!input||digest(input)!==digest(testCase.expected))throw fail('normalized-input-mismatch',metrics);
  confirmation(state);metrics.preparationMs=performance.now()-prepareStart;confirmed=true;
  if(testCase.confirmOnly){metrics.businessHash=digest({input,stage:state.stage});return metrics;}
  let business,calculationCount=0,calculationFailure;
  service.calculatePretrade=async(product,action,...rest)=>{
   calculationCount++;
   const actualAction=Array.isArray(action)?action.map(comparableAction):comparableAction(action);
   const actual=isBatchExpected(testCase)?{product,actions:Array.isArray(actualAction)?actualAction:null}:{product,...(actualAction??{})};
   if(digest(actual)!==digest(testCase.expected)){metrics.actualInputHash=digest(actual);metrics.missingInputFields=Object.keys(testCase.expected).filter(k=>!(k in actual));calculationFailure=fail('calculation-input-mismatch',metrics);throw calculationFailure;}
   const t=performance.now();
   try{
    const r=await originalCalculate.call(service,product,action,...rest);
    metrics.backendTimings=r.timings??r.result?.timings??null;
    if(r.status!=='success')throw fail('calculation-failed',metrics);
    business={...r.result};delete business.timings; // Timing is metadata; every business field remains compared exactly.
    metrics.dataDate=business.date;metrics.baselineHash=digest(business.before);metrics.baselineMetricsHash=digest(business.before?.metrics);metrics.backendRunIdHash=digest(r.id);metrics.netAssets=business.before?.metrics?.net_assets??null;
    if(testCase.dataDate&&metrics.dataDate!==testCase.dataDate)throw fail('data-date-changed',metrics);
    if(testCase.baselineHash&&metrics.baselineHash!==testCase.baselineHash)throw fail('baseline-changed',metrics);
    if(testCase.baselineMetricsHash&&metrics.baselineMetricsHash!==testCase.baselineMetricsHash)throw fail('baseline-metrics-changed',metrics);
    return r;
   }catch(e){calculationFailure=e;throw e;}finally{metrics.calculationMs=performance.now()-t;}
  };
  const router=new api.WeComRiskRouter(service);
  if(isBatchState(state)&&typeof router.executeConfirmed!=='function')throw fail('batch-confirmation-route-unavailable',metrics);
  const result=router.executeConfirmed?await router.executeConfirmed(state):await router.handle(randomUUID(),api.canonicalCommand(state));
  if(calculationFailure)throw calculationFailure;
  if(!business||result.intent==='risk-error'||calculationCount!==1)throw fail('calculation-not-completed-once',metrics);
  metrics.businessHash=digest(business);metrics.displayHash=digest(result.markdown);metrics.calculationCalls=calculationCount;
  return metrics;
 }catch(e){if(!e.chainMetrics)e.chainMetrics=metrics;throw e;}finally{if(originalCalculate)service.calculatePretrade=originalCalculate;}
}

export async function runCalculationOnly(service,testCase){
 const expected=testCase?.expected;
 const metrics={aiCalls:0,aiMs:0,usage:[],preparationMs:null,calculationMs:null,displayMs:null,inputHash:expected?digest(expected):null,businessHash:null,displayHash:null,confirmationChecks:[],backendTimings:null,dataDate:null,baselineHash:null,netAssets:null,excludedNonBusinessPaths:['$.timings'],path:'direct-client-calculation-no-ai-or-confirmation'};
 if(testCase.approvedForLocalCalculation!==true)throw fail('case-not-approved',metrics);
 if(!expected||typeof expected!=='object'||Array.isArray(expected))throw fail('case-invalid-expected',metrics);
 const batch=Array.isArray(expected.actions);
 if(batch&&!expected.actions.length)throw fail('case-invalid-actions',metrics);
 const product=expected.product;
 const action=batch?expected.actions.map(expectedServiceAction):expectedServiceAction(expected);
 const t=performance.now();
 try{
  const r=await service.calculatePretrade(product,action);
  metrics.backendTimings=r.timings??r.result?.timings??null;
  if(r.status!=='success')throw fail('calculation-failed',metrics);
  const business={...r.result};delete business.timings;
  metrics.dataDate=business.date;metrics.baselineHash=digest(business.before);metrics.baselineMetricsHash=digest(business.before?.metrics);metrics.backendRunIdHash=digest(r.id);metrics.netAssets=business.before?.metrics?.net_assets??null;
  if(testCase.dataDate&&metrics.dataDate!==testCase.dataDate)throw fail('data-date-changed',metrics);
  if(testCase.baselineHash&&metrics.baselineHash!==testCase.baselineHash)throw fail('baseline-changed',metrics);
    if(testCase.baselineMetricsHash&&metrics.baselineMetricsHash!==testCase.baselineMetricsHash)throw fail('baseline-metrics-changed',metrics);
  metrics.businessHash=digest(business);metrics.calculationCalls=1;
  return metrics;
 }catch(e){if(!e.chainMetrics)e.chainMetrics=metrics;throw e;}finally{metrics.calculationMs=performance.now()-t;}
}
