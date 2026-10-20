// Install the shared source into a self-contained app; never alter official apps.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import setup from './setup-runtime.cjs';
const require=createRequire(import.meta.url);
const {sourceHash}=require('./source-manifest.cjs');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if(process.platform!=='darwin')throw new Error('Mac installer must run on macOS');
const applications=path.join(os.homedir(),'Applications');fs.mkdirSync(applications,{recursive:true});
const installed=path.join(applications,'Codex Desk.app');
// Avoid replacing a bundle used by a running task; the menu updater exits first.
try {
  const output=execFileSync('/bin/ps',['-axo','command='],{encoding:'utf8'});
  if(output.split('\n').some(line=>line.trim().startsWith(path.join(installed,'Contents','MacOS')+'/')))throw new Error('请先从菜单栏退出 Codex Desk，再更新。');
} catch(error){if(error.message.includes('请先'))throw error;}
await setup.prepareRuntime({root});
await import('./package-mac.mjs');
const built=path.join(root,'release','Codex Desk-darwin-'+process.arch,'Codex Desk.app');
if(!fs.existsSync(path.join(built,'Contents','MacOS','Codex Desk')))throw new Error('Mac build output not found');
const staging=path.join(applications,`.CodexDesk-${process.pid}.app`), previous=path.join(applications,'Codex Desk.previous.app');
fs.cpSync(built,staging,{recursive:true});
execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',staging],{stdio:'inherit'});
if(!previous.startsWith(applications+path.sep)||path.basename(previous)!=='Codex Desk.previous.app')throw new Error('Invalid backup path');
if(fs.existsSync(previous))fs.rmSync(previous,{recursive:true});
if(fs.existsSync(installed))fs.renameSync(installed,previous);
try{fs.renameSync(staging,installed);}catch(error){if(fs.existsSync(previous))fs.renameSync(previous,installed);throw error;}
const data=path.join(os.homedir(),'Library','Application Support','Codex Desk');fs.mkdirSync(data,{recursive:true,mode:0o700});
fs.writeFileSync(path.join(data,'install-source.json'),JSON.stringify({source:root,sourceHash:sourceHash(root),installedAt:new Date().toISOString(),installed},null,2),{mode:0o600});
const localTools=path.join(installed,'Contents','Resources','local-tools');
const adapters=await import(pathToFileURL(path.join(localTools,'lib','integrations.mjs')).href);
const toolData=path.join(data,'tools');fs.mkdirSync(toolData,{recursive:true,mode:0o700});
const tools=adapters.runtimePaths(toolData),engineHome=path.join(data,'codex');
const env={PATH:[path.dirname(tools.python),path.dirname(tools.node),tools.poppler,process.env.PATH||'','/usr/bin','/bin'].join(path.delimiter),NODE_PATH:tools.nodeModules};
fs.writeFileSync(path.join(data,'local-tools.json'),JSON.stringify({engineHome,skillRoots:adapters.extraSkillRoots(),env},null,2),{mode:0o600});
const TOML=require('@iarna/toml'),extensionFile=path.join(data,'extensions.toml');
const extensions=fs.existsSync(extensionFile)?TOML.parse(fs.readFileSync(extensionFile,'utf8')):{};
extensions.mcp_servers={...extensions.mcp_servers,desk_tools:{...extensions.mcp_servers?.desk_tools,command:tools.node,args:[path.join(localTools,'tools','mcp-server.mjs')],env:{SUB2API_DESK_DATA:toolData,SUB2API_DESK_POLICY_FILE:path.join(data,'tool-permissions.json')},startup_timeout_sec:30,tool_timeout_sec:120}};
if(!extensions.mcp_servers.openai_docs)extensions.mcp_servers.openai_docs={url:'https://developers.openai.com/mcp',startup_timeout_sec:30,tool_timeout_sec:60};
fs.writeFileSync(extensionFile,TOML.stringify(extensions),{mode:0o600});
const desktop=path.join(os.homedir(),'Desktop','Codex Desk.app');
if(fs.existsSync(desktop)&&fs.lstatSync(desktop).isSymbolicLink())fs.unlinkSync(desktop);
if(!fs.existsSync(desktop))fs.symlinkSync(installed,desktop);
execFileSync('/usr/bin/open',[installed]);
console.log('Codex Desk 已更新；上一版保留在 ~/Applications/Codex Desk.previous.app。');
