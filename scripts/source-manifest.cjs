const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
function sourceHash(root) {
  const hash = createHash('sha256');
  function visit(relative) {
    const full=path.join(root,relative);if(!fs.existsSync(full))return;
    if(fs.statSync(full).isDirectory()){for(const name of fs.readdirSync(full).sort())visit(path.join(relative,name));}
    else{hash.update(relative.replaceAll('\\','/'));hash.update(fs.readFileSync(full));}
  }
  for(const entry of ['src','assets','local-tools','scripts','package.json','package-lock.json','setup-windows.ps1','启动.command'])visit(entry);
  return hash.digest('hex');
}
module.exports={sourceHash};
