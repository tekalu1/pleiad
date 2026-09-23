// Only descendants need Electron's embedded Node runtime. Setting this before
// utilityProcess starts makes Chromium's utility flags look like Node options.
process.env.ELECTRON_RUN_AS_NODE = '1';
import('../core/server.mjs').catch(error => { console.error(error.message); process.exit(1); });
