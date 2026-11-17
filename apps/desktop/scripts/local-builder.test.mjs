import assert from "node:assert/strict";
import test from "node:test";
import local from "../electron-builder.local.cjs";

test("the local fork clears inherited URL handlers after builder configuration merging", () => {
  const original = [{name: "Multica", schemes: ["multica"]}];
  const context = {electronPlatformName: "darwin", packager: {
    config: {protocols: [...original]}, platformSpecificBuildOptions: {protocols: [...original]},
  }};
  local.beforePack(context);
  assert.deepEqual(context.packager.config.protocols, []);
  assert.deepEqual(context.packager.platformSpecificBuildOptions.protocols, []);
  assert.notEqual(local.appId, "ai.multica.desktop");
  assert.notEqual(local.productName, "Multica");
  assert.equal(local.publish, null);
});
