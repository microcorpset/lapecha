// ── PROTECCIÓN DE DOMINIO ─────────────────────────────────────────────────────
const _dominiosPermitidos = [
  'microcorpset.github.io',
  'localhost',
  '127.0.0.1'
];
if (!_dominiosPermitidos.some(d => location.hostname === d || location.hostname.endsWith('.' + d))) {
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:monospace;color:#888">Acceso no autorizado</div>';
  throw new Error('Dominio no autorizado');
}
// ─────────────────────────────────────────────────────────────────────────────

import { authReady, db } from './firebase.js';
import {
  ref, onValue, get, query, limitToLast, orderByChild, startAt, endAt,
  set as fbSet, push as fbPush, remove as fbRemove, update as fbUpdate
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const checkAndTouchMenu = (refVal) => {
  if (!refVal) return;
  const url = refVal.toString();
  if (url.includes('/carta') || url.includes('/categorias')) {
    fbSet(ref(db, 'config/menu_version'), Date.now()).catch(err => console.error(err));
  }
};

const set = async (refVal, data) => {
  const res = await fbSet(refVal, data);
  checkAndTouchMenu(refVal);
  return res;
};

const push = async (refVal, data) => {
  const res = await fbPush(refVal, data);
  checkAndTouchMenu(refVal);
  return res;
};

const remove = async (refVal) => {
  const res = await fbRemove(refVal);
  checkAndTouchMenu(refVal);
  return res;
};

const update = async (refVal, data) => {
  const res = await fbUpdate(refVal, data);
  if (data && typeof data === 'object') {
    const keys = Object.keys(data);
    if (keys.some(k => k.startsWith('carta') || k.startsWith('categorias'))) {
      fbSet(ref(db, 'config/menu_version'), Date.now()).catch(err => console.error(err));
    }
  }
  checkAndTouchMenu(refVal);
  return res;
};
import {
  listarFacturas, consultarEstado, actualizarEstadoFactura,
  emitirRectificativa, guardarFacturaEmitida,
  fmtFechaVf, siguienteNumero, verNumeroActual,
  labelTipoFactura, labelEstado, buildLineasVf
} from './verifacti.js';

await authReady;

// ─── CONTRASEÑA ──────────────────────────────────────────────────────────────
const ADMIN_PWD_DEFAULT = 'admin1234';
const ADMIN_PWD_PATH = 'config/admin/password';
const PRINT_SERVICE_ID = 'local-print-service-1';

window.checkLogin = async () => {
  const pwd = document.getElementById('pwd-input').value;
  const snap = await get(ref(db, ADMIN_PWD_PATH));
  const stored = snap.val() || ADMIN_PWD_DEFAULT;
  if (pwd === stored) {
    document.getElementById('login-error').style.display = 'none';
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    init();
  } else {
    document.getElementById('login-error').style.display = 'block';
  }
};

document.getElementById('pwd-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') window.checkLogin();
});

window.changePwd = async () => {
  const v = document.getElementById('new-pwd').value.trim();
  if (!v) return;
  await set(ref(db, ADMIN_PWD_PATH), v);
  document.getElementById('new-pwd').value = '';
  toast('Contraseña actualizada');
};

// ─── TABS ────────────────────────────────────────────────────────────────────
window.showTab = (name, btn) => {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('sec-' + name).classList.add('active');
  btn.classList.add('active');
};

// ─── TOAST ───────────────────────────────────────────────────────────────────
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ─── MÓDULO: DATOS GLOBALES ───────────────────────────────────────────────────
let mesasData     = {};
let planoCfgAdmin = { cols: 16, rows: 12 };
let cartaData     = {};
let categoriasData = {};
let openCatVarsPanels = new Set();
let openEditPanels = new Set();
let collapsedCategories = new Set();
let editingArticuloId = null;
let editingCatId = null;
let pedidosData = {};
let alertasConfig = { verde: 10, amarillo: 20 };
let planoZonaActiva = null;
let configLocalAdmin = {};

let ventasData    = [];        // para CSV y dashboard por artículo
let ventasTabActiva = 'tickets';
let historialVentasCache = [];
let historialVentasCargado = false;
let turnoActualCache = {};
let unsubscribeTurnSales = null;

function confirmDialog({ title, body, confirmLabel = 'Aceptar', cancelLabel = 'Cancelar', danger = false }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:450;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.55);backdrop-filter:blur(4px)';
    const card = document.createElement('div');
    card.style.cssText = 'width:min(520px,100%);background:var(--surface,#161616);border:1px solid var(--border,#2a2a2a);border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.35);padding:18px;display:flex;flex-direction:column;gap:14px';
    card.innerHTML = `
      <div style="font-family:var(--mono);font-size:18px;color:var(--text)">${title}</div>
      <div style="font-size:14px;line-height:1.45;color:var(--muted-strong,var(--muted))">${body}</div>
      <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap">
        <button type="button" data-act="cancel" class="btn" style="min-width:110px">${cancelLabel}</button>
        <button type="button" data-act="ok" class="btn ${danger ? 'btn-danger' : 'btn-success'}" style="min-width:150px">${confirmLabel}</button>
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

const ALERGENOS_EU = [
  'Gluten','Crustáceos','Huevo','Pescado','Cacahuetes','Soja','Lácteos',
  'Frutos de cáscara','Apio','Mostaza','Sésamo','Dióxido de azufre','Altramuces','Moluscos'
];

function fmtEu(n) {
  return Number(n || 0).toFixed(2).replace('.', ',') + ' €';
}

function escCsv(v) {
  return '"' + String(v ?? '').replace(/"/g, '""') + '"';
}

function fechaKeyLocal(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fechaLabelDesdeKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
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

// ─── MESAS ───────────────────────────────────────────────────────────────────
// ─── PLANO VISUAL DE MESAS ───────────────────────────────────────────────────
function normalizarEtiquetaZona(zona) {
  const txt = String(zona ?? '').trim();
  if (!txt) return 'Sin zona';
  const mapa = {
    'SALÃ“N': 'SALÓN',
    'SalÃ³n': 'Salón',
    'salÃ³n': 'salón'
  };
  return mapa[txt] || txt;
}

function qtyResumenMesa(linea) {
  if (linea.estado === 'cancelado') return 0;
  if (linea.qtyTicket !== undefined && linea.qtyTicket !== null) return Number(linea.qtyTicket || 0);
  if (linea.estado === 'servido') return Number(linea.qty || 0);
  if (linea.qtyServida !== undefined && linea.qtyServida !== null && Number(linea.qtyServida) > 0) {
    return Number(linea.qtyServida || 0);
  }
  return Number(linea.qty || 0);
}

function resumenMesaActual(id) {
  const pedidosMesa = pedidosData[id];
  if (!pedidosMesa) return 'Sin consumo';
  const lineas = aplanarPedidos(pedidosMesa).filter(l => l.estado !== 'cancelado' && l.destino !== 'descuento');
  const uds   = lineas.reduce((s, l) => s + qtyResumenMesa(l), 0);
  const total = lineas.reduce((s, l) => s + Number(l.precio || 0) * qtyResumenMesa(l), 0);
  if (!uds) return 'Sin consumo';
  return `<strong>${uds} uds</strong> | <strong>${fmtEu(total)}</strong>`;
}

function aplanarPedidos(pedidos) {
  const lineas = [];
  Object.entries(pedidos).forEach(([envioId, envio]) => {
    if (envioId.startsWith('_')) return;
    const ls = envio.lineas || { [envioId]: envio };
    const envioTs = envio.ts || null;
    const envioCamarero = envio.camarero || null;
    Object.entries(ls).forEach(([keyInDb, l]) => {
      const artId = l.artId || keyInDb;
      const baseId = artId.split('__')[0];
      const nombre = l.nombre || (cartaData[baseId]?.nombre) || 'Artículo';
      const precio = l.precio !== undefined ? l.precio : (cartaData[baseId]?.precio || 0);
      const destino = l.destino || (cartaData[baseId]?.destino || 'barra');
      lineas.push({ ...l, envioId, dbKey: keyInDb, artId, nombre, precio, destino, envioTs, envioCamarero });
    });
  });
  return lineas;
}

function calcularInfoMesa(id, m) {
  const ocupada = m.estado === 'ocupada';
  const empty = { clase: 'libre', alertaHTML: '', iconHTML: '', tiempoHTML: '', tiempoPendHTML: '', resumen: '', totalHTML: '' };
  if (!ocupada) return empty;

  const data = pedidosData[id];
  if (!data) return { ...empty, clase: 'ocupada' };

  const lineasResumen = aplanarPedidos(data).filter(l => l.estado !== 'cancelado' && l.destino !== 'descuento');
  const totalVal = lineasResumen.reduce((s, l) => s + Number(l.precio || 0) * qtyResumenMesa(l), 0);
  const totalHTML = lineasResumen.length
    ? `<span class="plano-mesa-resumen">${fmtEu(totalVal)}</span>` : '';

  const resumen = resumenMesaActual(id);

  let minTs = Infinity;
  let lineasPend = [];
  Object.values(data).forEach(envio => {
    const envioTs = Number(envio.ts) || 0;
    if (envioTs > 0 && envioTs < minTs) minTs = envioTs;
    const ls = envio.lineas || { _: envio };
    Object.values(ls).forEach(l => {
      if (l.estado === 'pendiente')
        lineasPend.push({ destino: l.destino, _tsMesa: Number(l.ts) || envioTs });
    });
  });

  const minsOcupada = minTs < Infinity ? Math.max(0, Math.floor((Date.now() - minTs) / 60000)) : 0;
  const horas    = Math.floor(minsOcupada / 60);
  const minResto = minsOcupada % 60;
  const tiempoHTML = minsOcupada > 0
    ? `<span class="plano-mesa-tiempo">${horas > 0 ? horas + 'h ' : ''}${minResto}m</span>` : '';

  if (!lineasPend.length)
    return { clase: 'ocupada', alertaHTML: '', iconHTML: '', tiempoHTML, tiempoPendHTML: '', resumen, totalHTML };

  const masAntigua  = lineasPend.reduce((min, l) => l._tsMesa < min._tsMesa ? l : min, lineasPend[0]);
  const minsPend    = Math.max(0, Math.floor((Date.now() - (masAntigua._tsMesa || Date.now())) / 60000));
  const minsPendTxt = minsPend === 0 ? '<1m' : `${minsPend}m`;

  const destinos = [...new Set(lineasPend.map(l => l.destino))];
  const iconoDestino = destinos.includes('ambos')
    ? '&#127866;&#127869;'
    : destinos.map(d => d === 'cocina' ? '&#127869;' : '&#127866;').join('');

  const pendTxt    = lineasPend.length === 1 ? '1 pend' : `${lineasPend.length} pend`;
  const alertaHTML = `<span class="plano-mesa-alerta">${iconoDestino} ${pendTxt} · ${minsPendTxt}</span>`;
  const iconHTML   = `<span class="plano-mesa-alerta" style="font-size:13px;line-height:1">${iconoDestino}</span>`;
  const tiempoPendHTML = `<span class="plano-mesa-tiempo">${minsPendTxt}</span>`;

  let clase = 'alerta-ok';
  if      (minsPend >= alertasConfig.amarillo) clase = 'alerta-danger';
  else if (minsPend >= alertasConfig.verde)    clase = 'alerta-warn';

  return { clase, alertaHTML, iconHTML, tiempoHTML, tiempoPendHTML, resumen, totalHTML };
}

function renderPlano() {
  const contenedor = document.getElementById('plano-contenedor');
  if (!contenedor) return;

  const entries = Object.entries(mesasData)
    .filter(([id]) => !id.startsWith('temp_'))
    .sort(([,a],[,b]) => (a.orden??999)-(b.orden??999) || a.nombre.localeCompare(b.nombre,'es',{numeric:true}));

  if (!entries.length) {
    contenedor.innerHTML = '<div class="loading">Sin mesas.</div>';
    return;
  }

  const hayZonas = entries.some(([,m]) => m.zona && m.zona.trim());
  const zonas = hayZonas
    ? [...new Set(entries.map(([,m]) => normalizarEtiquetaZona(m.zona)))]
    : null;

  if (hayZonas && (!planoZonaActiva || !zonas.includes(planoZonaActiva))) {
    planoZonaActiva = zonas[0];
  }

  const mesasFiltradas = hayZonas
    ? entries.filter(([,m]) => normalizarEtiquetaZona(m.zona) === planoZonaActiva)
    : entries;

  const cols = planoCfgAdmin.cols || 16;
  const rows = planoCfgAdmin.rows || 12;
  const ubicadas  = mesasFiltradas.filter(([,m]) => m.plano);
  const sinUbicar = mesasFiltradas.filter(([,m]) => !m.plano && !m.nombre.startsWith('#'));

  const tabsHTML = hayZonas
    ? zonas.map(z => `<button class="plano-tab${z === planoZonaActiva ? ' active' : ''}" onclick="seleccionarZonaPlano('${z.replace(/'/g,"\\'")}')">${z}</button>`).join('')
    : '';

  const tabsEl = document.getElementById('plano-zona-tabs');
  if (tabsEl) {
    tabsEl.style.display = hayZonas ? 'flex' : 'none';
    tabsEl.innerHTML = tabsHTML;
  }

  const mesasHTML = ubicadas.map(([id, m]) => {
    const p = m.plano;
    const circle    = p.shape === 'circle' ? ' circle' : '';
    const isDeco    = m.nombre.startsWith('#');
    const shortCard = p.h === 1 ? ' short' : '';

    if (isDeco) {
      const displayNombre = m.nombre.slice(1);
      return `<div class="plano-mesa decorador${circle}${shortCard}"
        style="grid-column:${p.x}/span ${p.w};grid-row:${p.y}/span ${p.h}">
        <span class="plano-mesa-nombre">${displayNombre}</span>
      </div>`;
    }

    const { clase, alertaHTML, iconHTML, tiempoHTML, tiempoPendHTML, resumen, totalHTML } = calcularInfoMesa(id, m);

    const topHTML  = tiempoHTML;
    const mainHTML = totalHTML;
    const resumenHTML = resumen && resumen !== 'Sin consumo'
      ? `<span class="plano-mesa-resumen">${resumen}</span>` : '';
    const extraHTML = resumenHTML + alertaHTML;

    return `<div class="plano-mesa ${clase}${circle}${shortCard}"
      style="grid-column:${p.x}/span ${p.w};grid-row:${p.y}/span ${p.h}">
      <span class="plano-mesa-tiempo">${topHTML}</span>
      <span class="plano-mesa-nombre">${m.nombre}</span>
      <span class="plano-mesa-extra">${extraHTML}</span>
    </div>`;
  }).join('');

  const sinUbicarHTML = sinUbicar.length
    ? `<div class="plano-sinubicar" style="margin-top:12px; font-size:12px; color:var(--muted)">Sin ubicar: ${sinUbicar.map(([,m]) => m.nombre).join(', ')}</div>`
    : '';

  contenedor.innerHTML = `<div class="plano-wrap"><div class="plano-grid" style="--plano-cols:${cols};--plano-rows:${rows}">${mesasHTML}</div></div>` + sinUbicarHTML;
}

