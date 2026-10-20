// This detached helper starts only from an explicit in-app update action.
const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const [source,pidInput]=process.argv.slice(2),pid=Number(pidInput);
if(!path.isAbsolute(source)||!Number.isSafeInteger(pid)||pid<=1)throw new Error('Invalid update arguments');
let attempts=0;
const timer=setInterval(()=>{
  let alive=false;try{process.kill(pid,0);alive=true;}catch{}
  if(alive){if(++attempts>180){clearInterval(timer);process.exitCode=1;}return;}
  clearInterval(timer);
  const log=fs.openSync(path.join(source,'artifacts','local-update.log'),'a');
  const command=process.platform==='win32'?'powershell.exe':process.execPath;
  const args=process.platform==='win32'?['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(source,'setup-windows.ps1'),'-Launch']:[path.join(source,'scripts','install-mac.mjs')];
  const child=spawn(command,args,{cwd:source,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined},windowsHide:true,stdio:['ignore',log,log]});
  child.on('exit',code=>{fs.closeSync(log);process.exitCode=code||0;});child.on('error',()=>{fs.closeSync(log);process.exitCode=1;});
},500);
