const fs = require('fs');
const path = require('path');
const ts = require(process.cwd() + '/node_modules/typescript');
const crypto = require('crypto');
const base = '/Users/guanglin/.lark-channel/releases/wecom-risk-batch-20260908-60a6bf0d9956';
const stage = fs.mkdtempSync('/tmp/wecom-account-hotfix-');
fs.cpSync(base + '/dist', stage + '/dist', {recursive:true});
fs.cpSync(base + '/bin', stage + '/bin', {recursive:true});
fs.cpSync(base + '/risk-bridge', stage + '/risk-bridge', {recursive:true});
for (const name of ['package.json','pnpm-lock.yaml']) fs.copyFileSync(base+'/'+name, stage+'/'+name);
const functions = {matchProductCandidates:'src/wecom/risk/parser.ts', normalizeProductText:'src/wecom/risk/parser.ts', inferAccountQuery:'src/wecom/risk/intent.ts'};
function declarations(text) {
 const ast = ts.createSourceFile('bundle.js',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 return ast.statements.filter(ts.isFunctionDeclaration);
}
const replacements = {};
for (const [name, file] of Object.entries(functions)) {
 const source = fs.readFileSync(file,'utf8');
 const js = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const node = declarations(js).find(n=>n.name?.text===name);
 if (!node) throw Error(name);
 replacements[name]=js.slice(node.getStart(),node.end).replace(/^export /,'');
}
const changes=[];
for(const entry of ['wecom.js','cli.js','index.js']) {
 const file=stage+'/dist/'+entry; let text=fs.readFileSync(file,'utf8');
 const edits=declarations(text).filter(n=>replacements[n.name?.text]).map(n=>({name:n.name.text,start:n.getStart(),end:n.end}));
 for(const edit of edits.sort((a,b)=>b.start-a.start)) text=text.slice(0,edit.start)+replacements[edit.name]+text.slice(edit.end);
 fs.writeFileSync(file,text); changes.push({entry,functions:edits.map(x=>x.name)});
}
if (changes.find(x=>x.entry==='wecom.js').functions.length!==3) throw Error('Missing hotfix functions');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const m={baseRelease:base,baseArtifactSha256:sha(base+'/dist/wecom.js'),artifactSha256:sha(stage+'/dist/wecom.js'),changes,sourceHashes:Object.fromEntries([...new Set(Object.values(functions))].map(f=>[f,sha(f)])),buildMethod:'Replace only three top-level function declarations with TypeScript-transpiled source; retain all other release bytes',model:'gpt-5.6-luna'};
fs.writeFileSync(stage+'/account-hotfix-manifest.json',JSON.stringify(m,null,2));
fs.writeFileSync('/tmp/account-hotfix-stage.txt',stage);
console.log(JSON.stringify({stage,...m}));
