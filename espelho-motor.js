// Responde às chamadas da API do ezBookkeeping (v2.1.0) a partir dos dados exportados do Mac.
// Reproduz, somente leitura, a lógica de pkg/api/transactions.go e pkg/services/transactions.go.
// Usado pelo service worker (sw.js) e pelos testes em Node.
(function (raiz) {
    'use strict';

    const DB = { AJUSTE: 1, RECEITA: 2, DESPESA: 3, TRANSF_SAIDA: 4, TRANSF_ENTRADA: 5 };
    const API_PARA_DB = { 1: 1, 2: 2, 3: 3, 4: 4 };
    const DB_PARA_API = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 4 };
    const FUSO_MAIS_LESTE = 840, FUSO_MAIS_OESTE = -720;
    // mensagens que a interface já traduz (locales: error.*)
    const SEM_PERMISSAO = 'not permitted to perform this action', API_INEXISTENTE = 'api not found';

    // ---------- fusos horários ----------
    const formatadores = new Map();
    function partes(unix, fuso) {
        if (fuso.nome === undefined) {
            const d = new Date((unix + fuso.offset * 60) * 1000);
            return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
        }
        let f = formatadores.get(fuso.nome);
        if (!f) {
            f = new Intl.DateTimeFormat('en-US', { timeZone: fuso.nome, hourCycle: 'h23', year: 'numeric', month: 'numeric',
                day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
            formatadores.set(fuso.nome, f);
        }
        const p = {};
        for (const x of f.formatToParts(new Date(unix * 1000))) p[x.type] = Number(x.value);
        return [p.year, p.month, p.day, p.hour, p.minute, p.second];
    }
    const dataHoraLocal = (unix, fuso) => { const [a, m, d, h, mi, s] = partes(unix, fuso); return ((((a * 100 + m) * 100 + d) * 100 + h) * 100 + mi) * 100 + s; };
    const anoMesDia = (unix, fuso) => { const [a, m, d] = partes(unix, fuso); return (a * 100 + m) * 100 + d; };
    const anoMes = (unix, fuso) => { const [a, m] = partes(unix, fuso); return a * 100 + m; };
    function offsetEm(unix, fuso) {
        if (fuso.nome === undefined) return fuso.offset;
        const [a, m, d, h, mi, s] = partes(unix, fuso);
        return Math.round((Date.UTC(a, m - 1, d, h, mi, s) / 1000 - unix) / 60);
    }
    const fusoDaTransacao = r => ({ offset: r.o });
    function fusoDoCliente(cabecalhos) {
        const nome = cabecalhos.get('X-Timezone-Name');
        if (nome) {
            try { new Intl.DateTimeFormat('en-US', { timeZone: nome }); return { nome }; } catch (e) { /* usa o offset */ }
        }
        const offset = parseInt(cabecalhos.get('X-Timezone-Offset'), 10);
        return { offset: isNaN(offset) ? 0 : offset };
    }
    const unixDe = tt => Math.floor(tt / 1000);
    const minTT = unix => unix * 1000;
    const maxTT = unix => unix * 1000 + 999;
    // utils.GetTransactionTimeRangeByYearMonth: o mês em qualquer fuso possível
    function faixaDoMes(ano, mes) {
        const inicio = Date.UTC(ano, mes - 1, 1) / 1000;
        const fim = Date.UTC(ano, mes, 1) / 1000;
        return [minTT(inicio - FUSO_MAIS_LESTE * 60), minTT(fim - FUSO_MAIS_OESTE * 60) - 1];
    }

    function criarMotor(dados) {
        const linhas = dados.transacoes;
        const tagsPorId = dados.tagsPorTransacao || {};
        const contas = [];
        for (const c of dados.contas) { contas.push(c); for (const s of c.subAccounts || []) contas.push(s); }
        const contaPorId = new Map(contas.map(c => [c.id, c]));
        const categorias = [];
        for (const lista of Object.values(dados.categorias)) for (const c of lista) { categorias.push(c); for (const s of c.subCategories || []) categorias.push(s); }
        const categoriaPorId = new Map(categorias.map(c => [c.id, c]));
        const tagPorId = new Map(dados.tags.map(t => [t.id, t]));
        const porIdLinha = new Map(linhas.map(r => [r.id, r]));
        const desc = (a, b) => b.tt - a.tt;

        // ---------- conversão para a resposta da API ----------
        function transferenciaRelacionada(r) {
            return { id: r.ri, t: r.t === DB.TRANSF_SAIDA ? DB.TRANSF_ENTRADA : DB.TRANSF_SAIDA, c: r.c,
                tt: r.t === DB.TRANSF_SAIDA ? r.tt + 1 : r.tt - 1, o: r.o, a: r.ra, v: r.rv, ri: r.id, ra: r.a, rv: r.v,
                h: false, cm: r.cm, lo: r.lo, la: r.la };
        }
        function paraInfo(r, q) {
            if (r.t === DB.TRANSF_ENTRADA) r = transferenciaRelacionada(r);
            const tagIds = tagsPorId[r.id] || [];
            const o = { id: r.id, timeSequenceId: String(r.tt), type: DB_PARA_API[r.t], categoryId: r.c, time: unixDe(r.tt),
                utcOffset: r.o, sourceAccountId: r.a, sourceAmount: r.v, hideAmount: r.h, tagIds: tagIds.slice(),
                comment: r.cm, editable: false };
            if (r.t === DB.TRANSF_SAIDA) { o.destinationAccountId = r.ra; o.destinationAmount = r.rv; }
            if (r.lo || r.la) o.geoLocation = { latitude: r.la, longitude: r.lo };
            if (q && q.get('trim_account') !== 'true') {
                if (contaPorId.has(r.a)) o.sourceAccount = contaPorId.get(r.a);
                if (contaPorId.has(r.ra)) o.destinationAccount = contaPorId.get(r.ra);
            }
            if (q && q.get('trim_category') !== 'true' && categoriaPorId.has(r.c)) o.category = categoriaPorId.get(r.c);
            if (q && q.get('trim_tag') !== 'true' && tagIds.length) o.tags = tagIds.map(i => tagPorId.get(i)).filter(Boolean);
            return o;
        }
        function ordenarInfos(itens) {
            return itens.sort((x, y) => x.time !== y.time ? y.time - x.time : (BigInt(y.id) > BigInt(x.id) ? 1 : BigInt(y.id) < BigInt(x.id) ? -1 : 0));
        }

        // ---------- filtros (buildTransactionQueryCondition + tags) ----------
        const lista = s => (s && s !== '0') ? s.split(',').filter(Boolean) : [];
        function expandirCategorias(s) {
            const out = new Set();
            for (const id of lista(s)) {
                const c = categoriaPorId.get(id);
                if (c && c.subCategories && c.subCategories.length) c.subCategories.forEach(x => out.add(x.id)); else out.add(id);
            }
            return out;
        }
        function expandirContas(s) {
            const out = new Set();
            for (const id of lista(s)) {
                const c = contaPorId.get(id);
                if (c && c.subAccounts && c.subAccounts.length) c.subAccounts.forEach(x => out.add(x.id)); else out.add(id);
            }
            return out;
        }
        function filtroDeTags(s) {
            if (!s) return { semTags: false, filtros: [] };
            if (s === 'none') return { semTags: true, filtros: [] };
            return { semTags: false, filtros: s.split(';').map(f => { const [tipo, ids] = f.split(':'); return { tipo: Number(tipo), ids: ids.split(',') }; }) };
        }
        function passaTags(r, tf) {
            const proprias = tagsPorId[r.id] || [], relacionadas = (r.ri && tagsPorId[r.ri]) || [];
            if (tf.semTags) return !proprias.length && !relacionadas.length;
            for (const f of tf.filtros) {
                const tem = l => f.tipo === 1 || f.tipo === 3 ? f.ids.every(i => l.includes(i)) : f.ids.some(i => l.includes(i));
                const casa = tem(proprias) || tem(relacionadas);
                if ((f.tipo <= 1 && !casa) || (f.tipo >= 2 && casa)) return false;
            }
            return true;
        }
        function passaValor(v, filtro) {
            if (!filtro) return true;
            const p = filtro.split(':'), a = Number(p[1]), b = Number(p[2]);
            switch (p[0]) {
                case 'gt': return v > a; case 'lt': return v < a; case 'eq': return v === a; case 'ne': return v !== a;
                case 'bt': return v >= a && v <= b; case 'nb': return v < a || v > b; default: return true;
            }
        }
        const passaPalavra = (cm, palavra) => !palavra || cm.toLowerCase().includes(palavra.toLowerCase());
        function consultar(q, maxT, minT) {
            const tipoDb = API_PARA_DB[Number(q.get('type')) || 0] || 0;
            const cats = expandirCategorias(q.get('category_ids'));
            const ctas = expandirContas(q.get('account_ids'));
            const tf = filtroDeTags(q.get('tag_filter'));
            const valor = q.get('amount_filter'), palavra = q.get('keyword');
            return linhas.filter(r => {
                if (maxT > 0 && r.tt > maxT) return false;
                if (minT > 0 && r.tt < minT) return false;
                if (tipoDb >= DB.AJUSTE && tipoDb <= DB.DESPESA) { if (r.t !== tipoDb) return false; }
                else if (tipoDb === DB.TRANSF_SAIDA) {
                    if (ctas.size === 0) { if (r.t !== DB.TRANSF_SAIDA) return false; }
                    else if (ctas.size === 1) { if (r.t !== DB.TRANSF_SAIDA && r.t !== DB.TRANSF_ENTRADA) return false; }
                    else if (!(r.t === DB.TRANSF_SAIDA || (r.t === DB.TRANSF_ENTRADA && !ctas.has(r.ra)))) return false;
                } else if (ctas.size === 0) { if (r.t === DB.TRANSF_ENTRADA) return false; }
                else if (ctas.size > 1 && r.t === DB.TRANSF_ENTRADA && ctas.has(r.ra)) return false;
                if (cats.size && !cats.has(r.c)) return false;
                if (ctas.size && !ctas.has(r.a)) return false;
                if (!passaValor(r.v, valor) || !passaPalavra(r.cm, palavra)) return false;
                return passaTags(r, tf);
            }).sort(desc);
        }

        // ---------- listas de lançamentos ----------
        function listar(q) {
            const conta = Math.max(1, Number(q.get('count')) || 1), pagina = Math.max(1, Number(q.get('page')) || 1);
            const todas = consultar(q, Number(q.get('max_time')) || 0, Number(q.get('min_time')) || 0);
            let fatia = todas.slice((pagina - 1) * conta, (pagina - 1) * conta + conta + 1);
            let proximo = null;
            if (fatia.length > conta) { proximo = String(fatia[conta].tt); fatia = fatia.slice(0, conta); }
            const res = { items: ordenarInfos(fatia.map(r => paraInfo(r, q))), nextTimeSequenceId: proximo };
            if (q.get('with_count') === 'true') res.totalCount = todas.length;
            return res;
        }
        function listarMes(q) {
            const ano = Number(q.get('year')), mes = Number(q.get('month'));
            const [minT, maxT] = faixaDoMes(ano, mes);
            const doMes = consultar(q, maxT, minT).filter(r => anoMes(unixDe(r.tt), fusoDaTransacao(r)) === ano * 100 + mes);
            return { items: ordenarInfos(doMes.map(r => paraInfo(r, q))), totalCount: doMes.length };
        }
        function listarTudo(q) {
            const fim = Number(q.get('end_time')) || 0, ini = Number(q.get('start_time')) || 0;
            return ordenarInfos(consultar(q, fim > 0 ? maxTT(fim) : Number.MAX_SAFE_INTEGER, ini > 0 ? minTT(ini) : 0).map(r => paraInfo(r, q)));
        }
        function obter(q) {
            const r = porIdLinha.get(q.get('id'));
            if (!r) throw erroApi(200001, 'transaction not found');
            return paraInfo(r, q);
        }

        // ---------- totais e estatísticas ----------
        function noIntervalo(r, fusoCli, usarFusoTx, iniLocal, fimLocal) {
            const local = dataHoraLocal(unixDe(r.tt), usarFusoTx ? fusoDaTransacao(r) : fusoCli);
            return !((iniLocal > 0 && local < iniLocal) || (fimLocal > 0 && local > fimLocal));
        }
        function receitasDespesasNoPeriodo(ini, fim, q, fusoCli) {
            const excluiContas = new Set(lista(q.get('exclude_account_ids'))), excluiCats = new Set(lista(q.get('exclude_category_ids')));
            const tf = filtroDeTags(q.get('tag_filter'));
            const usarFusoTx = q.get('use_transaction_timezone') === 'true';
            const iniLocal = dataHoraLocal(ini, fusoCli), fimLocal = dataHoraLocal(fim, fusoCli);
            const minT = minTT(ini + offsetEm(ini, fusoCli) * 60 - FUSO_MAIS_LESTE * 60);
            const maxT = maxTT(fim + offsetEm(fim, fusoCli) * 60 - FUSO_MAIS_OESTE * 60);
            return linhas.filter(r => (r.t === DB.RECEITA || r.t === DB.DESPESA) && r.tt >= minT && r.tt <= maxT
                && !excluiContas.has(r.a) && !excluiCats.has(r.c) && passaTags(r, tf)
                && noIntervalo(r, fusoCli, usarFusoTx, iniLocal, fimLocal));
        }
        function somarPorMoeda(rs) {
            const porMoeda = new Map();
            for (const r of rs) {
                const conta = contaPorId.get(r.a);
                if (!conta) continue;
                const t = porMoeda.get(conta.currency) || { currency: conta.currency, inc: 0n, exp: 0n };
                if (r.t === DB.RECEITA) t.inc += BigInt(r.v); else t.exp += BigInt(r.v);
                porMoeda.set(conta.currency, t);
            }
            return [...porMoeda.values()].sort((a, b) => a.currency < b.currency ? -1 : 1)
                .map(t => ({ currency: t.currency, incomeAmount: t.inc.toString(), expenseAmount: t.exp.toString() }));
        }
        function totais(q, fusoCli) {
            const res = {};
            for (const item of (q.get('query') || '').split('|')) {
                const [nome, ini, fim] = item.split('_');
                const rs = receitasDespesasNoPeriodo(Number(ini), Number(fim), q, fusoCli);
                res[nome] = { startTime: Number(ini), endTime: Number(fim), amounts: somarPorMoeda(rs) };
            }
            return res;
        }
        function totaisDiarios(q, fusoCli) {
            const usarFusoTx = q.get('use_transaction_timezone') === 'true';
            const porDia = new Map();
            for (const r of receitasDespesasNoPeriodo(Number(q.get('start_time')), Number(q.get('end_time')), q, fusoCli)) {
                const dia = anoMesDia(unixDe(r.tt), usarFusoTx ? fusoDaTransacao(r) : fusoCli);
                if (!porDia.has(dia)) porDia.set(dia, []);
                porDia.get(dia).push(r);
            }
            return [...porDia.keys()].sort((a, b) => a - b).map(d => ({
                date: `${Math.floor(d / 10000)}-${String(Math.floor(d / 100) % 100).padStart(2, '0')}-${String(d % 100).padStart(2, '0')}`,
                amounts: somarPorMoeda(porDia.get(d))
            }));
        }
        const ehFluxo = r => r.t >= DB.RECEITA && r.t <= DB.TRANSF_ENTRADA;
        function agrupar(rs, chaveExtra) {
            const grupos = new Map();
            for (const r of rs) {
                const transf = r.t === DB.TRANSF_SAIDA || r.t === DB.TRANSF_ENTRADA;
                const chave = `${chaveExtra(r)}_${r.c}_${r.a}` + (transf ? `_${r.ra}_${r.t}` : '');
                const g = grupos.get(chave) || { extra: chaveExtra(r), r, total: 0n };
                g.total += BigInt(r.v);
                grupos.set(chave, g);
            }
            return [...grupos.values()];
        }
        function itemEstatistica(g) {
            const item = { categoryId: g.r.c, accountId: g.r.a, amount: g.total.toString() };
            if (g.r.t === DB.TRANSF_SAIDA) { item.relatedAccountId = g.r.ra; item.relatedAccountType = 2; }
            if (g.r.t === DB.TRANSF_ENTRADA) { item.relatedAccountId = g.r.ra; item.relatedAccountType = 1; }
            return item;
        }
        function filtroEstatistica(q) {
            const tf = filtroDeTags(q.get('tag_filter')), palavra = q.get('keyword');
            return r => ehFluxo(r) && passaPalavra(r.cm, palavra) && passaTags(r, tf);
        }
        function estatisticas(q, fusoCli) {
            const ini = Number(q.get('start_time')) || 0, fim = Number(q.get('end_time')) || 0;
            const usarFusoTx = q.get('use_transaction_timezone') === 'true';
            const iniLocal = ini > 0 ? dataHoraLocal(ini, fusoCli) : 0, fimLocal = fim > 0 ? dataHoraLocal(fim, fusoCli) : 0;
            const minT = ini > 0 ? minTT(ini + offsetEm(ini, fusoCli) * 60 - FUSO_MAIS_LESTE * 60) : 0;
            const maxT = fim > 0 ? maxTT(fim + offsetEm(fim, fusoCli) * 60 - FUSO_MAIS_OESTE * 60) : 0;
            const passa = filtroEstatistica(q);
            const rs = linhas.filter(r => passa(r) && (!minT || r.tt >= minT) && (!maxT || r.tt <= maxT)
                && noIntervalo(r, fusoCli, usarFusoTx, iniLocal, fimLocal));
            return { startTime: ini, endTime: fim, items: agrupar(rs, () => '').map(itemEstatistica) };
        }
        function tendencias(q, fusoCli) {
            const am = s => { if (!s) return 0; const [a, m] = s.split('-').map(Number); return a * 100 + m; };
            const ini = am(q.get('start_year_month')), fim = am(q.get('end_year_month'));
            const minT = ini ? faixaDoMes(Math.floor(ini / 100), ini % 100)[0] : 0;
            const maxT = fim ? faixaDoMes(Math.floor(fim / 100), fim % 100)[1] : 0;
            const usarFusoTx = q.get('use_transaction_timezone') === 'true';
            const passa = filtroEstatistica(q);
            const mesDe = r => anoMes(unixDe(r.tt), usarFusoTx ? fusoDaTransacao(r) : fusoCli);
            const rs = linhas.filter(r => passa(r) && (!minT || r.tt >= minT) && (!maxT || r.tt <= maxT)
                && !((ini && mesDe(r) < ini) || (fim && mesDe(r) > fim)));
            const porMes = new Map();
            for (const g of agrupar(rs, mesDe)) {
                if (!porMes.has(g.extra)) porMes.set(g.extra, []);
                porMes.get(g.extra).push(itemEstatistica(g));
            }
            return [...porMes.keys()].sort((a, b) => a - b).map(m => ({ year: Math.floor(m / 100), month: m % 100, items: porMes.get(m) }));
        }
        function variacao(r) {
            switch (r.t) {
                case DB.AJUSTE: return BigInt(r.rv);
                case DB.RECEITA: case DB.TRANSF_ENTRADA: return BigInt(r.v);
                default: return -BigInt(r.v);
            }
        }
        function tendenciaDeAtivos(q, fusoCli) {
            const fim = Number(q.get('end_time')) || 0, ini = Number(q.get('start_time')) || 0;
            const maxT = fim > 0 ? maxTT(fim) : maxTT(Math.floor(Date.now() / 1000)), minT = ini > 0 ? minTT(ini) : 0;
            const rs = linhas.filter(r => r.tt <= maxT).sort(desc);
            if (!rs.length) return [];
            const acumulado = new Map(), antesDoInicio = new Map(), porDia = new Map();
            for (let i = rs.length - 1; i >= 0; i--) {
                const r = rs[i];
                const anterior = acumulado.get(r.a) || 0n, atual = anterior + variacao(r);
                acumulado.set(r.a, atual);
                if (r.tt < minT) { antesDoInicio.set(r.a, atual); continue; }
                const chave = `${anoMesDia(unixDe(r.tt), fusoCli)}_${r.a}`;
                if (porDia.has(chave)) porDia.get(chave).fecha = atual;
                else porDia.set(chave, { conta: r.a, abre: anterior, fecha: atual });
            }
            const primeiroDia = anoMesDia(unixDe(Math.max(rs[rs.length - 1].tt, minT)), fusoCli);
            for (const [conta, saldo] of antesDoInicio) {
                const chave = `${primeiroDia}_${conta}`;
                if (saldo !== 0n && !porDia.has(chave)) porDia.set(chave, { conta, abre: saldo, fecha: saldo });
            }
            const dias = new Map();
            for (const [chave, v] of porDia) {
                const dia = Number(chave.split('_')[0]);
                if (!dias.has(dia)) dias.set(dia, []);
                dias.get(dia).push({ accountId: v.conta, accountOpeningBalance: v.abre.toString(), accountClosingBalance: v.fecha.toString() });
            }
            return [...dias.keys()].sort((a, b) => a - b).map(d => ({ year: Math.floor(d / 10000), month: Math.floor(d / 100) % 100, day: d % 100, items: dias.get(d) }));
        }
        function extratoDaConta(q) {
            const contaId = q.get('account_id'), conta = contaPorId.get(contaId);
            if (!conta) throw erroApi(200101, 'account not found');
            const fim = Number(q.get('end_time')) || 0, ini = Number(q.get('start_time')) || 0;
            const maxT = fim > 0 ? maxTT(fim) : maxTT(Math.floor(Date.now() / 1000)), minT = ini > 0 ? minTT(ini) : 0;
            const rs = linhas.filter(r => r.a === contaId && r.tt <= maxT).sort(desc);
            let entradas = 0n, saidas = 0n, abertura = 0n, acumulado = 0n, ultimo = 0n;
            const saldos = new Map(), escolhidas = [];
            for (let i = rs.length - 1; i >= 0; i--) {
                const r = rs[i];
                acumulado += variacao(r);
                if (r.tt < minT) { abertura = acumulado; ultimo = acumulado; continue; }
                if (r.t === DB.AJUSTE) { if (conta.isAsset) entradas += BigInt(r.rv); else if (conta.isLiability) saidas -= BigInt(r.rv); }
                else if (r.t === DB.RECEITA || r.t === DB.TRANSF_ENTRADA) entradas += BigInt(r.v);
                else saidas += BigInt(r.v);
                const s = { abre: ultimo.toString(), fecha: acumulado.toString() };
                saldos.set(r.id, s); if (r.ri) saldos.set(r.ri, s);
                ultimo = acumulado;
                escolhidas.push(r);
            }
            const q2 = new URLSearchParams('trim_account=true&trim_category=true&trim_tag=true');
            const itens = ordenarInfos(escolhidas.map(r => paraInfo(r, q2))).map(info => {
                const s = saldos.get(info.id) || { abre: '0', fecha: '0' };
                info.tagIds = [];
                return Object.assign(info, { accountOpeningBalance: s.abre, accountClosingBalance: s.fecha });
            });
            return { transactions: itens, totalInflows: entradas.toString(), totalOutflows: saidas.toString(),
                openingBalance: abertura.toString(), closingBalance: acumulado.toString() };
        }

        // ---------- dados fixos ----------
        const acharEm = (l, id, filhos) => { for (const x of l) { if (x.id === id) return x; for (const f of x[filhos] || []) if (f.id === id) return f; } return null; };
        function obrigatorio(x, codigo) { if (!x) throw erroApi(codigo, 'not found'); return x; }
        const nuvem = Array.isArray(dados.configuracoesNuvem) && dados.configuracoesNuvem.length ? dados.configuracoesNuvem : undefined;
        const respostaLogin = () => ({ token: 'somente-leitura', need2FA: false, user: dados.perfil, applicationCloudSettings: nuvem });
        const rotas = {
            'GET v1/users/profile/get.json': () => dados.perfil,
            'GET v1/users/settings/cloud/get.json': () => dados.configuracoesNuvem,
            'GET v1/users/2fa/status.json': () => ({ enable: false }),
            'GET v1/users/external_auth/list.json': () => [],
            'GET v1/tokens/list.json': () => [],
            'GET v1/systems/version.json': () => dados.versao,
            'GET v1/data/statistics.json': () => dados.estatisticasDeDados,
            'GET v1/custom_icons/list.json': () => dados.iconesPersonalizados || [],
            'GET v1/insights/explorers/list.json': () => dados.exploradores || [],
            'GET v1/insights/explorers/get.json': q => obrigatorio((dados.exploradores || []).find(e => e.id === q.get('id')), 200001),
            'GET v1/exchange_rates/latest.json': () => dados.cambio,
            'GET v1/accounts/list.json': q => q.get('visible_only') === 'true' ? dados.contas.filter(c => !c.hidden) : dados.contas,
            'GET v1/accounts/get.json': q => obrigatorio(acharEm(dados.contas, q.get('id'), 'subAccounts'), 200101),
            'GET v1/transaction/categories/list.json': () => dados.categorias,
            'GET v1/transaction/categories/get.json': q => obrigatorio(categoriaPorId.get(q.get('id')), 200201),
            'GET v1/transaction/tags/list.json': () => dados.tags,
            'GET v1/transaction/tags/get.json': q => obrigatorio(tagPorId.get(q.get('id')), 200301),
            'GET v1/transaction/tags/groups/list.json': () => dados.gruposDeTags,
            'GET v1/transaction/tags/groups/get.json': q => obrigatorio(dados.gruposDeTags.find(g => g.id === q.get('id')), 200301),
            'GET v1/transaction/templates/list.json': q => dados.modelos[q.get('templateType') || '1'] || [],
            'GET v1/transaction/templates/get.json': q => obrigatorio(Object.values(dados.modelos).flat().find(m => m.id === q.get('id')), 200401),
            'GET v1/transactions/list.json': listar,
            'GET v1/transactions/list/by_month.json': listarMes,
            'GET v1/transactions/list/all.json': listarTudo,
            'GET v1/transactions/get.json': obter,
            'GET v1/transactions/statistics.json': estatisticas,
            'GET v1/transactions/statistics/trends.json': tendencias,
            'GET v1/transactions/statistics/asset_trends.json': tendenciaDeAtivos,
            'GET v1/transactions/amounts.json': totais,
            'GET v1/transactions/amounts/daily.json': totaisDiarios,
            'GET v1/transactions/reconciliation_statements.json': extratoDaConta,
            'GET v1/transactions/unreconciled_transaction_counts.json': () => ({ items: [] }),
            'GET logout.json': () => true,
            'POST authorize.json': respostaLogin,
            'POST v1/tokens/refresh.json': () => ({ user: dados.perfil, applicationCloudSettings: nuvem }),
        };

        function responder(metodo, caminho, q, cabecalhos) {
            const rota = rotas[`${metodo} ${caminho}`];
            if (!rota) {
                const leitura = metodo === 'GET';
                return { status: leitura ? 404 : 400, corpo: { success: false, errorCode: leitura ? 100001 : 201031,
                    errorMessage: leitura ? API_INEXISTENTE : SEM_PERMISSAO, path: '/api/' + caminho } };
            }
            try {
                return { status: 200, corpo: { success: true, result: rota(q, fusoDoCliente(cabecalhos)) } };
            } catch (e) {
                return { status: 400, corpo: { success: false, errorCode: e.codigo || 100000, errorMessage: e.message, path: '/api/' + caminho } };
            }
        }
        return { responder };
    }
    function erroApi(codigo, mensagem) { const e = new Error(mensagem); e.codigo = codigo; return e; }

    const exportado = { criarMotor };
    if (typeof module !== 'undefined' && module.exports) module.exports = exportado; else raiz.EspelhoMotor = exportado;
})(typeof self !== 'undefined' ? self : this);
