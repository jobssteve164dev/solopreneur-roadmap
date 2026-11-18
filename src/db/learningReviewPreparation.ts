import { createHash } from 'crypto';
import type { ReviewManifest, ReviewSource } from '../learningReview.js';
import type { LearningReviewSourceRow } from './learningReviewSourceCapture.js';

/** Reconstitute the actual captured SQL data, including the original native reference overlays. */
export function materializeCapturedReviewSource(row:LearningReviewSourceRow,decode:(contentId:string)=>unknown):Record<string,unknown> {
  const data:Record<string,unknown>={...row.data};
  if(row.kind==='lesson_decision'){
    const candidates=(row.referenceRows || []).map(ref=>({objectId:String(ref.lesson_id),revision:ref.lesson_revision===null?null:Number(ref.lesson_revision)}));
    data.candidate_refs=candidates.length || !data.lesson_id || data.lesson_revision!=null?candidates:[{objectId:data.lesson_id,revision:null}];
  }
  if(row.kind==='lesson'){
    const refs=row.referenceRows || [],ids:string[]=data.source_event_ids_json?JSON.parse(String(data.source_event_ids_json)):[];
    data.event_refs=refs.length?refs.map(ref=>({sourceId:String(ref.source_id),objectId:ref.event_id===null?null:String(ref.event_id),revision:ref.event_revision===null?null:Number(ref.event_revision)})):ids.map(sourceId=>({sourceId,objectId:null,revision:null}));
  }
  for(const [field,value] of Object.entries(data))if(value && (field==='content_id' || field.endsWith('_content_id')))data[field==='content_id'?'content':field.slice(0,-3)]=decode(String(value));
  if(row.kind==='report' && typeof data.content==='string'){
    try{const report=JSON.parse(data.content);if(report && typeof report.summary==='string')data.summary=report.summary;}catch{/* Preserve malformed original report text. */}
  }
  return data;
}

/** Hash the same JSON as the full manifest while loading one stored source body at a time. */
export async function hashStoredReviewManifest(manifest:ReviewManifest,sourceContents:Readonly<Record<string,string>>,load:(contentId:string)=>string|Promise<string>):Promise<string> {
  const hash=createHash('sha256');let bodies=0;
  const source=async(value:ReviewSource):Promise<void>=>{
    hash.update('{');let separator='';
    for(const [key,item] of Object.entries(value)){
      if(item===undefined)continue;
      hash.update(separator+JSON.stringify(key)+':');separator=',';
      if(key==='content'){
        const id=sourceContents[`${value.id}:${value.hash}:${value.contentHash}`] || sourceContents[`${value.id}:${value.hash}`];
        if(!id)throw new Error('learning_review_source_content_missing');
        hash.update(JSON.stringify(await load(id)));if(++bodies%128===0)await new Promise<void>(resolve=>setImmediate(resolve));
      }else if(key==='value' && (sourceContents[`@value:${value.id}:${value.hash}:${value.contentHash}`] || sourceContents[`@value:${value.id}:${value.hash}`])){
        hash.update(await load(sourceContents[`@value:${value.id}:${value.hash}:${value.contentHash}`] || sourceContents[`@value:${value.id}:${value.hash}`]));
      }else if(key==='previousVersions'){
        hash.update('[');for(let index=0;index<item.length;index++){if(index)hash.update(',');await source(item[index]);}hash.update(']');
      }else hash.update(JSON.stringify(item));
    }
    hash.update('}');
  };
  hash.update('{');let separator='';
  for(const [key,value] of Object.entries(manifest)){
    if(value===undefined)continue;
    hash.update(separator+JSON.stringify(key)+':');separator=',';
    if(key==='sources'){hash.update('[');for(let index=0;index<value.length;index++){if(index)hash.update(',');await source(value[index]);}hash.update(']');}
    else hash.update(JSON.stringify(value));
  }
  return hash.update('}').digest('hex');
}
