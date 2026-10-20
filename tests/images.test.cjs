const{test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const{Images}=require('../src/images.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
test('image generation validates live catalog, stores PNG locally, never returns credentials',async()=>{
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'desk-image-'))),requests=[];
  const images=new Images({directory,connection:()=>({baseUrl:'https://relay.invalid/v1',key:'fixture-secret'}),readInput:async()=>({bytes:png,mime:'image/png'}),fetchImpl:async(url,request)=>{
    requests.push({url,request});return new Response(JSON.stringify(url.endsWith('/models')?{data:[{id:'gpt-image-1'},{id:'gpt-6.1-sol'}]}:{data:[{b64_json:png.toString('base64')}]}),{headers:{'Content-Type':'application/json'}});
  }});
  assert.deepEqual(await images.models(),['gpt-image-1']);const result=await images.generate({id:'test',model:'gpt-image-1',prompt:'a test square'});assert.ok(fs.readFileSync(result.path).equals(png));assert.doesNotMatch(JSON.stringify(result),/fixture-secret/);
  const sent=requests.find(r=>r.url.endsWith('/generations'));assert.equal(sent.request.headers.Authorization,'Bearer fixture-secret');assert.equal(JSON.parse(sent.request.body).quality,'low');
  await assert.rejects(images.generate({id:'absent',model:'not-listed',prompt:'test'}),/列表/);
  await images.generate({id:'edit',model:'gpt-image-1',prompt:'edit',editPath:'image.png',transparent:true});const edit=requests.find(r=>r.url.endsWith('/edits'));assert.ok(edit.request.body instanceof FormData);assert.equal(edit.request.body.get('background'),'transparent');assert.ok(edit.request.body.get('image[]') instanceof Blob);
});
test('image failures do not expose service payloads; URLs are not fetched; cancellation works',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'desk-image-error-'));let mode='error';
  const images=new Images({directory,connection:()=>({baseUrl:'https://relay.invalid/v1',key:'fixture-secret'}),fetchImpl:async(url,request)=>{
    if(url.endsWith('/models'))return new Response(JSON.stringify({data:[{id:'gpt-image-1'}]}));
    if(mode==='cancel')return new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('aborted'))));
    return mode==='url'?new Response(JSON.stringify({data:[{url:'http://127.0.0.1/private'}]})):new Response('fixture-secret private service body',{status:403});
  }});
  await assert.rejects(images.generate({id:'error',model:'gpt-image-1',prompt:'test'}),e=>e.message.includes('403')&&!e.message.includes('fixture-secret'));
  mode='url';await assert.rejects(images.generate({id:'url',model:'gpt-image-1',prompt:'test'}),/base64/);
  mode='cancel';const pending=images.generate({id:'cancel',model:'gpt-image-1',prompt:'test'});await new Promise(r=>setTimeout(r,10));images.cancel('cancel');await assert.rejects(pending,/取消/);assert.equal(images.active.size,0);
});
test('Mac runtime adapter contains native bin paths rather than Windows executables',async()=>{
  const{runtimePaths}=await import('../local-tools/lib/integrations.mjs');const tools=runtimePaths('/tmp/codex-desk-tools','darwin');assert.doesNotMatch(tools.python,/\.exe$|Scripts/);assert.match(tools.python,/python3$/);assert.doesNotMatch(tools.node,/\.exe$/);assert.ok(!String(tools.browser).includes('C:/'));
});
