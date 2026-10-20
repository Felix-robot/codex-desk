const{test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const{spawn}=require('node:child_process');const{once}=require('node:events');
test('Windows updater waits for the app PID, then invokes the installer with a spaced path',{skip:process.platform!=='win32',timeout:20000},async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'desk update 空格-')));fs.mkdirSync(path.join(root,'artifacts'));
  fs.writeFileSync(path.join(root,'setup-windows.ps1'),"param([switch]$Launch)\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'updated.marker'),[string]$Launch)\n",'utf8');
  const blocker=spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{windowsHide:true,stdio:'ignore'});
  await once(blocker,'spawn');const helper=spawn(process.execPath,[path.join(__dirname,'..','scripts','update-installed.cjs'),root,String(blocker.pid)],{windowsHide:true,stdio:'pipe'});
  let errors='';helper.stderr.on('data',b=>errors+=b);const ended=once(helper,'exit');
  try{await new Promise(r=>setTimeout(r,500));assert.equal(fs.existsSync(path.join(root,'updated.marker')),false);const[code]=await ended;assert.equal(code,0,errors);assert.equal(fs.readFileSync(path.join(root,'updated.marker'),'utf8'),'True');}
  finally{blocker.kill();helper.kill();}
});
