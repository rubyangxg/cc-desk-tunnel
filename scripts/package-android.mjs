import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const run = (file, args, env = {}) =>
  execFileSync(file, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error('Set ANDROID_HOME to Android SDK with build-tools 35.0.0.');
const argument = process.argv.indexOf('--unsigned');
const unsigned =
  argument >= 0
    ? resolve(process.argv[argument + 1])
    : join(root, 'apps/mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk');
if (argument < 0) {
  run(process.execPath, [
    join(root, 'node_modules/vite/bin/vite.js'),
    'build',
    '--config',
    'apps/mobile/vite.config.ts',
  ]);
  run(process.env.GRADLE ?? join(root, 'apps/mobile/android/gradlew'), [
    '-p',
    'apps/mobile/android',
    ':app:assembleRelease',
    ':app:testDebugUnitTest',
    ':app:lintRelease',
  ]);
}
// The stable signing key is private and never enters git, an APK, a workflow log or a public release.
// Keep both files as a private backup to retain the ability to install future updates over this app.
const privateDir = join(root, '.local/android-signing');
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const keystore = process.env.ANDROID_RELEASE_KEYSTORE ?? join(privateDir, 'release.p12');
const passwordFile = process.env.ANDROID_RELEASE_PASSWORD_FILE ?? join(privateDir, 'password.txt');
const certificateFile = join(root, 'apps/mobile/android/signing-certificate.sha256');
const expectedCertificate = existsSync(certificateFile)
  ? readFileSync(certificateFile, 'utf8').trim()
  : undefined;
if (!existsSync(keystore)) {
  if (expectedCertificate)
    throw new Error('Restore the existing private Android signing key before packaging an update.');
  if (process.env.ANDROID_RELEASE_KEYSTORE)
    throw new Error('Configured Android signing key is missing.');
  if (!existsSync(passwordFile))
    writeFileSync(passwordFile, randomBytes(36).toString('base64url'), { mode: 0o600 });
  const password = readFileSync(passwordFile, 'utf8').trim();
  const keytool = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin/keytool') : 'keytool';
  run(
    keytool,
    [
      '-genkeypair',
      '-keystore',
      keystore,
      '-alias',
      'cc-desk-tunnel',
      '-keyalg',
      'RSA',
      '-keysize',
      '3072',
      '-validity',
      '10000',
      '-storetype',
      'PKCS12',
      '-storepass:env',
      'CC_ANDROID_SIGNING_PASSWORD',
      '-keypass:env',
      'CC_ANDROID_SIGNING_PASSWORD',
      '-dname',
      'CN=CC Desk Tunnel Personal, O=CC Desk Tunnel',
    ],
    { CC_ANDROID_SIGNING_PASSWORD: password },
  );
}
if (!existsSync(passwordFile))
  throw new Error('Signing password file missing; restore your private backup.');
const version = JSON.parse(readFileSync(join(root, 'apps/mobile/package.json'), 'utf8')).version;
const output = join(root, 'artifacts/android');
mkdirSync(output, { recursive: true });
const aligned = join(output, 'aligned-unsigned.apk'),
  apk = join(output, `CC-Desk-Tunnel-${version}-android.apk`),
  tools = join(sdk, 'build-tools/35.0.0');
run(join(tools, 'zipalign'), ['-f', '-p', '4', unsigned, aligned]);
run(join(tools, 'apksigner'), [
  'sign',
  '--ks',
  keystore,
  '--ks-key-alias',
  'cc-desk-tunnel',
  '--ks-pass',
  `file:${passwordFile}`,
  '--out',
  apk,
  aligned,
]);
const verification = execFileSync(
  join(tools, 'apksigner'),
  ['verify', '--verbose', '--print-certs', apk],
  { encoding: 'utf8' },
);
console.log(verification);
const certificate = /Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})/i.exec(verification)?.[1];
if (!certificate || (expectedCertificate && certificate !== expectedCertificate))
  throw new Error('Android signing certificate changed; do not publish this APK.');
if (!expectedCertificate) writeFileSync(certificateFile, certificate + '\n');
console.log(
  `Android package: ${apk}\nKeep a private backup of ${privateDir}; never upload it to GitHub.`,
);
