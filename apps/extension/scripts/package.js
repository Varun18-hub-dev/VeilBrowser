// Builds the production extension and zips dist/ for the Chrome Web Store.
// Usage: npm run package   ->  apps/extension/veilbrowse-<version>.zip
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const out = path.join(root, `veilbrowse-${version}.zip`);

execSync('npx webpack --config webpack.config.js --mode production', { cwd: root, stdio: 'inherit' });
if (fs.existsSync(out)) fs.unlinkSync(out);

if (process.platform === 'win32') {
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${dist}\\*' -DestinationPath '${out}'"`, { stdio: 'inherit' });
} else {
  execSync(`zip -qr "${out}" .`, { cwd: dist, stdio: 'inherit' });
}
console.log(`Packaged ${path.relative(process.cwd(), out)}`);
