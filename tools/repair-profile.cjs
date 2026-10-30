const fs = require('node:fs');
const path = require('node:path');

const profile = path.join(process.env.APPDATA, 'dsh-desktop', 'harness', 'profiles', 'desktop');
const pkgFile = path.join(profile, 'package.json');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

const LINKS = {
  'dsh-dianming': 'link:D:/500 工作/DSH/2026-10-29/关键词或语音快速启动本地软件/dsh-dianming',
  'dsh-file-context-menu': 'link:D:/500 工作/DSH/2026-10-24/dsh右键打开文件位置插件',
  'dsh-workbuddy-expert-panel': 'link:D:/500 工作/DSH/2026-10-26/DSH专家功能插件对应/dsh-workbuddy-expert-panel',
};

const raw = fs.readFileSync(pkgFile, 'utf8');
fs.writeFileSync(path.join(profile, `package.json.bak-repair-${stamp}`), raw);
const pkg = JSON.parse(raw);

pkg.dependencies = pkg.dependencies || {};
for (const [name, spec] of Object.entries(LINKS)) pkg.dependencies[name] = spec;

const bundles = pkg.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) throw new Error('bundles not found');
if (!bundles.includes('dsh-dianming')) {
  const at = bundles.indexOf('dsh-workbuddy-expert-panel');
  if (at >= 0) bundles.splice(at + 1, 0, 'dsh-dianming');
  else bundles.push('dsh-dianming');
}

const text = JSON.stringify(pkg, null, 2) + '\n';
fs.writeFileSync(pkgFile, text, 'utf8');

// validate
const back = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const bytes = fs.readFileSync(pkgFile);
const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
console.log('bom=', bom, 'deps=', Object.keys(back.dependencies).length, 'bundles=', back.dsh.profile.bundles.length);
for (const [name, spec] of Object.entries(LINKS)) {
  const p = spec.replace(/^link:/, '');
  console.log(name, '| exists=', fs.existsSync(p), '|', back.dependencies[name]);
}
console.log('dianming in bundles =', back.dsh.profile.bundles.includes('dsh-dianming'));

// market disabled list
const mstate = path.join(profile, '.dsh-market', 'state.json');
if (fs.existsSync(mstate)) {
  const mraw = fs.readFileSync(mstate, 'utf8');
  fs.writeFileSync(path.join(profile, '.dsh-market', `state.json.bak-repair-${stamp}`), mraw);
  const m = JSON.parse(mraw);
  m.disabled = (m.disabled || []).filter((n) => n !== 'dsh-dianming');
  fs.writeFileSync(mstate, JSON.stringify(m, null, 2) + '\n', 'utf8');
  console.log('market disabled now =', JSON.parse(fs.readFileSync(mstate, 'utf8')).disabled);
}
