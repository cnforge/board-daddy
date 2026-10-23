'use strict';
// Ad-hoc code-sign the .app so it launches on Apple Silicon without a paid Developer ID.
const { execSync } = require('child_process');
exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log('Ad-hoc signing', app);
  execSync(`codesign --force --deep --sign - "${app}"`, { stdio: 'inherit' });
};
