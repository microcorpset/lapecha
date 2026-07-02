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
import { ref, onValue, push, set, remove, get, update, query, orderByChild, limitToLast }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  fmtFechaVf, buildLineasVf, siguienteNumero, verNumeroActual,
  guardarFacturaEmitida, emitirSimplificada, emitirCompleta,
  emitirSustitutiva, emitirRectificativa, anularFactura, consultarEstado,
  labelTipoFactura
} from './verifacti.js';


await authReady;
cargarClientesAutocomplete();

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────
// carrito: key → { art, qty, nota }
// key es artId para artículos simples, artId__v{idx} para variantes
let mesaId = null, mesaNombre = null;
let carrito = {};
let mesasData = {};
let menuCache = {};
try {
  menuCache = JSON.parse(localStorage.getItem('comandero_menu_cache') || '{}');
} catch (e) {
  console.error('Error al leer caché de menú:', e);
}
let cachedVersion = localStorage.getItem('comandero_menu_version') || '0';

let categoriasData = menuCache.categorias || {};
let cartaData = menuCache.carta || {};
let catsReady = !!menuCache.categorias;
let cartaReady = !!menuCache.carta;
let configLocal = {};
let configVf = {};
let ticketEditMode = false;
let ticketSimplificado = true;
let ticketPreciosMode = false;
let ticketPreciosCustom = {};
let drawerNotasAbiertas = new Set();
let mesasViewMode = localStorage.getItem('mesas_view_mode') || 'grid';
let planoInfoMode = 'resumen';
let planoCfg = { cols: 16, rows: 12 };
let planoZonaActiva = null;
let pedidosData = {};
let alertasConfig = { verde: 10, amarillo: 20 };

let isFirebaseConnected = false;
let isSyncInProgress = false;
const queuedMesas = new Set();   // mesaIds con pedidos en cola IDB
const localOcupada = new Set();   // mesas marcadas ocupadas offline
const queuedPedidosLocal = {};          // pedidos locales pendientes de sync

// ── USUARIOS / PIN multi-camarero ─────────────────────────────────────────────
const PIN_SESSION = 'cam_auth';
const USER_SESSION = 'cam_user';
let usuariosData = {};
let camareroActual = sessionStorage.getItem(USER_SESSION) || '';
let pinBuffer = '';
let seguridadData = {};
let camareroKeyActual = '';

onValue(ref(db, 'config/usuarios'), s => {
  usuariosData = s.val() || {};
  if (!Object.keys(usuariosData).length) {
    get(ref(db, 'config/pins/camarero')).then(p => {
      if (p.val()) usuariosData['_default'] = { nombre: 'Camarero', pin: p.val() };
      else usuariosData['_default'] = { nombre: 'Camarero', pin: '1234' };
    });
  }
}, () => {
  usuariosData['_default'] = { nombre: 'Camarero', pin: '1234' };
});

if (sessionStorage.getItem(PIN_SESSION) === '1' && camareroActual) {
  document.getElementById('pin-screen').style.display = 'none';
  document.getElementById('topbar-camarero').textContent = camareroActual;
  comprobarNovedadesFirebase();
  setTimeout(() => { if (typeof actualizarCabecera === 'function') actualizarCabecera(); }, 50);
}

// Fallback to hide PIN screen connection loader after 3 seconds
setTimeout(() => {
  const pLoad = document.getElementById('pin-loading');
  if (pLoad) pLoad.style.display = 'none';
}, 3000);

// State for security and emoji authentication
let pinFailCount = 0;
let emojiFailCount = 0;
let lockoutActive = false;
let correctPinCached = '';
let registeredEmojis = null;
const EMOJI_LIST = ['🍔', '🍺', '🍕', '🍷', '☕', '🍰', '🍦', '🍟', '🌮', '🥗'];
window.filtroCategoriaActivo = "";
window.filtroSearchText = "";
const NOTAS_PREDEFINIDAS = ["Sin cebolla", "Poco hecho", "Muy hecho", "Sin hielo", "Para llevar", "Salsa aparte", "Sin lactosa", "Sin gluten", "Sin sal"];

window.drawerChipsColapsados = new Set();

window.actualizarCabecera = () => {
  const titleEl = document.getElementById('topbar-title');
  if (!titleEl) return;
  if (!camareroActual) {
    titleEl.textContent = 'Comandero 2.7';
    return;
  }
  if (mesaNombre) {
    titleEl.textContent = `${camareroActual} - Mesa ${mesaNombre}`;
  } else {
    titleEl.textContent = camareroActual;
  }
};

window.obtenerNotasPredefinidasArticulo = (artId) => {
  const art = cartaData[artId];
  if (art) {
    if (art.notasPredefinidas && art.notasPredefinidas.trim()) {
      return art.notasPredefinidas.split(',').map(n => n.trim()).filter(Boolean);
    }
    const catId = art.catId;
    const cat = categoriasData[catId];
    if (cat && cat.notasPredefinidas && cat.notasPredefinidas.trim()) {
      return cat.notasPredefinidas.split(',').map(n => n.trim()).filter(Boolean);
    }
  }
  return NOTAS_PREDEFINIDAS;
};

function lockoutDevice(durationSeconds = 30) {
  lockoutActive = true;
  let remaining = durationSeconds;
  
  const errorEl = document.getElementById('pin-error');
  errorEl.textContent = `Bloqueado. Intenta en ${remaining}s`;
  errorEl.style.color = '#ff6b6b';
  errorEl.style.display = 'block';
  updatePinDots(true);
  
  const emojiConfirmBtn = document.getElementById('emoji-btn-confirm');
  if (emojiConfirmBtn) {
    emojiConfirmBtn.disabled = true;
    emojiConfirmBtn.textContent = `Bloqueado (${remaining}s)`;
  }
  const emojiErrorEl = document.getElementById('emoji-error');
  if (emojiErrorEl) {
    emojiErrorEl.textContent = `Dispositivo bloqueado por seguridad.`;
    emojiErrorEl.style.display = 'block';
  }

  const interval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(interval);
      lockoutActive = false;
      errorEl.style.display = 'none';
      errorEl.textContent = 'PIN incorrecto';
      errorEl.style.color = '#ff7d7d';
      pinBuffer = '';
      updatePinDots(false);
      
      if (emojiConfirmBtn) {
        emojiConfirmBtn.disabled = false;
        emojiConfirmBtn.textContent = 'Confirmar Acceso';
      }
      if (emojiErrorEl) {
        emojiErrorEl.style.display = 'none';
        emojiErrorEl.textContent = 'Combinación incorrecta';
      }
    } else {
      errorEl.textContent = `Bloqueado. Intenta en ${remaining}s`;
      if (emojiConfirmBtn) {
        emojiConfirmBtn.textContent = `Bloqueado (${remaining}s)`;
      }
    }
  }, 1000);
}

// --- GPS GEOLOCATION HELPERS ---
function obtenerPosicionGPS(timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocalización no soportada por el navegador'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: timeout,
      maximumAge: 60000
    });
  });
}

function calcularDistanciaHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Radio de la Tierra en metros
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


window.pinKey = d => {
  if (lockoutActive) return;
  if (pinBuffer.length >= 4) return;
  pinBuffer += d; updatePinDots();
  if (pinBuffer.length === 4) verificarPin();
};
window.pinDel = () => {
  if (lockoutActive) return;
  pinBuffer = pinBuffer.slice(0, -1); updatePinDots(false);
  document.getElementById('pin-error').style.display = 'none';
};
function updatePinDots(error) {
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('pd' + i);
    dot.className = 'pin-dot' + (i < pinBuffer.length ? (error ? ' error' : ' filled') : '');
  }
}
async function verificarPin() {
  if (lockoutActive) return;
  const matchEntry = Object.entries(usuariosData).find(([key, u]) => u.pin === pinBuffer);
  if (!matchEntry) {
    pinFailCount++;
    updatePinDots(true);
    document.getElementById('pin-error').textContent = 'PIN incorrecto';
    document.getElementById('pin-error').style.display = 'block';
    logAuditoria('login_incorrecto_pin', `Intento fallido de PIN. PIN probado: ${pinBuffer}`, { intento: pinFailCount });
    
    if (pinFailCount >= 3) {
      logAuditoria('login_bloqueado', `Acceso bloqueado tras 3 fallos de PIN. PIN probado: ${pinBuffer}`);
      pinFailCount = 0;
      lockoutDevice(30);
    } else {
      setTimeout(() => { pinBuffer = ''; updatePinDots(false); document.getElementById('pin-error').style.display = 'none'; }, 900);
    }
    return;
  }

  const [matchKey, match] = matchEntry;

  // 1. Validar si el camarero está inactivo
  if (match.activo === false) {
    const errEl = document.getElementById('pin-error');
    errEl.textContent = 'Acceso denegado: este camarero está desactivado.';
    errEl.style.display = 'block';
    updatePinDots(true);
    setTimeout(() => {
      pinBuffer = '';
      updatePinDots(false);
      errEl.style.display = 'none';
    }, 3000);
    return;
  }

  // 2. Validar bloqueo total de camareros (cierre del local)
  if (seguridadData && seguridadData.bloqueoCamareros === true && seguridadData.excepcionCamarero !== matchKey) {
    const errEl = document.getElementById('pin-error');
    errEl.textContent = 'Acceso denegado: el comandero está cerrado.';
    errEl.style.display = 'block';
    updatePinDots(true);
    setTimeout(() => {
      pinBuffer = '';
      updatePinDots(false);
      errEl.style.display = 'none';
    }, 3000);
    return;
  }

  // Validar IP si la seguridad esta habilitada en Firebase
  if (seguridadData && seguridadData.wifiRestricted) {
    const errEl = document.getElementById('pin-error');
    const originalText = errEl.textContent;
    errEl.textContent = 'Comprobando red del local...';
    errEl.style.display = 'block';

    try {
      // Intentar obtener la IP con timeout de 5 segundos
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
      clearTimeout(timeoutId);

      const data = await resp.json();
      const ipActual = data.ip;

      if (ipActual !== seguridadData.wifiIP) {
        errEl.textContent = 'Acceso denegado: debes estar en la Wi-Fi del local.';
        errEl.style.display = 'block';
        updatePinDots(true);
        setTimeout(() => {
          pinBuffer = '';
          updatePinDots(false);
          errEl.style.display = 'none';
          errEl.textContent = originalText;
        }, 3000);
        return;
      }
    } catch (e) {
      errEl.textContent = 'Error de conexion al validar la Wi-Fi.';
      errEl.style.display = 'block';
      updatePinDots(true);
      setTimeout(() => {
        pinBuffer = '';
        updatePinDots(false);
        errEl.style.display = 'none';
        errEl.textContent = originalText;
      }, 3000);
      return;
    }
  }

  // 2.5. Validar Geolocalización GPS si está ACTIVADA
  if (seguridadData && seguridadData.geoActivo === true) {
    const geoLat = seguridadData.geoLat;
    const geoLng = seguridadData.geoLng;
    const geoRadio = seguridadData.geoRadio || 100;
    const geoIntervaloMs = (seguridadData.geoIntervaloHoras || 3) * 3600000;
    if (geoLat != null && geoLng != null) {
      const ultimaValidacionGeo = parseInt(localStorage.getItem('geo_validated_at') || '0');
      const tiempoDesdeUltima = Date.now() - ultimaValidacionGeo;
      if (tiempoDesdeUltima >= geoIntervaloMs) {
        const errEl = document.getElementById('pin-error');
        errEl.textContent = 'Comprobando ubicación GPS...';
        errEl.style.display = 'block';
        try {
          const pos = await obtenerPosicionGPS(10000);
          const distancia = calcularDistanciaHaversine(pos.coords.latitude, pos.coords.longitude, geoLat, geoLng);
          if (distancia > geoRadio) {
            errEl.textContent = `Acceso denegado: estás a ${Math.round(distancia)}m del local (máx: ${geoRadio}m).`;
            errEl.style.display = 'block';
            updatePinDots(true);
            setTimeout(() => { pinBuffer = ''; updatePinDots(false); errEl.style.display = 'none'; }, 4000);
            return;
          }
          localStorage.setItem('geo_validated_at', String(Date.now()));
        } catch (e) {
          errEl.textContent = 'Error al obtener ubicación GPS. Activa la ubicación en tu dispositivo.';
          errEl.style.display = 'block';
          updatePinDots(true);
          setTimeout(() => { pinBuffer = ''; updatePinDots(false); errEl.style.display = 'none'; }, 4000);
          return;
        }
        errEl.style.display = 'none';
      }
    }
  }

  camareroActual = match.nombre;
  camareroKeyActual = matchKey;
  correctPinCached = pinBuffer;
  const pin = pinBuffer;
  pinBuffer = '';
  updatePinDots(false);
  pinFailCount = 0; // Reset counter on correct PIN

  // 3. Validar emojis si está ACTIVADO
  if (seguridadData && seguridadData.emojisActivo === true) {
    const emojisConfigurados = seguridadData.emojisAcceso || '';
    if (emojisConfigurados) {
      const localSaved = localStorage.getItem('emoji_auth_global');
      if (localSaved !== emojisConfigurados) {
        mostrarPantallaEmojis(pin);
        return;
      }
      // Emojis ya validados en este dispositivo
      loginExitosoCompleto(`Inicio de sesión (Acceso rápido por emojis del local): ${camareroActual} (PIN: ${pin})`);
      return;
    }
  }
  // Emojis desactivados o sin combinación → login directo
  loginExitosoCompleto(`Inicio de sesión: ${camareroActual} (PIN: ${pin})`);
}

let selectedEmojis = [];

function loginExitosoCompleto(detalleAuditoria) {
  sessionStorage.setItem(PIN_SESSION, '1');
  sessionStorage.setItem(USER_SESSION, camareroActual);
  document.getElementById('pin-screen').style.display = 'none';
  document.getElementById('emoji-screen').style.display = 'none';
  document.getElementById('topbar-camarero').textContent = camareroActual;
  actualizarCabecera();
  logAuditoria('login', detalleAuditoria);
  comprobarNovedadesFirebase();

  // Guardar último login del camarero
  if (camareroKeyActual) {
    update(ref(db, `config/usuarios/${camareroKeyActual}`), {
      ultimoLogin: Date.now()
    }).catch(e => console.error("Error al registrar ultimoLogin:", e));
  }
}

function initReels() {
  for (let r = 0; r < 3; r++) {
    const reel = document.getElementById(`reel-${r}`);
    if (reel && reel.children.length === 0) {
      reel.innerHTML = EMOJI_LIST.map(emoji => `<div class="emoji-item">${emoji}</div>`).join('');
    }
  }
}

function spinReel(reelIndex, value) {
  const reel = document.getElementById(`reel-${reelIndex}`);
  if (reel) {
    const offset = value * 70; // 70px por emoji
    reel.style.transform = `translateY(-${offset}px)`;
  }
  updateSelectedEmojisPreview();
}

function updateSelectedEmojisPreview() {
  const display = [];
  for (let i = 0; i < 3; i++) {
    display.push(selectedEmojis[i] || '❓');
  }
  document.getElementById('selected-emojis-preview').textContent = display.join(' ');
}

function mostrarPantallaEmojis(pin) {
  initReels();
  
  // Limpiar seleccion
  selectedEmojis = [];
  for (let r = 0; r < 3; r++) {
    spinReel(r, 0);
  }
  
  document.getElementById('emoji-error').style.display = 'none';
  
  const titleEl = document.getElementById('emoji-title');
  const subEl = document.getElementById('emoji-sub');
  const confirmBtn = document.getElementById('emoji-btn-confirm');
  
  titleEl.textContent = 'Emojis de Seguridad';
  subEl.textContent = 'Introduce los 3 emojis de seguridad del local';
  confirmBtn.textContent = 'Confirmar Acceso';
  
  document.getElementById('pin-screen').style.display = 'none';
  document.getElementById('emoji-screen').style.display = 'flex';
  
  renderEmojiPicker();
}

function renderEmojiPicker() {
  const container = document.getElementById('emoji-picker-grid');
  if (!container) return;
  container.innerHTML = EMOJI_LIST.map(emoji => `
    <button type="button" class="emoji-picker-btn" onclick="seleccionarEmoji('${emoji}')">${emoji}</button>
  `).join('');
}

window.seleccionarEmoji = function(emoji) {
  if (lockoutActive) return;
  if (selectedEmojis.length >= 3) return;
  
  const currentIdx = selectedEmojis.length;
  selectedEmojis.push(emoji);
  
  const emojiIndex = EMOJI_LIST.indexOf(emoji);
  if (emojiIndex !== -1) {
    spinReel(currentIdx, emojiIndex);
  }
};

window.limpiarSeleccionEmojis = function() {
  if (lockoutActive) return;
  selectedEmojis = [];
  for (let r = 0; r < 3; r++) {
    spinReel(r, 0);
  }
};

async function confirmarEmojis() {
  if (lockoutActive) return;
  
  if (selectedEmojis.length < 3) {
    const errEl = document.getElementById('emoji-error');
    errEl.textContent = 'Selecciona 3 emojis';
    errEl.style.display = 'block';
    return;
  }
  
  const selectedStr = selectedEmojis.join('');
  const pin = correctPinCached;
  const targetStr = seguridadData ? seguridadData.emojisAcceso : '';
  
  if (selectedStr === targetStr) {
    localStorage.setItem('emoji_auth_global', selectedStr);
    emojiFailCount = 0;
    loginExitosoCompleto(`Inicio de sesión (Emojis verificados): ${camareroActual} (PIN: ${pin}, Emojis: ${selectedStr})`);
  } else {
    emojiFailCount++;
    const errEl = document.getElementById('emoji-error');
    errEl.textContent = 'Combinación incorrecta';
    errEl.style.display = 'block';
    logAuditoria('login_incorrecto_emojis', `Intento fallido de emojis: ${selectedStr} (PIN: ${pin})`, { intento: emojiFailCount });
    
    if (emojiFailCount >= 3) {
      logAuditoria('login_bloqueado', `Acceso bloqueado tras 3 fallos de verificación de emojis. PIN: ${pin}. Emojis: ${selectedStr}`);
      emojiFailCount = 0;
      lockoutDevice(30);
    } else {
      setTimeout(() => {
        limpiarSeleccionEmojis();
        errEl.style.display = 'none';
      }, 1000);
    }
  }
}

