const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
for(const folder of ['src','scripts'])for(const name of fs.readdirSync(path.join(__dirname,'..',folder)).sort())if(/\.(?:cjs|mjs|js)$/.test(name))execFileSync(process.execPath,['--check',path.join(__dirname,'..',folder,name)],{stdio:'inherit'});
console.log('All client and installer JavaScript syntax checks passed.');
