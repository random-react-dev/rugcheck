import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/check-environment.mjs',import.meta.url));
const flags=['--sandbox','--ephemeral','--json','--output-schema','--output-last-message','--skip-git-repo-check','--cd'];
async function check(major){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rugcheck-runtime-policy-')),marker=path.join(root,'help-called'),cli=path.join(root,'help.mjs');
 await fs.writeFile(cli,'#!/usr/bin/env node\nimport fs from "node:fs";fs.writeFileSync('+JSON.stringify(marker)+',"help");console.log('+JSON.stringify(flags.join(' '))+');\n',{mode:0o700});
 // Test only: exercise the real prerequisite process with a controlled version field.
 const preload=major===null?[]:['--import','data:text/javascript,'+encodeURIComponent('Object.defineProperty(process.versions,"node",{value:'+JSON.stringify(major+'.99.0')+'});')];
 const child=spawn(process.execPath,[...preload,script,cli],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 try{let called=false;try{await fs.access(marker);called=true;}catch{}return {code,value:JSON.parse(output),called,errors};}finally{await fs.rm(root,{recursive:true,force:true});}
}
test('the actual supported runtime reaches bounded CLI help without a model call',async()=>{
 const r=await check(null);assert.equal(r.code,0,r.errors);assert.equal(r.value.status,'PREREQUISITES_ONLY');assert.equal(r.value.real_execution,'NOT_RUN');assert.equal(r.called,true);
});
test('both supported majors reach CLI help',async()=>{
 for(const major of [22,24]){const r=await check(major);assert.equal(r.code,0,r.errors);assert.equal(r.value.cli_flags,'PRESENT');assert.equal(r.called,true);}
});
test('unqualified majors are rejected before any CLI process starts',async()=>{
 for(const major of [20,23,25,26]){const r=await check(major);assert.equal(r.code,1);assert.equal(r.value.error,'RUNTIME_UNQUALIFIED');assert.equal(r.called,false);}
});
