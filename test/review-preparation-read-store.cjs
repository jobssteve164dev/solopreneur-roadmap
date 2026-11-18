const {UnifiedDataStore}=require('../out/db/unifiedDataStore.js');

// Drive the real readonly planner in-process when a test must observe its reads.
exports.attachReviewPreparationReadStore=store=>{
  const reader=UnifiedDataStore.openReadOnly(store.root,store.databaseId),capture=UnifiedDataStore.openReadOnly(store.root,store.databaseId),previous=store.learningReviewPrepareCompute,previousCapture=store.learningReviewSourceCompute;
  let iterator,request,phase=0;
  const next=async acknowledgement=>{const value=await iterator.next(acknowledgement);return value.done?{preparationId:request.preparationId,phase,done:true,result:value.value}:{preparationId:request.preparationId,phase,done:false,value:value.value};};
  store.setLearningReviewPrepareCompute({...previous,
    begin:async value=>{if(iterator)throw Error('learning_review_prepare_busy');request=value;phase=0;iterator=reader.planLearningReviewPreparation(value,()=>capture);return next();},
    advance:async value=>{if(value.preparationId!==request.preparationId || value.phase!==phase)throw Error('learning_review_prepare_phase_changed');phase++;return next(value.acknowledgement);},
    release:async value=>{if(!iterator)return{released:false};if(value.preparationId!==request.preparationId)throw Error('learning_review_prepare_phase_changed');await iterator.return();iterator=undefined;return{released:true};},
    result:async value=>reader.projectLearningReviewPreparationResult(value)
  });
  store.setLearningReviewSourceCompute({begin:async value=>capture.beginLearningReviewSourceCapture(value),page:async value=>capture.captureLearningReviewSourcePage(value),peek:async value=>capture.peekLearningReviewSourceCapture(value),consume:async value=>capture.consumeLearningReviewSourceCapture(value),release:async value=>capture.releaseLearningReviewSourceCapture(value)});
  return{reader,close:async()=>{try{await iterator?.return();}finally{store.setLearningReviewPrepareCompute(previous);store.setLearningReviewSourceCompute(previousCapture);reader.close();capture.close();}}};
};
