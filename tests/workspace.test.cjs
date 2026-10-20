const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Workspace, run } = require('../src/workspace.cjs');

function fixture() {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'desk-workspace-'))), project=path.join(root,'project'), data=path.join(root,'data');fs.mkdirSync(project);fs.mkdirSync(data);
  return {root,project,data,workspace:new Workspace({directory:data,roots:()=>[project]})};
}
test('damaged workspace metadata is preserved and does not prevent the client from starting',()=>{
  const {data,project}=fixture();fs.writeFileSync(path.join(data,'workspace.json'),'{bad json');const w=new Workspace({directory:data,roots:()=>[project]});assert.match(w.data.notice,/已备份/);assert.equal(w.data.jobs.length,0);assert.ok(fs.readdirSync(data).some(name=>name.startsWith('workspace.json.invalid-')));
});
test('editor saves checkpoints, rejects stale revisions, restores and enforces boundaries',()=>{
  const {root,project,data,workspace:w}=fixture();const file=path.join(project,'资料.md');fs.writeFileSync(file,'原内容\r\n');fs.writeFileSync(path.join(root,'outside.txt'),'outside');fs.writeFileSync(path.join(project,'.env'),'private');
  const first=w.read(project,file);const next=w.write(project,file,'新内容\n',first.revision);assert.equal(next.text,'新内容\n');
  assert.throws(()=>w.write(project,file,'覆盖',first.revision),/其他程序/);
  const snapshots=w.snapshots(file);assert.equal(snapshots.length,1);assert.equal(w.restore(project,file,snapshots[0].id,next.revision).text,first.text);
  assert.throws(()=>w.read(project,'../outside.txt'),/范围/);assert.throws(()=>w.read(project,'.env'),/范围/);assert.throws(()=>w.read(project,path.join(data,'workspace.json')),/范围/);
  assert.ok(!w.tree(project).entries.some(e=>e.name==='.env'));
  const ro=new Workspace({directory:data,roots:()=>[project],readonly:()=>true});assert.throws(()=>ro.write(project,file,'no',w.read(project,file).revision),/只读/);
});
test('real git: stage one hunk, stale patch protection, commit, branch, worktree and deleted file',async()=>{
  const {root,project,workspace:w}=fixture();const git=args=>run('git',args,project);
  await git(['init']);await git(['config','user.name','Desk Test']);await git(['config','user.email','desk@example.invalid']);
  const file=path.join(project,'中文 空格.txt');const original=Array.from({length:40},(_,i)=>`line ${i}`).join('\n')+'\n';fs.writeFileSync(file,original);await git(['add','.']);await git(['commit','-m','initial']);
  fs.writeFileSync(file,original.replace('line 1\n','first change\n').replace('line 35\n','last change\n'));
  const diff=await w.git(project,'fileDiff',{path:file});assert.equal(diff.diff.split(/^@@ /m).length,3);
  await w.git(project,'stageHunk',{path:file,index:0,revision:diff.revision});
  assert.match(await git(['diff','--cached']),/first change/);assert.doesNotMatch(await git(['diff','--cached']),/last change/);
  await assert.rejects(w.git(project,'stageHunk',{path:file,index:1,revision:diff.revision}),/差异已变化/);
  await w.git(project,'stage',{path:'中文 空格.txt'});await w.git(project,'commit',{message:'both hunks'});
  const status=await w.git(project,'status');assert.equal(status.files.length,0);
  await w.git(project,'branch',{branch:'desk-test-branch'});await w.git(project,'switch',{branch:status.branch});
  const destination=path.join(root,'new worktree');await w.git(project,'worktree',{branch:'desk-test-branch',destination});assert.ok(fs.existsSync(path.join(destination,'中文 空格.txt')));
  fs.unlinkSync(file);await w.git(project,'stage',{path:'中文 空格.txt'});assert.match(await git(['diff','--cached','--name-status']),/D/);
  await assert.rejects(w.git(project,'stage',{path:'../outside.txt'}),/无效/);
});
test('queue scheduling is persistent, serialized, missed schedules skip, restart does not replay running work',async()=>{
  const {data,project,workspace:w}=fixture();const now=Date.now();let busy=false,starts=0;
  w.addJob({threadId:'thread1',text:'first'});w.addJob({threadId:'thread1',text:'second'});
  const dependencies={active:()=>busy,start:async()=>{busy=true;starts++;return {turn:{id:'turn'+starts}};}};
  await Promise.all([w.pump(dependencies),w.pump(dependencies)]);assert.equal(starts,1);assert.equal(w.data.jobs[1].status,'queued');
  w.complete('thread1',{id:'turn1',status:'completed'});busy=false;await w.pump(dependencies);assert.equal(starts,2);
  const restarted=new Workspace({directory:data,roots:()=>[project]});assert.equal(restarted.data.jobs[1].status,'interrupted');
  const late=w.addJob({threadId:'later',text:'scheduled',when:new Date(now+3600000).toISOString()});await w.pump({active:()=>false,start:dependencies.start},now+4000000);assert.equal(late.status,'missed');
  const future=w.addJob({threadId:'future',text:'interval',when:new Date(now+3600000).toISOString(),interval:30});w.cancelJob(future.id);assert.equal(future.status,'cancelled');
});
