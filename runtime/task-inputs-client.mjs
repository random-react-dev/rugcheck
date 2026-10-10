import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from './core.mjs';
import {validateTask,readBounded} from './hybrid-protocol.mjs';
import {invariant,RugError} from './errors.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validateFiles(files){invariant(Array.isArray(files)&&files.length<=10,'TASK_INPUT_LIMIT');const ids=new Set();let total=0;for(const f of files){invariant(f&&Object.keys(f).sort().join(',')==='id,name,sha256,size'&&uuid.test(f.id)&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(f.name)&&!f.name.includes('..')&&/^[a-f0-9]{64}$/.test(f.sha256)&&Number.isSafeInteger(f.size)&&f.size>0&&f.size<=524288&&!ids.has(f.id),'TASK_INPUT_MANIFEST_INVALID');ids.add(f.id);total+=f.size;}invariant(total<=2097152,'TASK_INPUT_LIMIT');}
export async function prepareTaskInputs({endpoint,installation,task,requestedTaskId=null,preferRequested=true,signal,fetchImpl=fetch}){
 const route='/v1/task-inputs',body={task,requested_task_id:requestedTaskId,prefer_requested:preferRequested},res=await fetchImpl(new URL(route,endpoint),{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json',...installation.headers(route,body)},body:JSON.stringify(body)});
 let value;try{value=JSON.parse(await readBounded(res.body,65536));}catch{throw new RugError('TASK_INPUT_MANIFEST_INVALID');}
 if(!res.ok)throw new RugError(/^SERVER_[A-Z_]{1,70}$/.test(value?.error?.code??'')?value.error.code:'TASK_INPUT_REQUEST_DENIED');
 invariant(value&&Object.keys(value).sort().join(',')==='applied,diagnosis,files,task','TASK_INPUT_MANIFEST_INVALID');validateTask(value.task);invariant(canonical(value.task.request)===canonical(task.request)&&(!requestedTaskId||value.task.task_id===requestedTaskId)&&(!preferRequested||requestedTaskId||uuid.test(value.task.task_id)),'TASK_INPUT_BINDING_INVALID');
 invariant(Array.isArray(value.files)&&value.files.length<=10&&(value.diagnosis===null||(typeof value.diagnosis==='string'&&Buffer.byteLength(value.diagnosis)<=32000)),'TASK_INPUT_MANIFEST_INVALID');
 if(value.applied!==null)invariant(value.applied&&Object.keys(value.applied).sort().join(',')==='global,installation,source'&&Number.isSafeInteger(value.applied.global)&&value.applied.global>0&&Number.isSafeInteger(value.applied.installation)&&value.applied.installation>0&&['global','override'].includes(value.applied.source),'TASK_INPUT_MANIFEST_INVALID');
 validateFiles(value.files);return value;
}
export async function materializeTaskInputs({endpoint,installation,bundle,workspaceRoot,signal,fetchImpl=fetch}){
 validateTask(bundle.task);validateFiles(bundle.files);
 const root=await fs.realpath(workspaceRoot),target=path.join(root,'external-inputs');await fs.mkdir(target,{mode:0o700});const files=[];
 for(const f of bundle.files){const route='/v1/task-file',body={task_id:bundle.task.task_id,file_id:f.id};const res=await fetchImpl(new URL(route,endpoint),{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json',...installation.headers(route,body)},body:JSON.stringify(body)});invariant(res.ok,'TASK_INPUT_DOWNLOAD_DENIED');const chunks=[];let size=0;for await(const chunk of res.body){size+=chunk.length;invariant(size<=f.size&&size<=524288,'TASK_INPUT_LIMIT');chunks.push(Buffer.from(chunk));}const bytes=Buffer.concat(chunks);invariant(size===f.size&&createHash('sha256').update(bytes).digest('hex')===f.sha256,'TASK_INPUT_DIGEST_INVALID');const safe=await fs.lstat(target);invariant(safe.isDirectory()&&!safe.isSymbolicLink(),'TASK_INPUT_WORKSPACE_UNSAFE');const name=f.id+'-'+f.name,destination=path.join(target,name),h=await fs.open(destination,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{await h.writeFile(bytes);}finally{await h.close();}files.push({name:f.name,size:f.size,sha256:f.sha256,path:'external-inputs/'+name});}
 return {task_id:bundle.task.task_id,files,diagnosis:bundle.diagnosis,applied:bundle.applied,executed:false,retained_after_task:false,workspace:target};
}
