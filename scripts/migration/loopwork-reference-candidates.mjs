// These explicit syntaxes describe candidate references, not filesystem authority.
// Prose without one of these forms and repository directory contents remain outside coverage.
export function referenceCandidates(text) {
 if(typeof text!=='string')return [];
 const result=[],seen=new Set(),covered=[];
 const add=(target,syntax,pointer='')=>{if(typeof target!=='string'||!target.trim())return;target=target.trim();const key=JSON.stringify([target,syntax,pointer]);if(!seen.has(key)){seen.add(key);result.push({target,syntax,pointer});}};
 const pathLike=value=>/^(?:\.\.?\/|\/|file:|https?:|data:|[A-Za-z0-9_.-]+\/)/i.test(value)||/\.(?:png|jpe?g|gif|webp|svg|pdf|html?|md|jsonl?|txt|log|csv|zip|mp4)(?:[?#].*)?$/i.test(value);
 // JSON fields retain their pointer, including arrays of paths and nested JSON strings.
 const visit=(value,pointer='',pathField=false,depth=0)=>{
  if(depth>30)return;
  if(typeof value==='string'){
   if(pathField)add(value,'json_path',pointer);
   if(/^[\s]*[\[{]/.test(value))try{visit(JSON.parse(value),pointer,pathField,depth+1);}catch{}
  }else if(Array.isArray(value))value.forEach((item,index)=>visit(item,`${pointer}/${index}`,pathField,depth+1));
  else if(value&&typeof value==='object')for(const [key,item] of Object.entries(value))visit(item,`${pointer}/${key.replaceAll('~','~0').replaceAll('/','~1')}`,/^(?:paths?|files?|file_paths?|relative_path|artifact_paths?|screenshot|image|src|href|url)$/i.test(key),depth+1);
 };
 try{visit(JSON.parse(text));}catch{}
 // Markdown destinations may contain balanced parentheses, angle brackets or a title.
 for(const match of text.matchAll(/!?\[[^\]\n]*\]\(/g)){
  let i=match.index+match[0].length;while(/[ \t]/.test(text[i]??'')&&i<text.length)i++;
  if(text[i]==='<'){const end=text.indexOf('>',i+1);if(end>=0&&!text.slice(i,end).includes('\n')){add(text.slice(i+1,end),'markdown');covered.push([match.index,end+1]);}continue;}
  let target='',depth=0;
  for(;i<text.length;i++){const char=text[i];if(char==='\\'&&i+1<text.length){target+=text[++i];continue;}if(char==='(')depth++;if(char===')'){if(!depth)break;depth--;}if(/\s/.test(char)&&!depth)break;target+=char;}
  add(target,'markdown');
  covered.push([match.index,i]);
 }
 for(const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm)){add(match[1]??match[2],'markdown_definition');covered.push([match.index,match.index+match[0].length]);}
 for(const match of text.matchAll(/<(?:img|a|source|video|audio)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/gi)){add(match[1],'html');covered.push([match.index,match.index+match[0].length]);}
 for(const match of text.matchAll(/`([^`\n]+)`/g))if(pathLike(match[1])){add(match[1],'inline_path');covered.push([match.index,match.index+match[0].length]);}
 for(const match of text.matchAll(/(?:\.tmp\/|\/Users\/)[^\s`"'<>()[\]，。；、（）【】“”]+/g))if(!covered.some(([start,end])=>match.index>=start&&match.index<end))add(match[0].replace(/[.,;:]+$/,''),'literal_path');
 return result;
}