async function comprobarNovedadesFirebase() {
  if (!camareroActual) return;
  try {
    const snapNovedades = await get(ref(db, 'novedades'));
    const novedades = snapNovedades.val() || {};
    
    // Filtrar las novedades activas y ordenar por fecha de creación (ascendente, el más antiguo primero)
    const activas = Object.values(novedades)
      .filter(n => n && n.activo)
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    if (activas.length === 0) return;

    const nombreClave = camareroActual.replace(/[\.\#\$\[\]]/g, '_');
    const snapVistas = await get(ref(db, `novedades_vistas/${nombreClave}`));
    const vistas = snapVistas.val() || {};

    // Filtrar las que no han sido vistas por este camarero
    const noVistas = activas.filter(n => !vistas[n.id]);
    if (noVistas.length === 0) return;

    // Tomar la primera novedad no vista
    const novedad = noVistas[0];

    // Rellenamos y abrimos el modal global de la app
    document.getElementById('modal-title').textContent = novedad.titulo;
    document.getElementById('modal-body').innerHTML = `<div style="font-size:14px; line-height:1.6; color:var(--text); white-space: pre-wrap;">${novedad.mensaje.trim()}</div>`;

    const btnVisto = document.createElement('button');
    btnVisto.className = 'modal-btn primary';
    btnVisto.style.width = '100%';
    btnVisto.textContent = 'Entendido';
    btnVisto.onclick = () => {
      set(ref(db, `novedades_vistas/${nombreClave}/${novedad.id}`), true).catch(err => {
        console.error("No se pudo registrar visto en Firebase:", err);
      });
      document.getElementById('modal-overlay').classList.remove('open');
      // Esperar a que se cierre el modal y comprobar si hay más pendientes
      setTimeout(() => {
        comprobarNovedadesFirebase();
      }, 300);
    };

    const actions = document.getElementById('modal-actions');
    actions.innerHTML = '';
    actions.appendChild(btnVisto);

    document.getElementById('modal-overlay').classList.add('open');
  } catch (error) {
    console.error("Error al comprobar novedades:", error);
  }
}

document.getElementById('pin-pad').addEventListener('click', e => {
  const btn = e.target.closest('[data-k]');
  if (!btn) return;
  const k = btn.dataset.k;
  if (k === 'del') pinDel();
  else if (k !== '') pinKey(k);
});

// EMOJI SLOT MACHINE LISTENERS
document.getElementById('emoji-btn-confirm').addEventListener('click', confirmarEmojis);

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

// ── TOGGLES COPIA / TXT / WAKE ────────────────────────────────────────────────
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
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { }
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

// Evitar recarga accidental de la página cuando se está en una mesa
window.addEventListener('beforeunload', (e) => {
  if (mesaId) {
    e.preventDefault();
    e.returnValue = '';
  }
});

window.toggleCatsPanel = () => {
  const panel = document.getElementById('cats-panel');
  if (!panel) return;
  const abierto = panel.style.display !== 'none' && panel.style.display !== '';
  panel.style.display = abierto ? 'none' : 'block';
};

window.cerrarCatsPanel = () => {
  const panel = document.getElementById('cats-panel');
  if (panel) panel.style.display = 'none';
};

document.addEventListener('click', e => {
  if (!e.target.closest('#cats-panel') && !e.target.closest('#btn-cats')) {
    window.cerrarCatsPanel();
  }
});

// ── Modal de nota ─────────────────────────────────────────────────────────────
window.abrirNotaModal = (artId, nombreArt) => {
  // Buscar nota del carrito: puede ser artId simple o primer variant key
  const carritoKey = Object.keys(carrito).find(k => k === artId || k.startsWith(artId + '__v')) || artId;
  const qty = carrito[carritoKey]?.qty || 0;
  
  if (qty === 0) {
    showModal({
      title: '⚠️ Cantidad requerida',
      body: 'Por favor, selecciona primero la cantidad del artículo antes de añadir una nota.',
      buttons: [{ label: 'Cerrar' }]
    });
    return;
  }

  const notaActual = carrito[carritoKey]?.nota || '';
  showModal({ title: '📝 ' + nombreArt, body: '', buttons: [] });
  const modalBody = document.getElementById('modal-body');
  modalBody.innerHTML = '';
  
  const flexContainer = document.createElement('div');
  flexContainer.style.cssText = 'display:flex;gap:6px;align-items:center;width:100%;';

  const inp = document.createElement('input');
  inp.type = 'text'; inp.value = notaActual;
  inp.placeholder = 'ej: poco hecho, sin cebolla…';
  inp.style.cssText = 'flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:14px;font-family:var(--sans);color:var(--text);outline:none;min-width:0;';
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') guardarNota(); });
  flexContainer.appendChild(inp);

  window.modalChipsColapsados = window.modalChipsColapsados || false;
  
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.textContent = window.modalChipsColapsados ? '➕' : '➖';
  toggleBtn.style.cssText = 'background:var(--surface3);border:none;border-radius:8px;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;color:var(--text);';
  toggleBtn.title = "Mostrar/ocultar notas rápidas";
  
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = '🧹';
  clearBtn.style.cssText = 'background:var(--surface3);border:none;border-radius:8px;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;color:var(--text);';
  clearBtn.title = "Limpiar nota";

  flexContainer.appendChild(toggleBtn);
  flexContainer.appendChild(clearBtn);
  modalBody.appendChild(flexContainer);

  // Inyectar chips de notas rápidas
  const notesList = obtenerNotasPredefinidasArticulo(artId);
  const chipsContainer = document.createElement('div');
  chipsContainer.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;';
  chipsContainer.style.display = window.modalChipsColapsados ? 'none' : 'flex';
  
  notesList.forEach(notaRapida => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = notaRapida;
    chip.style.cssText = 'background:var(--surface3);border:1px solid var(--border);border-radius:10px;padding:6px 10px;font-size:11px;font-weight:500;font-family:var(--sans);color:var(--text);cursor:pointer;transition:all 0.1s;';
    chip.addEventListener('click', () => {
      let currentVal = inp.value.trim();
      if (!currentVal) {
        inp.value = notaRapida;
      } else {
        const notasExistentes = currentVal.split(',').map(n => n.trim().toLowerCase());
        if (!notasExistentes.includes(notaRapida.toLowerCase())) {
          inp.value = currentVal + ', ' + notaRapida;
        }
      }
      inp.focus();
    });
    chipsContainer.appendChild(chip);
  });
  modalBody.appendChild(chipsContainer);

  toggleBtn.addEventListener('click', () => {
    window.modalChipsColapsados = !window.modalChipsColapsados;
    toggleBtn.textContent = window.modalChipsColapsados ? '➕' : '➖';
    chipsContainer.style.display = window.modalChipsColapsados ? 'none' : 'flex';
  });

  clearBtn.addEventListener('click', () => {
    inp.value = '';
    inp.focus();
  });

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

// ── Modal de Nuevo Pedido (Llevar / Domicilio / Local) ──────────────────────────
let npTipoPedido = 'Llevar';

window.setTipoPedido = (tipo) => {
  npTipoPedido = tipo;
  const btnLlevar = document.getElementById('btn-tipo-llevar');
  const btnDom = document.getElementById('btn-tipo-domicilio');
  const btnLocal = document.getElementById('btn-tipo-local');

  if (btnLlevar) btnLlevar.className = 'modal-btn' + (tipo === 'Llevar' ? ' primary' : '');
  if (btnDom) btnDom.className = 'modal-btn' + (tipo === 'Domicilio' ? ' primary' : '');
  if (btnLocal) btnLocal.className = 'modal-btn' + (tipo === 'Local' ? ' primary' : '');

  const divTel = document.getElementById('np-div-telefono');
  const divHora = document.getElementById('np-div-hora');

  if (tipo === 'Local') {
    if (divTel) divTel.style.display = 'none';
    if (divHora) divHora.style.display = 'none';
  } else {
    if (divTel) divTel.style.display = 'block';
    if (divHora) divHora.style.display = 'block';
  }
};

window.npSumarMinutos = (mins) => {
  const input = document.getElementById('np-hora');
  if (!input) return;
  let baseDate = new Date();
  if (input.value) {
    const [h, m] = input.value.split(':').map(Number);
    baseDate.setHours(h, m, 0, 0);
  }
  const futureDate = new Date(baseDate.getTime() + mins * 60000);
  const HH = String(futureDate.getHours()).padStart(2, '0');
  const MM = String(futureDate.getMinutes()).padStart(2, '0');
  input.value = `${HH}:${MM}`;
};

window.abrirNuevoPedidoModal = () => {
  npTipoPedido = 'Llevar';
  showModal({ title: '🛍️ Nuevo Pedido', body: '', buttons: [] });

  const modalBody = document.getElementById('modal-body');
  modalBody.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:12px; font-family:var(--sans)">
      <!-- Selector de Tipo -->
      <div style="display:flex; gap:6px;">
        <button id="btn-tipo-llevar" type="button" class="modal-btn primary" style="flex:1; padding:8px; border-radius:10px; font-size:12px; cursor:pointer;" onclick="window.setTipoPedido('Llevar')">🛍️ Llevar</button>
        <button id="btn-tipo-domicilio" type="button" class="modal-btn" style="flex:1; padding:8px; border-radius:10px; font-size:12px; cursor:pointer;" onclick="window.setTipoPedido('Domicilio')">🛵 Domicilio</button>
        <button id="btn-tipo-local" type="button" class="modal-btn" style="flex:1; padding:8px; border-radius:10px; font-size:12px; cursor:pointer;" onclick="window.setTipoPedido('Local')">🍺 Local</button>
      </div>
      
      <!-- Nombre de Cliente -->
      <div>
        <label style="display:block; font-size:11px; color:var(--muted); margin-bottom:4px; font-family:var(--mono);">CLIENTE</label>
        <input id="np-cliente" type="text" placeholder="Nombre (ej: Juan, María...)" required style="width:100%; padding:10px; border-radius:10px; border:1px solid var(--border); font-size:14px; background:var(--surface2); color:var(--text); outline:none;">
      </div>

      <!-- Teléfono -->
      <div id="np-div-telefono">
        <label style="display:block; font-size:11px; color:var(--muted); margin-bottom:4px; font-family:var(--mono);">TELÉFONO</label>
        <input id="np-telefono" type="tel" placeholder="Teléfono (opcional)" style="width:100%; padding:10px; border-radius:10px; border:1px solid var(--border); font-size:14px; background:var(--surface2); color:var(--text); outline:none;">
      </div>
    </div>
  `;

  // Foco en nombre del cliente
  setTimeout(() => {
    const inp = document.getElementById('np-cliente');
    if (inp) inp.focus();
  }, 100);

  // Configurar botones de acción
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';

  const btnCancel = document.createElement('button');
  btnCancel.className = 'modal-btn';
  btnCancel.textContent = 'Cancelar';
  btnCancel.onclick = () => {
    document.getElementById('modal-overlay').classList.remove('open');
  };

  const btnCrear = document.createElement('button');
  btnCrear.className = 'modal-btn primary';
  btnCrear.textContent = 'Crear pedido';
  btnCrear.onclick = async () => {
    const cliente = document.getElementById('np-cliente').value.trim();
    const telefono = document.getElementById('np-telefono').value.trim();
    if (!cliente) {
      const inp = document.getElementById('np-cliente');
      inp.style.border = '2px solid var(--danger)';
      inp.placeholder = '¡El nombre es obligatorio!';
      inp.focus();
      return;
    }
    document.getElementById('modal-overlay').classList.remove('open');
    await crearNuevoPedido(cliente, telefono, '');
  };

  acts.appendChild(btnCancel);
  acts.appendChild(btnCrear);
};

async function crearNuevoPedido(cliente, telefono, hora) {
  const newMesaId = 'temp_' + Date.now();
  const emoji = npTipoPedido === 'Domicilio' ? '🛵' : npTipoPedido === 'Local' ? '🍺' : '🛍️';
  const displayHora = npTipoPedido !== 'Local' && hora ? ` (${hora})` : '';
  const nombreMesa = `${emoji} ${cliente}${displayHora}`;

  const newMesa = {
    nombre: nombreMesa,
    estado: 'ocupada',
    zona: 'Pedidos',
    temporal: true,
    cliente: cliente,
    telefono: npTipoPedido !== 'Local' ? telefono : '',
    horaRecogida: npTipoPedido !== 'Local' ? hora : '',
    tipoPedido: npTipoPedido,
    creadoTs: Date.now()
  };

  // Guardar en Firebase
  await set(ref(db, 'mesas/' + newMesaId), newMesa);

  // Log auditoría
  logAuditoria('articulo_agregado', `Pedido temporal creado: ${nombreMesa}`, {
    cliente,
    telefono: newMesa.telefono,
    hora: newMesa.horaRecogida,
    tipo: npTipoPedido,
    mesaId: newMesaId,
    mesa: nombreMesa
  });

  // Abrir la comanda de la mesa temporal directamente
  abrirMesa(newMesaId, nombreMesa, true);
}

// ── Modal de Edición de Pedido Temporal ─────────────────────────────────────────
window.abrirEditarPedidoModal = () => {
  const m = mesasData[mesaId] || {};
  npTipoPedido = m.tipoPedido || 'Llevar';

  showModal({ title: '✏️ Editar Datos del Pedido', body: '', buttons: [] });

  const modalBody = document.getElementById('modal-body');
  modalBody.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:12px; font-family:var(--sans)">
      <!-- Selector de Tipo -->
      <div style="display:flex; gap:6px;">
        <button id="btn-tipo-llevar" type="button" class="modal-btn ${npTipoPedido === 'Llevar' ? 'primary' : ''}" style="flex:1; padding:8px; border-radius:10px; font-size:12px; cursor:pointer;" onclick="window.setTipoPedido('Llevar')">🛍️ Llevar</button>
        <button id="btn-tipo-domicilio" type="button" class="modal-btn ${npTipoPedido === 'Domicilio' ? 'primary' : ''}" style="flex:1; padding:8px; border-radius:10px; font-size:12px; cursor:pointer;" onclick="window.setTipoPedido('Domicilio')">🛵 Domicilio</button>
        <button id="btn-tipo-local" type="button" class="modal-btn ${npTipoPedido === 'Local' ? 'primary' : ''}" style="flex:1; padding:8px; border-radius:10px; font-size:12px; cursor:pointer;" onclick="window.setTipoPedido('Local')">🍺 Local</button>
      </div>
      
      <!-- Nombre de Cliente -->
      <div>
        <label style="display:block; font-size:11px; color:var(--muted); margin-bottom:4px; font-family:var(--mono);">CLIENTE</label>
        <input id="np-cliente" type="text" placeholder="Nombre" value="${m.cliente || ''}" required style="width:100%; padding:10px; border-radius:10px; border:1px solid var(--border); font-size:14px; background:var(--surface2); color:var(--text); outline:none;">
      </div>

      <!-- Teléfono -->
      <div id="np-div-telefono" style="display: ${npTipoPedido === 'Local' ? 'none' : 'block'};">
        <label style="display:block; font-size:11px; color:var(--muted); margin-bottom:4px; font-family:var(--mono);">TELÉFONO</label>
        <input id="np-telefono" type="tel" placeholder="Teléfono (opcional)" value="${m.telefono || ''}" style="width:100%; padding:10px; border-radius:10px; border:1px solid var(--border); font-size:14px; background:var(--surface2); color:var(--text); outline:none;">
      </div>

      <!-- Hora de Recogida -->
      <div id="np-div-hora" style="display: ${npTipoPedido === 'Local' ? 'none' : 'block'};">
        <label style="display:block; font-size:11px; color:var(--muted); margin-bottom:4px; font-family:var(--mono);">HORA DE RECOGIDA</label>
        <div style="display:flex; gap:6px; margin-bottom:6px;">
          <input id="np-hora" type="time" value="${m.horaRecogida || ''}" style="flex:1; padding:8px; border-radius:10px; border:1px solid var(--border); font-size:14px; background:var(--surface2); color:var(--text); outline:none;">
          <button type="button" class="modal-btn" style="padding:0 12px; font-size:12px;" onclick="window.npSumarMinutos(5)">+5m</button>
          <button type="button" class="modal-btn" style="padding:0 12px; font-size:12px;" onclick="window.npSumarMinutos(15)">+15m</button>
          <button type="button" class="modal-btn" style="padding:0 12px; font-size:12px;" onclick="window.npSumarMinutos(30)">+30m</button>
        </div>
      </div>
    </div>
  `;

  if (!m.horaRecogida && npTipoPedido !== 'Local') {
    const now = new Date();
    const future = new Date(now.getTime() + 15 * 60000);
    const HH = String(future.getHours()).padStart(2, '0');
    const MM = String(future.getMinutes()).padStart(2, '0');
    const horaInput = document.getElementById('np-hora');
    if (horaInput) horaInput.value = `${HH}:${MM}`;
  }

  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';

  const btnCancel = document.createElement('button');
  btnCancel.className = 'modal-btn';
  btnCancel.textContent = 'Cancelar';
  btnCancel.onclick = () => {
    document.getElementById('modal-overlay').classList.remove('open');
  };

  const btnGuardar = document.createElement('button');
  btnGuardar.className = 'modal-btn primary';
  btnGuardar.textContent = 'Guardar';
  btnGuardar.onclick = async () => {
    const cliente = document.getElementById('np-cliente').value.trim();
    const telefono = document.getElementById('np-telefono').value.trim();
    const hora = document.getElementById('np-hora').value;
    if (!cliente) {
      const inp = document.getElementById('np-cliente');
      inp.style.border = '2px solid var(--danger)';
      inp.placeholder = '¡El nombre es obligatorio!';
      inp.focus();
      return;
    }
    document.getElementById('modal-overlay').classList.remove('open');
    await guardarEdicionPedido(cliente, telefono, hora, npTipoPedido);
  };

  acts.appendChild(btnCancel);
  acts.appendChild(btnGuardar);
};

async function guardarEdicionPedido(cliente, telefono, hora, tipo) {
  const emoji = tipo === 'Domicilio' ? '🛵' : tipo === 'Local' ? '🍺' : '🛍️';
  const displayHora = tipo !== 'Local' && hora ? ` (${hora})` : '';
  const nuevoNombre = `${emoji} ${cliente}${displayHora}`;

  const updates = {
    nombre: nuevoNombre,
    cliente: cliente,
    telefono: tipo !== 'Local' ? telefono : '',
    horaRecogida: tipo !== 'Local' ? hora : '',
    tipoPedido: tipo
  };

  await update(ref(db, 'mesas/' + mesaId), updates);

  mesaNombre = nuevoNombre;
  document.getElementById('topbar-mesa').textContent = 'Mesa ' + nuevoNombre;
  actualizarCabecera();

  logAuditoria('cantidad_editada', `Pedido editado: ${nuevoNombre}`, {
    cliente,
    telefono: tipo !== 'Local' ? telefono : '',
    hora: tipo !== 'Local' ? hora : '',
    tipo,
    mesaId
  });

  cargarTicketActual();
}

// ── COLA OFFLINE (IndexedDB) ──────────────────────────────────────────────────
const IDB_NAME = 'cmd-queue';
const IDB_VER = 1;
const IDB_STORE = 'orders';
let idb = null;

function abrirIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = e => {
      if (!e.target.result.objectStoreNames.contains(IDB_STORE))
        e.target.result.createObjectStore(IDB_STORE, { keyPath: 'queueId', autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}
function idbTodos() {
  return new Promise((resolve, reject) => {
    const req = idb.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
    req.onsuccess = e => resolve(e.target.result || []);
    req.onerror = e => reject(e.target.error);
  });
}
function idbAgregar(registro) {
  return new Promise((resolve, reject) => {
    const req = idb.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).add(registro);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}
function idbEliminar(queueId) {
  return new Promise((resolve, reject) => {
    const req = idb.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).delete(queueId);
    req.onsuccess = () => resolve();
    req.onerror = e => reject(e.target.error);
  });
}

async function actualizarBannerOffline() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  const pendientes = idb ? await idbTodos() : [];
  if (isFirebaseConnected) {
    if (isSyncInProgress && pendientes.length > 0) {
      banner.style.display = 'flex';
      banner.style.background = 'rgba(61,122,255,.9)';
      banner.innerHTML =
        '<span class="offline-spinner"></span> Sincronizando ' +
        pendientes.length + ' pedido' + (pendientes.length > 1 ? 's' : '') + '…';
    } else {
      banner.style.display = 'none';
    }
  } else {
    banner.style.display = 'flex';
    banner.style.background = 'rgba(226,77,77,.92)';
    banner.innerHTML = pendientes.length > 0
      ? '📡 Sin conexión — ' + pendientes.length + ' pedido' +
      (pendientes.length > 1 ? 's' : '') + ' guardado' +
      (pendientes.length > 1 ? 's' : '') + ' en cola local'
      : '📡 Sin conexión — los pedidos se enviarán al reconectar';
  }
}

async function vaciarCola() {
  if (isSyncInProgress || !idb) return;
  const pendientes = await idbTodos();
  if (!pendientes.length) return;

  isSyncInProgress = true;
  actualizarBannerOffline();

  for (const item of pendientes) {
    try {
      await set(ref(db, 'mesas/' + item.mesaId + '/estado'), 'ocupada');
      await set(ref(db, 'pedidos/' + item.mesaId + '/' + item.envioId), {
        ts: item.envioTs, camarero: item.camarero, envioId: item.envioId,
        lineas: item.lineasObj
      });
      await idbEliminar(item.queueId);
      if (queuedPedidosLocal[item.mesaId])
        delete queuedPedidosLocal[item.mesaId][item.envioId];
      const resto = await idbTodos();
      if (!resto.some(r => r.mesaId === item.mesaId)) {
        queuedMesas.delete(item.mesaId);
        localOcupada.delete(item.mesaId);
      }
      actualizarBannerOffline();
    } catch (e) {
      break;
    }
  }

  isSyncInProgress = false;
  actualizarBannerOffline();
  renderMesas();
}

async function initCola() {
  try {
    idb = await abrirIDB();
    const pendientes = await idbTodos();
    pendientes.forEach(r => {
      queuedMesas.add(r.mesaId);
      localOcupada.add(r.mesaId);
      if (!queuedPedidosLocal[r.mesaId]) queuedPedidosLocal[r.mesaId] = {};
      queuedPedidosLocal[r.mesaId][r.envioId] = {
        ts: r.envioTs, camarero: r.camarero, envioId: r.envioId, lineas: r.lineasObj
      };
    });
    if (pendientes.length) { actualizarBannerOffline(); renderMesas(); }
  } catch (e) {
    console.warn('IndexedDB no disponible:', e);
  }
}

initCola();

// Inicializar estado de los botones de vista según localStorage
if (mesasViewMode === 'plano') {
  const btnGrid = document.getElementById('btn-vista-grid');
  const btnPlano = document.getElementById('btn-vista-plano');
  const gridEl = document.getElementById('mesas-grid');
  const planoEl = document.getElementById('plano-contenedor');
  if (btnGrid) btnGrid.classList.remove('active');
  if (btnPlano) btnPlano.classList.add('active');
  if (gridEl) gridEl.style.display = 'none';
  if (planoEl) planoEl.style.display = '';
  const btnInfo = document.getElementById('btn-plano-info');
  if (btnInfo) {
    btnInfo.style.display = '';
    btnInfo.textContent = planoInfoMode === 'resumen' ? '⏳ Pendientes' : '💰 Totales';
  }
  document.body.classList.add('plano-active');
}

// ── LISTENERS FIREBASE ────────────────────────────────────────────────────────
onValue(ref(db, 'mesas'), snap => { mesasData = snap.val() || {}; mesasViewMode === 'grid' ? renderMesas() : renderPlano(); });
// Escuchar cambios de versión del menú en tiempo real (ligero)
onValue(ref(db, 'config/menu_version'), async (snap) => {
  const version = String(snap.val() || '0');
  if (version !== cachedVersion || !catsReady || !cartaReady) {
    try {
      const [catsSnap, cartaSnap] = await Promise.all([
        get(ref(db, 'categorias')),
        get(ref(db, 'carta'))
      ]);
      categoriasData = catsSnap.val() || {};
      cartaData = cartaSnap.val() || {};
      catsReady = true;
      cartaReady = true;
      
      cachedVersion = version;
      localStorage.setItem('comandero_menu_version', version);
      localStorage.setItem('comandero_menu_cache', JSON.stringify({
        categorias: categoriasData,
        carta: cartaData
      }));
      
      if (mesaId) renderCarta();
    } catch (e) {
      console.error('Error al actualizar carta de Firebase:', e);
    }
  } else {
    if (mesaId) renderCarta();
  }
});
onValue(ref(db, 'config/local'), snap => {
  configLocal = snap.val() || {};
  const mesasLinks = document.getElementById('mesas-links');
  if (mesasLinks) mesasLinks.style.display = configLocal.comandaAutoServir ? 'none' : '';
});
onValue(ref(db, 'config/verifacti'), snap => { configVf = snap.val() || {}; });
onValue(ref(db, 'config/seguridad'), snap => { seguridadData = snap.val() || {}; });
onValue(ref(db, 'pedidos'), snap => {
  pedidosData = snap.val() || {};
  // Merge local queued orders so UI reflects offline-saved orders
  Object.entries(queuedPedidosLocal).forEach(([mid, envios]) => {
    if (!pedidosData[mid]) pedidosData[mid] = {};
    Object.assign(pedidosData[mid], envios);
  });
  mesasViewMode === 'grid' ? renderMesas() : renderPlano();
});
onValue(ref(db, 'config/alertas'), snap => {
  const d = snap.val();
  if (d) alertasConfig = { verde: d.verde || 10, amarillo: d.amarillo || 20 };
});
onValue(ref(db, 'config/plano'), snap => {
  const d = snap.val();
  if (d) planoCfg = { cols: Number(d.cols) || 16, rows: Number(d.rows) || 12 };
  if (mesasViewMode === 'plano' && Object.keys(mesasData).length) renderPlano();
});

// Banner offline + trigger sync on reconnect
onValue(ref(db, '.info/connected'), snap => {
  const eraConectado = isFirebaseConnected;
  isFirebaseConnected = !!snap.val();
  actualizarBannerOffline();
  const pLoad = document.getElementById('pin-loading');
  if (pLoad) pLoad.style.display = 'none';
  if (!eraConectado && isFirebaseConnected) vaciarCola();
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
  const uds = lineas.reduce((s, l) => s + qtyResumenMesa(l), 0);
  const total = lineas.reduce((s, l) => s + Number(l.precio || 0) * qtyResumenMesa(l), 0);
  if (!uds) return 'Sin consumo';
  return `<strong>${uds} uds</strong> | <strong>${fmtEu(total)}</strong>`;
}

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

// ── MESAS CON COLORES Y ZONAS ─────────────────────────────────────────────────
function renderMesas() {
  const grid = document.getElementById('mesas-grid');
  const entries = Object.entries(mesasData)
    .filter(([, m]) => !m.nombre.startsWith('#'))
    .sort(([, a], [, b]) => {
      // Si ambos son temporales, aplicar ordenación de cola inteligente
      if (a.temporal && b.temporal) {
        const horaA = a.horaRecogida || '';
        const horaB = b.horaRecogida || '';
        // Si ambos tienen hora, ordenar cronológicamente
        if (horaA && horaB) return horaA.localeCompare(horaB);
        // Si uno tiene hora y el otro no (Local), priorizar el Local (sin hora) al principio
        if (!horaA && horaB) return -1;
        if (horaA && !horaB) return 1;
        // Si ninguno tiene hora (o son de la misma hora), ordenar por orden de entrada/creación
        return (a.creadoTs || 0) - (b.creadoTs || 0);
      }
      // Mezcla (poner temporales al final si comparten zona con fijas)
      if (a.temporal && !b.temporal) return 1;
      if (!a.temporal && b.temporal) return -1;
      // Ambos fijos
      return (a.orden ?? 999) - (b.orden ?? 999) || a.nombre.localeCompare(b.nombre, 'es', { numeric: true });
    });

  if (!entries.length) {
    grid.classList.remove('zonas-layout');
    grid.innerHTML = '<div class="loading">Sin mesas.</div>';
    return;
  }

  const hayZonas = entries.some(([, m]) => m.zona && m.zona.trim());

  grid.innerHTML = '';
  grid.classList.toggle('zonas-layout', hayZonas);

  if (hayZonas) {
    const grupos = {};
    entries.forEach(([id, m]) => {
      const zona = normalizarEtiquetaZona(m.zona);
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
  const ocupada = m.estado === 'ocupada' || localOcupada.has(id);
  let claseAlerta = ocupada ? 'ocupada' : 'libre';
  let alertaInfo = '';

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
      if (mins >= alertasConfig.amarillo) claseAlerta = 'alerta-danger';
      else if (mins >= alertasConfig.verde) claseAlerta = 'alerta-warn';
      else claseAlerta = 'alerta-ok';
      alertaInfo = `<span class="mesa-alerta-info">${dest} ${pendienteTxt} | ${minsTxt}</span>`;
    }
  }

  const div = document.createElement('div');
  div.className = 'mesa-btn ' + claseAlerta;
  const syncBadge = queuedMesas.has(id)
    ? '<span class="mesa-sync-badge">⏳ Sin sincronizar</span>'
    : '';
  div.innerHTML = `
    <span class="mesa-nombre">${m.nombre}</span>
    <span class="mesa-estado">${ocupada ? 'ocupada' : 'libre'}</span>
    <span class="mesa-resumen">${resumenMesaActual(id)}</span>
    ${alertaInfo}
    ${syncBadge}`;
  div.addEventListener('click', () => abrirMesa(id, m.nombre, ocupada));
  return div;
}

setInterval(() => {
  if (Object.keys(mesasData).length && document.getElementById('view-mesas').style.display !== 'none') {
    mesasViewMode === 'grid' ? renderMesas() : renderPlano();
  }
}, 30000);

// ── VISTA PLANO ───────────────────────────────────────────────────────────────
window.toggleVistaPlano = modo => {
  mesasViewMode = modo;
  localStorage.setItem('mesas_view_mode', modo);
  document.getElementById('btn-vista-grid').classList.toggle('active', modo === 'grid');
  document.getElementById('btn-vista-plano').classList.toggle('active', modo === 'plano');
  document.getElementById('mesas-grid').style.display = modo === 'grid' ? '' : 'none';
  document.getElementById('plano-contenedor').style.display = modo === 'plano' ? '' : 'none';
  const btnInfo = document.getElementById('btn-plano-info');
  if (btnInfo) {
    btnInfo.style.display = modo === 'plano' ? '' : 'none';
    btnInfo.textContent = planoInfoMode === 'resumen' ? '⏳ Pendientes' : '💰 Totales';
  }
  document.body.classList.toggle('plano-active', modo === 'plano');
  modo === 'grid' ? renderMesas() : renderPlano();
};

window.togglePlanoInfoMode = () => {
  planoInfoMode = planoInfoMode === 'resumen' ? 'pendientes' : 'resumen';
  localStorage.setItem('plano_info_mode', planoInfoMode);
  const btn = document.getElementById('btn-plano-info');
  if (btn) btn.textContent = planoInfoMode === 'resumen' ? '⏳ Pendientes' : '💰 Totales';
  renderPlano();
};

window.seleccionarZonaPlano = zona => {
  planoZonaActiva = zona;
  renderPlano();
};

function calcularInfoMesa(id, m) {
  const ocupada = m.estado === 'ocupada' || localOcupada.has(id);
  const empty = { clase: 'libre', alertaHTML: '', iconHTML: '', tiempoHTML: '', tiempoPendHTML: '', resumen: '', totalHTML: '' };
  if (!ocupada) return empty;

  const data = pedidosData[id];
  if (!data) return { ...empty, clase: 'ocupada' };

  // Total solo en euros (sin uds) para vista compacta
  const lineasResumen = aplanarPedidos(data).filter(l => l.estado !== 'cancelado' && l.destino !== 'descuento');
  const totalVal = lineasResumen.reduce((s, l) => s + Number(l.precio || 0) * qtyResumenMesa(l), 0);
  const totalHTML = lineasResumen.length
    ? `<span class="plano-mesa-resumen">${fmtEu(totalVal)}</span>` : '';

  // Resumen completo (uds | total) para vista ancha
  const resumen = resumenMesaActual(id);

  // Tiempo desde primera comanda
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
  const horas = Math.floor(minsOcupada / 60);
  const minResto = minsOcupada % 60;
  const tiempoHTML = minsOcupada > 0
    ? `<span class="plano-mesa-tiempo">${horas > 0 ? horas + 'h ' : ''}${minResto}m</span>` : '';

  if (!lineasPend.length)
    return { clase: 'ocupada', alertaHTML: '', iconHTML: '', tiempoHTML, tiempoPendHTML: '', resumen, totalHTML };

  const masAntigua = lineasPend.reduce((min, l) => l._tsMesa < min._tsMesa ? l : min, lineasPend[0]);
  const minsPend = Math.max(0, Math.floor((Date.now() - (masAntigua._tsMesa || Date.now())) / 60000));
  const minsPendTxt = minsPend === 0 ? '<1m' : `${minsPend}m`;

  // Icono(s) de destino únicos entre todos los pendientes
  const destinos = [...new Set(lineasPend.map(l => l.destino))];
  const iconoDestino = destinos.includes('ambos')
    ? '&#127866;&#127869;'
    : destinos.map(d => d === 'cocina' ? '&#127869;' : '&#127866;').join('');

  const pendTxt = lineasPend.length === 1 ? '1 pend' : `${lineasPend.length} pend`;
  const alertaHTML = `<span class="plano-mesa-alerta">${iconoDestino} ${pendTxt} · ${minsPendTxt}</span>`;
  const iconHTML = `<span class="plano-mesa-alerta" style="font-size:13px;line-height:1">${iconoDestino}</span>`;
  const tiempoPendHTML = `<span class="plano-mesa-tiempo">${minsPendTxt}</span>`;

  let clase = 'alerta-ok';
  if (minsPend >= alertasConfig.amarillo) clase = 'alerta-danger';
  else if (minsPend >= alertasConfig.verde) clase = 'alerta-warn';

  return { clase, alertaHTML, iconHTML, tiempoHTML, tiempoPendHTML, resumen, totalHTML };
}

function renderPlano() {
  const contenedor = document.getElementById('plano-contenedor');
  if (!contenedor) return;

  const entries = Object.entries(mesasData)
    .filter(([id]) => !id.startsWith('temp_'))
    .sort(([, a], [, b]) => (a.orden ?? 999) - (b.orden ?? 999) || a.nombre.localeCompare(b.nombre, 'es', { numeric: true }));

  if (!entries.length) {
    contenedor.innerHTML = '<div class="loading">Sin mesas.</div>';
    return;
  }

  const hayZonas = entries.some(([, m]) => m.zona && m.zona.trim());
  const zonas = hayZonas
    ? [...new Set(entries.map(([, m]) => normalizarEtiquetaZona(m.zona)))]
    : null;

  if (hayZonas && (!planoZonaActiva || !zonas.includes(planoZonaActiva))) {
    planoZonaActiva = zonas[0];
  }

  const mesasFiltradas = hayZonas
    ? entries.filter(([, m]) => normalizarEtiquetaZona(m.zona) === planoZonaActiva)
    : entries;

  const cols = planoCfg.cols;
  const rows = planoCfg.rows;
  const ubicadas = mesasFiltradas.filter(([, m]) => m.plano);
  const sinUbicar = mesasFiltradas.filter(([, m]) => !m.plano && !m.nombre.startsWith('#'));

  const tabsHTML = hayZonas ? `<div class="plano-tabs">` +
    zonas.map(z => `<button class="plano-tab${z === planoZonaActiva ? ' active' : ''}" onclick="seleccionarZonaPlano('${z.replace(/'/g, "\\'")}')">${z}</button>`).join('') +
    `</div>` : '';

  const mesasHTML = ubicadas.map(([id, m]) => {
    const p = m.plano;
    const circle = p.shape === 'circle' ? ' circle' : '';
    const isDeco = m.nombre.startsWith('#');
    const shortCard = p.h === 1 ? ' short' : '';

    if (isDeco) {
      const displayNombre = m.nombre.slice(1);
      return `<div class="plano-mesa decorador${circle}${shortCard}"
        style="grid-column:${p.x}/span ${p.w};grid-row:${p.y}/span ${p.h}">
        <span class="plano-mesa-nombre">${displayNombre}</span>
      </div>`;
    }

    const ocupada = m.estado === 'ocupada' || localOcupada.has(id);
    const { clase, alertaHTML, iconHTML, tiempoHTML, tiempoPendHTML, resumen, totalHTML } = calcularInfoMesa(id, m);
    const syncBadge = queuedMesas.has(id) ? '<span class="plano-mesa-sync">⏳</span>' : '';

    // Narrow: 3 líneas según modo (ocultas en pantallas anchas)
    const topHTML = planoInfoMode === 'resumen' ? tiempoHTML : (tiempoPendHTML || tiempoHTML);
    const mainHTML = planoInfoMode === 'resumen' ? totalHTML : iconHTML;
    // Wide: igual que grid → resumen (uds+total) + alerta (pendientes)
    const resumenHTML = resumen && resumen !== 'Sin consumo'
      ? `<span class="plano-mesa-resumen">${resumen}</span>` : '';
    const extraHTML = resumenHTML + alertaHTML;

    return `<div class="plano-mesa ${clase}${circle}${shortCard}"
      data-id="${id}" data-nombre="${m.nombre.replace(/"/g, '&quot;')}" data-ocupada="${ocupada}"
      style="grid-column:${p.x}/span ${p.w};grid-row:${p.y}/span ${p.h}">
      <span class="plano-narrow-only">${topHTML}</span>
      <span class="plano-mesa-nombre">${m.nombre}${syncBadge}</span>
      <span class="plano-narrow-only">${mainHTML}</span>
      <span class="plano-mesa-extra">${extraHTML}</span>
    </div>`;
  }).join('');

  const sinUbicarHTML = sinUbicar.length
    ? `<div class="plano-sinubicar">Sin ubicar: ${sinUbicar.map(([, m]) => m.nombre).join(', ')}</div>`
    : '';

  contenedor.innerHTML = tabsHTML +
    `<div class="plano-wrap"><div class="plano-grid" style="--plano-cols:${cols};--plano-rows:${rows}">${mesasHTML}</div></div>` +
    sinUbicarHTML;

  contenedor.onclick = e => {
    const mesa = e.target.closest('.plano-mesa[data-id]');
    if (!mesa) return;
    abrirMesa(mesa.dataset.id, mesa.dataset.nombre, mesa.dataset.ocupada === 'true');
  };
}

function abrirMesa(id, nombre, ocupada) {
  mesaId = id; mesaNombre = nombre; carrito = {};
  ticketPreciosCustom = {}; ticketPreciosMode = false;
  document.getElementById('topbar-mesa').textContent = 'Mesa ' + nombre;
  document.getElementById('topbar-mesa').style.display = '';
  actualizarCabecera();
  document.getElementById('btn-cuenta').style.display = ocupada ? '' : 'none';
  show('carta');
  if (cartaReady && catsReady) renderCarta();
  else document.getElementById('carta-body').innerHTML = '<div class="loading">Cargando carta…</div>';
  updateUI();
}

window.volverMesas = () => {
  if (Object.keys(carrito).length > 0) {
    showModal({
      title: '⚠️ ¿Salir de la mesa?',
      body: 'Tienes artículos en el pedido actual que aún no has enviado. Si sales de la mesa, estos artículos se perderán.',
      buttons: [
        {
          label: 'Salir y borrar pedido',
          style: 'danger',
          action: () => {
            confirmarSalidaMesa();
          }
        },
        {
          label: 'Permanecer en la mesa',
          style: 'primary'
        }
      ]
    });
  } else {
    confirmarSalidaMesa();
  }
};

function confirmarSalidaMesa() {
  mesaId = null; mesaNombre = null; carrito = {};
  ticketEditMode = false; ticketSimplificado = false;
  document.getElementById('topbar-mesa').style.display = 'none';
  actualizarCabecera();
  cerrarDrawer(); show('mesas');
  if (Object.keys(mesasData).length) renderMesas();
}

// ── CARTA ─────────────────────────────────────────────────────────────────────
function renderCarta() {
  const body = document.getElementById('carta-body');
  const cats = Object.entries(categoriasData).sort(([, a], [, b]) => (a.orden ?? 999) - (b.orden ?? 999) || a.nombre.localeCompare(b.nombre, 'es'));
  if (!cats.length) { body.innerHTML = '<div class="loading">Sin categorías.</div>'; return; }
  body.innerHTML = '';

  cats.forEach(([catId, cat]) => {
    const arts = Object.entries(cartaData)
      .filter(([, a]) => a.catId === catId)
      .sort(([, a], [, b]) => (a.orden ?? 999) - (b.orden ?? 999) || a.nombre.localeCompare(b.nombre, 'es'));
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
      const catVars = categoriasData[art.catId]?.variantes || [];
      const artVars = art.variantes || [];
      const totalVarsCount = artVars.length + catVars.length;
      const variantesLabel = totalVarsCount
        ? `<span style="font-size:10px;color:var(--muted);font-family:var(--mono);margin-left:4px">${totalVarsCount} var.</span>`
        : '';

      mainRow.innerHTML = `
        <div style="flex:1;min-width:0">
          <div class="art-nombre">${art.nombre}${variantesLabel}</div>
          ${agotado ? '<div style="font-size:10px;color:var(--danger);font-family:var(--mono)">Agotado</div>' : ''}
        </div>
        <span class="art-precio">${Number(art.precio).toFixed(2)} €</span>
        ${alergenosBtn}
        <div class="qty-ctrl">
          <button class="qty-btn" data-id="${artId}" data-d="-1" ${agotado ? 'disabled' : ''}>−</button>
          <span class="qty-num" id="qty-${artId}">0</span>
          <button class="qty-btn" data-id="${artId}" data-d="1" ${agotado ? 'disabled' : ''}>+</button>
        </div>
        <button class="btn-nota" id="btnnota-${artId}" title="Añadir nota"
          onclick="abrirNotaModal('${artId}','${art.nombre.replace(/'/g, "\\'")}')" ${agotado ? 'disabled' : ''}>📝</button>`;
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

  // Rellenar chips de categorías en móvil
  const catChipsContainer = document.getElementById('category-chips-scroll');
  if (catChipsContainer) {
    const activeCatId = window.filtroCategoriaActivo || "";
    let chipsHtml = `
      <button type="button" class="category-chip ${!activeCatId ? 'active' : ''}" onclick="window.cambiarChipCategoria('')">Todas</button>
    `;
    cats.forEach(([catId, cat]) => {
      const arts = Object.entries(cartaData).filter(([, a]) => a.catId === catId);
      if (!arts.length) return;
      chipsHtml += `
        <button type="button" class="category-chip ${activeCatId === catId ? 'active' : ''}" onclick="window.cambiarChipCategoria('${catId}')">${cat.nombre}</button>
      `;
    });
    catChipsContainer.innerHTML = chipsHtml;
  }



  // Tablet/Mobile: panel lateral de categorías
  const tabletCats = document.getElementById('tablet-cats');
  if (tabletCats && window.innerWidth >= 768) {
    tabletCats.innerHTML = '';
    
    // Category list
    const listDiv = document.createElement('div');
    listDiv.className = 'tablet-cats-list';
    
    const activeCatId = window.filtroCategoriaActivo || "";
    
    // 1. Opción "Todas"
    const allItem = document.createElement('div');
    allItem.className = 'tablet-cat-item' + (!activeCatId ? ' activa' : '');
    const totalCount = Object.entries(carrito).reduce((s, [, v]) => s + v.qty, 0);
    allItem.innerHTML = `<span>Todas</span>${totalCount > 0 ? `<span class="tablet-cat-count">${totalCount}</span>` : ''}`;
    allItem.addEventListener('click', () => {
      window.filtroCategoriaActivo = '';
      document.querySelectorAll('.tablet-cat-item').forEach(i => i.classList.remove('activa'));
      allItem.classList.add('activa');
      document.querySelectorAll('.cat-section').forEach(s => {
        s.classList.add('tablet-visible');
      });
      document.getElementById('carta-body').scrollTop = 0;
      filtrarCartaPorTodo();
    });
    listDiv.appendChild(allItem);

    // 2. Cada categoría
    cats.forEach(([catId, cat]) => {
      const arts = Object.entries(cartaData).filter(([, a]) => a.catId === catId);
      if (!arts.length) return;
      
      const isActiva = activeCatId === catId;
      const item = document.createElement('div');
      item.className = 'tablet-cat-item' + (isActiva ? ' activa' : '');
      item.dataset.catId = catId;
      const count = Object.entries(carrito)
        .filter(([k]) => k === catId || cartaData[k.split('__')[0]]?.catId === catId)
        .reduce((s, [, v]) => s + v.qty, 0);
      item.innerHTML = `<span>${cat.nombre}</span>${count > 0 ? `<span class="tablet-cat-count">${count}</span>` : ''}`;
      
      item.addEventListener('click', () => {
        window.filtroCategoriaActivo = catId;
        document.querySelectorAll('.tablet-cat-item').forEach(i => i.classList.remove('activa'));
        item.classList.add('activa');
        document.querySelectorAll('.cat-section').forEach(s => s.classList.remove('tablet-visible'));
        const sec = document.getElementById('cat-' + catId);
        if (sec) sec.classList.add('tablet-visible');
        document.getElementById('carta-body').scrollTop = 0;
        filtrarCartaPorTodo();
      });
      listDiv.appendChild(item);
    });
    
    tabletCats.appendChild(listDiv);

    // Asegurarse de que las secciones visibles correspondan al filtro actual
    setTimeout(() => {
      document.querySelectorAll('.cat-section').forEach(s => {
        if (!activeCatId) {
          s.classList.add('tablet-visible');
        } else {
          s.classList.toggle('tablet-visible', s.id === 'cat-' + activeCatId);
        }
      });
    }, 0);
  }

  // Rellenar panel de categorías (popup móvil)
  const panel = document.getElementById('cats-panel');
  if (panel) {
    panel.innerHTML = '';
    
    const activeCatId = window.filtroCategoriaActivo || "";
    
    // 1. Opción "Todas"
    const allItem = document.createElement('div');
    allItem.className = 'cats-panel-item' + (!activeCatId ? ' activa' : '');
    const totalCount = Object.values(carrito).reduce((s, { qty }) => s + qty, 0);
    allItem.innerHTML = `<span>Todas</span>${totalCount > 0 ? `<span class="tablet-cat-count">${totalCount}</span>` : ''}`;
    allItem.addEventListener('click', () => {
      window.filtroCategoriaActivo = '';
      window.cambiarChipCategoria('');
      window.cerrarCatsPanel();
    });
    panel.appendChild(allItem);

    // 2. Cada categoría
    cats.forEach(([catId, cat]) => {
      const arts = Object.entries(cartaData).filter(([, a]) => a.catId === catId);
      if (!arts.length) return;
      
      const isActiva = activeCatId === catId;
      const item = document.createElement('div');
      item.className = 'cats-panel-item' + (isActiva ? ' activa' : '');
      item.dataset.catId = catId;
      const count = Object.entries(carrito)
        .filter(([k]) => k === catId || cartaData[k.split('__')[0]]?.catId === catId)
        .reduce((s, [, v]) => s + v.qty, 0);
      item.innerHTML = `<span>${cat.nombre}</span>${count > 0 ? `<span class="tablet-cat-count">${count}</span>` : ''}`;
      
      item.addEventListener('click', () => {
        window.filtroCategoriaActivo = catId;
        window.cambiarChipCategoria(catId);
        window.cerrarCatsPanel();
      });
      panel.appendChild(item);
    });
  }

  updateQtyDisplay();
  updateUI();
}

window.cambiarChipCategoria = (catId) => {
  window.filtroCategoriaActivo = catId;
  
  // Actualizar etiqueta del botón de categorías (móvil)
  const btnLabel = document.getElementById('btn-cats-label');
  if (btnLabel) {
    if (catId) {
      const cat = categoriasData[catId];
      btnLabel.textContent = cat ? cat.nombre : 'Categorías';
    } else {
      btnLabel.textContent = 'Categorías';
    }
  }

  // Actualizar estado activo en el panel flotante
  document.querySelectorAll('.cats-panel-item').forEach(item => {
    item.classList.remove('activa');
  });
  const activePanelItem = document.querySelector(`.cats-panel-item[data-cat-id="${catId}"]`) || document.querySelector('.cats-panel-item:not([data-cat-id])');
  if (activePanelItem) activePanelItem.classList.add('activa');

  // Actualizar estado activo en el panel lateral (tablet/desktop)
  document.querySelectorAll('.tablet-cat-item').forEach(item => {
    item.classList.remove('activa');
  });
  const activeTabletItem = document.querySelector(`.tablet-cat-item[data-cat-id="${catId}"]`) || document.querySelector('.tablet-cat-item:not([data-cat-id])');
  if (activeTabletItem) {
    activeTabletItem.classList.add('activa');
  }

  // Si no hay categoría activa, mostrar todas las secciones, de lo contrario sólo la activa (para tablet)
  document.querySelectorAll('.cat-section').forEach(s => {
    if (!catId) {
      s.classList.add('tablet-visible');
    } else {
      s.classList.toggle('tablet-visible', s.id === 'cat-' + catId);
    }
  });

  filtrarCartaPorTodo();
};

window.filtrarCartaPorTexto = (text) => {
  window.filtroSearchText = text.trim().toLowerCase();
  
  // Sincronizar campos de búsqueda
  const topbarInput = document.getElementById('topbar-search-input');
  if (topbarInput && topbarInput.value !== text) {
    topbarInput.value = text;
  }
  const oldInput = document.getElementById('carta-search-input');
  if (oldInput && oldInput.value !== text) {
    oldInput.value = text;
  }

  const btnClearTopbar = document.getElementById('btn-clear-topbar-search');
  if (btnClearTopbar) {
    btnClearTopbar.style.display = window.filtroSearchText ? 'block' : 'none';
  }
  const btnClearOld = document.getElementById('btn-clear-search');
  if (btnClearOld) {
    btnClearOld.style.display = window.filtroSearchText ? 'block' : 'none';
  }

  filtrarCartaPorTodo();
};

window.limpiarBuscadorCarta = () => {
  const topbarInput = document.getElementById('topbar-search-input');
  if (topbarInput) topbarInput.value = "";
  const oldInput = document.getElementById('carta-search-input');
  if (oldInput) oldInput.value = "";
  window.filtrarCartaPorTexto("");
};

function filtrarCartaPorTodo() {
  const catId = window.filtroCategoriaActivo || "";
  const search = window.filtroSearchText || "";

  document.querySelectorAll('.cat-section').forEach(s => {
    const matchesCategory = !catId || s.id === 'cat-' + catId;
    if (!matchesCategory) {
      s.style.display = 'none';
      return;
    }

    let artsVisibles = 0;
    const items = s.querySelectorAll('.art-row');
    
    items.forEach(row => {
      const nombre = row.querySelector('.art-nombre').textContent.toLowerCase();
      const matchesSearch = !search || nombre.includes(search);
      
      if (matchesSearch) {
        row.style.display = '';
        artsVisibles++;
      } else {
        row.style.display = 'none';
      }
    });

    if (artsVisibles > 0) {
      s.style.display = '';
      if (search && s.classList.contains('collapsed')) {
        toggleCat(s);
      }
    } else {
      s.style.display = 'none';
    }
  });
}

window.toggleAlergenos = (artId) => {
  const panel = document.getElementById('alerg-' + artId);
  if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
};



function toggleCat(section) {
  const items = section.querySelector('.cat-items');
  const collapsed = section.classList.toggle('collapsed');
  items.style.maxHeight = collapsed ? '0' : '4000px';
}

// ── CARRITO ───────────────────────────────────────────────────────────────────
function cambiarQty(artId, delta) {
  const art = cartaData[artId];
  if (!art) return;

  // Artículo con combo: interceptar clics
  if (art.esCombo === true) {
    if (delta > 0) {
      abrirComboModal(artId, art);
    } else {
      const comboKeys = Object.keys(carrito).filter(k => k.startsWith(artId + '__combo__'));
      if (comboKeys.length) {
        const lastKey = comboKeys[comboKeys.length - 1];
        const prev = carrito[lastKey].qty;
        const next = Math.max(0, prev + delta);
        if (next === 0) delete carrito[lastKey];
        else carrito[lastKey] = { ...carrito[lastKey], qty: next };
        updateQtyDisplay();
        updateUI();
        if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
      }
    }
    return;
  }

  const catVariantes = categoriasData[art.catId]?.variantes || [];
  const artVariantes = art.variantes || [];
  const tieneVariantes = artVariantes.length > 0 || catVariantes.length > 0;

  // Artículo con variantes: mostrar modal al sumar
  if (delta > 0 && tieneVariantes) {
    abrirVarianteModal(artId, art);
    return;
  }

  // Artículo con variantes: restar la última variante añadida
  if (delta < 0 && tieneVariantes) {
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

function abrirComboModal(artId, art) {
  const rawGroups = art.comboGroups;
  const comboGroups = rawGroups
    ? (Array.isArray(rawGroups) ? rawGroups : Object.values(rawGroups)).map(g => {
      if (!g) return null;
      const rawItems = g.items;
      const itemsArr = rawItems ? (Array.isArray(rawItems) ? rawItems : Object.values(rawItems)) : [];
      return {
        nombre: g.nombre || '',
        items: itemsArr.filter(Boolean).map(item => ({
          artId: item.artId || '',
          suplemento: parseFloat(item.suplemento) || 0
        }))
      };
    }).filter(Boolean)
    : [];

  if (!comboGroups.length) {
    showModal({
      title: 'Aviso',
      body: 'Este combo no tiene grupos configurados.',
      buttons: [{ label: 'Aceptar' }]
    });
    return;
  }

  let selections = new Array(comboGroups.length).fill(null);
  let qty = 1;

  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const acts = document.getElementById('modal-actions');
  modalTitle.textContent = art.nombre;

  function render() {
    let html = '';
    html += '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">Configura las opciones de tu combo:</div>';
    html += '<div style="display:flex;flex-direction:column;gap:14px;max-height:55vh;overflow-y:auto;padding-right:4px">';

    comboGroups.forEach((g, gIdx) => {
      const gSelection = selections[gIdx];
      html += '<div>';
      html += `<div style="font-weight:bold;font-size:12px;color:var(--accent);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em">${g.nombre}</div>`;
      html += '<div style="display:flex;flex-direction:column;gap:6px">';

      (g.items || []).forEach(item => {
        const subArt = cartaData[item.artId];
        if (!subArt) return;

        const isSelected = gSelection?.artId === item.artId;
        const suplText = item.suplemento > 0 ? ` (+${Number(item.suplemento).toFixed(2)} €)` : '';

        html += `<div style="border-radius:10px;border:1px solid ${isSelected ? 'var(--accent2)' : 'var(--border)'};overflow:hidden;background:${isSelected ? 'rgba(61,122,255,.04)' : 'var(--surface3)'}">`;
        html += `<button type="button" data-gidx="${gIdx}" data-artid="${item.artId}" class="combo-opt-btn" style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;width:100%;background:none;border:none;cursor:pointer;font-size:13px;color:${isSelected ? 'var(--accent2)' : 'var(--text)'}">`;
        html += `<span>${subArt.nombre}${suplText}</span>`;
        html += `<span>${isSelected ? '✓' : ''}</span>`;
        html += `</button>`;

        if (isSelected) {
          const catVars = categoriasData[subArt.catId]?.variantes || [];
          const artVars = subArt.variantes || [];
          const todasVars = [...artVars, ...catVars];
          if (todasVars.length > 0) {
            html += `<div style="display:flex;flex-direction:column;gap:4px;border-top:1px solid rgba(61,122,255,.15);padding:6px 12px;background:var(--surface2)">`;
            html += `<div style="font-size:11px;color:var(--muted);margin-bottom:2px">Elige variante:</div>`;
            todasVars.forEach(v => {
              const isVarSelected = gSelection?.variante === v.nombre;
              html += `<button type="button" data-gidx="${gIdx}" data-varname="${v.nombre}" class="combo-var-btn" style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;width:100%;background:${isVarSelected ? 'var(--accent)' : 'none'};border:1px solid ${isVarSelected ? 'var(--accent)' : 'var(--border)'};border-radius:6px;cursor:pointer;font-size:12px;color:${isVarSelected ? '#fff' : 'var(--text)'};margin-bottom:2px">`;
              html += `<span>${v.nombre}</span>`;
              html += `<span>${isVarSelected ? '●' : ''}</span>`;
              html += `</button>`;
            });
            html += '</div>';
          }
        }
        html += '</div>';
      });

      html += '</div>';
      html += '</div>';
    });

    html += '</div>';

    // Seleccionador de cantidad
    html += '<div style="display:flex;align-items:center;gap:10px;margin-top:14px;border-top:1px solid var(--border);padding-top:12px">';
    html += '<span style="font-size:12px;color:var(--muted);flex:1">Cantidad del Combo:</span>';
    html += '<button type="button" id="cqty-minus" style="width:32px;height:32px;border-radius:8px 0 0 8px;border:1px solid var(--border);background:var(--surface3);font-size:18px;cursor:pointer">−</button>';
    html += `<span id="cqty-num" style="width:36px;height:32px;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:14px;font-weight:700;border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:#fff">${qty}</span>`;
    html += '<button type="button" id="cqty-plus" style="width:32px;height:32px;border-radius:0 8px 8px 0;border:1px solid var(--border);background:var(--surface3);font-size:18px;cursor:pointer">＋</button>';
    html += '</div>';

    modalBody.innerHTML = html;

    // Verificar si la selección está completa
    const isComplete = selections.every((sel, idx) => {
      if (!sel) return false;
      const subArt = cartaData[sel.artId];
      if (!subArt) return true;
      const catVars = categoriasData[subArt.catId]?.variantes || [];
      const artVars = subArt.variantes || [];
      const todasVars = [...artVars, ...catVars];
      if (todasVars.length > 0 && !sel.variante) {
        return false;
      }
      return true;
    });

    acts.innerHTML =
      '<button class="modal-btn" id="cbtn-cancel">Cancelar</button>' +
      `<button class="modal-btn primary" id="cbtn-add"${!isComplete ? ' disabled' : ''}>` +
      (isComplete ? `Añadir ${qty}` : 'Faltan selecciones') +
      '</button>';

    // Eventos
    document.getElementById('cbtn-cancel').onclick = () =>
      document.getElementById('modal-overlay').classList.remove('open');

    const btnAdd = document.getElementById('cbtn-add');
    if (btnAdd && isComplete) {
      btnAdd.onclick = () => {
        document.getElementById('modal-overlay').classList.remove('open');
        confirmarCombo(artId, art, selections, qty);
      };
    }

    // Delegación eventos opciones
    modalBody.querySelectorAll('.combo-opt-btn').forEach(btn => {
      btn.onclick = () => {
        const gIdx = parseInt(btn.dataset.gidx);
        const optArtId = btn.dataset.artid;
        const group = comboGroups[gIdx];
        const item = (group.items || []).find(it => it.artId === optArtId);
        const subArt = cartaData[optArtId];
        if (item && subArt) {
          selections[gIdx] = {
            artId: optArtId,
            nombre: subArt.nombre,
            destino: subArt.destino || 'barra',
            suplemento: item.suplemento || 0,
            variante: null
          };
          render();
        }
      };
    });

    // Delegación eventos variantes
    modalBody.querySelectorAll('.combo-var-btn').forEach(btn => {
      btn.onclick = () => {
        const gIdx = parseInt(btn.dataset.gidx);
        const varName = btn.dataset.varname;
        if (selections[gIdx]) {
          selections[gIdx].variante = varName;
          render();
        }
      };
    });

    // Eventos de cantidad
    const minus = document.getElementById('cqty-minus');
    const plus = document.getElementById('cqty-plus');
    if (minus) minus.onclick = () => { if (qty > 1) { qty--; render(); } };
    if (plus) plus.onclick = () => { qty++; render(); };
  }

  render();
  document.getElementById('modal-overlay').classList.add('open');
}

window.confirmarCombo = (artId, art, selections, qty) => {
  // Generar clave estable según selecciones
  const selectionsStr = selections.map(s => `${s.artId}:${s.variante || ''}`).join('|');
  const carritoKey = artId + '__combo__' + selectionsStr;

  const totalSuplementos = selections.reduce((s, item) => s + (item.suplemento || 0), 0);
  const comboPrecio = Number(art.precio) + totalSuplementos;

  const artCombo = {
    ...art,
    precio: comboPrecio
  };

  const prev = carrito[carritoKey]?.qty || 0;
  const nota = carrito[carritoKey]?.nota || '';

  carrito[carritoKey] = {
    art: artCombo,
    selections: selections.map(s => ({
      artId: s.artId,
      nombre: s.nombre,
      destino: s.destino,
      suplemento: s.suplemento,
      variante: s.variante
    })),
    basePrecio: art.precio,
    qty: prev + qty,
    nota
  };

  updateQtyDisplay();
  updateUI();
  if (document.getElementById('drawer').classList.contains('open')) renderDrawer();
};

function abrirVarianteModal(artId, art) {
  let selIdx = null;
  let qty = 1;

  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const acts = document.getElementById('modal-actions');
  modalTitle.textContent = art.nombre;

  const catVariantes = categoriasData[art.catId]?.variantes || [];
  const artVariantes = art.variantes || [];
  const todasVariantes = [...artVariantes, ...catVariantes];

  function render() {
    modalBody.innerHTML =
      '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">Elige variante y cantidad:</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px">' +
      todasVariantes.map((v, i) => {
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
    const plus = document.getElementById('vqty-plus');
    if (minus) minus.addEventListener('click', e => { e.stopPropagation(); if (qty > 1) { qty--; render(); } });
    if (plus) plus.addEventListener('click', e => { e.stopPropagation(); qty++; render(); });
  }

  render();
  document.getElementById('modal-overlay').classList.add('open');
}

window.seleccionarVariante = (artId, variantIdx, qty = 1) => {
  const art = cartaData[artId];
  if (!art) return;
  const catVariantes = categoriasData[art.catId]?.variantes || [];
  const artVariantes = art.variantes || [];
  const todasVariantes = [...artVariantes, ...catVariantes];
  if (!todasVariantes[variantIdx]) return;
  const variante = todasVariantes[variantIdx];
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
      .filter(([k]) => k === id || k.startsWith(id + '__v') || k.startsWith(id + '__combo__'))
      .reduce((s, [, item]) => s + item.qty, 0);
    el.textContent = totalQty;
    el.className = 'qty-num' + (totalQty > 0 ? ' has-qty' : '');
    const btnNota = document.getElementById('btnnota-' + id);
    if (btnNota) {
      const hasNota = Object.entries(carrito).some(([k, v]) => (k === id || k.startsWith(id + '__v') || k.startsWith(id + '__combo__')) && v.nota);
      btnNota.classList.toggle('tiene-nota', hasNota);
    }
  });

  // Contador por categoría
  Object.entries(categoriasData).forEach(([catId]) => {
    const el = document.getElementById('catcount-' + catId);
    const arts = Object.entries(cartaData).filter(([, a]) => a.catId === catId);
    const total = arts.reduce((s, [id]) => {
      return s + Object.entries(carrito)
        .filter(([k]) => k === id || k.startsWith(id + '__v') || k.startsWith(id + '__combo__'))
        .reduce((ss, [, v]) => ss + v.qty, 0);
    }, 0);

    if (el) {
      el.textContent = total > 0 ? total : '';
      el.classList.toggle('visible', total > 0);
    }

    // Actualizar contador en el panel lateral de categorías (tablet/desktop)
    const item = document.querySelector(`.tablet-cat-item[data-cat-id="${catId}"]`);
    if (item) {
      let countEl = item.querySelector('.tablet-cat-count');
      if (total > 0) {
        if (!countEl) {
          countEl = document.createElement('span');
          countEl.className = 'tablet-cat-count';
          item.appendChild(countEl);
        }
        countEl.textContent = total;
      } else if (countEl) {
        countEl.remove();
      }
    }

    // Actualizar contador en el panel flotante de categorías (móvil)
    const panelItem = document.querySelector(`.cats-panel-item[data-cat-id="${catId}"]`);
    if (panelItem) {
      let countEl = panelItem.querySelector('.tablet-cat-count');
      if (total > 0) {
        if (!countEl) {
          countEl = document.createElement('span');
          countEl.className = 'tablet-cat-count';
          panelItem.appendChild(countEl);
        }
        countEl.textContent = total;
      } else if (countEl) {
        countEl.remove();
      }
    }
  });

  // Actualizar contador total en el botón "Todas" del panel lateral (tablet/desktop)
  const allItem = document.querySelector('.tablet-cat-item:not([data-cat-id])');
  if (allItem) {
    const totalCount = Object.values(carrito).reduce((s, { qty }) => s + qty, 0);
    let countEl = allItem.querySelector('.tablet-cat-count');
    if (totalCount > 0) {
      if (!countEl) {
        countEl = document.createElement('span');
        countEl.className = 'tablet-cat-count';
        allItem.appendChild(countEl);
      }
      countEl.textContent = totalCount;
    } else if (countEl) {
      countEl.remove();
    }
  }

  // Actualizar contador total en "Todas" del panel flotante (móvil)
  const allPanelItem = document.querySelector('.cats-panel-item:not([data-cat-id])');
  if (allPanelItem) {
    const totalCount = Object.values(carrito).reduce((s, { qty }) => s + qty, 0);
    let countEl = allPanelItem.querySelector('.tablet-cat-count');
    if (totalCount > 0) {
      if (!countEl) {
        countEl = document.createElement('span');
        countEl.className = 'tablet-cat-count';
        allPanelItem.appendChild(countEl);
      }
      countEl.textContent = totalCount;
    } else if (countEl) {
      countEl.remove();
    }
  }
}

function updateUI() {
  const n = Object.keys(carrito).length;
  const totalUds = Object.values(carrito).reduce((s, { qty }) => s + qty, 0);
  const total = Object.values(carrito).reduce((s, { art, qty }) => s + Number(art.precio) * qty, 0);

  document.getElementById('res-lineas').textContent = n ? `${totalUds} ud${totalUds > 1 ? 's' : ''}` : 'Sin artículos';
  document.getElementById('res-total').textContent = total.toFixed(2).replace('.', ',') + ' €';
  document.getElementById('btn-enviar').disabled = n === 0;

  const btnC = document.getElementById('btn-carrito');
  if (n > 0) {
    const prevCount = parseInt(document.getElementById('carrito-count').textContent, 10) || 0;
    btnC.classList.add('tiene');
    document.getElementById('carrito-count').textContent = totalUds;
    document.getElementById('carrito-label').textContent = total.toFixed(2).replace('.', ',') + ' €';
    
    if (prevCount !== totalUds) {
      btnC.classList.remove('cart-pop');
      btnC.offsetHeight; // Forzar reflow
      btnC.classList.add('cart-pop');
      setTimeout(() => btnC.classList.remove('cart-pop'), 450);
    }
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
  items.forEach(([carritoKey, item]) => {
    const { art, qty, nota, selections } = item;
    const notaAbierta = drawerNotasAbiertas.has(carritoKey);
    const notaVisible = !!nota || notaAbierta;
    const wrap = document.createElement('div');
    wrap.className = 'ri-wrap';

    const selectionsHTML = selections && selections.length
      ? `<div style="font-size:11px;color:var(--muted);padding-left:10px;margin-top:2px;line-height:1.25">` +
      selections.map(s => `• ${s.nombre}${s.variante ? ` (${s.variante})` : ''}${s.suplemento > 0 ? ` (+${Number(s.suplemento).toFixed(2)} €)` : ''}`).join('<br>') +
      `</div>`
      : '';

    const main = document.createElement('div');
    main.className = 'ri-main';
    main.innerHTML = `
      <span class="ri-nombre${notaVisible ? ' abierta' : ''}${nota ? ' con-nota' : ''}" onclick="drawerToggleNota('${carritoKey}')">
        <span class="ri-nombre-text">${art.nombre}</span>
        ${selectionsHTML}
        <span class="ri-nombre-toggle">${notaVisible ? '▾' : '▸'}</span>
      </span>
      <div class="ri-qty-ctrl">
        <button class="ri-qty-btn" onclick="drawerCambiarQty('${carritoKey}',-1)">−</button>
        <span class="ri-qty-num" id="dqty-${carritoKey}">${qty}</span>
        <button class="ri-qty-btn" onclick="drawerCambiarQty('${carritoKey}',1)">+</button>
      </div>
      <span class="ri-precio" id="dprecio-${carritoKey}">${(Number(art.precio) * qty).toFixed(2)} €</span>`;
    wrap.appendChild(main);

    const notaRow = document.createElement('div');
    notaRow.className = 'ri-nota-row' + (notaVisible ? '' : ' oculta');
    
    const artId = carritoKey.split('__v')[0];
    const chipsColapsados = !drawerChipsColapsados.has(carritoKey);
    const notesList = obtenerNotasPredefinidasArticulo(artId);
    
    let chipsHTML = '';
    if (!chipsColapsados && notesList.length > 0) {
      chipsHTML = `
        <div class="drawer-nota-chips" style="display:flex;flex-wrap:wrap;gap:6px;padding:6px 0;width:100%;margin-top:4px;">
          ` + notesList.map(notaRapida => `
            <button type="button" class="drawer-nota-chip" onclick="window.agregarNotaRapidaDrawer('${carritoKey}', '${notaRapida.replace(/'/g, "\\'")}')" style="background:var(--surface3);border:none;border-radius:10px;padding:5px 10px;font-size:10px;font-weight:500;color:var(--text);white-space:nowrap;cursor:pointer;">${notaRapida}</button>
          `).join('') + `
        </div>
      `;
    }
    
    notaRow.innerHTML = `
        <span class="ri-nota-label">Nota:</span>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;gap:4px;align-items:center;width:100%;">
            <input class="ri-nota-input" id="input-nota-${carritoKey}" type="text"
              placeholder="ej: poco hecho, sin cebolla…"
              value="${(nota || '').replace(/"/g, '&quot;')}"
              oninput="drawerNota('${carritoKey}', this.value)" style="flex:1;min-width:0;" />
            <button type="button" class="btn-nota-action" onclick="window.drawerToggleChips('${carritoKey}')" style="background:var(--surface3);border:none;border-radius:8px;width:30px;height:30px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--text);flex-shrink:0;" title="Mostrar/ocultar notas rápidas">${chipsColapsados ? '➕' : '➖'}</button>
            <button type="button" class="btn-nota-action" onclick="window.drawerLimpiarNota('${carritoKey}')" style="background:var(--surface3);border:none;border-radius:8px;width:30px;height:30px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--text);flex-shrink:0;" title="Limpiar nota">🧹</button>
          </div>
          ${chipsHTML}
        </div>`;
    wrap.appendChild(notaRow);
    body.appendChild(wrap);
  });
}

window.drawerCambiarQty = (carritoKey, delta) => {
  if (carrito[carritoKey]) {
    const prev = carrito[carritoKey].qty;
    const next = Math.max(0, prev + delta);
    if (next === 0) {
      delete carrito[carritoKey];
      drawerNotasAbiertas.delete(carritoKey);
    }
    else carrito[carritoKey].qty = next;
    updateQtyDisplay();
    updateUI();
    const qtyEl = document.getElementById('dqty-' + carritoKey);
    const precioEl = document.getElementById('dprecio-' + carritoKey);
    if (carrito[carritoKey]) {
      if (qtyEl) qtyEl.textContent = carrito[carritoKey].qty;
      if (precioEl) precioEl.textContent = (Number(carrito[carritoKey].art.precio) * carrito[carritoKey].qty).toFixed(2) + ' €';
    } else {
      renderDrawer();
    }
  }
};

window.drawerToggleNota = carritoKey => {
  if (!carrito[carritoKey]) return;
  if (drawerNotasAbiertas.has(carritoKey)) drawerNotasAbiertas.delete(carritoKey);
  else drawerNotasAbiertas.add(carritoKey);
  renderDrawer();
};

window.drawerNota = (carritoKey, valor) => {
  if (carrito[carritoKey]) {
    carrito[carritoKey].nota = valor.trim();
    if (carrito[carritoKey].nota) drawerNotasAbiertas.add(carritoKey);
  }
};

window.agregarNotaRapidaDrawer = (carritoKey, notaRapida) => {
  if (!carrito[carritoKey]) return;
  let currentVal = (carrito[carritoKey].nota || '').trim();
  if (!currentVal) {
    carrito[carritoKey].nota = notaRapida;
  } else {
    const notasExistentes = currentVal.split(',').map(n => n.trim().toLowerCase());
    if (!notasExistentes.includes(notaRapida.toLowerCase())) {
      carrito[carritoKey].nota = currentVal + ', ' + notaRapida;
    }
  }
  if (carrito[carritoKey].nota) drawerNotasAbiertas.add(carritoKey);
  
  updateQtyDisplay();
  updateUI();
  renderDrawer();
};

window.drawerToggleChips = (carritoKey) => {
  if (drawerChipsColapsados.has(carritoKey)) {
    drawerChipsColapsados.delete(carritoKey);
  } else {
    drawerChipsColapsados.add(carritoKey);
  }
  renderDrawer();
};

window.drawerLimpiarNota = (carritoKey) => {
  if (carrito[carritoKey]) {
    carrito[carritoKey].nota = '';
  }
  updateQtyDisplay();
  updateUI();
  renderDrawer();
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

function renderTicketRowsHTML(lineas, maxChars, conPrecio, showNotes = true) {
  const nameChars = conPrecio ? Math.max(10, maxChars - 14) : Math.max(20, maxChars - 4);
  const headerHtml = conPrecio
    ? `<div class="print-line-top print-header">
        <span class="print-qty">Ud.</span>
        <span class="print-name">Artículo</span>
        <div class="print-prices-group"><span class="print-unit-price">Precio</span><span class="print-price">Importe</span></div>
      </div>`
    : '';
  const rowsHtml = lineas.map(l => {
    const nombreLineas = wrapTicketLine(l.nombre, nameChars);
    const primera = nombreLineas.shift() || '';
    const qty = Number(l.qty);
    const precioUd = Number(l.precio);
    const precioTotal = precioUd * qty;
    const udTxt = conPrecio ? `${precioUd.toFixed(2)}€` : '';
    const totalTxt = conPrecio ? `${precioTotal.toFixed(2)}€` : '';
    const extras = [];
    nombreLineas.forEach(n => extras.push(`<div class="ticket-subline">${n}</div>`));
    if (showNotes && l.nota) extras.push(`<div class="ticket-note">-> ${l.nota}</div>`);

    return `
      <div class="print-line">
        <div class="print-line-top">
          <span class="print-qty">${qty}</span>
          <span class="print-name">${primera}</span>
          ${conPrecio ? `<div class="print-prices-group"><span class="print-unit-price">${udTxt}</span><span class="print-price">${totalTxt}</span></div>` : ''}
        </div>
        ${extras.join('')}
      </div>`;
  }).join('');
  return headerHtml + rowsHtml;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function construirHTMLTicket({ titulo, subtitulo, lineas, configLocal, mostrarPrecio = false, mostrarTotal = false, total = 0, pie = '', mostrarLogo = false, cobro = null, autoPrint = false, modoCopia = false, verifactu = null }) {
  const paperCfg = getTicketPaperConfig(configLocal);
  const logoHtml = mostrarLogo && configLocal?.ticketLogoUrl
    ? `<div class="ticket-logo-wrap"><img class="ticket-logo" src="${escapeHtml(configLocal.ticketLogoUrl)}" alt="Logo" /></div>`
    : '';
  const cabecera = (configLocal?.nombre || configLocal?.direccion || configLocal?.telefono || configLocal?.cif)
    ? `<div class="local">${logoHtml}${configLocal?.nombre ? `<div class="local-name">${configLocal.nombre}</div>` : ''}${configLocal?.direccion ? `<div class="local-line">${configLocal.direccion}</div>` : ''}${configLocal?.telefono ? `<div class="local-line">${configLocal.telefono}</div>` : ''}${configLocal?.cif ? `<div class="local-line">${configLocal.cif}</div>` : ''}</div>`
    : logoHtml;
  const rows = renderTicketRowsHTML(lineas, paperCfg.chars, mostrarPrecio, configLocal?.ticketShowNotes !== false);
  const totalHtml = mostrarTotal
    ? `<div class="print-total"><span>Total</span><span>${fmtEu(total)}</span></div>`
    : '';
  const cobradoHtml = cobro
    ? `<div class="print-total" style="font-weight:normal;border-top:none;margin-top:4px;padding-top:4px"><span>Recibido</span><span>${fmtEu(cobro.recibido)}</span></div>` +
    `<div class="print-total" style="border-top:1px dashed #666;margin-top:4px;padding-top:4px"><span>Cambio</span><span>${fmtEu(cobro.cambio)}</span></div>`
    : '';
  const footerHtml = pie
    ? `<div class="print-footer">${pie}</div>`
    : '';

  // ── Bloque Verifactu: desglose IVA + QR ──
  let verifactuHtml = '';
  if (verifactu) {
    const tipoLabel = { F1: 'FACTURA COMPLETA', F2: 'TICKET SIMPLIFICADO', F3: 'FACTURA SUSTITUTIVA', R1: 'RECTIFICATIVA', R2: 'RECTIFICATIVA', R3: 'RECTIFICATIVA', R4: 'RECTIFICATIVA', R5: 'RECTIFICATIVA', Rx: 'RECTIFICATIVA' }[verifactu.tipo] || 'FACTURA VERIFACTU';
    const destinatarioHtml = verifactu.destinatario
      ? `<div style="font-size:10px;color:#333;border-top:1px dashed #ccc;padding-top:4px;margin-top:4px">`
      + `<div>Destinatario:</div><div>${verifactu.destinatario.nombre || ''}</div>`
      + `<div>NIF: ${verifactu.destinatario.nif || ''}</div>`
      + (verifactu.destinatario.direccion ? `<div>${verifactu.destinatario.direccion}</div>` : '')
      + `</div>`
      : '';
    const ivaHtml = (verifactu.lineasIva || []).map(l =>
      `<div style="display:flex;justify-content:space-between;font-size:9px;color:#555">`
      + `<span>Base imp. (${l.tipo_impositivo}%)</span><span>${parseFloat(l.base_imponible).toFixed(2).replace('.', ',')} €</span></div>`
      + `<div style="display:flex;justify-content:space-between;font-size:9px;color:#555">`
      + `<span>IVA ${l.tipo_impositivo}%</span><span>${parseFloat(l.cuota_repercutida).toFixed(2).replace('.', ',')} €</span></div>`
    ).join('');
    const qrHtml = verifactu.qr
      ? `<div style="text-align:center;margin:6px 0"><img src="data:image/png;base64,${verifactu.qr}" style="width:80px;height:80px;display:block;margin:0 auto" alt="QR Verifactu"/><div style="font-size:8px;color:#666;margin-top:2px">Verificación AEAT</div></div>`
      : '';
    const uuidHtml = verifactu.uuid
      ? `<div style="font-size:7px;color:#aaa;text-align:center;word-break:break-all;margin-top:2px">${verifactu.uuid}</div>`
      : '';
    const factRefHtml = verifactu.facturas_ref && verifactu.facturas_ref.length
      ? `<div style="font-size:8px;color:#555;margin-top:3px">Ref: ${verifactu.facturas_ref.map(f => `${f.serie}-${f.numero}`).join(', ')}</div>`
      : '';
    verifactuHtml = `
      <div style="border-top:1px dashed #999;margin-top:8px;padding-top:6px">
        <div style="font-weight:bold;text-align:center;font-size:10px;letter-spacing:.04em">${tipoLabel} VERIFACTU</div>
        <div style="text-align:center;font-size:9px;color:#333;margin-bottom:4px">Nº ${verifactu.serie}-${verifactu.numero} | ${verifactu.fecha}</div>
        ${destinatarioHtml}
        <div style="border-top:1px solid #eee;padding-top:4px;margin-top:4px">${ivaHtml}</div>
        ${factRefHtml}
        ${qrHtml}
        ${uuidHtml}
        <div style="text-align:center;font-size:8px;color:#888;margin-top:4px">Factura conforme al Reglamento Verifactu RD 1007/2023</div>
      </div>`;
  }

  const accionesHtml = modoCopia
    ? `<div class="share-toolbar">
         <button onclick="window.print()">Imprimir / Guardar PDF</button>
         <button onclick="window.close()">Cerrar</button>
       </div>
       <div class="share-hint">Copia visual del ticket final para guardar o compartir si la necesitas.</div>`
    : '';
  const autoPrintScript = autoPrint
    ? `<script>window.onload=()=>setTimeout(()=>window.print(),60)<\/script>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    @page{size:${paperCfg.width} auto;margin:0}
    body{font-family:monospace;font-size:${paperCfg.fontSize}px;width:${paperCfg.width};padding:${paperCfg.marginY}mm ${paperCfg.marginX}mm;color:#111;${paperCfg.uppercase ? 'text-transform:uppercase;' : ''}}
    .local{text-align:center;color:#111;border-bottom:1px dashed #999;padding-bottom:6px;margin-bottom:8px}
    .local-name{font-size:${configLocal?.ticketHeaderNameFontSize || paperCfg.fontSize + 3}px;font-weight:bold;letter-spacing:.02em;color:#000}
    .local-line{font-size:${configLocal?.ticketHeaderSubFontSize || Math.max(9, paperCfg.fontSize - 1)}px;line-height:1.35;color:#111}
    .ticket-logo-wrap{text-align:center;margin-bottom:6px}
    .ticket-logo{max-width:100%;max-height:${paperCfg.paper === '80mm' ? '70px' : '52px'};object-fit:contain}
    h2{font-size:${paperCfg.fontSize + 4}px;font-weight:bold;margin-bottom:2px;text-align:center;color:#000}
    .sub{font-size:${Math.max(9, paperCfg.fontSize - 1)}px;color:#333;margin-bottom:10px;text-align:center}
    .print-line{padding:4px 0;border-bottom:1px solid #ccc}
    .print-line:last-of-type{border-bottom:none}
    .print-line-top{display:flex;gap:6px;align-items:flex-start}
    .print-qty{font-weight:bold;white-space:nowrap;min-width:1.2em}
    .print-name{flex:1;min-width:0}
    .print-prices-group{display:flex;gap:2px;white-space:nowrap}
    .print-unit-price{text-align:right;white-space:nowrap;color:#555;min-width:4.5em}
    .print-price{text-align:right;white-space:nowrap;font-weight:bold;min-width:4.5em}
    .print-header{font-size:${Math.max(8, paperCfg.fontSize - 1)}px;color:#666;border-bottom:1px solid #999;padding-bottom:3px;margin-bottom:2px}
    .ticket-subline{padding-left:24px}
    .ticket-note{padding-left:24px;font-size:10px;color:#333;font-style:italic}
    .print-total{display:flex;justify-content:space-between;border-top:1px dashed #666;margin-top:8px;padding-top:8px;font-weight:bold;color:#000}
    .print-footer{text-align:center;font-size:11px;color:#333;margin-top:10px;padding-top:8px;border-top:1px dashed #999}
    .share-toolbar{display:flex;gap:8px;justify-content:center;margin:0 auto 12px;width:min(100%, 420px)}
    .share-toolbar button{border:1px solid #999;background:#fff;color:#111;border-radius:999px;padding:8px 14px;font:inherit;cursor:pointer}
    .share-hint{margin:0 auto 12px;width:min(100%, 420px);text-align:center;font-size:${Math.max(10, paperCfg.fontSize - 1)}px;color:#555}
    body.copia{background:#f4f4f4;padding-top:14px;padding-bottom:20px}
    body.copia .ticket-wrap{background:#fff;padding:${paperCfg.marginY}mm ${paperCfg.marginX}mm;border:1px solid #ddd;box-shadow:0 8px 28px rgba(0,0,0,.08);margin:0 auto}
    @media print{body{width:${paperCfg.width};padding:${paperCfg.marginY}mm ${paperCfg.marginX}mm}*{color:#000!important;border-color:#000!important}}
    @media print{
      .share-toolbar,.share-hint{display:none!important}
      body.copia{background:#fff;padding:0}
      body.copia .ticket-wrap{border:none;box-shadow:none;margin:0;padding:${paperCfg.marginY}mm ${paperCfg.marginX}mm}
    }
  </style></head><body>
  ${accionesHtml}
  <div class="ticket-wrap">
    ${cabecera}
    <h2>${titulo}</h2>
    <div class="sub">${subtitulo}</div>
    ${rows}
    ${totalHtml}
    ${cobradoHtml}
    ${verifactuHtml}
    ${footerHtml}
  </div>
  ${autoPrintScript}
  <script>if(${modoCopia ? 'true' : 'false'})document.body.classList.add('copia')<\/script>
  </body></html>`;
}

function abrirImpresionTicket({ titulo, subtitulo, lineas, configLocal, mostrarPrecio = false, mostrarTotal = false, total = 0, pie = '', mostrarLogo = false, cobro = null, verifactu = null }) {
  const html = construirHTMLTicket({
    titulo,
    subtitulo,
    lineas,
    configLocal,
    mostrarPrecio,
    mostrarTotal,
    total,
    pie,
    mostrarLogo,
    cobro,
    autoPrint: true,
    verifactu
  });

  iframeComanda.srcdoc = html;
}

function abrirCopiaTicketFinal({ titulo, subtitulo, lineas, configLocal, total = 0, pie = '', mostrarLogo = false, cobro = null, ventana = null, verifactu = null }) {
  const win = ventana || window.open('', '_blank');
  if (!win) {
    showModal({
      title: 'No se pudo abrir la copia',
      body: 'Tu navegador ha bloqueado la ventana emergente. Permítela si quieres guardar o compartir la copia del ticket.',
      buttons: [{ label: 'Cerrar', style: 'primary' }]
    });
    return;
  }
  const html = construirHTMLTicket({
    titulo,
    subtitulo,
    lineas,
    configLocal,
    mostrarPrecio: true,
    mostrarTotal: true,
    total,
    pie,
    mostrarLogo,
    cobro,
    modoCopia: true,
    verifactu
  });
  win.document.open();
  win.document.write(html);
  win.document.close();
}

function generarTXTComanda(nombreMesa, lineas, configLocal) {
  const ahora = new Date();
  const hora = ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const fecha = ahora.toLocaleDateString('es-ES');
  const ts = `${String(ahora.getHours()).padStart(2, '0')}${String(ahora.getMinutes()).padStart(2, '0')}${String(ahora.getSeconds()).padStart(2, '0')}`;
  const sep = '--------------------------------';
  let txt = '';
  if (configLocal?.nombre) txt += configLocal.nombre + '\n';
  if (configLocal?.direccion) txt += configLocal.direccion + '\n';
  txt += sep + '\n';
  txt += `Mesa ${nombreMesa}\n${fecha}  ${hora}\n${sep}\n`;
  lineas.forEach(l => {
    txt += `${l.qty}x ${l.nombre}\n`;
    if (l.nota) txt += `   -> ${l.nota}\n`;
  });
  txt += sep + '\n';
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
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
  } catch (e) { }
}

// ── AUDITORÍA GLOBAL ──────────────────────────────────────────────────────────
// Registra cada acción importante (añadir/eliminar artículos, imprimir ticket,
// cobrar, descuentos, cierre de mesa, facturación…) en una rama separada para
// auditoría. Se almacena bajo la fecha LOCAL del dispositivo para evitar
// desfases de zona horaria al filtrar por día desde admin.
async function logAuditoria(accion, detalle = '', extras = {}) {
  try {
    const ts = Date.now();
    const d = new Date(ts);
    const fechaKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hora = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const entrada = {
      ts, fechaKey, hora,
      camarero: camareroActual || '(sin identificar)',
      accion,
      mesaId: mesaId || extras.mesaId || null,
      mesa: mesaNombre || extras.mesa || null,
      detalle: String(detalle || '')
    };
    if (extras && typeof extras === 'object') {
      Object.entries(extras).forEach(([k, v]) => {
        if (v !== undefined && entrada[k] === undefined) entrada[k] = v;
      });
    }
    await push(ref(db, `auditoria/${fechaKey}`), entrada);
  } catch (e) { }
}

// ── ENVIAR PEDIDO ─────────────────────────────────────────────────────────────
window.enviarPedido = async () => {
  if (!mesaId || !Object.keys(carrito).length) return;

  const esTemporal = mesaId.startsWith('temp_');
  const m = mesasData[mesaId] || {};
  const tipoPedidoActual = m.tipoPedido || 'Llevar';

  if (!esTemporal || tipoPedidoActual === 'Local') {
    await realizarEnvioPedido();
    return;
  }

  // Si es temporal (Llevar / Domicilio), mostrar modal de confirmación y permitir ajustar los detalles antes de enviar
  npTipoPedido = tipoPedidoActual;

  showModal({ title: '📋 Confirmar Pedido', body: '', buttons: [] });

  const modalBody = document.getElementById('modal-body');
  modalBody.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:12px; font-family:var(--sans)">
      <div style="font-size:12px; color:var(--muted); margin-bottom:4px;">
        Confirma los detalles del pedido antes de enviar a barra y cocina:
      </div>
      <!-- Selector de Tipo -->
      <div style="display:flex; gap:6px;">
        <button id="btn-tipo-llevar" type="button" class="modal-btn ${npTipoPedido === 'Llevar' ? 'primary' : ''}" style="flex:1; padding:8px; border-radius:10px; font-size:12px; cursor:pointer;" onclick="window.setTipoPedido('Llevar')">🛍️ Llevar</button>
        <button id="btn-tipo-domicilio" type="button" class="modal-btn ${npTipoPedido === 'Domicilio' ? 'primary' : ''}" style="flex:1; padding:8px; border-radius:10px; font-size:12px; cursor:pointer;" onclick="window.setTipoPedido('Domicilio')">🛵 Domicilio</button>
        <button id="btn-tipo-local" type="button" class="modal-btn ${npTipoPedido === 'Local' ? 'primary' : ''}" style="flex:1; padding:8px; border-radius:10px; font-size:12px; cursor:pointer;" onclick="window.setTipoPedido('Local')">🍺 Local</button>
      </div>
      
      <!-- Nombre de Cliente -->
      <div>
        <label style="display:block; font-size:11px; color:var(--muted); margin-bottom:4px; font-family:var(--mono);">CLIENTE</label>
        <input id="np-cliente" type="text" placeholder="Nombre" value="${m.cliente || ''}" required style="width:100%; padding:10px; border-radius:10px; border:1px solid var(--border); font-size:14px; background:var(--surface2); color:var(--text); outline:none;">
      </div>

      <!-- Teléfono -->
      <div id="np-div-telefono" style="display: ${npTipoPedido === 'Local' ? 'none' : 'block'};">
        <label style="display:block; font-size:11px; color:var(--muted); margin-bottom:4px; font-family:var(--mono);">TELÉFONO</label>
        <input id="np-telefono" type="tel" placeholder="Teléfono (opcional)" value="${m.telefono || ''}" style="width:100%; padding:10px; border-radius:10px; border:1px solid var(--border); font-size:14px; background:var(--surface2); color:var(--text); outline:none;">
      </div>

      <!-- Hora de Recogida -->
      <div id="np-div-hora" style="display: ${npTipoPedido === 'Local' ? 'none' : 'block'};">
        <label style="display:block; font-size:11px; color:var(--muted); margin-bottom:4px; font-family:var(--mono);">HORA DE RECOGIDA</label>
        <div style="display:flex; gap:6px; margin-bottom:6px;">
          <input id="np-hora" type="time" value="${m.horaRecogida || ''}" style="flex:1; padding:8px; border-radius:10px; border:1px solid var(--border); font-size:14px; background:var(--surface2); color:var(--text); outline:none;">
          <button type="button" class="modal-btn" style="padding:0 12px; font-size:12px;" onclick="window.npSumarMinutos(5)">+5m</button>
          <button type="button" class="modal-btn" style="padding:0 12px; font-size:12px;" onclick="window.npSumarMinutos(15)">+15m</button>
          <button type="button" class="modal-btn" style="padding:0 12px; font-size:12px;" onclick="window.npSumarMinutos(30)">+30m</button>
        </div>
      </div>
    </div>
  `;

  if (!m.horaRecogida && npTipoPedido !== 'Local') {
    const now = new Date();
    const future = new Date(now.getTime() + 15 * 60000);
    const HH = String(future.getHours()).padStart(2, '0');
    const MM = String(future.getMinutes()).padStart(2, '0');
    const horaInput = document.getElementById('np-hora');
    if (horaInput) horaInput.value = `${HH}:${MM}`;
  }

  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';

  const btnCancel = document.createElement('button');
  btnCancel.className = 'modal-btn';
  btnCancel.textContent = 'Volver';
  btnCancel.onclick = () => {
    document.getElementById('modal-overlay').classList.remove('open');
  };

  const btnConfirmar = document.createElement('button');
  btnConfirmar.className = 'modal-btn primary';
  btnConfirmar.textContent = 'Confirmar y Enviar';
  btnConfirmar.onclick = async () => {
    const cliente = document.getElementById('np-cliente').value.trim();
    const telefono = document.getElementById('np-telefono').value.trim();
    const hora = document.getElementById('np-hora').value;
    if (!cliente) {
      const inp = document.getElementById('np-cliente');
      inp.style.border = '2px solid var(--danger)';
      inp.placeholder = '¡El nombre es obligatorio!';
      inp.focus();
      return;
    }
    document.getElementById('modal-overlay').classList.remove('open');

    // Guardar los detalles actualizados en la base de datos antes de enviar
    const emoji = npTipoPedido === 'Domicilio' ? '🛵' : npTipoPedido === 'Local' ? '🍺' : '🛍️';
    const displayHora = npTipoPedido !== 'Local' && hora ? ` (${hora})` : '';
    const nuevoNombre = `${emoji} ${cliente}${displayHora}`;

    const updates = {
      nombre: nuevoNombre,
      cliente: cliente,
      telefono: npTipoPedido !== 'Local' ? telefono : '',
      horaRecogida: npTipoPedido !== 'Local' ? hora : '',
      tipoPedido: npTipoPedido
    };

    if (!isFirebaseConnected) {
      await update(ref(db, 'mesas/' + mesaId), updates);
    }

    // Actualizar variables locales para que el envío contenga los nombres actualizados
    mesaNombre = nuevoNombre;
    document.getElementById('topbar-mesa').textContent = 'Mesa ' + nuevoNombre;
    actualizarCabecera();

    // Ejecutar el envío real pasándole los updates atómicos si estamos online
    await realizarEnvioPedido(isFirebaseConnected ? updates : null);
  };

  acts.appendChild(btnCancel);
  acts.appendChild(btnConfirmar);
};

async function realizarEnvioPedido(tableUpdates) {
  if (!mesaId || !Object.keys(carrito).length) return;

  const nLineas = Object.keys(carrito).length;

  if (isFirebaseConnected && quotaActual !== null && quotaActual !== -1) {
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

  const lineasImprimir = [];
  const envioTs = Date.now();
  const envioId = envioTs + '_' + mesaId;
  const lineasObj = {};

  function sanitizeFirebaseKey(key) {
    if (!key) return '';
    const clean = key
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ñ/g, 'n').replace(/Ñ/g, 'N');
    return clean.replace(/[^a-zA-Z0-9_\:\-\|]/g, '_');
  }

  const estadoInicial = 'pendiente';
  Object.entries(carrito).forEach(([carritoKey, item]) => {
    const { art, qty, nota, selections, basePrecio } = item;
    const artId = carritoKey.split('__')[0];
    const safeCarritoKey = sanitizeFirebaseKey(carritoKey);

    if (selections && selections.length) {
      // 1. Línea Cabecera del Combo (precio base, destino "none")
      lineasObj[safeCarritoKey] = {
        artId,
        nombre: art.nombre,
        precio: Number(basePrecio),
        qty,
        destino: 'none',
        estado: estadoInicial,
        nota: nota || '',
        camarero: camareroActual
      };
      lineasImprimir.push({
        nombre: art.nombre,
        precio: Number(basePrecio),
        qty,
        nota: nota || ''
      });

      // 2. Líneas de Sub-artículos del Combo (precio suplemento, destino original)
      selections.forEach((s, sIdx) => {
        const subKey = `${carritoKey}__sub__${sIdx}`;
        const safeSubKey = sanitizeFirebaseKey(subKey);
        const subNombre = `> ${s.nombre}${s.variante ? ` (${s.variante})` : ''}`;
        lineasObj[safeSubKey] = {
          artId: s.artId,
          nombre: subNombre,
          precio: Number(s.suplemento || 0),
          qty,
          destino: s.destino || 'barra',
          estado: estadoInicial,
          nota: '',
          camarero: camareroActual
        };
        lineasImprimir.push({
          nombre: subNombre,
          precio: Number(s.suplemento || 0),
          qty,
          nota: ''
        });
      });
    } else {
      // Artículo Simple o Variante normal
      lineasObj[safeCarritoKey] = {
        artId,
        nombre: art.nombre,
        precio: Number(art.precio),
        qty,
        destino: art.destino,
        estado: estadoInicial,
        nota: nota || '',
        camarero: camareroActual
      };
      lineasImprimir.push({
        nombre: art.nombre,
        precio: Number(art.precio),
        qty,
        nota: nota || ''
      });
    }
  });

  // ── RAMA OFFLINE: guardar en cola IndexedDB ──────────────────────────────
  if (!isFirebaseConnected) {
    let enviadoLocal = false;
    if (usarServidorLocal()) {
      try {
        enviadoLocal = await enviarComandaAServidorLocal(lineasObj);
      } catch (err) {
        console.warn('No se pudo enviar la comanda al servidor local', err);
      }
    }

    if (enviadoLocal) {
      if (autoTXT) generarTXTComanda(mesaNombre, lineasImprimir, configLocal);
      carrito = {};
      drawerNotasAbiertas.clear();
      cerrarDrawer();
      updateQtyDisplay();
      updateUI();
      btn1.textContent = '✓ Enviado local'; btn1.disabled = false;
      btn2.textContent = 'Enviar pedido';
      setTimeout(() => { btn1.textContent = 'Enviar'; updateUI(); }, 2500);
      document.getElementById('btn-cuenta').style.display = '';
      renderMesas();
      return;
    }

    if (idb) {
      await idbAgregar({ mesaId, mesaNombre, envioId, envioTs, camarero: camareroActual, lineasObj });
      queuedMesas.add(mesaId);
      localOcupada.add(mesaId);
      if (!queuedPedidosLocal[mesaId]) queuedPedidosLocal[mesaId] = {};
      queuedPedidosLocal[mesaId][envioId] = { ts: envioTs, camarero: camareroActual, envioId, lineas: lineasObj };
      if (!pedidosData[mesaId]) pedidosData[mesaId] = {};
      pedidosData[mesaId][envioId] = queuedPedidosLocal[mesaId][envioId];
    }
    enviarComandaAMiniApp(lineasObj);
    if (autoTXT) generarTXTComanda(mesaNombre, lineasImprimir, configLocal);
    carrito = {};
    drawerNotasAbiertas.clear();
    cerrarDrawer();
    updateQtyDisplay();
    updateUI();
    btn1.textContent = '📥 En cola'; btn1.disabled = false;
    btn2.textContent = 'Enviar pedido';
    setTimeout(() => { btn1.textContent = 'Enviar'; updateUI(); }, 2500);
    document.getElementById('btn-cuenta').style.display = '';
    actualizarBannerOffline();
    renderMesas();
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  // 1. Guardar estado y metadatos de la mesa
  const tableData = { estado: 'ocupada' };
  if (tableUpdates) {
    Object.assign(tableData, tableUpdates);
  }
  await update(ref(db, 'mesas/' + mesaId), tableData);

  // 2. Guardar el envío de la comanda
  await set(ref(db, `pedidos/${mesaId}/${envioId}`), {
    ts: envioTs, camarero: camareroActual, envioId,
    lineas: lineasObj
  });

  document.getElementById('btn-cuenta').style.display = '';

  if (String(configLocal?.localNetworkMode || 'disabled') === 'mirror') {
    try {
      await enviarComandaAServidorLocal(lineasObj);
    } catch (err) {
      console.warn('No se pudo replicar la comanda al servidor local', err);
    }
  }

  enviarComandaAMiniApp(lineasObj);

  // Log
  logAccion(mesaId, envioId, 'enviado', `${nLineas} líneas`);

  // Auditoría: detalle de los artículos añadidos
  {
    const detalleArts = Object.values(lineasObj)
      .map(l => `${l.qty}× ${l.nombre}${Number(l.precio) ? ' (' + fmtEu(l.precio) + ')' : ''}`)
      .join(', ');
    const totalAprox = Object.values(lineasObj).reduce((s, l) => s + Number(l.precio || 0) * Number(l.qty || 0), 0);
    logAuditoria('articulo_agregado', detalleArts, {
      envioId,
      lineas: nLineas,
      total: Math.round(totalAprox * 100) / 100
    });
  }

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
  const mesKey = `${ahora2.getFullYear()}-${String(ahora2.getMonth() + 1).padStart(2, '0')}`;
  const statsRef = ref(db, 'config/stats/' + mesKey + '/lineas');
  const statsSnap = await get(statsRef);
  await set(statsRef, (statsSnap.val() || 0) + nLineas);

  if (autoTXT) generarTXTComanda(mesaNombre, lineasImprimir, configLocal);

  carrito = {};
  drawerNotasAbiertas.clear();
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
  ticketPreciosMode = false;
  ticketSimplificado = true;
  ticketEditMode = false;
  const btn = document.getElementById('btn-edit-ticket');
  if (btn) btn.textContent = 'Editar cuenta';
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

// Guarda o sobreescribe la venta de la sesión activa de la mesa en historial.
// La primera vez hace push y almacena la clave en pedidos/{mesaId}/_ventaKey;
// las siguientes llamadas de la misma sesión sobreescriben esa entrada.
async function upsertHistorial(datos) {
  if (!mesaId) return;
  try {
    const ventaKeySnap = await get(ref(db, `pedidos/${mesaId}/_meta/ventaKey`));
    const ventaKey = ventaKeySnap.val();
    if (ventaKey) {
      await set(ref(db, 'historial/' + ventaKey), datos);
    } else {
      const newRef = await push(ref(db, 'historial'), datos);
      await set(ref(db, `pedidos/${mesaId}/_meta/ventaKey`), newRef.key);
    }
  } catch (_) { }
}

async function enviarTicketFinalAServicio(lineasServidas, total, cobro = null, verifactu = null) {
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
      footer: configLocal?.footer || '',
      logoUrl: configLocal?.ticketLogoUrl || '',
      ticketShowNotes: configLocal?.ticketShowNotes !== false,
      headerNameFontSize: Number(configLocal?.ticketHeaderNameFontSize || 12),
      headerSubFontSize: Number(configLocal?.ticketHeaderSubFontSize || 8)
    },
    format: {
      paper: paperCfg.paper,
      fontSize: paperCfg.fontSize,
      uppercase: paperCfg.uppercase === true,
      headerOffset: Number(configLocal?.ticketHeaderOffset ?? 0)
    },
    total: Math.round(Number(total || 0) * 100) / 100,
    lines: lineasServidas.map(l => ({
      nombre: l.nombre,
      qty: Number(l.qtyCuenta || 0),
      precio: Math.round(Number(l.precio || 0) * 100) / 100,
      nota: configLocal?.ticketShowNotes === false ? '' : limpiarNotaTicket(l.nota)
    })),
    cobro: cobro ? { recibido: Math.round(cobro.recibido * 100) / 100, cambio: Math.round(cobro.cambio * 100) / 100 } : null,
    verifactu: verifactu || null
  };

  // Guardar en historial ANTES de enviar al servicio (por si el servicio falla)
  // Los tickets Verifactu ya guardan en historial dentro de vfEmitirYPrint
  if (!verifactu && mesaId) {
    const lineasHist = payload.lines.filter(l => l.qty > 0);
    if (lineasHist.length > 0) {
      const ahora = new Date();
      await upsertHistorial({
        mesa: mesaNombre, camarero: camareroActual || '',
        ts: ahora.getTime(), fecha: ahora.toLocaleDateString('es-ES'),
        hora: ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
        total: payload.total, lineas: lineasHist
      });
    }
  }

  await push(ref(db, 'print_jobs'), payload);
}

function usarMiniAppImpresion() {
  return configLocal?.localBrowserPrintEnabled === true;
}

function usarServidorLocal() {
  const mode = String(configLocal?.localNetworkMode || 'disabled');
  return mode === 'fallback' || mode === 'mirror';
}

function urlServidorLocal() {
  return String(configLocal?.localNetworkUrl || '').trim().replace(/\/+$/, '');
}

async function postServidorLocal(path, payload) {
  const base = urlServidorLocal();
  if (!base) throw new Error('No hay servidor local configurado');
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function enviarComandaAServidorLocal(lineasObj) {
  if (!usarServidorLocal()) return false;
  const lineas = Object.values(lineasObj || {}).map(linea => ({
    nombre: linea.nombre,
    qty: Number(linea.qty || 0),
    precio: Number(linea.precio || 0),
    nota: linea.nota || '',
    destino: linea.destino || 'barra'
  }));
  if (!lineas.length) return false;
  await postServidorLocal('/api/orders/command', {
    mesaId,
    mesaNombre,
    camarero: camareroActual || '',
    lineas
  });
  return true;
}

async function enviarTicketAServidorLocal(lineasTicket, total, cobro = null) {
  await postServidorLocal('/api/orders/ticket', {
    mesaId,
    mesaNombre,
    camarero: camareroActual || '',
    total,
    cobro,
    lineas: lineasTicket
  });
}

function enviarComandaAMiniApp(lineasObj) {
  // Eliminado: no se usa browser-print-bridge.js
}

function enviarTicketAMiniApp(lineasTicket, total, cobro = null, verifactu = null) {
  // Eliminado: no se usa browser-print-bridge.js
}

async function limpiarPrintJobsCerradosDeMesa(mesaIdObjetivo) {
  if (!mesaIdObjetivo) return 0;
  const snap = await get(ref(db, 'print_jobs'));
  const printJobs = snap.val() || {};
  const updates = {};
  let borrados = 0;

  Object.entries(printJobs).forEach(([jobId, job]) => {
    if (!job || typeof job !== 'object') return;
    if (String(job.mesaId || '') !== String(mesaIdObjetivo)) return;
    const status = String(job.status || '').toLowerCase();
    if (!['printed', 'error', 'skipped'].includes(status)) return;
    updates[`print_jobs/${jobId}`] = null;
    borrados++;
  });

  if (!borrados) return 0;
  await update(ref(db), updates);
  return borrados;
}

async function imprimirTicketFinal(lineasServidas, total, cobro = null, verifactu = null) {
  const mode = String(configLocal?.ticketPrintMode || 'browser');
  const fecha = new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
  const copiaWindow = autoPDF ? window.open('', '_blank') : null;

  // Auditoría: registrar la impresión del ticket
  try {
    const nLineas = (lineasServidas || []).reduce((s, l) => s + Number(l.qtyCuenta || 0), 0);
    const detalle = (lineasServidas || [])
      .slice(0, 12)
      .map(l => `${l.qtyCuenta}× ${l.nombre}`)
      .join(', ') + ((lineasServidas || []).length > 12 ? '…' : '');
    const extras = {
      total: Math.round(Number(total || 0) * 100) / 100,
      lineas: nLineas
    };
    if (cobro) {
      extras.recibido = Number(cobro.recibido || 0);
      extras.cambio = Number(cobro.cambio || 0);
    }
    if (verifactu) {
      extras.verifactuTipo = verifactu.tipo || null;
      extras.verifactuSerie = verifactu.serie || null;
      extras.verifactuNumero = verifactu.numero || null;
    }
    logAuditoria(cobro ? 'ticket_cobrado' : 'ticket_impreso', detalle, extras);
  } catch (_) { }

  const lineasTicket = lineasServidas.map(l => ({
    nombre: l.nombre,
    qty: l.qtyCuenta,
    precio: Number(l.precio),
    nota: configLocal?.ticketShowNotes === false ? '' : limpiarNotaTicket(l.nota)
  }));

  if (mode === 'local' || mode === 'local+browser') {
    enviarTicketAMiniApp(lineasTicket, total, cobro, verifactu);
    actualizarEstadoBotonTicket(mode === 'local+browser' ? 'Enviado a mini app + local' : 'Enviado a mini app');
  }

  if (mode === 'local_server' || mode === 'local_server+browser') {
    try {
      await enviarTicketAServidorLocal(lineasTicket, total, cobro);
      actualizarEstadoBotonTicket(mode === 'local_server+browser' ? 'Enviado al servidor local + local' : 'Enviado al servidor local');
    } catch (err) {
      console.error('Error enviando ticket al servidor local', err);
      showModal({
        title: 'Error de impresión local',
        body: 'No se pudo enviar el ticket al servidor local de la red.',
        buttons: [{ label: 'Cerrar', style: 'primary' }]
      });
      if (mode === 'local_server') {
        if (copiaWindow && !copiaWindow.closed) copiaWindow.close();
        return;
      }
    }
  }

  if (mode === 'service' || mode === 'both') {
    try {
      await enviarTicketFinalAServicio(lineasServidas, total, cobro, verifactu);
      actualizarEstadoBotonTicket(mode === 'both' ? 'Enviado al servicio + local' : 'Enviado al servicio');
    } catch (err) {
      console.error('Error enviando ticket al servicio', err);
      showModal({
        title: 'Error de impresión remota',
        body: 'No se pudo enviar el ticket al servicio Python. Puedes reintentarlo o usar el modo navegador.',
        buttons: [{ label: 'Cerrar', style: 'primary' }]
      });
      if (mode === 'service') {
        if (copiaWindow && !copiaWindow.closed) copiaWindow.close();
        return;
      }
    }
  }

  if (mode === 'service') {
    if (autoPDF) {
      abrirCopiaTicketFinal({
        titulo: `Mesa ${mesaNombre}`,
        subtitulo: fecha,
        lineas: lineasTicket,
        configLocal,
        mostrarPrecio: true,
        mostrarTotal: true,
        total,
        pie: configLocal?.footer || '',
        mostrarLogo: true,
        cobro,
        ventana: copiaWindow,
        verifactu
      });
    }
    return;
  }

  if (mode === 'local') {
    if (autoPDF) {
      abrirCopiaTicketFinal({
        titulo: `Mesa ${mesaNombre}`,
        subtitulo: fecha,
        lineas: lineasTicket,
        configLocal,
        total,
        pie: configLocal?.footer || '',
        mostrarLogo: true,
        cobro,
        ventana: copiaWindow,
        verifactu
      });
    }
    return;
  }

  if (mode === 'local_server') {
    if (autoPDF) {
      abrirCopiaTicketFinal({
        titulo: `Mesa ${mesaNombre}`,
        subtitulo: fecha,
        lineas: lineasTicket,
        configLocal,
        total,
        pie: configLocal?.footer || '',
        mostrarLogo: true,
        cobro,
        ventana: copiaWindow,
        verifactu
      });
    }
    return;
  }

  abrirImpresionTicket({
    titulo: `Mesa ${mesaNombre}`,
    subtitulo: fecha,
    lineas: lineasTicket,
    configLocal,
    mostrarPrecio: true,
    mostrarTotal: true,
    total,
    pie: configLocal?.footer || '',
    mostrarLogo: true,
    cobro,
    verifactu
  });

  if (autoPDF) {
    abrirCopiaTicketFinal({
      titulo: `Mesa ${mesaNombre}`,
      subtitulo: fecha,
      lineas: lineasTicket,
      configLocal,
      total,
      pie: configLocal?.footer || '',
      mostrarLogo: true,
      cobro,
      ventana: copiaWindow,
      verifactu
    });
  }
}

function showCobrarModal(total, lineasImprimir) {
  document.getElementById('modal-title').textContent = 'Cobrar mesa';
  document.getElementById('modal-body').innerHTML = `
    <div style="font-family:var(--mono);font-size:14px">
      <div style="margin-bottom:12px">Total a cobrar: <strong>${fmtEu(total)}</strong></div>
      <label style="display:block;margin-bottom:6px;color:var(--muted);font-size:12px">Cantidad recibida (€)</label>
      <input id="cobrar-input" type="number" min="0" step="0.01"
        style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:16px;font-family:var(--mono);background:var(--surface);color:var(--text)"
        placeholder="0,00" />
      <div id="cobrar-error" style="color:#e55;font-size:12px;margin-top:6px;display:none">La cantidad recibida debe ser mayor o igual al total.</div>
    </div>`;
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  const btnCancelar = document.createElement('button');
  btnCancelar.className = 'modal-btn secondary';
  btnCancelar.textContent = 'Cancelar';
  btnCancelar.onclick = () => document.getElementById('modal-overlay').classList.remove('open');
  const btnCobrar = document.createElement('button');
  btnCobrar.className = 'modal-btn primary';
  btnCobrar.textContent = 'Imprimir con cambio';
  btnCobrar.onclick = async () => {
    const inp = document.getElementById('cobrar-input');
    const recibido = parseFloat((inp?.value || '').replace(',', '.'));
    if (isNaN(recibido) || recibido < total - 0.001) {
      const err = document.getElementById('cobrar-error');
      if (err) err.style.display = 'block';
      return;
    }
    const cambio = Math.round((recibido - total) * 100) / 100;
    document.getElementById('modal-overlay').classList.remove('open');
    await imprimirTicketFinal(lineasImprimir, total, { recibido, cambio });
  };
  acts.appendChild(btnCancelar);
  acts.appendChild(btnCobrar);
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('cobrar-input')?.focus(), 80);
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

function qtyEnCuenta(linea) {
  if (linea.qtyTicket !== undefined && linea.qtyTicket !== null) return Number(linea.qtyTicket || 0);
  return qtyMaxEnCuenta(linea);
}

function qtyMaxEnCuenta(linea) {
  if (linea.estado === 'cancelado') return 0;
  if (linea.estado === 'servido') return Number(linea.qty || 0);
  if (linea.qtyServida !== undefined && linea.qtyServida !== null) return Number(linea.qtyServida || 0);
  return Number(linea.qty || 0);
}

function limpiarNotaTicket(nota) {
  return (nota || '')
    .replace(/Comprobar/g, '').replace(/Verificado/g, '')
    .replace(/⚠️/g, '').replace(/✅/g, '')
    .replace(/Â·/g, '').replace(/\s+/g, ' ').trim();
}

function renderTicket(pedidos) {
  const vfRef = pedidos['_vf'] || null;
  const todasLineas = aplanarPedidos(pedidos);

  const esTemporal = mesaId && mesaId.startsWith('temp_');
  const btnEditarMesa = esTemporal
    ? ' <button class="btn btn-sm no-print" onclick="window.abrirEditarPedidoModal()" style="padding:2px 8px; font-size:11px; margin-left:8px; background:none; border:1px solid var(--border); border-radius:6px; cursor:pointer; color:var(--muted)">✏️ Editar</button>'
    : '';

  // Limpiar automáticamente nodos corruptos creados por versiones anteriores en caché
  todasLineas.forEach(l => {
    const isCorrupto = !l.qty && l.qtyTicket !== undefined;
    const key = l.dbKey || l.artId;
    if (key === 'undefined' || key === 'null' || isCorrupto) {
      remove(ref(db, `pedidos/${mesaId}/${l.envioId}/lineas/${key}`));
    }
  });

  const lineasServidas = todasLineas
    .map(l => {
      const qtyCuenta = qtyEnCuenta(l);
      const qtyMax = qtyMaxEnCuenta(l);
      return { ...l, qtyOriginal: l.qty, qtyCuenta, qtyMax };
    })
    .filter(l => l.qtyCuenta > 0)
    .sort((a, b) => (a.envioId || '').localeCompare(b.envioId || '') || (a.nombre || '').localeCompare(b.nombre || '', 'es'));

  window._tLineas = lineasServidas;

  // Cargar precioTicket guardados en Firebase al cache local (sin sobreescribir ediciones en curso)
  lineasServidas.forEach(l => {
    if (l.precioTicket !== undefined && l.precioTicket !== null) {
      const clave = l.artId + '||' + l.nombre;
      if (ticketPreciosCustom[clave] === undefined) {
        ticketPreciosCustom[clave] = Number(l.precioTicket);
      }
    }
  });

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

  const total = lineasServidas.reduce((s, l) => {
    const clave = l.artId + '||' + l.nombre;
    const pUd = ticketPreciosCustom[clave] !== undefined ? ticketPreciosCustom[clave] : Number(l.precio);
    return s + pUd * l.qtyCuenta;
  }, 0);
  const totalUds = lineasServidas.filter(l => l.destino !== 'descuento').reduce((s, l) => s + l.qtyCuenta, 0);
  const fecha = new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
  const loc = configLocal;

  const cab =
    (loc.nombre ? '<div style="font-size:18px;font-weight:500;font-family:var(--mono)">' + loc.nombre + '</div>' : '') +
    (loc.direccion ? '<div style="font-size:12px;color:var(--muted);margin-top:2px">' + loc.direccion + '</div>' : '') +
    (loc.telefono ? '<div style="font-size:12px;color:var(--muted)">' + loc.telefono + '</div>' : '') +
    (loc.cif ? '<div style="font-size:11px;color:var(--muted)">' + loc.cif + '</div>' : '');
  const pie = loc.footer
    ? '<div style="text-align:center;font-size:12px;color:var(--muted);margin-top:1rem;padding-top:.75rem;border-top:1px dashed var(--border)">' + loc.footer + '</div>'
    : '';

  let lineasHTML;
  if (ticketSimplificado) {
    // Vista simplificada: agrupa por artId+nombre, suma cantidades
    const grupos = {};
    lineasServidas.forEach(l => {
      const clave = l.artId + '||' + l.nombre;
      if (!grupos[clave]) grupos[clave] = { ...l, qtyCuenta: 0 };
      grupos[clave].qtyCuenta += l.qtyCuenta;
    });
    lineasHTML = Object.values(grupos).map(l => {
      const esDescuento = l.destino === 'descuento';
      const clave = l.artId + '||' + l.nombre;
      const pUd = ticketPreciosCustom[clave] !== undefined ? ticketPreciosCustom[clave] : Number(l.precio);
      const pTotal = pUd * l.qtyCuenta;
      const precioCustom = ticketPreciosCustom[clave] !== undefined;
      const preciosCol = esDescuento
        ? '<div class="ticket-linea-precio-wrap">' +
        '<span style="min-width:52px"></span>' +
        '<span class="ticket-linea-precio" style="color:var(--success);min-width:52px;text-align:right">' + fmtEu(pTotal) + '</span>' +
        '</div>'
        : ticketPreciosMode
          ? '<div class="no-print ticket-linea-precio-wrap price-input-active">' +
          '<input type="number" min="0" step="0.01" class="input-precio-custom" data-clave="' + clave + '" value="' + pUd.toFixed(2) + '"' +
          ' style="width:60px;min-width:60px;padding:3px 5px;border:1px solid var(--accent2);border-radius:6px;font-size:13px;font-family:var(--mono);background:var(--surface);color:var(--text);text-align:right">' +
          '<span class="ticket-linea-precio" style="min-width:52px;text-align:right">' + fmtEu(pTotal) + '</span>' +
          '</div>'
          : '<div class="ticket-linea-precio-wrap">' +
          '<span style="min-width:52px;text-align:right;font-size:12px;color:' + (precioCustom ? 'var(--accent2)' : 'var(--muted)') + '">' + fmtEu(pUd) + '</span>' +
          '<span class="ticket-linea-precio" style="min-width:52px;text-align:right">' + fmtEu(pTotal) + '</span>' +
          '</div>';
      return '<div class="ticket-linea ticket-linea-edit' + (esDescuento ? ' ticket-descuento' : '') + '">' +
        (esDescuento ? '<span style="min-width:24px"></span>' : '<span style="min-width:24px;font-weight:bold">' + l.qtyCuenta + '</span>') +
        '<div style="flex:1;min-width:120px">' +
        '<div>' + l.nombre + '</div>' +
        '</div>' +
        '<div class="ticket-linea-right">' +
        preciosCol +
        '</div>' +
        '</div>';
    }).join('');
  } else {
    lineasHTML = lineasServidas.map((l, i) => {
      const notaVisible = limpiarNotaTicket(l.nota);
      const esDescuento = l.destino === 'descuento';
      const clave = l.artId + '||' + l.nombre;
      const pUd = ticketPreciosCustom[clave] !== undefined ? ticketPreciosCustom[clave] : Number(l.precio);
      const pTotal = pUd * l.qtyCuenta;
      const controlesEdicion = (!esDescuento && ticketEditMode)
        ? '<div class="ticket-qty-edit no-print">' +
        '<button class="ticket-qty-btn" data-accion="restar" data-idx="' + i + '"' + (l.qtyCuenta <= 1 ? ' disabled' : '') + '>-</button>' +
        '<span class="ticket-qty-num">' + l.qtyCuenta + '</span>' +
        '<button class="ticket-qty-btn" data-accion="sumar" data-idx="' + i + '">+</button>' +
        '</div>'
        : '';
      const horaLinea = l.envioTs
        ? new Date(l.envioTs).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
        : null;
      const metaLinea = [horaLinea, l.envioCamarero].filter(Boolean).join(' · ');
      const preciosCol = esDescuento
        ? '<div class="ticket-linea-precio-wrap">' +
        '<span style="min-width:52px"></span>' +
        '<span class="ticket-linea-precio" style="color:var(--success);min-width:52px;text-align:right">' + fmtEu(pTotal) + '</span>' +
        '</div>'
        : '<div class="ticket-linea-precio-wrap">' +
        (l.qtyCuenta > 1 ? '<span style="min-width:52px;text-align:right;font-size:12px;color:var(--muted)">' + fmtEu(pUd) + '</span>' : '<span style="min-width:52px"></span>') +
        '<span class="ticket-linea-precio" style="min-width:52px;text-align:right">' + fmtEu(pTotal) + '</span>' +
        '</div>';
      return '<div class="ticket-linea ticket-linea-edit' + (esDescuento ? ' ticket-descuento' : '') + '">' +
        (esDescuento ? '<span style="min-width:24px"></span>' : '<span style="min-width:24px;font-weight:bold">' + l.qtyCuenta + '</span>') +
        '<div style="flex:1;min-width:120px">' +
        '<div>' + l.nombre + '</div>' +
        (metaLinea ? '<div class="ticket-linea-meta no-print">' + metaLinea + '</div>' : '') +
        (notaVisible ? '<div class="no-print" style="font-size:11px;color:var(--muted);font-style:italic">-> ' + notaVisible + '</div>' : '') +
        (l.verificado ? '<span class="nota-verificado no-print">Verificado</span>' : '') +
        '</div>' +
        '<div class="ticket-linea-right">' +
        controlesEdicion +
        preciosCol +
        (!esDescuento && ticketEditMode ? '<button class="btn-quitar-linea" data-idx="' + i + '" title="Devolver a barra/cocina">x</button>' : '') +
        '</div>' +
        '</div>';
    }).join('');
  }

  const textoHint = ticketEditMode
    ? 'Modo edición: ajusta cantidades sin reenviar nada a barra o cocina'
    : 'Cuenta actual: ' + totalUds + ' uds | ' + fmtEu(total);

  document.getElementById('ticket-card').innerHTML =
    '<div class="ticket-header">' +
    cab +
    '<div style="margin-top:' + (loc.nombre ? '.75rem' : '0') + '">' +
    '<div class="ticket-mesa" style="display:flex; align-items:center; justify-content:center;">Mesa ' + mesaNombre + btnEditarMesa + '</div>' +
    '<div class="ticket-fecha">' + fecha + '</div>' +
    '</div>' +
    '</div>' +
    '<div class="ticket-edit-hint">' + textoHint + '</div>' +
    '<div class="ticket-linea" style="font-size:11px;color:var(--muted);border-bottom:1px solid var(--border);padding-bottom:4px;margin-bottom:2px">' +
    '<span style="min-width:24px;font-weight:600">Ud.</span>' +
    '<span style="flex:1;font-weight:600">Artículo</span>' +
    '<span style="font-size:10px;margin-right:4px;min-width:52px;text-align:right">Precio</span>' +
    '<span style="font-weight:600;min-width:52px;text-align:right">Importe</span>' +
    '</div>' +
    lineasHTML +
    '<div class="ticket-total"><span>Total</span><span>' + fmtEu(total) + '</span></div>' +
    pie +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:1rem">' +
    '<button class="btn-descuento no-print" style="flex:1;background:rgba(53,199,119,.1);color:var(--success);border:1px solid rgba(53,199,119,.3);border-radius:12px;padding:10px;font-family:var(--mono);font-size:13px;cursor:pointer">＋ Descuento</button>' +
    '<button class="btn-parcial no-print" style="flex:1;background:rgba(255,193,7,.1);color:var(--accent2);border:1px solid rgba(255,193,7,.4);border-radius:12px;padding:10px;font-family:var(--mono);font-size:13px;font-weight:bold;cursor:pointer">PARCIAL</button>' +
    '<button class="btn-transferir no-print" style="flex:1;background:none;color:var(--muted);border:1px solid var(--border);border-radius:12px;padding:10px;font-family:var(--mono);font-size:13px;cursor:pointer">Transferir</button>' +
    '</div>' +
    (ticketSimplificado ? '<button class="btn-precios no-print" style="width:100%;margin-top:6px;background:none;color:' + (ticketPreciosMode ? 'var(--accent2)' : 'var(--muted)') + ';border:1px solid ' + (ticketPreciosMode ? 'var(--accent2)' : 'var(--border)') + ';border-radius:12px;padding:10px;font-family:var(--mono);font-size:13px;cursor:pointer">' + (ticketPreciosMode ? 'Guardar precios' : 'Precios') + '</button>' : '') +
    '<div style="display:flex;gap:8px;margin-top:8px">' +
    '<button class="btn-print no-print-btn" style="flex:1;background:var(--accent);color:#fff;border:none;border-radius:12px;padding:11px 14px;font-family:var(--mono);font-size:13px;font-weight:bold;cursor:pointer;margin-top:0;">Imprimir ticket</button>' +
    '<button class="btn-cobrar no-print" style="flex:1;background:rgba(53,199,119,.15);color:var(--success);border:1px solid rgba(53,199,119,.5);border-radius:12px;padding:10px 14px;font-family:var(--mono);font-size:13px;font-weight:bold;cursor:pointer">Cobrar</button>' +
    '</div>' +
    (configVf?.habilitado ? renderVfButtons(vfRef) : renderStandardBillingButtons(pedidos['_standard_factura'] || null)) +
    '<button class="btn-refresh no-print">Actualizar ticket</button>' +
    '<button class="btn-cerrar">Cerrar mesa y limpiar</button>';

  const card = document.getElementById('ticket-card');
  card.onclick = async e => {
    if (e.target.classList.contains('ticket-qty-btn')) {
      const i = parseInt(e.target.dataset.idx);
      const delta = e.target.dataset.accion === 'sumar' ? 1 : -1;
      await editarCantidadTicket(i, delta);
    } else if (e.target.classList.contains('btn-quitar-linea')) {
      await quitarDelTicket(parseInt(e.target.dataset.idx));
    } else if (e.target.classList.contains('btn-print') || e.target.classList.contains('no-print-btn')) {
      const lineasImprimir = aplicarPreciosCustom(
        ticketSimplificado
          ? Object.values(lineasServidas.reduce((acc, l) => {
            const k = l.artId + '||' + l.nombre;
            if (!acc[k]) acc[k] = { ...l, qtyCuenta: 0 };
            acc[k].qtyCuenta += l.qtyCuenta;
            return acc;
          }, {}))
          : lineasServidas
      );
      await imprimirTicketFinal(lineasImprimir, total);
    } else if (e.target.classList.contains('btn-cobrar')) {
      const lineasImprimir = aplicarPreciosCustom(
        ticketSimplificado
          ? Object.values(lineasServidas.reduce((acc, l) => {
            const k = l.artId + '||' + l.nombre;
            if (!acc[k]) acc[k] = { ...l, qtyCuenta: 0 };
            acc[k].qtyCuenta += l.qtyCuenta;
            return acc;
          }, {}))
          : lineasServidas
      );
      showCobrarModal(total, lineasImprimir);
    } else if (e.target.classList.contains('btn-precios')) {
      if (ticketPreciosMode) {
        // Recoger valores de inputs al guardar
        card.querySelectorAll('.input-precio-custom').forEach(inp => {
          const v = parseFloat(inp.value);
          if (!isNaN(v) && v >= 0) ticketPreciosCustom[inp.dataset.clave] = v;
        });
        // Persistir precioTicket en Firebase para cada línea afectada
        const writes = [];
        for (const l of (window._tLineas || [])) {
          const clave = l.artId + '||' + l.nombre;
          if (ticketPreciosCustom[clave] !== undefined) {
            const nuevoP = ticketPreciosCustom[clave];
            const precioOriginal = Number(l.precio);
            // Si vuelve al precio original, borra el override (null)
            const val = Math.abs(nuevoP - precioOriginal) < 0.001 ? null : nuevoP;
            if (val === null) delete ticketPreciosCustom[clave];
            writes.push(set(ref(db, `pedidos/${mesaId}/${l.envioId}/lineas/${l.dbKey || l.artId}/precioTicket`), val));
          }
        }
        await Promise.all(writes);
      }
      ticketPreciosMode = !ticketPreciosMode;
      renderTicket(pedidos);
    } else if (e.target.classList.contains('btn-refresh')) {
      await cargarTicketActual();
    } else if (e.target.classList.contains('btn-cerrar')) {
      cerrarMesa();
    } else if (e.target.classList.contains('btn-descuento')) {
      abrirDescuentoModal(total);
    } else if (e.target.classList.contains('btn-parcial')) {
      abrirParcialModal();
    } else if (e.target.classList.contains('btn-transferir')) {
      abrirTransferirMesaModal();
    } else if (e.target.classList.contains('btn-vf-simp')) {
      const lp = aplicarPreciosCustom(agruparLineasSimplificado(lineasServidas));
      showVfSimplificadaModal(lp, total);
    } else if (e.target.classList.contains('btn-vf-comp')) {
      const lp = aplicarPreciosCustom(agruparLineasSimplificado(lineasServidas));
      showVfCompletaModal(lp, total);
    } else if (e.target.classList.contains('btn-vf-sust')) {
      const lp = aplicarPreciosCustom(agruparLineasSimplificado(lineasServidas));
      const ref_ = vfRef || {};
      showVfSustitutivaModal(lp, total, { serie: ref_.serie, numero: ref_.numero, fecha: ref_.fecha });
    } else if (e.target.classList.contains('btn-vf-cobrar')) {
      const lp = aplicarPreciosCustom(agruparLineasSimplificado(lineasServidas));
      showVfCobrarModal(lp, total);
    } else if (e.target.classList.contains('btn-vf-rect')) {
      const ref_ = vfRef || {};
      window.showVfRectificativaModal({ serie: ref_.serie, numero: ref_.numero, fecha: ref_.fecha, tipo: ref_.tipo });
    } else if (e.target.classList.contains('btn-vf-reimp')) {
      if (vfRef?.fbKey) reimprimirFacturaVfMesa(vfRef.fbKey);
    } else if (e.target.classList.contains('btn-standard-factura')) {
      const lp = aplicarPreciosCustom(agruparLineasSimplificado(lineasServidas));
      showStandardCompletaModal(lp, total);
    } else if (e.target.classList.contains('btn-standard-reimp')) {
      const standardFacturaRef = pedidos['_standard_factura'] || null;
      if (standardFacturaRef?.fbKey) reimprimirFacturaVfMesa(standardFacturaRef.fbKey);
    }
  };
}

function renderVfButtons(vfRef) {
  const btn = (cls, label, style = '') =>
    `<button class="${cls}" style="flex:1;min-width:120px;border-radius:10px;padding:8px 10px;font-family:var(--mono);font-size:12px;cursor:pointer;${style}">${label}</button>`;
  const accentBtn = (cls, label) => btn(cls, label, 'background:rgba(61,122,255,.12);color:var(--accent2);border:1px solid rgba(61,122,255,.3)');
  const greenBtn = (cls, label) => btn(cls, label, 'background:rgba(53,199,119,.12);color:var(--success);border:1px solid rgba(53,199,119,.3);font-weight:bold');
  const mutedBtn = (cls, label) => btn(cls, label, 'background:rgba(216,255,97,.08);color:var(--muted);border:1px solid var(--border)');
  const dangerBtn = (cls, label) => btn(cls, label, 'background:rgba(229,85,85,.1);color:#e55;border:1px solid rgba(229,85,85,.3)');

  const header = '<div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:7px">Facturación Verifactu</div>';
  const wrap = inner => `<div class="no-print" style="margin-top:10px;padding:10px;border:1px solid var(--border);border-radius:12px;background:var(--surface3)">${header}${inner}</div>`;
  const row = (...btns) => `<div style="display:flex;gap:6px;flex-wrap:wrap">${btns.join('')}</div>`;
  const row2 = (...btns) => `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${btns.join('')}</div>`;

  if (!vfRef) {
    return wrap(
      row(accentBtn('btn-vf-simp', 'Simplificada (F2)'), accentBtn('btn-vf-comp', 'Con NIF (F1)')) +
      row2(greenBtn('btn-vf-cobrar', 'Cobrar + Factura'))
    );
  }

  const tipo = vfRef.tipo || '';
  const badge = `<div style="font-size:11px;margin-bottom:6px;padding:4px 8px;border-radius:6px;background:rgba(53,199,119,.12);color:var(--success);display:inline-block">✓ ${tipo} emitida — ${vfRef.serie}-${vfRef.numero}</div>`;

  if (tipo === 'F2') {
    return wrap(
      badge +
      row(accentBtn('btn-vf-sust', 'Sustituir → F3'), dangerBtn('btn-vf-rect', 'Rectificar F2')) +
      row2(mutedBtn('btn-vf-reimp', 'Reimprimir'))
    );
  }

  return wrap(
    badge +
    row(dangerBtn('btn-vf-rect', 'Rectificar'), mutedBtn('btn-vf-reimp', 'Reimprimir'))
  );
}

function agruparLineasSimplificado(lineasServidas) {
  return Object.values(lineasServidas.reduce((acc, l) => {
    const k = l.artId + '||' + l.nombre;
    if (!acc[k]) acc[k] = { ...l, qtyCuenta: 0 };
    acc[k].qtyCuenta += l.qtyCuenta;
    return acc;
  }, {}));
}

function aplicarPreciosCustom(lineas) {
  if (!Object.keys(ticketPreciosCustom).length) return lineas;
  return lineas.map(l => {
    const clave = l.artId + '||' + l.nombre;
    return ticketPreciosCustom[clave] !== undefined ? { ...l, precio: ticketPreciosCustom[clave] } : l;
  });
}

window.toggleEditarCuenta = () => {
  ticketEditMode = !ticketEditMode;
  if (ticketEditMode) {
    ticketSimplificado = false;
  } else {
    ticketSimplificado = true;
  }
  ticketPreciosMode = false;
  const btn = document.getElementById('btn-edit-ticket');
  if (btn) btn.textContent = ticketEditMode ? 'Listo' : 'Editar cuenta';
  cargarTicketActual();
};

async function editarCantidadTicket(i, delta) {
  const l = window._tLineas?.[i];
  if (!l) return;
  const nuevaQty = Math.max(1, l.qtyCuenta + delta);
  const keyToUse = l.dbKey || l.artId;
  const path = 'pedidos/' + mesaId + '/' + l.envioId + '/lineas/' + keyToUse + '/qtyTicket';
  if (nuevaQty === qtyMaxEnCuenta(l)) await set(ref(db, path), null);
  else await set(ref(db, path), nuevaQty);
  logAccion(mesaId, l.envioId, 'cantidad_editada', `${keyToUse}: ${l.qtyCuenta}→${nuevaQty}`);
  logAuditoria('cantidad_editada',
    `${l.nombre || keyToUse}: ${l.qtyCuenta} → ${nuevaQty}`,
    { envioId: l.envioId, artId: keyToUse, qtyAntes: l.qtyCuenta, qtyDespues: nuevaQty, precio: Number(l.precio || 0) }
  );
  await cargarTicketActual();
}

async function quitarDelTicket(i) {
  const l = window._tLineas?.[i];
  if (!l) return;
  const { envioId } = l;
  const keyToUse = l.dbKey || l.artId;
  const notaBase = (l.nota || '')
    .replace(/\s*·?\s*⚠️\s*Comprobar/g, '').replace(/\s*·?\s*✅\s*Verificado/g, '').trim();
  const updates = {
    verificado: false,
    qtyServida: null,
    qtyTicket: 0,
    nota: (notaBase ? notaBase + ' · ' : '') + '⚠️ Comprobar',
  };
  if (l.estado === 'servido') updates['estado'] = 'pendiente';
  await update(ref(db, `pedidos/${mesaId}/${envioId}/lineas/${keyToUse}`), updates);
  logAccion(mesaId, envioId, 'item_quitado', keyToUse);
  logAuditoria('articulo_eliminado',
    `${l.nombre || keyToUse} (${l.qtyCuenta}× a ${fmtEu(l.precio || 0)})`,
    { envioId, artId: keyToUse, qty: l.qtyCuenta, precio: Number(l.precio || 0), importe: Math.round(Number(l.precio || 0) * Number(l.qtyCuenta || 0) * 100) / 100 }
  );
  await cargarTicketActual();
}

// ── DESCUENTO MANUAL ──────────────────────────────────────────────────────────
function abrirDescuentoModal(totalActual = 0) {
  document.getElementById('modal-title').textContent = '＋ Añadir descuento';
  const modalBody = document.getElementById('modal-body');
  modalBody.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px">
      <select id="desc-tipo"
        style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:14px;color:var(--text);outline:none">
        <option value="importe">Descuento por importe fijo</option>
        <option value="porcentaje">Descuento por porcentaje</option>
      </select>
      <input type="text" id="desc-nombre" placeholder="Descripción opcional"
        style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:14px;color:var(--text);outline:none" />
      <input type="number" id="desc-valor" placeholder="Importe a descontar €" min="0.01" step="0.01"
        style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:14px;color:var(--text);outline:none" />
      <div id="desc-ayuda" style="font-size:12px;color:var(--muted)">
        Total actual: ${fmtEu(totalActual)}. Se descontará el importe indicado.
      </div>
    </div>`;
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  const tipoEl = () => document.getElementById('desc-tipo');
  const valorEl = () => document.getElementById('desc-valor');
  const ayudaEl = () => document.getElementById('desc-ayuda');
  function syncDescuentoUI() {
    const tipo = tipoEl()?.value || 'importe';
    const valor = valorEl();
    const ayuda = ayudaEl();
    if (!valor || !ayuda) return;
    if (tipo === 'porcentaje') {
      valor.placeholder = 'Porcentaje %';
      valor.min = '0.01';
      valor.max = '100';
      valor.step = '0.01';
      const pct = parseFloat(valor.value);
      const importe = !isNaN(pct) && pct > 0 ? Math.round(totalActual * pct) / 100 : 0;
      ayuda.textContent = `Total actual: ${fmtEu(totalActual)}. Descuento estimado: ${importe > 0 ? fmtEu(importe) : '—'}.`;
    } else {
      valor.placeholder = 'Importe a descontar €';
      valor.min = '0.01';
      valor.removeAttribute('max');
      valor.step = '0.01';
      ayuda.textContent = `Total actual: ${fmtEu(totalActual)}. Se descontará el importe indicado.`;
    }
  }
  const btnC = document.createElement('button');
  btnC.className = 'modal-btn'; btnC.textContent = 'Cancelar';
  btnC.onclick = () => document.getElementById('modal-overlay').classList.remove('open');
  const btnOk = document.createElement('button');
  btnOk.className = 'modal-btn primary'; btnOk.textContent = 'Aplicar';
  btnOk.onclick = async () => {
    const tipo = tipoEl()?.value || 'importe';
    const nombreInput = document.getElementById('desc-nombre')?.value.trim();
    const valor = parseFloat(valorEl()?.value);
    if (isNaN(valor) || valor <= 0) return;
    let importe = valor;
    let nombre = nombreInput;
    if (tipo === 'porcentaje') {
      if (valor > 100) return;
      importe = Math.round(totalActual * valor) / 100;
      if (!(importe > 0)) return;
      if (!nombre) nombre = `Descuento ${valor.toFixed(valor % 1 === 0 ? 0 : 2).replace('.', ',')}%`;
    } else {
      if (!nombre) nombre = 'Descuento';
    }
    document.getElementById('modal-overlay').classList.remove('open');
    const ts = Date.now();
    const envioId = 'desc_' + ts;
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
    logAuditoria('descuento_aplicado',
      `${nombre}: -${fmtEu(importe)} (${tipo === 'porcentaje' ? valor + '%' : 'importe fijo'})`,
      { envioId, importe: -Math.round(importe * 100) / 100, tipo, valor, totalAntes: Math.round(totalActual * 100) / 100 }
    );
    await cargarTicketActual();
  };
  acts.appendChild(btnC); acts.appendChild(btnOk);
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('desc-tipo')?.addEventListener('change', syncDescuentoUI);
  document.getElementById('desc-valor')?.addEventListener('input', syncDescuentoUI);
  syncDescuentoUI();
  setTimeout(() => document.getElementById('desc-valor')?.focus(), 80);
}

// ── PAGO PARCIAL ─────────────────────────────────────────────────────────────
function abrirParcialModal() {
  if (!mesaId || !window._tLineas || !window._tLineas.length) return;

  const grupos = {};
  (window._tLineas || []).forEach(l => {
    const clave = l.artId + '||' + l.nombre;
    let precio = Number(l.precio);
    if (ticketPreciosCustom[clave] !== undefined) {
      precio = ticketPreciosCustom[clave];
    } else if (l.precioTicket !== undefined && l.precioTicket !== null) {
      precio = Number(l.precioTicket);
    }
    if (!grupos[clave]) {
      grupos[clave] = {
        artId: l.artId,
        nombre: l.nombre,
        precio: precio,
        qtyCuenta: 0
      };
    }
    grupos[clave].qtyCuenta += l.qtyCuenta;
  });
  const simplifiedList = Object.values(grupos);

  const selectedQuantities = {};
  simplifiedList.forEach(item => {
    selectedQuantities[item.artId + '||' + item.nombre] = 0;
  });

  let currentMode = 'selection'; // 'selection' or 'split'
  let splitParts = 2;
  let splitPartsPaid = 0;

  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const acts = document.getElementById('modal-actions');

  modalTitle.textContent = 'Pago Parcial - Mesa ' + mesaNombre;

  function render() {
    let totalParcial = 0;
    let anySelected = false;

    let html = '';

    // Si hay pagos de división en curso, muestra el banner de progreso con estilo premium
    if (splitPartsPaid > 0) {
      const totalCuenta = simplifiedList.reduce((sum, item) => sum + item.precio * item.qtyCuenta, 0);
      const partValue = totalCuenta / splitParts;
      html += `
        <div style="background:rgba(53,199,119,.12); border:1px solid var(--success); color:var(--success); border-radius:12px; padding:12px; margin-bottom:16px; font-weight:bold; font-size:13px; text-align:center; display:flex; flex-direction:column; gap:4px">
          <span>✅ Pago ${splitPartsPaid} / ${splitParts} de ${partValue.toFixed(2)} € registrado</span>
          <span style="font-size:12px; font-weight:normal; color:var(--text)">Restan ${splitParts - splitPartsPaid} pagos de ${partValue.toFixed(2)} €</span>
        </div>
      `;
    }

    // Segmented tab controls (deshabilitados si hay pagos de división en curso)
    if (splitPartsPaid > 0) {
      html += `
        <div class="parcial-tabs" style="display:flex;background:var(--surface2);border-radius:12px;padding:4px;margin-bottom:16px;border:1px solid var(--border);opacity:0.6;pointer-events:none">
          <button type="button" style="flex:1;padding:10px;border:none;border-radius:8px;background:var(--accent2);color:#fff;font-weight:bold;font-size:13px">División Equitativa (En Curso)</button>
        </div>
      `;
    } else {
      html += `
        <div class="parcial-tabs" style="display:flex;background:var(--surface2);border-radius:12px;padding:4px;margin-bottom:16px;border:1px solid var(--border)">
          <button type="button" id="p-tab-selection" style="flex:1;padding:10px;border:none;border-radius:8px;background:${currentMode === 'selection' ? 'var(--accent2)' : 'transparent'};color:${currentMode === 'selection' ? '#fff' : 'var(--muted)'};font-weight:bold;cursor:pointer;font-size:13px;transition:all 0.25s">Por Selección</button>
          <button type="button" id="p-tab-split" style="flex:1;padding:10px;border:none;border-radius:8px;background:${currentMode === 'split' ? 'var(--accent2)' : 'transparent'};color:${currentMode === 'split' ? '#fff' : 'var(--muted)'};font-weight:bold;cursor:pointer;font-size:13px;transition:all 0.25s">División Equitativa</button>
        </div>
      `;
    }

    if (currentMode === 'selection') {
      html += '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">Elige qué artículos cobrar en este pago:</div>';
      html += '<div style="display:flex;flex-direction:column;gap:10px;max-height:45vh;overflow-y:auto;padding-right:4px">';

      simplifiedList.forEach(item => {
        const clave = item.artId + '||' + item.nombre;
        const selQty = selectedQuantities[clave] || 0;
        totalParcial += item.precio * selQty;
        if (selQty > 0) anySelected = true;

        html += `
          <div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface3);border:1px solid var(--border);border-radius:10px;padding:10px 12px">
            <div style="flex:1;min-width:0;margin-right:8px">
              <div style="font-size:13px;font-weight:bold;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.nombre}</div>
              <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">${Number(item.precio).toFixed(2)} € / ud</div>
            </div>
            
            <!-- Controles de cantidad -->
            <div style="display:flex;align-items:center;gap:6px">
              <button type="button" class="pq-btn-minus" data-clave="${clave}" style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">−</button>
              <span style="font-family:var(--mono);font-size:13px;font-weight:bold;width:34px;text-align:center">${selQty} / ${item.qtyCuenta}</span>
              <button type="button" class="pq-btn-plus" data-clave="${clave}" style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">＋</button>
            </div>
          </div>
        `;
      });

      html += `</div>`;

      // Total Parcial
      html += `
        <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;color:var(--muted)">Total parcial:</span>
          <span style="font-size:16px;font-weight:bold;color:var(--accent2);font-family:var(--mono)">${totalParcial.toFixed(2)} €</span>
        </div>
      `;

    } else {
      // División Equitativa
      html += '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">Selecciona en cuántas partes dividir la cuenta:</div>';

      // Selectores de division (deshabilitados si hay pagos de división en curso)
      if (splitPartsPaid > 0) {
        html += `
          <div style="display:flex;gap:6px;margin-bottom:16px;align-items:center;flex-wrap:wrap;opacity:0.6;pointer-events:none">
            <button type="button" class="split-n-btn active" style="flex:1;min-width:40px;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--accent2);color:#fff;font-weight:bold;font-family:var(--mono)">x${splitParts}</button>
          </div>
        `;
      } else {
        html += `
          <div style="display:flex;gap:6px;margin-bottom:16px;align-items:center;flex-wrap:wrap">
            <button type="button" class="split-n-btn ${splitParts === 2 ? 'active' : ''}" data-n="2" style="flex:1;min-width:40px;padding:8px;border-radius:8px;border:1px solid var(--border);background:${splitParts === 2 ? 'var(--accent2)' : 'var(--surface3)'};color:${splitParts === 2 ? '#fff' : 'var(--text)'};font-weight:bold;cursor:pointer;font-family:var(--mono)">x2</button>
            <button type="button" class="split-n-btn ${splitParts === 3 ? 'active' : ''}" data-n="3" style="flex:1;min-width:40px;padding:8px;border-radius:8px;border:1px solid var(--border);background:${splitParts === 3 ? 'var(--accent2)' : 'var(--surface3)'};color:${splitParts === 3 ? '#fff' : 'var(--text)'};font-weight:bold;cursor:pointer;font-family:var(--mono)">x3</button>
            <button type="button" class="split-n-btn ${splitParts === 4 ? 'active' : ''}" data-n="4" style="flex:1;min-width:40px;padding:8px;border-radius:8px;border:1px solid var(--border);background:${splitParts === 4 ? 'var(--accent2)' : 'var(--surface3)'};color:${splitParts === 4 ? '#fff' : 'var(--text)'};font-weight:bold;cursor:pointer;font-family:var(--mono)">x4</button>
            <button type="button" class="split-n-btn ${splitParts === 5 ? 'active' : ''}" data-n="5" style="flex:1;min-width:40px;padding:8px;border-radius:8px;border:1px solid var(--border);background:${splitParts === 5 ? 'var(--accent2)' : 'var(--surface3)'};color:${splitParts === 5 ? '#fff' : 'var(--text)'};font-weight:bold;cursor:pointer;font-family:var(--mono)">x5</button>
            <div style="display:flex;align-items:center;background:var(--surface3);border:1px solid var(--border);border-radius:8px;padding:2px 8px;height:34px;box-sizing:border-box;flex:2;min-width:100px">
              <span style="font-size:12px;color:var(--muted);margin-right:6px">Otro:</span>
              <input type="number" id="split-custom-input" min="2" max="100" value="${[2, 3, 4, 5].includes(splitParts) ? '6' : splitParts}" style="width:40px;background:none;border:none;color:var(--text);font-family:var(--mono);font-size:14px;font-weight:bold;outline:none;text-align:center">
            </div>
          </div>
        `;
      }

      // Calculate totals
      const totalCuenta = simplifiedList.reduce((sum, item) => sum + item.precio * item.qtyCuenta, 0);
      totalParcial = totalCuenta / splitParts;
      anySelected = true; // Always valid to pay if items exist

      html += `<div style="font-size:12px;color:var(--muted);margin-bottom:10px" class="split-header">Detalle de la parte a cobrar (1/${splitParts}):</div>`;
      html += '<div style="display:flex;flex-direction:column;gap:8px;max-height:25vh;overflow-y:auto;padding-right:4px">';

      simplifiedList.forEach(item => {
        const partedQty = item.qtyCuenta / splitParts;
        html += `
          <div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface3);border:1px solid var(--border);border-radius:10px;padding:8px 12px">
            <div style="flex:1;min-width:0;margin-right:8px">
              <div style="font-size:13px;font-weight:bold;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.nombre}</div>
              <div style="font-size:11px;color:var(--muted);font-family:var(--mono)">${Number(item.precio).toFixed(2)} € / ud</div>
            </div>
            <div style="font-family:var(--mono);font-size:13px;font-weight:bold;color:var(--accent2)">
              ${Number(partedQty.toFixed(2))} / ${item.qtyCuenta}
            </div>
          </div>
        `;
      });

      html += `</div>`;

      // Display Total Cuenta and Total Parte
      html += `
        <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px;display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)">
            <span>Total original de la cuenta:</span>
            <span style="font-family:var(--mono)">${totalCuenta.toFixed(2)} €</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
            <span style="font-size:13px;font-weight:bold;color:var(--text)" class="split-label">Monto por parte (1/${splitParts}):</span>
            <span style="font-size:16px;font-weight:bold;color:var(--success);font-family:var(--mono)" class="split-total-value">${totalParcial.toFixed(2)} €</span>
          </div>
        </div>
      `;
    }

    modalBody.innerHTML = html;

    // Acciones y etiquetas dinámicas según el progreso de la división
    const cancelLabel = splitPartsPaid > 0 ? 'Cerrar' : 'Cancelar';
    const payLabel = splitPartsPaid > 0 ? `Pagar Parte ${splitPartsPaid + 1}` : 'Pagar';
    const payPrintLabel = splitPartsPaid > 0 ? `Cobrar e Imprimir Parte ${splitPartsPaid + 1}` : 'Cobrar e Imprimir';

    acts.innerHTML = `
      <button class="modal-btn" id="pbtn-cancel" style="padding:10px 12px">${cancelLabel}</button>
      <button class="modal-btn" id="pbtn-pay" ${!anySelected ? 'disabled' : ''} style="padding:10px 12px;background:rgba(53,199,119,.1);color:var(--success);border:1px solid var(--success)">${payLabel}</button>
      <button class="modal-btn primary" id="pbtn-pay-print" ${!anySelected ? 'disabled' : ''} style="padding:10px 12px">${payPrintLabel}</button>
    `;

    // Pestañas bloqueadas si ya comenzó la división
    if (splitPartsPaid === 0) {
      document.getElementById('p-tab-selection').onclick = () => {
        currentMode = 'selection';
        render();
      };
      document.getElementById('p-tab-split').onclick = () => {
        currentMode = 'split';
        render();
      };
    }

    if (currentMode === 'selection') {
      modalBody.querySelectorAll('.pq-btn-minus').forEach(btn => {
        btn.onclick = () => {
          const clv = btn.dataset.clave;
          const maxVal = simplifiedList.find(sl => (sl.artId + '||' + sl.nombre) === clv)?.qtyCuenta || 0;
          const val = selectedQuantities[clv] || 0;
          if (val > 0) {
            if (val === maxVal && val % 1 !== 0) {
              selectedQuantities[clv] = Math.floor(val);
            } else {
              selectedQuantities[clv] = Math.max(0, val - 1);
            }
            render();
          }
        };
      });

      modalBody.querySelectorAll('.pq-btn-plus').forEach(btn => {
        btn.onclick = () => {
          const clv = btn.dataset.clave;
          const maxVal = simplifiedList.find(sl => (sl.artId + '||' + sl.nombre) === clv)?.qtyCuenta || 0;
          const val = selectedQuantities[clv] || 0;
          if (val < maxVal) {
            if (val + 1 > maxVal) {
              selectedQuantities[clv] = maxVal;
            } else {
              selectedQuantities[clv] = val + 1;
            }
            render();
          }
        };
      });
    } else {
      if (splitPartsPaid === 0) {
        modalBody.querySelectorAll('.split-n-btn').forEach(btn => {
          btn.onclick = () => {
            splitParts = parseInt(btn.dataset.n);
            render();
          };
        });

        const customInput = document.getElementById('split-custom-input');
        if (customInput) {
          customInput.oninput = () => {
            const val = parseInt(customInput.value);
            if (!isNaN(val) && val >= 2) {
              splitParts = val;
              modalBody.querySelectorAll('.split-n-btn').forEach(b => {
                b.style.background = 'var(--surface3)';
                b.style.color = 'var(--text)';
              });
              const totalCuenta = simplifiedList.reduce((sum, item) => sum + item.precio * item.qtyCuenta, 0);
              const partial = totalCuenta / splitParts;
              const successSpan = modalBody.querySelector('.split-total-value');
              if (successSpan) successSpan.textContent = `${partial.toFixed(2)} €`;

              const labelSpan = modalBody.querySelector('.split-label');
              if (labelSpan) labelSpan.textContent = `Monto por parte (1/${splitParts}):`;

              const headerSpan = modalBody.querySelector('.split-header');
              if (headerSpan) headerSpan.textContent = `Detalle de la parte a cobrar (1/${splitParts}):`;
            }
          };
          customInput.onchange = () => {
            const val = parseInt(customInput.value);
            if (!isNaN(val) && val >= 2) {
              splitParts = val;
              render();
            }
          };
        }
      }
    }

    document.getElementById('pbtn-cancel').onclick = async () => {
      modalOverlay.classList.remove('open');
      await cargarTicketActual();
    };

    const processPayment = async (printTicket) => {
      const isLastPayment = currentMode === 'selection' || (splitPartsPaid + 1 >= splitParts);

      if (isLastPayment) {
        modalOverlay.classList.remove('open');
      }

      const lineasParaCobrar = [];

      // Obtener las líneas reales más recientes directamente de Firebase
      let todasLineas = [];
      try {
        const snapPedidos = await get(ref(db, `pedidos/${mesaId}`));
        const pedidosActive = snapPedidos.val() || {};
        todasLineas = aplanarPedidos(pedidosActive).map(l => {
          const qtyCuenta = qtyEnCuenta(l);
          const qtyMax = qtyMaxEnCuenta(l);
          return { ...l, qtyOriginal: l.qty, qtyCuenta, qtyMax };
        }).filter(l => l.qtyCuenta > 0);
      } catch (e) {
        todasLineas = window._tLineas || [];
      }

      const quantitiesToPay = {};
      if (currentMode === 'selection') {
        for (const [clave, qty] of Object.entries(selectedQuantities)) {
          if (qty > 0) quantitiesToPay[clave] = qty;
        }
      } else {
        simplifiedList.forEach(item => {
          const clave = item.artId + '||' + item.nombre;
          const qty = item.qtyCuenta / splitParts;
          if (qty > 0) quantitiesToPay[clave] = qty;
        });
      }

      if (Object.keys(quantitiesToPay).length === 0) return;

      for (const [clave, qtyToPay] of Object.entries(quantitiesToPay)) {
        const [artId, nombre] = clave.split('||');
        let remainingToPay = qtyToPay;

        const matchingLines = todasLineas.filter(l => l.artId === artId && l.nombre === nombre);

        for (const l of matchingLines) {
          if (remainingToPay <= 0) break;
          const currQty = qtyEnCuenta(l);
          if (currQty <= 0) continue;

          const deduct = Math.min(remainingToPay, currQty);
          remainingToPay -= deduct;

          const newQty = Math.max(0, Number(l.qty || 0) - deduct);
          const newQtyServida = l.qtyServida !== undefined && l.qtyServida !== null
            ? Math.max(0, Number(l.qtyServida) - deduct)
            : null;
          const newQtyTicket = l.qtyTicket !== undefined && l.qtyTicket !== null
            ? Math.max(0, Number(l.qtyTicket) - deduct)
            : null;

          const isZero = (l.qtyTicket !== undefined && l.qtyTicket !== null)
            ? (newQtyTicket <= 0.01)
            : (newQty <= 0.01);

          if (isZero) {
            await remove(ref(db, `pedidos/${mesaId}/${l.envioId}/lineas/${l.dbKey}`));
          } else {
            const updates = {};
            if (l.qty !== undefined) updates.qty = newQty;
            if (newQtyServida !== null) updates.qtyServida = newQtyServida;
            if (newQtyTicket !== null) updates.qtyTicket = newQtyTicket;
            await update(ref(db, `pedidos/${mesaId}/${l.envioId}/lineas/${l.dbKey}`), updates);
          }
        }

        const unit = simplifiedList.find(sl => sl.artId === artId && sl.nombre === nombre);
        lineasParaCobrar.push({
          nombre,
          qtyCuenta: Number(qtyToPay.toFixed(2)),
          precio: Number(unit?.precio || 0),
          nota: ''
        });
      }

      const totalCobro = lineasParaCobrar.reduce((sum, l) => sum + l.precio * l.qtyCuenta, 0);

      if (printTicket) {
        await imprimirTicketFinal(lineasParaCobrar, totalCobro);
      }

      // Guardar venta parcial en el historial
      try {
        const ahora = new Date();
        const datosVentaParcial = {
          mesa: mesaNombre + ' (Parcial)',
          camarero: camareroActual || '',
          ts: ahora.getTime(),
          fecha: ahora.toLocaleDateString('es-ES'),
          hora: ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
          total: Math.round(totalCobro * 100) / 100,
          lineas: lineasParaCobrar.map(l => ({
            nombre: l.nombre,
            precio: Math.round(Number(l.precio) * 100) / 100,
            qty: Number(l.qtyCuenta || 0)
          }))
        };
        await push(ref(db, 'historial'), datosVentaParcial);
      } catch (e) {
        console.error("Error al registrar venta parcial en historial:", e);
      }

      try {
        const detail = lineasParaCobrar.map(l => `${l.qtyCuenta}x ${l.nombre}`).join(', ');
        logAuditoria('pago_parcial', `Cobro parcial de ${fmtEu(totalCobro)}: ${detail}`, { total: totalCobro, mesaId });
      } catch (_) { }

      if (isLastPayment) {
        showModal({
          title: 'Pago Finalizado',
          body: `Cuenta saldada por completo. Se ha procesado el último pago de ${totalCobro.toFixed(2)} € con éxito.`,
          buttons: [{ label: 'Aceptar' }]
        });
        await cargarTicketActual();
      } else {
        splitPartsPaid++;
        render();
      }
    };

    document.getElementById('pbtn-pay').onclick = () => processPayment(false);
    document.getElementById('pbtn-pay-print').onclick = () => processPayment(true);
  }

  render();
  modalOverlay.classList.add('open');
}

// ── TRANSFERIR MESA ───────────────────────────────────────────────────────────
function abrirTransferirMesaModal() {
  const mesasLibres = Object.entries(mesasData).filter(([id, m]) => m.estado === 'libre' && id !== mesaId && !m.nombre.startsWith('#'));
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
  if (mesaId.startsWith('temp_')) {
    batchUpdates[`mesas/${mesaId}`] = null;
  } else {
    batchUpdates[`mesas/${mesaId}/estado`] = 'libre';
  }
  batchUpdates[`mesas/${mesaDestId}/estado`] = 'ocupada';

  await update(ref(db), batchUpdates);

  const mesaDestNombre = mesasData[mesaDestId]?.nombre || mesaDestId;
  const mesaOrigenNombre = mesaNombre;
  const mesaOrigenId = mesaId;
  mesaId = mesaDestId;
  mesaNombre = mesaDestNombre;
  document.getElementById('topbar-mesa').textContent = 'Mesa ' + mesaDestNombre;
  actualizarCabecera();
  logAuditoria('mesa_transferida',
    `${mesaOrigenNombre} → ${mesaDestNombre}`,
    { mesaOrigenId, mesaOrigen: mesaOrigenNombre, mesaDestId, mesaDest: mesaDestNombre }
  );
  await cargarTicketActual();
}

// ── CERRAR MESA ───────────────────────────────────────────────────────────────
window.cerrarMesa = async () => {
  showModal({
    title: 'Cerrar mesa ' + mesaNombre,
    body: 'Se borrarán todos los pedidos de esta mesa. ¿Continuar?',
    buttons: [
      { label: 'Cancelar' },
      {
        label: 'Cerrar mesa', style: 'danger', action: async () => {
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
          const total = lineas.reduce((s, l) => s + l.precio * l.qty, 0);

          if (lineas.length > 0 && !pedidos['_vf'] && !pedidos['_standard_factura']) {
            const ahora = new Date();
            await upsertHistorial({
              mesa: mesaNombre, camarero: [...camareros].join(', '),
              ts: ahora.getTime(), fecha: ahora.toLocaleDateString('es-ES'),
              hora: ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
              total: Math.round(total * 100) / 100, lineas
            });
            logAuditoria('mesa_cerrada',
              `Total ${fmtEu(total)} · ${lineas.length} artículos`,
              { total: Math.round(total * 100) / 100, articulos: lineas.length }
            );
          } else if (lineas.length > 0) {
            logAuditoria('mesa_cerrada', `Mesa cerrada (facturada previamente) total ${fmtEu(total)}`, { total: Math.round(total * 100) / 100 });
          } else {
            logAuditoria('mesa_cerrada', 'Mesa cerrada sin consumo', { total: 0 });
          }

          await remove(ref(db, 'pedidos/' + mesaId));
          if (mesaId.startsWith('temp_')) {
            await remove(ref(db, 'mesas/' + mesaId));
          } else {
            await set(ref(db, 'mesas/' + mesaId + '/estado'), 'libre');
          }
          try {
            const borrados = await limpiarPrintJobsCerradosDeMesa(mesaId);
            if (borrados > 0) {
              logAuditoria(
                'print_jobs_limpiados',
                `Limpieza tecnica al cerrar mesa (${borrados})`,
                { mesaId, mesa: mesaNombre, printJobs: borrados }
              );
            }
          } catch (_) { }
          mesaId = null; mesaNombre = null; carrito = {};
          document.getElementById('topbar-mesa').style.display = 'none';
          actualizarCabecera();
          show('mesas');
        }
      }
    ]
  });
};

// ── VERIFACTU: HELPERS Y MODALES ──────────────────────────────────────────────

function vfConfigCheck() {
  if (!configVf?.habilitado) return 'Verifactu no está habilitado. Configúralo en Admin → Verifactu.';
  if (!configVf?.apiKey) return 'Falta la API Key de Verifacti. Configúrala en Admin → Verifactu.';
  return null;
}

async function vfEmitirYPrint({ tipo, lineas, total, cobro = null, destinatario = null, facturasRef = null }) {
  const err = vfConfigCheck();
  if (err) { showModal({ title: 'Verifactu', body: err, buttons: [{ label: 'Cerrar' }] }); return; }

  const serie =
    tipo === 'F2' ? (configVf.serieSimp || 'SIMP') :
      tipo === 'F3' ? (configVf.serieSust || 'SUST') :
        (tipo.startsWith('R') || tipo === 'Rx') ? (configVf.serieRect || 'RECT') :
          (configVf.serieFact || 'FACT');

  const iva = Number(configVf.ivaDefault ?? 10);
  const numero = await siguienteNumero(serie);
  const fecha = fmtFechaVf(Date.now());
  const desc = configVf.descripcionDefault || `Mesa ${mesaNombre}`;
  const lineasVf = buildLineasVf(lineas, iva);
  const totalNum = Math.round(Number(total) * 100) / 100;

  let resultado;
  try {
    if (tipo === 'F2') {
      resultado = await emitirSimplificada({ serie, numero, lineas: lineasVf, total: totalNum, descripcion: desc, fecha }, configVf.apiKey, configVf.apiUrl);
    } else if (tipo === 'F1') {
      resultado = await emitirCompleta({ serie, numero, lineas: lineasVf, total: totalNum, descripcion: desc, fecha, nif: destinatario.nif, nombre: destinatario.nombre }, configVf.apiKey, configVf.apiUrl);
    } else if (tipo === 'F3') {
      resultado = await emitirSustitutiva({ serie, numero, lineas: lineasVf, total: totalNum, descripcion: desc, fecha, nif: destinatario.nif, nombre: destinatario.nombre, facturasOriginales: facturasRef }, configVf.apiKey, configVf.apiUrl);
    } else {
      resultado = await emitirRectificativa({ serie, numero, tipo, metodo: 'I', lineas: lineasVf, total: totalNum, descripcion: desc, fecha, nif: destinatario?.nif, nombre: destinatario?.nombre, facturasRectificadas: facturasRef }, configVf.apiKey, configVf.apiUrl);
    }
  } catch (e) {
    showModal({ title: 'Error Verifactu', body: `No se pudo emitir la factura:\n${e.message}`, buttons: [{ label: 'Cerrar' }] });
    return null;
  }

  const qr = resultado.qr_code || resultado.qr || resultado.qrCode || resultado.QRCode || null;
  const uuid = resultado.uuid || resultado.UUID || resultado.id || null;

  const vfData = {
    tipo, serie, numero, fecha, uuid, qr,
    total: totalNum, lineasIva: lineasVf,
    status: resultado.status || 'Pending',
    mesa: mesaNombre, camarero: camareroActual,
    destinatario: destinatario || null,
    facturas_ref: facturasRef || null
  };

  let fbKey = null;
  try { fbKey = await guardarFacturaEmitida(vfData); } catch (_) { }
  if (fbKey) vfData.fbKey = fbKey;

  logAuditoria('factura_emitida',
    `${labelTipoFactura ? labelTipoFactura(tipo) : tipo} ${serie}-${numero} · ${fmtEu(totalNum)}`,
    {
      tipo, serie, numero, total: totalNum, uuid: uuid || null, fbKey: fbKey || null,
      destinatario: destinatario ? (destinatario.nombre || destinatario.nif || null) : null
    }
  );

  // Guardar referencia en pedidos/{mesaId}/_vf para control de estado de botones
  if (mesaId) {
    try {
      await set(ref(db, `pedidos/${mesaId}/_vf`), { tipo, serie, numero, fecha, fbKey: fbKey || null });
    } catch (_) { }
  }

  // Guardar venta en historial ANTES de imprimir, por si falla la impresión
  if (mesaId) {
    try {
      const snap = await get(ref(db, 'pedidos/' + mesaId));
      const pedidosSnap = snap.val() || {};
      const todasLineas = aplanarPedidos(pedidosSnap);
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
      const lineasHist = Object.values(agrupado);
      if (lineasHist.length > 0) {
        const ahora = new Date();
        await upsertHistorial({
          mesa: mesaNombre, camarero: [...camareros].join(', '),
          ts: ahora.getTime(), fecha: ahora.toLocaleDateString('es-ES'),
          hora: ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
          total: Math.round(totalNum * 100) / 100, lineas: lineasHist,
          verifactu: { tipo, serie, numero, uuid: uuid || null, fbKey: fbKey || null }
        });
      }
    } catch (_) { }
  }

  await imprimirTicketFinal(lineas, total, cobro, vfData);
  return vfData;
}

// Modal: Factura Simplificada F2
function showVfSimplificadaModal(lineas, total) {
  const iva = Number(configVf?.ivaDefault ?? 10);
  const factor = 1 + iva / 100;
  const base = Math.round(total / factor * 100) / 100;
  const cuota = Math.round((total - base) * 100) / 100;

  document.getElementById('modal-title').textContent = 'Factura Simplificada Verifactu';
  document.getElementById('modal-body').innerHTML = `
    <div style="font-family:var(--mono);font-size:13px;display:flex;flex-direction:column;gap:8px">
      <div style="padding:10px;background:var(--surface3);border-radius:10px">
        <div style="color:var(--muted);font-size:11px;margin-bottom:4px">TIPO F2 — Sin identificación de destinatario</div>
        <div>Serie: <strong>${configVf.serieSimp || 'SIMP'}</strong></div>
        <div>Total: <strong>${fmtEu(total)}</strong></div>
        <div style="font-size:11px;color:var(--muted)">Base imp. (${iva}%): ${fmtEu(base)} | IVA: ${fmtEu(cuota)}</div>
      </div>
      <label style="font-size:12px;color:var(--muted)">Descripción (opcional)</label>
      <input id="vf-desc" type="text" value="Consumición en local"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text)" />
    </div>`;
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  const btnC = document.createElement('button');
  btnC.className = 'modal-btn'; btnC.textContent = 'Cancelar';
  btnC.onclick = () => document.getElementById('modal-overlay').classList.remove('open');
  const btnOk = document.createElement('button');
  btnOk.className = 'modal-btn primary'; btnOk.textContent = 'Emitir y imprimir';
  btnOk.onclick = async () => {
    const desc = document.getElementById('vf-desc')?.value.trim() || 'Consumición en local';
    document.getElementById('modal-overlay').classList.remove('open');
    btnOk.disabled = true;
    configVf.descripcionDefault = desc;
    await vfEmitirYPrint({ tipo: 'F2', lineas, total });
  };
  acts.appendChild(btnC); acts.appendChild(btnOk);
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('vf-desc')?.select(), 80);
}

// Modal: Factura Completa F1 (pide NIF + Nombre del destinatario)
function showVfCompletaModal(lineas, total) {
  const iva = Number(configVf?.ivaDefault ?? 10);
  const factor = 1 + iva / 100;
  const base = Math.round(total / factor * 100) / 100;
  const cuota = Math.round((total - base) * 100) / 100;

  document.getElementById('modal-title').textContent = 'Factura Completa Verifactu';
  document.getElementById('modal-body').innerHTML = `
    <div style="font-family:var(--mono);font-size:13px;display:flex;flex-direction:column;gap:8px">
      <div style="padding:10px;background:var(--surface3);border-radius:10px">
        <div style="color:var(--muted);font-size:11px;margin-bottom:4px">TIPO F1 — Con identificación de destinatario</div>
        <div>Serie: <strong>${configVf.serieFact || 'FACT'}</strong> | Total: <strong>${fmtEu(total)}</strong></div>
        <div style="font-size:11px;color:var(--muted)">Base imp. (${iva}%): ${fmtEu(base)} | IVA: ${fmtEu(cuota)}</div>
      </div>
      <label style="font-size:12px;color:var(--muted)">NIF / CIF destinatario *</label>
      <input id="vf-nif" type="text" placeholder="B12345678 / 12345678A" list="clientes-nif-list" maxlength="20"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:14px;background:var(--surface2);color:var(--text);text-transform:uppercase" />
      <label style="font-size:12px;color:var(--muted)">Nombre / Razón social *</label>
      <input id="vf-nombre" type="text" placeholder="Nombre completo o empresa" list="clientes-nombre-list"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:14px;background:var(--surface2);color:var(--text)" />
      <label style="font-size:12px;color:var(--muted)">Dirección (opcional)</label>
      <input id="vf-dir" type="text" placeholder="Calle, nº, CP Ciudad"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text)" />
      <label style="font-size:12px;color:var(--muted)">Descripción (opcional)</label>
      <input id="vf-desc" type="text" value="Consumición en local"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text)" />
      <div id="vf-err" style="color:#e55;font-size:12px;display:none">Introduce NIF y nombre del destinatario.</div>
      ${getAutocompleteDatalists()}
    </div>`;
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  const btnC = document.createElement('button');
  btnC.className = 'modal-btn'; btnC.textContent = 'Cancelar';
  btnC.onclick = () => document.getElementById('modal-overlay').classList.remove('open');
  const btnOk = document.createElement('button');
  btnOk.className = 'modal-btn primary'; btnOk.textContent = 'Emitir y imprimir';
  btnOk.onclick = async () => {
    const nif = (document.getElementById('vf-nif')?.value || '').trim().toUpperCase();
    const nombre = (document.getElementById('vf-nombre')?.value || '').trim();
    const direccion = (document.getElementById('vf-dir')?.value || '').trim();
    const desc = (document.getElementById('vf-desc')?.value || '').trim() || 'Consumición en local';
    if (!nif || !nombre) { document.getElementById('vf-err').style.display = 'block'; return; }
    document.getElementById('modal-overlay').classList.remove('open');
    configVf.descripcionDefault = desc;
    await vfEmitirYPrint({ tipo: 'F1', lineas, total, destinatario: { nif, nombre, ...(direccion ? { direccion } : {}) } });
  };
  acts.appendChild(btnC); acts.appendChild(btnOk);
  document.getElementById('modal-overlay').classList.add('open');
  setupAutocompleteListeners();
  setTimeout(() => document.getElementById('vf-nif')?.focus(), 80);

  // background refresh datalist
  cargarClientesAutocomplete().then(() => {
    const datalistNif = document.getElementById('clientes-nif-list');
    const datalistNombre = document.getElementById('clientes-nombre-list');
    if (datalistNif) datalistNif.innerHTML = clientesCache.map(c => `<option value="${escapeHtml(c.nif)}">${escapeHtml(c.nombre)}</option>`).join('');
    if (datalistNombre) datalistNombre.innerHTML = clientesCache.map(c => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nif)}</option>`).join('');
  });
}


// Modal: Factura Sustitutiva F3 (reemplaza una simplificada con una completa)
function showVfSustitutivaModal(lineas, total, original = {}) {
  const prefSerie = original.serie || configVf.serieSimp || 'SIMP';
  const prefNum = original.numero || '';
  const prefFecha = original.fecha || fmtFechaVf(Date.now());
  document.getElementById('modal-title').textContent = 'Factura Sustitutiva F3';
  document.getElementById('modal-body').innerHTML = `
    <div style="font-family:var(--mono);font-size:13px;display:flex;flex-direction:column;gap:8px">
      <div style="padding:10px;background:var(--surface3);border-radius:10px;font-size:12px;color:var(--muted)">
        TIPO F3 — Reemplaza una factura simplificada (F2) por una completa con NIF del destinatario.
      </div>
      <label style="font-size:12px;color:var(--muted)">Serie factura original *</label>
      <input id="vf-orig-serie" type="text" value="${prefSerie}"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text);text-transform:uppercase" />
      <label style="font-size:12px;color:var(--muted)">Número factura original *</label>
      <input id="vf-orig-num" type="text" value="${prefNum}" placeholder="42"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:14px;background:var(--surface2);color:var(--text)" />
      <label style="font-size:12px;color:var(--muted)">Fecha factura original (DD-MM-AAAA) *</label>
      <input id="vf-orig-fecha" type="text" value="${prefFecha}"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text)" />
      <label style="font-size:12px;color:var(--muted)">NIF destinatario *</label>
      <input id="vf-nif" type="text" placeholder="B12345678" list="clientes-nif-list"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:14px;background:var(--surface2);color:var(--text);text-transform:uppercase" />
      <label style="font-size:12px;color:var(--muted)">Nombre / Razón social *</label>
      <input id="vf-nombre" type="text" placeholder="Nombre completo o empresa" list="clientes-nombre-list"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:14px;background:var(--surface2);color:var(--text)" />
      <label style="font-size:12px;color:var(--muted)">Dirección (opcional)</label>
      <input id="vf-dir" type="text" placeholder="Calle, nº, CP Ciudad"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text)" />
      <div id="vf-err" style="color:#e55;font-size:12px;display:none">Completa todos los campos obligatorios.</div>
      ${getAutocompleteDatalists()}
    </div>`;
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  const btnC = document.createElement('button');
  btnC.className = 'modal-btn'; btnC.textContent = 'Cancelar';
  btnC.onclick = () => document.getElementById('modal-overlay').classList.remove('open');
  const btnOk = document.createElement('button');
  btnOk.className = 'modal-btn primary'; btnOk.textContent = 'Emitir F3 y imprimir';
  btnOk.onclick = async () => {
    const origSerie = (document.getElementById('vf-orig-serie')?.value || '').trim().toUpperCase();
    const origNum = (document.getElementById('vf-orig-num')?.value || '').trim();
    const origFecha = (document.getElementById('vf-orig-fecha')?.value || '').trim();
    const nif = (document.getElementById('vf-nif')?.value || '').trim().toUpperCase();
    const nombre = (document.getElementById('vf-nombre')?.value || '').trim();
    const direccion = (document.getElementById('vf-dir')?.value || '').trim();
    if (!origSerie || !origNum || !origFecha || !nif || !nombre) {
      document.getElementById('vf-err').style.display = 'block'; return;
    }
    document.getElementById('modal-overlay').classList.remove('open');
    await vfEmitirYPrint({
      tipo: 'F3', lineas, total,
      destinatario: { nif, nombre, ...(direccion ? { direccion } : {}) },
      facturasRef: [{ serie: origSerie, numero: origNum, fecha_expedicion: origFecha }]
    });
  };
  acts.appendChild(btnC); acts.appendChild(btnOk);
  document.getElementById('modal-overlay').classList.add('open');
  setupAutocompleteListeners();
  setTimeout(() => document.getElementById('vf-nif')?.focus(), 80);

  // background refresh datalist
  cargarClientesAutocomplete().then(() => {
    const datalistNif = document.getElementById('clientes-nif-list');
    const datalistNombre = document.getElementById('clientes-nombre-list');
    if (datalistNif) datalistNif.innerHTML = clientesCache.map(c => `<option value="${escapeHtml(c.nif)}">${escapeHtml(c.nombre)}</option>`).join('');
    if (datalistNombre) datalistNombre.innerHTML = clientesCache.map(c => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nif)}</option>`).join('');
  });
}


// Modal: Rectificativa Rx (desde camarero, para la mesa actual)
// Se usa desde admin.js para el historial de facturas
window.showVfRectificativaModal = function ({ serie, numero, fecha, nif, nombre, total, tipo = 'R1' } = {}) {
  document.getElementById('modal-title').textContent = 'Factura Rectificativa';
  const tiposRect = ['R1', 'R2', 'R3', 'R4', 'R5'].map(t =>
    `<option value="${t}"${t === tipo ? ' selected' : ''}>${t} – ${t === 'R1' ? 'Art.80.1,2,6 LIVA' : t === 'R2' ? 'Art.80.3 (concurso)' : t === 'R3' ? 'Art.80.4 (impago)' : t === 'R4' ? 'Otras causas' : 'Simpl. rectificativa'
    }</option>`
  ).join('');
  document.getElementById('modal-body').innerHTML = `
    <div style="font-family:var(--mono);font-size:13px;display:flex;flex-direction:column;gap:8px">
      <div style="padding:10px;background:var(--surface3);border-radius:10px;font-size:11px;color:var(--muted)">
        Factura original: <strong>${serie || '?'}-${numero || '?'}</strong> del <strong>${fecha || '?'}</strong>
      </div>
      <label style="font-size:12px;color:var(--muted)">Tipo de rectificativa</label>
      <select id="vf-tipo-rect"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text)">
        ${tiposRect}
      </select>
      <label style="font-size:12px;color:var(--muted)">Método</label>
      <select id="vf-metodo-rect"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text)">
        <option value="I">Por diferencias (I) — importe negativo de la diferencia</option>
        <option value="S">Por sustitución (S) — anula y reemplaza</option>
      </select>
      <label style="font-size:12px;color:var(--muted)">Importe a rectificar (negativo = devolución)</label>
      <input id="vf-importe-rect" type="number" step="0.01" placeholder="-10.00"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:14px;background:var(--surface2);color:var(--text)" />
      <label style="font-size:12px;color:var(--muted)">Descripción</label>
      <input id="vf-desc" type="text" value="Rectificación"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text)" />
      ${nif ? `<div style="font-size:11px;color:var(--muted)">Destinatario: ${nif} — ${nombre || ''}</div>` : ''}
      <div id="vf-err" style="color:#e55;font-size:12px;display:none">Introduce el importe a rectificar.</div>
    </div>`;
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  const btnC = document.createElement('button');
  btnC.className = 'modal-btn'; btnC.textContent = 'Cancelar';
  btnC.onclick = () => document.getElementById('modal-overlay').classList.remove('open');
  const btnOk = document.createElement('button');
  btnOk.className = 'modal-btn primary'; btnOk.textContent = 'Emitir rectificativa';
  btnOk.onclick = async () => {
    const tipoRect = document.getElementById('vf-tipo-rect')?.value || 'R1';
    const metodo = document.getElementById('vf-metodo-rect')?.value || 'I';
    const importeStr = document.getElementById('vf-importe-rect')?.value;
    const importeNum = parseFloat(importeStr);
    const desc = document.getElementById('vf-desc')?.value.trim() || 'Rectificación';
    if (isNaN(importeNum)) { document.getElementById('vf-err').style.display = 'block'; return; }
    document.getElementById('modal-overlay').classList.remove('open');

    const err = vfConfigCheck();
    if (err) { showModal({ title: 'Verifactu', body: err, buttons: [{ label: 'Cerrar' }] }); return; }

    const serieRect = configVf.serieRect || 'RECT';
    const iva = Number(configVf.ivaDefault ?? 10);
    const factor = 1 + iva / 100;
    const baseRect = Math.round(importeNum / factor * 100) / 100;
    const cuotaRect = Math.round((importeNum - baseRect) * 100) / 100;
    const lineasVf = [{ base_imponible: baseRect.toFixed(2), tipo_impositivo: String(iva), cuota_repercutida: cuotaRect.toFixed(2) }];
    const numRect = await siguienteNumero(serieRect);
    const fechaRect = fmtFechaVf(Date.now());

    try {
      const resultado = await emitirRectificativa({
        serie: serieRect, numero: numRect, tipo: tipoRect, metodo,
        lineas: lineasVf, total: importeNum, descripcion: desc, fecha: fechaRect,
        nif, nombre,
        facturasRectificadas: [{ serie, numero, fecha_expedicion: fecha }]
      }, configVf.apiKey, configVf.apiUrl);

      const qrRes = resultado.qr_code || resultado.qr || resultado.qrCode || null;
      const uuidRes = resultado.uuid || resultado.id || null;
      const vfData = {
        tipo: tipoRect, serie: serieRect, numero: numRect, fecha: fechaRect,
        uuid: uuidRes, qr: qrRes, total: importeNum, lineasIva: lineasVf,
        status: resultado.status || 'Pending',
        facturas_ref: [{ serie, numero, fecha_expedicion: fecha }],
        destinatario: nif ? { nif, nombre } : null
      };
      try { await guardarFacturaEmitida(vfData); } catch (_) { }

      // Reimprimir la rectificativa como ticket
      const fecha2 = new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
      const lineasImpresion = [{ nombre: desc, qty: 1, precio: importeNum, nota: '' }];
      abrirImpresionTicket({
        titulo: `Rectificativa ${serieRect}-${numRect}`,
        subtitulo: fecha2,
        lineas: lineasImpresion,
        configLocal,
        mostrarPrecio: true,
        mostrarTotal: true,
        total: importeNum,
        pie: configLocal?.footer || '',
        mostrarLogo: true,
        verifactu: vfData
      });
      if (autoPDF) {
        abrirCopiaTicketFinal({
          titulo: `Rectificativa ${serieRect}-${numRect}`,
          subtitulo: fecha2,
          lineas: lineasImpresion,
          configLocal,
          total: importeNum,
          pie: configLocal?.footer || '',
          mostrarLogo: true,
          verifactu: vfData
        });
      }
    } catch (e) {
      showModal({ title: 'Error Verifactu', body: `No se pudo emitir la rectificativa:\n${e.message}`, buttons: [{ label: 'Cerrar' }] });
    }
  };
  acts.appendChild(btnC); acts.appendChild(btnOk);
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('vf-importe-rect')?.focus(), 80);
};

// Modal: Cobrar + Factura (Cobro con opción de emitir simplificada o completa)
function showVfCobrarModal(lineas, total) {
  document.getElementById('modal-title').textContent = 'Cobrar con Factura Verifactu';
  document.getElementById('modal-body').innerHTML = `
    <div style="font-family:var(--mono);font-size:14px;display:flex;flex-direction:column;gap:10px">
      <div style="margin-bottom:4px">Total a cobrar: <strong>${fmtEu(total)}</strong></div>
      <label style="font-size:12px;color:var(--muted)">Cantidad recibida (€)</label>
      <input id="vfc-recibido" type="number" min="0" step="0.01"
        style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:16px;font-family:var(--mono);background:var(--surface2);color:var(--text)"
        placeholder="0,00" />
      <label style="font-size:12px;color:var(--muted)">Tipo de factura</label>
      <select id="vfc-tipo"
        style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text)">
        <option value="F2">F2 — Simplificada (sin NIF cliente)</option>
        <option value="F1">F1 — Completa (con NIF cliente)</option>
      </select>
      <div id="vfc-nif-wrap" style="display:none;flex-direction:column;gap:6px">
        <label style="font-size:12px;color:var(--muted)">NIF destinatario</label>
        <input id="vfc-nif" type="text" placeholder="B12345678"
          style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:14px;background:var(--surface2);color:var(--text);text-transform:uppercase" />
        <label style="font-size:12px;color:var(--muted)">Nombre</label>
        <input id="vfc-nombre" type="text" placeholder="Cliente o empresa"
          style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:14px;background:var(--surface2);color:var(--text)" />
      </div>
      <div id="vfc-err" style="color:#e55;font-size:12px;display:none">Importe debe ser ≥ total.</div>
    </div>`;
  document.getElementById('vfc-tipo').addEventListener('change', e => {
    document.getElementById('vfc-nif-wrap').style.display = e.target.value === 'F1' ? 'flex' : 'none';
  });
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  const btnC = document.createElement('button');
  btnC.className = 'modal-btn'; btnC.textContent = 'Cancelar';
  btnC.onclick = () => document.getElementById('modal-overlay').classList.remove('open');
  const btnOk = document.createElement('button');
  btnOk.className = 'modal-btn primary'; btnOk.textContent = 'Cobrar y emitir factura';
  btnOk.onclick = async () => {
    const recibido = parseFloat((document.getElementById('vfc-recibido')?.value || '').replace(',', '.'));
    if (isNaN(recibido) || recibido < total - 0.001) {
      document.getElementById('vfc-err').style.display = 'block'; return;
    }
    const cambio = Math.round((recibido - total) * 100) / 100;
    const tipo = document.getElementById('vfc-tipo')?.value || 'F2';
    let destinatario = null;
    if (tipo === 'F1') {
      const nif = (document.getElementById('vfc-nif')?.value || '').trim().toUpperCase();
      const nombre = (document.getElementById('vfc-nombre')?.value || '').trim();
      if (!nif || !nombre) { document.getElementById('vfc-err').textContent = 'Introduce NIF y nombre.'; document.getElementById('vfc-err').style.display = 'block'; return; }
      destinatario = { nif, nombre };
    }
    document.getElementById('modal-overlay').classList.remove('open');
    await vfEmitirYPrint({ tipo, lineas, total, cobro: { recibido, cambio }, destinatario });
  };
  acts.appendChild(btnC); acts.appendChild(btnOk);
  document.getElementById('modal-overlay').classList.add('open');
  setTimeout(() => document.getElementById('vfc-recibido')?.focus(), 80);
}

// Reimprimir desde el ticket activo (carga datos completos de Firebase por fbKey)
async function reimprimirFacturaVfMesa(fbKey) {
  try {
    const snap = await get(ref(db, `verifactu/facturas/${fbKey}`));
    const vfData = snap.val();
    if (!vfData) { showModal({ title: 'Verifactu', body: 'No se encontraron datos de la factura.', buttons: [{ label: 'Cerrar' }] }); return; }
    window.reimprimirFacturaVf(vfData);
  } catch (e) {
    showModal({ title: 'Error', body: `No se pudo cargar la factura: ${e.message}`, buttons: [{ label: 'Cerrar' }] });
  }
}

// Reimprimir una factura emitida (desde historial admin)
window.reimprimirFacturaVf = function (vfData) {
  if (!vfData) return;
  const fecha = new Date().toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
  const lineas = (vfData.lineasIva || []).map(l => ({
    nombre: `Base imp. ${l.tipo_impositivo}%`,
    qty: 1,
    precio: parseFloat(l.base_imponible || 0),
    nota: ''
  }));
  abrirImpresionTicket({
    titulo: `${labelTipoFactura(vfData.tipo)} ${vfData.serie}-${vfData.numero}`,
    subtitulo: `${vfData.fecha} | Reimpr. ${fecha}`,
    lineas,
    configLocal,
    mostrarPrecio: true,
    mostrarTotal: true,
    total: vfData.total || 0,
    pie: configLocal?.footer || '',
    mostrarLogo: true,
    verifactu: vfData
  });
  if (autoPDF) {
    abrirCopiaTicketFinal({
      titulo: `${labelTipoFactura(vfData.tipo)} ${vfData.serie}-${vfData.numero}`,
      subtitulo: `${vfData.fecha} | Reimpr. ${fecha}`,
      lineas,
      configLocal,
      total: vfData.total || 0,
      pie: configLocal?.footer || '',
      mostrarLogo: true,
      verifactu: vfData
    });
  }
};

// ── SHOW / NAVEGACIÓN ─────────────────────────────────────────────────────────
window.show = v => {
  document.getElementById('view-mesas').style.display = v === 'mesas' ? 'block' : 'none';
  
  const viewCarta = document.getElementById('view-carta');
  if (v === 'carta') {
    if (window.innerWidth >= 768) {
      viewCarta.style.setProperty('display', 'grid', 'important');
      viewCarta.classList.add('tablet-active');
    } else {
      viewCarta.style.setProperty('display', 'block', 'important');
      viewCarta.classList.remove('tablet-active');
    }
  } else {
    viewCarta.style.display = 'none';
    viewCarta.classList.remove('tablet-active');
  }
  
  document.getElementById('view-ticket').style.display = v === 'ticket' ? 'block' : 'none';
  
  const topbar = document.querySelector('.topbar');
  if (topbar) {
    if (v === 'carta' && window.innerWidth >= 768) {
      topbar.classList.add('in-carta');
    } else {
      topbar.classList.remove('in-carta');
    }
  }
  
  document.body.classList.toggle('plano-active', v === 'mesas' && mesasViewMode === 'plano');
};

// ── CLIENTES AUTOCOMPLETE ──────────────────────────────────────────────────────
let clientesCache = [];

async function cargarClientesAutocomplete() {
  try {
    const snap = await get(ref(db, 'verifactu/facturas'));
    const facturas = snap.val() || {};
    const clientesMap = {};
    Object.values(facturas).forEach(f => {
      if (f.destinatario && f.destinatario.nif) {
        const nif = f.destinatario.nif.toUpperCase().trim();
        const nombre = (f.destinatario.nombre || '').trim();
        const direccion = (f.destinatario.direccion || '').trim();
        if (nif && nombre) {
          clientesMap[nif] = { nif, nombre, direccion };
        }
      }
    });
    clientesCache = Object.values(clientesMap);
  } catch (e) {
    console.error("Error cargando autocompletado de clientes:", e);
  }
}

function getAutocompleteDatalists() {
  const nifOptions = clientesCache.map(c => `<option value="${escapeHtml(c.nif)}">${escapeHtml(c.nombre)}</option>`).join('');
  const nombreOptions = clientesCache.map(c => `<option value="${escapeHtml(c.nombre)}">${escapeHtml(c.nif)}</option>`).join('');
  return `
    <datalist id="clientes-nif-list">${nifOptions}</datalist>
    <datalist id="clientes-nombre-list">${nombreOptions}</datalist>
  `;
}

function setupAutocompleteListeners() {
  const nifInput = document.getElementById('vf-nif');
  const nombreInput = document.getElementById('vf-nombre');
  const dirInput = document.getElementById('vf-dir');

  if (!nifInput || !nombreInput) return;

  nifInput.addEventListener('input', () => {
    const val = nifInput.value.trim().toUpperCase();
    const client = clientesCache.find(c => c.nif === val);
    if (client) {
      nombreInput.value = client.nombre;
      if (dirInput && client.direccion) {
        dirInput.value = client.direccion;
      }
    }
  });

  nombreInput.addEventListener('input', () => {
    const val = nombreInput.value.trim();
    const client = clientesCache.find(c => c.nombre === val);
    if (client) {
      nifInput.value = client.nif;
      if (dirInput && client.direccion) {
        dirInput.value = client.direccion;
      }
    }
  });
}

// ── ÚLTIMOS TICKETS CERRADOS ───────────────────────────────────────────────────
window.abrirUltimosTicketsModal = async function () {
  document.getElementById('modal-title').textContent = 'Últimos tickets cerrados';
  document.getElementById('modal-body').innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted)">Cargando últimos tickets...</div>';
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  const btnC = document.createElement('button');
  btnC.className = 'modal-btn'; btnC.textContent = 'Cerrar';
  btnC.onclick = () => document.getElementById('modal-overlay').classList.remove('open');
  acts.appendChild(btnC);
  document.getElementById('modal-overlay').classList.add('open');

  try {
    const snap = await get(query(ref(db, 'historial'), orderByChild('ts'), limitToLast(5)));
    const historyObj = snap.val() || {};
    const historyList = Object.entries(historyObj)
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));

    if (historyList.length === 0) {
      document.getElementById('modal-body').innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted)">No hay tickets cerrados en el historial.</div>';
      return;
    }

    let html = '<div style="display:flex;flex-direction:column;gap:12px;max-height:400px;overflow-y:auto;padding-right:4px">';
    historyList.forEach(h => {
      const tipoText = h.verifactu
        ? (h.verifactu.status === 'Local' ? 'Factura Completa (Local)' : `Factura (${h.verifactu.tipo})`)
        : 'Ticket Simplificado';
      const detArticulos = (h.lineas || []).map(l => `${l.qty}x ${l.nombre}`).join(', ');
      html += `
        <div style="padding:12px;background:var(--surface3);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-weight:bold;font-size:13px">${escapeHtml(h.mesa || 'Sin Mesa')}</span>
            <span style="font-size:11px;color:var(--muted)">${escapeHtml(h.fecha || '')} ${escapeHtml(h.hora || '')}</span>
          </div>
          <div style="font-size:11px;color:var(--accent2);font-weight:500">${tipoText}</div>
          <div style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(detArticulos)}">
            ${escapeHtml(detArticulos)}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;border-top:1px dashed var(--border);padding-top:6px">
            <span style="font-weight:bold;font-size:14px;color:var(--text)">${fmtEu(h.total || 0)}</span>
            <button class="modal-btn primary" onclick="window.reimprimirTicketHistorial('${h.key}')" style="padding:4px 10px;font-size:11px;border-radius:6px;min-width:auto;margin:0">Reimprimir</button>
          </div>
        </div>
      `;
    });
    html += '</div>';
    document.getElementById('modal-body').innerHTML = html;
    window._ultimosTickets = historyList;
  } catch (e) {
    document.getElementById('modal-body').innerHTML = `<div style="color:var(--danger);padding:10px">Error al cargar el historial: ${e.message}</div>`;
  }
};

