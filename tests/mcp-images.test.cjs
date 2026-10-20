const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {CodexBridge}=require('../src/bridge.cjs');const {SettingsStore,writePrivate}=require('../src/storage.cjs');const {mockProvider}=require('./mock-provider.cjs');
const binary=process.env.DESK_TEST_BINARY||path.join(__dirname,'..','runtime','codex',process.platform==='win32'?'codex.exe':'codex');
test('real app-server discovers and executes the credential-isolated image MCP tool',{skip:!fs.existsSync(binary),timeout:60000},async()=>{
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'desk-mcp-image-'))),provider=await mockProvider({images:true}),key='mcp-test-private-key';
  const store=new SettingsStore(directory,{isEncryptionAvailable:()=>false});store.save({baseUrl:provider.url,model:'desk-test-model',apiKey:key,rememberKey:false});store.addProject(directory);
  writePrivate(path.join(directory,'extensions.toml'),require('@iarna/toml').stringify({mcp_servers:{desk_tools:{command:process.execPath,args:[path.join(__dirname,'..','local-tools','tools','mcp-server.mjs')],env_vars:['CODEX_DESK_API_KEY'],env:{SUB2API_DESK_DATA:directory,CODEX_DESK_IMAGE_BASE_URL:provider.url,CODEX_DESK_IMAGE_OUTPUT:directory,CODEX_DESK_PROJECT_ROOTS:JSON.stringify([directory])},startup_timeout_sec:20,tool_timeout_sec:30}}}));store.writeConfig();
  const bridge=new CodexBridge({binary,home:store.codexHome,env:{CODEX_DESK_API_KEY:key}});const requests=[];bridge.on('request',r=>{requests.push(r);if(r.method.includes('Approval'))bridge.respond(r.id,{decision:'accept'});});
  try{
    await bridge.start();const{thread}=await bridge.request('thread/start',{cwd:directory,model:'desk-test-model',approvalPolicy:'never',sandbox:'workspace-write'});
    const mcp=await bridge.request('mcpServerStatus/list',{threadId:thread.id});assert.ok(Object.keys(mcp.data.find(s=>s.name==='desk_tools').tools).some(n=>n==='image_generate'));
    assert.ok(Object.keys(mcp.data.find(s=>s.name==='desk_tools').tools).includes('desktop_action'));
    const denied=await bridge.request('mcpServer/tool/call',{threadId:thread.id,server:'desk_tools',tool:'desktop_screenshot',arguments:{}});assert.match(JSON.stringify(denied),/重开新版|未开启/);
    const models=await bridge.request('mcpServer/tool/call',{threadId:thread.id,server:'desk_tools',tool:'image_models',arguments:{}});assert.match(JSON.stringify(models),/gpt-image-1/);
    const result=await bridge.request('mcpServer/tool/call',{threadId:thread.id,server:'desk_tools',tool:'image_generate',arguments:{model:'gpt-image-1',prompt:'mock test square'}});
    assert.doesNotMatch(JSON.stringify(result),/mcp-test-private-key/);assert.ok(fs.readdirSync(path.join(directory,'attachments')).some(n=>n.endsWith('.png')));
    assert.doesNotMatch(fs.readFileSync(path.join(store.codexHome,'config.toml'),'utf8'),/mcp-test-private-key/);
  }finally{bridge.stop();provider.server.closeAllConnections();await new Promise(r=>provider.server.close(r));}
});
