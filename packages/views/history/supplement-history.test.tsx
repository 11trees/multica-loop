import {expect,it,vi} from "vitest";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {screen} from "@testing-library/react";
import {renderWithI18n} from "../test/i18n";
import {NavigationProvider} from "../navigation";
import {SupplementHistory} from "./supplement-history";
const api=vi.hoisted(()=>({historyAvailability:vi.fn(),historySupplement:vi.fn(),downloadHistorySupplementFile:vi.fn()}));vi.mock("@multica/core/api",()=>({api}));
it("does not request supplemental material when the current human/workspace is unavailable",async()=>{
 api.historyAvailability.mockResolvedValue({enabled:false,supplement:{enabled:false,hash:""}});
 renderWithI18n(<NavigationProvider value={{push:vi.fn(),replace:vi.fn(),back:vi.fn(),pathname:"/test/history",searchParams:new URLSearchParams("archive=supplement"),hash:"",getShareableUrl:path=>path}}><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><SupplementHistory wsId="foreign-workspace" userId="foreign-user"/></QueryClientProvider></NavigationProvider>);
 expect(await screen.findByText('Supplementary history is unavailable in this workspace.')).toBeInTheDocument();expect(api.historySupplement).not.toHaveBeenCalled();expect(api.downloadHistorySupplementFile).not.toHaveBeenCalled();
});