window.reimprimirTicketHistorial = async function (key) {
  const item = (window._ultimosTickets || []).find(h => h.key === key);
  if (!item) {
    showModal({ title: 'Reimpresión', body: 'No se encontraron los datos del ticket.', buttons: [{ label: 'Cerrar' }] });
    return;
  }

  document.getElementById('modal-overlay').classList.remove('open');

  const lineasParaImprimir = (item.lineas || []).map(l => ({
    nombre: l.nombre,
    precio: Number(l.precio || 0),
    qtyCuenta: Number(l.qty || 0),
    nota: l.nota || ''
  }));

  if (item.verifactu && item.verifactu.fbKey) {
    try {
      const snap = await get(ref(db, `verifactu/facturas/${item.verifactu.fbKey}`));
      const vfData = snap.val();
      if (vfData) {
        await imprimirTicketFinal(lineasParaImprimir, item.total, null, vfData);
        return;
      }
    } catch (e) {
      console.warn("No se pudo cargar vfData desde fbKey, se imprime sin QR:", e);
    }
  }

  const vfData = item.verifactu ? {
    tipo: item.verifactu.tipo,
    serie: item.verifactu.serie,
    numero: item.verifactu.numero,
    fecha: item.fecha,
    total: item.total,
    status: item.verifactu.status || 'Pending',
    destinatario: item.destinatario || null,
    lineasIva: buildLineasVf(lineasParaImprimir, Number(configVf?.ivaDefault ?? 10))
  } : null;

  await imprimirTicketFinal(lineasParaImprimir, item.total, null, vfData);
};

