import {beforeEach,expect,it,vi} from "vitest";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {fireEvent,screen,waitFor} from "@testing-library/react";
import {renderWithI18n} from "../test/i18n";
import {HistoryPreparation} from "./history-preparation";
const mocks=vi.hoisted(()=>({historyPreparation:vi.fn(),prepareHistoryTask:vi.fn()}));
vi.mock("@multica/core/api",()=>({api:mocks}));
const base={sourceOwner:"LoopWork",executionAuthorized:false,sourceTaskId:"source-task",packetHash:"b".repeat(64),archiveHash:"a".repeat(64),mappedProjectId:"",projects:[],teams:[{id:"team",name:"Development Team",revision:1,workflow:"develop"}],blockers:[],preparations:[]};
beforeEach(()=>{vi.resetAllMocks();mocks.historyPreparation.mockResolvedValue(base);});
function mount(hash=base.packetHash){return renderWithI18n(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}><HistoryPreparation wsId="workspace" userId="owner" taskId="source-task" packetHash={hash}/></QueryClientProvider>);}
it("saves project and Team preparation without choosing per-task Agents or starting execution",async()=>{
 const saved={id:"prep",revision:1,projectId:"project",teamId:"team",teamRevision:1,current:true};
 mocks.prepareHistoryTask.mockImplementation(async()=>{mocks.historyPreparation.mockResolvedValue({...base,mappedProjectId:"project",projects:[{id:"project",title:"Original project"}],preparations:[saved]});return saved;});
 mount();expect(await screen.findByRole('button',{name:'Save preparation'})).toBeEnabled();expect(screen.getByLabelText('Native project')).toHaveValue('create');expect(screen.getByLabelText('Team')).toHaveValue('team');
 fireEvent.click(screen.getByRole('button',{name:'Save preparation'}));expect(await screen.findByText('Preparation revision 1 saved')).toBeInTheDocument();expect(mocks.prepareHistoryTask).toHaveBeenCalledWith('workspace','source-task',{expectedRevision:0,expectedPacketHash:base.packetHash,teamId:'team',expectedTeamRevision:1,createProject:true});expect(screen.getByLabelText('Native project')).toBeDisabled();expect(screen.queryByRole('button',{name:/start|run|done/i})).not.toBeInTheDocument();expect(screen.queryByLabelText(/Agent/)).not.toBeInTheDocument();
});
it("keeps a rejected save unsaved and refreshes the current Team version before retry",async()=>{
 mocks.prepareHistoryTask.mockRejectedValueOnce(new Error('Team version changed'));mount();fireEvent.click(await screen.findByRole('button',{name:'Save preparation'}));expect(await screen.findByRole('alert')).toHaveTextContent(/Reload the material/);expect(screen.queryByText(/Preparation revision/)).not.toBeInTheDocument();
 mocks.historyPreparation.mockResolvedValue({...base,teams:[{...base.teams[0],revision:2}]});fireEvent.click(screen.getByRole('button',{name:'Retry'}));await waitFor(()=>expect(mocks.historyPreparation).toHaveBeenCalledTimes(2));fireEvent.click(screen.getByRole('button',{name:'Save preparation'}));await waitFor(()=>expect(mocks.prepareHistoryTask).toHaveBeenLastCalledWith('workspace','source-task',expect.objectContaining({expectedTeamRevision:2})));
});
it("does not prepare deleted projects or a different frozen material version",async()=>{
 mocks.historyPreparation.mockResolvedValue({...base,blockers:['source_project_deleted']});const view=mount();expect(await screen.findByText(/source project was deleted/)).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Save preparation'})).not.toBeInTheDocument();view.unmount();
 mocks.historyPreparation.mockResolvedValue(base);mount('c'.repeat(64));expect(await screen.findByRole('alert')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Save preparation'})).toBeDisabled();expect(mocks.prepareHistoryTask).not.toHaveBeenCalled();
});
