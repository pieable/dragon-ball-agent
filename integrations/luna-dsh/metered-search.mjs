import {searchWeb} from './web-search.mjs';
export async function runMeteredSearch(args,{record,save,sanitize=value=>value,search=searchWeb}) {
  let result,failure;
  try{result=await search(args);}
  catch(error){failure={code:error.code,message:error.message,status:error.status,response_body:error.response_body,request_id:error.request_id,response_id:error.response_id,usage:error.usage,web_search_calls:error.web_search_calls,error:error.error,incomplete_details:error.incomplete_details};}
  const observed=result??failure;record.auxiliary_usage??=[];
  record.auxiliary_usage.push({tool:'search_web',status:failure?'failed':'completed',usage:observed.usage??null,web_search_calls:observed.web_search_calls?.length??null,search_actions:observed.web_search_calls?.map(call=>({id:call.id,status:call.status,action_type:call.action?.type}))??null,response_id:observed.response_id,request_id:observed.request_id,cost_known:Boolean(observed.usage),at:new Date().toISOString()});
  await save(record);
  if(failure)throw new Error(JSON.stringify(sanitize(failure)));
  return result;
}
