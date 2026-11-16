// @vitest-environment node
import { expect,it } from "vitest";
import { checkpointRepairTargets } from "./repair-original-targets";
const binding={workspaceId:"w",issueId:"i",revision:1,contractVersion:"contract",codeVersion:"commit"};
const comment={id:"original-comment",version:"native-v1",content:"Original requested behavior",sourceRef:"COMMENT:original-comment",authorId:"reader"};
const context={ref:"original-context",version:"v1",content:"Frozen user context"};
const group={key:"original-group",workType:"bug",reason:"Original failure",commentIds:[comment.id],affectedDeliveryUnits:[1],acceptance:["Preserve the original acceptance"]};
const unit={index:1,key:"unit",version:"v1",content:"Original delivered unit"};
const evidence={ref:"test:original",kind:"verification",status:"passed",revision:"1",fingerprint:"a".repeat(64),independentTest:true,content:"Original independent observations"};
const variants:{chain:string;snapshot:Record<string,unknown>;key:string;fact:string}[]=[
  {chain:"direct",snapshot:{direct:{input:"Original Direct goal"}},key:"original-input",fact:"Original Direct goal"},
  ...["idea-context","business-design","requirement-spec","spec-review"].map((chain,index)=>({chain,snapshot:{contract:{binding,stage:["intent","business_design","specification","review"][index],decisionMode:"balanced"},business:{originalInput:"Original business idea",stage:["intent","business_design","specification","review"][index],upstream:[{draftId:"upstream",hash:"source-hash",content:"Published upstream fact"}],previous:null,returnReason:null,comments:[{id:"comment",version:"original-version",content:"Specification correction"}]}},key:"upstream:0",fact:"Published upstream fact"})),
  {chain:"context",snapshot:{contract:{binding,input:"Original requirement goal",kind:"requirement",decisionMode:"balanced"}},key:"original-input",fact:"Original requirement goal"},
  ...["analysis","development","verification"].map(chain=>({chain,snapshot:{contract:{sources:[{key:"acceptance",oracle:"Original oracle",sourceRef:"original-source"}]}},key:"source:acceptance",fact:"Original oracle"})),
  {chain:"planning",snapshot:{contract:{binding,sources:[{key:"technical",kind:"technical",content:"Original technical boundary",sourceRef:"source:technical"}],feedback:{batchId:"batch",groupId:"group",group,comments:[comment],context,units:[unit]},reproduction:{draftId:"repro",sequence:1,codeVersion:"commit",report:"Frozen reproduction result"}}},key:"feedback-comment:original-comment",fact:comment.content},
  {chain:"reproduction",snapshot:{contract:{binding,decisionMode:"balanced",contextRef:"context",contextFingerprint:"b".repeat(64),contextContent:"Frozen bug context",expectedBehavior:"Exact Existing Expected"}},key:"existing-expected",fact:"Exact Existing Expected"},
  {chain:"review",snapshot:{contract:{binding,generation:1,subjects:[{key:"acceptance",kind:"acceptance",content:"Original obligation",requiredEvidenceRefs:[evidence.ref]}],evidence:[evidence]}},key:"evidence:test:original",fact:evidence.content},
  {chain:"feedback-triage",snapshot:{contract:{binding,batchId:"batch",decisionMode:"balanced",comments:[comment],context,units:[unit],previousFeedback:[{ref:"old",version:"old-v1",content:"Preserve old feedback"}]}},key:"comment:original-comment",fact:comment.content},
  {chain:"feedback-verify",snapshot:{contract:{binding,batchId:"batch",groupId:"group",group,comment,context,work:{kind:"delivery",ref:"accepted:unit",version:"actual-v1",codeVersion:binding.codeVersion,content:"Authoritative accepted work"}}},key:"accepted-work",fact:"Authoritative accepted work"},
];
for(const fixture of variants)it(`derives ${fixture.chain} repair targets from its actual native contract`,()=>{
  const targets=checkpointRepairTargets(fixture.chain,fixture.snapshot),target=targets.find(item=>item.key===fixture.key);
  expect(target).toBeDefined();expect(JSON.stringify(target!.original)).toContain(fixture.fact);
  expect(new Set(targets.map(item=>item.key)).size).toBe(targets.length);
});
it("refuses unknown contracts and missing original facts instead of inventing an acceptance",()=>{
  expect(()=>checkpointRepairTargets("unknown",{contract:{sources:[{key:"fake",oracle:"Invented"}]}})).toThrow(/unsupported/);
  for(const chain of ["context","reproduction","review","feedback-triage","feedback-verify","planning"])expect(()=>checkpointRepairTargets(chain,{contract:{binding}})).toThrow();
  const business=variants.find(item=>item.chain==="idea-context")!;
  expect(()=>checkpointRepairTargets("spec-review",business.snapshot)).toThrow(/stage identity/);
});
