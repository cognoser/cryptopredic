(function () {
  const storageKey = 'tcn-theme';

  function setupTheme() {
    const body = document.body;
    if (!body) return;

    const navigation = document.querySelector('.site-nav, header nav');
    if (!navigation || navigation.querySelector('.theme-toggle')) return;

    document.querySelectorAll('a[href="index.html#latest-news"]').forEach(function (link) {
      link.href = 'todays-article.html';
      link.textContent = "Today's article";
    });

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-toggle';
    button.setAttribute('aria-label', 'Switch color theme');
    button.title = 'Switch color theme';

    function applyTheme(theme) {
      const nextTheme = theme === 'light' ? 'light' : 'dark';
      body.dataset.theme = nextTheme;
      button.textContent = nextTheme === 'dark' ? '☼' : '☾';
      button.setAttribute('aria-label', nextTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      button.title = nextTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    }

    button.addEventListener('click', function () {
      const nextTheme = body.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(storageKey, nextTheme);
      applyTheme(nextTheme);
    });

    navigation.appendChild(button);
    applyTheme(localStorage.getItem(storageKey) || 'dark');
  }

  document.addEventListener('DOMContentLoaded', setupTheme);
})();
