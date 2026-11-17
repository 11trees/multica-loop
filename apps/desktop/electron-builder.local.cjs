const applyMacUpdateFloor = require("./scripts/mac-update-floor.cjs");
const {join} = require("node:path");

module.exports = {
  extends: "./electron-builder.yml",
  appId: "ai.loopwork.multica.local",
  productName: "Multica Loop",
  extraMetadata: {productName: "Multica Loop"},
  files: ["!eslint.config.*", "!electron-builder.*", "!scripts/**"],
  publish: null,
  mac: {notarize: false, identity: null},
  beforePack(context) {
    // electron-builder concatenates inherited arrays; [] cannot clear protocols.
    context.packager.config.protocols = [];
    context.packager.platformSpecificBuildOptions.protocols = [];
    applyMacUpdateFloor(context);
  },
  async afterPack(context) {
    const {verifyPackedArchive} = await import("./scripts/verify-asar.mjs");
    const archive = context.electronPlatformName === "darwin"
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents/Resources/app.asar")
      : join(context.appOutDir, "resources/app.asar");
    const result = verifyPackedArchive(archive, context.packager.appInfo.version);
    console.log(`[local-package] verified ${result.files} packed files (${result.bytes} bytes)`);
  },
};
