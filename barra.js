// Protección de dominio
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
import { ref, onValue, set, get, update } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

await authReady;

const escocina = location.pathname.includes('cocina') || location.search.includes('rol=cocina');
const ROL = escocina ? 'cocina' : 'barra';
const PRINT_KEY = 'autoimp_' + ROL;
const TXT_KEY = 'txt_' + ROL;
const PRINTED_KEY = 'printed_' + ROL;
const PIN_SESSION = 'auth_' + ROL;
const WAKE_KEY = 'wake_' + ROL;
const THEME_KEY = 'theme_' + ROL;
const FONT_KEY = 'font_' + ROL;
const modoTachar = true;

let PIN_CORRECTO = '1234';
let wakeLock = null;
let autoWake = localStorage.getItem(WAKE_KEY) === 'true';
let autoImprimir = localStorage.getItem(PRINT_KEY) === 'true';
let autoTXT = localStorage.getItem(TXT_KEY) === 'true';
let configLocal = {};
let mesasData = {};
let pedidosPorMesa = {};
let vistos = new Set(JSON.parse(localStorage.getItem('vistos_' + ROL) || '[]'));
let impresos = new Set(JSON.parse(localStorage.getItem(PRINTED_KEY) || '[]'));
let nuevosActivos = new Set();
let primeraVez = true;
let statsArticulos = new Map();
let grupoActivo = null;
let audioCtx;

const wakeTrack = document.getElementById('wake-track');
const printTrack = document.getElementById('print-track');
const txtTrack = document.getElementById('txt-track');
const themeSelect = document.getElementById('theme-select');
const fontSelect = document.getElementById('font-select');
const prefsBtn = document.getElementById('prefs-btn');
const prefsPanel = document.getElementById('prefs-panel');
const bulkServeBtn = document.getElementById('bulk-serve-btn');
const bulkClearBtn = document.getElementById('bulk-clear-btn');

get(ref(db, 'config/pins/' + ROL)).then(s => {
  if (s.val()) PIN_CORRECTO = s.val();
}).catch(() => {});

if (ROL === 'cocina') {
  document.documentElement.classList.add('rol-cocina');
  document.getElementById('topbar-title').textContent = 'Cocina';
  document.getElementById('pin-rol-title').textContent = 'Cocina';
  document.title = 'Cocina · Comandero';
}

const pinSubEl = document.querySelector('.pin-box .pin-sub');
if (pinSubEl) pinSubEl.textContent = `— ${ROL === 'cocina' ? 'Cocina' : 'Barra'} —`;

function saveVistos() {
  localStorage.setItem('vistos_' + ROL, JSON.stringify([...vistos]));
}

function saveImpresos() {
  localStorage.setItem(PRINTED_KEY, JSON.stringify([...impresos]));
}

function limpiarNotaSistema(nota = '') {
  return String(nota)
    .replace(/\s*·?\s*⚠️\s*Comprobar/g, '')
    .replace(/\s*·?\s*✅\s*Verificado/g, '')
    .replace(/\s*·\s*$/g, '')
    .trim();
}

function notaVisible(nota = '') {
  return String(nota)
    .replace(/\s*·?\s*⚠️\s*Comprobar/g, '⚠️ Comprobar')
    .replace(/\s*·?\s*✅\s*Verificado/g, '')
    .replace(/\s*·\s*$/g, '')
    .trim();
}

