// Prepare the independent installation; API settings and official login stay separate.
const fs=require('node:fs'),path=require('node:path');
async function main(){
  const [source,buildInput,dataInput]=process.argv.slice(2);
  if(!source||!buildInput||!dataInput)throw new Error('Missing installation paths');
  fs.mkdirSync(buildInput,{recursive:true});fs.mkdirSync(dataInput,{recursive:true});
  const build=fs.realpathSync(buildInput),data=fs.realpathSync(dataInput);
  for(const name of ['src','assets','tests','scripts','local-tools'])fs.cpSync(path.join(source,name),path.join(build,name),{recursive:true});
  for(const name of ['package.json','package-lock.json'])fs.copyFileSync(path.join(source,name),path.join(build,name));
  const {prepareRuntime}=require(path.join(build,'scripts','setup-runtime.cjs'));
  const runtime=await prepareRuntime({root:build,data});
  const {SettingsStore}=require(path.join(build,'src','storage.cjs'));
  const settings=path.join(data,'settings.json');
  if(!fs.existsSync(settings)){
    const store=new SettingsStore(data,{isEncryptionAvailable:()=>false});
    store.save({binary:runtime.binary});
  }
  const executable=path.join(build,'node_modules','electron','dist','electron.exe'),engineHome=path.join(data,'codex');
  const {sourceHash}=require('./source-manifest.cjs');
  fs.writeFileSync(path.join(data,'windows-install.json'),JSON.stringify({source,build,executable,engineHome,sourceHash:sourceHash(source),installedAt:new Date().toISOString()},null,2));
  console.log(JSON.stringify({build,data,executable}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
