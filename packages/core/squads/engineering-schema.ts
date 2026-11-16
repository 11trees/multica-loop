import {z} from "zod";
import {teamDefinitionSchema} from "@multica/command-chain/team";
export {teamDefinitionSchema,teamWorkflowRoles} from "@multica/command-chain/team";
export type {TeamDefinition} from "@multica/command-chain/team";
export const EngineeringTeamProfileSchema=z.object({workspaceId:z.uuid(),teamId:z.uuid(),revision:z.number().int().positive(),configuredBy:z.uuid(),definition:teamDefinitionSchema,createdAt:z.iso.datetime()});
export const EngineeringTeamResponseSchema=z.object({enabled:z.boolean().default(true),profile:EngineeringTeamProfileSchema.nullable()});
export type EngineeringTeamProfile=z.infer<typeof EngineeringTeamProfileSchema>;
export type EngineeringTeamResponse=z.infer<typeof EngineeringTeamResponseSchema>;
