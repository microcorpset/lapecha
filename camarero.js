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
import { ref, onValue, push, set, remove, get, update }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

await authReady;

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────
// carrito: key → { art, qty, nota }
// key es artId para artículos simples, artId__v{idx} para variantes
let mesaId = null, mesaNombre = null;
let carrito = {};
let mesasData = {}, cartaData = {}, categoriasData = {};
let cartaReady = false, catsReady = false;
let configLocal = {};
let ticketEditMode = false;
let pedidosData = {};
let alertasConfig = { verde: 10, amarillo: 20 };

// ── USUARIOS / PIN multi-camarero ─────────────────────────────────────────────
const PIN_SESSION  = 'cam_auth';
const USER_SESSION = 'cam_user';
let usuariosData   = {};
let camareroActual = sessionStorage.getItem(USER_SESSION) || '';
let pinBuffer      = '';

get(ref(db, 'config/usuarios')).then(s => {
  usuariosData = s.val() || {};
  if (!Object.keys(usuariosData).length) {
    get(ref(db, 'config/pins/camarero')).then(p => {
      if (p.val()) usuariosData['_default'] = { nombre: 'Camarero', pin: p.val() };
      else         usuariosData['_default'] = { nombre: 'Camarero', pin: '1234' };
    });
  }
}).catch(() => { usuariosData['_default'] = { nombre: 'Camarero', pin: '1234' }; });

if (sessionStorage.getItem(PIN_SESSION) === '1' && camareroActual) {
  document.getElementById('pin-screen').style.display = 'none';
  document.getElementById('topbar-camarero').textContent = camareroActual;
}

window.pinKey = d => {
  if (pinBuffer.length >= 4) return;
  pinBuffer += d; updatePinDots();
  if (pinBuffer.length === 4) verificarPin();
};
window.pinDel = () => {
  pinBuffer = pinBuffer.slice(0,-1); updatePinDots(false);
  document.getElementById('pin-error').style.display = 'none';
};
function updatePinDots(error) {
  for (let i=0;i<4;i++) {
    const dot = document.getElementById('pd'+i);
    dot.className = 'pin-dot'+(i<pinBuffer.length?(error?' error':' filled'):'');
  }
}
function verificarPin() {
  const match = Object.values(usuariosData).find(u => u.pin === pinBuffer);
  if (match) {
    camareroActual = match.nombre;
    sessionStorage.setItem(PIN_SESSION, '1');
    sessionStorage.setItem(USER_SESSION, camareroActual);
    document.getElementById('pin-screen').style.display = 'none';
    document.getElementById('topbar-camarero').textContent = camareroActual;
  } else {
    updatePinDots(true);
    document.getElementById('pin-error').style.display = 'block';
    setTimeout(() => { pinBuffer=''; updatePinDots(false); document.getElementById('pin-error').style.display='none'; }, 900);
  }
}

document.getElementById('pin-pad').addEventListener('click', e => {
  const btn = e.target.closest('[data-k]');
  if (!btn) return;
  const k = btn.dataset.k;
  if (k === 'del') pinDel();
  else if (k !== '') pinKey(k);
});

// ── MODAL ─────────────────────────────────────────────────────────────────────
function showModal({ title, body, buttons }) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent = body;
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'modal-btn' + (b.style ? ' ' + b.style : '');
    btn.textContent = b.label;
    btn.onclick = () => {
      document.getElementById('modal-overlay').classList.remove('open');
      if (b.action) b.action();
    };
    acts.appendChild(btn);
  });
  document.getElementById('modal-overlay').classList.add('open');
}

document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay'))
    document.getElementById('modal-overlay').classList.remove('open');
});

document.querySelector('.resumen-info')?.addEventListener('click', () => {
  if (window.innerWidth <= 640 && mesaId) abrirDrawer();
});

// ── TOGGLES PDF / TXT / WAKE ──────────────────────────────────────────────────
const PRINT_KEY = 'camarero_pdf';
let autoPDF = localStorage.getItem(PRINT_KEY) === 'true';
const printTrack = document.getElementById('print-track');
printTrack.classList.toggle('on', autoPDF);
printTrack.parentElement.addEventListener('click', () => {
  autoPDF = !autoPDF;
  localStorage.setItem(PRINT_KEY, autoPDF);
  printTrack.classList.toggle('on', autoPDF);
});

const TXT_KEY = 'camarero_txt';
let autoTXT = localStorage.getItem(TXT_KEY) === 'true';
const txtTrack = document.getElementById('txt-track');
txtTrack.classList.toggle('on', autoTXT);
txtTrack.parentElement.addEventListener('click', () => {
  autoTXT = !autoTXT;
  localStorage.setItem(TXT_KEY, autoTXT);
  txtTrack.classList.toggle('on', autoTXT);
});

const WAKE_KEY = 'camarero_wake';
let wakeLock = null;
let autoWake = localStorage.getItem(WAKE_KEY) === 'true';
const wakeTrack = document.getElementById('wake-track');
wakeTrack.classList.toggle('on', autoWake);
async function activarWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
}
if (autoWake) activarWakeLock();
wakeTrack.parentElement.addEventListener('click', () => {
  autoWake = !autoWake;
  localStorage.setItem(WAKE_KEY, autoWake);
  wakeTrack.classList.toggle('on', autoWake);
  if (autoWake) activarWakeLock(); else { if (wakeLock) { wakeLock.release(); wakeLock = null; } }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && autoWake) activarWakeLock();
});

// ── Modal de nota ─────────────────────────────────────────────────────────────
window.abrirNotaModal = (artId, nombreArt) => {
  // Buscar nota del carrito: puede ser artId simple o primer variant key
  const carritoKey = Object.keys(carrito).find(k => k === artId || k.startsWith(artId + '__v')) || artId;
  const notaActual = carrito[carritoKey]?.nota || '';
  showModal({ title: '📝 ' + nombreArt, body: '', buttons: [] });
  const modalBody = document.getElementById('modal-body');
  modalBody.innerHTML = '';
  const inp = document.createElement('input');
  inp.type = 'text'; inp.value = notaActual;
  inp.placeholder = 'ej: poco hecho, sin cebolla…';
  inp.style.cssText = 'width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:14px;font-family:var(--sans);color:var(--text);outline:none';
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') guardarNota(); });
  modalBody.appendChild(inp);
  setTimeout(() => inp.focus(), 80);
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  const btnClear = document.createElement('button');
  btnClear.className = 'modal-btn'; btnClear.textContent = 'Borrar';
  btnClear.onclick = () => { inp.value = ''; guardarNota(); };
  const btnOk = document.createElement('button');
  btnOk.className = 'modal-btn primary'; btnOk.textContent = 'Guardar';
  btnOk.onclick = guardarNota;
  acts.appendChild(btnClear); acts.appendChild(btnOk);

  function guardarNota() {
    const val = inp.value.trim();
    // Aplicar nota a todas las variantes de este artId en el carrito
    Object.keys(carrito).forEach(k => {
      if (k === artId || k.startsWith(artId + '__v')) carrito[k].nota = val;
    });
    const btn = document.getElementById('btnnota-' + artId);
    if (btn) btn.classList.toggle('tiene-nota', !!val);
    document.getElementById('modal-overlay').classList.remove('open');
    if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
  }
};

// ── LISTENERS FIREBASE ────────────────────────────────────────────────────────
onValue(ref(db, 'mesas'), snap => { mesasData = snap.val() || {}; renderMesas(); });
onValue(ref(db, 'categorias'), snap => { categoriasData = snap.val() || {}; catsReady = true; if (cartaReady && mesaId) renderCarta(); });
onValue(ref(db, 'carta'), snap => { cartaData = snap.val() || {}; cartaReady = true; if (catsReady && mesaId) renderCarta(); });
onValue(ref(db, 'config/local'), snap => { configLocal = snap.val() || {}; });
onValue(ref(db, 'pedidos'), snap => {
  pedidosData = snap.val() || {};
  renderMesas();
});
onValue(ref(db, 'config/alertas'), snap => {
  const d = snap.val();
  if (d) alertasConfig = { verde: d.verde || 10, amarillo: d.amarillo || 20 };
});

