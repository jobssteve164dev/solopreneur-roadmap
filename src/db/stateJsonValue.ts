import { types } from 'util';
import { canCaptureNativeBuffer, jsonByteViewLength, nativeBufferJson, snapshotJsonByteView } from './dataWritePublication.js';
import type { StateImport } from './importObjectPublication.js';
import { createDataValueTransfer,restoreDataValueTransfer,type DataValueTransfer } from './dataValueTransfer.js';

type JsonMethods=typeof JSON & {isRawJSON?:(value:unknown)=>boolean};
export interface StateJsonSnapshot {
  value:unknown;
  nativeBuffers:NonNullable<StateImport['nativeBuffers']>[number][];
  nativeProperties:NonNullable<StateImport['nativeProperties']>[number][];
  nativeRawJson:NonNullable<StateImport['nativeRawJson']>[number][];
  transport?:DataValueTransfer;
}
/** Compute-side encoding after caller hooks and private byte capture have completed. */
export function encodeStateJson(value:StateJsonSnapshot):string|undefined {
  if(value.transport)return encodeStateJson(restoreDataValueTransfer(value.transport) as StateJsonSnapshot);
  const buffers=new Set(value.nativeBuffers),properties=new Map(value.nativeProperties.map(item=>[item.value,item.properties])),rawValues=new Set(value.nativeRawJson),nativeJson=JSON as typeof JSON & {rawJSON?:(value:string)=>unknown},expanded=new WeakMap<object,Record<string,unknown>>();
  return buffers.size || properties.size || rawValues.size?JSON.stringify(value.value,(_key,item)=>{
    if(buffers.has(item))return Buffer.from(item).toJSON();
    if(rawValues.has(item)){if(!nativeJson.rawJSON)throw new Error('native_raw_json_unavailable');return nativeJson.rawJSON(item.rawJSON);}
    const fields=properties.get(item);if(!fields)return item;
    const current=expanded.get(item);if(current)return current;
    const result=Object.assign(Object.create(null),item,fields) as Record<string,unknown>;expanded.set(item,result);return result;
  }):JSON.stringify(value.value);
}
/** Generate once before admission; only private data crosses subsequent awaits. */
export function captureStateJson(value:unknown):StateJsonSnapshot {
  const result:StateJsonSnapshot={value:undefined,nativeBuffers:[],nativeProperties:[],nativeRawJson:[]},json=JSON as JsonMethods,ancestors=new WeakSet<object>();
  const frames:Array<{source:object;target:object;keys?:string[];length:number;index:number}>=[];let depth=0;
  const copy=(input:unknown,key:string):unknown=>{
    let item=input;
    if(item!==null && ['object','function','bigint'].includes(typeof item)){
      const receiver=Object(item) as object,hook=Reflect.get(receiver,'toJSON',item);
      if(typeof hook==='function'){
        if(hook===nativeBufferJson && canCaptureNativeBuffer(item)){const bytes=snapshotJsonByteView(item as Uint8Array) as Uint8Array;result.nativeBuffers.push(bytes);return bytes;}
        item=Reflect.apply(hook,item,[key]);
      }
    }
    if(item && typeof item==='object'){
      if(types.isNumberObject(item))item=Number(item);
      else if(types.isStringObject(item))item=String(item);
      else if(types.isBooleanObject(item))item=Boolean.prototype.valueOf.call(item);
      else if(types.isBoxedPrimitive(item) && !types.isSymbolObject(item))item=BigInt.prototype.valueOf.call(item);
    }
    if(typeof item==='bigint')throw new TypeError('Do not know how to serialize a BigInt');
    if(typeof item==='function' || typeof item==='symbol' || item===undefined)return undefined;
    if(!item || typeof item!=='object')return item;
    if(json.isRawJSON?.(item)){
      const literal=Object.assign(Object.create(null),{rawJSON:(item as {rawJSON:string}).rawJSON});result.nativeRawJson.push(literal);return literal;
    }
    const identity=item;
    if(ancestors.has(identity))throw new TypeError('Converting circular structure to JSON');
    ancestors.add(identity);
    if(ArrayBuffer.isView(item) && !types.isDataView(item)){
      const view=snapshotJsonByteView(item),length=jsonByteViewLength(view),initialLength=jsonByteViewLength(item),fields:Record<string,unknown>=Object.create(null);
      if(length>0 && typeof (item as unknown as Record<string,unknown>)['0']==='bigint')throw new TypeError('Do not know how to serialize a BigInt');
      const keys=Object.keys(item).filter(name=>!((name==='0' || /^[1-9]\d*$/.test(name)) && Number(name)<initialLength));
      if(keys.length)result.nativeProperties.push({value:view,properties:fields});frames.push({source:item,target:fields,keys,length:keys.length,index:0});return view;
    }
    if(Array.isArray(item)){
      const length=Number(Reflect.get(item,'length')),array=new Array(length);frames.push({source:item,target:array,length,index:0});return array;
    }
    const object:Record<string,unknown>=Object.create(null),keys=Object.keys(item);frames.push({source:item,target:object,keys,length:keys.length,index:0});return object;
  };
  result.value=copy(value,'');
  while(frames.length){
    depth=Math.max(depth,frames.length);
    const frame=frames[frames.length-1];if(frame.index===frame.length){ancestors.delete(frame.source);frames.pop();continue;}
    const name=frame.keys?frame.keys[frame.index]:String(frame.index);frame.index++;Object.defineProperty(frame.target,name,{value:copy(Reflect.get(frame.source,name),name),enumerable:true,configurable:true,writable:true});
  }
  return depth>128?{value:undefined,nativeBuffers:[],nativeProperties:[],nativeRawJson:[],transport:createDataValueTransfer(result)}:result;
}