function normalizarTexto(txt = '') {
  return String(txt)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function claveArticulo(linea) {
  return `${normalizarTexto(linea.nombre)}||${normalizarTexto(limpiarNotaSistema(linea.nota || ''))}`;
}

function escapeAttr(txt = '') {
  return String(txt).replace(/'/g, "\\'");
}

function aplicarTema(theme) {
  const valor = theme === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('theme-light', valor === 'light');
  localStorage.setItem(THEME_KEY, valor);
  if (themeSelect) themeSelect.value = valor;
}

function aplicarTamanoFuente(scale) {
  const valor = ['0.9', '1', '1.15', '1.3'].includes(String(scale)) ? String(scale) : '1';
  document.documentElement.style.setProperty('--font-scale', valor);
  localStorage.setItem(FONT_KEY, valor);
  if (fontSelect) fontSelect.value = valor;
}

aplicarTema(localStorage.getItem(THEME_KEY) || 'dark');
aplicarTamanoFuente(localStorage.getItem(FONT_KEY) || '1');

if (themeSelect) themeSelect.addEventListener('change', e => aplicarTema(e.target.value));
if (fontSelect) fontSelect.addEventListener('change', e => aplicarTamanoFuente(e.target.value));
if (prefsBtn && prefsPanel) {
  prefsBtn.addEventListener('click', e => {
    e.stopPropagation();
    prefsPanel.classList.toggle('open');
  });
  document.addEventListener('click', e => {
    if (!prefsPanel.contains(e.target) && !prefsBtn.contains(e.target)) {
      prefsPanel.classList.remove('open');
    }
  });
}

let pinBuffer = '';
if (sessionStorage.getItem(PIN_SESSION) === '1') {
  document.getElementById('pin-screen').style.display = 'none';
}

function updatePinDots(error) {
  for (let i = 0; i < 4; i++) {
    const d = document.getElementById('pd' + i);
    if (d) d.className = 'pin-dot' + (i < pinBuffer.length ? (error ? ' error' : ' filled') : '');
  }
}

function verificarPin() {
  if (pinBuffer === PIN_CORRECTO) {
    sessionStorage.setItem(PIN_SESSION, '1');
    document.getElementById('pin-screen').style.display = 'none';
    return;
  }

  updatePinDots(true);
  document.getElementById('pin-error').style.display = 'block';
  setTimeout(() => {
    pinBuffer = '';
    updatePinDots(false);
    document.getElementById('pin-error').style.display = 'none';
  }, 900);
}

window.pinKey = d => {
  if (pinBuffer.length >= 4) return;
  pinBuffer += d;
  updatePinDots();
  if (pinBuffer.length === 4) verificarPin();
};

window.pinDel = () => {
  pinBuffer = pinBuffer.slice(0, -1);
  updatePinDots(false);
  document.getElementById('pin-error').style.display = 'none';
};

document.getElementById('pin-pad').addEventListener('click', e => {
  const btn = e.target.closest('[data-k]');
  if (!btn) return;
  const k = btn.dataset.k;
  if (k === 'del') pinDel();
  else if (k !== '') pinKey(k);
});

async function activarWake() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {}
}

if (wakeTrack) wakeTrack.classList.toggle('on', autoWake);
if (autoWake) activarWake();
if (wakeTrack) {
  wakeTrack.parentElement.addEventListener('click', () => {
    autoWake = !autoWake;
    localStorage.setItem(WAKE_KEY, autoWake);
    wakeTrack.classList.toggle('on', autoWake);
    if (autoWake) activarWake();
    else if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
    }
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && autoWake) activarWake();
});

function updateToggleUI() {
  if (printTrack) printTrack.classList.toggle('on', autoImprimir);
  if (txtTrack) txtTrack.classList.toggle('on', autoTXT);
}

updateToggleUI();

if (printTrack) {
  printTrack.parentElement.addEventListener('click', () => {
    autoImprimir = !autoImprimir;
    localStorage.setItem(PRINT_KEY, autoImprimir);
    updateToggleUI();
  });
}

if (txtTrack) {
  txtTrack.parentElement.addEventListener('click', () => {
    autoTXT = !autoTXT;
    localStorage.setItem(TXT_KEY, autoTXT);
    updateToggleUI();
  });
}

function showModal({ title, body, buttons }) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent = body;
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  (buttons || []).forEach(b => {
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
  if (e.target === document.getElementById('modal-overlay')) {
    document.getElementById('modal-overlay').classList.remove('open');
  }
});

const colaImpresion = [];
let imprimiendoAhora = false;
window.__comanderoPrintDone = () => {};
const iframeComanda = document.createElement('iframe');
iframeComanda.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none';
document.body.appendChild(iframeComanda);