window.seleccionarZonaPlano = (zona) => {
  planoZonaActiva = zona;
  renderPlano();
};


// ─── CARTA ───────────────────────────────────────────────────────────────────
let destino = 'barra';

window.setDest = d => {
  destino = d;
  document.querySelectorAll('.dest-btn').forEach(b => {
    b.className = 'dest-btn';
    if (b.id === 'db-' + d) b.classList.add('active-' + d);
  });
};

window.addCategoria = async () => {
  const nombre = document.getElementById('cat-nombre').value.trim();
  if (!nombre) return;
  const maxOrden = Object.values(categoriasData).reduce((max, c) => Math.max(max, c.orden || 0), 0);
  await push(ref(db, 'categorias'), { nombre, orden: maxOrden + 1 });
  document.getElementById('cat-nombre').value = '';
  toast('Categoría añadida');
};

window.addArticulo = async () => {
  const nombre = document.getElementById('art-nombre').value.trim();
  const precio = parseFloat(document.getElementById('art-precio').value);
  const catId  = document.getElementById('art-cat').value;
  if (!nombre || isNaN(precio) || !catId) { toast('Rellena todos los campos'); return; }
  await push(ref(db, 'carta'), { nombre, precio, destino, catId, disponible: true });
  document.getElementById('art-nombre').value = '';
  document.getElementById('art-precio').value = '';
  toast('Artículo añadido');
};

window.delArticulo = async id => {
  await remove(ref(db, 'carta/' + id));
  toast('Artículo eliminado');
};

window.toggleDestino = async (id, actual) => {
  const orden = ['barra','cocina','ambos'];
  const next = orden[(orden.indexOf(actual) + 1) % 3];
  await set(ref(db, 'carta/' + id + '/destino'), next);
};

window.toggleDisponible = async (id, disponibleActual) => {
  const nuevo = !disponibleActual;
  await set(ref(db, 'carta/' + id + '/disponible'), nuevo);
  toast(nuevo ? 'Artículo disponible' : 'Artículo marcado como agotado');
};

