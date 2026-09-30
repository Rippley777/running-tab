import {randomUUID} from 'node:crypto';
import {db,sql,one,required,audit,AppError,type Context,type Executor} from '../db/index.js';
import {snapshotHash} from './math.js';
export async function mutate<T>(ctx:Context,action:string,input:unknown,fn:(tx:Executor)=>Promise<T>,key?:string):Promise<T>{return db.transaction(async tx=>{
 await required(sql`SELECT id FROM "user" WHERE id=${ctx.userId} FOR UPDATE`,tx);
 await required(sql`SELECT id FROM workspace WHERE id=${ctx.workspaceId} AND owner_id=${ctx.userId} FOR UPDATE`,tx);
 const hash=snapshotHash(input);
 if(key){const old=await one(sql`SELECT * FROM idempotency_record WHERE workspace_id=${ctx.workspaceId} AND key=${key}`,tx);if(old){if(old.action!==action||old.request_hash!==hash)throw new AppError('IDEMPOTENCY_CONFLICT','This request key was already used with different content.',409);return old.response as T;}}
 const result=await fn(tx);
 if(key)await tx.execute(sql`INSERT INTO idempotency_record(workspace_id,key,action,request_hash,response) VALUES(${ctx.workspaceId},${key},${action},${hash},${JSON.stringify(result??null)}::jsonb)`);
 return result;
});}
export async function ownedProject(tx:Executor,ctx:Context,id:string){return required(sql`SELECT p.*,c.default_rate client_rate,c.archived_at client_archived,w.default_rate workspace_rate,w.rounding_minutes FROM project p JOIN client c ON c.id=p.client_id AND c.workspace_id=p.workspace_id JOIN workspace w ON w.id=p.workspace_id WHERE p.id=${id} AND p.workspace_id=${ctx.workspaceId}`,tx);}
export async function ensureTask(tx:Executor,ctx:Context,projectId:string,taskId?:string|null){if(taskId)await required(sql`SELECT id FROM project_task WHERE workspace_id=${ctx.workspaceId} AND project_id=${projectId} AND id=${taskId}`,tx);}
export {randomUUID,audit,AppError};
