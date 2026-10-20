const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|TOKEN|SECRET|AUTHORIZATION|COOKIE|PASSWORD)/i.test(name) && !/^(?:OPENAI|CHATGPT|CODEX_ACCESS|SKY_CUA)/i.test(name)).concat([['PYTHONIOENCODING','utf-8']]));
}
function execute(command, args, input, {timeout=20000, spawnImpl=spawn, onChild}={}) {
  return new Promise((resolve,reject) => {
    const proc=spawnImpl(command,args,{windowsHide:true,env:cleanEnv(),stdio:['pipe','pipe','ignore']});onChild?.(proc);
    let output='', settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{proc.kill();finish(new Error('本地操作超时，已停止'));},timeout);
    proc.stdout.on('data',bytes=>{output+=bytes;if(output.length>45*1024*1024){proc.kill();finish(new Error('本地输出超过上限'));}});
    proc.on('error',()=>finish(new Error('本地运行环境无法启动，请先安装依赖')));
    proc.on('exit',code=>{if(code!==0){let reason='本地操作失败，请检查系统权限';try{reason=JSON.parse(output).error||reason;}catch{}finish(new Error(reason));}else finish(null,output);});
    proc.stdin.on('error',()=>{});proc.stdin.end(input||'');
  });
}
class NativeDesktop {
  constructor({directory,python,spawnImpl=spawn}) { this.directory=directory;this.python=python;this.spawnImpl=spawnImpl;this.file=path.join(directory,'desktop-access.json'); }
  grant() {
    let data;try{data=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{}
    if(!data||!['ask','full'].includes(data.mode)||!(data.expiresAt>Date.now()))throw new Error('电脑控制未开启或已到期，请在输入框旁的「电脑」入口开启');
    return data;
  }
  async call(args, {approve=async()=>false,threadMode}={}) {
    const initial=this.grant();
    if(!['screenshot','click','doubleClick','move','drag','scroll','key','type'].includes(args.action))throw new Error('不支持的电脑操作');
    if(args.action!=='screenshot') {
      if(threadMode==='readonly')throw new Error('当前对话为只读模式，不能操作电脑');
      if(initial.mode!=='full' && !await approve('电脑操作：'+args.action+'\n'+JSON.stringify(args)))return{approved:false};
      const current=this.grant();if(initial.id!==current.id)throw new Error('控制授权已变更，操作已停止');
    }
    return JSON.parse(await execute(this.python,[path.join(__dirname,'..','native','desktop.py')],JSON.stringify(args),{spawnImpl:this.spawnImpl}));
  }
}
class LocalVoice {
  constructor({directory,python,send=()=>{},spawnImpl=spawn}) {this.directory=directory;this.python=python;this.send=send;this.spawnImpl=spawnImpl;this.session=0;this.proc=null;this.synth=null;}
  async status() {
    let modules={};
    try{modules=JSON.parse(await execute(this.python,['-c',"import importlib.util,json;print(json.dumps({m:bool(importlib.util.find_spec(m)) for m in ['vosk','sounddevice','pyautogui']}))"],'',{spawnImpl:this.spawnImpl}));}catch{}
    return{modules,model:fs.existsSync(path.join(this.directory,'tools','voice','vosk-model-small-cn-0.22','am','final.mdl')),listening:!!this.proc};
  }
  async start() {
    if(this.proc)return;
    const session=++this.session;
    const info=await this.status();if(!info.modules.vosk||!info.modules.sounddevice||!info.model)throw new Error('请先点击「安装本地依赖」');
    if(this.session!==session)return;
    const proc=this.spawnImpl(this.python,[path.join(__dirname,'..','native','listen.py'),path.join(this.directory,'tools','voice','vosk-model-small-cn-0.22')],{windowsHide:true,env:cleanEnv(),stdio:['pipe','pipe','ignore']});this.proc=proc;
    proc.stdin.on('error',()=>{});
    readline.createInterface({input:proc.stdout}).on('line',line=>{if(this.session!==session)return;try{const event=JSON.parse(line);if(['ready','partial','final','error'].includes(event.type))this.send({method:'desk/voice',params:{...event,text:String(event.text||'').slice(0,2000)}});}catch{}});
    proc.on('error',()=>{if(this.session===session){this.proc=null;this.send({method:'desk/voice',params:{type:'error',message:'无法启动本地识别，请安装依赖'}});}});
    proc.on('exit',()=>{if(this.session===session){this.proc=null;this.send({method:'desk/voice',params:{type:'stopped'}});}});
  }
  pause(value) {if(this.proc?.stdin.writable)this.proc.stdin.write(JSON.stringify({command:value?'pause':'resume'})+'\n');}
  cancelSpeech() {this.synth?.kill();this.synth=null;}
  stop() {this.session++;this.proc?.kill();this.proc=null;this.synth?.kill();this.synth=null;this.send({method:'desk/voice',params:{type:'stopped'}});}
  async speech(text) {
    if(typeof text!=='string'||!text.trim()||text.length>6000)throw new Error('朗读文字需为1至6000字');
    this.synth?.kill();const id=randomUUID(), folder=path.join(this.directory,'voice-temp'), output=path.join(folder,id+'.wav');
    fs.mkdirSync(folder,{recursive:true,mode:0o700});
    let child;
    try{
      if(process.platform==='win32')await execute(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'..','native','speak.ps1')],JSON.stringify({text,output}),{timeout:60000,spawnImpl:this.spawnImpl,onChild:proc=>{child=this.synth=proc;}});
      else if(process.platform==='darwin')await execute('/usr/bin/say',['--file-format=WAVE','--data-format=LEI16@22050','-o',output],text,{timeout:60000,spawnImpl:this.spawnImpl,onChild:proc=>{child=this.synth=proc;}});
      else throw new Error('系统朗读仅支持 Windows / macOS');
      if(this.synth!==child)throw new Error('朗读已停止');
      const bytes=fs.readFileSync(output);if(bytes.length>30*1024*1024)throw new Error('朗读音频过长');
      return 'data:audio/wav;base64,'+bytes.toString('base64');
    }finally{if(this.synth===child)this.synth=null;try{fs.unlinkSync(output);}catch{}}
  }
}
module.exports={NativeDesktop,LocalVoice,execute,cleanEnv};
