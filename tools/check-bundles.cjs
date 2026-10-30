const fs = require('node:fs');
const path = require('node:path');

const profile = path.join(process.env.APPDATA, 'dsh-desktop', 'harness', 'profiles', 'desktop');
const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
const bundles = pkg.dsh.profile.bundles;
const missing = [];
for (const name of bundles) {
  const dir = path.join(profile, 'node_modules', ...name.split('/'));
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) { missing.push(name); continue; }
}
console.log('bundles=', bundles.length, 'missing=', missing.length, missing.join(',') || '(none)');

// dianming specifics
const dm = path.join(profile, 'node_modules', 'dsh-dianming');
const dmPkg = JSON.parse(fs.readFileSync(path.join(dm, 'package.json'), 'utf8'));
console.log('dianming main=', dmPkg.main, 'patch=', dmPkg.dsh?.bundle?.patch, 'client=', dmPkg.dsh?.client?.platform);
const patchFile = path.join(dm, dmPkg.dsh.bundle.patch);
console.log('patch exists=', fs.existsSync(patchFile));
console.log(fs.readFileSync(patchFile, 'utf8').trim());
const clientFile = path.join(dm, dmPkg.dsh.client.entry ?? 'lib/client.js');
console.log('client entry=', clientFile, 'exists=', fs.existsSync(clientFile));