// Banner offline
onValue(ref(db, '.info/connected'), snap => {
  const banner = document.getElementById('offline-banner');
  if (banner) banner.style.display = snap.val() ? 'none' : 'flex';
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
function fmtEu(n) {
  return Number(n || 0).toFixed(2).replace('.', ',') + ' €';
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

// ── MESAS CON COLORES Y ZONAS ─────────────────────────────────────────────────
function renderMesas() {
  const grid = document.getElementById('mesas-grid');
  const entries = Object.entries(mesasData)
    .sort(([,a],[,b]) => (a.orden??999)-(b.orden??999) || a.nombre.localeCompare(b.nombre,'es',{numeric:true}));

  if (!entries.length) {
    grid.classList.remove('zonas-layout');
    grid.innerHTML = '<div class="loading">Sin mesas.</div>';
    return;
  }

  const hayZonas = entries.some(([,m]) => m.zona && m.zona.trim());

  grid.innerHTML = '';
  grid.classList.toggle('zonas-layout', hayZonas);

  if (hayZonas) {
    const grupos = {};
    entries.forEach(([id, m]) => {
      const zona = m.zona?.trim() || 'Sin zona';
      if (!grupos[zona]) grupos[zona] = [];
      grupos[zona].push([id, m]);
    });
    Object.entries(grupos).forEach(([zona, mesas]) => {
      const groupEl = document.createElement('div');
      groupEl.className = 'zona-group';
      const header = document.createElement('div');
      header.className = 'zona-nombre';
      header.textContent = zona;
      groupEl.appendChild(header);
      const subGrid = document.createElement('div');
      subGrid.className = 'mesas-grid';
      mesas.forEach(([id, m]) => subGrid.appendChild(crearMesaBtn(id, m)));
      groupEl.appendChild(subGrid);
      grid.appendChild(groupEl);
    });
  } else {
    entries.forEach(([id, m]) => grid.appendChild(crearMesaBtn(id, m)));
  }
}

function crearMesaBtn(id, m) {
  const ocupada = m.estado === 'ocupada';
  let claseAlerta = ocupada ? 'ocupada' : 'libre';
  let alertaInfo  = '';

  if (ocupada && pedidosData[id]) {
    let lineasPend = [];
    Object.values(pedidosData[id]).forEach(envio => {
      const envioTs = Number(envio.ts) || 0;
      const ls = envio.lineas || { _: envio };
      Object.values(ls).forEach(l => {
        if (l.estado === 'pendiente') lineasPend.push({ ...l, _tsMesa: Number(l.ts) || envioTs });
      });
    });
    if (lineasPend.length) {
      const masAntigua = lineasPend.reduce((min, l) => l._tsMesa < min._tsMesa ? l : min, lineasPend[0]);
      const mins = Math.max(0, Math.floor((Date.now() - (masAntigua._tsMesa || Date.now())) / 60000));
      const minsTxt = mins === 0 ? '<1m' : `${mins}m`;
      const dest = masAntigua.destino === 'cocina' ? '&#127869;' : masAntigua.destino === 'barra' ? '&#127866;' : '&#127866;&#127869;';
      const pendienteTxt = lineasPend.length === 1 ? '1 pendiente' : `${lineasPend.length} pendientes`;
      if      (mins >= alertasConfig.amarillo) claseAlerta = 'alerta-danger';
      else if (mins >= alertasConfig.verde)    claseAlerta = 'alerta-warn';
      else                                     claseAlerta = 'alerta-ok';
      alertaInfo = `<span class="mesa-alerta-info">${dest} ${pendienteTxt} | ${minsTxt}</span>`;
    }
  }

  const div = document.createElement('div');
  div.className = 'mesa-btn ' + claseAlerta;
  div.innerHTML = `
    <span class="mesa-nombre">${m.nombre}</span>
    <span class="mesa-estado">${ocupada ? 'ocupada' : 'libre'}</span>
    <span class="mesa-resumen">${resumenMesaActual(id)}</span>
    ${alertaInfo}`;
  div.addEventListener('click', () => abrirMesa(id, m.nombre, ocupada));
  return div;
}

setInterval(() => {
  if (Object.keys(mesasData).length && document.getElementById('view-mesas').style.display !== 'none') {
    renderMesas();
  }
}, 30000);

function abrirMesa(id, nombre, ocupada) {
  mesaId = id; mesaNombre = nombre; carrito = {};
  document.getElementById('topbar-mesa').textContent = 'Mesa ' + nombre;
  document.getElementById('topbar-mesa').style.display = '';
  document.getElementById('btn-cuenta').style.display = ocupada ? '' : 'none';
  show('carta');
  if (cartaReady && catsReady) renderCarta();
  else document.getElementById('carta-body').innerHTML = '<div class="loading">Cargando carta…</div>';
  updateUI();
}

window.volverMesas = () => {
  mesaId = null; mesaNombre = null; carrito = {};
  ticketEditMode = false;
  document.getElementById('topbar-mesa').style.display = 'none';
  cerrarDrawer(); show('mesas');
  if (Object.keys(mesasData).length) renderMesas();
};

// ── CARTA ─────────────────────────────────────────────────────────────────────
function renderCarta() {
  const body = document.getElementById('carta-body');
  const cats = Object.entries(categoriasData).sort(([,a],[,b]) => a.nombre.localeCompare(b.nombre, 'es'));
  if (!cats.length) { body.innerHTML = '<div class="loading">Sin categorías.</div>'; return; }
  body.innerHTML = '';

  cats.forEach(([catId, cat]) => {
    const arts = Object.entries(cartaData)
      .filter(([,a]) => a.catId === catId)
      .sort(([,a],[,b]) => (a.orden ?? 999) - (b.orden ?? 999) || a.nombre.localeCompare(b.nombre, 'es'));
    if (!arts.length) return;

    const section = document.createElement('div');
    section.className = 'cat-section';
    section.id = 'cat-' + catId;

    const toggle = document.createElement('div');
    toggle.className = 'cat-toggle';
    toggle.id = 'cathdr-' + catId;
    toggle.innerHTML = `
      <span class="cat-nombre-label">${cat.nombre}</span>
      <span class="cat-count" id="catcount-${catId}"></span>
      <span class="cat-arrow">▾</span>`;
    toggle.addEventListener('click', () => toggleCat(section));
    section.appendChild(toggle);

    const itemsDiv = document.createElement('div');
    itemsDiv.className = 'cat-items';
    itemsDiv.style.maxHeight = '4000px';

    arts.forEach(([artId, art]) => {
      const agotado = art.disponible === false;
      const wrap = document.createElement('div');
      wrap.className = 'art-row' + (agotado ? ' art-agotado' : '');

      const mainRow = document.createElement('div');
      mainRow.className = 'art-main';

      // Alérgenos: botón compacto si los hay
      const alergenosBtn = art.alergenos?.length
        ? `<button class="btn-alergenos" data-artid="${artId}" title="Ver alérgenos">⚠</button>`
        : '';

      // Variantes: indicador
      const variantesLabel = art.variantes?.length
        ? `<span style="font-size:10px;color:var(--muted);font-family:var(--mono);margin-left:4px">${art.variantes.length} var.</span>`
        : '';

      mainRow.innerHTML = `
        <div style="flex:1;min-width:0">
          <div class="art-nombre">${art.nombre}${variantesLabel}</div>
          ${agotado ? '<div style="font-size:10px;color:var(--danger);font-family:var(--mono)">Agotado</div>' : ''}
        </div>
        <span class="art-precio">${Number(art.precio).toFixed(2)} €</span>
        ${alergenosBtn}
        <div class="qty-ctrl">
          <button class="qty-btn" data-id="${artId}" data-d="-1" ${agotado?'disabled':''}>−</button>
          <span class="qty-num" id="qty-${artId}">0</span>
          <button class="qty-btn" data-id="${artId}" data-d="1" ${agotado?'disabled':''}>+</button>
        </div>
        <button class="btn-nota" id="btnnota-${artId}" title="Añadir nota"
          onclick="abrirNotaModal('${artId}','${art.nombre.replace(/'/g,"\\'")}')" ${agotado?'disabled':''}>📝</button>`;
      wrap.appendChild(mainRow);

      // Panel de alérgenos (oculto por defecto)
      if (art.alergenos?.length) {
        const alergDiv = document.createElement('div');
        alergDiv.id = 'alerg-' + artId;
        alergDiv.className = 'alergenos-panel';
        alergDiv.style.display = 'none';
        alergDiv.textContent = '⚠ ' + art.alergenos.join(' · ');
        wrap.appendChild(alergDiv);
      }

      itemsDiv.appendChild(wrap);
    });

    section.appendChild(itemsDiv);
    body.appendChild(section);
  });

  // Evento delegado para botones qty
  body.onclick = e => {
    const btn = e.target.closest('[data-d]');
    if (btn) { cambiarQty(btn.dataset.id, parseInt(btn.dataset.d)); return; }
    const alergBtn = e.target.closest('.btn-alergenos');
    if (alergBtn) toggleAlergenos(alergBtn.dataset.artid);
  };

  // Rellenar selector de categorías en móvil
  const catSel = document.getElementById('cat-filter-sel');
  if (catSel) {
    catSel.innerHTML = '<option value="">Todas las categorías</option>';
    cats.forEach(([catId, cat]) => {
      const arts = Object.entries(cartaData).filter(([,a]) => a.catId === catId);
      if (!arts.length) return;
      catSel.innerHTML += `<option value="${catId}">${cat.nombre}</option>`;
    });
  }

  // Panel de categorías (popup móvil)
  const panel = document.getElementById('cats-panel');
  if (panel) {
    panel.innerHTML = '';
    cats.forEach(([catId, cat]) => {
      const arts = Object.entries(cartaData).filter(([,a]) => a.catId === catId);
      if (!arts.length) return;
      const item = document.createElement('div');
      item.style.cssText = 'padding:11px 16px;font-size:14px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;transition:background .1s';
      item.textContent = cat.nombre;
      item.addEventListener('pointerdown', () => item.style.background = 'var(--surface2)');
      item.addEventListener('click', () => {
        cerrarCatsPanel();
        const hdr = document.getElementById('cathdr-' + catId);
        if (hdr) hdr.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const sec = document.getElementById('cat-' + catId);
        if (sec && sec.classList.contains('collapsed')) toggleCat(sec);
      });
      panel.appendChild(item);
    });
  }
  const btnCats = document.getElementById('btn-cats');
  if (btnCats) btnCats.style.display = 'flex';

  // Tablet: panel lateral
  const tabletCats = document.getElementById('tablet-cats');
  if (tabletCats && window.innerWidth >= 768) {
    tabletCats.innerHTML = '';
    let primeraActiva = true;
    cats.forEach(([catId, cat]) => {
      const arts = Object.entries(cartaData).filter(([,a]) => a.catId === catId);
      if (!arts.length) return;
      const item = document.createElement('div');
      item.className = 'tablet-cat-item' + (primeraActiva ? ' activa' : '');
      item.dataset.catId = catId;
      const count = Object.entries(carrito)
        .filter(([k]) => k === catId || cartaData[k.split('__')[0]]?.catId === catId)
        .reduce((s,[,v]) => s + v.qty, 0);
      item.innerHTML = `<span>${cat.nombre}</span>${count > 0 ? `<span class="tablet-cat-count">${count}</span>` : ''}`;
      item.addEventListener('click', () => {
        document.querySelectorAll('.tablet-cat-item').forEach(i => i.classList.remove('activa'));
        item.classList.add('activa');
        document.querySelectorAll('.cat-section').forEach(s => s.classList.remove('tablet-visible'));
        const sec = document.getElementById('cat-' + catId);
        if (sec) sec.classList.add('tablet-visible');
        document.getElementById('carta-body').scrollTop = 0;
      });
      tabletCats.appendChild(item);
      if (primeraActiva) {
        primeraActiva = false;
        setTimeout(() => {
          document.querySelectorAll('.cat-section').forEach(s => s.classList.remove('tablet-visible'));
          const sec = document.getElementById('cat-' + catId);
          if (sec) sec.classList.add('tablet-visible');
        }, 0);
      }
    });
  }

  updateQtyDisplay();
  updateUI();
}

// Filtrar carta por categoría en móvil
window.filtrarCategoria = (catId) => {
  if (!catId) {
    document.querySelectorAll('.cat-section').forEach(s => {
      s.style.display = '';
      if (s.classList.contains('collapsed')) toggleCat(s);
    });
  } else {
    document.querySelectorAll('.cat-section').forEach(s => {
      const visible = s.id === 'cat-' + catId;
      s.style.display = visible ? '' : 'none';
      if (visible && s.classList.contains('collapsed')) toggleCat(s);
    });
  }
};

window.toggleAlergenos = (artId) => {
  const panel = document.getElementById('alerg-' + artId);
  if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
};

window.toggleCatsPanel = () => {
  const panel = document.getElementById('cats-panel');
  if (!panel) return;
  const abierto = panel.style.display !== 'none';
  panel.style.display = abierto ? 'none' : 'block';
};
window.cerrarCatsPanel = () => {
  const panel = document.getElementById('cats-panel');
  if (panel) panel.style.display = 'none';
};
document.addEventListener('click', e => {
  if (!e.target.closest('#cats-panel') && !e.target.closest('#btn-cats')) cerrarCatsPanel();
});

function toggleCat(section) {
  const items = section.querySelector('.cat-items');
  const collapsed = section.classList.toggle('collapsed');
  items.style.maxHeight = collapsed ? '0' : '4000px';
}

// ── CARRITO ───────────────────────────────────────────────────────────────────
function cambiarQty(artId, delta) {
  const art = cartaData[artId];
  if (!art) return;

  // Artículo con variantes: mostrar modal al sumar
  if (delta > 0 && art.variantes?.length) {
    abrirVarianteModal(artId, art);
    return;
  }

  // Artículo con variantes: restar la última variante añadida
  if (delta < 0 && art.variantes?.length) {
    const varKeys = Object.keys(carrito).filter(k => k.startsWith(artId + '__v'));
    if (varKeys.length) {
      const lastKey = varKeys[varKeys.length - 1];
      const prev = carrito[lastKey].qty;
      const next = Math.max(0, prev + delta);
      if (next === 0) delete carrito[lastKey];
      else carrito[lastKey] = { ...carrito[lastKey], qty: next };
      updateQtyDisplay();
      updateUI();
      if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
    }
    return;
  }

  // Artículo simple
  const prev = carrito[artId]?.qty || 0;
  const nota = carrito[artId]?.nota || '';
  const next = Math.max(0, prev + delta);
  if (next === 0) delete carrito[artId];
  else carrito[artId] = { art, qty: next, nota };
  updateQtyDisplay();
  updateUI();
  if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
}

function abrirVarianteModal(artId, art) {
  let selIdx = null;
  let qty = 1;

  const modalTitle = document.getElementById('modal-title');
  const modalBody  = document.getElementById('modal-body');
  const acts       = document.getElementById('modal-actions');
  modalTitle.textContent = art.nombre;

  function render() {
    modalBody.innerHTML =
      '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">Elige variante y cantidad:</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px">' +
      art.variantes.map((v, i) => {
        const sel = selIdx === i;
        return (
          `<div style="border-radius:12px;border:1px solid ${sel ? 'var(--accent2)' : 'var(--border)'};overflow:hidden;background:${sel ? 'rgba(61,122,255,.06)' : 'var(--surface3)'}">` +
          `<button data-varidx="${i}" style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;width:100%;background:none;border:none;cursor:pointer;font-size:14px;color:${sel ? 'var(--accent2)' : 'var(--text)'}">` +
          `<span>${v.nombre}</span>` +
          `<span style="font-family:var(--mono)">${Number(v.precio).toFixed(2)} €</span>` +
          `</button>` +
          (sel
            ? `<div style="display:flex;align-items:center;gap:10px;border-top:1px solid rgba(61,122,255,.2);padding:8px 16px">` +
              `<span style="font-size:12px;color:var(--muted);flex:1">Cantidad:</span>` +
              `<button id="vqty-minus" style="width:32px;height:32px;border-radius:8px 0 0 8px;border:1px solid var(--border);background:var(--surface3);font-size:18px;cursor:pointer">−</button>` +
              `<span id="vqty-num" style="width:36px;height:32px;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:14px;font-weight:700;border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:#fff">${qty}</span>` +
              `<button id="vqty-plus" style="width:32px;height:32px;border-radius:0 8px 8px 0;border:1px solid var(--border);background:var(--surface3);font-size:18px;cursor:pointer">＋</button>` +
              `</div>`
            : '') +
          `</div>`
        );
      }).join('') + '</div>';

    acts.innerHTML =
      '<button class="modal-btn" id="vbtn-cancel">Cancelar</button>' +
      `<button class="modal-btn primary" id="vbtn-add"${selIdx === null ? ' disabled' : ''}>` +
        (selIdx !== null ? `Añadir ${qty}` : 'Añadir') +
      `</button>`;

    document.getElementById('vbtn-cancel').onclick = () =>
      document.getElementById('modal-overlay').classList.remove('open');

    const btnAdd = document.getElementById('vbtn-add');
    if (btnAdd && selIdx !== null) {
      btnAdd.onclick = () => {
        document.getElementById('modal-overlay').classList.remove('open');
        seleccionarVariante(artId, selIdx, qty);
      };
    }

    modalBody.querySelectorAll('[data-varidx]').forEach(btn => {
      btn.addEventListener('click', () => {
        selIdx = parseInt(btn.dataset.varidx);
        qty = 1;
        render();
      });
    });

    const minus = document.getElementById('vqty-minus');
    const plus  = document.getElementById('vqty-plus');
    if (minus) minus.addEventListener('click', e => { e.stopPropagation(); if (qty > 1) { qty--; render(); } });
    if (plus)  plus.addEventListener('click',  e => { e.stopPropagation(); qty++; render(); });
  }

  render();
  document.getElementById('modal-overlay').classList.add('open');
}

window.seleccionarVariante = (artId, variantIdx, qty = 1) => {
  const art = cartaData[artId];
  if (!art?.variantes?.[variantIdx]) return;
  const variante = art.variantes[variantIdx];
  const carritoKey = artId + '__v' + variantIdx;
  const artConVariante = { ...art, precio: variante.precio, nombre: art.nombre + ' (' + variante.nombre + ')' };
  const prev = carrito[carritoKey]?.qty || 0;
  const nota = carrito[carritoKey]?.nota || '';
  carrito[carritoKey] = { art: artConVariante, qty: prev + qty, nota };
  updateQtyDisplay();
  updateUI();
  if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
};

window.actualizarNota = (artId, valor) => {
  if (carrito[artId]) {
    carrito[artId].nota = valor.trim();
    if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
  }
};

function updateQtyDisplay() {
  // Para cada artículo de la carta, sumar todas las entradas del carrito
  Object.keys(cartaData).forEach(id => {
    const el = document.getElementById('qty-' + id);
    if (!el) return;
    const totalQty = Object.entries(carrito)
      .filter(([k]) => k === id || k.startsWith(id + '__v'))
      .reduce((s, [, item]) => s + item.qty, 0);
    el.textContent = totalQty;
    el.className = 'qty-num' + (totalQty > 0 ? ' has-qty' : '');
    const btnNota = document.getElementById('btnnota-' + id);
    if (btnNota) {
      const hasNota = Object.entries(carrito).some(([k, v]) => (k === id || k.startsWith(id + '__v')) && v.nota);
      btnNota.classList.toggle('tiene-nota', hasNota);
    }
  });

  // Contador por categoría
  Object.entries(categoriasData).forEach(([catId]) => {
    const el = document.getElementById('catcount-' + catId);
    if (!el) return;
    const arts = Object.entries(cartaData).filter(([,a]) => a.catId === catId);
    const total = arts.reduce((s, [id]) => {
      return s + Object.entries(carrito)
        .filter(([k]) => k === id || k.startsWith(id + '__v'))
        .reduce((ss, [, v]) => ss + v.qty, 0);
    }, 0);
    el.textContent = total > 0 ? total : '';
    el.classList.toggle('visible', total > 0);
  });
}

function updateUI() {
  const n = Object.keys(carrito).length;
  const totalUds = Object.values(carrito).reduce((s, {qty}) => s + qty, 0);
  const total = Object.values(carrito).reduce((s, {art, qty}) => s + Number(art.precio) * qty, 0);

  document.getElementById('res-lineas').textContent = n ? `${totalUds} ud${totalUds > 1 ? 's' : ''}` : 'Sin artículos';
  document.getElementById('res-total').textContent = total.toFixed(2).replace('.', ',') + ' €';
  document.getElementById('btn-enviar').disabled = n === 0;

  const btnC = document.getElementById('btn-carrito');
  if (n > 0) {
    btnC.classList.add('tiene');
    document.getElementById('carrito-count').textContent = totalUds;
    document.getElementById('carrito-label').textContent = total.toFixed(2).replace('.', ',') + ' €';
  } else {
    btnC.classList.remove('tiene');
  }

  document.getElementById('drawer-total').textContent = total.toFixed(2).replace('.', ',') + ' €';
  document.getElementById('btn-enviar-drawer').disabled = n === 0;
}

// ── DRAWER ────────────────────────────────────────────────────────────────────
window.abrirDrawer = () => {
  renderDrawer();
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer-overlay').classList.add('open');
};

window.cerrarDrawer = () => {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('open');
};

function renderDrawer() {
  const body = document.getElementById('drawer-body');
  document.getElementById('drawer-title').textContent = mesaNombre ? 'Mesa ' + mesaNombre : 'Pedido';

  const items = Object.entries(carrito);
  if (!items.length) { body.innerHTML = '<div class="drawer-empty">Sin artículos aún</div>'; return; }

  body.innerHTML = '';
  items.forEach(([carritoKey, {art, qty, nota}]) => {
    const wrap = document.createElement('div');
    wrap.className = 'ri-wrap';

    const main = document.createElement('div');
    main.className = 'ri-main';
    main.innerHTML = `
      <span class="ri-nombre">${art.nombre}</span>
      <div class="ri-qty-ctrl">
        <button class="ri-qty-btn" onclick="drawerCambiarQty('${carritoKey}',-1)">−</button>
        <span class="ri-qty-num" id="dqty-${carritoKey}">${qty}</span>
        <button class="ri-qty-btn" onclick="drawerCambiarQty('${carritoKey}',1)">+</button>
      </div>
      <span class="ri-precio" id="dprecio-${carritoKey}">${(Number(art.precio) * qty).toFixed(2)} €</span>`;
    wrap.appendChild(main);

    const notaRow = document.createElement('div');
    notaRow.className = 'ri-nota-row';
    notaRow.innerHTML = `
      <span class="ri-nota-label">Nota:</span>
      <input class="ri-nota-input" type="text"
        placeholder="ej: poco hecho, sin cebolla…"
        value="${(nota || '').replace(/"/g, '&quot;')}"
        oninput="drawerNota('${carritoKey}', this.value)" />`;
    wrap.appendChild(notaRow);
    body.appendChild(wrap);
  });
}

window.drawerCambiarQty = (carritoKey, delta) => {
  if (carrito[carritoKey]) {
    const prev = carrito[carritoKey].qty;
    const next = Math.max(0, prev + delta);
    if (next === 0) delete carrito[carritoKey];
    else carrito[carritoKey].qty = next;
    updateQtyDisplay();
    updateUI();
    const qtyEl    = document.getElementById('dqty-' + carritoKey);
    const precioEl = document.getElementById('dprecio-' + carritoKey);
    if (carrito[carritoKey]) {
      if (qtyEl)    qtyEl.textContent = carrito[carritoKey].qty;
      if (precioEl) precioEl.textContent = (Number(carrito[carritoKey].art.precio) * carrito[carritoKey].qty).toFixed(2) + ' €';
    } else {
      renderDrawer();
    }
  }
};

window.drawerNota = (carritoKey, valor) => {
  if (carrito[carritoKey]) carrito[carritoKey].nota = valor.trim();
};

// ── IMPRESIÓN ─────────────────────────────────────────────────────────────────
const iframeComanda = document.createElement('iframe');
iframeComanda.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none';
document.body.appendChild(iframeComanda);

function getTicketPaperConfig(configLocal) {
  const paper = String(configLocal?.ticketPaper || configLocal?.papelTicket || '58mm').toLowerCase();
  const fontSize = Number(configLocal?.ticketFontSize || (paper.includes('80') ? 10 : 9));
  const uppercase = configLocal?.ticketUppercase === true;
  const marginX = Number(configLocal?.ticketMarginX ?? 3);
  const marginY = Number(configLocal?.ticketMarginY ?? 3);
  if (paper.includes('80')) {
    return { paper: '80mm', width: '80mm', bodyWidth: '72mm', chars: 48, fontSize, uppercase, marginX, marginY };
  }
  return { paper: '58mm', width: '58mm', bodyWidth: '50mm', chars: 32, fontSize, uppercase, marginX, marginY };
}

function wrapTicketLine(text, maxChars) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  const out = [];
  let rest = clean;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut < 1) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function renderTicketRowsHTML(lineas, maxChars, conPrecio) {
  const nameChars = conPrecio ? Math.max(14, maxChars - 12) : Math.max(20, maxChars - 4);
  return lineas.map(l => {
    const nombreLineas = wrapTicketLine(l.nombre, nameChars);
    const primera = nombreLineas.shift() || '';
    const totalTxt = conPrecio ? `${(Number(l.precio) * Number(l.qty)).toFixed(2)}€` : '';
    const extras = [];
    nombreLineas.forEach(n => extras.push(`<div class="ticket-subline">${n}</div>`));
    if (l.nota) extras.push(`<div class="ticket-note">-> ${l.nota}</div>`);

    return `
      <div class="print-line">
        <div class="print-line-top">
          <span class="print-qty">${l.qty}x</span>
          <span class="print-name">${primera}</span>
          ${conPrecio ? `<span class="print-price">${totalTxt}</span>` : ''}
        </div>
        ${extras.join('')}
      </div>`;
  }).join('');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function abrirImpresionTicket({ titulo, subtitulo, lineas, configLocal, mostrarPrecio = false, mostrarTotal = false, total = 0, pie = '', mostrarLogo = false }) {
  const paperCfg = getTicketPaperConfig(configLocal);
  const logoHtml = mostrarLogo && configLocal?.ticketLogoUrl
    ? `<div class="ticket-logo-wrap"><img class="ticket-logo" src="${escapeHtml(configLocal.ticketLogoUrl)}" alt="Logo" /></div>`
    : '';
  const cabecera = (configLocal?.nombre || configLocal?.direccion || configLocal?.telefono || configLocal?.cif)
    ? `<div class="local">${logoHtml}${configLocal?.nombre ? `<div class="local-name">${configLocal.nombre}</div>` : ''}${configLocal?.direccion ? `<div class="local-line">${configLocal.direccion}</div>` : ''}${configLocal?.telefono ? `<div class="local-line">${configLocal.telefono}</div>` : ''}${configLocal?.cif ? `<div class="local-line">${configLocal.cif}</div>` : ''}</div>`
    : logoHtml;
  const rows = renderTicketRowsHTML(lineas, paperCfg.chars, mostrarPrecio);
  const totalHtml = mostrarTotal
    ? `<div class="print-total"><span>Total</span><span>${fmtEu(total)}</span></div>`
    : '';
  const footerHtml = pie
    ? `<div class="print-footer">${pie}</div>`
    : '';

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    @page{size:${paperCfg.width} auto;margin:0}
    body{font-family:monospace;font-size:${paperCfg.fontSize}px;width:${paperCfg.bodyWidth};padding:${paperCfg.marginY}mm ${paperCfg.marginX}mm;color:#111;${paperCfg.uppercase ? 'text-transform:uppercase;' : ''}}
    .local{text-align:center;color:#555;border-bottom:1px dashed #ccc;padding-bottom:6px;margin-bottom:8px}
    .local-name{font-size:${paperCfg.fontSize + 3}px;font-weight:bold;letter-spacing:.02em}
    .local-line{font-size:${Math.max(9, paperCfg.fontSize - 1)}px;line-height:1.35}
    .ticket-logo-wrap{text-align:center;margin-bottom:6px}
    .ticket-logo{max-width:100%;max-height:${paperCfg.paper === '80mm' ? '70px' : '52px'};object-fit:contain}
    h2{font-size:${paperCfg.fontSize + 4}px;font-weight:bold;margin-bottom:2px;text-align:center}
    .sub{font-size:${Math.max(9, paperCfg.fontSize - 1)}px;color:#777;margin-bottom:10px;text-align:center}
    .print-line{padding:4px 0;border-bottom:1px solid #eee}
    .print-line:last-of-type{border-bottom:none}
    .print-line-top{display:flex;gap:6px;align-items:flex-start}
    .print-qty{font-weight:bold;white-space:nowrap}
    .print-name{flex:1;min-width:0}
    .print-price{text-align:right;white-space:nowrap;padding-left:6px}
    .ticket-subline{padding-left:24px}
    .ticket-note{padding-left:24px;font-size:10px;color:#666;font-style:italic}
    .print-total{display:flex;justify-content:space-between;border-top:1px dashed #999;margin-top:8px;padding-top:8px;font-weight:bold}
    .print-footer{text-align:center;font-size:11px;color:#666;margin-top:10px;padding-top:8px;border-top:1px dashed #ccc}
    @media print{body{width:${paperCfg.bodyWidth};padding:${paperCfg.marginY}mm ${paperCfg.marginX}mm}}
  </style></head><body>
  ${cabecera}
  <h2>${titulo}</h2>
  <div class="sub">${subtitulo}</div>
  ${rows}
  ${totalHtml}
  ${footerHtml}
  <script>window.onload=()=>setTimeout(()=>window.print(),60)<\/script>
  </body></html>`;

  iframeComanda.srcdoc = html;
}

function generarPDFComanda(nombreMesa, lineas, configLocal) {
  const ahora = new Date();
  const hora  = ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const fecha = ahora.toLocaleDateString('es-ES');
  abrirImpresionTicket({
    titulo: `Mesa ${nombreMesa}`,
    subtitulo: `${fecha} · ${hora}`,
    lineas,
    configLocal,
    mostrarPrecio: false,
    mostrarTotal: false,
    mostrarLogo: false
  });
}

function generarTXTComanda(nombreMesa, lineas, configLocal) {
  const ahora = new Date();
  const hora  = ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const fecha = ahora.toLocaleDateString('es-ES');
  const ts    = `${String(ahora.getHours()).padStart(2,'0')}${String(ahora.getMinutes()).padStart(2,'0')}${String(ahora.getSeconds()).padStart(2,'0')}`;
  const sep   = '--------------------------------';
  let txt = '';
  if (configLocal?.nombre)    txt += configLocal.nombre + '\n';
  if (configLocal?.direccion) txt += configLocal.direccion + '\n';
  txt += sep + '\n';
  txt += `Mesa ${nombreMesa}\n${fecha}  ${hora}\n${sep}\n`;
  lineas.forEach(l => {
    txt += `${l.qty}x ${l.nombre}\n`;
    if (l.nota) txt += `   -> ${l.nota}\n`;
  });
  txt += sep + '\n';
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `comanda-mesa${nombreMesa}-${ts}.txt`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── CUOTA ─────────────────────────────────────────────────────────────────────
let quotaActual = null;

onValue(ref(db, 'config/quota/lineas'), snap => {
  quotaActual = snap.val() ?? null;
  renderQuotaBadge();
});

function renderQuotaBadge() {
  const badge = document.getElementById('quota-badge');
  if (!badge) return;
  if (quotaActual === null || quotaActual === -1) { badge.style.display = 'none'; return; }
  if (quotaActual <= 0) {
    badge.style.cssText = 'display:inline-flex;background:rgba(229,53,53,.12);color:#e53535;border-color:rgba(229,53,53,.3)';
    badge.textContent = '⚠ Sin líneas';
  } else if (quotaActual <= 200) {
    badge.style.cssText = 'display:inline-flex;background:rgba(229,150,53,.12);color:#e57a35;border-color:rgba(229,150,53,.3)';
    badge.textContent = '⚠ ' + quotaActual + ' líneas restantes';
  } else {
    badge.style.display = 'none';
  }
}

// ── LOG DE MODIFICACIONES ─────────────────────────────────────────────────────
async function logAccion(mesaId, envioId, accion, detalle) {
  try {
    await push(ref(db, `pedidos/${mesaId}/${envioId}/log`), {
      ts: Date.now(), accion, usuario: camareroActual, detalle: String(detalle || '')
    });
  } catch(e) {}
}

// ── ENVIAR PEDIDO ─────────────────────────────────────────────────────────────
window.enviarPedido = async () => {
  if (!mesaId || !Object.keys(carrito).length) return;

  const nLineas = Object.keys(carrito).length;

  if (quotaActual !== null && quotaActual !== -1) {
    if (quotaActual <= 0) {
      showModal({
        title: 'Límite de pedidos alcanzado',
        body: 'Se han agotado las líneas de pedido incluidas en el plan. Contacta con el administrador.',
        buttons: [{ label: 'Entendido', style: 'primary' }]
      });
      return;
    }
    if (quotaActual < nLineas) {
      showModal({
        title: 'Líneas insuficientes',
        body: `Quedan ${quotaActual} líneas y el pedido tiene ${nLineas}. Reduce el pedido o contacta con el administrador.`,
        buttons: [{ label: 'Entendido', style: 'primary' }]
      });
      return;
    }
  }

  const btn1 = document.getElementById('btn-enviar');
  const btn2 = document.getElementById('btn-enviar-drawer');
  btn1.disabled = true; btn1.textContent = '…';
  btn2.disabled = true; btn2.textContent = '…';

  await set(ref(db, 'mesas/' + mesaId + '/estado'), 'ocupada');
  document.getElementById('btn-cuenta').style.display = '';

  const lineasImprimir = [];
  const envioTs  = Date.now();
  const envioId  = envioTs + '_' + mesaId;
  const lineasObj = {};

  Object.entries(carrito).forEach(([carritoKey, {art, qty, nota}]) => {
    const artId = carritoKey.split('__')[0];
    lineasObj[carritoKey] = {
      artId, nombre: art.nombre, precio: Number(art.precio),
      qty, destino: art.destino, estado: 'pendiente',
      nota: nota || '', camarero: camareroActual
    };
    lineasImprimir.push({ nombre: art.nombre, precio: Number(art.precio), qty, nota: nota || '' });
  });

  await set(ref(db, `pedidos/${mesaId}/${envioId}`), {
    ts: envioTs, camarero: camareroActual, envioId,
    lineas: lineasObj
  });

  // Log
  await logAccion(mesaId, envioId, 'enviado', `${nLineas} líneas`);

  if (quotaActual !== null && quotaActual !== -1) {
    await set(ref(db, 'config/quota/lineas'), quotaActual - nLineas);
    const restante = quotaActual - nLineas;
    if (restante > 0 && restante <= 100) {
      setTimeout(() => showModal({
        title: 'Pocas líneas restantes',
        body: `Quedan ${restante} líneas disponibles.`,
        buttons: [{ label: 'Entendido' }]
      }), 800);
    }
  }

  const ahora2 = new Date();
  const mesKey = `${ahora2.getFullYear()}-${String(ahora2.getMonth()+1).padStart(2,'0')}`;
  const statsRef = ref(db, 'config/stats/' + mesKey + '/lineas');
  const statsSnap = await get(statsRef);
  await set(statsRef, (statsSnap.val() || 0) + nLineas);

  if (autoPDF) generarPDFComanda(mesaNombre, lineasImprimir, configLocal);
  if (autoTXT) generarTXTComanda(mesaNombre, lineasImprimir, configLocal);

  carrito = {};
  cerrarDrawer();
  updateQtyDisplay();
  updateUI();
  btn1.textContent = '✓ Enviado'; btn1.disabled = false;
  btn2.textContent = 'Enviar pedido';
  setTimeout(() => { btn1.textContent = 'Enviar'; updateUI(); }, 1800);
};

// ── CUENTA / TICKET ───────────────────────────────────────────────────────────
async function cargarTicketActual() {
  if (!mesaId) return;
  const snap = await get(ref(db, 'pedidos/' + mesaId));
  renderTicket(snap.val() || {});
}

window.verCuenta = async () => {
  if (!mesaId) return;
  const btn = document.getElementById('btn-edit-ticket');
  if (btn) btn.textContent = ticketEditMode ? 'Listo' : 'Editar cuenta';
  await cargarTicketActual();
  show('ticket');
};

function actualizarEstadoBotonTicket(texto, restaurar = true) {
  const btn = document.querySelector('#ticket-card .btn-print');
  if (!btn) return;
  const previo = btn.dataset.prevText || btn.textContent || 'Imprimir ticket';
  if (!btn.dataset.prevText) btn.dataset.prevText = previo;
  btn.textContent = texto;
  if (restaurar) {
    setTimeout(() => {
      btn.textContent = btn.dataset.prevText || 'Imprimir ticket';
      delete btn.dataset.prevText;
    }, 1800);
  }
}

async function enviarTicketFinalAServicio(lineasServidas, total) {
  const paperCfg = getTicketPaperConfig(configLocal);
  const serviceId = String(configLocal?.ticketPrintServiceId || 'local-print-service-1').trim() || 'local-print-service-1';
  const payload = {
    kind: 'ticket_final',
    status: 'pending',
    createdAt: Date.now(),
    serviceId,
    requestedBy: camareroActual || '',
    mesaId: mesaId || '',
    mesaNombre: mesaNombre || '',
    local: {
      nombre: configLocal?.nombre || '',
      direccion: configLocal?.direccion || '',
      telefono: configLocal?.telefono || '',
      cif: configLocal?.cif || '',
      footer: configLocal?.footer || ''
    },
    format: {
      paper: paperCfg.paper,
      fontSize: paperCfg.fontSize,
      uppercase: paperCfg.uppercase === true
    },
    total: Math.round(Number(total || 0) * 100) / 100,
    lines: lineasServidas.map(l => ({
      nombre: l.nombre,
      qty: Number(l.qtyCuenta || 0),
      precio: Math.round(Number(l.precio || 0) * 100) / 100,
      nota: limpiarNotaTicket(l.nota)
    }))
  };
  await push(ref(db, 'print_jobs'), payload);
}

async function imprimirTicketFinal(lineasServidas, total) {
  const mode = String(configLocal?.ticketPrintMode || 'browser');
  const fecha = new Date().toLocaleString('es-ES', { dateStyle:'short', timeStyle:'short' });

  if (mode === 'service' || mode === 'both') {
    try {
      await enviarTicketFinalAServicio(lineasServidas, total);
      actualizarEstadoBotonTicket(mode === 'both' ? 'Enviado al servicio + local' : 'Enviado al servicio');
    } catch (err) {
      console.error('Error enviando ticket al servicio', err);
      showModal({
        title: 'Error de impresión remota',
        body: 'No se pudo enviar el ticket al servicio Python. Puedes reintentarlo o usar el modo navegador.',
        buttons: [{ label: 'Cerrar', style: 'primary' }]
      });
      if (mode === 'service') return;
    }
  }

  if (mode === 'service') {
    return;
  }

  abrirImpresionTicket({
    titulo: `Mesa ${mesaNombre}`,
    subtitulo: fecha,
    lineas: lineasServidas.map(l => ({
      nombre: l.nombre,
      qty: l.qtyCuenta,
      precio: Number(l.precio),
      nota: limpiarNotaTicket(l.nota)
    })),
    configLocal,
    mostrarPrecio: true,
    mostrarTotal: true,
    total,
    pie: configLocal?.footer || '',
    mostrarLogo: true
  });
}

function aplanarPedidos(pedidos) {
  const lineas = [];
  Object.entries(pedidos).forEach(([envioId, envio]) => {
    const ls = envio.lineas || { [envioId]: envio };
    Object.entries(ls).forEach(([artId, l]) => {
      lineas.push({ envioId, artId, ...l });
    });
  });
  return lineas;
}

function qtyEnCuenta(linea) {
  if (linea.qtyTicket !== undefined && linea.qtyTicket !== null) return Number(linea.qtyTicket || 0);
  return qtyMaxEnCuenta(linea);
}

function qtyMaxEnCuenta(linea) {
  if (linea.estado === 'servido') return Number(linea.qty || 0);
  return Number(linea.qtyServida || 0);
}

function limpiarNotaTicket(nota) {
  return (nota || '')
    .replace(/Comprobar/g, '').replace(/Verificado/g, '')
    .replace(/⚠️/g, '').replace(/✅/g, '')
    .replace(/Â·/g, '').replace(/\s+/g, ' ').trim();
}

function renderTicket(pedidos) {
  const todasLineas = aplanarPedidos(pedidos);

  const lineasServidas = todasLineas
    .map(l => {
      const qtyCuenta = qtyEnCuenta(l);
      const qtyMax    = qtyMaxEnCuenta(l);
      return { ...l, qtyOriginal: l.qty, qtyCuenta, qtyMax };
    })
    .filter(l => l.qtyCuenta > 0)
    .sort((a, b) => (a.envioId || '').localeCompare(b.envioId || '') || a.nombre.localeCompare(b.nombre, 'es'));

  window._tLineas = lineasServidas;

  if (!lineasServidas.length) {
    document.getElementById('ticket-card').innerHTML =
      '<div class="ticket-edit-hint">No hay artículos servidos aún</div>' +
      '<div class="ticket-total"><span>Total</span><span>' + fmtEu(0) + '</span></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:1rem">' +
        '<button class="btn-transferir no-print" style="flex:1;background:none;color:var(--muted);border:1px solid var(--border);border-radius:12px;padding:10px;font-family:var(--mono);font-size:13px;cursor:pointer">Transferir</button>' +
      '</div>' +
      '<button class="btn-cerrar">Cerrar mesa y limpiar</button>';
    document.getElementById('ticket-card').onclick = e => {
      if (e.target.classList.contains('btn-cerrar')) cerrarMesa();
      else if (e.target.classList.contains('btn-transferir')) abrirTransferirMesaModal();
    };
    return;
  }

  const total = lineasServidas.reduce((s, l) => s + Number(l.precio) * l.qtyCuenta, 0);
  const totalUds = lineasServidas.filter(l => l.destino !== 'descuento').reduce((s, l) => s + l.qtyCuenta, 0);
  const fecha = new Date().toLocaleString('es-ES', { dateStyle:'short', timeStyle:'short' });
  const loc = configLocal;

  const cab =
    (loc.nombre ? '<div style="font-size:18px;font-weight:500;font-family:var(--mono)">' + loc.nombre + '</div>' : '') +
    (loc.direccion ? '<div style="font-size:12px;color:var(--muted);margin-top:2px">' + loc.direccion + '</div>' : '') +
    (loc.telefono ? '<div style="font-size:12px;color:var(--muted)">' + loc.telefono + '</div>' : '') +
    (loc.cif ? '<div style="font-size:11px;color:var(--muted)">' + loc.cif + '</div>' : '');
  const pie = loc.footer
    ? '<div style="text-align:center;font-size:12px;color:var(--muted);margin-top:1rem;padding-top:.75rem;border-top:1px dashed var(--border)">' + loc.footer + '</div>'
    : '';

  const lineasHTML = lineasServidas.map((l, i) => {
    const notaVisible = limpiarNotaTicket(l.nota);
    const esDescuento = l.destino === 'descuento';
    const controlesEdicion = (!esDescuento && ticketEditMode)
      ? '<div class="ticket-qty-edit no-print">' +
        '<button class="ticket-qty-btn" data-accion="restar" data-idx="' + i + '"' + (l.qtyCuenta <= 1 ? ' disabled' : '') + '>-</button>' +
        '<span class="ticket-qty-num">' + l.qtyCuenta + '</span>' +
        '<button class="ticket-qty-btn" data-accion="sumar" data-idx="' + i + '">+</button>' +
      '</div>'
      : '';
    return '<div class="ticket-linea ticket-linea-edit' + (esDescuento ? ' ticket-descuento' : '') + '">' +
      '<div style="flex:1">' +
        '<div>' + (esDescuento ? '' : l.qtyCuenta + 'x ') + l.nombre + '</div>' +
        (notaVisible ? '<div class="no-print" style="font-size:11px;color:var(--muted);font-style:italic">-> ' + notaVisible + '</div>' : '') +
        (l.verificado ? '<span class="nota-verificado no-print">Verificado</span>' : '') +
      '</div>' +
      controlesEdicion +
      '<span class="ticket-linea-precio" style="' + (esDescuento ? 'color:var(--success)' : '') + '">' + fmtEu(Number(l.precio) * l.qtyCuenta) + '</span>' +
      (!esDescuento && !ticketEditMode ? '<button class="btn-quitar-linea" data-idx="' + i + '" title="Devolver a barra/cocina">x</button>' : '') +
    '</div>';
  }).join('');

  const textoHint = ticketEditMode
    ? 'Modo edición: ajusta cantidades sin reenviar nada a barra o cocina'
    : 'Cuenta actual: ' + totalUds + ' uds | ' + fmtEu(total);

  document.getElementById('ticket-card').innerHTML =
    '<div class="ticket-header">' +
      cab +
      '<div style="margin-top:' + (loc.nombre ? '.75rem' : '0') + '">' +
        '<div class="ticket-mesa">Mesa ' + mesaNombre + '</div>' +
        '<div class="ticket-fecha">' + fecha + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="ticket-edit-hint">' + textoHint + '</div>' +
    lineasHTML +
    '<div class="ticket-total"><span>Total</span><span>' + fmtEu(total) + '</span></div>' +
    pie +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:1rem">' +
      '<button class="btn-descuento no-print" style="flex:1;background:rgba(53,199,119,.1);color:var(--success);border:1px solid rgba(53,199,119,.3);border-radius:12px;padding:10px;font-family:var(--mono);font-size:13px;cursor:pointer">＋ Descuento</button>' +
      '<button class="btn-partir no-print" style="flex:1;background:none;color:var(--accent2);border:1px solid rgba(61,122,255,.3);border-radius:12px;padding:10px;font-family:var(--mono);font-size:13px;cursor:pointer">Partir cuenta</button>' +
      '<button class="btn-transferir no-print" style="flex:1;background:none;color:var(--muted);border:1px solid var(--border);border-radius:12px;padding:10px;font-family:var(--mono);font-size:13px;cursor:pointer">Transferir</button>' +
    '</div>' +
    '<button class="btn-print no-print-btn">Imprimir ticket</button>' +
    '<button class="btn-refresh no-print">Actualizar ticket</button>' +
    '<button class="btn-cerrar">Cerrar mesa y limpiar</button>';

  const card = document.getElementById('ticket-card');
  card.onclick = async e => {
    if (e.target.classList.contains('ticket-qty-btn')) {
      const i     = parseInt(e.target.dataset.idx);
      const delta = e.target.dataset.accion === 'sumar' ? 1 : -1;
      await editarCantidadTicket(i, delta);
    } else if (e.target.classList.contains('btn-quitar-linea')) {
      await quitarDelTicket(parseInt(e.target.dataset.idx));
    } else if (e.target.classList.contains('btn-print') || e.target.classList.contains('no-print-btn')) {
      await imprimirTicketFinal(lineasServidas, total);
    } else if (e.target.classList.contains('btn-refresh')) {
      await cargarTicketActual();
    } else if (e.target.classList.contains('btn-cerrar')) {
      cerrarMesa();
    } else if (e.target.classList.contains('btn-descuento')) {
      abrirDescuentoModal();
    } else if (e.target.classList.contains('btn-partir')) {
      abrirPartirCuentaModal(total);
    } else if (e.target.classList.contains('btn-transferir')) {
      abrirTransferirMesaModal();
    }
  };
}

window.toggleEditarCuenta = () => {
  ticketEditMode = !ticketEditMode;
  const btn = document.getElementById('btn-edit-ticket');
  if (btn) btn.textContent = ticketEditMode ? 'Listo' : 'Editar cuenta';
  cargarTicketActual();
};

async function editarCantidadTicket(i, delta) {
  const l = window._tLineas?.[i];
  if (!l) return;
  const nuevaQty = Math.max(1, l.qtyCuenta + delta);
  const path = 'pedidos/' + mesaId + '/' + l.envioId + '/lineas/' + l.artId + '/qtyTicket';
  if (nuevaQty === qtyMaxEnCuenta(l)) await set(ref(db, path), null);
  else await set(ref(db, path), nuevaQty);
  await logAccion(mesaId, l.envioId, 'cantidad_editada', `${l.artId}: ${l.qtyCuenta}→${nuevaQty}`);
  await cargarTicketActual();
}

async function quitarDelTicket(i) {
  const l = window._tLineas?.[i];
  if (!l) return;
  const { envioId, artId } = l;
  const notaBase = (l.nota || '')
    .replace(/\s*·?\s*⚠️\s*Comprobar/g, '').replace(/\s*·?\s*✅\s*Verificado/g, '').trim();
  const updates = {
    [`pedidos/${mesaId}/${envioId}/lineas/${artId}/verificado`]: false,
    [`pedidos/${mesaId}/${envioId}/lineas/${artId}/qtyServida`]: null,
    [`pedidos/${mesaId}/${envioId}/lineas/${artId}/qtyTicket`]: null,
    [`pedidos/${mesaId}/${envioId}/lineas/${artId}/nota`]: (notaBase ? notaBase + ' · ' : '') + '⚠️ Comprobar',
  };
  if (l.estado === 'servido') updates[`pedidos/${mesaId}/${envioId}/lineas/${artId}/estado`] = 'pendiente';
  await update(ref(db), updates);
  await logAccion(mesaId, envioId, 'item_quitado', artId);
  await cargarTicketActual();
}

// ── DESCUENTO MANUAL ──────────────────────────────────────────────────────────
function abrirDescuentoModal() {
  document.getElementById('modal-title').textContent = '＋ Añadir descuento';
  const modalBody = document.getElementById('modal-body');
  modalBody.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px">
      <input type="text" id="desc-nombre" placeholder="Descripción (ej: Invitación, Descuento 10%)"
        style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:14px;color:var(--text);outline:none" />
      <input type="number" id="desc-importe" placeholder="Importe a descontar €" min="0.01" step="0.01"
        style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:14px;color:var(--text);outline:none" />
    </div>`;
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  const btnC = document.createElement('button');
  btnC.className = 'modal-btn'; btnC.textContent = 'Cancelar';
  btnC.onclick = () => document.getElementById('modal-overlay').classList.remove('open');
  const btnOk = document.createElement('button');
  btnOk.className = 'modal-btn primary'; btnOk.textContent = 'Aplicar';
  btnOk.onclick = async () => {
    const nombre  = document.getElementById('desc-nombre')?.value.trim();
    const importe = parseFloat(document.getElementById('desc-importe')?.value);
    if (!nombre || isNaN(importe) || importe <= 0) return;
    document.getElementById('modal-overlay').classList.remove('open');
    const ts       = Date.now();
    const envioId  = 'desc_' + ts;
    await set(ref(db, `pedidos/${mesaId}/${envioId}`), {
      ts, camarero: camareroActual, envioId,
      lineas: {
        desc_line: {
          artId: 'descuento', nombre, precio: -importe,
          qty: 1, destino: 'descuento', estado: 'servido',
          nota: '', camarero: camareroActual
        }
      }
    });
    await cargarTicketActual();
  };
  acts.appendChild(btnC); acts.appendChild(btnOk);
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('desc-nombre')?.focus(), 80);
}

// ── PARTIR CUENTA ─────────────────────────────────────────────────────────────
function abrirPartirCuentaModal(totalActual) {
  document.getElementById('modal-title').textContent = 'Partir cuenta';
  const modalBody = document.getElementById('modal-body');
  const actualStr = fmtEu(totalActual);
  modalBody.innerHTML = `
    <div style="text-align:center;margin-bottom:12px;font-family:var(--mono);font-size:13px;color:var(--muted)">Total: ${actualStr}</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <label style="font-size:13px;white-space:nowrap">Entre</label>
      <input type="number" id="partir-n" min="2" max="20" value="2"
        style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:18px;font-family:var(--mono);text-align:center;color:var(--text);outline:none" />
      <label style="font-size:13px;white-space:nowrap">personas</label>
    </div>
    <div id="partir-resultado" style="text-align:center;font-family:var(--mono);font-size:22px;font-weight:600;color:var(--accent2);padding:12px;background:var(--surface3);border-radius:12px">
      ${fmtEu(totalActual / 2)} / persona
    </div>`;
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  const inp = modalBody.querySelector('#partir-n');
  inp.addEventListener('input', () => {
    const n = parseInt(inp.value) || 1;
    const resultado = document.getElementById('partir-resultado');
    if (resultado) resultado.textContent = fmtEu(totalActual / Math.max(1, n)) + ' / persona';
  });
  const btnC = document.createElement('button');
  btnC.className = 'modal-btn'; btnC.textContent = 'Cerrar';
  btnC.onclick = () => document.getElementById('modal-overlay').classList.remove('open');
  acts.appendChild(btnC);
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => inp.focus(), 80);
}

// ── TRANSFERIR MESA ───────────────────────────────────────────────────────────
function abrirTransferirMesaModal() {
  const mesasLibres = Object.entries(mesasData).filter(([id, m]) => m.estado === 'libre' && id !== mesaId);
  if (!mesasLibres.length) {
    showModal({ title: 'Sin mesas libres', body: 'No hay mesas disponibles para transferir.', buttons: [{ label: 'Cerrar' }] });
    return;
  }
  document.getElementById('modal-title').textContent = 'Transferir mesa';
  const modalBody = document.getElementById('modal-body');
  modalBody.innerHTML = '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">Elige la mesa destino (debe estar libre):</div>' +
    '<div style="display:flex;flex-direction:column;gap:6px">' +
    mesasLibres.map(([id, m]) =>
      `<button data-mesadest="${id}"
        style="padding:12px 16px;border-radius:12px;border:1px solid var(--border);background:var(--surface3);cursor:pointer;font-size:14px;color:var(--text);text-align:left;font-family:var(--mono)">
        Mesa ${m.nombre}
      </button>`
    ).join('') + '</div>';
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '<button class="modal-btn" onclick="document.getElementById(\'modal-overlay\').classList.remove(\'open\')">Cancelar</button>';
  modalBody.addEventListener('click', async e => {
    const btn = e.target.closest('[data-mesadest]');
    if (!btn) return;
    document.getElementById('modal-overlay').classList.remove('open');
    await transferirMesa(btn.dataset.mesadest);
  }, { once: true });
  document.getElementById('modal-overlay').classList.add('open');
}

async function transferirMesa(mesaDestId) {
  const snapPedidos = await get(ref(db, 'pedidos/' + mesaId));
  const pedidos = snapPedidos.val();
  if (!pedidos) return;

  const batchUpdates = {};
  Object.entries(pedidos).forEach(([envioId, envio]) => {
    batchUpdates[`pedidos/${mesaDestId}/${envioId}`] = envio;
    batchUpdates[`pedidos/${mesaId}/${envioId}`] = null;
  });
  batchUpdates[`mesas/${mesaId}/estado`]    = 'libre';
  batchUpdates[`mesas/${mesaDestId}/estado`] = 'ocupada';

  await update(ref(db), batchUpdates);

  const mesaDestNombre = mesasData[mesaDestId]?.nombre || mesaDestId;
  mesaId     = mesaDestId;
  mesaNombre = mesaDestNombre;
  document.getElementById('topbar-mesa').textContent = 'Mesa ' + mesaDestNombre;
  await cargarTicketActual();
}

// ── CERRAR MESA ───────────────────────────────────────────────────────────────
window.cerrarMesa = async () => {
  showModal({
    title: 'Cerrar mesa ' + mesaNombre,
    body: 'Se borrarán todos los pedidos de esta mesa. ¿Continuar?',
    buttons: [
      { label: 'Cancelar' },
      { label: 'Cerrar mesa', style: 'danger', action: async () => {
        const snap = await get(ref(db, 'pedidos/' + mesaId));
        const pedidos = snap.val() || {};

        const todasLineas = aplanarPedidos(pedidos);
        const agrupado = {};
        const camareros = new Set();
        todasLineas.forEach(l => {
          const qtyCuenta = qtyEnCuenta(l);
          if (qtyCuenta <= 0) return;
          if (l.camarero && l.destino !== 'descuento') camareros.add(l.camarero);
          const k = l.nombre + '||' + Number(l.precio).toFixed(2);
          if (!agrupado[k]) agrupado[k] = { nombre: l.nombre, precio: Number(l.precio), qty: 0, nota: l.nota || '' };
          agrupado[k].qty += qtyCuenta;
        });
        const lineas = Object.values(agrupado);
        const total  = lineas.reduce((s, l) => s + l.precio * l.qty, 0);

        if (lineas.length > 0) {
          const ahora = new Date();
          await push(ref(db, 'historial'), {
            mesa: mesaNombre, camarero: [...camareros].join(', '),
            ts: ahora.getTime(), fecha: ahora.toLocaleDateString('es-ES'),
            hora: ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
            total: Math.round(total * 100) / 100, lineas
          });
        }

        await remove(ref(db, 'pedidos/' + mesaId));
        await set(ref(db, 'mesas/' + mesaId + '/estado'), 'libre');
        mesaId = null; mesaNombre = null; carrito = {};
        document.getElementById('topbar-mesa').style.display = 'none';
        show('mesas');
      }}
    ]
  });
};

// ── SHOW / NAVEGACIÓN ─────────────────────────────────────────────────────────
window.show = v => {
  document.getElementById('view-mesas').style.display  = v === 'mesas'  ? 'block' : 'none';
  document.getElementById('view-carta').style.display  = v === 'carta'  ? 'block' : 'none';
  document.getElementById('view-ticket').style.display = v === 'ticket' ? 'block' : 'none';
  const viewCarta = document.getElementById('view-carta');
  if (v === 'carta' && window.innerWidth >= 768) viewCarta.classList.add('tablet-active');
  else viewCarta.classList.remove('tablet-active');
  const btnCats = document.getElementById('btn-cats');
  if (btnCats) btnCats.style.display = (v === 'carta' && window.innerWidth < 768) ? 'flex' : 'none';
  const filterBar = document.getElementById('cat-filter-bar');
  if (filterBar) filterBar.style.display = (v === 'carta' && window.innerWidth < 768) ? 'block' : 'none';
  cerrarCatsPanel();
};
