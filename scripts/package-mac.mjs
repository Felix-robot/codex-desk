import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import setup from './setup-runtime.cjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await setup.prepareRuntime({root,configure:false});
// Code Mode starts this sibling executable on the first model tool call.
for (const name of ['codex', 'codex-code-mode-host', 'rg']) {
  fs.accessSync(path.join(root, 'runtime', 'codex', name), fs.constants.X_OK);
}
const version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
const cache = path.join(os.homedir(), 'Library', 'Caches', 'electron');
const filename = `electron-v${version}-darwin-${process.arch}.zip`;
const cachedZipDirectory = fs.existsSync(cache) ? fs.readdirSync(cache)
  .map((name) => path.join(cache, name)).find((directory) => fs.existsSync(path.join(directory, filename))) : undefined;

const builds = await packager({
  dir: root, name: 'Codex Desk', platform: 'darwin', arch: process.arch,
  electronVersion: version, ...(cachedZipDirectory ? { electronZipDir: cachedZipDirectory } : {}),
  out: path.join(root, 'release'), overwrite: true,
  ignore: /^\/(release|tests|\.protocol|artifacts|runtime|shared-chats)(\/|$)/,
  extraResource: [path.join(root, 'runtime', 'codex'), path.join(root, 'local-tools'), path.join(root, 'src', 'images.cjs')],
  icon: path.join(root, 'assets', 'desk.icns'), appBundleId: 'local.felix.codexdesk',
  extendInfo: { NSMicrophoneUsageDescription: '仅在你开启语音时使用麦克风，在本机识别后将文字发送到所选模型。' },
});
for (const directory of builds) console.log(`Built: ${directory}`);
