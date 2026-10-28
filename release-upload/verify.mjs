import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const release=JSON.parse(readFileSync('/tmp/cc-release.json','utf8'));
const expected={"version": "0.4.36", "protocol": 22, "runtime": 1, "commit": "81bc658feb411a772264ea2f3d14802bb7b1d435", "files": [{"name": "CC-Desk-Tunnel-Setup-0.4.36-x64.exe", "size": 201112433, "sha256": "fd44304b8b5d2e9de76875ef2853423a3c81c81c886837869a650254cfcb6f36"}, {"name": "cc-desk-tunnel-server-0.4.36.tar.gz", "size": 1618366, "sha256": "36e0c48717047894534a6ae9e5b8fea4399a1701499fe843ad7d47c007bccc38"}, {"name": "CC-Desk-Tunnel-0.4.36-android.apk", "size": 1535617, "sha256": "99fe45bb01ca4df049fe0452b85c78b9b7fe004db385204293c89e20807e0b39"}]};
const hashes={"CC-Desk-Tunnel-0.4.36-android.apk": "99fe45bb01ca4df049fe0452b85c78b9b7fe004db385204293c89e20807e0b39", "release.json": "fdb2a4b950a4adaebaaea7ef27ca28045f03d53fbbc0b4f8ab250f1930ced11a", "SHA256SUMS": "9452080c06a1e40f47a66204e3d829fea2c840bd775872ab7b03681e91b04cff"};
assert.equal(release.id,426797589);
assert.equal(release.draft,true);
assert.equal(release.prerelease,false);
assert.equal(release.tag_name,'v0.4.36');
assert.equal(release.target_commitish,expected.commit);
for(const [name,hash] of Object.entries(hashes)) {
 const bytes=readFileSync('release-upload/'+name);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),hash,name);
}
assert.deepEqual(JSON.parse(readFileSync('release-upload/release.json','utf8')),expected);
assert.equal(readFileSync('release-upload/SHA256SUMS','utf8'),expected.files.map(f=>`${f.sha256}  ${f.name}\n`).join(''));
for(const f of expected.files.filter(f=>!f.name.endsWith('.apk'))) {
 const a=release.assets.find(a=>a.name===f.name);
 assert.ok(a,f.name);
 assert.equal(a.size,f.size);
 assert.equal(a.digest,'sha256:'+f.sha256);
}
const allowed=new Set([...expected.files.map(f=>f.name),'release.json','SHA256SUMS']);
assert.ok(release.assets.every(a=>allowed.has(a.name)));
console.log('Verified original tested source, draft Windows/server hashes, signed APK and protocol-22 manifest.');
