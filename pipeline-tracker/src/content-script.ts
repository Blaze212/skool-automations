function announce(): void {
  window.postMessage(
    { source: 'cs-crm-ext', type: 'ready', extensionId: chrome.runtime.id },
    window.location.origin,
  );
}

announce();

window.addEventListener('message', (e: MessageEvent) => {
  if (e.data?.source === 'cs-crm-page' && e.data?.type === 'discovery') {
    announce();
  }
});
