const applyMacUpdateFloor = require("./scripts/mac-update-floor.cjs");

module.exports = {
  extends: "./electron-builder.yml",
  appId: "ai.loopwork.multica.local",
  productName: "Multica Loop",
  extraMetadata: {productName: "Multica Loop"},
  publish: null,
  mac: {notarize: false, identity: null},
  beforePack(context) {
    // electron-builder concatenates inherited arrays; [] cannot clear protocols.
    context.packager.config.protocols = [];
    context.packager.platformSpecificBuildOptions.protocols = [];
    applyMacUpdateFloor(context);
  },
};
