import type {Hono} from 'hono';
import type {AppEnv} from '../../../apps/api/src/api-context';
import {getWorkspaceId,requireScopes} from '../../../apps/api/src/request-auth';
import {SharedTableStore} from '../../../apps/api/src/shared-table-store';

/** Explicit local harness. Never imported by the production API entry point. */
export function registerSharedCandidateRoutes(app:Hono<AppEnv>){
 app.post('/candidate/tables/:id/query',async c=>{
  const denied=requireScopes(c,'read:memos');if(denied)return denied;
  return c.json(await new SharedTableStore(c.env.storage.db).query(getWorkspaceId(c),c.req.param('id'),await c.req.json()));
 });
 app.post('/candidate/tables/:id/records',async c=>{
  const denied=requireScopes(c,'write:memos');if(denied)return denied;
  return c.json(await new SharedTableStore(c.env.storage.db).apply(getWorkspaceId(c),c.req.param('id'),await c.req.json()));
 });
 app.post('/candidate/tables/:id/snapshot',async c=>{
  const denied=requireScopes(c,'read:memos');if(denied)return denied;
  const {revision}=await c.req.json();
  return c.json(await new SharedTableStore(c.env.storage.db).snapshot(getWorkspaceId(c),c.req.param('id'),revision));
 });
}
