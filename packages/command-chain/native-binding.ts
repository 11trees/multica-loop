export type NativeBindingResult={bound:true;repository_path:string};
/** The workflow validates first; the host commits all binding facts together. */
export type NativeBindingCommit=(write:()=>NativeBindingResult)=>NativeBindingResult;
