// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { handoffReservationHash, handoffReservationSchema } from "./repair-handoff";

it("matches the native UTF-8 reservation witness and detects a changed checkpoint",async()=>{
 const value=JSON.parse(await readFile(new URL("./test-helpers/repair-handoff-reservation.json",import.meta.url),"utf8"));
 expect(handoffReservationSchema.parse(value)).toEqual(value);
 expect(handoffReservationHash(value)).toBe(value.hash);
 expect(()=>handoffReservationSchema.parse({...value,continuation:{...value.continuation,expected_sequence:value.continuation.expected_sequence+1}})).toThrow(/hash changed/);
});
