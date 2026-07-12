import { bootstrapCloudData, startCloudSaveUi } from "/cloud-save-v3.js?v=20260712-1";

await bootstrapCloudData();
await import("/assets/index-v121-ui-status-fix-v2.js");
startCloudSaveUi();
