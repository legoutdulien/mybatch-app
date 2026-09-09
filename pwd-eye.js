// Ajoute un bouton "œil" (afficher/masquer) à chaque champ mot de passe de la page.
// Inclure sur toutes les pages avec un champ mot de passe : <script src="pwd-eye.js" defer></script>
// Couvre aussi les champs ajoutés dynamiquement (MutationObserver).
(function () {
  var EYE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYEOFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function addEye(inp) {
    if (!inp || inp.dataset.pwdEye || inp.type !== 'password') return;
    inp.dataset.pwdEye = '1';
    var wrap = document.createElement('span');
    wrap.className = 'pwd-eye-wrap';
    wrap.style.cssText = 'position:relative;display:block';
    if (!inp.parentNode) return;
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    var pr = parseInt(getComputedStyle(inp).paddingRight, 10) || 0;
    inp.style.paddingRight = Math.max(pr, 42) + 'px';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.tabIndex = -1;
    btn.setAttribute('aria-label', 'Afficher le mot de passe');
    btn.style.cssText = 'position:absolute;top:0;bottom:0;right:8px;margin:auto 0;height:28px;width:32px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;color:#9a9a9a;padding:0;z-index:2';
    btn.innerHTML = EYE;
    btn.addEventListener('click', function () {
      var show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      btn.innerHTML = show ? EYEOFF : EYE;
      btn.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
      btn.style.color = show ? '#555' : '#9a9a9a';
    });
    wrap.appendChild(btn);
  }

  function scan(root) {
    try { (root || document).querySelectorAll('input[type="password"]').forEach(addEye); } catch (e) {}
  }

  function init() {
    scan();
    try { new MutationObserver(function () { scan(); }).observe(document.body, { childList: true, subtree: true }); } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
