// ── PROTECCIÓN DE DOMINIO ─────────────────────────────────────────────────────
// Cambia 'microcorpset.github.io' por tu dominio real antes de ofuscar
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

// carrito: artId → { art, qty, nota }
let mesaId = null, mesaNombre = null;
let carrito = {};
let mesasData = {}, cartaData = {}, categoriasData = {};
let cartaReady = false, catsReady = false;
let configLocal = {};
let ticketEditMode = false;

// ── USUARIOS / PIN multi-camarero ─────────────────────────────────────────────
const PIN_SESSION  = 'cam_auth';
const USER_SESSION = 'cam_user';
let usuariosData   = {}; // { userId: { nombre, pin } }
let camareroActual = sessionStorage.getItem(USER_SESSION) || '';
let pinBuffer      = '';

// Cargar usuarios desde Firebase
get(ref(db, 'config/usuarios')).then(s => {
  usuariosData = s.val() || {};
  // Retrocompatibilidad: si no hay usuarios, usar PIN único de camarero
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
  // Buscar qué usuario tiene ese PIN
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

// Listeners del teclado PIN (sin onclick inline para compatibilidad con módulos ES)
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

// Cerrar modal al hacer clic en el overlay (fuera del box)
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay'))
    document.getElementById('modal-overlay').classList.remove('open');
});


// ── Móvil: tocar el área de total abre el drawer ──────────────────────────────
document.querySelector('.resumen-info')?.addEventListener('click', () => {
  if (window.innerWidth <= 640 && mesaId) abrirDrawer();
});

const PRINT_KEY = 'camarero_pdf';
let autoPDF = localStorage.getItem(PRINT_KEY) === 'true';
const printTrack = document.getElementById('print-track');
printTrack.classList.toggle('on', autoPDF);
printTrack.parentElement.addEventListener('click', () => {
  autoPDF = !autoPDF;
  localStorage.setItem(PRINT_KEY, autoPDF);
  printTrack.classList.toggle('on', autoPDF);
});

// ── Toggle TXT autoimpresión ───────────────────────────────────────────────────
const TXT_KEY = 'camarero_txt';
let autoTXT = localStorage.getItem(TXT_KEY) === 'true';
const txtTrack = document.getElementById('txt-track');
txtTrack.classList.toggle('on', autoTXT);
txtTrack.parentElement.addEventListener('click', () => {
  autoTXT = !autoTXT;
  localStorage.setItem(TXT_KEY, autoTXT);
  txtTrack.classList.toggle('on', autoTXT);
});

// ── Wake Lock ──────────────────────────────────────────────────────────────────
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
  const notaActual = carrito[artId]?.nota || '';
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
    if (carrito[artId]) carrito[artId].nota = val;
    const drawerInp = document.querySelector(`[data-rnota="${artId}"]`);
    if (drawerInp) drawerInp.value = val;
    const btn = document.getElementById('btnnota-' + artId);
    if (btn) btn.classList.toggle('tiene-nota', !!val);
    document.getElementById('modal-overlay').classList.remove('open');
    if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
  }
};

onValue(ref(db, 'mesas'), snap => { mesasData = snap.val() || {}; renderMesas(); });
onValue(ref(db, 'categorias'), snap => { categoriasData = snap.val() || {}; catsReady = true; if (cartaReady && mesaId) renderCarta(); });
onValue(ref(db, 'carta'), snap => { cartaData = snap.val() || {}; cartaReady = true; if (catsReady && mesaId) renderCarta(); });
onValue(ref(db, 'config/local'), snap => { configLocal = snap.val() || {}; });
// Escuchar pedidos para colores de mesas
onValue(ref(db, 'pedidos'), snap => {
  pedidosData = snap.val() || {};
  renderMesas();
});

// ── Mesas con colores de estado ───────────────────────────────────────────────
let pedidosData = {};

function fmtEu(n) {
  return Number(n || 0).toFixed(2).replace('.', ',') + ' €';
}

