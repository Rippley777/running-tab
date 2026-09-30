import {createHash} from 'node:crypto';
import {AppError} from '../db/index.js';
export function ratio(numerator:number|bigint,denominator:number|bigint):number{const n=BigInt(numerator),d=BigInt(denominator);if(d<=0n||n<0n)throw new AppError('INVALID_AMOUNT','Invalid exact ratio.');const result=(n+d/2n)/d;if(result>100_000_000n)throw new AppError('AMOUNT_LIMIT','Amount exceeds the MVP transaction limit.');return Number(result);}
export function timeValue(seconds:number,rate:number){return ratio(BigInt(seconds)*BigInt(rate),3600);}
export function roundedSeconds(actual:number,increment:number){return increment===0?actual:Math.ceil(actual/(increment*60))*increment*60;}
export function invoiceTotals(amounts:number[],discount=0,taxBps=0){const subtotal=amounts.reduce((a,b)=>a+b,0);if(discount>subtotal)throw new AppError('DISCOUNT_TOO_LARGE','Discount cannot exceed service subtotal.');const tax=ratio(BigInt(subtotal-discount)*BigInt(taxBps),10000);return{subtotal,discount,tax,total:subtotal-discount+tax};}
export function snapshotHash(input:unknown):string{const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'&&!(v instanceof Date)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;return createHash('sha256').update(JSON.stringify(stable(input))).digest('hex');}
export function csvCell(value:unknown){let s=String(value??'');if(/^[\s]*[=+\-@\t\r]/.test(s))s=`'${s}`;return`"${s.replaceAll('"','""')}"`;}
export function csv(records:Record<string,unknown>[],fields:string[]){return [fields.map(csvCell).join(','),...records.map(r=>fields.map(f=>csvCell(r[f])).join(','))].join('\r\n');}
