import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import dns from 'node:dns/promises';
import net from 'node:net';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runtimePaths, pythonProbe } from '../lib/integrations.mjs';
import { spawn } from 'node:child_process';
import nativeLibrary from '../lib/native.cjs';

const DATA = process.env.SUB2API_DESK_DATA || path.join(os.homedir(), '.codex-desk', 'tools');
const imageCredential=process.env.SUB2API_API_KEY||process.env.CODEX_DESK_API_KEY||'';
// No model or official-account credential is needed by local tools or browsers.
for (const k of Object.keys(process.env)) if (/^(SUB2API_API_KEY|CODEX_DESK_API_KEY|OPENAI|CHATGPT|CODEX_ACCESS|CODEX_API|SKY_CUA|NODE_REPL)/i.test(k)) delete process.env[k];
const paths = runtimePaths(DATA);
const waiting = new Map(); let sequence = 0; let browser, page;
const write = data => process.stdout.write(JSON.stringify(data) + '\n');
const text = value => ({ content: [{ type:'text', text:typeof value === 'string' ? value : JSON.stringify(value) }] });
let imageService;
async function images() {
  if(imageService)return imageService;
  if(!imageCredential||!process.env.CODEX_DESK_IMAGE_BASE_URL)throw new Error('图像工具尚未由 Codex Desk 配置，请重开新版应用。');
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const library=[path.join(root,'..','src','images.cjs'),path.join(root,'..','images.cjs')].find(fs.existsSync);
  if(!library)throw new Error('图像运行库尚未安装');
  const {Images}=await import(pathToFileURL(library).href);
  const output=process.env.CODEX_DESK_IMAGE_OUTPUT||DATA;
  const roots=JSON.parse(process.env.CODEX_DESK_PROJECT_ROOTS||'[]');
  imageService=new Images({directory:output,connection:()=>({baseUrl:process.env.CODEX_DESK_IMAGE_BASE_URL,key:imageCredential}),readInput:async input=>{
    const file=fs.realpathSync(input),official=path.join(os.homedir(),'.codex');
    const contains=(root,target)=>{const relative=path.relative(fs.realpathSync(root),target);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
    if(fs.existsSync(official)&&contains(official,file)||!roots.concat(path.join(output,'attachments')).some(root=>fs.existsSync(root)&&contains(root,file)))throw new Error('原图不在项目或本机附件目录内');
    if(!/\.(png|jpe?g|webp)$/i.test(file)||fs.statSync(file).size>20*1024*1024)throw new Error('原图需为20 MB以内的 PNG/JPEG/WebP');
    const bytes=fs.readFileSync(file);if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&!bytes.subarray(0,3).equals(Buffer.from([255,216,255]))&&!(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'))throw new Error('文件不是有效的图像格式');
    return{bytes,mime:/\.png$/i.test(file)?'image/png':/\.webp$/i.test(file)?'image/webp':'image/jpeg'};
  }});return imageService;
}

export function privateAddress(ip) {
  const address = ip.replace(/^::ffff:/i,'').toLowerCase();
  if (net.isIP(address) === 6) return !/^[23]/.test(address) || address.startsWith('2001:db8:');
  const p = address.split('.').map(Number);
  return p.length !== 4 || p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || p[0] === 169 && p[1] === 254 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 192 && p[1] === 168 || p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}
export async function publicUrl(raw) {
  const url = new URL(raw);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('只接受没有账号凭据的公开 HTTP/HTTPS 地址。');
  const host = url.hostname.replace(/^\[|\]$/g,'');
  const found = net.isIP(host) ? [{ address:host }] : await dns.lookup(host,{all:true});
  if (!found.length || found.some(x=>privateAddress(x.address))) throw new Error('公开网页工具不访问本机、内网或元数据地址。项目本地服务请使用终端工具。');
  return url;
}
async function readPage(raw) {
  let url = await publicUrl(raw);
  for (let i=0;i<6;i++) {
    const response = await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(25000),headers:{'User-Agent':'Sub2APIDesk/0.1'}});
    if ([301,302,303,307,308].includes(response.status)) { await response.body?.cancel(); url = await publicUrl(new URL(response.headers.get('location'),url).href); continue; }
    const type=response.headers.get('content-type') || '';
    if (!/text|json|xml|html/.test(type)) {await response.body?.cancel();throw new Error('此接口只读取文本页面。');}
    const reader=response.body.getReader();const chunks=[];let size=0;
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1500000){await reader.cancel();break}chunks.push(Buffer.from(value));}
    let body=Buffer.concat(chunks).toString('utf8');
    if (/html/.test(type)) body=body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
    return {url:url.href,status:response.status,text:body.slice(0,45000),untrustedSource:true};
  }
  throw new Error('页面重定向过多。');
}
async function getPage() {
  if (!page || page.isClosed()) {
    const {chromium}=await import(pathToFileURL(paths.playwright).href);
    browser=await chromium.launch({executablePath:paths.browser,headless:true});
    const context=await browser.newContext({viewport:{width:1365,height:900},acceptDownloads:false});
    await context.route('**/*',async route=>{try{await publicUrl(route.request().url());await route.continue()}catch{await route.abort()}});
    page=await context.newPage();page.setDefaultTimeout(15000);
    page.on('dialog',dialog=>dialog.dismiss());
  }
  return page;
}
async function snapshot() {
  const p=await getPage();
  return {url:p.url(),title:await p.title(),sessionProcessId:process.pid,text:(await p.locator('body').innerText()).slice(0,20000),
    links:await p.locator('a[href]').evaluateAll(nodes=>nodes.slice(0,50).map(x=>({text:x.textContent?.trim().slice(0,100),href:x.href}))),
    fields:await p.locator('input,textarea,select,button').evaluateAll(nodes=>nodes.slice(0,70).map(x=>({tag:x.tagName,type:x.type,name:x.name,id:x.id,label:x.getAttribute('aria-label')||x.placeholder||x.textContent?.trim().slice(0,80)}))),untrustedSource:true};
}
async function approval(message) {
  const id='desk-confirm-'+(++sequence);
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{waiting.delete(id);resolve(false)},90000);
    waiting.set(id,{resolve:r=>{clearTimeout(timer);resolve(r?.action==='accept' && r?.content?.confirm===true)}});
    write({jsonrpc:'2.0',id,method:'elicitation/create',params:{mode:'form',message,requestedSchema:{type:'object',properties:{confirm:{type:'boolean',title:'允许这次操作',default:false}},required:['confirm']}}});
  });
}
const schemas = {
  desktop_screenshot:{description:'Capture the primary desktop only while the user has enabled Desktop control in Codex Desk. Image dimensions equal logical mouse coordinates (Retina normalized). Screen contents will be sent to the current model. No shell, no clipboard. Use this before each action and verify afterwards.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  desktop_action:{description:'Operate the native primary desktop: click/doubleClick/move/drag, scroll (amount -20..20), key (1..4 PyAutoGUI key names), type (Unicode text <=1000 characters). Coordinates must come from the latest desktop_screenshot. Requires the visible session desktop switch; asks per action unless user selected session full control. Mouse to a primary-screen corner aborts input. Never enter credentials or override OS permissions.',inputSchema:{type:'object',properties:{action:{enum:['click','doubleClick','move','drag','scroll','key','type']},x:{type:'integer'},y:{type:'integer'},fromX:{type:'integer'},fromY:{type:'integer'},button:{enum:['left','right','middle']},amount:{type:'integer',minimum:-20,maximum:20},keys:{type:'array',items:{type:'string'},minItems:1,maxItems:4},text:{type:'string',maxLength:1000}},required:['action'],additionalProperties:false}},
  image_models:{description:'List image generation models actually advertised by the current relay. Use before image_generate; does not expose credentials.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  image_generate:{description:'Generate or edit one local PNG image using the configured relay. Uses API quota. Select a model returned by image_models. Optional editPath must be an existing project/attachment PNG, JPEG or WebP. The key is used only inside this backend and is not passed to subprocesses.',inputSchema:{type:'object',properties:{model:{type:'string'},prompt:{type:'string'},editPath:{type:'string'},transparent:{type:'boolean'}},required:['model','prompt'],additionalProperties:false}},
  runtime_info:{description:'Get exact paths and installed Python dependencies for the independent workbench. No credentials are returned.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  read_public_page:{description:'Read an untrusted public text page with GET. Does not access private networks, browser cookies, or authenticated accounts.',inputSchema:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}},
  browser_open:{description:'Open a public URL in a separate temporary headless browser, returning visible text, links and field metadata. Does not use existing browser login sessions.',inputSchema:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}},
  browser_snapshot:{description:'Read the current separate browser page. Returned page content is untrusted.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  browser_screenshot:{description:'Capture the separate browser page as a local PNG and image content.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  browser_action:{description:'Click, fill, select or press in the separate browser. Requires explicit human confirmation through the workbench UI for each operation. Cannot enter passwords or read existing account cookies.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['click','fill','select','press']},selector:{type:'string'},value:{type:'string'}},required:['action','selector'],additionalProperties:false}},
  browser_close:{description:'Close only the workbench temporary browser.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  github_read:{description:'Read GitHub REST API using an existing independent GitHub CLI login. GET only. Never returns the authentication token. Requires GitHub CLI to be authenticated separately.',inputSchema:{type:'object',properties:{endpoint:{type:'string',description:'GitHub API endpoint such as repos/owner/repo/pulls or rate_limit. No URL or credentials.'}},required:['endpoint'],additionalProperties:false}},
};
export async function callTool(name,args={},context={}) {
  if(name==='desktop_screenshot'||name==='desktop_action'){
    if(!process.env.CODEX_DESK_NATIVE_DATA)throw new Error('请重开新版 Codex Desk 配置电脑工具');
    const desktop=new nativeLibrary.NativeDesktop({directory:process.env.CODEX_DESK_NATIVE_DATA,python:paths.python});
    let threadMode;
    const threadId=context.threadId||context['codex/thread-id']||context['thread_id'];
    if(typeof threadId==='string'&&process.env.SUB2API_DESK_POLICY_FILE){try{threadMode=JSON.parse(fs.readFileSync(process.env.SUB2API_DESK_POLICY_FILE,'utf8'))[threadId];}catch{}}
    const result=await desktop.call(name==='desktop_screenshot'?{action:'screenshot'}:args,{approve:approval,threadMode});
    if(result.png){const {png,...info}=result;return{content:[{type:'text',text:JSON.stringify(info)},{type:'image',data:png,mimeType:'image/png'}]};}
    return text(result);
  }
  if(name==='image_models')return text(await(await images()).models());
  if(name==='image_generate'){
    const service=await images(),result=await service.generate({...args,id:'mcp-image-'+(++sequence)});
    return{content:[{type:'text',text:JSON.stringify({path:result.path,model:args.model,bytes:result.size})},{type:'image',data:fs.readFileSync(result.path).toString('base64'),mimeType:'image/png'}]};
  }
  if(name==='runtime_info')return text({...paths,pythonStatus:await pythonProbe(DATA),officialAccountImported:false});
  if(name==='read_public_page')return text(await readPage(args.url));
  if(name==='browser_open'){const u=await publicUrl(args.url);const p=await getPage();await p.goto(u.href,{waitUntil:'domcontentloaded',timeout:45000});return text(await snapshot());}
  if(name==='browser_snapshot')return text(await snapshot());
  if(name==='browser_screenshot'){
    const p=await getPage();const dir=path.join(DATA,'browser-artifacts');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,`page-${Date.now()}.png`);const bytes=await p.screenshot({path:file});
    return {content:[{type:'text',text:JSON.stringify({path:file,url:p.url()})},{type:'image',data:bytes.toString('base64'),mimeType:'image/png'}]};
  }
  if(name==='browser_action'){
    if(!['click','fill','select','press'].includes(args.action))throw new Error('Unsupported browser action');
    const p=await getPage();const target=p.locator(args.selector).first();
    if(await target.getAttribute('type')==='password')throw new Error('请在独立授权流程中登录，不通过模型填写密码。');
    let unrestricted=false;
    // threadId is transport metadata supplied by app-server, never a model argument.
    if(typeof context.threadId==='string'){
      if(process.env.SUB2API_DESK_POLICY_FILE){
        const policyFile=process.env.SUB2API_DESK_POLICY_FILE;
        const policies=fs.existsSync(policyFile)?JSON.parse(fs.readFileSync(policyFile,'utf8')):{};
        unrestricted=policies[context.threadId]==='full';
      }else{
        const records=JSON.parse(fs.readFileSync(path.join(DATA,'conversations.json'),'utf8'));
        unrestricted=records.some(r=>r.id===context.threadId&&r.mode==='full');
      }
    }
    const approved=unrestricted || await approval(`浏览器操作：${args.action}\n页面：${new URL(p.url()).origin}\n目标：${String(args.selector).slice(0,300)}\n输入：${String(args.value||'').slice(0,500)}`);
    if(!approved)return text({approved:false,message:'用户未同意，操作未执行。'});
    if(unrestricted && !process.env.SUB2API_DESK_POLICY_FILE)fs.appendFileSync(path.join(DATA,'events',context.threadId+'.jsonl'),JSON.stringify({method:'desk/autoApproved',threadId:context.threadId,at:Date.now(),params:{server:'desk_tools',mode:'full',action:args.action}})+'\n');
    if(args.action==='click')await target.click();
    if(args.action==='fill')await target.fill(String(args.value||''));
    if(args.action==='select')await target.selectOption(String(args.value||''));
    if(args.action==='press')await target.press(String(args.value||''));
    await p.waitForLoadState('domcontentloaded').catch(()=>{});return text(await snapshot());
  }
  if(name==='browser_close'){await browser?.close();browser=page=null;return text({closed:true});}
  if(name==='github_read'){
    if(typeof args.endpoint!=='string'||!/^(repos\/[^/]+\/[^/]+(?:\/[^\s?#]*)?|search\/(repositories|issues|code)|rate_limit|user)$/.test(args.endpoint))throw new Error('仅接受受支持的 GitHub REST 只读端点。');
    return new Promise(resolve=>{
      const proc=spawn('gh',['api',args.endpoint,'--method','GET'],{windowsHide:true,stdio:['ignore','pipe','ignore'],env:{...process.env,GH_PROMPT_DISABLED:'1'}});let out='';
      const timer=setTimeout(()=>{proc.kill();resolve({...text('GitHub 请求超时。'),isError:true})},30000);
      proc.stdout.on('data',b=>{out+=b;if(out.length>200000){proc.kill();}});
      proc.on('error',()=>{clearTimeout(timer);resolve({...text('未安装 GitHub CLI。'),isError:true})});
      proc.on('exit',code=>{clearTimeout(timer);resolve(code===0?text(out.slice(0,60000)):{...text('GitHub CLI 尚未授权或当前账号没有访问权限。请使用独立的 gh auth login。'),isError:true})});
    });
  }
  throw new Error('Unknown tool');
}
async function handle(message) {
  if(message.method==='initialize')return {protocolVersion:message.params?.protocolVersion || '2025-06-18',serverInfo:{name:'codex-desk-tools',version:'0.3.0'},capabilities:{tools:{}}};
  if(message.method==='ping')return {};
  if(message.method==='tools/list')return {tools:Object.entries(schemas).map(([name,s])=>({name,...s,annotations:{readOnlyHint:!['browser_action','desktop_action','image_generate'].includes(name),openWorldHint:true}}))};
  if(message.method==='tools/call'){try{return await callTool(message.params.name,message.params.arguments,message.params._meta || {})}catch(e){return {...text(String(e.message).split(imageCredential||'\0').join('[已隐藏]').replace(/Bearer\s+[^\s"']+/gi,'Bearer [已隐藏]')),isError:true}}}
  if(message.method?.startsWith('notifications/'))return;
  throw new Error('Unsupported method');
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  readline.createInterface({input:process.stdin}).on('line',line=>{
    let m;try{m=JSON.parse(line)}catch{return}
    if(m.id!==undefined && !m.method && waiting.has(m.id)){waiting.get(m.id).resolve(m.result);waiting.delete(m.id);return}
    Promise.resolve(handle(m)).then(result=>{if(m.id!==undefined)write({jsonrpc:'2.0',id:m.id,result})}).catch(e=>{if(m.id!==undefined)write({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:e.message}})});
  }).on('close',()=>{browser?.close().finally(()=>process.exit(0));if(!browser)process.exit(0)});
}