function resumenMesaActual(id) {
  const pedidosMesa = pedidosData[id];
  if (!pedidosMesa) return 'Sin consumo';
  const lineas = aplanarPedidos(pedidosMesa).filter(l => l.estado !== 'cancelado');
  const uds = lineas.reduce((s, l) => s + Number(l.qty || 0), 0);
  const total = lineas.reduce((s, l) => s + Number(l.precio || 0) * Number(l.qty || 0), 0);
  if (!uds) return 'Sin consumo';
  return `<strong>${uds} uds</strong> | <strong>${fmtEu(total)}</strong>`;
}

function renderMesas() {
  const grid = document.getElementById('mesas-grid');
  const entries = Object.entries(mesasData);
  if (!entries.length) { grid.innerHTML = '<div class="loading">Sin mesas.</div>'; return; }
  grid.innerHTML = '';
  entries
    .sort(([,a],[,b]) => (a.orden??999)-(b.orden??999) || a.nombre.localeCompare(b.nombre,'es',{numeric:true}))
    .forEach(([id, m]) => {
      const ocupada = m.estado === 'ocupada';
      const div = document.createElement('div');

      // Buscar línea pendiente más antigua de todos los envíos de esta mesa
      let claseAlerta = ocupada ? 'ocupada' : 'libre';
      let alertaInfo  = '';
      if (ocupada && pedidosData[id]) {
        let lineasPend = [];
        Object.values(pedidosData[id]).forEach(envio => {
          const envioTs = Number(envio.ts) || 0;
          const ls = envio.lineas || { _: envio };
          Object.values(ls).forEach(l => {
            if (l.estado === 'pendiente') {
              lineasPend.push({
                ...l,
                _tsMesa: Number(l.ts) || envioTs
              });
            }
          });
        });
        if (lineasPend.length) {
          const masAntigua = lineasPend.reduce((min, l) => l._tsMesa < min._tsMesa ? l : min, lineasPend[0]);
          const mins = Math.max(0, Math.floor((Date.now() - (masAntigua._tsMesa || Date.now())) / 60000));
          const minsTxt = mins === 0 ? '<1m' : `${mins}m`;
          const dest = masAntigua.destino === 'cocina' ? '&#127869;' : masAntigua.destino === 'barra' ? '&#127866;' : '&#127866;&#127869;';
          const pendienteTxt = lineasPend.length === 1 ? '1 pendiente' : `${lineasPend.length} pendientes`;
          if (mins >= 20)     claseAlerta = 'alerta-danger';
          else if (mins >= 10) claseAlerta = 'alerta-warn';
          else                 claseAlerta = 'alerta-ok';
          alertaInfo = `<span class="mesa-alerta-info">${dest} ${pendienteTxt} | ${minsTxt}</span>`;
        }
      }

      const resumenMesa = resumenMesaActual(id);

      div.className = 'mesa-btn ' + claseAlerta;
      div.innerHTML = `
        <span class="mesa-nombre">${m.nombre}</span>
        <span class="mesa-estado">${ocupada ? 'ocupada' : 'libre'}</span>
        <span class="mesa-resumen">${resumenMesa}</span>
        ${alertaInfo}`;
      div.addEventListener('click', () => abrirMesa(id, m.nombre, ocupada));
      grid.appendChild(div);
    });
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

// ── Carta ─────────────────────────────────────────────────────────────────────
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
      const wrap = document.createElement('div');
      wrap.className = 'art-row';

      const mainRow = document.createElement('div');
      mainRow.className = 'art-main';
      mainRow.innerHTML = `
        <span class="art-nombre">${art.nombre}</span>
        <span class="art-precio">${Number(art.precio).toFixed(2)} €</span>
        <div class="qty-ctrl">
          <button class="qty-btn" data-id="${artId}" data-d="-1">−</button>
          <span class="qty-num" id="qty-${artId}">0</span>
          <button class="qty-btn" data-id="${artId}" data-d="1">+</button>
        </div>
        <button class="btn-nota" id="btnnota-${artId}" title="Añadir nota"
          onclick="abrirNotaModal('${artId}','${art.nombre.replace(/'/g,"\\'")}')">📝</button>`;
      wrap.appendChild(mainRow);
      itemsDiv.appendChild(wrap);
    });

    section.appendChild(itemsDiv);
    body.appendChild(section);
  });

  body.onclick = e => {
    const btn = e.target.closest('[data-d]');
    if (!btn) return;
    cambiarQty(btn.dataset.id, parseInt(btn.dataset.d));
  };

  // Rellenar panel de categorías
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
        if (hdr) { hdr.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        // Si está colapsada, expandirla
        const sec = document.getElementById('cat-' + catId);
        if (sec && sec.classList.contains('collapsed')) toggleCat(sec);
      });
      panel.appendChild(item);
    });
  }
  const btnCats = document.getElementById('btn-cats');
  if (btnCats) btnCats.style.display = 'flex';

  // ── Tablet: panel lateral de categorías ───────────────────────────────────
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
      const count = arts.reduce((s,[id]) => s + (carrito[id]?.qty||0), 0);
      item.innerHTML = `<span>${cat.nombre}</span>${count > 0 ? `<span class="tablet-cat-count">${count}</span>` : ''}`;
      item.addEventListener('click', () => {
        document.querySelectorAll('.tablet-cat-item').forEach(i => i.classList.remove('activa'));
        item.classList.add('activa');
        // Mostrar solo la sección de esta categoría
        document.querySelectorAll('.cat-section').forEach(s => s.classList.remove('tablet-visible'));
        const sec = document.getElementById('cat-' + catId);
        if (sec) sec.classList.add('tablet-visible');
        document.getElementById('carta-body').scrollTop = 0;
      });
      tabletCats.appendChild(item);
      // Primera categoría activa por defecto
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
// Cerrar panel al tocar fuera
document.addEventListener('click', e => {
  if (!e.target.closest('#cats-panel') && !e.target.closest('#btn-cats')) cerrarCatsPanel();
});

