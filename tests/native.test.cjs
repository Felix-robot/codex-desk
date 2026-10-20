const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const {NativeDesktop,LocalVoice,cleanEnv}=require('../local-tools/lib/native.cjs');
test('desktop defaults closed, expires, readonly and approval/revocation gates prevent actions',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'desk-native-')),file=path.join(directory,'desktop-access.json');let calls=0;
  const spawnImpl=(command,args,options)=>{calls++;assert.equal(options.windowsHide,true);const p=new EventEmitter();p.stdin=new PassThrough();p.stdout=new PassThrough();p.kill=()=>{};setImmediate(()=>{p.stdout.write(JSON.stringify({ok:true,width:800,height:600}));p.emit('exit',0);});return p;};
  const service=new NativeDesktop({directory,python:'fixture-python',spawnImpl}),grant=(mode='ask',expiresAt=Date.now()+60000)=>fs.writeFileSync(file,JSON.stringify({mode,expiresAt,id:'first'}));
  await assert.rejects(service.call({action:'screenshot'}),/未开启/);grant('full',0);await assert.rejects(service.call({action:'click',x:1,y:1}),/到期/);grant();
  assert.equal((await service.call({action:'click',x:1,y:1})).approved,false);assert.equal(calls,0);
  await assert.rejects(service.call({action:'click'},{threadMode:'readonly'}),/只读/);
  await assert.rejects(service.call({action:'click'},{approve:async()=>{fs.writeFileSync(file,'{"mode":"off"}');return true;}}),/未开启/);assert.equal(calls,0);
  grant('full');await service.call({action:'click',x:4,y:5});assert.equal(calls,1);grant();await service.call({action:'screenshot'});assert.equal(calls,2);
  fs.rmSync(directory,{recursive:true,force:true});
});
test('native subprocesses strip inherited credentials and voice stop kills local child',()=>{
  process.env.DESK_NATIVE_TEST_TOKEN='fixture-secret';assert.equal(cleanEnv().DESK_NATIVE_TEST_TOKEN,undefined);delete process.env.DESK_NATIVE_TEST_TOKEN;
  let killed=false;const voice=new LocalVoice({directory:os.tmpdir(),python:'fixture'});voice.proc={kill(){killed=true;}};voice.stop();assert.equal(killed,true);assert.equal(voice.proc,null);
});
