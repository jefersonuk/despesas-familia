// Prepara o espelho antes de abrir a interface do ezBookkeeping:
// entra automaticamente (somente leitura) e espera o service worker assumir as chamadas /api/.
(function () {
    var app = document.currentScript.getAttribute('data-app');

    function abrirApp() {
        var s = document.createElement('script');
        s.type = 'module';
        s.crossOrigin = '';
        s.src = app;
        document.head.appendChild(s);
    }

    function avisar(texto) {
        document.body.innerHTML = '<p style="font:16px system-ui;padding:24px">' + texto + '</p>';
    }

    if (!('serviceWorker' in navigator)) {
        avisar('Este navegador não suporta o modo de visualização. Use uma versão recente do Chrome, Safari ou Firefox.');
        return;
    }

    try {
        if (!localStorage.getItem('ebk_user_token')) localStorage.setItem('ebk_user_token', 'somente-leitura');
    } catch (e) { /* segue sem salvar */ }

    var usuario = fetch('espelho-usuario.json', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (u) { try { localStorage.setItem('ebk_user_info', JSON.stringify(u)); } catch (e) { /* ignora */ } })
        .catch(function () { /* o app busca o perfil depois */ });

    var controle = navigator.serviceWorker.register('sw.js').then(function (reg) {
        if (navigator.serviceWorker.controller) return;
        return new Promise(function (pronto) {
            navigator.serviceWorker.addEventListener('controllerchange', pronto, { once: true });
            navigator.serviceWorker.ready.then(function (r) { r.active.postMessage('assumir'); });
            setTimeout(function () {
                if (navigator.serviceWorker.controller) return;
                if (sessionStorage.getItem('espelho_recarregou')) { avisar('Não foi possível iniciar a visualização. Recarregue a página.'); return; }
                sessionStorage.setItem('espelho_recarregou', '1');
                location.reload();
            }, 4000);
        });
    });

    Promise.all([usuario, controle]).then(abrirApp, function () {
        avisar('Não foi possível iniciar a visualização. Recarregue a página.');
    });
})();