// ── FACTURACIÓN ESTÁNDAR (SIN VERIFACTU ACTIVO) ──────────────────────────────
function renderStandardBillingButtons(standardRef) {
  const btn = (cls, label, style = '') =>
    `<button class="${cls}" style="flex:1;min-width:120px;border-radius:10px;padding:8px 10px;font-family:var(--mono);font-size:12px;cursor:pointer;${style}">${label}</button>`;
  const accentBtn = (cls, label) => btn(cls, label, 'background:rgba(61,122,255,.12);color:var(--accent2);border:1px solid rgba(61,122,255,.3)');

  const header = '<div style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:7px">Facturación Estándar</div>';
  const wrap = inner => `<div class="no-print" style="margin-top:10px;padding:10px;border:1px solid var(--border);border-radius:12px;background:var(--surface3)">${header}${inner}</div>`;
  const row = (...btns) => `<div style="display:flex;gap:6px;flex-wrap:wrap">${btns.join('')}</div>`;

  if (!standardRef) {
    return wrap(
      row(accentBtn('btn-standard-factura', 'Crear Factura Completa'))
    );
  }

  const badge = `<div style="font-size:11px;margin-bottom:6px;padding:4px 8px;border-radius:6px;background:rgba(53,199,119,.12);color:var(--success);display:inline-block">✓ Factura emitida — ${standardRef.serie}-${standardRef.numero}</div>`;
  return wrap(
    badge +
    row(accentBtn('btn-standard-reimp', 'Reimprimir Factura'))
  );
}

