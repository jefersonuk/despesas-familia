// Service worker do espelho: atende as chamadas /api/ da interface do ezBookkeeping
// com os dados exportados do Mac (espelho-dados.json), sem servidor.
importScripts('espelho-motor.js?v=89ef94aba4');

const RECARREGAR_APOS_MS = 60 * 1000;
let motor = null, carregadoEm = 0, carregando = null;

function obterMotor(forcar) {
    if (motor && !forcar && Date.now() - carregadoEm < RECARREGAR_APOS_MS) return Promise.resolve(motor);
    if (!carregando) {
        carregando = fetch('espelho-dados.json', { cache: 'no-store' })
            .then(r => { if (!r.ok) throw new Error('dados indisponíveis (' + r.status + ')'); return r.json(); })
            .then(dados => { motor = self.EspelhoMotor.criarMotor(dados); carregadoEm = Date.now(); return motor; })
            .finally(() => { carregando = null; });
    }
    return motor && !forcar ? Promise.resolve(motor) : carregando;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('message', e => { if (e.data === 'assumir') self.clients.claim(); });

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    const prefixo = new URL('api/', self.registration.scope).pathname;
    if (url.origin !== self.location.origin || !url.pathname.startsWith(prefixo)) return;
    e.respondWith(responder(e.request, url, url.pathname.slice(prefixo.length)));
});

async function responder(req, url, caminho) {
    const json = (status, corpo) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
    try {
        const m = await obterMotor(caminho === 'v1/tokens/refresh.json');
        const r = m.responder(req.method, caminho, url.searchParams, req.headers);
        return json(r.status, r.corpo);
    } catch (erro) {
        return json(500, { success: false, errorCode: 100000, errorMessage: String(erro && erro.message || erro) });
    }
}
