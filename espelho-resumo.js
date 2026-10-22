// Resumo do mês: entradas e saídas segmentadas (duas roscas) e saldos de contas e aplicações.
// Lê a mesma API do ezBookkeeping (no espelho, respondida pelo service worker).
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const $ = id => document.getElementById(id);
const SLOTS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];
const OUTROS = 'Outros';
const APLICACOES = [7, 8, 9];          // investimento, poupança, CDB (pkg/models/account.go)
const GRUPOS_DE_CONTA = [
    ['Conta corrente', c => c.category === 2],
    ['Aplicações financeiras', c => APLICACOES.includes(c.category)],
    ['Dinheiro', c => c.category === 1],
    ['Cartões de crédito', c => c.category === 3],
    ['Outras contas', () => true],
];
const ehCelular = /Android|iPhone|iPod|Mobile|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

const estado = { mes: null, modo: lerModo() };
let dados;

function lerModo() { try { return localStorage.getItem('espelho_resumo_modo') || 'categoria'; } catch (e) { return 'categoria'; } }
function salvarModo(m) { try { localStorage.setItem('espelho_resumo_modo', m); } catch (e) { /* opcional */ } }

async function api(caminho) {
    const r = await fetch('api/v1/' + caminho, { headers: {
        Authorization: 'Bearer ' + (localStorage.getItem('ebk_user_token') || ''),
        'X-Timezone-Name': Intl.DateTimeFormat().resolvedOptions().timeZone,
        'X-Timezone-Offset': String(-new Date().getTimezoneOffset()),
    } });
    const j = await r.json();
    if (!j.success) throw new Error(j.errorMessage || 'erro');
    return j.result;
}

