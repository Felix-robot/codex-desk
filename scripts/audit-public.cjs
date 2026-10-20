// Check publication candidates without printing matched credential values.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const candidates=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root}).toString().split('\0').filter(Boolean))];
const staged=new Set(execFileSync('git',['ls-files','--cached','-z'],{cwd:root}).toString().split('\0').filter(Boolean));
const forbidden=/(^|\/)(?:node_modules|runtime|release|artifacts|shared-chats|attachments|__pycache__|\.protocol|\.stversions)(\/|$)|(?:^|\/)(?:\.env(?:\..+)?|auth\.json|credential\.bin|settings\.json|preferences\.json|local-tools\.json|extensions\.toml|integrations\.json|workspace\.json|tool-permissions\.json|desktop-access\.json|PROJECT_MEMORY[^/]*|[^/]*sync-conflict[^/]*|~syncthing~[^/]*)$/i;
const rules=[
  ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token',/\bgh[opusr]_[A-Za-z0-9]{30,}\b|github_pat_[A-Za-z0-9_]{30,}/],
  ['api-key',/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/],
  ['credential-url',/https?:\/\/[^\s/"'<>]+:[^\s/"'<>]+@/],
  ['personal-windows-path',/[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+[\\/]/],
  ['personal-mac-path',/\/Users\/[A-Za-z0-9_.-]+\//],
  ['fixed-http-ip',/https?:\/\/(?!(?:127\.|0\.0\.0\.0|localhost))\d{1,3}(?:\.\d{1,3}){3}(?=[:/])/],
];
const failures=[];let bytes=0;
for(const relative of candidates){
  if(forbidden.test(relative)||/\.(?:exe|dll|dylib|sqlite\w*|jsonl|pyc)$/i.test(relative))failures.push({file:relative,rule:'private-or-generated-file'});
  const file=path.join(root,relative);if(!fs.existsSync(file))continue;
  const versions=[['working',fs.readFileSync(file)]];
  if(staged.has(relative))versions.push(['index',execFileSync('git',['show',':'+relative],{cwd:root,maxBuffer:10*1024*1024})]);
  bytes+=versions[0][1].length;
  for(const [version,content] of versions){
    if(content.length>5*1024*1024){failures.push({file:relative,rule:'oversized-file',version});continue;}
    if(content.subarray(0,8192).includes(0))continue;
    const text=content.toString('utf8');for(const[rule,pattern]of rules)if(pattern.test(text))failures.push({file:relative,rule,version});
  }
}
console.log(JSON.stringify({passed:failures.length===0,files:candidates.length,bytes,failures},null,2));
if(failures.length)process.exitCode=1;