function generarTXT(mesaNombre, lineas) {
  const ahora = new Date();
  const hora = ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const fecha = ahora.toLocaleDateString('es-ES');
  const ts = `${String(ahora.getHours()).padStart(2, '0')}${String(ahora.getMinutes()).padStart(2, '0')}${String(ahora.getSeconds()).padStart(2, '0')}`;
  const sep = '--------------------------------';
  const camareros = [...new Set(lineas.map(l => l.camarero).filter(Boolean))];
  const camareroTxt = camareros.join(', ');

  let txt = `${ROL === 'cocina' ? 'COCINA' : 'BARRA'} - Mesa ${mesaNombre}\n`;
  if (camareroTxt) txt += `Camarero: ${camareroTxt}\n`;
  txt += `${fecha}  ${hora}\n${sep}\n`;

  lineas.forEach(l => {
    const precio = (l.precio * l.qty).toFixed(2) + 'EUR';
    const izq = `${l.qty}x ${l.nombre}`;
    txt += izq + ' '.repeat(Math.max(1, 32 - izq.length - precio.length)) + precio + '\n';
    if (l.nota) txt += `   -> ${l.nota}\n`;
  });

  txt += sep + '\n';
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `comanda-${ROL}-mesa${mesaNombre}-${ts}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function imprimirComanda(mesaNombre, lineas) {
  const ahora = new Date();
  const hora = ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const fecha = ahora.toLocaleDateString('es-ES');
  const camarero = [...new Set(lineas.map(l => l.camarero).filter(Boolean))].join(', ');
  const cabecera = configLocal?.nombre ? `
    <div class="local">${configLocal.nombre}${configLocal.direccion ? `<br><span>${configLocal.direccion}</span>` : ''}</div>` : '';
  const rows = lineas.map(l => `
    <tr>
      <td class="qty">${l.qty}×</td>
      <td class="nombre">
        ${l.nombre}
        ${l.nota ? `<br><span class="nota">↳ ${limpiarNotaSistema(l.nota)}</span>` : ''}
      </td>
      <td class="precio">${(Number(l.precio) * Number(l.qty)).toFixed(2)}€</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: monospace; font-size: 13px; width: 72mm; padding: 4mm; color: #111; }
      .local { font-size: 11px; color: #555; border-bottom: 1px dashed #ccc; padding-bottom: 5px; margin-bottom: 8px; }
      .local span { font-size: 10px; }
      h2 { font-size: 15px; font-weight: bold; margin-bottom: 2px; }
      .sub { font-size: 10px; color: #777; margin-bottom: 10px; }
      table { width: 100%; border-collapse: collapse; }
      tr { border-bottom: 1px solid #eee; }
      tr:last-child { border-bottom: none; }
      td { padding: 4px 2px; vertical-align: top; }
      .qty { font-weight: bold; white-space: nowrap; padding-right: 5px; }
      .precio { text-align: right; white-space: nowrap; padding-left: 5px; }
      .nota { font-size: 10px; color: #666; font-style: italic; }
      @media print { body { width: 100%; padding: 0; } }
    </style>
    <script>
      const finalizar = () => {
        try { parent.__comanderoPrintDone(); } catch {}
      };
      window.addEventListener('afterprint', finalizar, { once: true });
      window.addEventListener('load', () => {
        setTimeout(() => {
          window.focus();
          window.print();
        }, 60);
      }, { once: true });
    <\/script></head><body>
      ${cabecera}
      <h2>${ROL === 'cocina' ? 'COCINA' : 'BARRA'} - Mesa ${mesaNombre}</h2>
      <div class="sub">${fecha}${camarero ? ' · ' + camarero : ''}</div>
      <table>${rows}</table>
    </body></html>`;

  const htmlFinal = html.replace(
    /<div class="sub">[\s\S]*?<\/div>/,
    `<div class="sub">${fecha} · ${hora}${camarero ? ' · ' + camarero : ''}</div>`
  );

  colaImpresion.push(htmlFinal);
  procesarColaImpresion();
}

function procesarColaImpresion() {
  if (imprimiendoAhora || !colaImpresion.length) return;
  imprimiendoAhora = true;

  const html = colaImpresion.shift();

  let finalizado = false;
  const limpiarYSeguir = () => {
    if (finalizado) return;
    finalizado = true;
    clearTimeout(timeoutSeguridad);
    iframeComanda.onload = null;
    window.__comanderoPrintDone = () => {};
    iframeComanda.srcdoc = '<!DOCTYPE html><html><body></body></html>';
    imprimiendoAhora = false;
    setTimeout(procesarColaImpresion, 120);
  };

  const timeoutSeguridad = setTimeout(limpiarYSeguir, 15000);

  iframeComanda.onload = () => {
    try {
      window.__comanderoPrintDone = limpiarYSeguir;
    } catch (e) {
      console.warn('Error impresion iframe:', e);
      limpiarYSeguir();
    }
  };

  iframeComanda.srcdoc = html;
}

function tick() {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

tick();
setInterval(tick, 10000);

function beep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(audioCtx.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(880, audioCtx.currentTime);
    g.gain.setValueAtTime(.4, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + .35);
    o.start();
    o.stop(audioCtx.currentTime + .35);
  } catch (e) {}
}

function construirStatsArticulos(listaEnvios) {
  const mapa = new Map();
  listaEnvios.forEach(({ mesaId, envioId, envio }) => {
    Object.entries(envio.lineas).forEach(([artId, linea]) => {
      if (linea.estado !== 'pendiente') return;
      const key = claveArticulo(linea);
      const qtyPendiente = Math.max(0, Number(linea.qty || 0) - Number(linea.qtyServida || 0));
      if (qtyPendiente <= 0) return;
      if (!mapa.has(key)) {
        mapa.set(key, {
          key,
          nombre: linea.nombre,
          nota: limpiarNotaSistema(linea.nota || ''),
          pendientes: [],
          totalPendiente: 0
        });
      }
      const grupo = mapa.get(key);
      grupo.pendientes.push({
        mesaId,
        envioId,
        artId,
        nombreMesa: mesasData[mesaId]?.nombre || mesaId,
        qtyPendiente
      });
      grupo.totalPendiente += qtyPendiente;
    });
  });
  return mapa;
}

function actualizarBannerGrupo() {
  const banner = document.getElementById('bulk-banner');
  const texto = document.getElementById('bulk-text');
  if (!banner || !texto || !bulkServeBtn) return;

  const grupo = grupoActivo ? statsArticulos.get(grupoActivo) : null;
  if (!grupo || grupo.pendientes.length < 2) {
    banner.classList.remove('open');
    bulkServeBtn.disabled = true;
    return;
  }

  const mesasTxt = [...new Set(grupo.pendientes.map(item => item.nombreMesa))].join(', ');
  const notaTxt = grupo.nota ? ` (${grupo.nota})` : '';
  texto.textContent = `${grupo.totalPendiente} uds pendientes de "${grupo.nombre}"${notaTxt} en: ${mesasTxt}`;
  banner.classList.add('open');
  bulkServeBtn.disabled = false;
}

function tiempoRelativo(ts) {
  const diff = Math.floor((Date.now() - ts) / 60000);
  if (diff < 1) return 'ahora';
  if (diff === 1) return 'hace 1 min';
  return `hace ${diff} min`;
}

function detectarNuevos() {
  nuevosActivos.clear();
  Object.entries(pedidosPorMesa).forEach(([, envios]) => {
    Object.entries(envios).forEach(([envioId, envio]) => {
      const visto = vistos.has(envioId);
      const tienePendiente = Object.values(envio.lineas).some(l => l.estado === 'pendiente');
      if (!visto && tienePendiente) nuevosActivos.add(envioId);
    });
  });

  const hay = nuevosActivos.size > 0;
  document.body.classList.toggle('hay-nuevos', hay);
  const badge = document.getElementById('badge-nuevos');
  if (hay) {
    badge.style.display = '';
    badge.textContent = nuevosActivos.size + (nuevosActivos.size === 1 ? ' comanda nueva' : ' comandas nuevas');
  } else {
    badge.style.display = 'none';
  }
}

function marcarVistaEnvio(envioId) {
  vistos.add(envioId);
  saveVistos();
  const card = document.getElementById('card-' + envioId);
  if (card) card.classList.remove('nueva');
  nuevosActivos.delete(envioId);
  detectarNuevos();
}

function marcarImpreso(envioId) {
  impresos.add(envioId);
  saveImpresos();
  const btn = document.querySelector(`#card-${CSS.escape(envioId)} .btn-imprimir`);
  if (btn) {
    btn.classList.remove('pendiente');
    btn.classList.add('impresa');
    btn.title = 'Impresa';
  }
}

function renderPedidos() {
  const grid = document.getElementById('pedidos-grid');
  const empty = document.getElementById('empty-state');
  const listaEnvios = [];

  Object.entries(pedidosPorMesa).forEach(([mesaId, envios]) => {
    Object.entries(envios).forEach(([envioId, envio]) => {
      const tienePendiente = Object.values(envio.lineas).some(l => l.estado === 'pendiente');
      if (tienePendiente) listaEnvios.push({ envioId, mesaId, envio });
    });
  });

  if (!listaEnvios.length) {
    grupoActivo = null;
    actualizarBannerGrupo();
    empty.style.display = '';
    grid.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  grid.style.display = '';
  grid.innerHTML = '';
  statsArticulos = construirStatsArticulos(listaEnvios);
  if (grupoActivo && !statsArticulos.has(grupoActivo)) grupoActivo = null;
  actualizarBannerGrupo();

  listaEnvios
    .sort((a, b) => (a.envio.ts || 0) - (b.envio.ts || 0))
    .forEach(({ envioId, mesaId, envio }) => {
      grid.appendChild(crearCard(envioId, mesaId, envio));
    });
}

function crearCard(envioId, mesaId, envio) {
  const esNuevo = nuevosActivos.has(envioId);
  const pendienteImpresion = !impresos.has(envioId);
  const nombreMesa = mesasData[mesaId]?.nombre || mesaId;
  const card = document.createElement('div');
  card.className = 'mesa-card' + (esNuevo ? ' nueva' : '');
  card.id = 'card-' + envioId;

  const header = document.createElement('div');
  header.className = 'card-header';
  header.innerHTML = `
    <span class="dot"></span>
    <span class="card-mesa-name">Mesa ${nombreMesa}</span>
    <span class="card-time">${envio.ts ? tiempoRelativo(envio.ts) : ''}</span>
    ${envio.camarero ? `<span style="font-size:10px;color:var(--muted);font-family:var(--mono)">${envio.camarero}</span>` : ''}
    <button class="btn-imprimir ${pendienteImpresion ? 'pendiente' : 'impresa'}" onclick="imprimirEnvio('${envioId}','${mesaId}')" title="${pendienteImpresion ? 'Pendiente de imprimir' : 'Impresa'}">P</button>
  `;
  header.addEventListener('click', e => {
    if (e.target.closest('.btn-imprimir')) return;
    marcarVistaEnvio(envioId);
  });
  card.appendChild(header);

  Object.entries(envio.lineas)
    .filter(([, l]) => {
      if (l.estado === 'cancelado') return false;
      if (l.estado === 'servido' && !modoTachar) return false;
      return true;
    })
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([artId, linea]) => {
      const esServida = linea.estado === 'servido';
      const key = claveArticulo(linea);
      const group = statsArticulos.get(key);
      const totalPendienteGrupo = group?.totalPendiente || 0;
      const repeticiones = group?.pendientes.length || 0;
      const mostrarAgrupacion = repeticiones > 1;
      const row = document.createElement('div');
      row.className = 'linea-row' + (esServida ? ' servida' : '') + (!esServida && grupoActivo === key ? ' group-match' : '');
      row.id = 'linea-' + envioId + '-' + artId;

      const main = document.createElement('div');
      main.className = 'linea-main';

      const countBtn = document.createElement('button');
      countBtn.className = 'linea-count' + (mostrarAgrupacion ? '' : ' hidden') + (grupoActivo === key ? ' active' : '');
      countBtn.type = 'button';
      countBtn.textContent = mostrarAgrupacion ? String(totalPendienteGrupo) : '1';
      countBtn.title = mostrarAgrupacion ? `Ver ${totalPendienteGrupo} uds pendientes de este artículo` : '';
      countBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (repeticiones <= 1) return;
        grupoActivo = grupoActivo === key ? null : key;
        actualizarBannerGrupo();
        renderPedidos();
      });
      main.appendChild(countBtn);

      if (esServida) {
        main.insertAdjacentHTML('beforeend', `
          <span class="linea-qty">${linea.qty}</span>
          <span class="linea-nombre">${linea.nombre}</span>
          <span class="linea-actions">
            <span class="btn-servido hecho">✅</span>
            <button class="btn-deshacer" onclick="deshacerServido('${mesaId}','${envioId}','${artId}',this)" title="Deshacer">↩</button>
          </span>
        `);
      } else {
        const qtyServida = linea.qtyServida || 0;
        const qtyPendiente = Math.max(0, Number(linea.qty || 0) - qtyServida);
        const progreso = qtyServida > 0
          ? ` <span style="font-size:10px;color:var(--accent);font-family:var(--mono)">(${qtyServida}/${linea.qty})</span>`
          : '';
        main.insertAdjacentHTML('beforeend', `
          <span class="linea-qty">${qtyPendiente || linea.qty}</span>
          <span class="linea-nombre">${linea.nombre}${progreso}</span>
          <span class="linea-actions">
            <button class="btn-servido" onclick="marcarServido('${mesaId}','${envioId}','${artId}',this)" title="Servido">✅</button>
            ${linea.qty > 1 ? `<button class="btn-parcial" onclick="servirParcial('${mesaId}','${envioId}','${artId}',${linea.qty},'${escapeAttr(linea.nombre)}')" title="Servir parcial">½</button>` : ''}
            <button class="btn-stock" onclick="marcarSinStock('${mesaId}','${envioId}','${artId}',this)" title="Sin stock">✕</button>
          </span>
        `);
      }

      row.appendChild(main);

      const notaLimpia = notaVisible(linea.nota || '');
      if (notaLimpia) {
        const nota = document.createElement('div');
        nota.className = 'linea-nota';
        nota.textContent = '↳ ' + notaLimpia;
        row.appendChild(nota);
      }

      card.appendChild(row);
    });

  return card;
}

function actualizarLineaLocal(mesaId, envioId, artId, cambios) {
  const linea = pedidosPorMesa[mesaId]?.[envioId]?.lineas?.[artId];
  if (!linea) return;
  Object.assign(linea, cambios);
}

async function marcarLineasComoServidas(lineasGrupo) {
  const updates = {};
  const enviosAfectados = new Set();

  lineasGrupo.forEach(({ mesaId, envioId, artId }) => {
    const lineaActual = pedidosPorMesa[mesaId]?.[envioId]?.lineas?.[artId];
    if (!lineaActual || lineaActual.estado !== 'pendiente') return;

    const eraComprobacion = (lineaActual.nota || '').includes('⚠️ Comprobar');
    const notaBase = limpiarNotaSistema(lineaActual.nota || '');

    updates[`pedidos/${mesaId}/${envioId}/lineas/${artId}/estado`] = 'servido';
    updates[`pedidos/${mesaId}/${envioId}/lineas/${artId}/qtyServida`] = null;
    if (eraComprobacion) {
      updates[`pedidos/${mesaId}/${envioId}/lineas/${artId}/nota`] = notaBase;
      updates[`pedidos/${mesaId}/${envioId}/lineas/${artId}/verificado`] = true;
    }
    enviosAfectados.add(envioId);
  });

  if (!Object.keys(updates).length) return;
  await update(ref(db), updates);
  enviosAfectados.forEach(envioId => vistos.add(envioId));
  saveVistos();
}

window.marcarServido = async (mesaId, envioId, artId, btn) => {
  if (!btn || btn.classList.contains('hecho')) return;
  btn.disabled = true;
  btn.textContent = '...';
  await marcarLineasComoServidas([{ mesaId, envioId, artId }]);
  btn.disabled = false;
};

window.deshacerServido = async (mesaId, envioId, artId) => {
  await set(ref(db, `pedidos/${mesaId}/${envioId}/lineas/${artId}/estado`), 'pendiente');
};

window.servirParcial = async (mesaId, envioId, artId, qtyTotal, nombreArt) => {
  const snapLinea = await get(ref(db, `pedidos/${mesaId}/${envioId}/lineas/${artId}`));
  const lineaActual = snapLinea.val() || {};
  const esComprobacion = (lineaActual.nota || '').includes('⚠️ Comprobar');
  const qtyYaServida = lineaActual.qtyServida || 0;
  const qtyRestante = qtyTotal - qtyYaServida;

  document.getElementById('modal-title').textContent = esComprobacion ? '⚠️ Comprobación' : 'Servir parcialmente';
  document.getElementById('modal-body').innerHTML = `
    <p style="margin-bottom:.75rem;color:var(--muted);font-size:13px">
      "${nombreArt}" — ${qtyRestante} pendientes${qtyYaServida > 0 ? ` (${qtyYaServida} ya servidas)` : ''}
    </p>
    <input id="input-parcial" type="number" min="1" max="${qtyRestante}" value="${qtyRestante}"
      style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;
      padding:12px;font-size:22px;font-family:var(--mono);color:var(--text);text-align:center;
      outline:none;pointer-events:all;touch-action:manipulation" />
  `;

  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';

  const btnC = document.createElement('button');
  btnC.className = 'modal-btn';
  btnC.textContent = 'Cancelar';
  btnC.onclick = () => document.getElementById('modal-overlay').classList.remove('open');

  const btnS = document.createElement('button');
  btnS.className = 'modal-btn primary';
  btnS.textContent = 'Servir';
  btnS.onclick = async () => {
    const n = parseInt(document.getElementById('input-parcial')?.value);
    if (isNaN(n) || n < 1 || n > qtyRestante) return;
    document.getElementById('modal-overlay').classList.remove('open');

    const notaBase = limpiarNotaSistema(lineaActual.nota || '');
    const nuevasServidas = qtyYaServida + n;
    const restoAun = qtyRestante - n;

    await set(ref(db, `pedidos/${mesaId}/${envioId}/lineas/${artId}/qtyServida`), nuevasServidas);
    await set(ref(db, `pedidos/${mesaId}/${envioId}/lineas/${artId}/nota`), notaBase);
    if (esComprobacion) {
      await set(ref(db, `pedidos/${mesaId}/${envioId}/lineas/${artId}/verificado`), true);
    }
    actualizarLineaLocal(mesaId, envioId, artId, {
      qtyServida: nuevasServidas,
      nota: notaBase,
      ...(esComprobacion ? { verificado: true } : {})
    });
    renderPedidos();

    if (restoAun <= 0) {
      await update(ref(db), {
        [`pedidos/${mesaId}/${envioId}/lineas/${artId}/estado`]: 'servido',
        [`pedidos/${mesaId}/${envioId}/lineas/${artId}/qtyServida`]: null,
        [`pedidos/${mesaId}/${envioId}/lineas/${artId}/nota`]: notaBase,
        ...(esComprobacion ? { [`pedidos/${mesaId}/${envioId}/lineas/${artId}/verificado`]: true } : {})
      });
      actualizarLineaLocal(mesaId, envioId, artId, {
        estado: 'servido',
        qtyServida: null,
        nota: notaBase,
        ...(esComprobacion ? { verificado: true } : {})
      });
      renderPedidos();
      return;
    }

    showModal({
      title: `Quedan ${restoAun} sin servir`,
      body: `¿Qué hacemos con ${restoAun}× "${nombreArt}"?`,
      buttons: [
        {
          label: 'Sin stock — anular',
          style: 'danger',
          action: async () => {
            await update(ref(db), {
              [`pedidos/${mesaId}/${envioId}/lineas/${artId}/qty`]: nuevasServidas,
              [`pedidos/${mesaId}/${envioId}/lineas/${artId}/estado`]: 'servido',
              [`pedidos/${mesaId}/${envioId}/lineas/${artId}/qtyServida`]: null,
              [`pedidos/${mesaId}/${envioId}/lineas/${artId}/nota`]: notaBase
            });
            actualizarLineaLocal(mesaId, envioId, artId, {
              qty: nuevasServidas,
              estado: 'servido',
              qtyServida: null,
              nota: notaBase
            });
            renderPedidos();
          }
        },
        {
          label: 'Mantener pendiente',
          action: () => {}
        }
      ]
    });
  };

  acts.appendChild(btnC);
  acts.appendChild(btnS);
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => {
    const i = document.getElementById('input-parcial');
    if (i) {
      i.focus();
      i.select();
    }
  }, 120);
};

window.marcarSinStock = async (mesaId, envioId, artId, btn) => {
  if (btn.disabled) return;
  btn.disabled = true;
  await set(ref(db, `pedidos/${mesaId}/${envioId}/lineas/${artId}/estado`), 'cancelado');
  const row = btn.closest('.linea-row');
  if (row) {
    row.style.opacity = '.3';
    row.style.textDecoration = 'line-through';
  }
  btn.disabled = false;

  const snap = await get(ref(db, `pedidos/${mesaId}/${envioId}/lineas`));
  const lineas = snap.val() || {};
  const quedan = Object.values(lineas).filter(l =>
    (l.destino === ROL || l.destino === 'ambos') && l.estado === 'pendiente'
  );
  if (!quedan.length) {
    nuevosActivos.delete(envioId);
    detectarNuevos();
    setTimeout(() => renderPedidos(), 600);
  }
};

window.imprimirEnvio = (envioId, mesaId) => {
  const envio = pedidosPorMesa[mesaId]?.[envioId];
  if (!envio) return;
  const lineas = Object.values(envio.lineas).filter(l => l.estado === 'pendiente');
  if (!lineas.length) return;
  const nombre = mesasData[mesaId]?.nombre || mesaId;
  marcarImpreso(envioId);
  imprimirComanda(nombre, lineas);
  if (autoTXT) generarTXT(nombre, lineas);
};

window.imprimirMesa = (envioId, mesaId) => window.imprimirEnvio(envioId, mesaId);

if (bulkClearBtn) {
  bulkClearBtn.addEventListener('click', () => {
    grupoActivo = null;
    actualizarBannerGrupo();
    renderPedidos();
  });
}

if (bulkServeBtn) {
  bulkServeBtn.addEventListener('click', () => {
    const grupo = grupoActivo ? statsArticulos.get(grupoActivo) : null;
    if (!grupo || grupo.pendientes.length < 2) return;
    showModal({
      title: 'Marcar grupo servido',
      body: `Se marcarán ${grupo.pendientes.length} líneas de "${grupo.nombre}" a la vez.`,
      buttons: [
        { label: 'Cancelar' },
        {
          label: 'Confirmar',
          style: 'primary',
          action: async () => {
            await marcarLineasComoServidas(grupo.pendientes);
            grupoActivo = null;
          }
        }
      ]
    });
  });
}

onValue(ref(db, 'mesas'), snap => {
  mesasData = snap.val() || {};
});

onValue(ref(db, 'config/local'), snap => {
  configLocal = snap.val() || {};
});

onValue(ref(db, 'pedidos'), snap => {
  const all = snap.val() || {};
  pedidosPorMesa = {};

  Object.entries(all).forEach(([mesaId, envios]) => {
    Object.entries(envios).forEach(([envioId, envio]) => {
      const lineas = envio.lineas || { [envioId]: envio };
      const mias = Object.entries(lineas).filter(([, l]) =>
        l.destino === ROL || l.destino === 'ambos'
      );
      if (!mias.length) return;
      if (!pedidosPorMesa[mesaId]) pedidosPorMesa[mesaId] = {};
      pedidosPorMesa[mesaId][envioId] = {
        ts: envio.ts || 0,
        camarero: envio.camarero || '',
        envioId,
        lineas: Object.fromEntries(mias)
      };
    });
  });

  detectarNuevos();
  renderPedidos();

  if (primeraVez) {
    primeraVez = false;
    return;
  }

  if (nuevosActivos.size > 0) {
    beep();
    nuevosActivos.forEach(envioKey => {
      let encontrado = null;
      let mesaNombre = '';
      Object.entries(pedidosPorMesa).forEach(([mesaId, envios]) => {
        if (envios[envioKey]) {
          encontrado = envios[envioKey];
          mesaNombre = mesasData[mesaId]?.nombre || mesaId;
        }
      });
      if (!encontrado) return;
      const lineas = Object.values(encontrado.lineas).filter(l => l.estado === 'pendiente');
      if (!lineas.length) return;
      vistos.add(envioKey);
      saveVistos();
      if (autoImprimir) imprimirComanda(mesaNombre, lineas);
      if (autoTXT) generarTXT(mesaNombre, lineas);
    });
  }
});