const reais = centavos => BRL.format(Number(centavos) / 100);
const mesDe = t => { const d = new Date((t.time + t.utcOffset * 60) * 1000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
function nomeDoMes(ym) {
    const [a, m] = ym.split('-').map(Number);
    const s = new Date(a, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    return s[0].toUpperCase() + s.slice(1);
}
function el(tag, attrs = {}, ...filhos) {
    const e = document.createElementNS(['svg', 'path', 'circle', 'text', 'title'].includes(tag) ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    for (const f of filhos) e.append(f instanceof Node ? f : document.createTextNode(f));
    return e;
}

// ---------- segmentação ----------
function chaves(t, nivel) {
    if (nivel === 'pessoa') {
        const nomes = (t.tagIds || []).map(id => dados.tags.get(id)).filter(x => x && x.grupo === 'Quem').map(x => x.nome);
        return nomes.length ? nomes : ['Sem pessoa'];
    }
    const sub = dados.categorias.get(t.categoryId);
    if (!sub) return ['Sem categoria'];
    if (nivel === 'subcategoria') return [sub.nome];
    const pai = dados.categorias.get(sub.pai);
    return [pai ? pai.nome : sub.nome];
}
function somar(lista, nivel) {
    const m = new Map();
    for (const t of lista) for (const k of chaves(t, nivel)) m.set(k, (m.get(k) || 0) + t.sourceAmount);
    return m;
}
// cor estável: as 5 maiores do histórico inteiro ganham cor fixa; o resto vira "Outros"
function coresEstaveis(tipo, nivel) {
    const total = somar(dados.transacoes.filter(t => t.type === tipo), nivel);
    const ordem = [...total.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    return new Map(ordem.slice(0, SLOTS.length).map((k, i) => [k, SLOTS[i]]));
}

// ---------- rosca ----------
const dica = $('dica');
function mostrarDica(alvo, valor, rotulo, x, y) {
    dica.replaceChildren(el('b', {}, valor), el('span', {}, rotulo));
    dica.hidden = false;
    const r = alvo.getBoundingClientRect();
    const px = x ?? r.left + r.width / 2, py = y ?? r.top;
    dica.style.left = Math.max(8, Math.min(px - dica.offsetWidth / 2, innerWidth - dica.offsetWidth - 8)) + 'px';
    dica.style.top = (py - dica.offsetHeight - 12 < 8 ? py + 18 : py - dica.offsetHeight - 12) + 'px';
}
function comDica(alvo, valor, rotulo) {
    alvo.setAttribute('tabindex', '0');
    alvo.setAttribute('aria-label', `${rotulo}: ${valor}`);
    alvo.addEventListener('pointermove', e => mostrarDica(alvo, valor, rotulo, e.clientX, e.clientY));
    alvo.addEventListener('focus', () => mostrarDica(alvo, valor, rotulo));
    for (const ev of ['pointerleave', 'blur']) alvo.addEventListener(ev, () => { dica.hidden = true; });
}
function arco(cx, cy, r0, r1, a0, a1) {
    const p = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    const g = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = p(r1, a0), [x1, y1] = p(r1, a1), [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0);
    return `M${x0} ${y0}A${r1} ${r1} 0 ${g} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${g} 0 ${x3} ${y3}Z`;
}
function rosca(alvo, fatias, total, rotuloTotal) {
    alvo.replaceChildren();
    if (!total) { alvo.append(el('div', { class: 'vazio' }, 'Nenhum lançamento neste mês.')); return; }
    const svg = el('svg', { class: 'rosca', viewBox: '0 0 190 190', role: 'img', 'aria-label': `${rotuloTotal}: ${reais(total)}` });
    let a = 0;
    for (const f of fatias) {
        const pct = f.valor / total, rotulo = `${f.nome} · ${(pct * 100).toFixed(1).replace('.', ',')}%`;
        const forma = pct >= 0.9999
            ? el('circle', { class: 'fatia', cx: 95, cy: 95, r: 70, fill: 'none', style: `stroke:${f.cor};stroke-width:38` })
            : el('path', { class: 'fatia', d: arco(95, 95, 51, 89, a, a + pct * 2 * Math.PI), style: `fill:${f.cor}` });
        comDica(forma, reais(f.valor), rotulo);
        svg.append(forma);
        a += pct * 2 * Math.PI;
    }
    svg.append(el('text', { x: 95, y: 90, 'font-size': 12, style: 'fill:var(--texto-2)' }, rotuloTotal),
               el('text', { x: 95, y: 110, 'font-size': 15, 'font-weight': 600 }, reais(total).replace(/,\d\d$/, '')));
    const legenda = el('ul', { class: 'legenda' });
    for (const f of fatias) {
        legenda.append(el('li', {}, Object.assign(el('span', { class: 'cor' }), { style: `background:${f.cor}` }),
            el('span', {}, f.nome), el('span', { class: 'v' }, reais(f.valor)),
            el('span', { class: 'p' }, Math.round(f.valor / total * 100) + '%')));
    }
    alvo.append(el('div', { class: 'grafico' }, svg, legenda));
}
function detalhamento(alvo, mapa, total) {
    const linhas = [...mapa.entries()].sort((a, b) => b[1] - a[1]);
    const corpo = el('tbody');
    for (const [k, v] of linhas) corpo.append(el('tr', {}, el('td', {}, k), el('td', { class: 'num' }, reais(v)), el('td', { class: 'num' }, Math.round(v / total * 100) + '%')));
    alvo.append(el('details', {}, el('summary', {}, `Ver detalhamento (${linhas.length} itens)`),
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Item'), el('th', { class: 'num' }, 'Valor'), el('th', { class: 'num' }, '%'))), corpo)));
}
function grafico(tipo, sufixo, rotuloTotal) {
    const doMes = dados.transacoes.filter(t => t.type === tipo && mesDe(t) === estado.mes);
    let nivel = estado.modo, nota = '';
    if (nivel === 'categoria' && somar(doMes, 'categoria').size === 1) { nivel = 'subcategoria'; nota = `Tudo em "${[...somar(doMes, 'categoria').keys()][0]}" — mostrando por subcategoria.`; }
    const mapa = somar(doMes, nivel), total = doMes.reduce((s, t) => s + t.sourceAmount, 0);
    const cores = coresEstaveis(tipo, nivel);
    const fatias = [];
    let outros = 0;
    for (const [nome, valor] of [...mapa.entries()].sort((a, b) => b[1] - a[1])) {
        if (cores.has(nome)) fatias.push({ nome, valor, cor: cores.get(nome) }); else outros += valor;
    }
    if (outros) fatias.push({ nome: OUTROS, valor: outros, cor: 'var(--outros)' });
    const titulo = { categoria: 'por categoria', subcategoria: 'por subcategoria', pessoa: 'por pessoa' }[nivel];
    $('t-' + sufixo).textContent = `${tipo === 2 ? 'Entradas' : 'Saídas'} ${titulo}`;
    $('n-' + sufixo).textContent = nota;
    rosca($('g-' + sufixo), fatias, total, rotuloTotal);
    if (total) detalhamento($('g-' + sufixo), mapa, total);
    return { total, qtd: doMes.length };
}

// ---------- contas ----------
function renderContas() {
    const corpo = $('t-contas'); corpo.replaceChildren();
    const usadas = new Set();
    let cc = 0, apl = 0, ativos = 0, passivos = 0, nApl = 0;
    for (const [nome, regra] of GRUPOS_DE_CONTA) {
        const contas = dados.contas.filter(c => !usadas.has(c.id) && regra(c));
        if (!contas.length) continue;
        contas.forEach(c => usadas.add(c.id));
        const soma = contas.reduce((s, c) => s + Number(c.balance), 0);
        corpo.append(el('tr', { class: 'grupo' }, el('td', {}, nome), el('td', { class: 'num' }, reais(soma))));
        for (const c of contas) corpo.append(el('tr', {}, el('td', {}, c.name), el('td', { class: 'num' }, reais(c.balance))));
        if (nome === 'Conta corrente') cc = soma;
        if (nome === 'Aplicações financeiras') { apl = soma; nApl = contas.length; }
    }
    for (const c of dados.contas) { if (c.isAsset) ativos += Number(c.balance); if (c.isLiability) passivos += Number(c.balance); }
    $('k-cc').textContent = reais(cc);
    $('k-cc-det').textContent = `${dados.contas.filter(c => c.category === 2).length} conta(s)`;
    $('k-apl').textContent = reais(apl);
    $('k-apl-det').textContent = nApl ? `${nApl} aplicação(ões)` : 'Nenhuma cadastrada';
    $('k-pl').textContent = reais(ativos + passivos);
    $('aviso-apl').hidden = nApl > 0;
}

// ---------- página ----------
function render() {
    dica.hidden = true;
    $('mes-nome').textContent = nomeDoMes(estado.mes);
    const i = dados.meses.indexOf(estado.mes);
    $('mes-ant').disabled = i <= 0;
    $('mes-prox').disabled = i >= dados.meses.length - 1;
    for (const b of document.querySelectorAll('.modo button')) b.setAttribute('aria-pressed', String(b.dataset.modo === estado.modo));
    const ent = grafico(2, 'ent', 'Entradas'), sai = grafico(3, 'sai', 'Saídas');
    $('k-ent').textContent = reais(ent.total);
    $('k-ent-det').textContent = `${ent.qtd} lançamento(s)`;
    $('k-sai').textContent = reais(sai.total);
    $('k-sai-det').textContent = `${sai.qtd} lançamento(s)`;
    const saldo = ent.total - sai.total;
    $('k-saldo').textContent = (saldo > 0 ? '+' : '') + reais(saldo);
    $('k-saldo').className = 'val ' + (saldo >= 0 ? 'positivo' : 'negativo');
}

async function iniciar() {
    $('abrir-app').href = (ehCelular ? 'mobile' : 'desktop') + '.html#/';
    const [transacoes, cats, tags, grupos, contas] = await Promise.all([
        api('transactions/list/all.json?trim_account=true&with_pictures=false&trim_category=true&trim_tag=true'),
        api('transaction/categories/list.json'), api('transaction/tags/list.json'),
        api('transaction/tags/groups/list.json'), api('accounts/list.json?visible_only=true'),
    ]);
    const categorias = new Map();
    for (const lista of Object.values(cats)) for (const c of lista) {
        categorias.set(c.id, { nome: c.name, pai: null });
        for (const s of c.subCategories || []) categorias.set(s.id, { nome: s.name, pai: c.id });
    }
    const nomeGrupo = new Map(grupos.map(g => [g.id, g.name]));
    const hoje = new Date(), atual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
    const fluxo = transacoes.filter(t => t.type === 2 || t.type === 3);
    const meses = [...new Set([...fluxo.map(mesDe), atual])].sort();
    dados = { transacoes: fluxo, categorias, contas, meses,
        tags: new Map(tags.map(t => [t.id, { nome: t.name, grupo: nomeGrupo.get(t.groupId) }])) };
    estado.mes = meses.includes(atual) ? atual : meses[meses.length - 1];

    $('mes-ant').onclick = () => { estado.mes = meses[meses.indexOf(estado.mes) - 1]; render(); };
    $('mes-prox').onclick = () => { estado.mes = meses[meses.indexOf(estado.mes) + 1]; render(); };
    for (const b of document.querySelectorAll('.modo button')) b.onclick = () => { estado.modo = b.dataset.modo; salvarModo(estado.modo); render(); };
    renderContas();
    render();
}

iniciar().catch(e => { $('mes-nome').textContent = 'Erro ao carregar'; console.error(e); });
