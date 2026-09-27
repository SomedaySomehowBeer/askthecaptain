/** Inspect Expo's generated manifest model and the linked SecureStore resources.
 * This does not compile Android or prove backup behaviour on a device. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const application = config._internal.modResults.android.manifest.manifest.application[0].$;
assert.equal(application['android:allowBackup'], 'false');
assert.equal(application['android:fullBackupContent'], '@xml/secure_store_backup_rules');
assert.equal(application['android:dataExtractionRules'], '@xml/secure_store_data_extraction_rules');
const resources = path.join(path.dirname(require.resolve('expo-secure-store/package.json')), 'android/src/main/res/xml');
const legacy = await readFile(path.join(resources, 'secure_store_backup_rules.xml'), 'utf8');
const modern = await readFile(path.join(resources, 'secure_store_data_extraction_rules.xml'), 'utf8');
const exclusion = /<exclude\s+domain="sharedpref"\s+path="SecureStore"\s*\/>/;
assert.match(legacy, exclusion);
for (const section of ['cloud-backup', 'device-transfer']) {
  const content = new RegExp(`<${section}[^>]*>([\\s\\S]*?)</${section}>`).exec(modern)?.[1];
  assert.ok(content, `missing ${section}`);
  assert.match(content, exclusion);
}
console.log('PASS Android generated config references SecureStore exclusions for backup and device transfer (not device proof)');
