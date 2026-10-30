// 在 profile 里启用/停用「点名」，并保证写盘不带 BOM、写完能 JSON.parse。
// 用法：node tools/profile-toggle.cjs on | off
// 停用 = 从 dsh.profile.bundles 和 dependencies 里摘掉（宿主启动时不再加载），
//        不改 .dsh-market/state.json，避免留下"禁用标记"。
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'dsh-dianming';
const PLUGIN_DIR = path.resolve(__dirname, '..');
const PROF = path.join(process.env.APPDATA || '', 'dsh-desktop', 'harness', 'profiles', 'desktop');
const PKG = path.join(PROF, 'package.json');

const mode = (process.argv[2] || '').toLowerCase();
if (mode !== 'on' && mode !== 'off') {
  console.error('用法：node tools/profile-toggle.cjs on|off');
  process.exit(1);
}

const raw = fs.readFileSync(PKG, 'utf8');
const pkg = JSON.parse(raw);
pkg.dependencies = pkg.dependencies || {};
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
const bundles = pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];

if (mode === 'on') {
  const spec = 'link:' + PLUGIN_DIR.replace(/\\/g, '/');
  pkg.dependencies[NAME] = spec;
  if (!bundles.includes(NAME)) bundles.push(NAME);
} else {
  delete pkg.dependencies[NAME];
  const index = bundles.indexOf(NAME);
  if (index >= 0) bundles.splice(index, 1);
}

fs.copyFileSync(PKG, PKG + '.bak-toggle');
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', { encoding: 'utf8' });
JSON.parse(fs.readFileSync(PKG, 'utf8'));

console.log(`${NAME}: ${mode === 'on' ? '已启用' : '已停用'}；bundles=${bundles.length}；备份 package.json.bak-toggle`);