function toggleCat(section) {
  const items = section.querySelector('.cat-items');
  const collapsed = section.classList.toggle('collapsed');
  items.style.maxHeight = collapsed ? '0' : '4000px';
}

// ── Carrito ───────────────────────────────────────────────────────────────────
function cambiarQty(artId, delta) {
  const art = cartaData[artId];
  if (!art) return;
  const prev = carrito[artId]?.qty || 0;
  const nota = carrito[artId]?.nota || '';
  const next = Math.max(0, prev + delta);
  if (next === 0) delete carrito[artId];
  else carrito[artId] = { art, qty: next, nota };
  updateQtyDisplay();
  updateUI();
  if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
}

window.actualizarNota = (artId, valor) => {
  if (carrito[artId]) {
    carrito[artId].nota = valor.trim();
    if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
  }
};

function updateQtyDisplay() {
  Object.keys(cartaData).forEach(id => {
    const el = document.getElementById('qty-' + id);
    if (!el) return;
    const q = carrito[id]?.qty || 0;
    el.textContent = q;
    el.className = 'qty-num' + (q > 0 ? ' has-qty' : '');
    // Actualizar botón nota
    const btnNota = document.getElementById('btnnota-' + id);
    if (btnNota) {
      btnNota.classList.toggle('tiene-nota', !!(carrito[id]?.nota));
    }
  });

  // contador por categoría
  Object.entries(categoriasData).forEach(([catId]) => {
    const el = document.getElementById('catcount-' + catId);
    if (!el) return;
    const arts = Object.entries(cartaData).filter(([,a]) => a.catId === catId);
    const total = arts.reduce((s, [id]) => s + (carrito[id]?.qty || 0), 0);
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

// ── Drawer ────────────────────────────────────────────────────────────────────
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
  items.forEach(([artId, {art, qty, nota}]) => {
    const wrap = document.createElement('div');
    wrap.className = 'ri-wrap';

    const main = document.createElement('div');
    main.className = 'ri-main';
    main.innerHTML = `
      <span class="ri-nombre">${art.nombre}</span>
      <div class="ri-qty-ctrl">
        <button class="ri-qty-btn" onclick="drawerCambiarQty('${artId}',-1)">−</button>
        <span class="ri-qty-num" id="dqty-${artId}">${qty}</span>
        <button class="ri-qty-btn" onclick="drawerCambiarQty('${artId}',1)">+</button>
      </div>
      <span class="ri-precio" id="dprecio-${artId}">${(Number(art.precio) * qty).toFixed(2)} €</span>`;
    wrap.appendChild(main);

    const notaRow = document.createElement('div');
    notaRow.className = 'ri-nota-row';
    notaRow.innerHTML = `
      <span class="ri-nota-label">Nota:</span>
      <input class="ri-nota-input" type="text"
        placeholder="ej: poco hecho, sin cebolla…"
        value="${(nota || '').replace(/"/g, '&quot;')}"
        oninput="drawerNota('${artId}', this.value)" />`;
    wrap.appendChild(notaRow);

    body.appendChild(wrap);
  });
}

// Cambiar qty desde el drawer sin re-renderizar todo
window.drawerCambiarQty = (artId, delta) => {
  cambiarQty(artId, delta);
  // Actualizar solo los números del drawer sin re-renderizar
  const qtyEl    = document.getElementById('dqty-' + artId);
  const precioEl = document.getElementById('dprecio-' + artId);
  if (carrito[artId]) {
    if (qtyEl)    qtyEl.textContent = carrito[artId].qty;
    if (precioEl) precioEl.textContent = (Number(carrito[artId].art.precio) * carrito[artId].qty).toFixed(2) + ' €';
  } else {
    // Se quedó a 0, re-renderizar para quitar la fila
    renderDrawer();
  }
};

window.drawerNota = (artId, valor) => {
  if (carrito[artId]) {
    carrito[artId].nota = valor.trim();
    const cartaInput = document.getElementById('nota-' + artId);
    if (cartaInput) cartaInput.value = valor;
  }
};

// ── Enviar ────────────────────────────────────────────────────────────────────
// ── Generar e imprimir comanda via iframe (igual que barra/cocina) ────────────
const iframeComanda = document.createElement('iframe');
iframeComanda.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none';
document.body.appendChild(iframeComanda);

function generarPDFComanda(nombreMesa, lineas, configLocal) {
  const ahora = new Date();
  const hora  = ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const fecha = ahora.toLocaleDateString('es-ES');

  const cabecera = configLocal?.nombre ? `
    <div class="local">${configLocal.nombre}${configLocal.direccion ? `<br><span>${configLocal.direccion}</span>` : ''}</div>` : '';

  const rows = lineas.map(l => `
    <tr>
      <td class="qty">${l.qty}×</td>
      <td class="nombre">${l.nombre}${l.nota ? `<br><span class="nota">↳ ${l.nota}</span>` : ''}</td>
      <td class="precio">${(l.precio * l.qty).toFixed(2)}€</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: monospace; font-size: 13px; width: 72mm; padding: 4mm; }
    .local { font-size: 11px; color: #555; border-bottom: 1px dashed #ccc;
             padding-bottom: 5px; margin-bottom: 8px; }
    .local span { font-size: 10px; }
    h2 { font-size: 15px; font-weight: bold; margin-bottom: 2px; }
    .sub { font-size: 10px; color: #777; margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; }
    tr { border-bottom: 1px solid #eee; }
    tr:last-child { border-bottom: none; }
    td { padding: 4px 2px; vertical-align: top; }
    .qty { font-weight: bold; white-space: nowrap; padding-right: 5px; }
    .nombre { flex: 1; }
    .precio { text-align: right; white-space: nowrap; padding-left: 5px; }
    .nota { font-size: 10px; color: #666; font-style: italic; }
    @media print { body { width: 100%; padding: 0; } }
  </style></head><body>
  ${cabecera}
  <h2>Mesa ${nombreMesa}</h2>
  <div class="sub">${fecha} · ${hora}</div>
  <table>${rows}</table>
  <script>window.onload = () => { window.print(); }<\/script>
  </body></html>`;

  iframeComanda.srcdoc = html;
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
  txt += `Mesa ${nombreMesa}\n`;
  txt += `${fecha}  ${hora}\n`;
  txt += sep + '\n';
  lineas.forEach(l => {
    const precio  = (l.precio * l.qty).toFixed(2) + 'EUR';
    const izq     = `${l.qty}x ${l.nombre}`;
    const nEspacios = Math.max(1, 32 - izq.length - precio.length);
    txt += izq + ' '.repeat(nEspacios) + precio + '\n';
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
let quotaActual = null; // null = aún no cargado

onValue(ref(db, 'config/quota/lineas'), snap => {
  quotaActual = snap.val() ?? null;
  renderQuotaBadge();
});

function renderQuotaBadge() {
  const badge = document.getElementById('quota-badge');
  if (!badge) return;
  if (quotaActual === null || quotaActual === -1) {
    badge.style.display = 'none'; return;
  }
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

// ── Enviar ────────────────────────────────────────────────────────────────────
window.enviarPedido = async () => {
  if (!mesaId || !Object.keys(carrito).length) return;

  // Contar líneas del carrito (cada artículo = 1 línea)
  const nLineas = Object.keys(carrito).length;

  // Comprobar cuota si está activada (−1 = sin límite)
  if (quotaActual !== null && quotaActual !== -1) {
    if (quotaActual <= 0) {
      showModal({
        title: 'Límite de pedidos alcanzado',
        body: 'Se han agotado las líneas de pedido incluidas en el plan. Contacta con el administrador para ampliar el servicio.',
        buttons: [{ label: 'Entendido', style: 'primary' }]
      });
      return;
    }
    if (quotaActual < nLineas) {
      showModal({
        title: 'Líneas insuficientes',
        body: `Quedan ${quotaActual} líneas disponibles y el pedido tiene ${nLineas}. Reduce el pedido o contacta con el administrador.`,
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

  Object.entries(carrito).forEach(([artId, {art, qty, nota}]) => {
    lineasObj[artId] = {
      artId, nombre: art.nombre, precio: Number(art.precio),
      qty, destino: art.destino, estado: 'pendiente',
      nota: nota || '', camarero: camareroActual
    };
    lineasImprimir.push({ nombre: art.nombre, precio: Number(art.precio), qty, nota: nota || '', camarero: camareroActual });
  });

  // Un solo push con todo el envío
  await set(ref(db, `pedidos/${mesaId}/${envioId}`), {
    ts: envioTs, camarero: camareroActual, envioId,
    lineas: lineasObj
  });

  // Descontar líneas de la cuota
  if (quotaActual !== null && quotaActual !== -1) {
    await set(ref(db, 'config/quota/lineas'), quotaActual - nLineas);
    const restante = quotaActual - nLineas;
    if (restante > 0 && restante <= 100) {
      setTimeout(() => showModal({
        title: 'Pocas líneas restantes',
        body: `Quedan ${restante} líneas de pedido disponibles. Contacta con el administrador para ampliar antes de quedarte sin servicio.`,
        buttons: [{ label: 'Entendido' }]
      }), 800);
    }
  }

  // Contador de consumo mensual (siempre, independiente de la cuota)
  const ahora2 = new Date();
  const mesKey = `${ahora2.getFullYear()}-${String(ahora2.getMonth()+1).padStart(2,'0')}`;
  const statsRef = ref(db, 'config/stats/' + mesKey + '/lineas');
  const statsSnap = await get(statsRef);
  const consumidoMes = statsSnap.val() || 0;
  await set(statsRef, consumidoMes + nLineas);

  // Generar y descargar PDF solo si el toggle está activo
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

// ── Cuenta / Ticket en tiempo real ───────────────────────────────────────────
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

// Aplanar estructura de envíos para el ticket
function aplanarPedidos(pedidos) {
  const lineas = []; // { envioId, artId, nombre, precio, qty, nota, estado }
  Object.entries(pedidos).forEach(([envioId, envio]) => {
    const ls = envio.lineas || { [envioId]: envio }; // compatibilidad estructura antigua
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
    .replace(/Comprobar/g, '')
    .replace(/Verificado/g, '')
    .replace(/⚠️/g, '')
    .replace(/✅/g, '')
    .replace(/Â·/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderTicket(pedidos) {
  const todasLineas = aplanarPedidos(pedidos);

  const lineasServidas = todasLineas
    .map(l => {
      const qtyCuenta = qtyEnCuenta(l);
      const qtyMax = qtyMaxEnCuenta(l);
      return { ...l, qtyOriginal: l.qty, qtyCuenta, qtyMax };
    })
    .filter(l => l.qtyCuenta > 0)
    .sort((a, b) => (a.envioId || '').localeCompare(b.envioId || '') || a.nombre.localeCompare(b.nombre, 'es'));

  window._tLineas = lineasServidas;

  if (!lineasServidas.length) {
    document.getElementById('ticket-card').innerHTML =       '<div class="ticket-edit-hint">No hay articulos servidos aun</div>' +
      '<div class="ticket-total"><span>Total</span><span>' + fmtEu(0) + '</span></div>' +
      '<button class="btn-cerrar">Cerrar mesa y limpiar</button>';
    document.getElementById('ticket-card').onclick = e => {
      if (e.target.classList.contains('btn-cerrar')) cerrarMesa();
    };
    return;
  }

  const total = lineasServidas.reduce((s, l) => s + Number(l.precio) * l.qtyCuenta, 0);
  const totalUds = lineasServidas.reduce((s, l) => s + l.qtyCuenta, 0);
  const fecha = new Date().toLocaleString('es-ES', { dateStyle:'short', timeStyle:'short' });
  const loc = configLocal;

  const cab =     (loc.nombre ? '<div style="font-size:18px;font-weight:500;font-family:var(--mono)">' + loc.nombre + '</div>' : '') +
    (loc.direccion ? '<div style="font-size:12px;color:var(--muted);margin-top:2px">' + loc.direccion + '</div>' : '') +
    (loc.telefono ? '<div style="font-size:12px;color:var(--muted)">' + loc.telefono + '</div>' : '') +
    (loc.cif ? '<div style="font-size:11px;color:var(--muted)">' + loc.cif + '</div>' : '');
  const pie = loc.footer
    ? '<div style="text-align:center;font-size:12px;color:var(--muted);margin-top:1rem;padding-top:.75rem;border-top:1px dashed var(--border)">' + loc.footer + '</div>'
    : '';

  const lineasHTML = lineasServidas.map((l, i) => {
    const notaVisible = limpiarNotaTicket(l.nota);
    const controlesEdicion = ticketEditMode
      ? '<div class="ticket-qty-edit no-print">' +
        '<button class="ticket-qty-btn" data-accion="restar" data-idx="' + i + '"' + (l.qtyCuenta <= 1 ? ' disabled' : '') + '>-</button>' +
        '<span class="ticket-qty-num">' + l.qtyCuenta + '</span>' +
        '<button class="ticket-qty-btn" data-accion="sumar" data-idx="' + i + '">+</button>' +
      '</div>'
      : '';
    return '<div class="ticket-linea ticket-linea-edit">' +
      '<div style="flex:1">' +
        '<div>' + l.qtyCuenta + 'x ' + l.nombre + '</div>' +
        (notaVisible ? '<div style="font-size:11px;color:var(--muted);font-style:italic">-> ' + notaVisible + '</div>' : '') +
        (l.verificado ? '<span class="nota-verificado no-print">Verificado</span>' : '') +
      '</div>' +
      controlesEdicion +
      '<span class="ticket-linea-precio">' + fmtEu(Number(l.precio) * l.qtyCuenta) + '</span>' +
      (ticketEditMode ? '' : '<button class="btn-quitar-linea" data-idx="' + i + '" title="Devolver a barra/cocina">x</button>') +
    '</div>';
  }).join('');

  const textoHint = ticketEditMode
    ? 'Modo edicion: ajusta cantidades sin reenviar nada a barra o cocina'
    : 'Cuenta actual: ' + totalUds + ' uds | ' + fmtEu(total);

  document.getElementById('ticket-card').innerHTML =     '<div class="ticket-header">' +
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
    '<button class="btn-print no-print-btn">Imprimir ticket</button>' +
    '<button class="btn-refresh no-print">Actualizar ticket</button>' +
    '<button class="btn-cerrar">Cerrar mesa y limpiar</button>';

  const card = document.getElementById('ticket-card');
  card.onclick = async e => {
    if (e.target.classList.contains('ticket-qty-btn')) {
      const i = parseInt(e.target.dataset.idx);
      const delta = e.target.dataset.accion === 'sumar' ? 1 : -1;
      await editarCantidadTicket(i, delta);
    } else if (e.target.classList.contains('btn-quitar-linea')) {
      const i = parseInt(e.target.dataset.idx);
      await quitarDelTicket(i);
    } else if (e.target.classList.contains('btn-print') || e.target.classList.contains('no-print-btn')) {
      window.print();
    } else if (e.target.classList.contains('btn-refresh')) {
      await cargarTicketActual();
    } else if (e.target.classList.contains('btn-cerrar')) {
      cerrarMesa();
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
    [`pedidos/${mesaId}/${envioId}/lineas/${artId}/nota`]:
      (notaBase ? notaBase + ' · ' : '') + '⚠️ Comprobar',
  };
  if (l.estado === 'servido') {
    updates[`pedidos/${mesaId}/${envioId}/lineas/${artId}/estado`] = 'pendiente';
  }
  await update(ref(db), updates);
  await cargarTicketActual();
};


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
          if (l.camarero) camareros.add(l.camarero);
          // Usar la cantidad realmente servida, incluyendo parciales
          const k = l.nombre + '||' + Number(l.precio).toFixed(2);
          if (!agrupado[k]) agrupado[k] = { nombre: l.nombre, precio: Number(l.precio), qty: 0, nota: l.nota || '' };
          agrupado[k].qty += qtyCuenta;
        });
        const lineas = Object.values(agrupado);
        const total  = lineas.reduce((s, l) => s + l.precio * l.qty, 0);
        if (lineas.length > 0) {
          const ahora = new Date();
          await push(ref(db, 'historial'), {
            mesa: mesaNombre,
            camarero: [...camareros].join(', '),
            ts: ahora.getTime(),
            fecha: ahora.toLocaleDateString('es-ES'),
            hora: ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
            total: Math.round(total * 100) / 100,
            lineas
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

window.show = v => {
  document.getElementById('view-mesas').style.display  = v === 'mesas'  ? 'block' : 'none';
  document.getElementById('view-carta').style.display  = v === 'carta'  ? 'block' : 'none';
  document.getElementById('view-ticket').style.display = v === 'ticket' ? 'block' : 'none';
  // Tablet: layout dividido
  const viewCarta = document.getElementById('view-carta');
  if (v === 'carta' && window.innerWidth >= 768) viewCarta.classList.add('tablet-active');
  else viewCarta.classList.remove('tablet-active');
  // Botón de categorías solo en móvil
  const btnCats = document.getElementById('btn-cats');
  if (btnCats) btnCats.style.display = (v === 'carta' && window.innerWidth < 768) ? 'flex' : 'none';
  cerrarCatsPanel();
};

// ── FAB acceso rápido barra/cocina ─────────────────────────────────────────────

// Evitar que los fab-item naveguen si el panel no está abierto

// FAB visible al arrancar (la vista inicial es mesas)

// Cerrar FAB al tocar fuera


