const _dominiosPermitidos = [
  'microcorpset.github.io',
  'localhost',
  '127.0.0.1'
];

if (!_dominiosPermitidos.some(d => location.hostname === d || location.hostname.endsWith('.' + d))) {
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;color:#888">Acceso no autorizado</div>';
  throw new Error('Dominio no autorizado');
}

import { authReady, db } from './firebase.js';
import {
  ref, set, push, onValue, get, remove, query, limitToLast, orderByChild, startAt, endAt
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

await authReady;

const GERENTE_PWD_DEFAULT = 'gerente1234';
const GERENTE_PWD_PATH = 'config/gerente/password';
const PRINT_SERVICE_ID = 'local-print-service-1';
const GERENTE_COMPACT_KEY = 'gerente_compact_state_v1';

const SALES_PAGE_SIZE = 25;
const AUDIT_PAGE_SIZE = 40;

let configLocal = {};
let historialVentasCache = [];
let historialVentasCargado = false;
let ventasFiltradas = [];
let ventasTabActiva = 'tickets';
let ventasPagina = 1;

let turnoActualCache = {};
let auditUsuarios = {};
let unsubscribeTurnSales = null;
let auditEventos = [];
let auditPagina = 1;
let auditUnlocked = true;
const GERENTE_SECTION_KEY = 'gerente_section_state_v1';

function confirmDialog({ title, body, confirmLabel = 'Aceptar', cancelLabel = 'Cancelar', danger = false }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:450;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(4,10,18,.62);backdrop-filter:blur(5px)';
    const card = document.createElement('div');
    card.style.cssText = 'width:min(520px,100%);background:var(--panel,#111823);border:1px solid var(--border,#233042);border-radius:22px;box-shadow:0 20px 60px rgba(0,0,0,.35);padding:18px;display:flex;flex-direction:column;gap:14px';
    card.innerHTML = `
      <div style="font-family:var(--mono);font-size:18px;color:var(--text)">${escHtml(title)}</div>
      <div style="font-size:14px;line-height:1.5;color:var(--muted)">${body}</div>
      <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap">
        <button type="button" data-act="cancel" class="small">${cancelLabel}</button>
        <button type="button" data-act="ok" class="small ${danger ? 'danger' : 'success'}">${confirmLabel}</button>
      </div>`;
    overlay.appendChild(card);
    const close = result => {
      overlay.remove();
      resolve(result);
    };
    overlay.addEventListener('click', e => {
      if (e.target === overlay) close(false);
    });
    card.querySelector('[data-act="cancel"]').onclick = () => close(false);
    card.querySelector('[data-act="ok"]').onclick = () => close(true);
    document.body.appendChild(overlay);
  });
}

const AUDIT_LABELS = {
  articulo_agregado: { label: 'Articulo añadido', color: 'var(--info)', sensible: false },
  articulo_eliminado: { label: 'Articulo eliminado', color: 'var(--danger)', sensible: true },
  cantidad_editada: { label: 'Cantidad editada', color: '#ffbf66', sensible: true },
  descuento_aplicado: { label: 'Descuento aplicado', color: '#ffbf66', sensible: true },
  ticket_impreso: { label: 'Ticket impreso', color: 'var(--info)', sensible: false },
  ticket_cobrado: { label: 'Mesa cobrada', color: 'var(--success)', sensible: false },
  factura_emitida: { label: 'Factura emitida', color: 'var(--success)', sensible: false },
  mesa_cerrada: { label: 'Mesa cerrada', color: 'var(--muted)', sensible: false },
  mesa_transferida: { label: 'Mesa transferida', color: 'var(--muted)', sensible: false },
  login_incorrecto_pin: { label: 'Intento PIN fallido',   color: '#ffbf66',          sensible: true  },
  login_incorrecto_emojis: { label: 'Intento Emojis fallido', color: '#ffbf66',      sensible: true  },
  login_bloqueado:     { label: 'ACCESO BLOQUEADO ⚠️',    color: 'var(--danger)',    sensible: true  },
  login:               { label: 'Inicio de sesión',     color: 'var(--success)',   sensible: false }
};

function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), 2400);
}

function leerEstadoSeccionesGerente() {
  try {
    return JSON.parse(localStorage.getItem(GERENTE_SECTION_KEY) || '{}');
  } catch (_) {
    return {};
  }
}

function guardarEstadoSeccionesGerente(state) {
  localStorage.setItem(GERENTE_SECTION_KEY, JSON.stringify(state));
}

