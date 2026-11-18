import { types } from 'util';

type DataValueReference={reference:number}|{value:unknown};
type DataValueNode={kind:'object'|'array';length?:number;nullPrototype?:boolean;fields:Array<[string,DataValueReference]>}|{kind:'native';value:object};
type DataValueContainerNode=Extract<DataValueNode,{kind:'object'|'array'}>;
export interface DataValueTransfer {root:DataValueReference;nodes:DataValueNode[]}

function container(value:unknown):value is Record<string,unknown> {
  if(!value || typeof value!=='object' || types.isProxy(value))return false;
  const prototype=Object.getPrototypeOf(value);return Array.isArray(value) || prototype===null || prototype===Object.prototype;
}

/** Flatten fixed ordinary data; preserve native cloning for generated/native inputs. */
export function dataValueNeedsTransfer(value:unknown):boolean {
  if(!container(value))return false;
  const seen=new WeakSet<object>([value]),frames=[{value,keys:Object.keys(value),index:0}];let deep=false;
  while(frames.length){
    if(frames.length>128)deep=true;
    const frame=frames[frames.length-1];if(frame.index===frame.keys.length){frames.pop();continue;}
    const field=Object.getOwnPropertyDescriptor(frame.value,frame.keys[frame.index++]);if(!field)continue;
    if(!('value' in field))return false;
    const child=field.value;
    if(typeof child==='function' || typeof child==='symbol')return false;
    if(child && typeof child==='object'){
      if(!container(child))return false;
      if(!seen.has(child)){seen.add(child);frames.push({value:child,keys:Object.keys(child),index:0});}
    }
  }
  return deep;
}

/** Flat private references keep existing Worker ports from recursively cloning deep JSON. */
export function createDataValueTransfer(value:unknown):DataValueTransfer {
  const nodes:DataValueNode[]=[],ids=new WeakMap<object,number>(),frames:Array<{source:object;node:DataValueContainerNode;keys:string[];index:number}>=[];
  const reference=(item:unknown):DataValueReference=>{
    if(!item || typeof item!=='object')return{value:item};
    const existing=ids.get(item);if(existing!==undefined)return{reference:existing};
    const id=nodes.length;ids.set(item,id);
    if(container(item)){
      const node:DataValueContainerNode={kind:Array.isArray(item)?'array':'object',...(Array.isArray(item)?{length:item.length}:{nullPrototype:Object.getPrototypeOf(item)===null}),fields:[]};nodes.push(node);frames.push({source:item,node,keys:Object.keys(item),index:0});
    }else nodes.push({kind:'native',value:item});return{reference:id};
  };
  const root=reference(value);
  while(frames.length){
    const frame=frames[frames.length-1];if(frame.index===frame.keys.length){frames.pop();continue;}
    const name=frame.keys[frame.index++];if(!Object.prototype.hasOwnProperty.call(frame.source,name))continue;
    frame.node.fields.push([name,reference(Reflect.get(frame.source,name))]);
  }
  return{root,nodes};
}

export function dataValueTransferIfDeep(value:unknown):DataValueTransfer|undefined {
  return dataValueNeedsTransfer(value)?createDataValueTransfer(value):undefined;
}

export function restoreDataValueTransfer(transfer:DataValueTransfer):unknown {
  const values=transfer.nodes.map(node=>node.kind==='native'?node.value:node.kind==='array'?new Array(node.length):Object.create(node.nullPrototype?null:Object.prototype));
  const value=(item:DataValueReference):unknown=>{
    if('value' in item)return item.value;
    if(!Number.isInteger(item.reference) || item.reference<0 || item.reference>=values.length)throw new Error('data_value_transfer_invalid');return values[item.reference];
  };
  for(const [index,node] of transfer.nodes.entries())if(node.kind!=='native')for(const [name,item] of node.fields)Object.defineProperty(values[index],name,{value:value(item),enumerable:true,configurable:true,writable:true});
  return value(transfer.root);
}
