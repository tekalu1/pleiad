import { t } from './i18n.mjs';
import { externalOrigin, previewPolicy } from './browser-confirm-policy.mjs';

let getPrefs = () => ({}), openSettings = () => {};
const records = new WeakMap();
const blocked = new Set();
const listeners = new Set();
export const blockedPreviewOrigins = () => [...blocked];
export function onBlockedPreviewOrigins(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function configurePreviewConfirmation(options) { getPrefs = options.getPrefs; openSettings = options.openSettings; }
export const currentPreviewPolicy = () => previewPolicy(getPrefs());

export function confirmedPreview(frame, render) {
  const record = { render, once: new Set(), violations: new Map(), bar: null, policy: '' };
  records.set(frame, record);
  draw(frame, record);
  return frame;
}
function draw(frame, record) {
  const policy = previewPolicy(getPrefs(), [...record.once]);
  record.policy = JSON.stringify(policy);
  record.violations.clear(); record.bar?.remove(); record.bar = null;
  frame.srcdoc = record.render(policy);
}
export function refreshPreviewConfirmation() {
  for (const frame of document.querySelectorAll('iframe.visualize-frame,iframe.file-preview-frame')) {
    const record = records.get(frame);
    if (record && record.policy !== JSON.stringify(previewPolicy(getPrefs(), [...record.once]))) draw(frame, record);
  }
}
export function receivePreviewViolation(event) {
  if (event.data?.type !== 'ply-preview-blocked' || getPrefs().confirmExternalLoads !== true) return false;
  const origin = externalOrigin(event.data.url);
  if (!origin) return false;
  for (const frame of document.querySelectorAll('iframe.visualize-frame,iframe.file-preview-frame')) {
    const record = records.get(frame);
    if (!record || frame.contentWindow !== event.source) continue;
    const allowed = previewPolicy(getPrefs(), [...record.once]).origins;
    if (allowed.includes(origin)) return false;
    const key = String(event.data.url).slice(0, 2048);
    if (record.violations.has(key)) return true;
    // The opaque frame may report arbitrary content. Bound memory and show text only.
    if (record.violations.size >= 500) return false;
    record.violations.set(key, origin);
    if (blocked.size < 500) blocked.add(origin);
    paintBar(frame, record);
    for (const listener of listeners) listener();
    return true;
  }
  return false;
}
function paintBar(frame, record) {
  if (!record.bar) {
    const bar = document.createElement('div'); bar.className = 'preview-blocked';
    const label = document.createElement('span'); label.setAttribute('role', 'status');
    const load = document.createElement('button'); load.type = 'button'; load.textContent = t('settings.browser.confirm.load');
    load.onclick = () => { for (const origin of record.violations.values()) record.once.add(origin); draw(frame, record); };
    const settings = document.createElement('button'); settings.type = 'button'; settings.textContent = t('settings.browser.confirm.settings');
    settings.onclick = () => openSettings();
    bar.append(label, load, settings); frame.after(bar); record.bar = bar;
  }
  record.bar.firstChild.textContent = t('settings.browser.confirm.blocked', { count: record.violations.size });
}
if (typeof window !== 'undefined') window.addEventListener?.('message', receivePreviewViolation);
