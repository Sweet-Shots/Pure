'use strict';
// electron-builder hook (F4, Widevine). VMP-signs the packaged app with castLabs EVS, but only when
// EVS_ACCOUNT_NAME is set. Wired as "afterSign" in package.json "build".
//
// Why afterSign and not afterPack: electron-builder flips the Electron fuses and edits the exe's resources (icon,
// version info) after afterPack, which would invalidate a signature taken there. On Windows afterSign runs after both,
// and castLabs requires VMP signing after code-signing on Windows (wiki EVS, "Signing an ECS application package").
//
// Without EVS_ACCOUNT_NAME the build is unchanged: one log line, no network, no signing. Credentials are never read
// or stored here: the castlabs-evs tool keeps its own login (`python -m castlabs_evs.account signup|reauth`).
//
// Optional env: EVS_PYTHON (interpreter that has castlabs-evs installed; default python / python3).

const { spawnSync } = require('child_process');

const PYTHON = process.env.EVS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function run(args, label) {
  const r = spawnSync(PYTHON, args, { stdio: 'inherit', windowsHide: true });
  if (r.error) throw new Error(`[evs] ${label}: could not start ${PYTHON} (${r.error.message}). Install castlabs-evs: ${PYTHON} -m pip install castlabs-evs`);
  if (r.status !== 0) throw new Error(`[evs] ${label} failed with exit code ${r.status}. The app was NOT VMP-signed.`);
}

module.exports = async function evsSign(context) {
  const { appOutDir, electronPlatformName } = context;
  if (electronPlatformName !== 'win32') return;

  if (!(process.env.EVS_ACCOUNT_NAME || '').trim()) {
    console.log('[evs] EVS_ACCOUNT_NAME is not set: skipping VMP signing (castLabs development signature only).');
    return;
  }

  console.log(`[evs] VMP signing ${appOutDir} (streaming signature)`);
  run(['-m', 'castlabs_evs.vmp', 'sign-pkg', appOutDir], 'sign-pkg');
  run(['-m', 'castlabs_evs.vmp', 'verify-pkg', appOutDir], 'verify-pkg');
  console.log('[evs] VMP signature written and verified.');
};
