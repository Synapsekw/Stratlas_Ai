// electron-builder custom Windows sign hook for cloud HSM certificates.
//
// Enabled by tools/release/brand-config.mjs when WIN_SIGN_COMMAND is set. The command is a
// template run once per file, with {file} replaced by the quoted absolute path. Examples:
//   DigiCert KeyLocker: smctl sign --keypair-alias=%SM_KEYPAIR_ALIAS% --input {file}
//   SSL.com eSigner:    CodeSignTool sign -username=... -credential_id=... -input_file_path={file} -override
//   signtool + KSP:     signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 /csp "..." /kc "..." /f cert.crt {file}
// The command must timestamp and must exit non-zero on failure.
import { execSync } from 'node:child_process';

/** @param {{ path: string }} configuration */
export default function sign(configuration) {
  const template = process.env.WIN_SIGN_COMMAND;
  if (!template) throw new Error('WIN_SIGN_COMMAND is not set');
  if (!template.includes('{file}')) throw new Error('WIN_SIGN_COMMAND must contain {file}');
  const command = template.replaceAll('{file}', `"${configuration.path}"`);
  process.stdout.write(`[win-sign] ${configuration.path}\n`);
  execSync(command, { stdio: 'inherit' });
}
