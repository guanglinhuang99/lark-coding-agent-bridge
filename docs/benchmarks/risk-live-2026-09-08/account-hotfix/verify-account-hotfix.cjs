const fs=require('fs'),vm=require('vm'),assert=require('assert');
const stage=fs.readFileSync('/tmp/account-hotfix-stage.txt','utf8');
const bundle=fs.readFileSync(stage+'/dist/wecom.js','utf8');
const start=bundle.indexOf('// src/wecom/risk/parser.ts');
const end=bundle.indexOf('// src/wecom/risk/formatter.ts');
const context=vm.createContext({});vm.runInContext(bundle.slice(start,end),context);
const products=['安联ESG专精特新资产管理产品','安联ESG成长甄选1号资产管理产品','安联ESG纯债1号资产管理产品','安联ESG量化成长1号资产管理产品','安联ESG量化精选1号资产管理产品','安联资产ESG1号资产管理产品'];
const text='/测算\n我司【ESG1号产品】明天（9.9）拟投资以下信用债（信评系统已发起）。\n烦请风险管理部同事确认、ESG同事评估，非常感谢！\n&#x20;\n1、 3.93Y 102583394.IB 25深圳特发MTN003  1.76  1000w&#x20;\n2、3.69Y+5Y(休1) 232580009.IB 25中信银行二级资本债01BC  1.7125行权  4000w。';
(async()=>{
 for(const account of ['ESG1号产品','ESG1号','']) {
  const draft=context.parseRiskIntentOutputPartial(JSON.stringify({account_query:account,transactions:[{action:'buy',security_query:'102583394.IB',amount_text:'1000w'},{action:'buy',security_query:'232580009.IB',amount_text:'4000w'}]}),text);
  const state=await context.normalizeRiskDraft(text,draft,{listProducts:async()=>products,searchSecurities:async q=>[{code:q,name:q,label:q}]});
  assert.equal(state.stage,'confirm');assert.equal(state.product,products[5]);assert.equal(state.draft.transactions.length,2);
 }
 console.log('Release artifact: 3 account variants resolved to 安联资产ESG1号资产管理产品; both bonds preserved.');
})().catch(e=>{console.error(e);process.exitCode=1});
