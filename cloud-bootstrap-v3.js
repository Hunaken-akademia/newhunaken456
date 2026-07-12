import { bootstrapCloudData, startCloudSaveUi } from "/cloud-save-v3.js?v=20260712-1";

await bootstrapCloudData();
await import("/src/main.jsx");
startCloudSaveUi();