function aplicarEstadoSeccionGerente(section, expanded) {
  const card = document.getElementById(`card-${section}`);
  if (!card) return;
  card.classList.toggle('collapsed', !expanded);
  const btn = card.querySelector('.card-toggle');
  if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

window.toggleGerenteSection = section => {
  const state = leerEstadoSeccionesGerente();
  const card = document.getElementById(`card-${section}`);
  const expanded = card ? card.classList.contains('collapsed') : false;
  state[section] = expanded;
  guardarEstadoSeccionesGerente(state);
  aplicarEstadoSeccionGerente(section, expanded);
};

function initGerenteSections() {
  const defaults = {
    ventas: true,
    auditoria: false,
    turnos: true,
    notas: false
  };
  const state = { ...defaults, ...leerEstadoSeccionesGerente() };
  Object.entries(state).forEach(([section, expanded]) => aplicarEstadoSeccionGerente(section, !!expanded));
}

function leerEstadoCompactoGerente() {
  try {
    return JSON.parse(localStorage.getItem(GERENTE_COMPACT_KEY) || '{}');
  } catch (_) {
    return {};
  }
}

function guardarEstadoCompactoGerente(state) {
  localStorage.setItem(GERENTE_COMPACT_KEY, JSON.stringify(state));
}

function aplicarCompactState(target, expanded) {
  if (target === 'turno') {
    const card = document.querySelector('.turno-quick-card');
    if (!card) return;
    card.classList.toggle('compact-mobile-card', true);
    card.classList.toggle('collapsed-mobile', !expanded);
    const btn = card.querySelector('.compact-mobile-toggle');
    if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    return;
  }
  if (target === 'audit-filter') {
    const wrap = document.querySelector('.audit-filtros-wrap');
    if (!wrap) return;
    wrap.classList.toggle('compact-mobile-card', true);
    wrap.classList.toggle('collapsed-mobile', !expanded);
    const btn = wrap.querySelector('.compact-mobile-toggle');
    if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
}

window.toggleCompactGerente = target => {
  const state = { turno: false, 'audit-filter': false, ...leerEstadoCompactoGerente() };
  const expanded = !(state[target] ?? false);
  state.turno = false;
  state['audit-filter'] = false;
  state[target] = expanded;
  guardarEstadoCompactoGerente(state);
  aplicarCompactState('turno', !!state.turno);
  aplicarCompactState('audit-filter', !!state['audit-filter']);
};

function initGerenteCompactBlocks() {
  const defaults = {
    turno: false,
    'audit-filter': false
  };
  const state = { ...defaults, ...leerEstadoCompactoGerente() };
  aplicarCompactState('turno', !!state.turno);
  aplicarCompactState('audit-filter', !!state['audit-filter']);
}

function fmtEu(n) {
  return `${Number(n || 0).toFixed(2).replace('.', ',')} €`;
}

function escHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escCsv(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

function fechaKeyLocal(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fechaLabelDesdeKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

function fechaKeyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseFechaHoraTicket(fecha, hora = '00:00') {
  if (!fecha) return NaN;
  const fechaTxt = String(fecha).trim();
  const horaTxt = String(hora || '00:00').trim().slice(0, 5);

  if (/^\d{4}-\d{2}-\d{2}$/.test(fechaTxt)) {
    return new Date(`${fechaTxt}T${horaTxt}:00`).getTime();
  }

  const match = fechaTxt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return NaN;

  const [, dd, mm, yyyy] = match;
  return new Date(`${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T${horaTxt}:00`).getTime();
}

function normalizarTicketVenta(id, ticket = {}) {
  const base = ticket && typeof ticket === 'object' ? ticket : {};
  const tsNum = Number(base.ts);
  const ts = Number.isFinite(tsNum) && tsNum > 0 ? tsNum : parseFechaHoraTicket(base.fecha, base.hora);
  return { id, ...base, ts };
}

function normalizarHistorialVentasData(data) {
  return Object.entries(data || {})
    .map(([id, t]) => normalizarTicketVenta(id, t))
    .filter(t => Number.isFinite(t.ts))
    .sort((a, b) => b.ts - a.ts);
}

function resumirTickets(tickets) {
  const total = tickets.reduce((s, t) => s + Number(t.total || 0), 0);
  const lineas = tickets.reduce((s, t) =>
    s + (t.lineas || []).reduce((acc, l) => acc + Number(l.qty || 0), 0), 0);
  return {
    tickets: tickets.length,
    total,
    lineas,
    media: tickets.length ? total / tickets.length : 0
  };
}

function agruparVentasPorDia(tickets) {
  const mapa = {};
  tickets.forEach(t => {
    const key = fechaKeyLocal(t.ts);
    if (!mapa[key]) mapa[key] = { fecha: key, tickets: 0, lineas: 0, total: 0 };
    mapa[key].tickets += 1;
    mapa[key].lineas += (t.lineas || []).reduce((acc, l) => acc + Number(l.qty || 0), 0);
    mapa[key].total += Number(t.total || 0);
  });
  return Object.values(mapa).sort((a, b) => b.fecha.localeCompare(a.fecha));
}

async function cargarHistorialVentas(tsIni = null, tsFin = null, force = false) {
  if (tsIni !== null && tsFin !== null) {
    const q = query(ref(db, 'historial'), orderByChild('ts'), startAt(tsIni), endAt(tsFin));
    const snap = await get(q);
    return normalizarHistorialVentasData(snap.val() || {});
  }
  if (!force && historialVentasCargado) return historialVentasCache;
  try {
    const q = query(ref(db, 'historial'), orderByChild('ts'), limitToLast(1));
    const snap = await get(q);
    historialVentasCache = normalizarHistorialVentasData(snap.val() || {});
  } catch (e) {
    console.error(e);
    historialVentasCache = [];
  }
  historialVentasCargado = true;
  return historialVentasCache;
}

function resumirMesaParaHistorial(mesaNombre, pedidosMesa = {}) {
  const todasLineas = Object.values(pedidosMesa || {})
    .filter(envio => envio && typeof envio === 'object' && !String(envio.envioId || '').startsWith('_'))
    .flatMap(envio => Object.values(envio.lineas || {}));
  const agrupado = {};
  const camareros = new Set();

  todasLineas.forEach(l => {
    if (!l || l.estado === 'cancelado') return;
    const qtyCuenta = l.qtyTicket !== undefined && l.qtyTicket !== null
      ? Number(l.qtyTicket || 0)
      : (l.estado === 'servido'
        ? Number(l.qty || 0)
        : (l.qtyServida !== undefined && l.qtyServida !== null ? Number(l.qtyServida || 0) : Number(l.qty || 0)));
    if (qtyCuenta <= 0) return;
    if (l.camarero && l.destino !== 'descuento') camareros.add(l.camarero);
    const key = `${l.nombre || 'Articulo'}||${Number(l.precio || 0).toFixed(2)}||${l.nota || ''}`;
    if (!agrupado[key]) {
      agrupado[key] = {
        nombre: l.nombre || 'Articulo',
        precio: Number(l.precio || 0),
        qty: 0,
        nota: l.nota || ''
      };
    }
    agrupado[key].qty += qtyCuenta;
  });

  const lineas = Object.values(agrupado);
  const total = lineas.reduce((s, l) => s + Number(l.precio || 0) * Number(l.qty || 0), 0);
  return {
    mesa: mesaNombre,
    camarero: [...camareros].join(', '),
    lineas,
    total: Math.round(total * 100) / 100
  };
}

async function cerrarMesasAbiertasParaTurno() {
  const [snapMesas, snapPedidos] = await Promise.all([
    get(ref(db, 'mesas')),
    get(ref(db, 'pedidos'))
  ]);
  const mesas = snapMesas.val() || {};
  const pedidos = snapPedidos.val() || {};
  const ahora = new Date();
  let mesasCerradas = 0;

  for (const [mesaId, pedidosMesa] of Object.entries(pedidos)) {
    if (!pedidosMesa || typeof pedidosMesa !== 'object') continue;
    const mesaNombre = mesas[mesaId]?.nombre || mesaId;
    const resumenMesa = resumirMesaParaHistorial(mesaNombre, pedidosMesa);
    if (resumenMesa.lineas.length > 0) {
      await push(ref(db, 'historial'), {
        mesa: resumenMesa.mesa,
        camarero: resumenMesa.camarero,
        ts: ahora.getTime(),
        fecha: ahora.toLocaleDateString('es-ES'),
        hora: ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
        total: resumenMesa.total,
        lineas: resumenMesa.lineas
      });
    }
    await remove(ref(db, `pedidos/${mesaId}`));
    if (mesaId.startsWith('temp_')) {
      await remove(ref(db, `mesas/${mesaId}`));
    } else {
      await set(ref(db, `mesas/${mesaId}/estado`), 'libre');
    }
    mesasCerradas += 1;
  }

  historialVentasCargado = false;
  return { mesasCerradas };
}

function initFiltrosVentasHoy() {
  const hoy = new Date();
  const hoyKey = fechaKeyFromDate(hoy);
  document.getElementById('filtro-fecha-ini').value = hoyKey;
  document.getElementById('filtro-fecha-fin').value = hoyKey;
  document.getElementById('filtro-hora-ini').value = '00:00';
  document.getElementById('filtro-hora-fin').value = '23:59';
}

async function prepararFiltrosVentasIniciales() {
  initFiltrosVentasHoy();
  const ultimo = (await cargarHistorialVentas())[0];
  if (!ultimo) return;
  const d = new Date(ultimo.ts);
  const key = fechaKeyFromDate(d);
  document.getElementById('filtro-fecha-ini').value = key;
  document.getElementById('filtro-fecha-fin').value = key;
}

function renderMetricasVentas(tickets) {
  const resumen = resumirTickets(tickets);
  document.getElementById('stat-mesas').textContent = resumen.tickets;
  document.getElementById('stat-total').textContent = fmtEu(resumen.total);
  document.getElementById('stat-media').textContent = resumen.tickets ? fmtEu(resumen.media) : '-';
  document.getElementById('stat-lineas').textContent = resumen.lineas;
  const topbar = document.getElementById('topbar-ventas-pill');
  if (topbar) topbar.textContent = tickets.length ? `${tickets.length} tickets filtrados` : 'Sin ventas filtradas';
}

function renderPager(totalItems, pageSize, page, prefix, onEmptyHide = true) {
  const pager = document.getElementById(`${prefix}-pager`);
  const info = document.getElementById(`${prefix}-pager-info`);
  const prev = document.getElementById(`${prefix}-prev`);
  const next = document.getElementById(`${prefix}-next`);
  if (!pager || !info || !prev || !next) return;

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  if (onEmptyHide && totalItems <= pageSize) {
    pager.style.display = 'none';
    return;
  }

  pager.style.display = 'flex';
  const start = totalItems ? ((page - 1) * pageSize) + 1 : 0;
  const end = Math.min(totalItems, page * pageSize);
  info.textContent = totalItems
    ? `Mostrando ${start}-${end} de ${totalItems}`
    : 'Sin resultados';
  prev.disabled = page <= 1;
  next.disabled = page >= totalPages;
}

function renderVentasTablaArticulos(tickets) {
  const host = document.getElementById('ventas-articulos');
  if (!host) return;
  if (!tickets.length) {
    host.innerHTML = '<div class="empty">Sin datos en el periodo seleccionado.</div>';
    return;
  }

  const mapa = {};
  tickets.forEach(t => {
    (t.lineas || []).forEach(l => {
      const nombre = String(l.nombre || 'Sin nombre');
      if (!mapa[nombre]) mapa[nombre] = { nombre, qty: 0, total: 0 };
      mapa[nombre].qty += Number(l.qty || 0);
      mapa[nombre].total += Number(l.precio || 0) * Number(l.qty || 0);
    });
  });

  const rows = Object.values(mapa).sort((a, b) => b.qty - a.qty);
  host.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Articulo</th><th>Unidades</th><th>Total</th></tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${escHtml(r.nombre)}</td>
              <td class="num">${r.qty}</td>
              <td class="num">${fmtEu(r.total)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderVentasTablaDias(tickets) {
  const host = document.getElementById('ventas-dias');
  if (!host) return;
  if (!tickets.length) {
    host.innerHTML = '<div class="empty">Sin datos en el periodo seleccionado.</div>';
    return;
  }

  const rows = agruparVentasPorDia(tickets);
  host.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Fecha</th><th>Tickets</th><th>Articulos</th><th>Total</th></tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${fechaLabelDesdeKey(r.fecha)}</td>
              <td class="num">${r.tickets}</td>
              <td class="num">${r.lineas}</td>
              <td class="num">${fmtEu(r.total)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderVentasTickets(tickets) {
  const lista = document.getElementById('ventas-lista');
  if (!lista) return;
  if (!tickets.length) {
    lista.innerHTML = '<div class="empty">Sin ventas en ese periodo.</div>';
    renderPager(0, SALES_PAGE_SIZE, 1, 'ventas');
    return;
  }

  const totalPages = Math.max(1, Math.ceil(tickets.length / SALES_PAGE_SIZE));
  ventasPagina = Math.min(Math.max(1, ventasPagina), totalPages);
  const start = (ventasPagina - 1) * SALES_PAGE_SIZE;
  const pageItems = tickets.slice(start, start + SALES_PAGE_SIZE);

  lista.innerHTML = pageItems.map(t => {
    const fecha = new Date(t.ts).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
    const lineas = (t.lineas || []).map(l => `
      <div class="ticket-line">
        <span>${Number(l.qty || 0)} x ${escHtml(l.nombre || 'Articulo')}</span>
        <span>${fmtEu(Number(l.precio || 0) * Number(l.qty || 0))}</span>
      </div>
    `).join('');

    return `
      <article class="ticket-card">
        <div class="ticket-head">
          <div>
            <div class="ticket-title">Mesa ${escHtml(t.mesa || '-')}</div>
            <div class="ticket-meta">${fecha}${t.camarero ? ` · ${escHtml(t.camarero)}` : ''}</div>
          </div>
          <div class="ticket-total">${fmtEu(t.total || 0)}</div>
        </div>
        <div class="ticket-body">
          <div class="ticket-lines">${lineas || '<div class="ticket-line"><span>Sin lineas guardadas</span><span>-</span></div>'}</div>
          <div class="ticket-actions">
            <button class="small" onclick="reimprimirTicketHistorial('${t.id}')">Reimprimir ticket</button>
          </div>
        </div>
      </article>
    `;
  }).join('');

  renderPager(tickets.length, SALES_PAGE_SIZE, ventasPagina, 'ventas');
}

function renderVentasSegunTab() {
  renderMetricasVentas(ventasFiltradas);
  renderVentasTickets(ventasFiltradas);
  renderVentasTablaArticulos(ventasFiltradas);
  renderVentasTablaDias(ventasFiltradas);
}

window.mostrarTabVentasGerente = (tab, btn) => {
  ventasTabActiva = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');

  document.getElementById('ventas-por-ticket').style.display = tab === 'tickets' ? '' : 'none';
  document.getElementById('ventas-por-articulo').style.display = tab === 'articulos' ? '' : 'none';
  document.getElementById('ventas-por-dia').style.display = tab === 'dias' ? '' : 'none';
};

window.cambiarPaginaVentas = delta => {
  const totalPages = Math.max(1, Math.ceil(ventasFiltradas.length / SALES_PAGE_SIZE));
  ventasPagina = Math.min(totalPages, Math.max(1, ventasPagina + delta));
  renderVentasTickets(ventasFiltradas);
};

window.aplicarFiltrosGerente = async () => {
  try {
    const fechaIni = document.getElementById('filtro-fecha-ini').value;
    const fechaFin = document.getElementById('filtro-fecha-fin').value;
    const horaIni = document.getElementById('filtro-hora-ini').value || '00:00';
    const horaFin = document.getElementById('filtro-hora-fin').value || '23:59';

    if (!fechaIni || !fechaFin) {
      toast('Selecciona las fechas');
      return;
    }

    const tsIni = new Date(`${fechaIni}T${horaIni}:00`).getTime();
    const tsFin = new Date(`${fechaFin}T${horaFin}:59`).getTime();

    ventasFiltradas = (await cargarHistorialVentas(tsIni, tsFin, true))
      .sort((a, b) => b.ts - a.ts);

    ventasPagina = 1;
    renderVentasSegunTab();
  } catch (err) {
    console.error('Error filtrando ventas', err);
    ventasFiltradas = [];
    renderVentasSegunTab();
    toast('No se pudieron cargar las ventas');
  }
};

window.resetFiltrosGerente = () => {
  initFiltrosVentasHoy();
  ventasPagina = 1;
  window.aplicarFiltrosComunesGerente();
};

window.exportarVentasGerenteCSV = () => {
  if (!ventasFiltradas.length) {
    toast('Sin datos para exportar');
    return;
  }

  let csv = '';
  let sufijo = ventasTabActiva;

  if (ventasTabActiva === 'articulos') {
    const mapa = {};
    ventasFiltradas.forEach(t => {
      (t.lineas || []).forEach(l => {
        const nombre = String(l.nombre || 'Sin nombre');
        if (!mapa[nombre]) mapa[nombre] = { nombre, qty: 0, total: 0 };
        mapa[nombre].qty += Number(l.qty || 0);
        mapa[nombre].total += Number(l.precio || 0) * Number(l.qty || 0);
      });
    });
    csv = 'Articulo,Unidades,Total\n';
    Object.values(mapa).sort((a, b) => b.qty - a.qty).forEach(r => {
      csv += `${escCsv(r.nombre)},${escCsv(r.qty)},${escCsv(r.total.toFixed(2))}\n`;
    });
  } else if (ventasTabActiva === 'dias') {
    csv = 'Fecha,Tickets,Articulos,Total\n';
    agruparVentasPorDia(ventasFiltradas).forEach(d => {
      csv += `${escCsv(fechaLabelDesdeKey(d.fecha))},${escCsv(d.tickets)},${escCsv(d.lineas)},${escCsv(d.total.toFixed(2))}\n`;
    });
  } else {
    sufijo = 'tickets';
    csv = 'Fecha,Hora,Mesa,Camarero,Total,Articulo,Cantidad,Precio unitario\n';
    ventasFiltradas.forEach(t => {
      const fecha = new Date(t.ts).toLocaleDateString('es-ES');
      const hora = new Date(t.ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      (t.lineas || []).forEach(l => {
        csv += `${escCsv(fecha)},${escCsv(hora)},${escCsv(t.mesa || '')},${escCsv(t.camarero || '')},${escCsv(Number(t.total || 0).toFixed(2))},${escCsv(l.nombre || '')},${escCsv(l.qty || 0)},${escCsv(Number(l.precio || 0).toFixed(2))}\n`;
      });
    });
  }

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fechaIni = document.getElementById('filtro-fecha-ini').value;
  const fechaFin = document.getElementById('filtro-fecha-fin').value;
  a.href = url;
  a.download = `ventas_gerencia_${sufijo}_${fechaIni}_${fechaFin}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

function buildTicketHtml(ticket) {
  const paper = configLocal.ticketPaper || '80mm';
  const logoHtml = configLocal.ticketLogoUrl
    ? `<div style="text-align:center;margin-bottom:4px"><img src="${escHtml(configLocal.ticketLogoUrl)}" style="max-width:60mm;max-height:18mm;object-fit:contain"></div>`
    : '';
  const localLines = [
    configLocal.nombre ? `<div style="text-align:center;font-weight:bold;font-size:11px">${escHtml(configLocal.nombre)}</div>` : '',
    configLocal.direccion ? `<div style="text-align:center;font-size:8px;color:#444">${escHtml(configLocal.direccion)}</div>` : '',
    configLocal.telefono ? `<div style="text-align:center;font-size:8px;color:#444">${escHtml(configLocal.telefono)}</div>` : '',
    configLocal.cif ? `<div style="text-align:center;font-size:8px;color:#444">${escHtml(configLocal.cif)}</div>` : ''
  ].join('');

  const lineasHtml = (ticket.lineas || []).map(l => `
    <div style="display:flex;justify-content:space-between;gap:10px;margin:3px 0">
      <span>${Number(l.qty || 0)} x ${escHtml(l.nombre || 'Articulo')}</span>
      <span>${fmtEu(Number(l.precio || 0) * Number(l.qty || 0))}</span>
    </div>
    ${l.nota ? `<div style="font-size:8px;color:#666;margin-top:-1px;margin-bottom:3px">${escHtml(l.nota)}</div>` : ''}
  `).join('');

  const fecha = new Date(ticket.ts || Date.now()).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
  const footerHtml = configLocal.footer
    ? `<div style="text-align:center;font-size:7px;color:#777;margin-top:8px;border-top:1px dashed #999;padding-top:4px">${escHtml(configLocal.footer)}</div>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
@page{size:${paper} auto;margin:3mm}
body{font-family:'Courier New',monospace;font-size:9px;width:${paper};max-width:${paper};color:#111}
.bar{display:flex;gap:6px;margin-bottom:10px;justify-content:center;flex-wrap:wrap}
.bar button{border:1px solid #aaa;background:#f5f5f5;color:#111;border-radius:999px;padding:5px 14px;font:inherit;cursor:pointer;font-size:10px}
.rule{border:none;border-top:1px dashed #666;margin:5px 0}
.total{display:flex;justify-content:space-between;font-weight:bold;font-size:10px;margin-top:6px;padding-top:4px;border-top:1px solid #333}
@media print{.bar{display:none}}
</style></head><body>
<div class="bar">
  <button onclick="window.print()">Imprimir / PDF</button>
  <button id="btn-servicio">Enviar a impresora</button>
  <button onclick="window.close()">Cerrar</button>
</div>
${logoHtml}
${localLines}
<div style="text-align:center;font-size:8px;margin-top:5px">Mesa ${escHtml(ticket.mesa || '-')}</div>
<div style="text-align:center;font-size:8px;color:#555">${fecha}${ticket.camarero ? ` · ${escHtml(ticket.camarero)}` : ''}</div>
<div style="text-align:center;font-size:7px;color:#666;margin-top:3px">Reimpresion desde gerencia</div>
<hr class="rule">
${lineasHtml || '<div style="text-align:center;font-size:8px;color:#666">Sin lineas guardadas</div>'}
<div class="total"><span>Total</span><span>${fmtEu(ticket.total || 0)}</span></div>
${footerHtml}
<script>
document.getElementById('btn-servicio')?.addEventListener('click', () => {
  window.__sendToService?.();
});
<\/script>
</body></html>`;
}

window.reimprimirTicketHistorial = async ticketId => {
  const ticket = historialVentasCache.find(t => t.id === ticketId);
  if (!ticket) {
    toast('No se encontro el ticket');
    return;
  }

  const html = buildTicketHtml(ticket);
  const win = window.open('', '_blank');
  if (!win) {
    toast('Permite las ventanas emergentes para reimprimir');
    return;
  }

  win.document.open();
  win.document.write(html);
  win.document.close();

  win.__sendToService = async () => {
    const serviceId = String(configLocal.ticketPrintServiceId || PRINT_SERVICE_ID).trim() || PRINT_SERVICE_ID;
    const payload = {
      kind: 'ticket_final',
      status: 'pending',
      createdAt: Date.now(),
      serviceId,
      requestedBy: 'gerencia-reprint',
      mesaId: ticket.mesa || '',
      mesaNombre: ticket.mesa || '',
      local: {
        nombre: configLocal.nombre || '',
        direccion: configLocal.direccion || '',
        telefono: configLocal.telefono || '',
        cif: configLocal.cif || '',
        footer: configLocal.footer || '',
        logoUrl: configLocal.ticketLogoUrl || '',
        ticketShowNotes: configLocal.ticketShowNotes !== false
      },
      format: {
        paper: configLocal.ticketPaper || '80mm',
        fontSize: Number(configLocal.ticketFontSize || 9),
        uppercase: configLocal.ticketUppercase === true,
        headerOffset: Number(configLocal.ticketHeaderOffset || 0)
      },
      total: Math.round(Number(ticket.total || 0) * 100) / 100,
      lines: (ticket.lineas || []).map(l => ({
        nombre: l.nombre || '',
        qty: Number(l.qty || 0),
        precio: Math.round(Number(l.precio || 0) * 100) / 100,
        nota: configLocal.ticketShowNotes === false ? '' : String(l.nota || '')
      })),
      cobro: null,
      verifactu: null
    };

    try {
      await push(ref(db, 'print_jobs'), payload);
      const btn = win.document.getElementById('btn-servicio');
      if (btn) {
        btn.textContent = 'Enviado';
        btn.disabled = true;
      }
    } catch (err) {
      alert(`Error al enviar: ${err.message}`);
    }
  };
};

window.abrirTurnoGerente = async () => {
  const nombre = document.getElementById('turno-nombre')?.value.trim() || 'Turno';
  await set(ref(db, 'config/turno'), { abierto: true, inicio: Date.now(), nombre });
  toast(`Turno abierto: ${nombre}`);
};

window.cerrarTurnoGerente = async () => {
  const snap = await get(ref(db, 'config/turno'));
  const turno = snap.val();
  if (!turno?.abierto) {
    toast('No hay turno abierto');
    return;
  }

  const snapPedidos = await get(ref(db, 'pedidos'));
  const pedidosActivos = Object.keys(snapPedidos.val() || {}).filter(k => !String(k).startsWith('_'));
  if (pedidosActivos.length) {
    const ok = await confirmDialog({
      title: 'Cerrar turno con mesas abiertas',
      body: `Hay ${pedidosActivos.length} ${pedidosActivos.length === 1 ? 'mesa con cuenta abierta' : 'mesas con cuentas abiertas'}. Si continúas, se generará el ticket pendiente de cada mesa, se guardará en ventas y después se limpiarán todas las mesas.`,
      confirmLabel: 'Cerrar turno y limpiar',
      cancelLabel: 'Volver',
      danger: true
    });
    if (!ok) return;
    const cierreMesas = await cerrarMesasAbiertasParaTurno();
    if (cierreMesas.mesasCerradas) toast(`Se cerraron ${cierreMesas.mesasCerradas} mesas antes de cerrar el turno`);
  }

  const tickets = await cargarHistorialVentas(Number(turno.inicio || 0), Date.now(), true);
  const resumen = resumirTickets(tickets);

  await push(ref(db, 'historial_turnos'), {
    nombre: turno.nombre,
    inicio: turno.inicio,
    fin: Date.now(),
    mesas: resumen.tickets,
    total: Math.round(resumen.total * 100) / 100,
    lineas_count: resumen.lineas,
    ticket_medio: Math.round(resumen.media * 100) / 100
  });

  await set(ref(db, 'config/turno'), { ...turno, abierto: false, ultimoCierre: Date.now() });
  toast(`Turno cerrado: ${resumen.tickets} tickets · ${fmtEu(resumen.total)}`);
};

function renderResumenTurnoActualConTickets(turno, tickets) {
  const cont = document.getElementById('turno-resumen-actual');
  const status = document.getElementById('turno-status');
  const pill = document.getElementById('topbar-turno-pill');
  const btnAbrir = document.getElementById('btn-abrir-turno');
  const btnCerrar = document.getElementById('btn-cerrar-turno');
  const compact = document.getElementById('turno-compact-summary');
  if (!cont || !status) return;

  if (!turno?.abierto) {
    status.textContent = 'Sin turno activo';
    status.style.color = 'var(--muted)';
    if (pill) pill.textContent = 'Sin turno activo';
    if (btnAbrir) btnAbrir.disabled = false;
    if (btnCerrar) btnCerrar.disabled = true;
    if (compact) compact.textContent = 'Sin turno activo';
    cont.innerHTML = '<div class="empty">No hay turno activo.</div>';
    return;
  }

  const resumen = resumirTickets(tickets);
  const inicio = new Date(turno.inicio);
  const inicioTxt = `${inicio.toLocaleDateString('es-ES')} · ${inicio.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;

  status.textContent = `"${turno.nombre || 'Turno'}" abierto desde las ${inicio.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
  status.style.color = 'var(--success)';
  if (pill) pill.textContent = `${turno.nombre || 'Turno'} activo`;
  if (btnAbrir) btnAbrir.disabled = true;
  if (btnCerrar) btnCerrar.disabled = false;
  if (compact) {
    compact.innerHTML = `${escHtml(turno.nombre || 'Turno')} activo<br>${resumen.tickets} tickets · ${fmtEu(resumen.total)}`;
  }

  cont.innerHTML = `
    <article class="turno-card">
      <div class="turno-head">
        <div>
          <div class="turno-title">${escHtml(turno.nombre || 'Turno en curso')}</div>
          <div class="turno-meta">Abierto el ${inicioTxt}</div>
        </div>
        <div class="badge active">Activo</div>
      </div>
      <div class="turno-body">
        <div class="turno-stats">
          <div class="turno-stat"><strong>${resumen.tickets}</strong><span>Tickets</span></div>
          <div class="turno-stat"><strong>${resumen.lineas}</strong><span>Articulos</span></div>
          <div class="turno-stat"><strong>${fmtEu(resumen.total)}</strong><span>Total</span></div>
          <div class="turno-stat"><strong>${resumen.tickets ? fmtEu(resumen.media) : '-'}</strong><span>Ticket medio</span></div>
        </div>
      </div>
    </article>`;
}

async function renderResumenTurnoActual(turno = turnoActualCache) {
  if (!turno?.abierto) {
    renderResumenTurnoActualConTickets(turno, []);
    return;
  }
  const tickets = await cargarHistorialVentas(Number(turno.inicio || 0), Date.now(), true);
  renderResumenTurnoActualConTickets(turno, tickets);
}

function renderHistorialTurnos(turnosData) {
  const lista = document.getElementById('turnos-lista');
  if (!lista) return;

  const turnos = Object.entries(turnosData || {})
    .map(([id, t]) => ({ id, ...t }))
    .filter(t => t.inicio && t.fin)
    .sort((a, b) => Number(b.fin || 0) - Number(a.fin || 0));

  if (!turnos.length) {
    lista.innerHTML = '<div class="empty">Todavia no hay turnos cerrados.</div>';
    return;
  }

  lista.innerHTML = turnos.map(t => {
    const inicio = new Date(t.inicio);
    const fin = new Date(t.fin);
    const mins = Math.max(0, Math.round((Number(t.fin) - Number(t.inicio)) / 60000));
    const horas = Math.floor(mins / 60);
    const resto = mins % 60;
    const duracion = horas ? `${horas}h ${String(resto).padStart(2, '0')}m` : `${resto}m`;
    const media = Number(t.ticket_medio ?? ((Number(t.total || 0)) / Math.max(1, Number(t.mesas || 0))));
    return `
      <article class="turno-card">
        <div class="turno-head">
          <div>
            <div class="turno-title">${escHtml(t.nombre || 'Turno')}</div>
            <div class="turno-meta">${inicio.toLocaleDateString('es-ES')} · ${inicio.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} - ${fin.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
          <div class="turno-badge">${fmtEu(t.total || 0)}</div>
        </div>
        <div class="turno-body">
          <div class="turno-stats">
            <div class="turno-stat"><strong>${Number(t.mesas || 0)}</strong><span>Tickets</span></div>
            <div class="turno-stat"><strong>${Number(t.lineas_count || 0)}</strong><span>Articulos</span></div>
            <div class="turno-stat"><strong>${fmtEu(media)}</strong><span>Ticket medio</span></div>
            <div class="turno-stat"><strong>${duracion}</strong><span>Duracion</span></div>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function initFiltrosAuditoria() {
  const hoyKey = fechaKeyFromDate(new Date());
  const ini = document.getElementById('filtro-fecha-ini');
  const fin = document.getElementById('filtro-fecha-fin');
  const hIni = document.getElementById('filtro-hora-ini');
  const hFin = document.getElementById('filtro-hora-fin');
  if (ini && !ini.value) ini.value = hoyKey;
  if (fin && !fin.value) fin.value = hoyKey;
  if (hIni && !hIni.value) hIni.value = '00:00';
  if (hFin && !hFin.value) hFin.value = '23:59';
}

window.resetFiltrosAuditoriaGerente = () => {
  const hoyKey = fechaKeyFromDate(new Date());
  document.getElementById('filtro-fecha-ini').value = hoyKey;
  document.getElementById('filtro-fecha-fin').value = hoyKey;
  document.getElementById('filtro-hora-ini').value = '00:00';
  document.getElementById('filtro-hora-fin').value = '23:59';
  document.getElementById('audit-camarero').value = '';
  document.getElementById('audit-accion').value = '';
  document.getElementById('audit-mesa').value = '';
  auditPagina = 1;
  window.aplicarFiltrosComunesGerente();
};

function poblarCamarerosAuditoria(usuarios) {
  auditUsuarios = usuarios || {};
  const sel = document.getElementById('audit-camarero');
  if (!sel) return;
  const actual = sel.value;
  const nombres = Object.values(auditUsuarios)
    .map(u => u?.nombre ? String(u.nombre) : null)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'es'));
  sel.innerHTML = '<option value="">- Todos -</option>' +
    nombres.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
  if (actual && nombres.includes(actual)) sel.value = actual;
}

function desbloquearAuditoriaGerente() {
  auditUnlocked = true;
  const locked = document.getElementById('audit-locked');
  const unlocked = document.getElementById('audit-unlocked');
  if (locked) locked.style.display = 'none';
  if (unlocked) unlocked.style.display = '';
  initFiltrosAuditoria();
  poblarCamarerosAuditoria(auditUsuarios);
  window.aplicarFiltrosAuditoriaGerente();
}

async function leerEventosAuditoriaRango(fechaIni, fechaFin) {
  const ini = new Date(`${fechaIni}T00:00:00`);
  const fin = new Date(`${fechaFin}T00:00:00`);
  if (isNaN(ini.getTime()) || isNaN(fin.getTime()) || ini > fin) return [];

  const eventos = [];
  const cursor = new Date(ini);
  let safety = 95;
  while (cursor <= fin && safety-- > 0) {
    const key = fechaKeyFromDate(cursor);
    try {
      const snap = await get(ref(db, `auditoria/${key}`));
      const data = snap.val() || {};
      Object.entries(data).forEach(([id, ev]) => {
        if (!ev || typeof ev !== 'object') return;
        eventos.push({ id, fechaKey: key, ...ev });
      });
    } catch (_) {}
    cursor.setDate(cursor.getDate() + 1);
  }
  return eventos;
}

function renderEventosAuditoria(eventos) {
  const lista = document.getElementById('audit-lista');
  if (!lista) return;

  document.getElementById('audit-stat-eventos').textContent = eventos.length;
  document.getElementById('audit-stat-eliminados').textContent = eventos.filter(e => e.accion === 'articulo_eliminado').length;
  document.getElementById('audit-stat-descuentos').textContent = eventos.filter(e =>
    e.accion === 'descuento_aplicado' ||
    (e.accion === 'cantidad_editada' && Number(e.qtyDespues || 0) < Number(e.qtyAntes || 0))
  ).length;

  const totalPages = Math.max(1, Math.ceil(eventos.length / AUDIT_PAGE_SIZE));
  auditPagina = Math.min(Math.max(1, auditPagina), totalPages);
  document.getElementById('audit-stat-paginas').textContent = totalPages;

  if (!eventos.length) {
    lista.innerHTML = '<div class="empty">Sin eventos en el periodo o filtro seleccionado.</div>';
    renderPager(0, AUDIT_PAGE_SIZE, 1, 'audit');
    return;
  }

  const start = (auditPagina - 1) * AUDIT_PAGE_SIZE;
  const pageItems = eventos.slice(start, start + AUDIT_PAGE_SIZE);
  lista.innerHTML = pageItems.map(ev => {
    const info = AUDIT_LABELS[ev.accion] || { label: ev.accion || '-', color: 'var(--muted)', sensible: false };
    const fecha = new Date(Number(ev.ts) || 0);
    const fechaTxt = fecha.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const horaTxt = ev.hora || fecha.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const detalle = escHtml(ev.detalle || '');
    const totalStr = ev.total !== undefined && ev.total !== null && !isNaN(Number(ev.total))
      ? ` <span style="color:var(--accent);font-family:var(--mono)">${fmtEu(ev.total)}</span>`
      : '';
      
    // Detectar inicio de sesión a horas inusuales (2:00 AM - 8:00 AM)
    let alertHora = '';
    if (String(ev.accion).includes('login')) {
      let hh = -1;
      if (ev.hora) {
        hh = parseInt(ev.hora.split(':')[0], 10);
      } else {
        hh = fecha.getHours();
      }
      if (hh >= 2 && hh < 8) {
        alertHora = ' <span title="¡Hora inusual (2am-8am)!" style="color:var(--danger);font-weight:bold;margin-left:4px">⚠️</span>';
      }
    }
    
    // Detectar si es bloqueo por 3 errores
    let isBlock = ev.accion === 'login_bloqueado' || String(ev.accion).includes('bloqueado');
    let rowClass = info.sensible ? 'sensitive' : '';
    if (isBlock) {
      rowClass = 'sensitive'; // Destacar fila bloqueada
    }
    
    const labelTxt = escHtml(info.label) + (isBlock ? ' ❗' : '');

    return `
      <article class="audit-row ${rowClass}" style="${isBlock ? 'background:rgba(229,83,83,0.12);border-left:4px solid var(--danger);font-weight:bold;' : ''}">
        <div class="audit-col mono">${fechaTxt}<br>${horaTxt}${alertHora}</div>
        <div class="audit-col mono">${escHtml(ev.camarero || '-')}</div>
        <div class="audit-col mono">${ev.mesa ? `Mesa ${escHtml(ev.mesa)}` : '-'}</div>
        <div class="audit-col" style="color:${info.color};font-weight:700">${labelTxt}</div>
        <div class="audit-col">${detalle}${totalStr}</div>
      </article>
    `;
  }).join('');

  renderPager(eventos.length, AUDIT_PAGE_SIZE, auditPagina, 'audit');
}

window.cambiarPaginaAuditoria = delta => {
  const totalPages = Math.max(1, Math.ceil(auditEventos.length / AUDIT_PAGE_SIZE));
  auditPagina = Math.min(totalPages, Math.max(1, auditPagina + delta));
  renderEventosAuditoria(auditEventos);
};

window.aplicarFiltrosComunesGerente = async () => {
  await window.aplicarFiltrosGerente();
  await window.aplicarFiltrosAuditoriaGerente();
};

window.aplicarFiltrosAuditoriaGerente = async () => {
  if (!auditUnlocked) return;

  const fechaIni = document.getElementById('filtro-fecha-ini').value;
  const fechaFin = document.getElementById('filtro-fecha-fin').value;
  const horaIni = document.getElementById('filtro-hora-ini').value || '00:00';
  const horaFin = document.getElementById('filtro-hora-fin').value || '23:59';
  const camFiltro = document.getElementById('audit-camarero').value || '';
  const accFiltro = document.getElementById('audit-accion').value || '';
  const mesaFiltro = (document.getElementById('audit-mesa').value || '').trim().toLowerCase();

  if (!fechaIni || !fechaFin) {
    toast('Selecciona el rango de fechas');
    return;
  }

  const lista = document.getElementById('audit-lista');
  if (lista) lista.innerHTML = '<div class="empty">Cargando...</div>';

  let eventos = await leerEventosAuditoriaRango(fechaIni, fechaFin);
  const tsMin = new Date(`${fechaIni}T${horaIni}:00`).getTime();
  const tsMax = new Date(`${fechaFin}T${horaFin}:59`).getTime();

  eventos = eventos.filter(ev => {
    const ts = Number(ev.ts || 0);
    if (!ts || ts < tsMin || ts > tsMax) return false;
    if (camFiltro && String(ev.camarero || '') !== camFiltro) return false;
    if (accFiltro && String(ev.accion || '') !== accFiltro) return false;
    if (mesaFiltro && !String(ev.mesa || '').toLowerCase().includes(mesaFiltro)) return false;
    return true;
  }).sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

  auditEventos = eventos;
  auditPagina = 1;
  renderEventosAuditoria(eventos);
  if (window.innerWidth <= 760) {
    const state = { turno: false, 'audit-filter': false, ...leerEstadoCompactoGerente(), 'audit-filter': false };
    guardarEstadoCompactoGerente(state);
    aplicarCompactState('audit-filter', false);
  }
};

window.exportarAuditoriaGerenteCSV = () => {
  if (!auditEventos.length) {
    toast('Sin eventos para exportar');
    return;
  }

  let csv = 'Fecha,Hora,Camarero,Mesa,Accion,Detalle,Total\n';
  auditEventos.forEach(ev => {
    const d = new Date(Number(ev.ts) || 0);
    const fecha = d.toLocaleDateString('es-ES');
    const hora = ev.hora || d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const accionLabel = AUDIT_LABELS[ev.accion]?.label || ev.accion || '';
    csv += `${escCsv(fecha)},${escCsv(hora)},${escCsv(ev.camarero || '')},${escCsv(ev.mesa || '')},${escCsv(accionLabel)},${escCsv(ev.detalle || '')},${escCsv(ev.total ?? '')}\n`;
  });

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fIni = document.getElementById('filtro-fecha-ini').value;
  const fFin = document.getElementById('filtro-fecha-fin').value;
  a.href = url;
  a.download = `auditoria_gerencia_${fIni}_${fFin}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

window.checkLogin = async () => {
  const pwd = document.getElementById('pwd-input').value;
  const snap = await get(ref(db, GERENTE_PWD_PATH));
  const stored = snap.val() || GERENTE_PWD_DEFAULT;
  if (pwd === stored) {
    document.getElementById('login-error').style.display = 'none';
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    await init();
  } else {
    document.getElementById('login-error').style.display = 'block';
  }
};

document.getElementById('pwd-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') window.checkLogin();
});

async function init() {
  await prepararFiltrosVentasIniciales();
  initGerenteSections();
  initGerenteCompactBlocks();

  onValue(ref(db, 'config/local'), snap => {
    configLocal = snap.val() || {};
  });

  onValue(ref(db, 'config/usuarios'), snap => {
    poblarCamarerosAuditoria(snap.val() || {});
  });

  onValue(ref(db, 'config/turno'), snap => {
    const t = snap.val() || {};
    turnoActualCache = t;

    // Manage real-time subscription for the active turn's sales
    if (unsubscribeTurnSales) {
      unsubscribeTurnSales();
      unsubscribeTurnSales = null;
    }

    if (t.abierto && t.inicio) {
      const q = query(ref(db, 'historial'), orderByChild('ts'), startAt(Number(t.inicio)));
      unsubscribeTurnSales = onValue(q, snapSales => {
        const salesObj = snapSales.val() || {};
        const currentTurnTickets = normalizarHistorialVentasData(salesObj);
        renderResumenTurnoActualConTickets(t, currentTurnTickets);
      });
    } else {
      renderResumenTurnoActualConTickets(t, []);
    }
  });

  onValue(query(ref(db, 'historial_turnos'), limitToLast(25)), snap => {
    renderHistorialTurnos(snap.val() || {});
  });

  desbloquearAuditoriaGerente();

  poblarCamarerosAuditoria(auditUsuarios);
  await window.aplicarFiltrosComunesGerente();
}

window.cierreCajaRapido = async () => {
  const dateInput = document.getElementById("cierre-fecha");
  const chosenDateStr = dateInput ? dateInput.value : "";

  let startTs, endTs;
  if (chosenDateStr) {
    const dStart = new Date(`${chosenDateStr}T05:00:00`);
    const dEnd = new Date(dStart.getTime() + 24 * 60 * 60 * 1000);
    startTs = dStart.getTime();
    endTs = dEnd.getTime();
  } else {
    const ahora = new Date();
    const inicioDiaComercial = new Date(ahora);
    if (ahora.getHours() < 5) {
      inicioDiaComercial.setDate(ahora.getDate() - 1);
    }
    inicioDiaComercial.setHours(5, 0, 0, 0);
    startTs = inicioDiaComercial.getTime();
    endTs = ahora.getTime();
  }

  toast('Generando cierre de caja...');
  const tickets = await cargarHistorialVentas(startTs, endTs, true);

  if (tickets.length === 0) {
    toast(chosenDateStr ? 'No hay ventas en la fecha seleccionada' : 'No hay ventas hoy (desde las 5:00 AM)');
    return;
  }

  const ticketsCount = tickets.length;
  const total = tickets.reduce((sum, t) => sum + Number(t.total || 0), 0);
  const efectivo = tickets.filter(t => (t.pagoMetodo || '').toLowerCase() === 'efectivo' || (t.cobro && !t.pagoMetodo)).reduce((sum, t) => sum + Number(t.total || 0), 0);
  const tarjeta = tickets.filter(t => (t.pagoMetodo || '').toLowerCase() === 'tarjeta').reduce((sum, t) => sum + Number(t.total || 0), 0);
  const ticketMedio = ticketsCount ? total / ticketsCount : 0;

  const articulosMap = {};
  tickets.forEach(t => {
    (t.lineas || []).forEach(l => {
      const nombre = l.nombre || 'Artículo';
      const qty = Number(l.qty || 0);
      const precio = Number(l.precio || 0);
      if (!articulosMap[nombre]) {
        articulosMap[nombre] = { nombre, qty: 0, total: 0 };
      }
      articulosMap[nombre].qty += qty;
      articulosMap[nombre].total += (qty * precio);
    });
  });
  const articulos = Object.values(articulosMap).sort((a, b) => b.qty - a.qty);

  const resumenDia = {
    startTs,
    endTs,
    ticketsCount,
    total,
    efectivo,
    tarjeta,
    ticketMedio,
    articulos
  };

  const loc = configLocal || {};
  const serviceId = String(loc.ticketPrintServiceId || PRINT_SERVICE_ID).trim() || PRINT_SERVICE_ID;
  const payload = {
    kind: 'ticket_final',
    status: 'pending',
    createdAt: Date.now(),
    serviceId,
    requestedBy: 'gerencia-cierre',
    mesaId: 'cierre',
    mesaNombre: 'CIERRE DIARIO',
    local: {
      nombre: loc.nombre || '',
      direccion: loc.direccion || '',
      telefono: loc.telefono || '',
      cif: loc.cif || '',
      footer: 'Fin de Cierre de Caja',
      logoUrl: loc.ticketLogoUrl || '',
      ticketShowNotes: false,
      headerNameFontSize: Number(loc.ticketHeaderNameFontSize || 12),
      headerSubFontSize: Number(loc.ticketHeaderSubFontSize || 8)
    },
    format: {
      paper: loc.ticketPaper || '80mm',
      fontSize: Number(loc.ticketFontSize || 9),
      uppercase: loc.ticketUppercase === true,
      headerOffset: Number(loc.ticketHeaderOffset || 0)
    },
    total: Math.round(total * 100) / 100,
    lines: [
      { nombre: 'Tickets Cobrados', qty: ticketsCount, precio: 0 },
      { nombre: '* EFECTIVO *', qty: 1, precio: Math.round(efectivo * 100) / 100 },
      { nombre: '* TARJETA *', qty: 1, precio: Math.round(tarjeta * 100) / 100 },
      { nombre: '--- DESGLOSE ARTÍCULOS ---', qty: 1, precio: 0 },
      ...articulos.map(a => ({
        nombre: a.nombre,
        qty: a.qty,
        precio: Math.round((a.total / a.qty) * 100) / 100
      }))
    ],
    cobro: null
  };

  try {
    await push(ref(db, 'print_jobs'), payload);
    toast('✓ Cierre enviado a la impresora');
  } catch (e) {
    alert('Error al enviar: ' + e.message);
  }
};

function buildCierreCajaHtml(resumenDia) {
  const loc = configLocal || {};
  const paper = loc.ticketPaper || '80mm';
  const logoHtml = loc.ticketLogoUrl
    ? `<div style="text-align:center;margin-bottom:4px"><img src="${escHtml(loc.ticketLogoUrl)}" style="max-width:60mm;max-height:18mm;object-fit:contain"></div>`
    : '';
  const localLines = [
    loc.nombre ? `<div style="text-align:center;font-weight:bold;font-size:11px">${escHtml(loc.nombre)}</div>` : '',
    loc.direccion ? `<div style="text-align:center;font-size:8px;color:#444">${escHtml(loc.direccion)}</div>` : '',
    loc.telefono ? `<div style="text-align:center;font-size:8px;color:#444">${escHtml(loc.telefono)}</div>` : '',
    loc.cif ? `<div style="text-align:center;font-size:8px;color:#444">${escHtml(loc.cif)}</div>` : ''
  ].join('');

  const fechaImpresion = new Date().toLocaleString('es-ES');
  const fechaDesde = new Date(resumenDia.startTs).toLocaleString('es-ES');
  const fechaHasta = new Date(resumenDia.endTs).toLocaleString('es-ES');

  const linesHtml = resumenDia.articulos.map(a => `
    <div style="display:flex;justify-content:space-between;gap:10px;margin:3px 0">
      <span>${a.qty} x ${escHtml(a.nombre)}</span>
      <span>${fmtEu(a.total)}</span>
    </div>
  `).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
@page{size:${paper} auto;margin:3mm}
body{font-family:'Courier New',monospace;font-size:9px;width:${paper};max-width:${paper};color:#111}
.bar{display:flex;gap:6px;margin-bottom:10px;justify-content:center;flex-wrap:wrap}
.bar button{border:1px solid #aaa;background:#f5f5f5;color:#111;border-radius:999px;padding:5px 14px;font:inherit;cursor:pointer;font-size:10px}
.rule{border:none;border-top:1px dashed #666;margin:5px 0}
.total{display:flex;justify-content:space-between;font-weight:bold;font-size:10px;margin-top:6px;padding-top:4px;border-top:1px solid #333}
@media print{.bar{display:none}}
</style></head><body>
<div class="bar">
  <button onclick="window.print()">Imprimir / PDF</button>
  <button id="btn-servicio">Enviar a impresora</button>
  <button onclick="window.close()">Cerrar</button>
</div>
${logoHtml}
${localLines}
<div style="text-align:center;font-weight:bold;font-size:11px;margin-top:8px">CIERRE DE CAJA DIARIO</div>
<div style="text-align:center;font-size:8px;color:#555;margin-top:4px">Reporte Z</div>
<hr class="rule">
<div style="font-size:8px;color:#333;margin-bottom:6px;line-height:1.4">
  <div><strong>Desde:</strong> ${fechaDesde}</div>
  <div><strong>Hasta:</strong> ${fechaHasta}</div>
  <div><strong>Impreso:</strong> ${fechaImpresion}</div>
</div>
<hr class="rule">
<div style="font-size:9px;font-weight:bold;margin-bottom:4px">RESUMEN DE CAJA:</div>
<div style="display:flex;justify-content:space-between;margin:3px 0">
  <span>Tickets Cobrados:</span>
  <span>${resumenDia.ticketsCount}</span>
</div>
<div style="display:flex;justify-content:space-between;margin:3px 0">
  <span>Ventas en Efectivo:</span>
  <span>${fmtEu(resumenDia.efectivo)}</span>
</div>
<div style="display:flex;justify-content:space-between;margin:3px 0">
  <span>Ventas en Tarjeta:</span>
  <span>${fmtEu(resumenDia.tarjeta)}</span>
</div>
<div style="display:flex;justify-content:space-between;margin:3px 0">
  <span>Ticket Medio:</span>
  <span>${fmtEu(resumenDia.ticketMedio)}</span>
</div>
<div class="total">
  <span>TOTAL GENERAL</span>
  <span>${fmtEu(resumenDia.total)}</span>
</div>
<hr class="rule">
<div style="font-size:9px;font-weight:bold;margin-top:8px;margin-bottom:4px">ARTÍCULOS VENDIDOS:</div>
${linesHtml || '<div style="text-align:center;font-size:8px;color:#666">Sin artículos vendidos</div>'}
<hr class="rule">
<div style="text-align:center;font-size:8px;color:#666;margin-top:10px">Fin de Cierre de Caja</div>
<script>
document.getElementById('btn-servicio')?.addEventListener('click', () => {
  window.__sendToService?.();
});
<\/script>
</body></html>`;
}
