const path = require('node:path');
const { fileURLToPath } = require('node:url');

function resolveLink(raw, { cwd, baseFile, platform = process.platform } = {}) {
  if (typeof raw !== 'string' || !raw.trim() || /[\0\r\n]/.test(raw)) throw new Error('链接地址无效');
  let href = raw.trim();
  if (/^(https?|mailto):/i.test(href)) return { kind: 'external', url: new URL(href).href };
  const fragmentAt = href.indexOf('#');
  const fragment = fragmentAt >= 0 ? href.slice(fragmentAt + 1) : '';
  if (fragmentAt >= 0) href = href.slice(0, fragmentAt);
  if (!href) return { kind: 'anchor', fragment };
  const localPath = platform === 'win32' ? path.win32 : path.posix;
  if (/^file:/i.test(href)) href = fileURLToPath(new URL(href), { windows: platform === 'win32' });
  else {
    if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) throw new Error('不支持此链接类型');
    try { href = decodeURIComponent(href); } catch { /* A literal percent sign is valid in a filename. */ }
  }
  if (platform === 'win32') href = href.replace(/^\/(?=[a-z]:[\\/])/i, '');
  let line;
  href = href.replace(/:(\d+)(?::\d+)?$/, (_match, n) => { line = Number(n); return ''; });
  const base = baseFile ? localPath.dirname(baseFile) : cwd;
  if (!localPath.isAbsolute(href) && !base) throw new Error('请先选择链接所在的项目');
  return { kind: 'file', path: localPath.resolve(base || '', href), fragment, line };
}

module.exports = { resolveLink };
