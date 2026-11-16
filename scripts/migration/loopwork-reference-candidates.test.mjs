import assert from 'node:assert/strict';
import test from 'node:test';
import {referenceCandidates} from './loopwork-reference-candidates.mjs';

test('retains explicit reference forms, balanced Markdown destinations and JSON pointers without interpreting prose',()=>{
 const found=referenceCandidates('![image](<.tmp/a b.png> "Caption") [remote](https://example.invalid/wiki/(sample))\n[proof]: .tmp/proof.pdf "Title"\n<img src=".tmp/image.png"> `docs/proof.md:3` ordinary/sentence is not an explicit reference; .tmp/raw.log、then prose');
 for(const [target,syntax] of [['.tmp/a b.png','markdown'],['https://example.invalid/wiki/(sample)','markdown'],['.tmp/proof.pdf','markdown_definition'],['.tmp/image.png','html'],['docs/proof.md:3','inline_path'],['.tmp/raw.log','literal_path']])assert.ok(found.some(row=>row.target===target&&row.syntax===syntax),`${syntax}: ${target}`);
 assert.equal(found.some(row=>row.target==='ordinary/sentence'),false);
 const json=referenceCandidates(JSON.stringify({payload:JSON.stringify({paths:['.tmp/a.png','/outside/file.txt'],nested:{file_path:'docs/example.md'}})}));
 assert.ok(json.some(row=>row.target==='.tmp/a.png'&&row.pointer==='/payload/paths/0'));
 assert.ok(json.some(row=>row.target==='docs/example.md'&&row.pointer==='/payload/nested/file_path'));
 assert.deepEqual(referenceCandidates(null),[]);
});
