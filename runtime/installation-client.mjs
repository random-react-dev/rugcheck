import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {canonical} from './core.mjs';
import {invariant,RugError} from './errors.mjs';
export async function createLocalInstallation({root=path.join(os.homedir(),'.local/state/rugcheck'),clock=Date.now}={}){
 invariant(path.isAbsolute(root),'INSTALLATION_STATE_INVALID');await fs.mkdir(root,{recursive:true,mode:0o700});const dir=await fs.lstat(root);invariant(dir.isDirectory()&&!dir.isSymbolicLink()&&(dir.mode&0o077)===0&&dir.uid===process.getuid(),'INSTALLATION_STATE_UNSAFE');const filename=path.join(root,'identity.pem');
 const temporary=path.join(root,'.identity-'+randomBytes(16).toString('hex'));let h;try{h=await fs.open(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);const {privateKey}=generateKeyPairSync('ed25519');await h.writeFile(privateKey.export({format:'pem',type:'pkcs8'}));await h.sync();await h.close();h=null;try{await fs.link(temporary,filename);}catch(e){if(e.code!=='EEXIST')throw e;}}catch{throw new RugError('INSTALLATION_STATE_UNAVAILABLE');}finally{await h?.close();await fs.unlink(temporary).catch(()=>{});}
 let read,key;try{read=await fs.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const stat=await read.stat();invariant(stat.isFile()&&stat.nlink===1&&(stat.mode&0o077)===0&&stat.uid===process.getuid()&&stat.size<4096,'INSTALLATION_STATE_UNSAFE');key=createPrivateKey(await read.readFile());invariant(key.asymmetricKeyType==='ed25519','INSTALLATION_STATE_INVALID');}finally{await read?.close();}
 const publicKey=createPublicKey(key).export({format:'der',type:'spki'}),id=createHash('sha256').update(publicKey).digest('hex');
 return {id,public_key:publicKey.toString('base64url'),headers(route,body){const timestamp=String(clock()),nonce=randomBytes(16).toString('hex'),message=`rugcheck-installation-v1\nPOST\n${route}\n${timestamp}\n${nonce}\n${createHash('sha256').update(canonical(body)).digest('hex')}`;return {'x-rugcheck-installation':id,'x-rugcheck-timestamp':timestamp,'x-rugcheck-nonce':nonce,'x-rugcheck-signature':sign(null,Buffer.from(message),key).toString('base64url')};}};
}
