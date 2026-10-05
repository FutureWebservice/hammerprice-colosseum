/**
 * Typed fetch wrappers for the pack surfaces. The routes live in src/app/api/packs (contracts/api.ts ROUTES is the agreement); this file
 * only speaks their shapes. `PACK_PATHS` repeats the paths as literals and api.test.ts compares every entry with ROUTES.
 */
import type { PackCreateRequest, PackOpenRequest, SignInput } from '@/contracts';
import type { RouteResponse } from '@/contracts/api';
import { call, type ApiResult } from '@/components/sell/api';

export const PACK_PATHS = {
  packsList: '/api/packs',
  packsMine: '/api/packs/mine',
  packsOperator: '/api/packs/operator',
  packsDeliveries: '/api/packs/deliveries',
  packsCreate: '/api/packs',
  packsDetail: '/api/packs/:id',
  packsControl: '/api/packs/:id/control',
  packsOpen: '/api/packs/:id/open',
  packsDraws: '/api/packs/:id/draws',
  packsDraw: '/api/packs/draws/:id',
  packsDrawPrepare: '/api/packs/draws/:id/prepare',
  packsDrawSign: '/api/packs/draws/:id/sign',
} as const;
const fill = (path: string, id: string) => path.replace(':id', encodeURIComponent(id));

export type { ApiResult };
export const listPacks = () => call<RouteResponse<'packsList'>>('GET', PACK_PATHS.packsList);
export const myPacks = () => call<RouteResponse<'packsMine'>>('GET', PACK_PATHS.packsMine);
export const operatorAccess = () => call<RouteResponse<'packsOperator'>>('GET', PACK_PATHS.packsOperator);
export const myDeliveries = () => call<RouteResponse<'packsDeliveries'>>('GET', PACK_PATHS.packsDeliveries);
export const createPack = (body: PackCreateRequest) => call<RouteResponse<'packsCreate'>>('POST', PACK_PATHS.packsCreate, { body });
export const getPack = (id: string) => call<RouteResponse<'packsDetail'>>('GET', fill(PACK_PATHS.packsDetail, id));
export const controlPack = (id: string, action: 'publish' | 'pause' | 'resume' | 'close') => call<RouteResponse<'packsControl'>>('POST', fill(PACK_PATHS.packsControl, id), { body: { action } });
export const openPack = (id: string, body: PackOpenRequest) => call<RouteResponse<'packsOpen'>>('POST', fill(PACK_PATHS.packsOpen, id), { body });
export const getDraws = (id: string, limit = 10) => call<RouteResponse<'packsDraws'>>('GET', fill(PACK_PATHS.packsDraws, id), { query: { limit: String(limit) } });
export const getDraw = (id: string) => call<RouteResponse<'packsDraw'>>('GET', fill(PACK_PATHS.packsDraw, id));
export const prepareDraw = (id: string) => call<RouteResponse<'packsDrawPrepare'>>('POST', fill(PACK_PATHS.packsDrawPrepare, id), { body: {} });
export const signDraw = (id: string, body: SignInput) => call<RouteResponse<'packsDrawSign'>>('POST', fill(PACK_PATHS.packsDrawSign, id), { body });