function showStandardCompletaModal(lineas, total) {
  const iva = Number(configVf?.ivaDefault ?? 10);
  const factor = 1 + iva / 100;
  const base = Math.round(total / factor * 100) / 100;
  const cuota = Math.round((total - base) * 100) / 100;

  document.getElementById('modal-title').textContent = 'Crear Factura Completa';
  document.getElementById('modal-body').innerHTML = `
    <div style="font-family:var(--mono);font-size:13px;display:flex;flex-direction:column;gap:8px">
      <div style="padding:10px;background:var(--surface3);border-radius:10px">
        <div>Serie: <strong>${configVf.serieFact || 'FACT'}</strong> | Total: <strong>${fmtEu(total)}</strong></div>
        <div style="font-size:11px;color:var(--muted)">Base imp. (${iva}%): ${fmtEu(base)} | IVA: ${fmtEu(cuota)}</div>
      </div>
      <label style="font-size:12px;color:var(--muted)">NIF / CIF destinatario *</label>
      <input id="vf-nif" type="text" placeholder="B12345678 / 12345678A" list="clientes-nif-list" maxlength="20"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:14px;background:var(--surface2);color:var(--text);text-transform:uppercase" />
      <label style="font-size:12px;color:var(--muted)">Nombre / Razón social *</label>
      <input id="vf-nombre" type="text" placeholder="Nombre completo o empresa" list="clientes-nombre-list"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:14px;background:var(--surface2);color:var(--text)" />
      <label style="font-size:12px;color:var(--muted)">Dirección *</label>
      <input id="vf-dir" type="text" placeholder="Calle, nº, CP Ciudad"
        style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-family:var(--mono);font-size:13px;background:var(--surface2);color:var(--text)" />
      <div id="vf-err" style="color:#e55;font-size:12px;display:none">Introduce NIF, nombre y dirección del destinatario.</div>
      ${getAutocompleteDatalists()}
    </div>`;
  const acts = document.getElementById('modal-actions');
  acts.innerHTML = '';
  const btnC = document.createElement('button');
  btnC.className = 'modal-btn'; btnC.textContent = 'Cancelar';
  btnC.onclick = () => document.getElementById('modal-overlay').classList.remove('open');
  const btnOk = document.createElement('button');
  btnOk.className = 'modal-btn primary'; btnOk.textContent = 'Emitir y imprimir';
  btnOk.onclick = async () => {
    const nif = (document.getElementById('vf-nif')?.value || '').trim().toUpperCase();
    const nombre = (document.getElementById('vf-nombre')?.value || '').trim();
    const direccion = (document.getElementById('vf-dir')?.value || '').trim();
    if (!nif || !nombre || !direccion) { document.getElementById('vf-err').style.display = 'block'; return; }
    document.getElementById('modal-overlay').classList.remove('open');
    btnOk.disabled = true;
    await emitirFacturaEstandarCompleta(lineas, total, { nif, nombre, direccion });
  };
  acts.appendChild(btnC); acts.appendChild(btnOk);
  document.getElementById('modal-overlay').classList.add('open');
  setupAutocompleteListeners();
  setTimeout(() => document.getElementById('vf-nif')?.focus(), 80);
}