function renderCarta() {
  const lista = document.getElementById('carta-lista');
  if (!lista) return;
  if (!Object.keys(categoriasData).length) {
    lista.innerHTML = '<p style="color:var(--muted);font-size:13px">Sin categorías aún</p>';
    return;
  }
  lista.innerHTML = '';
  
  Object.entries(categoriasData)
    .sort(([,a],[,b]) => (a.orden ?? 999) - (b.orden ?? 999) || a.nombre.localeCompare(b.nombre, 'es'))
    .forEach(([catId, cat], idx, arr) => {
      const arts = Object.entries(cartaData)
        .filter(([,a]) => a.catId === catId)
        .sort(([,a],[,b]) => (a.orden||0) - (b.orden||0) || a.nombre.localeCompare(b.nombre,'es'));

      const isCollapsed = collapsedCategories.has(catId);
      const catEl = document.createElement('div');
      catEl.className = 'categoria-wrapper';
      catEl.style.marginBottom = '16px';
      catEl.style.border = '1px solid var(--border)';
      catEl.style.borderRadius = '12px';
      catEl.style.background = 'var(--surface)';
      catEl.style.overflow = 'hidden';

      catEl.innerHTML = `
        <div class="categoria-header" onclick="toggleCollapseCategoria('${catId}')" style="display:flex;justify-content:space-between;align-items:center;background:var(--surface2);padding:10px 14px;border-bottom:${isCollapsed?'none':'1px solid var(--border)'};cursor:pointer;user-select:none">
          <div style="display:flex;align-items:center;gap:6px">
            <span class="cat-toggle-arrow ${isCollapsed ? 'collapsed' : ''}" style="color:var(--accent);font-size:10px;transition:transform 0.2s;display:inline-block;transform:${isCollapsed?'rotate(-90deg)':'none'}">▼</span>
            <span style="font-weight:600;font-size:14px">${cat.nombre}</span>
            <span style="font-size:11px;color:var(--muted);margin-left:4px">(${arts.length} art.)</span>
          </div>
          <div style="display:flex;gap:4px;align-items:center" onclick="event.stopPropagation()">
            <button class="btn btn-sm" title="Mover categoría arriba"
              onclick="moverCat('${catId}',${idx},-1)" ${idx===0?'disabled':''}>↑</button>
            <button class="btn btn-sm" title="Mover categoría abajo"
              onclick="moverCat('${catId}',${idx},1)" ${idx===arr.length-1?'disabled':''}>↓</button>
            <button class="btn btn-sm ${editingCatId === catId ? 'btn-success' : ''}" title="Editar variantes compartidas"
              onclick="toggleCatVariantes('${catId}')">✏ var</button>
            <button class="btn btn-sm btn-danger" onclick="delCat('${catId}')">×</button>
          </div>
        </div>
      `;

      const articlesContainer = document.createElement('div');
      articlesContainer.className = `categoria-articles ${isCollapsed ? 'collapsed' : ''}`;
      articlesContainer.style.display = isCollapsed ? 'none' : 'block';

      arts.forEach(([id, a], idx) => {
        const disponible = a.disponible !== false;
        const row = document.createElement('div');
        row.className = 'row-item';
        row.id = 'art-row-' + id;
        row.style.borderBottom = idx === arts.length - 1 ? 'none' : '1px solid var(--border)';
        row.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0">
            <span class="row-label" id="art-label-${id}" style="${disponible?'':'opacity:.45;text-decoration:line-through'}">${a.nombre}</span>
            <span class="row-sub">${Number(a.precio).toFixed(2)} €${a.variantes?.length ? ` · ${a.variantes.length} variante${a.variantes.length>1?'s':''}` : ''}${a.alergenos?.length ? ` · ${a.alergenos.length} alérg.` : ''}</span>
          </div>
          <button class="btn btn-sm ${disponible ? 'btn-success' : 'btn-danger'}" style="flex-shrink:0;font-size:11px"
            onclick="toggleDisponible('${id}',${disponible})">${disponible ? '✓ Disp.' : '✗ Agotado'}</button>
          <span class="badge-dest bd-${a.destino}" style="cursor:pointer;flex-shrink:0"
            onclick="toggleDestino('${id}','${a.destino}')" id="art-dest-${id}">${a.destino}</span>
          <div style="display:flex;gap:4px;flex-shrink:0">
            <button class="btn btn-sm" title="Mover arriba"
              onclick="moverArt('${id}','${catId}',${idx},-1)" ${idx===0?'disabled':''}>↑</button>
            <button class="btn btn-sm" title="Mover abajo"
              onclick="moverArt('${id}','${catId}',${idx},1)" ${idx===arts.length-1?'disabled':''}>↓</button>
            <button class="btn btn-sm ${editingArticuloId === id ? 'btn-success' : ''}" onclick="editarArticulo('${id}')">✏</button>
            <button class="btn btn-sm btn-danger" onclick="delArticulo('${id}')">×</button>
          </div>`;
        articlesContainer.appendChild(row);
      });

      if (arts.length === 0) {
        const row = document.createElement('div');
        row.style.padding = '12px';
        row.style.fontSize = '13px';
        row.style.color = 'var(--muted)';
        row.textContent = 'Sin artículos en esta categoría';
        articlesContainer.appendChild(row);
      }

      catEl.appendChild(articlesContainer);
      lista.appendChild(catEl);
    });

  if (editingCatId) {
    updateCatVariantsList(editingCatId);
  }
  if (editingArticuloId) {
    updateEditVariantsList(editingArticuloId);
    if (window.updateEditComboGroupsList) {
      window.updateEditComboGroupsList(editingArticuloId);
    }
  }
}

window.toggleCollapseCategoria = (catId) => {
  if (collapsedCategories.has(catId)) {
    collapsedCategories.delete(catId);
  } else {
    collapsedCategories.add(catId);
  }
  renderCarta();
};

window.editarArticulo = id => {
  editingArticuloId = id;
  editingCatId = null;
  const catVarContainer = document.getElementById('cat-variantes-sidebar-container');
  if (catVarContainer) catVarContainer.innerHTML = '';
  
  renderSidebarEditForm(id);
  renderCarta();
};

window.cancelarEdicion = id => {
  editingArticuloId = null;
  renderSidebarNuevoForm();
  renderCarta();
};

window.toggleCatVariantes = id => {
  if (editingCatId === id) {
    editingCatId = null;
    const container = document.getElementById('cat-variantes-sidebar-container');
    if (container) container.innerHTML = '';
    renderCarta();
  } else {
    editingCatId = id;
    renderSidebarCatVariantesForm(id);
    renderCarta();
  }
};

window.agregarCatVariante = async (catId) => {
  const nombre = document.getElementById('cat-var-nombre-' + catId)?.value.trim();
  const precio = parseFloat(document.getElementById('cat-var-precio-' + catId)?.value);
  if (!nombre || isNaN(precio)) { toast('Rellena nombre y precio de la variante'); return; }
  const variantesActuales = categoriasData[catId]?.variantes || [];
  const nuevas = [...variantesActuales, { nombre, precio }];
  await set(ref(db, 'categorias/' + catId + '/variantes'), nuevas);
  
  const inpNom = document.getElementById('cat-var-nombre-' + catId);
  const inpPre = document.getElementById('cat-var-precio-' + catId);
  if (inpNom) inpNom.value = '';
  if (inpPre) inpPre.value = '';
  
  toast('Variante compartida añadida');
};

window.eliminarCatVariante = async (catId, idx) => {
  const variantesActuales = categoriasData[catId]?.variantes || [];
  const nuevas = variantesActuales.filter((_, i) => i !== idx);
  await set(ref(db, 'categorias/' + catId + '/variantes'), nuevas.length ? nuevas : null);
  toast('Variante compartida eliminada');
};

window.guardarArticulo = async id => {
  const nombre = document.getElementById('edit-nombre-' + id)?.value.trim();
  const precio = parseFloat(document.getElementById('edit-precio-' + id)?.value);
  const catId  = document.getElementById('edit-cat-' + id)?.value;
  if (!nombre || isNaN(precio) || !catId) { toast('Rellena todos los campos'); return; }

  // Recoger alérgenos seleccionados
  const checks = document.querySelectorAll(`#alerg-checks-${id} input[type="checkbox"]`);
  const alergenos = Array.from(checks).filter(c => c.checked).map(c => c.dataset.alerg);

  // Variantes actuales (se gestionan por agregarVariante/eliminarVariante en tiempo real)
  const variantesActuales = cartaData[id]?.variantes || [];

  // Combo
  const esCombo = document.getElementById('edit-escombo-' + id)?.checked || false;
  const comboGroups = cartaData[id]?.comboGroups || [];

  await set(ref(db, 'carta/' + id), {
    ...cartaData[id], nombre, precio, catId, alergenos,
    variantes: variantesActuales,
    esCombo,
    comboGroups: esCombo ? comboGroups : null,
    disponible: cartaData[id]?.disponible !== false
  });
  
  editingArticuloId = null;
  renderSidebarNuevoForm();
  toast('Artículo actualizado');
};

function getComboGroups(id) {
  const raw = cartaData[id]?.comboGroups;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  return arr.map(g => {
    if (!g) return null;
    const itemsRaw = g.items;
    const itemsArr = itemsRaw ? (Array.isArray(itemsRaw) ? itemsRaw : Object.values(itemsRaw)) : [];
    return {
      nombre: g.nombre || '',
      items: itemsArr.filter(Boolean).map(item => ({
        artId: item.artId || '',
        suplemento: parseFloat(item.suplemento) || 0
      }))
    };
  }).filter(Boolean);
}

window.toggleComboPanel = async (id) => {
  const chk = document.getElementById('edit-escombo-' + id);
  const panel = document.getElementById('combo-panel-' + id);
  if (chk && panel) {
    const esCombo = chk.checked;
    panel.style.display = esCombo ? 'flex' : 'none';
    await set(ref(db, 'carta/' + id + '/esCombo'), esCombo);
  }
};

window.agregarGrupoCombo = async (id) => {
  const nombre = prompt("Nombre del grupo (ej: Bebida, Pan, Comida):");
  if (!nombre) return;
  const groups = getComboGroups(id);
  groups.push({ nombre: nombre.trim(), items: [] });
  await set(ref(db, 'carta/' + id + '/comboGroups'), groups);
  toast('Grupo añadido');
};

window.eliminarGrupoCombo = async (id, groupIdx) => {
  if (!confirm('¿Eliminar este grupo y sus opciones?')) return;
  const groups = getComboGroups(id).filter((_, idx) => idx !== groupIdx);
  await set(ref(db, 'carta/' + id + '/comboGroups'), groups.length ? groups : null);
  toast('Grupo eliminado');
};

window.agregarOpcionCombo = async (id, groupIdx) => {
  const selectEl = document.getElementById(`combo-art-select-${id}-${groupIdx}`);
  const suplEl = document.getElementById(`combo-supl-input-${id}-${groupIdx}`);
  if (!selectEl || !suplEl) return;
  const artId = selectEl.value;
  const suplemento = parseFloat(suplEl.value) || 0;
  if (!artId) { toast('Elige un artículo'); return; }
  
  const groups = getComboGroups(id);
  if (!groups[groupIdx]) return;
  groups[groupIdx].items.push({ artId, suplemento });
  
  await set(ref(db, 'carta/' + id + '/comboGroups'), groups);
  toast('Opción añadida');
};

window.eliminarOpcionCombo = async (id, groupIdx, itemIdx) => {
  const groups = getComboGroups(id);
  if (!groups[groupIdx]) return;
  groups[groupIdx].items = groups[groupIdx].items.filter((_, idx) => idx !== itemIdx);
  await set(ref(db, 'carta/' + id + '/comboGroups'), groups.length ? groups : null);
  toast('Opción eliminada');
};

window.updateEditComboGroupsList = (id) => {
  const el = document.getElementById(`combo-groups-lista-${id}`);
  if (!el) return;
  const comboGroups = getComboGroups(id);
  
  const otherArticlesHTML = Object.entries(categoriasData)
    .sort(([, ca], [, cb]) => (ca.orden ?? 999) - (cb.orden ?? 999) || ca.nombre.localeCompare(cb.nombre, 'es'))
    .map(([catId, cat]) => {
      const catArts = Object.entries(cartaData)
        .filter(([aid, art]) => art.catId === catId && aid !== id)
        .sort(([, artA], [, artB]) => (artA.orden || 0) - (artB.orden || 0) || artA.nombre.localeCompare(artB.nombre, 'es'));
      if (!catArts.length) return '';
      return `<optgroup label="${cat.nombre}">
        ${catArts.map(([aid, art]) => `<option value="${aid}">${art.nombre} (${Number(art.precio).toFixed(2)} €)</option>`).join('')}
      </optgroup>`;
    }).join('');

  el.innerHTML = comboGroups.map((g, gIdx) => `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);padding-bottom:4px">
        <span style="font-weight:bold;font-size:12px;color:var(--accent)">Grupo: ${g.nombre}</span>
        <button class="btn btn-sm btn-danger" onclick="eliminarGrupoCombo('${id}', ${gIdx})" style="padding:2px 6px;font-size:10px">Eliminar Grupo</button>
      </div>
      <div id="combo-items-lista-${id}-${gIdx}" style="display:flex;flex-direction:column;gap:4px">
        ${(g.items || []).map((item, itemIdx) => {
          const subArt = cartaData[item.artId];
          const subArtNombre = subArt ? subArt.nombre : '[Artículo Eliminado]';
          return `
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:2px 0">
              <span>${subArtNombre} ${item.suplemento > 0 ? `<b style="color:var(--accent)">+${Number(item.suplemento).toFixed(2)} €</b>` : '<span style="color:var(--muted)">Sin supl.</span>'}</span>
              <button class="btn btn-sm btn-danger" onclick="eliminarOpcionCombo('${id}', ${gIdx}, ${itemIdx})" style="padding:0px 4px;font-size:10px">×</button>
            </div>
          `;
        }).join('')}
      </div>
      <div style="display:flex;gap:4px;margin-top:4px;align-items:center">
        <select id="combo-art-select-${id}-${gIdx}" style="flex:1;font-size:11px;padding:4px">
          <option value="">— Seleccionar artículo —</option>
          ${otherArticlesHTML}
        </select>
        <input type="number" id="combo-supl-input-${id}-${gIdx}" placeholder="Supl. €" step="0.05" min="0" style="width:70px;font-size:11px;padding:4px" />
        <button class="btn btn-sm btn-success" onclick="agregarOpcionCombo('${id}', ${gIdx})" style="padding:4px 8px;font-size:11px">+ Añadir</button>
      </div>
    </div>
  `).join('');
};

window.agregarVariante = async (artId) => {
  const nombre = document.getElementById('var-nombre-' + artId)?.value.trim();
  const precio = parseFloat(document.getElementById('var-precio-' + artId)?.value);
  if (!nombre || isNaN(precio)) { toast('Rellena nombre y precio de la variante'); return; }
  const variantesActuales = cartaData[artId]?.variantes || [];
  const nuevas = [...variantesActuales, { nombre, precio }];
  await set(ref(db, 'carta/' + artId + '/variantes'), nuevas);
  
  const inpNom = document.getElementById('var-nombre-' + artId);
  const inpPre = document.getElementById('var-precio-' + artId);
  if (inpNom) inpNom.value = '';
  if (inpPre) inpPre.value = '';
  
  toast('Variante añadida');
};

window.eliminarVariante = async (artId, idx) => {
  const variantesActuales = cartaData[artId]?.variantes || [];
  const nuevas = variantesActuales.filter((_, i) => i !== idx);
  await set(ref(db, 'carta/' + artId + '/variantes'), nuevas.length ? nuevas : null);
  toast('Variante eliminada');
};

window.moverArt = async (id, catId, idx, dir) => {
  const arts = Object.entries(cartaData)
    .filter(([,a]) => a.catId === catId)
    .sort(([,a],[,b]) => (a.orden||0) - (b.orden||0) || a.nombre.localeCompare(b.nombre,'es'));
  const idxDest = idx + dir;
  if (idxDest < 0 || idxDest >= arts.length) return;
  const updates = {};
  arts.forEach(([aid], i) => { updates['carta/' + aid + '/orden'] = i; });
  updates['carta/' + arts[idx][0] + '/orden'] = idxDest;
  updates['carta/' + arts[idxDest][0] + '/orden'] = idx;
  await update(ref(db), updates);
};

window.moverCat = async (id, idx, dir) => {
  const cats = Object.entries(categoriasData)
    .sort(([,a],[,b]) => (a.orden ?? 999) - (b.orden ?? 999) || a.nombre.localeCompare(b.nombre, 'es'));
  const idxDest = idx + dir;
  if (idxDest < 0 || idxDest >= cats.length) return;
  const updates = {};
  cats.forEach(([cid], i) => { updates['categorias/' + cid + '/orden'] = i; });
  updates['categorias/' + cats[idx][0] + '/orden'] = idxDest;
  updates['categorias/' + cats[idxDest][0] + '/orden'] = idx;
  await update(ref(db), updates);
};

window.delCat = async id => {
  if (!confirm('¿Eliminar categoría y sus artículos?')) return;
  const snaps = await get(ref(db, 'carta'));
  const arts = snaps.val() || {};
  const dels = Object.entries(arts).filter(([,a]) => a.catId === id).map(([aid]) =>
    remove(ref(db, 'carta/' + aid)));
  await Promise.all([...dels, remove(ref(db, 'categorias/' + id))]);
  toast('Categoría eliminada');
};

function updateCatSelect() {
  const sel = document.getElementById('art-cat');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Categoría —</option>';
  Object.entries(categoriasData)
    .sort(([,a],[,b]) => (a.orden ?? 999) - (b.orden ?? 999) || a.nombre.localeCompare(b.nombre, 'es'))
    .forEach(([id, c]) => {
      sel.innerHTML += `<option value="${id}">${c.nombre}</option>`;
    });
}

function renderSidebarEditForm(id) {
  const container = document.getElementById('articulo-form-container');
  if (!container) return;
  const a = cartaData[id];
  if (!a) {
    editingArticuloId = null;
    renderSidebarNuevoForm();
    return;
  }
  const alergenosActuales = a.alergenos || [];
  container.innerHTML = `
    <div class="card" id="edit-articulo-card">
      <div class="card-header">
        <div>
          <div class="card-kicker">Modificar</div>
          <div class="card-title">Editar artículo</div>
          <p class="card-desc">Modificando "${a.nombre}"</p>
        </div>
      </div>
      <div class="card-body">
        <div class="field-stack" style="margin-bottom:10px">
          <label>Nombre del artículo</label>
          <input type="text" id="edit-nombre-${id}" value="${a.nombre.replace(/"/g,'&quot;')}" placeholder="Nombre" style="width:100%" />
        </div>
        <div class="field-stack" style="margin-bottom:10px">
          <label>Precio €</label>
          <input type="number" id="edit-precio-${id}" value="${Number(a.precio).toFixed(2)}" placeholder="Precio €" step="0.1" min="0" style="width:100%" />
        </div>
        <div class="field-stack" style="margin-bottom:12px">
          <label for="edit-cat-${id}">Categoría</label>
          <select id="edit-cat-${id}" style="width:100%"></select>
        </div>
        
        <div style="margin-top:12px">
          <div style="font-size:11px;color:var(--muted);margin-bottom:6px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em">Alérgenos</div>
          <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:4px" id="alerg-checks-${id}">
            ${ALERGENOS_EU.map(al => `
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;padding:3px 0">
                <input type="checkbox" data-alerg="${al}" ${alergenosActuales.includes(al)?'checked':''} style="width:14px;height:14px" />
                <span>${al}</span>
              </label>`).join('')}
          </div>
        </div>
        
        <div style="margin-top:12px; border-top: 1px solid var(--border); padding-top: 12px">
          <div style="font-size:11px;color:var(--muted);margin-bottom:6px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em">Variantes de precio</div>
          <div id="edit-variantes-lista-${id}"></div>
          <div style="display:flex;gap:8px;margin-top:6px">
            <input type="text" id="var-nombre-${id}" placeholder="Nueva variante" style="flex:2;min-width:100px" />
            <input type="number" id="var-precio-${id}" placeholder="Precio" step="0.1" min="0" style="width:75px;flex:none" />
            <button class="btn btn-sm btn-success" onclick="agregarVariante('${id}')">+ Añadir</button>
          </div>
        </div>

        <!-- Combo (Menús / Desayunos) -->
        <div style="margin-top:12px; border-top: 1px solid var(--border); padding-top: 12px">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;font-weight:bold;margin-bottom:8px">
            <input type="checkbox" id="edit-escombo-${id}" ${a.esCombo === true ? 'checked' : ''} onchange="toggleComboPanel('${id}')" style="width:14px;height:14px" />
            <span>Es un Combo (Menú/Desayuno)</span>
          </label>
          <div id="combo-panel-${id}" style="display:${a.esCombo === true ? 'flex' : 'none'};flex-direction:column;gap:10px;margin-left:8px;padding-left:12px;border-left:2px solid var(--accent)">
            <div id="combo-groups-lista-${id}" style="display:flex;flex-direction:column;gap:8px">
              <!-- Se poblará dinámicamente -->
            </div>
            <button class="btn btn-sm btn-success" style="align-self:flex-start;font-size:11px;margin-top:4px" onclick="agregarGrupoCombo('${id}')">+ Añadir Grupo</button>
          </div>
        </div>
        
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button class="btn btn-sm" onclick="cancelarEdicion('${id}')">Cancelar</button>
          <button class="btn btn-sm btn-success" onclick="guardarArticulo('${id}')">Guardar</button>
        </div>
      </div>
    </div>
  `;
  const sel = document.getElementById('edit-cat-' + id);
  if (sel) {
    sel.innerHTML = Object.entries(categoriasData)
      .sort(([,a],[,b]) => (a.orden ?? 999) - (b.orden ?? 999) || a.nombre.localeCompare(b.nombre, 'es'))
      .map(([cid, c]) => `<option value="${cid}" ${a.catId===cid?'selected':''}>${c.nombre}</option>`)
      .join('');
  }
  updateEditVariantsList(id);
  if (window.updateEditComboGroupsList) {
    window.updateEditComboGroupsList(id);
  }
}

function renderSidebarNuevoForm() {
  const container = document.getElementById('articulo-form-container');
  if (!container) return;
  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-kicker">Alta</div>
          <div class="card-title">Nuevo artículo</div>
          <p class="card-desc">Añade producto, precio, categoría y destino operativo desde un solo bloque.</p>
        </div>
      </div>
      <div class="card-body">
        <div class="form-row">
          <input type="text" id="art-nombre" placeholder="Nombre del artículo" style="flex:2" />
          <input type="number" id="art-precio" placeholder="Precio €" step="0.1" min="0" style="max-width:140px" />
        </div>
        <div class="form-grid">
          <div class="field-stack">
            <label for="art-cat">Categoría</label>
            <select id="art-cat"><option value="">— Categoría —</option></select>
          </div>
          <div class="field-stack">
            <label>Destino</label>
            <div class="destino-btns">
              <button class="dest-btn active-barra" id="db-barra" onclick="setDest('barra')">Barra</button>
              <button class="dest-btn" id="db-cocina" onclick="setDest('cocina')">Cocina</button>
              <button class="dest-btn" id="db-ambos" onclick="setDest('ambos')">Ambos</button>
            </div>
          </div>
        </div>
        <div class="add-row">
          <button class="btn btn-success" onclick="addArticulo()">+ Añadir artículo</button>
        </div>
      </div>
    </div>
  `;
  updateCatSelect();
}

function renderSidebarCatVariantesForm(catId) {
  const container = document.getElementById('cat-variantes-sidebar-container');
  if (!container) return;
  const cat = categoriasData[catId];
  if (!cat) {
    editingCatId = null;
    container.innerHTML = '';
    return;
  }
  container.innerHTML = `
    <div class="card" id="edit-cat-vars-card">
      <div class="card-header">
        <div>
          <div class="card-kicker">Modificar</div>
          <div class="card-title">Variantes de categoría</div>
          <p class="card-desc">Variantes para "${cat.nombre}"</p>
        </div>
      </div>
      <div class="card-body">
        <div id="cat-variantes-lista-${catId}"></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <input type="text" id="cat-var-nombre-${catId}" placeholder="Nueva variante" style="flex:2;min-width:100px" />
          <input type="number" id="cat-var-precio-${catId}" placeholder="Precio" step="0.1" min="0" style="width:75px;flex:none" />
          <button class="btn btn-sm btn-success" onclick="agregarCatVariante('${catId}')">+ Añadir</button>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:12px">
          <button class="btn btn-sm" onclick="toggleCatVariantes('${catId}')">Cerrar</button>
        </div>
      </div>
    </div>
  `;
  updateCatVariantsList(catId);
}

function updateEditVariantsList(id) {
  const el = document.getElementById(`edit-variantes-lista-${id}`);
  if (!el) return;
  const a = cartaData[id];
  const variantesActuales = a?.variantes || [];
  el.innerHTML = variantesActuales.map((v, i) => `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
      <span style="flex:1;font-size:13px">${v.nombre}</span>
      <span style="font-family:var(--mono);font-size:12px;color:var(--muted)">${Number(v.precio).toFixed(2)} €</span>
      <button class="btn btn-sm btn-danger" onclick="eliminarVariante('${id}',${i})">×</button>
    </div>`).join('');
}

function updateCatVariantsList(catId) {
  const el = document.getElementById(`cat-variantes-lista-${catId}`);
  if (!el) return;
  const cat = categoriasData[catId];
  const catVars = cat?.variantes || [];
  el.innerHTML = catVars.map((v, i) => `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
      <span style="flex:1;font-size:13px">${v.nombre}</span>
      <span style="font-family:var(--mono);font-size:12px;color:var(--muted)">${Number(v.precio).toFixed(2)} €</span>
      <button class="btn btn-sm btn-danger" onclick="eliminarCatVariante('${catId}',${i})">×</button>
    </div>`).join('');
}

window.guardarPin = (rol) => {
  const val = document.getElementById('pin-' + rol).value.trim();
  if (!/^\d{4}$/.test(val)) { toast('El PIN debe tener exactamente 4 dígitos'); return; }
  set(ref(db, 'config/pins/' + rol), val);
  toast('PIN de ' + rol + ' actualizado');
};

// ─── VENTAS ──────────────────────────────────────────────────────────────────
function initFiltrosFecha() {
  const hoy = new Date();
  const yyyy = hoy.getFullYear();
  const mm   = String(hoy.getMonth() + 1).padStart(2, '0');
  const dd   = String(hoy.getDate()).padStart(2, '0');
  const local = `${yyyy}-${mm}-${dd}`;
  document.getElementById('filtro-fecha-ini').value = local;
  document.getElementById('filtro-fecha-fin').value = local;
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
  const iso = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return new Date(`${iso}T${horaTxt}:00`).getTime();
}

function normalizarTicketVenta(id, ticket = {}) {
  const base = ticket && typeof ticket === 'object' ? ticket : {};
  const tsNum = Number(base.ts);
  const ts = Number.isFinite(tsNum) && tsNum > 0
    ? tsNum
    : parseFechaHoraTicket(base.fecha, base.hora);
  return { id, ...base, ts };
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
    const key = `${l.nombre || 'Artículo'}||${Number(l.precio || 0).toFixed(2)}||${l.nota || ''}`;
    if (!agrupado[key]) {
      agrupado[key] = {
        nombre: l.nombre || 'Artículo',
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
  let ticketsGenerados = 0;

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
      ticketsGenerados += 1;
    }

    await remove(ref(db, `pedidos/${mesaId}`));
    await set(ref(db, `mesas/${mesaId}/estado`), 'libre');
    mesasCerradas += 1;
  }

  historialVentasCargado = false;
  return { mesasCerradas, ticketsGenerados };
}

async function prepararFiltrosVentasIniciales() {
  initFiltrosFecha();
  document.getElementById('filtro-hora-ini').value = '00:00';
  document.getElementById('filtro-hora-fin').value = '23:59';

  const ultimo = (await cargarHistorialVentas())[0];

  if (!ultimo) return;

  const hoy = new Date();
  const hoyLocal = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
  const ultimoLocal = new Date(ultimo.ts);
  const ultimaFecha = `${ultimoLocal.getFullYear()}-${String(ultimoLocal.getMonth() + 1).padStart(2, '0')}-${String(ultimoLocal.getDate()).padStart(2, '0')}`;

  if (ultimaFecha !== hoyLocal) {
    document.getElementById('filtro-fecha-ini').value = ultimaFecha;
    document.getElementById('filtro-fecha-fin').value = ultimaFecha;
  }
}

window.resetFiltros = () => {
  initFiltrosFecha();
  document.getElementById('filtro-hora-ini').value = '00:00';
  document.getElementById('filtro-hora-fin').value = '23:59';
  aplicarFiltros();
};

window.aplicarFiltros = async () => {
  try {
    const fechaIni  = document.getElementById('filtro-fecha-ini').value;
    const fechaFin  = document.getElementById('filtro-fecha-fin').value;
    const horaIni   = document.getElementById('filtro-hora-ini').value || '00:00';
    const horaFin   = document.getElementById('filtro-hora-fin').value || '23:59';

    if (!fechaIni || !fechaFin) { toast('Selecciona las fechas'); return; }

    const tsIni = new Date(`${fechaIni}T${horaIni}:00`).getTime();
    const tsFin = new Date(`${fechaFin}T${horaFin}:59`).getTime();

    const tickets = (await cargarHistorialVentas(tsIni, tsFin))
      .filter(t => t.ts >= tsIni && t.ts <= tsFin)
      .sort((a, b) => b.ts - a.ts);

    ventasData = tickets;

    const btnCargar = document.getElementById('btn-cargar-mas');
    if (btnCargar) btnCargar.style.display = 'none';

    renderVentas(tickets);
    if (ventasTabActiva === 'articulos') renderVentasPorArticulo(tickets);
    if (ventasTabActiva === 'dias') renderVentasPorDia(tickets);
  } catch (err) {
    console.error('Error al filtrar ventas', err);
    ventasData = [];
    renderVentas([]);
    const listaArt = document.getElementById('ventas-por-articulo');
    if (listaArt) listaArt.innerHTML = '<div class="ventas-empty">No se pudieron cargar las ventas</div>';
    const listaDias = document.getElementById('ventas-por-dia');
    if (listaDias) listaDias.innerHTML = '<div class="ventas-empty">No se pudieron cargar las ventas</div>';
    toast('No se pudieron cargar las ventas');
  }
};

window.cargarMasHistorial = async () => {
  await aplicarFiltros();
};

window.exportarCSV = () => {
  if (!ventasData.length) { toast('Sin datos para exportar'); return; }
  const fechaIni = document.getElementById('filtro-fecha-ini').value;
  const fechaFin = document.getElementById('filtro-fecha-fin').value;
  let csv = '';
  let sufijo = ventasTabActiva;

  if (ventasTabActiva === 'articulos') {
    const mapa = {};
    ventasData.forEach(t => {
      (t.lineas || []).forEach(l => {
        const k = l.nombre;
        if (!mapa[k]) mapa[k] = { nombre: l.nombre, qty: 0, total: 0 };
        mapa[k].qty += Number(l.qty || 0);
        mapa[k].total += Number(l.precio || 0) * Number(l.qty || 0);
      });
    });
    csv = 'Articulo,Unidades,Total\n';
    Object.values(mapa)
      .sort((a, b) => b.qty - a.qty)
      .forEach(a => {
        csv += `${escCsv(a.nombre)},${escCsv(a.qty)},${escCsv(a.total.toFixed(2))}\n`;
      });
  } else if (ventasTabActiva === 'dias') {
    csv = 'Fecha,Tickets,Articulos,Total\n';
    agruparVentasPorDia(ventasData).forEach(d => {
      csv += `${escCsv(fechaLabelDesdeKey(d.fecha))},${escCsv(d.tickets)},${escCsv(d.lineas)},${escCsv(d.total.toFixed(2))}\n`;
    });
  } else {
    sufijo = 'tickets';
    csv = 'Fecha,Hora,Mesa,Camarero,Total,Articulo,Cantidad,Precio unitario\n';
    ventasData.forEach(t => {
      const fecha = new Date(t.ts).toLocaleDateString('es-ES');
      const hora  = new Date(t.ts).toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' });
      (t.lineas || []).forEach(l => {
        csv += `${escCsv(fecha)},${escCsv(hora)},${escCsv(t.mesa)},${escCsv(t.camarero || '')},${escCsv((t.total || 0).toFixed(2))},${escCsv(l.nombre)},${escCsv(l.qty)},${escCsv(Number(l.precio).toFixed(2))}\n`;
      });
    });
  }

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `ventas_${sufijo}_${fechaIni}_${fechaFin}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
};

window.mostrarTabVentas = (tab, btn) => {
  ventasTabActiva = tab;
  document.querySelectorAll('.ventas-tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const divTickets   = document.getElementById('ventas-por-ticket');
  const divArticulos = document.getElementById('ventas-por-articulo');
  const divDias      = document.getElementById('ventas-por-dia');
  if (divTickets)   divTickets.style.display   = tab === 'tickets'   ? '' : 'none';
  if (divArticulos) divArticulos.style.display = tab === 'articulos' ? '' : 'none';
  if (divDias)      divDias.style.display      = tab === 'dias'      ? '' : 'none';
  if (tab === 'articulos') renderVentasPorArticulo(ventasData);
  if (tab === 'dias') renderVentasPorDia(ventasData);
};

function renderVentas(tickets) {
  const lista = document.getElementById('ventas-lista');

  if (!tickets.length) {
    lista.innerHTML = '<div class="ventas-empty">Sin ventas en ese período</div>';
    document.getElementById('stat-mesas').textContent  = '0';
    document.getElementById('stat-total').textContent  = '0,00 €';
    document.getElementById('stat-media').textContent  = '—';
    document.getElementById('stat-lineas').textContent = '0';
    return;
  }

  const totalGeneral = tickets.reduce((s, t) => s + (t.total || 0), 0);
  const totalLineas  = tickets.reduce((s, t) =>
    s + (t.lineas || []).reduce((acc, l) => acc + Number(l.qty || 0), 0), 0);
  const media        = totalGeneral / tickets.length;

  document.getElementById('stat-mesas').textContent  = tickets.length;
  document.getElementById('stat-total').textContent  = totalGeneral.toFixed(2).replace('.', ',') + ' €';
  document.getElementById('stat-media').textContent  = media.toFixed(2).replace('.', ',') + ' €';
  document.getElementById('stat-lineas').textContent = totalLineas;

  lista.innerHTML = '';
  tickets.forEach(t => {
    const hora = new Date(t.ts).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
    const div = document.createElement('div');
    div.className = 'ticket-hist';
    div.innerHTML = `
      <div class="ticket-hist-hdr" onclick="this.parentElement.classList.toggle('open')">
        <span class="ticket-hist-mesa">Mesa ${t.mesa}</span>
        <span class="ticket-hist-hora">${hora}</span>
        ${t.camarero ? `<span style="font-family:var(--mono);font-size:11px;color:var(--accent)">${t.camarero}</span>` : ''}
        <span class="ticket-hist-total">${(t.total||0).toFixed(2).replace('.',',')} €</span>
        <span style="color:var(--muted);font-size:12px">▾</span>
      </div>
      <div class="ticket-hist-body">
        ${(t.lineas || []).map(l => `
          <div class="ticket-hist-linea">
            <span>${l.qty}× ${l.nombre}</span>
            <span style="font-family:var(--mono)">${(l.precio * l.qty).toFixed(2)} €</span>
          </div>`).join('')}
        <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-weight:500;margin-top:8px;padding-top:8px;border-top:2px solid var(--border)">
          <span>Total</span><span>${(t.total||0).toFixed(2).replace('.',',')} €</span>
        </div>
      </div>`;
    lista.appendChild(div);
  });
}

function renderVentasPorArticulo(tickets) {
  const lista = document.getElementById('ventas-por-articulo');
  if (!lista) return;
  if (!tickets.length) {
    lista.innerHTML = '<div class="ventas-empty">Sin datos en el período seleccionado</div>';
    return;
  }
  const mapa = {};
  tickets.forEach(t => {
    (t.lineas || []).forEach(l => {
      const k = l.nombre;
      if (!mapa[k]) mapa[k] = { nombre: l.nombre, qty: 0, total: 0 };
      mapa[k].qty   += Number(l.qty || 0);
      mapa[k].total += Number(l.precio || 0) * Number(l.qty || 0);
    });
  });
  const sorted = Object.values(mapa).sort((a, b) => b.qty - a.qty);
  lista.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="border-bottom:1px solid var(--border)">
        <th style="text-align:left;padding:8px 4px;color:var(--muted);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Artículo</th>
        <th style="text-align:right;padding:8px 4px;color:var(--muted);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Uds</th>
        <th style="text-align:right;padding:8px 4px;color:var(--muted);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Total</th>
      </tr></thead>
      <tbody>${sorted.map(a => `
        <tr style="border-bottom:1px solid var(--border)">
          <td style="padding:8px 4px">${a.nombre}</td>
          <td style="text-align:right;padding:8px 4px;font-family:var(--mono)">${a.qty}</td>
          <td style="text-align:right;padding:8px 4px;font-family:var(--mono);color:var(--accent)">${a.total.toFixed(2).replace('.',',')} €</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderVentasPorDia(tickets) {
  const lista = document.getElementById('ventas-por-dia');
  if (!lista) return;
  if (!tickets.length) {
    lista.innerHTML = '<div class="ventas-empty">Sin datos en el período seleccionado</div>';
    return;
  }
  const dias = agruparVentasPorDia(tickets);
  lista.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="border-bottom:1px solid var(--border)">
        <th style="text-align:left;padding:8px 4px;color:var(--muted);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Fecha</th>
        <th style="text-align:right;padding:8px 4px;color:var(--muted);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Tickets</th>
        <th style="text-align:right;padding:8px 4px;color:var(--muted);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Artículos</th>
        <th style="text-align:right;padding:8px 4px;color:var(--muted);font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Total</th>
      </tr></thead>
      <tbody>${dias.map(d => `
        <tr style="border-bottom:1px solid var(--border)">
          <td style="padding:8px 4px">${fechaLabelDesdeKey(d.fecha)}</td>
          <td style="text-align:right;padding:8px 4px;font-family:var(--mono)">${d.tickets}</td>
          <td style="text-align:right;padding:8px 4px;font-family:var(--mono)">${d.lineas}</td>
          <td style="text-align:right;padding:8px 4px;font-family:var(--mono);color:var(--accent)">${fmtEu(d.total)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

// ─── USUARIOS ────────────────────────────────────────────────────────────────
window.addUsuario = async () => {
  const nombre = document.getElementById('usr-nombre').value.trim();
  const pin    = document.getElementById('usr-pin').value.trim();
  if (!nombre) { toast('Introduce un nombre'); return; }
  if (!/^\d{4}$/.test(pin)) { toast('El PIN debe tener 4 dígitos'); return; }
  const snap = await get(ref(db, 'config/usuarios'));
  const usuarios = snap.val() || {};
  const duplicado = Object.values(usuarios).find(u => u.pin === pin);
  if (duplicado) { toast('Ese PIN ya está en uso por ' + duplicado.nombre); return; }
  await push(ref(db, 'config/usuarios'), { nombre, pin });
  document.getElementById('usr-nombre').value = '';
  document.getElementById('usr-pin').value = '';
  toast('Camarero añadido');
};

window.delUsuario = async id => {
  await remove(ref(db, 'config/usuarios/' + id));
  toast('Camarero eliminado');
};

function renderUsuarios(usuarios) {
  const lista = document.getElementById('usuarios-lista');
  if (!lista) return;
  const entries = Object.entries(usuarios || {});
  if (!entries.length) {
    lista.innerHTML = '<p style="font-size:13px;color:var(--muted)">Sin camareros. Añade uno abajo.</p>';
    return;
  }
  lista.innerHTML = '';
  entries.forEach(([id, u]) => {
    const row = document.createElement('div');
    row.className = 'row-item';
    row.innerHTML = `
      <span class="row-label">${u.nombre}</span>
      <span class="row-sub" style="font-family:var(--mono)">PIN: ${u.pin}</span>
      <button class="btn btn-sm btn-danger" onclick="delUsuario('${id}')">× Eliminar</button>`;
    lista.appendChild(row);
  });
}

// ─── ALERTAS DE TIEMPO ────────────────────────────────────────────────────────
window.guardarAlertas = async () => {
  const verde    = parseInt(document.getElementById('alerta-verde')?.value) || 10;
  const amarillo = parseInt(document.getElementById('alerta-amarillo')?.value) || 20;
  if (verde >= amarillo) { toast('El umbral amarillo debe ser mayor que el verde'); return; }
  await set(ref(db, 'config/alertas'), { verde, amarillo });
  toast('Umbrales de alerta guardados');
};

window.marcarPendientesComoImpresas = async () => {
  const snap = await get(ref(db, 'pedidos'));
  const pedidos = snap.val() || {};
  const serviceKey = PRINT_SERVICE_ID.replace(/[.#$/\[\]]+/g, '_');
  const now = Date.now();
  const updates = {};
  let totalMarcadas = 0;

  Object.entries(pedidos).forEach(([mesaId, envios]) => {
    Object.entries(envios || {}).forEach(([envioId, envio]) => {
      const lineas = Object.values(envio.lineas || {});
      const tieneBarra = lineas.some(l => l.estado === 'pendiente' && (l.destino === 'barra' || l.destino === 'ambos'));
      const tieneCocina = lineas.some(l => l.estado === 'pendiente' && (l.destino === 'cocina' || l.destino === 'ambos'));

      if (tieneBarra) {
        updates[`pedidos/${mesaId}/${envioId}/_printService/barra/${serviceKey}`] = {
          printedAt: now,
          serviceId: PRINT_SERVICE_ID,
          manualSkip: true
        };
        totalMarcadas++;
      }
      if (tieneCocina) {
        updates[`pedidos/${mesaId}/${envioId}/_printService/cocina/${serviceKey}`] = {
          printedAt: now,
          serviceId: PRINT_SERVICE_ID,
          manualSkip: true
        };
        totalMarcadas++;
      }
    });
  });

  if (!totalMarcadas) {
    toast('No había comandas pendientes para marcar');
    return;
  }

  await update(ref(db), updates);
  toast(`Marcadas ${totalMarcadas} colas de impresión como impresas`);
};

// ─── TURNO ────────────────────────────────────────────────────────────────────
window.abrirTurno = async () => {
  const nombre = document.getElementById('turno-nombre')?.value.trim() || 'Turno';
  await set(ref(db, 'config/turno'), { abierto: true, inicio: Date.now(), nombre });
  toast('Turno abierto: ' + nombre);
};

window.cerrarTurno = async () => {
  const snapTurno = await get(ref(db, 'config/turno'));
  const turno = snapTurno.val();
  if (!turno?.abierto) { toast('No hay turno abierto'); return; }

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
  toast(`Turno cerrado — ${resumen.tickets} mesas · ${fmtEu(resumen.total)}`);
};

function renderResumenTurnoActualConTickets(turno, tickets) {
  const cont = document.getElementById('turno-resumen-actual');
  if (!cont) return;

  if (!turno?.abierto) {
    cont.innerHTML = '<div class="ventas-empty" style="padding:1.2rem 1rem">No hay turno activo</div>';
    return;
  }

  const resumen = resumirTickets(tickets);
  const inicio = new Date(turno.inicio);

  cont.innerHTML = `
    <div class="turno-card">
      <div class="turno-card-head">
        <div>
          <div class="turno-card-title">${escHtml(turno.nombre || 'Turno en curso')}</div>
          <div class="turno-card-meta">Abierto el ${inicio.toLocaleDateString('es-ES')} a las ${inicio.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' })}</div>
        </div>
        <span class="turno-badge activo">Activo</span>
      </div>
      <div class="turno-live-grid">
        <div class="turno-stat"><strong>${resumen.tickets}</strong><span>Tickets</span></div>
        <div class="turno-stat"><strong>${resumen.lineas}</strong><span>Artículos</span></div>
        <div class="turno-stat"><strong>${fmtEu(resumen.total)}</strong><span>Total</span></div>
        <div class="turno-stat"><strong>${fmtEu(resumen.media)}</strong><span>Ticket medio</span></div>
      </div>
    </div>`;
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
    lista.innerHTML = '<div class="ventas-empty">Todavía no hay turnos cerrados</div>';
    return;
  }

  lista.innerHTML = turnos.map(t => {
    const inicio = new Date(t.inicio);
    const fin = new Date(t.fin);
    const duracionMin = Math.max(0, Math.round((Number(t.fin) - Number(t.inicio)) / 60000));
    const horas = Math.floor(duracionMin / 60);
    const mins = duracionMin % 60;
    const duracionTxt = horas ? `${horas}h ${String(mins).padStart(2, '0')}m` : `${mins}m`;
    const media = Number(t.ticket_medio ?? ((Number(t.total || 0)) / Math.max(1, Number(t.mesas || 0))));
    return `
      <div class="turno-card" style="margin-bottom:12px">
        <div class="turno-card-head">
          <div>
            <div class="turno-card-title">${t.nombre || 'Turno'}</div>
            <div class="turno-card-meta">
              ${inicio.toLocaleDateString('es-ES')} · ${inicio.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' })} - ${fin.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' })}<br>
              Duración: ${duracionTxt}
            </div>
          </div>
          <span class="turno-badge">${fmtEu(t.total || 0)}</span>
        </div>
        <div class="turno-history-grid">
          <div class="turno-stat"><strong>${Number(t.mesas || 0)}</strong><span>Tickets</span></div>
          <div class="turno-stat"><strong>${Number(t.lineas_count || 0)}</strong><span>Artículos</span></div>
          <div class="turno-stat"><strong>${fmtEu(media)}</strong><span>Ticket medio</span></div>
          <div class="turno-stat"><strong>${fechaLabelDesdeKey(fechaKeyLocal(t.fin))}</strong><span>Fecha de cierre</span></div>
        </div>
      </div>`;
  }).join('');
}

// ─── AUDITORÍA ───────────────────────────────────────────────────────────────
const AUDIT_PWD_DEFAULT = 'audit1234';
const AUDIT_PWD_PATH = 'config/audit/password';
const AUDIT_SESSION_KEY = 'audit_unlocked';

let auditUsuarios = {};
let auditEventos = [];
let auditUnlocked = false;

const AUDIT_LABELS = {
  articulo_agregado:   { label: 'Artículo añadido',     color: 'var(--accent)',    sensible: false },
  articulo_eliminado:  { label: 'Artículo ELIMINADO',   color: '#e55353',          sensible: true  },
  cantidad_editada:    { label: 'Cantidad editada',     color: '#e5a035',          sensible: true  },
  descuento_aplicado:  { label: 'Descuento aplicado',   color: '#e5a035',          sensible: true  },
  ticket_impreso:      { label: 'Ticket impreso',       color: 'var(--accent2,#7ad7ff)', sensible: false },
  ticket_cobrado:      { label: 'Mesa cobrada',         color: 'var(--success,#35c777)', sensible: false },
  factura_emitida:     { label: 'Factura emitida',      color: 'var(--success,#35c777)', sensible: false },
  mesa_cerrada:        { label: 'Mesa cerrada',         color: 'var(--muted)',     sensible: false },
  mesa_transferida:    { label: 'Mesa transferida',     color: 'var(--muted)',     sensible: false },
  login_incorrecto_pin: { label: 'Intento PIN fallido',   color: '#e5a035',          sensible: true  },
  login_incorrecto_emojis: { label: 'Intento Emojis fallido', color: '#e5a035',      sensible: true  },
  login_bloqueado:     { label: 'ACCESO BLOQUEADO ⚠️',    color: '#e55353',          sensible: true  },
  login:               { label: 'Inicio de sesión',     color: 'var(--success,#35c777)', sensible: false }
};

function fechaKeyFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function initFiltrosAuditoria() {
  const hoy = new Date();
  const hoyKey = fechaKeyFromDate(hoy);
  const ini = document.getElementById('audit-fecha-ini');
  const fin = document.getElementById('audit-fecha-fin');
  if (ini && !ini.value) ini.value = hoyKey;
  if (fin && !fin.value) fin.value = hoyKey;
  const hIni = document.getElementById('audit-hora-ini');
  const hFin = document.getElementById('audit-hora-fin');
  if (hIni && !hIni.value) hIni.value = '00:00';
  if (hFin && !hFin.value) hFin.value = '23:59';
}

window.resetFiltrosAuditoria = () => {
  const hoy = new Date();
  const hoyKey = fechaKeyFromDate(hoy);
  document.getElementById('audit-fecha-ini').value = hoyKey;
  document.getElementById('audit-fecha-fin').value = hoyKey;
  document.getElementById('audit-hora-ini').value = '00:00';
  document.getElementById('audit-hora-fin').value = '23:59';
  document.getElementById('audit-camarero').value = '';
  document.getElementById('audit-accion').value = '';
  document.getElementById('audit-mesa').value = '';
  aplicarFiltrosAuditoria();
};

function poblarCamarerosAuditoria(usuarios) {
  auditUsuarios = usuarios || {};
  const sel = document.getElementById('audit-camarero');
  if (!sel) return;
  const valActual = sel.value;
  const nombres = Object.values(auditUsuarios)
    .map(u => u && u.nombre ? String(u.nombre) : null)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'es'));
  sel.innerHTML = '<option value="">— Todos —</option>' +
    nombres.map(n => `<option value="${n.replace(/"/g, '&quot;')}">${n}</option>`).join('');
  if (valActual && nombres.includes(valActual)) sel.value = valActual;
}

window.checkAuditPwd = async () => {
  const inp = document.getElementById('audit-pwd-input');
  const err = document.getElementById('audit-pwd-error');
  const pwd = (inp?.value || '').trim();
  if (!pwd) { if (err) err.style.display = 'block'; return; }
  let stored = AUDIT_PWD_DEFAULT;
  try {
    const snap = await get(ref(db, AUDIT_PWD_PATH));
    if (snap.val()) stored = String(snap.val());
  } catch (_) {}
  if (pwd === stored) {
    if (err) err.style.display = 'none';
    inp.value = '';
    desbloquearAuditoria();
  } else {
    if (err) err.style.display = 'block';
  }
};

window.bloquearAuditoria = () => {
  auditUnlocked = false;
  sessionStorage.removeItem(AUDIT_SESSION_KEY);
  document.getElementById('audit-locked').style.display = '';
  document.getElementById('audit-unlocked').style.display = 'none';
};

function desbloquearAuditoria() {
  auditUnlocked = true;
  sessionStorage.setItem(AUDIT_SESSION_KEY, '1');
  document.getElementById('audit-locked').style.display = 'none';
  document.getElementById('audit-unlocked').style.display = '';
  initFiltrosAuditoria();
  poblarCamarerosAuditoria(auditUsuarios);
  aplicarFiltrosAuditoria();
}

document.getElementById('audit-pwd-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') window.checkAuditPwd();
});

window.changeAuditPwd = async () => {
  const v = (document.getElementById('new-audit-pwd')?.value || '').trim();
  if (!v) { toast('Introduce una contraseña'); return; }
  await set(ref(db, AUDIT_PWD_PATH), v);
  document.getElementById('new-audit-pwd').value = '';
  toast('Contraseña de auditoría actualizada');
};

async function leerEventosAuditoriaRango(fechaIni, fechaFin) {
  const ini = new Date(`${fechaIni}T00:00:00`);
  const fin = new Date(`${fechaFin}T00:00:00`);
  if (isNaN(ini.getTime()) || isNaN(fin.getTime())) return [];
  if (ini > fin) return [];
  const eventos = [];
  const cursor = new Date(ini);
  // Evita rangos absurdos (límite duro de 95 días)
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

window.aplicarFiltrosAuditoria = async () => {
  if (!auditUnlocked) return;
  const fechaIni = document.getElementById('audit-fecha-ini').value;
  const fechaFin = document.getElementById('audit-fecha-fin').value;
  const horaIni  = document.getElementById('audit-hora-ini').value || '00:00';
  const horaFin  = document.getElementById('audit-hora-fin').value || '23:59';
  const camFiltro = document.getElementById('audit-camarero').value || '';
  const accFiltro = document.getElementById('audit-accion').value || '';
  const mesaFiltro = (document.getElementById('audit-mesa').value || '').trim().toLowerCase();

  if (!fechaIni || !fechaFin) { toast('Selecciona el rango de fechas'); return; }

  const lista = document.getElementById('audit-lista');
  if (lista) lista.innerHTML = '<div style="font-size:13px;color:var(--muted)">Cargando…</div>';

  let eventos = await leerEventosAuditoriaRango(fechaIni, fechaFin);

  // Construye límites locales (mismo offset que las fechas almacenadas)
  const tsMin = new Date(`${fechaIni}T${horaIni}:00`).getTime();
  const tsMax = new Date(`${fechaFin}T${horaFin}:59`).getTime();

  eventos = eventos.filter(ev => {
    const ts = Number(ev.ts || 0);
    if (!ts) return false;
    if (ts < tsMin || ts > tsMax) return false;
    if (camFiltro && (ev.camarero || '') !== camFiltro) return false;
    if (accFiltro && (ev.accion || '') !== accFiltro) return false;
    if (mesaFiltro) {
      const m = String(ev.mesa || '').toLowerCase();
      if (!m.includes(mesaFiltro)) return false;
    }
    return true;
  }).sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

  auditEventos = eventos;
  renderEventosAuditoria(eventos);
};

function renderEventosAuditoria(eventos) {
  const lista = document.getElementById('audit-lista');
  const elTotal     = document.getElementById('audit-stat-eventos');
  const elElim      = document.getElementById('audit-stat-eliminados');
  const elDescuento = document.getElementById('audit-stat-descuentos');

  if (elTotal) elTotal.textContent = eventos.length;
  if (elElim)  elElim.textContent  = eventos.filter(e => e.accion === 'articulo_eliminado').length;
  if (elDescuento) {
    const reduc = eventos.filter(e =>
      e.accion === 'descuento_aplicado' ||
      (e.accion === 'cantidad_editada' && Number(e.qtyDespues || 0) < Number(e.qtyAntes || 0))
    ).length;
    elDescuento.textContent = reduc;
  }

  if (!lista) return;
  if (!eventos.length) {
    lista.innerHTML = '<div style="font-size:13px;color:var(--muted);padding:1rem 0">Sin eventos en el período/filtro seleccionado.</div>';
    return;
  }

  const html = eventos.map(ev => {
    const info = AUDIT_LABELS[ev.accion] || { label: ev.accion || '—', color: 'var(--muted)', sensible: false };
    const fecha = new Date(Number(ev.ts) || 0);
    const fechaTxt = fecha.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const horaTxt = ev.hora || fecha.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const mesa = ev.mesa ? `Mesa ${ev.mesa}` : '—';
    const importeStr = (ev.total !== undefined && ev.total !== null && !isNaN(Number(ev.total)))
      ? `<span style="font-family:var(--mono);color:var(--accent);font-size:12px;margin-left:8px">${fmtEu(ev.total)}</span>`
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
        alertHora = ' <span title="¡Hora inusual (2am-8am)!" style="color:#e55353;font-weight:bold;margin-left:4px">⚠️</span>';
      }
    }
    
    // Detectar si es bloqueo por 3 errores
    let isBlock = ev.accion === 'login_bloqueado' || String(ev.accion).includes('bloqueado');
    let bgSens = info.sensible ? 'background:rgba(229,83,83,.06);border-left:3px solid #e55353' : 'background:transparent';
    if (isBlock) {
      bgSens = 'background:rgba(229,83,83,.15);border-left:4px solid #e55353';
    }
    
    const labelTxt = info.label + (isBlock ? ' ❗' : '');

    return `
      <div style="display:grid;grid-template-columns:120px 130px 130px 170px 1fr;gap:10px;padding:10px;border-bottom:1px solid var(--border);align-items:flex-start;${bgSens}">
        <div style="font-family:var(--mono);font-size:12px;color:var(--muted)">${fechaTxt}<br>${horaTxt}${alertHora}</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--text);font-weight:500">${ev.camarero || '—'}</div>
        <div style="font-family:var(--mono);font-size:12px;color:var(--muted)">${mesa}</div>
        <div style="font-size:12px;color:${info.color};font-weight:600;letter-spacing:.02em">${labelTxt}</div>
        <div style="font-size:12px;color:var(--text);line-height:1.4">${(ev.detalle || '').replace(/</g,'&lt;')}${importeStr}</div>
      </div>`;
  }).join('');

  lista.innerHTML = `
    <div style="display:grid;grid-template-columns:120px 130px 130px 170px 1fr;gap:10px;padding:8px 10px;border-bottom:2px solid var(--border);font-family:var(--mono);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">
      <div>Fecha / Hora</div>
      <div>Camarero</div>
      <div>Mesa</div>
      <div>Acción</div>
      <div>Detalle</div>
    </div>
    ${html}`;
}

window.exportarAuditoriaCSV = () => {
  if (!auditEventos.length) { toast('Sin eventos para exportar'); return; }
  let csv = 'Fecha,Hora,Camarero,Mesa,Accion,Detalle,Total\n';
  auditEventos.forEach(ev => {
    const d = new Date(Number(ev.ts) || 0);
    const fecha = d.toLocaleDateString('es-ES');
    const hora = ev.hora || d.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const accionLabel = (AUDIT_LABELS[ev.accion]?.label) || ev.accion || '';
    csv += `${escCsv(fecha)},${escCsv(hora)},${escCsv(ev.camarero || '')},${escCsv(ev.mesa || '')},${escCsv(accionLabel)},${escCsv(ev.detalle || '')},${escCsv(ev.total ?? '')}\n`;
  });
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fIni = document.getElementById('audit-fecha-ini').value;
  const fFin = document.getElementById('audit-fecha-fin').value;
  a.href = url;
  a.download = `auditoria_${fIni}_${fFin}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// ─── INIT ────────────────────────────────────────────────────────────────────
async function init() {
  try {
    await prepararFiltrosVentasIniciales();
    // Do NOT auto-run aplicarFiltros() on load
  } catch (err) {
    console.error('Error preparando ventas', err);
    renderVentas([]);
  }

  onValue(ref(db, 'mesas'), snap => {
    mesasData = snap.val() || {};
    renderPlano();
  });

  onValue(ref(db, 'pedidos'), snap => {
    pedidosData = snap.val() || {};
    renderPlano();
  });

  onValue(ref(db, 'config/plano'), snap => {
    const d = snap.val();
    if (d) planoCfgAdmin = { cols: Number(d.cols) || 16, rows: Number(d.rows) || 12 };
    renderPlano();
  });

  onValue(ref(db, 'categorias'), snap => {
    categoriasData = snap.val() || {};
    updateCatSelect();
    if (!editingArticuloId) renderSidebarNuevoForm();
    renderCarta();
  });

  onValue(ref(db, 'carta'), snap => {
    cartaData = snap.val() || {};
    renderCarta();
  });

  onValue(ref(db, 'config/local'), snap => {
    configLocalAdmin = snap.val() || {};
  });

  onValue(ref(db, 'config/usuarios'), snap => {
    const usuarios = snap.val();
    poblarCamarerosAuditoria(usuarios);
  });

  onValue(ref(db, 'config/alertas'), snap => {
    const d = snap.val() || {};
    alertasConfig = { verde: d.verde ?? 10, amarillo: d.amarillo ?? 20 };
    renderPlano();
  });

  // Sesión de auditoría: si se desbloqueó en esta pestaña, restaurar
  if (sessionStorage.getItem(AUDIT_SESSION_KEY) === '1') {
    auditUnlocked = true;
    const lockedEl = document.getElementById('audit-locked');
    const unlockedEl = document.getElementById('audit-unlocked');
    if (lockedEl) lockedEl.style.display = 'none';
    if (unlockedEl) unlockedEl.style.display = '';
    initFiltrosAuditoria();
    aplicarFiltrosAuditoria();
  } else {
    initFiltrosAuditoria();
  }
}

function renderStats(data) {
  const lista = document.getElementById('stats-lista');
  if (!lista) return;

  const meses = Object.entries(data).sort(([a],[b]) => b.localeCompare(a));

  if (!meses.length) {
    lista.innerHTML = '<div style="font-size:13px;color:var(--muted)">Sin datos aún. Se irán registrando con cada pedido enviado.</div>';
    return;
  }

  const mesActual = (() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
  })();

  const totalGeneral = meses.reduce((s, [,d]) => s + (d.lineas||0), 0);
  const maxMes = Math.max(...meses.map(([,d]) => d.lineas||0));

  lista.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0 12px;border-bottom:1px solid var(--border);margin-bottom:4px">
      <span style="font-size:13px;color:var(--muted)">Total acumulado</span>
      <span style="font-family:var(--mono);font-size:18px;font-weight:500">${totalGeneral.toLocaleString('es-ES')} líneas</span>
    </div>`;

  meses.forEach(([mes, datos]) => {
    const lineas = datos.lineas || 0;
    const esActual = mes === mesActual;
    const [anio, num] = mes.split('-');
    const nombre = new Date(anio, num-1, 1).toLocaleString('es-ES', {month:'long', year:'numeric'});
    const porcentaje = maxMes > 0 ? Math.round(lineas / maxMes * 100) : 0;

    const row = document.createElement('div');
    row.style.cssText = 'padding:10px 0;border-bottom:1px solid var(--border)';
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <span style="font-size:13px;font-weight:500;flex:1;text-transform:capitalize">${nombre}</span>
        ${esActual ? `<span style="font-size:11px;background:var(--accent-dim);color:var(--accent);padding:2px 8px;border-radius:20px;font-family:var(--mono)">en curso</span>` : ''}
        <span style="font-family:var(--mono);font-size:14px;font-weight:500">${lineas.toLocaleString('es-ES')}</span>
        <span style="font-size:12px;color:var(--muted)">líneas</span>
      </div>
      <div style="height:4px;background:var(--surface2);border-radius:2px;overflow:hidden">
        <div style="height:100%;width:${porcentaje}%;background:${esActual?'var(--accent)':'var(--border)'};border-radius:2px"></div>
      </div>`;
    lista.appendChild(row);
  });
}

window.syncTicketPaper = (source) => {
  const top = document.getElementById('local-ticket-paper');
  const bot = document.getElementById('ps-ticket-paper');
  if (!top || !bot) return;
  if (source === 'local') bot.value = top.value;
  else top.value = bot.value;
};

window.guardarLocal = async () => {
  await set(ref(db, 'config/local'), {
    nombre:    document.getElementById('local-nombre').value.trim(),
    direccion: document.getElementById('local-direccion').value.trim(),
    telefono:  document.getElementById('local-telefono').value.trim(),
    cif:       document.getElementById('local-cif').value.trim(),
    footer:    document.getElementById('local-footer').value.trim(),
    localNetworkUrl: document.getElementById('local-network-url').value.trim(),
    localNetworkMode: document.getElementById('local-network-mode').value || 'disabled',
    ticketLogoUrl: document.getElementById('local-ticket-logo').value.trim(),
    ticketPaper: document.getElementById('local-ticket-paper').value || '58mm',
    ticketFontSize: parseFloat(document.getElementById('local-ticket-font-size').value) || 9,
    ticketHeaderNameFontSize: parseFloat(document.getElementById('local-ticket-header-name-size').value) || 12,
    ticketHeaderSubFontSize:  parseFloat(document.getElementById('local-ticket-header-sub-size').value)  || 8,
    ticketUppercase: document.getElementById('local-ticket-uppercase').value === 'true',
    ticketShowNotes: document.getElementById('local-ticket-show-notes').value !== 'false',
    ticketHeaderOffset: parseInt(document.getElementById('local-ticket-header-offset').value) || 0,
    ticketMarginX: parseFloat(document.getElementById('local-ticket-margin-x').value) || 3,
    ticketMarginY: parseFloat(document.getElementById('local-ticket-margin-y').value) || 3,
    barraFontSize: parseFloat(document.getElementById('local-barra-font-size').value) || 9,
    cocinaFontSize: parseFloat(document.getElementById('local-cocina-font-size').value) || 9,
    barraUppercase: document.getElementById('local-barra-uppercase').value === 'true',
    cocinaUppercase: document.getElementById('local-cocina-uppercase').value === 'true',
    localBrowserPrintEnabled: document.getElementById('local-browser-print-enabled').value === 'true',
    ticketPrintMode: document.getElementById('local-ticket-print-mode').value || 'browser',
    ticketPrintServiceId: document.getElementById('local-ticket-print-service-id').value.trim() || PRINT_SERVICE_ID,
    barraPrintServiceId: document.getElementById('local-barra-print-service-id').value.trim(),
    cocinaPrintServiceId: document.getElementById('local-cocina-print-service-id').value.trim(),
    comandaAutoServir: document.getElementById('local-comanda-auto-servir').value === 'true',
  });
  toast('Datos del local guardados');
};

// ─── SERVICIO IMPRESIÓN ───────────────────────────────────────────────────────
function renderPrintServiceStatus(ps) {
  const paused = !!(ps && ps.paused);
  const dot   = document.getElementById('ps-pausa-dot');
  const label = document.getElementById('ps-pausa-label');
  const btn   = document.getElementById('btn-toggle-pausa');
  const badge = document.getElementById('ps-badge-status');
  if (!dot) return;

  dot.style.background   = paused ? 'var(--danger)' : 'var(--success)';
  label.textContent      = paused ? 'En pausa' : 'Activo';
  btn.textContent        = paused ? 'Reanudar impresión' : 'Pausar impresión';
  btn.className          = paused ? 'btn btn-success' : 'btn btn-danger';
  if (badge) { badge.textContent = paused ? 'Pausado' : 'Activo'; }

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const setOpt = (id, val) => { const el = document.getElementById(id); if (el) el.value = String(val); };

  const b = (ps && ps.barra) || {};
  set('ps-barra-printer', b.printerName || '');
  setOpt('ps-barra-paper', b.paper || '58mm');
  setOpt('ps-barra-enabled', b.enabled !== false ? 'true' : 'false');

  const c = (ps && ps.cocina) || {};
  set('ps-cocina-printer', c.printerName || '');
  setOpt('ps-cocina-paper', c.paper || '58mm');
  setOpt('ps-cocina-enabled', c.enabled !== false ? 'true' : 'false');

  const t = (ps && ps.ticketFinal) || {};
  set('ps-ticket-printer', t.printerName || '');
  setOpt('ps-ticket-paper', t.paper || '58mm');
  setOpt('ps-ticket-enabled', t.enabled !== false ? 'true' : 'false');
}

window.togglePausaImpresion = async () => {
  const snap = await get(ref(db, 'config/printService/paused'));
  const actual = !!snap.val();
  await set(ref(db, 'config/printService/paused'), !actual);
  toast(!actual ? 'Impresión pausada' : 'Impresión reanudada');
};

window.guardarConfigImpresoras = async () => {
  const snap = await get(ref(db, 'config/printService'));
  const actual = snap.val() || {};
  const nextConfig = {
    ...actual,
    barra: {
      enabled: document.getElementById('ps-barra-enabled').value === 'true',
      printerName: document.getElementById('ps-barra-printer').value.trim(),
      paper: document.getElementById('ps-barra-paper').value,
    },
    cocina: {
      enabled: document.getElementById('ps-cocina-enabled').value === 'true',
      printerName: document.getElementById('ps-cocina-printer').value.trim(),
      paper: document.getElementById('ps-cocina-paper').value,
    },
    ticketFinal: {
      enabled: document.getElementById('ps-ticket-enabled').value === 'true',
      printerName: document.getElementById('ps-ticket-printer').value.trim(),
      paper: document.getElementById('ps-ticket-paper').value,
    },
  };
  await set(ref(db, 'config/printService'), nextConfig);

  const localUrl = (document.getElementById('local-network-url')?.value || '').trim().replace(/\/+$/, '');
  if (localUrl) {
    try {
      await fetch(localUrl + '/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printing: {
            barra: nextConfig.barra,
            cocina: nextConfig.cocina,
            ticketFinal: nextConfig.ticketFinal
          }
        })
      });
      toast('Configuración de impresoras guardada y enviada al servidor local');
      return;
    } catch (err) {
      console.warn('No se pudo sincronizar con el servidor local', err);
      toast('Configuración guardada, pero no se pudo enviar al servidor local');
      return;
    }
  }

  toast('Configuración de impresoras guardada');
};

window.marcarPendientesComoImpresas = async () => {
  const pedidos = (await get(ref(db, 'pedidos'))).val() || {};
  const printJobs = (await get(ref(db, 'print_jobs'))).val() || {};
  const serviceKey = PRINT_SERVICE_ID.replace(/[.#$/\[\]]+/g, '_');
  const now = Date.now();
  const updates = {};
  let totalColas = 0;
  let totalTickets = 0;

  Object.entries(pedidos).forEach(([mesaId, envios]) => {
    Object.entries(envios || {}).forEach(([envioId, envio]) => {
      const lineas = Object.values(envio.lineas || {});
      const tieneBarra = lineas.some(l => l.estado === 'pendiente' && (l.destino === 'barra' || l.destino === 'ambos'));
      const tieneCocina = lineas.some(l => l.estado === 'pendiente' && (l.destino === 'cocina' || l.destino === 'ambos'));

      if (tieneBarra) {
        updates[`pedidos/${mesaId}/${envioId}/_printService/barra/${serviceKey}`] = {
          printedAt: now,
          serviceId: PRINT_SERVICE_ID,
          manualSkip: true
        };
        totalColas++;
      }
      if (tieneCocina) {
        updates[`pedidos/${mesaId}/${envioId}/_printService/cocina/${serviceKey}`] = {
          printedAt: now,
          serviceId: PRINT_SERVICE_ID,
          manualSkip: true
        };
        totalColas++;
      }
    });
  });

  Object.entries(printJobs).forEach(([jobId, job]) => {
    const status = String(job?.status || 'pending');
    const serviceId = String(job?.serviceId || PRINT_SERVICE_ID);
    if (status !== 'pending' || serviceId !== PRINT_SERVICE_ID) return;
    updates[`print_jobs/${jobId}/status`] = 'skipped';
    updates[`print_jobs/${jobId}/skippedAt`] = now;
    updates[`print_jobs/${jobId}/skippedBy`] = 'admin';
    totalTickets++;
  });

  if (!totalColas && !totalTickets) {
    toast('No había pendientes del servicio para marcar');
    return;
  }

  await update(ref(db), updates);
  toast(`Marcadas ${totalColas} colas y ${totalTickets} tickets como impresos`);
};

// ── VERIFACTU ADMIN ───────────────────────────────────────────────────────────

let configVfAdmin = {};

// Carga y rellena el formulario de configuración Verifactu
onValue(ref(db, 'config/verifacti'), async snap => {
  configVfAdmin = snap.val() || {};
  const set_ = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
  set_('vf-apikey',     configVfAdmin.apiKey || '');
  set_('vf-apiurl',     configVfAdmin.apiUrl || 'https://api.verifacti.com');
  set_('vf-iva',        configVfAdmin.ivaDefault ?? 10);
  set_('vf-desc',       configVfAdmin.descripcionDefault || 'Consumición en local');
  set_('vf-serie-simp', configVfAdmin.serieSimp || 'SIMP');
  set_('vf-serie-fact', configVfAdmin.serieFact || 'FACT');
  set_('vf-serie-rect', configVfAdmin.serieRect || 'RECT');
  set_('vf-serie-sust', configVfAdmin.serieSust || 'SUST');
  set_('vf-prefix',     configVfAdmin.numPrefijo || '');
  set_('vf-digits',     configVfAdmin.numDigitos || '');

  const track = document.getElementById('vf-enabled-track');
  const label = document.getElementById('vf-enabled-label');
  if (track) track.classList.toggle('active', !!configVfAdmin.habilitado);
  if (label) label.textContent = configVfAdmin.habilitado ? 'Activado' : 'Desactivado';

  await recargarContadores();
});

window.toggleVfEnabled = async () => {
  const nuevo = !configVfAdmin.habilitado;
  await set(ref(db, 'config/verifacti/habilitado'), nuevo);
};

window.guardarConfigVf = async () => {
  const v = id => document.getElementById(id)?.value.trim();
  const serieSimp = (v('vf-serie-simp') || 'SIMP').toUpperCase();
  const serieFact = (v('vf-serie-fact') || 'FACT').toUpperCase();
  const serieRect = (v('vf-serie-rect') || 'RECT').toUpperCase();
  const serieSust = (v('vf-serie-sust') || 'SUST').toUpperCase();
  const numPrefijo = v('vf-prefix') || '';
  const numDigitos = v('vf-digits') !== '' ? Number(v('vf-digits')) : 0;
  await set(ref(db, 'config/verifacti'), {
    ...configVfAdmin,
    apiKey:              v('vf-apikey') || '',
    apiUrl:              v('vf-apiurl') || 'https://api.verifacti.com',
    ivaDefault:          Number(v('vf-iva')) || 10,
    descripcionDefault:  v('vf-desc') || 'Consumición en local',
    serieSimp, serieFact, serieRect, serieSust,
    numPrefijo, numDigitos,
    habilitado:          configVfAdmin.habilitado || false
  });
  toast('Configuración Verifactu guardada');
};

window.recargarContadores = async () => {
  const series = [
    ['vf-next-simp', document.getElementById('vf-serie-simp')?.value || configVfAdmin.serieSimp || 'SIMP'],
    ['vf-next-fact', document.getElementById('vf-serie-fact')?.value || configVfAdmin.serieFact || 'FACT'],
    ['vf-next-rect', document.getElementById('vf-serie-rect')?.value || configVfAdmin.serieRect || 'RECT'],
    ['vf-next-sust', document.getElementById('vf-serie-sust')?.value || configVfAdmin.serieSust || 'SUST'],
  ];
  for (const [elId, serie] of series) {
    const el = document.getElementById(elId);
    if (!el) continue;
    try {
      const n = await verNumeroActual(serie.toUpperCase());
      el.textContent = `Siguiente nº: ${n}`;
    } catch (_) { el.textContent = 'Contador: —'; }
  }
};

window.testearApiVf = async () => {
  const res = document.getElementById('vf-test-result');
  if (!res) return;
  res.style.display = 'block';
  res.style.color = 'var(--muted)';
  res.textContent = 'Probando conexión…';
  const apiKey = document.getElementById('vf-apikey')?.value.trim();
  const baseUrl = (document.getElementById('vf-apiurl')?.value.trim() || 'https://api.verifacti.com').replace(/\/$/, '');
  if (!apiKey) { res.style.color = 'var(--danger)'; res.textContent = 'Falta la API Key.'; return; }
  try {
    const resp = await fetch(`${baseUrl}/verifactu/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({})
    });
    if (resp.ok || resp.status === 400 || resp.status === 422) {
      res.style.color = 'var(--success)';
      res.textContent = `Conexión correcta (HTTP ${resp.status}). API Key válida.`;
    } else if (resp.status === 401 || resp.status === 403) {
      res.style.color = 'var(--danger)';
      res.textContent = `API Key incorrecta o sin permisos (HTTP ${resp.status}).`;
    } else {
      res.style.color = 'var(--danger)';
      res.textContent = `Respuesta inesperada: HTTP ${resp.status}.`;
    }
  } catch (e) {
    res.style.color = 'var(--danger)';
    res.textContent = `Error de red: ${e.message}`;
  }
};

// ── HISTORIAL VERIFACTU ───────────────────────────────────────────────────────

let vfHistorialCache = {};

window.cargarHistorialVf = async () => {
  const lista = document.getElementById('vf-historial-lista');
  if (!lista) return;
  lista.innerHTML = '<div style="font-size:13px;color:var(--muted)">Cargando…</div>';
  try {
    vfHistorialCache = await listarFacturas();
  } catch (e) {
    lista.innerHTML = `<div style="color:var(--danger);font-size:13px">Error al cargar: ${e.message}</div>`;
    return;
  }
  renderHistorialVf();

  // Auto-consultar estado AEAT para facturas pendientes con UUID (máx 5)
  if (configVfAdmin.apiKey) {
    const pendientes = Object.entries(vfHistorialCache)
      .filter(([, f]) => f.status === 'Pending' && f.uuid)
      .slice(0, 5);
    for (const [fbKey, f] of pendientes) {
      try {
        const res = await consultarEstado(f.uuid, configVfAdmin.apiKey, configVfAdmin.apiUrl);
        const nuevoEstado = res.status || res.Estado || f.status;
        if (nuevoEstado !== f.status) {
          await actualizarEstadoFactura(fbKey, nuevoEstado);
          vfHistorialCache[fbKey] = { ...f, status: nuevoEstado };
        }
      } catch (_) {}
    }
    if (pendientes.length) renderHistorialVf();
  }
};

function renderHistorialVf() {
  const lista = document.getElementById('vf-historial-lista');
  if (!lista) return;
  const entries = Object.entries(vfHistorialCache)
    .map(([k, v]) => ({ fbKey: k, ...v }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));

  if (!entries.length) {
    lista.innerHTML = '<div style="font-size:13px;color:var(--muted)">Sin facturas emitidas aún.</div>';
    return;
  }

  const colorEstado = s => s === 'Accepted' ? 'var(--success)' : s === 'Rejected' ? 'var(--danger)' : s === 'Cancelled' ? 'var(--muted)' : s === 'Local' ? 'var(--muted)' : 'var(--info)';

  lista.innerHTML = `
    <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12px">
      <thead>
        <tr style="color:var(--muted);border-bottom:1px solid var(--border)">
          <th style="text-align:left;padding:6px 8px">Nº Factura</th>
          <th style="text-align:left;padding:6px 8px">Tipo</th>
          <th style="text-align:left;padding:6px 8px">Fecha</th>
          <th style="text-align:right;padding:6px 8px">Total</th>
          <th style="text-align:left;padding:6px 8px">Mesa</th>
          <th style="text-align:left;padding:6px 8px">Estado AEAT</th>
          <th style="text-align:center;padding:6px 8px">Acciones</th>
        </tr>
      </thead>
      <tbody>
        ${entries.map(f => `
          <tr style="border-bottom:1px solid var(--border)" data-fbkey="${f.fbKey}">
            <td style="padding:6px 8px;font-weight:600">${f.serie || '?'}-${f.numero || '?'}</td>
            <td style="padding:6px 8px;color:var(--muted-strong)">${labelTipoFactura(f.tipo)}</td>
            <td style="padding:6px 8px">${f.fecha || '—'}</td>
            <td style="padding:6px 8px;text-align:right">${fmtEu(f.total || 0)}</td>
            <td style="padding:6px 8px">${f.mesa ? `Mesa ${f.mesa}` : '—'}${f.destinatario ? `<br><span style="font-size:10px;color:var(--muted)">${f.destinatario.nif || ''}</span>` : ''}</td>
            <td style="padding:6px 8px">
              <span style="color:${colorEstado(f.status)}">${labelEstado(f.status)}</span>
            </td>
            <td style="padding:6px 8px;text-align:center;white-space:nowrap">
              <button class="btn btn-sm" style="font-size:11px;padding:4px 8px" onclick="vfAccion('reprint','${f.fbKey}')">Reimpr.</button>
              ${f.uuid ? `<button class="btn btn-sm" style="font-size:11px;padding:4px 8px;margin-left:4px" onclick="vfAccion('status','${f.fbKey}')">Estado</button>` : ''}
              ${(f.tipo === 'F1' || f.tipo === 'F2') && f.status !== 'Local' ? `<button class="btn btn-sm" style="font-size:11px;padding:4px 8px;margin-left:4px;background:var(--danger-dim);color:var(--danger)" onclick="vfAccion('rect','${f.fbKey}')">Rectif.</button>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>`;
}

window.vfAccion = async (accion, fbKey) => {
  const f = vfHistorialCache[fbKey];
  if (!f) return;

  if (accion === 'reprint') {
    vfReimprimirAdmin(f);
  } else if (accion === 'status') {
    await vfConsultarEstadoAdmin(fbKey, f);
  } else if (accion === 'rect') {
    vfMostrarModalRectificativa(fbKey, f);
  }
};

function buildVfTicketHtml(f) {
  const loc = configLocalAdmin || {};
  const paperW = loc.ticketPaper || '80mm';
  const tipoLabel = labelTipoFactura(f.tipo);
  const fecha = new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });

  const logoHtml = loc.ticketLogoUrl
    ? `<div style="text-align:center;margin-bottom:4px"><img src="${loc.ticketLogoUrl}" style="max-width:60mm;max-height:18mm;object-fit:contain" /></div>` : '';
  const localHtml = loc.nombre
    ? `<div style="text-align:center;font-weight:bold;font-size:11px;margin-bottom:2px">${loc.nombre}</div>` : '';
  const localInfoHtml = ['direccion','telefono','cif'].map(k => loc[k]
    ? `<div style="text-align:center;font-size:8px;color:#444">${loc[k]}</div>` : '').join('');

  const ivaHtml = (f.lineasIva || []).map(l => `
    <div style="display:flex;justify-content:space-between;font-size:8px;color:#444">
      <span>Base imp. ${l.tipo_impositivo}%</span><span>${parseFloat(l.base_imponible||0).toFixed(2).replace('.',',')} €</span></div>
    <div style="display:flex;justify-content:space-between;font-size:8px;color:#444">
      <span>IVA ${l.tipo_impositivo}%</span><span>${parseFloat(l.cuota_repercutida||0).toFixed(2).replace('.',',')} €</span></div>`
  ).join('');

  const qrHtml = f.qr
    ? `<div style="text-align:center;margin:6px 0"><img src="data:image/png;base64,${f.qr}" style="width:80px;height:80px;display:block;margin:0 auto" /><div style="font-size:7px;color:#666;margin-top:2px">Verificación AEAT</div></div>` : '';

  const destHtml = f.destinatario
    ? `<div style="font-size:9px;border-top:1px dashed #ccc;padding-top:4px;margin-top:4px">
        <div>Destinatario: <strong>${f.destinatario.nombre||''}</strong></div>
        <div>NIF: ${f.destinatario.nif||''}</div>
        ${f.destinatario.direccion ? `<div>${f.destinatario.direccion}</div>` : ''}
       </div>` : '';

  const footerHtml = loc.footer
    ? `<div style="text-align:center;font-size:7px;color:#888;margin-top:6px;border-top:1px dashed #999;padding-top:4px">${loc.footer}</div>` : '';

  const isLocal = f.status === 'Local';
  const headerText = isLocal ? tipoLabel.toUpperCase() : `${tipoLabel.toUpperCase()} VERIFACTU`;
  const qrOutput = isLocal ? '' : qrHtml;
  const uuidOutput = isLocal ? '' : (f.uuid ? `<div style="font-size:6px;color:#bbb;text-align:center;word-break:break-all;margin-top:2px">${f.uuid}</div>` : '');
  const verifactuLegalFooter = isLocal ? '' : `<div style="text-align:center;font-size:7px;color:#666;margin-top:4px;border-top:1px dashed #999;padding-top:3px">Conforme RD 1007/2023 — Verifactu</div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
@page{size:${paperW} auto;margin:3mm}
body{font-family:'Courier New',monospace;font-size:9px;width:${paperW};max-width:${paperW};color:#111}
.rule{border:none;border-top:1px dashed #666;margin:5px 0}
.total{display:flex;justify-content:space-between;font-weight:bold;font-size:10px;margin-top:4px;padding-top:4px;border-top:1px solid #333}
.bar{display:flex;gap:6px;margin-bottom:10px;justify-content:center;flex-wrap:wrap}
.bar button{border:1px solid #aaa;background:#f5f5f5;color:#111;border-radius:999px;padding:5px 14px;font:inherit;cursor:pointer;font-size:10px}
@media print{.bar{display:none}}
</style></head><body>
<div class="bar">
  <button onclick="window.print()">Imprimir / PDF</button>
  <button id="btn-servicio">Enviar a impresora</button>
  <button onclick="window.close()">Cerrar</button>
</div>
${logoHtml}${localHtml}${localInfoHtml}
<div style="text-align:center;font-size:7px;color:#666;margin:2px 0">Reimpresión ${fecha}</div>
<hr class="rule">
<div style="text-align:center;font-weight:bold;font-size:10px;letter-spacing:.05em;margin-bottom:2px">${headerText}</div>
<div style="text-align:center;font-size:8px;margin-bottom:4px">Nº ${f.serie}-${f.numero} | ${f.fecha}</div>
${destHtml}
<hr class="rule">
${ivaHtml}
<div class="total"><span>Total</span><span>${Number(f.total||0).toFixed(2).replace('.',',')} €</span></div>
${qrOutput}
${uuidOutput}
${verifactuLegalFooter}
${footerHtml}
<script>
document.getElementById('btn-servicio')?.addEventListener('click', () => {
  window.__sendToService?.();
});
<\/script>
</body></html>`;
}

function vfReimprimirAdmin(f) {
  const html = buildVfTicketHtml(f);
  const win = window.open('', '_blank');
  if (!win) { toast('Bloqueo de ventanas emergentes — permite pop-ups'); return; }
  win.document.open(); win.document.write(html); win.document.close();

  // Inject the "send to service" handler after the window loads
  win.__sendToService = async () => {
    const loc = configLocalAdmin || {};
    const serviceId = (loc.ticketPrintServiceId || PRINT_SERVICE_ID).trim() || PRINT_SERVICE_ID;
    const payload = {
      kind: 'ticket_final',
      status: 'pending',
      createdAt: Date.now(),
      serviceId,
      requestedBy: 'admin-reprint',
      mesaId: f.mesa || '',
      mesaNombre: f.mesa || '',
      local: {
        nombre: loc.nombre || '',
        direccion: loc.direccion || '',
        telefono: loc.telefono || '',
        cif: loc.cif || '',
        footer: loc.footer || '',
        logoUrl: loc.ticketLogoUrl || '',
        ticketShowNotes: true,
        headerNameFontSize: Number(loc.ticketHeaderNameFontSize || 12),
        headerSubFontSize: Number(loc.ticketHeaderSubFontSize || 8)
      },
      format: {
        paper: loc.ticketPaper || '80mm',
        fontSize: Number(loc.ticketFontSize || 9),
        uppercase: loc.ticketUppercase === true,
        headerOffset: Number(loc.ticketHeaderOffset || 0)
      },
      total: Number(f.total || 0),
      lines: (f.lineasIva || []).map(l => ({
        nombre: `Base imponible ${l.tipo_impositivo}%`,
        qty: 1,
        precio: parseFloat(l.base_imponible || 0),
        nota: ''
      })),
      cobro: null,
      verifactu: f
    };
    try {
      await push(ref(db, 'print_jobs'), payload);
      win.document.getElementById('btn-servicio').textContent = '✓ Enviado';
      win.document.getElementById('btn-servicio').disabled = true;
    } catch (e) {
      alert('Error al enviar: ' + e.message);
    }
  };
}

async function vfConsultarEstadoAdmin(fbKey, f) {
  if (!f.uuid) { toast('Esta factura no tiene UUID de Verifacti'); return; }
  if (!configVfAdmin.apiKey) { toast('Configura la API Key de Verifacti primero'); return; }
  toast('Consultando estado en AEAT…');
  try {
    const resultado = await consultarEstado(f.uuid, configVfAdmin.apiKey, configVfAdmin.apiUrl);
    const nuevoEstado = resultado.status || resultado.Estado || f.status;
    await actualizarEstadoFactura(fbKey, nuevoEstado);
    vfHistorialCache[fbKey] = { ...f, status: nuevoEstado };
    renderHistorialVf();
    toast(`Estado: ${labelEstado(nuevoEstado)}`);
  } catch (e) {
    toast(`Error al consultar: ${e.message}`);
  }
}

// ── MODAL RECTIFICATIVA (Admin) ───────────────────────────────────────────────

function vfMostrarModalRectificativa(fbKey, f) {
  const overlay = document.getElementById('vf-modal-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';

  document.getElementById('vf-modal-title').textContent = 'Crear Rectificativa';
  document.getElementById('vf-modal-body').innerHTML = `
    <div style="padding:10px;background:rgba(255,255,255,.04);border-radius:10px;font-size:11px;color:var(--muted)">
      Factura original: <strong>${f.serie}-${f.numero}</strong> del <strong>${f.fecha}</strong> | Total: <strong>${fmtEu(f.total)}</strong>
    </div>
    <label style="font-size:12px;color:var(--muted)">Tipo de rectificativa</label>
    <select id="adm-rect-tipo"
      style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text)">
      <option value="R1">R1 — Art.80.1,2,6 LIVA (error en cuota)</option>
      <option value="R2">R2 — Art.80.3 (concurso de acreedores)</option>
      <option value="R3">R3 — Art.80.4 (crédito incobrable)</option>
      <option value="R4">R4 — Otras causas</option>
      <option value="R5">R5 — Rectificativa simplificada</option>
    </select>
    <label style="font-size:12px;color:var(--muted)">Método de rectificación</label>
    <select id="adm-rect-metodo"
      style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text)">
      <option value="I">Por diferencias (I) — importe negativo de la diferencia</option>
      <option value="S">Por sustitución (S) — anula el original y pone el nuevo</option>
    </select>
    <label style="font-size:12px;color:var(--muted)">Importe a rectificar (€, negativo = devolución) *</label>
    <input id="adm-rect-importe" type="number" step="0.01" placeholder="-${Number(f.total||0).toFixed(2)}"
      style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:14px;background:var(--surface2);color:var(--text)" />
    <label style="font-size:12px;color:var(--muted)">Descripción</label>
    <input id="adm-rect-desc" type="text" value="Rectificación"
      style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text)" />
    ${f.destinatario ? `<div style="font-size:11px;color:var(--muted)">Destinatario: ${f.destinatario.nif} — ${f.destinatario.nombre || ''}</div>` : ''}
    <div id="adm-rect-err" style="color:var(--danger);font-size:12px;display:none">Introduce el importe a rectificar.</div>`;

  const acts = document.getElementById('vf-modal-actions');
  acts.innerHTML = '';
  const btnC = document.createElement('button');
  btnC.className = 'btn'; btnC.textContent = 'Cancelar';
  btnC.onclick = () => { overlay.style.display = 'none'; };

  const btnOk = document.createElement('button');
  btnOk.className = 'btn btn-success'; btnOk.textContent = 'Emitir rectificativa';
  btnOk.onclick = async () => {
    const tipo = document.getElementById('adm-rect-tipo')?.value || 'R1';
    const metodo = document.getElementById('adm-rect-metodo')?.value || 'I';
    const importeStr = document.getElementById('adm-rect-importe')?.value;
    const importeNum = parseFloat(importeStr);
    const desc = document.getElementById('adm-rect-desc')?.value.trim() || 'Rectificación';
    if (isNaN(importeNum)) {
      document.getElementById('adm-rect-err').style.display = 'block'; return;
    }
    overlay.style.display = 'none';
    if (!configVfAdmin.apiKey) { toast('Configura la API Key primero'); return; }

    const serieRect = (configVfAdmin.serieRect || 'RECT').toUpperCase();
    const iva = Number(configVfAdmin.ivaDefault ?? 10);
    const factor = 1 + iva / 100;
    const baseRect = Math.round(importeNum / factor * 100) / 100;
    const cuotaRect = Math.round((importeNum - baseRect) * 100) / 100;
    const lineasVf = [{ base_imponible: baseRect.toFixed(2), tipo_impositivo: String(iva), cuota_repercutida: cuotaRect.toFixed(2) }];
    const numRect = await siguienteNumero(serieRect);
    const fechaRect = fmtFechaVf(Date.now());

    toast('Emitiendo rectificativa…');
    try {
      const resultado = await emitirRectificativa({
        serie: serieRect, numero: numRect, tipo, metodo,
        lineas: lineasVf, total: importeNum, descripcion: desc, fecha: fechaRect,
        nif: f.destinatario?.nif, nombre: f.destinatario?.nombre,
        facturasRectificadas: [{ serie: f.serie, numero: f.numero, fecha_expedicion: f.fecha }]
      }, configVfAdmin.apiKey, configVfAdmin.apiUrl);

      const qrRes = resultado.qr_code || resultado.qr || resultado.qrCode || null;
      const uuidRes = resultado.uuid || resultado.id || null;
      const vfData = {
        tipo, serie: serieRect, numero: numRect, fecha: fechaRect,
        uuid: uuidRes, qr: qrRes, total: importeNum, lineasIva: lineasVf,
        status: resultado.status || 'Pending',
        facturas_ref: [{ serie: f.serie, numero: f.numero, fecha_expedicion: f.fecha }],
        destinatario: f.destinatario || null
      };
      const newKey = await guardarFacturaEmitida(vfData);
      vfHistorialCache[newKey] = { fbKey: newKey, ...vfData };
      renderHistorialVf();
      toast(`Rectificativa ${serieRect}-${numRect} emitida`);
      // Abrir ventana de impresión
      vfReimprimirAdmin(vfData);
    } catch (e) {
      toast(`Error: ${e.message}`);
    }
  };

  acts.appendChild(btnC);
  acts.appendChild(btnOk);
  setTimeout(() => document.getElementById('adm-rect-importe')?.focus(), 80);
}

window.exportarHistorialVf = () => {
  const entries = Object.values(vfHistorialCache).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (!entries.length) { toast('No hay facturas para exportar'); return; }
  const cols = ['Nº Factura','Tipo','Fecha','Total','Mesa','Destinatario NIF','Destinatario Nombre','Estado AEAT','UUID'];
  const rows = entries.map(f => [
    `${f.serie || ''}-${f.numero || ''}`,
    labelTipoFactura(f.tipo),
    f.fecha || '',
    Number(f.total || 0).toFixed(2),
    f.mesa ? `Mesa ${f.mesa}` : '',
    f.destinatario?.nif || '',
    f.destinatario?.nombre || '',
    labelEstado(f.status),
    f.uuid || ''
  ]);
  const csv = [cols, ...rows].map(r => r.map(escCsv).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = `verifactu-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  toast('CSV exportado');
};

// Cerrar modal Verifactu al clic fuera
document.getElementById('vf-modal-overlay')?.addEventListener('click', e => {
  if (e.target === document.getElementById('vf-modal-overlay'))
    document.getElementById('vf-modal-overlay').style.display = 'none';
});

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

  const loc = configLocalAdmin || {};
  const serviceId = String(loc.ticketPrintServiceId || PRINT_SERVICE_ID).trim() || PRINT_SERVICE_ID;
  const payload = {
    kind: 'ticket_final',
    status: 'pending',
    createdAt: Date.now(),
    serviceId,
    requestedBy: 'admin-cierre',
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

const escHtml = v => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildCierreCajaHtml(resumenDia) {
  const loc = configLocalAdmin || {};
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
