import assert from "node:assert/strict";
import {lstat,mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createLocalDesktopProfile,main} from "./local-profile.mjs";

test("creates a private local client profile with explicit daemon/update preferences and refuses reuse or remote origins",async t=>{
 const root=await mkdtemp(join(tmpdir(),"desktop-profile-"));t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,"local"),options={directory,apiUrl:"http://localhost:18729",appUrl:"http://localhost:13649"};
 const result=await createLocalDesktopProfile(options);assert.equal(result.daemon_auto_start,false);assert.equal((await lstat(directory)).mode&0o777,0o700);
 for(const path of ["desktop.json","daemon-prefs.json","electron/updater-preferences.json"])assert.equal((await lstat(join(directory,path))).mode&0o777,0o600);
 assert.deepEqual(JSON.parse(await readFile(join(directory,"daemon-prefs.json"),"utf8")),{autoStart:false,autoStop:false});assert.deepEqual(JSON.parse(await readFile(join(directory,"electron/updater-preferences.json"),"utf8")),{automaticUpdates:false});
 await assert.rejects(createLocalDesktopProfile(options),/EEXIST/);await assert.rejects(createLocalDesktopProfile({...options,directory:join(root,"remote"),apiUrl:"https://remote.example"}),/loopback/);await assert.rejects(main(["--directory",directory]),/Use --directory/);
});