async function emitirFacturaEstandarCompleta(lineas, total, destinatario) {
  const serie = configVf.serieFact || 'FACT';
  const numero = await siguienteNumero(serie);
  const fecha = fmtFechaVf(Date.now());
  const totalNum = Math.round(Number(total) * 100) / 100;
  const lineasVf = buildLineasVf(lineas, Number(configVf?.ivaDefault ?? 10));

  const factData = {
    tipo: 'F1',
    serie,
    numero,
    fecha,
    total: totalNum,
    lineasIva: lineasVf,
    status: 'Local',
    mesa: mesaNombre,
    camarero: camareroActual,
    destinatario: destinatario
  };

  let fbKey = null;
  try { fbKey = await guardarFacturaEmitida(factData); } catch (_) { }
  if (fbKey) factData.fbKey = fbKey;

  logAuditoria('factura_estandar_emitida',
    `Factura Estándar ${serie}-${numero} · ${fmtEu(totalNum)}`,
    {
      tipo: 'F1', serie, numero, total: totalNum, fbKey: fbKey || null,
      destinatario: destinatario ? (destinatario.nombre || destinatario.nif || null) : null
    }
  );

  if (mesaId) {
    try {
      await set(ref(db, `pedidos/${mesaId}/_standard_factura`), { tipo: 'F1', serie, numero, fecha, fbKey: fbKey || null });
    } catch (_) { }
  }

  // Guardar en historial
  if (mesaId) {
    try {
      const snap = await get(ref(db, 'pedidos/' + mesaId));
      const pedidosSnap = snap.val() || {};
      const todasLineas = aplanarPedidos(pedidosSnap);
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
      const lineasHist = Object.values(agrupado);
      if (lineasHist.length > 0) {
        const ahora = new Date();
        await upsertHistorial({
          mesa: mesaNombre, camarero: [...camareros].join(', '),
          ts: ahora.getTime(), fecha: ahora.toLocaleDateString('es-ES'),
          hora: ahora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
          total: Math.round(totalNum * 100) / 100, lineas: lineasHist,
          verifactu: { tipo: 'F1', serie, numero, status: 'Local', fbKey: fbKey || null }
        });
      }
    } catch (_) { }
  }

  await cargarClientesAutocomplete();
  await imprimirTicketFinal(lineas, total, null, factData);
  await cargarTicketActual();
}
