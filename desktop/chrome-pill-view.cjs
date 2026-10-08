const button = document.getElementById('resume');
let sessionId = null;
window.plyChromePill.onLabel(message => {
  sessionId = message.sessionId;
  button.textContent = message.label;
  if (message.enter && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    button.classList.remove('in');
    requestAnimationFrame(() => requestAnimationFrame(() => button.classList.add('in')));
  } else button.classList.add('in');
});
button.addEventListener('click', () => { if (sessionId) window.plyChromePill.resume(sessionId); });
