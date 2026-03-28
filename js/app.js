import { renderSessionsView } from './sessions.js';
import { renderAnalyticsView } from './analytics.js';

document.addEventListener('DOMContentLoaded', () => {
  const content = document.getElementById('content');
  const navBtns = document.querySelectorAll('.nav-btn');

  function switchView(view) {
    navBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
    content.innerHTML = '';
    if (view === 'sessions') {
      renderSessionsView(content);
    } else {
      renderAnalyticsView(content);
    }
  }

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  switchView('sessions');
});
