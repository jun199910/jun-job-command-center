// Completed reports are accepted only when the tool trace contains original-source reads.
async function audit(trace,originalUrl,fetchSource=fetch){
 const events=trace.split('\n').filter(Boolean).map(s=>{try{return JSON.parse(s)}catch{return {}}});
 const refs=new Set(),extra=new Set();let opened=false;
 for(const e of events){
  const i=e.item;if(!i)continue;
  if(['command_execution','mcp_tool_call'].includes(i.type))throw Error('Forbidden tool in isolated context');
  if(e.type!=='item.completed'||i.type!=='web_search')continue;
  if(!originalUrl)throw Error('Comparator used web access');
  const a=i.action||{};
  if(a.type==='search'||(i.query&&!/^https?:\/\//.test(i.query)&&a.type==='search'))throw Error('Search is forbidden for original-posting verification');
  if(a.type==='open_page'){
   const url=a.url;
   if(url===originalUrl)opened=true;
   else if(/^https?:\/\//.test(url||''))extra.add(url);
   else if(!refs.has(url))throw Error('Unproven source reference');
  }else if(a.type==='other'&&!i.query&&(i.results||[]).length&&(i.results||[]).every(r=>/^https?:\/\//.test(r.url||''))){
   // CLI represents link-clicks as "other". Accept only URLs whose embedding
   // can be independently established from the original document below.
   for(const r of i.results)if(r.url!==originalUrl)extra.add(r.url);
  }else if(!['find_in_page'].includes(a.type))throw Error('Unauditable web action: '+a.type);
  for(const r of i.results||[])if(r.ref_id)refs.add(r.ref_id);
 }
 if(originalUrl&&!opened)throw Error('Original URL was not opened');
 if(extra.size){
  // Only directly embedded images/frames from the exact original page may supplement it.
  const embedded=new Set(),documents=[originalUrl],seen=new Set();
  while(documents.length){
   const parent=documents.shift();if(seen.has(parent))continue;seen.add(parent);
   const res=await fetchSource(parent,{signal:AbortSignal.timeout(20000)});
   if(!res.ok)throw Error('Cannot prove embedded source provenance');
   const html=await res.text();
   for(const match of html.matchAll(/<(img|iframe)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)){
    try{const child=new URL(match[2].replace(/&amp;/g,'&'),parent).href;embedded.add(child);if(match[1].toLowerCase()==='iframe'&&extra.has(child))documents.push(child);}catch{}
   }
  }
  for(const url of extra)if(!embedded.has(url))throw Error('Non-original source rejected: '+url);
 }
 return {original_url:originalUrl,embedded_urls:[...extra],source_audit:'passed'};
}
module.exports={audit};
