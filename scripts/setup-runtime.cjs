// Assemble an ignored local runtime from the pinned public npm distribution.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');
function dataDirectory(){return process.env.CODEX_DESK_DATA_DIR||(process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support','Codex Desk'):path.join(os.homedir(),'.codex-desk'));}
function findFiles(directory,predicate,depth=0){
  if(!fs.existsSync(directory)||depth>9)return[];
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{const file=path.join(directory,entry.name);return entry.isDirectory()?findFiles(file,predicate,depth+1):entry.isFile()&&predicate(entry.name)?[file]:[];});
}
async function prepareRuntime({root=path.resolve(__dirname,'..'),data=dataDirectory(),configure=true}={}){
  const electronRoot=path.join(root,'node_modules','electron');
  const electronBinary=path.join(electronRoot,'dist',process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':process.platform==='win32'?'electron.exe':'electron');
  if(!fs.existsSync(electronBinary)){
    require('node:child_process').execFileSync(process.execPath,[path.join(electronRoot,'install.js')],{cwd:root,stdio:'inherit'});
    if(!fs.existsSync(electronBinary))throw new Error('Electron binary missing. Disable ELECTRON_SKIP_BINARY_DOWNLOAD and retry npm run setup.');
  }
  const executable=process.platform==='win32'?'codex.exe':'codex';
  const output=path.join(root,'runtime','codex');
  const candidates=findFiles(path.join(root,'node_modules','@openai'),name=>name===executable);
  const triples={win32:{x64:'x86_64-pc-windows-msvc',arm64:'aarch64-pc-windows-msvc'},darwin:{x64:'x86_64-apple-darwin',arm64:'aarch64-apple-darwin'},linux:{x64:'x86_64-unknown-linux-musl',arm64:'aarch64-unknown-linux-musl'}};
  const triple=triples[process.platform]?.[process.arch];
  const selected=candidates.find(file=>triple&&file.includes(triple))||candidates[0];
  if(selected){
    fs.mkdirSync(output,{recursive:true});fs.cpSync(path.dirname(selected),output,{recursive:true});
    const rg=findFiles(path.join(root,'node_modules','@openai'),name=>name===(process.platform==='win32'?'rg.exe':'rg')).find(file=>!triple||file.includes(triple));
    if(rg)fs.copyFileSync(rg,path.join(output,path.basename(rg)));
  }
  const binary=path.join(output,executable),host=path.join(output,'codex-code-mode-host'+(process.platform==='win32'?'.exe':''));
  if(!fs.existsSync(binary)||!fs.existsSync(host))throw new Error('Pinned Codex runtime or Code Mode host missing. Run npm ci with optional dependencies enabled.');
  if(process.platform!=='win32')for(const file of fs.readdirSync(output))if(!path.extname(file))fs.chmodSync(path.join(output,file),0o755);
  if(configure){
    const tools=path.join(data,'tools'),node=path.join(tools,'runtime',process.platform==='win32'?'node.exe':'node');fs.mkdirSync(path.dirname(node),{recursive:true,mode:0o700});
    if(path.resolve(node)!==path.resolve(process.execPath))fs.copyFileSync(process.execPath,node);
    if(process.platform!=='win32')fs.chmodSync(node,0o755);
    const {runtimePaths,extraSkillRoots}=await import(pathToFileURL(path.join(root,'local-tools','lib','integrations.mjs')).href);
    const {writePrivate}=require(path.join(root,'src','storage.cjs')),TOML=require(path.join(root,'node_modules','@iarna','toml'));
    const adapters=runtimePaths(tools),engineHome=path.join(data,'codex'),configuration=path.join(data,'local-tools.json');
    const previous=fs.existsSync(configuration)?JSON.parse(fs.readFileSync(configuration,'utf8')):{};
    const env={PATH:[path.dirname(adapters.python),path.dirname(node),process.env.PATH||''].join(path.delimiter)};
    writePrivate(configuration,JSON.stringify({...previous,engineHome:previous.engineHome||engineHome,skillRoots:previous.skillRoots||extraSkillRoots(),env:{...previous.env,...env}},null,2));
    const extensionsFile=path.join(data,'extensions.toml');
    const extensions=fs.existsSync(extensionsFile)?TOML.parse(fs.readFileSync(extensionsFile,'utf8')):{};
    extensions.mcp_servers={...extensions.mcp_servers,desk_tools:{...extensions.mcp_servers?.desk_tools,command:node,args:[path.join(root,'local-tools','tools','mcp-server.mjs')],env:{SUB2API_DESK_DATA:tools,SUB2API_DESK_POLICY_FILE:path.join(data,'tool-permissions.json')},startup_timeout_sec:30,tool_timeout_sec:120}};
    writePrivate(extensionsFile,TOML.stringify(extensions));
  }
  return{binary,data,root};
}
module.exports={prepareRuntime,dataDirectory,findFiles};
if(require.main===module)prepareRuntime({configure:!process.argv.includes('--runtime-only')}).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
