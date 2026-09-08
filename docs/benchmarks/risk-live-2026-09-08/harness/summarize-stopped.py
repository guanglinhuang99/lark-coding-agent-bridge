from pathlib import Path
import json,statistics,math,sys
p=Path(sys.argv[1]) # Directory with samples.jsonl, pairs.jsonl and controlled-stop.json
rows=[json.loads(x) for x in (p/'samples.jsonl').read_text().splitlines()]
pairs=[json.loads(x) for x in (p/'pairs.jsonl').read_text().splitlines()]
stop=json.loads((p/'controlled-stop.json').read_text())
d={'kind':'real-client-read-only-query','controlled_stop':stop,'scenarios':{}}
for scenario in dict.fromkeys(r['scenario'] for r in rows):
 x={}
 for version in ['before','after']:
  a=[r for r in rows if r['scenario']==scenario and r['version']==version];ok=[r for r in a if r['success']];ts=sorted(r['totalMs'] for r in ok)
  x[version]={'n':len(a),'success':len(ok),'failures':len(a)-len(ok),'successRate':len(ok)/len(a) if a else None,'median':statistics.median(ts) if ts else None,'p95':ts[math.ceil(len(ts)*.95)-1] if ts else None,'backendRequests':sum(sum(r['backendRequests'].values()) for r in a)}
 b=x['before']['median'];a=x['after']['median'];x['absoluteReductionMs']=b-a if b is not None and a is not None else None;x['reductionPercent']=(1-a/b)*100 if b and a is not None else None
 checks=[r for r in pairs if r['scenario']==scenario];x['consistentPairs']=sum(r['consistent'] for r in checks);x['businessConsistent']=bool(checks) and all(r['consistent'] for r in checks)
 d['scenarios'][scenario]=x
 d['scenarios']['security_concurrent_mixed']={'status':'cancelled-invalid-scenario','distinctQueryCount':7,'completedPairs':0,'inFlightAtStop':'unobserved; up to one batch may have been submitted; excluded from performance, explicitly recorded here'}
(p/'summary.json').write_text(json.dumps(d,indent=2)+'\n')
print(json.dumps(d,indent=2))
