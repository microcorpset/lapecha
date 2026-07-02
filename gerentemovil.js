import { db } from './firebase.js';
import {
  ref, get, onValue, query, orderByChild, startAt, endAt,
  set as fbSet, push as fbPush, remove as fbRemove, update as fbUpdate
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const checkAndTouchMenu = (refVal) => {
  if (!refVal) return;
  const url = refVal.toString();
  if (url.includes('/carta') || url.includes('/categorias') || url.includes('carta') || url.includes('categorias')) {
    fbSet(ref(db, 'config/menu_version'), Date.now()).catch(err => console.error(err));
  }
};

const set = (refVal, data) => {
  const res = fbSet(refVal, data);
  checkAndTouchMenu(refVal);
  return res;
};

const push = (refVal, data) => {
  const res = fbPush(refVal, data);
  checkAndTouchMenu(refVal);
  return res;
};

const remove = (refVal) => {
  const res = fbRemove(refVal);
  checkAndTouchMenu(refVal);
  return res;
};

const update = (refVal, data) => {
  const res = fbUpdate(refVal, data);
  if (data && typeof data === 'object') {
    const keys = Object.keys(data);
    if (keys.some(k => k.startsWith('carta') || k.startsWith('categorias'))) {
      fbSet(ref(db, 'config/menu_version'), Date.now()).catch(err => console.error(err));
    }
  }
  checkAndTouchMenu(refVal);
  return res;
};

// --- VARIABLES DE ESTADO ---
let passwordCorrecta = "";
let pinBuffer = "";
let mesasData = {};
let pedidosData = {};
let categoriasData = {};
let cartaData = {};
let planoCfg = { cols: 16, rows: 12 };
let planoZonaActiva = null;
let currentMesaId = null;
let currentView = 'plano';
let seguridadData = {};
let usuariosData = {};

const PIN_SESSION_KEY = "gerente_auth_session";

// --- ELEMENTOS DEL DOM ---
const pinScreen = document.getElementById("pin-screen");
const appShell = document.getElementById("app-shell");
const pinDots = [
  document.getElementById("pd0"),
  document.getElementById("pd1"),
  document.getElementById("pd2"),
  document.getElementById("pd3")
];
const pinErrorMsg = document.getElementById("pin-error");

// --- INICIALIZACIÓN Y SEGURIDAD PIN ---
async function init() {
  // 1. Obtener la contraseña de Firebase o fallback
  try {
    const snap = await get(ref(db, "config/audit/password"));
    passwordCorrecta = snap.val() ? String(snap.val()).trim() : "audit1234";
  } catch (err) {
    passwordCorrecta = "audit1234";
  }

  // 2. Comprobar sesión existente
  if (sessionStorage.getItem(PIN_SESSION_KEY) === "1") {
    desbloquearPanel();
  } else {
    // Determinar si mostramos teclado numérico o teclado de texto
    // Si la contraseña es "audit1234" (default con letras), permitimos usar el PIN "1234" en teclado numérico,
    // o escribir la contraseña alfanumérica completa.
    const esNumerico4 = /^\d{4}$/.test(passwordCorrecta) || passwordCorrecta === "audit1234";

    if (esNumerico4) {
      document.querySelector(".pin-dots").style.display = "flex";
      document.getElementById("pin-pad").style.display = "grid";
      document.getElementById("text-login-container").style.display = "none";
      configurarTecladoPin();
    } else {
      document.querySelector(".pin-dots").style.display = "none";
      document.getElementById("pin-pad").style.display = "none";
      document.getElementById("text-login-container").style.display = "flex";
      configurarTecladoTexto();
    }
  }
}

function configurarTecladoPin() {
  document.getElementById("pin-pad").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-k]");
    if (!btn) return;
    const k = btn.dataset.k;
    
    if (k === "del") {
      pinBuffer = pinBuffer.slice(0, -1);
      actualizarDots();
    } else if (k !== "") {
      if (pinBuffer.length >= 4) return;
      pinBuffer += k;
      actualizarDots();
      
      if (pinBuffer.length === 4) {
        verificarPin();
      }
    }
  });
}

function configurarTecladoTexto() {
  const btnEntrar = document.getElementById("btn-entrar-texto");
  const inputTexto = document.getElementById("text-pin-input");

  btnEntrar.onclick = () => {
    const val = inputTexto.value.trim();
    if (val === passwordCorrecta) {
      iniciarSesionExitosa();
    } else {
      pinErrorMsg.textContent = "Contraseña Incorrecta";
      inputTexto.value = "";
      setTimeout(() => {
        pinErrorMsg.textContent = "";
      }, 1500);
    }
  };

  // Permitir entrar pulsando Enter
  inputTexto.onkeydown = (e) => {
    if (e.key === "Enter") {
      btnEntrar.click();
    }
  };
}

function actualizarDots(error = false) {
  pinDots.forEach((dot, idx) => {
    dot.className = "pin-dot" + (idx < pinBuffer.length ? (error ? " error" : " filled") : "");
  });
}

async function verificarPin() {
  const esCorrecto = (pinBuffer === passwordCorrecta) || (passwordCorrecta === "audit1234" && pinBuffer === "1234");
  
  if (esCorrecto) {
    iniciarSesionExitosa();
  } else {
    // Feedback de error
    actualizarDots(true);
    pinErrorMsg.textContent = "PIN Incorrecto";
    
    setTimeout(() => {
      pinBuffer = "";
      actualizarDots(false);
      pinErrorMsg.textContent = "";
    }, 900);
  }
}

function iniciarSesionExitosa() {
  sessionStorage.setItem(PIN_SESSION_KEY, "1");
  
  // Registrar evento de login en auditoría
  logAuditoria('login', 'Inicio de sesión (Gerente Móvil)');
  
  desbloquearPanel();
}

function desbloquearPanel() {
  pinScreen.style.display = "none";
  appShell.style.display = "flex";
  
  // Iniciar sincronización de datos
  iniciarSincronizacionDB();
  
  // Establecer fechas iniciales para filtros de consulta
  const hoy = new Date().toISOString().split('T')[0];
  document.getElementById("venta-desde").value = hoy;
  document.getElementById("venta-hasta").value = hoy;
  document.getElementById("audit-fecha").value = hoy;
}

// --- LOGS DE AUDITORÍA ---
function logAuditoria(accion, detalle = '') {
  const ts = Date.now();
  const d = new Date(ts);
  const fechaKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hora = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  
  const entrada = {
    ts, fechaKey, hora,
    camarero: "Gerente Móvil",
    accion,
    detalle: String(detalle)
  };
  
  // Registro asíncrono sin bloquear
  push(ref(db, `auditoria/${fechaKey}`), entrada).catch(() => {});
}

// --- SINCRONIZACIÓN FIREBASE REALTIME ---
function iniciarSincronizacionDB() {
  // Monitoreo de conexión a internet
  onValue(ref(db, ".info/connected"), (snap) => {
    const statusDot = document.getElementById("network-status");
    if (snap.val() === true) {
      statusDot.classList.add("connected");
    } else {
      statusDot.classList.remove("connected");
    }
  });

  // Título del establecimiento
  onValue(ref(db, "config/local"), (snap) => {
    const loc = snap.val() || {};
    document.getElementById("local-title").textContent = loc.nombre || "Comandero - Gerencia";
  });

  // Configuración del plano
  onValue(ref(db, "config/plano"), (snap) => {
    const val = snap.val() || {};
    planoCfg = { cols: Number(val.cols) || 16, rows: Number(val.rows) || 12 };
    renderPlano();
  });

  // Mesas
  onValue(ref(db, "mesas"), (snap) => {
    mesasData = snap.val() || {};
    renderPlano();
  });

  // Pedidos
  onValue(ref(db, "pedidos"), (snap) => {
    pedidosData = snap.val() || {};
    renderPlano();
    if (currentMesaId) {
      renderDetalleComanda(currentMesaId);
    }
  });

  // Categorías
  onValue(ref(db, "categorias"), (snap) => {
    categoriasData = snap.val() || {};
    renderCarta();
  });

  // Carta / Artículos
  onValue(ref(db, "carta"), (snap) => {
    cartaData = snap.val() || {};
    renderCarta();
  });

  // Seguridad y bloqueo
  onValue(ref(db, "config/seguridad"), (snap) => {
    seguridadData = snap.val() || {};
    actualizarAjustesSeguridadMovil();
  });

  // Usuarios / Camareros
  onValue(ref(db, "config/usuarios"), (snap) => {
    usuariosData = snap.val() || {};
    renderCamarerosListado();
    poblarExcepcionCamareroSelectorMovil();
  });
}

// --- NAVEGACIÓN ENTRE VISTAS ---
window.navegarA = (tab) => {
  currentView = tab;
  
  // Cambiar botones activos de la barra de navegación
  const navItems = document.querySelectorAll(".nav-item");
  navItems.forEach(item => {
    if (item.getAttribute("onclick").includes(tab)) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });

  // Cambiar paneles visibles
  const panes = document.querySelectorAll(".view-pane");
  panes.forEach(pane => {
    if (pane.id === `pane-${tab}`) {
      pane.classList.add("active");
    } else {
      pane.classList.remove("active");
    }
  });
  
  // Recargar plano o carta si aplica
  if (tab === 'plano') renderPlano();
  if (tab === 'carta') renderCarta();
  if (tab === 'camareros') renderCamarerosListado();
};

// --- RENDERIZADO PLANO DE MESAS ---
function renderPlano() {
  if (currentView !== 'plano') return;
  const tabsContainer = document.getElementById("plano-tabs-container");
  const renderArea = document.getElementById("plano-render-area");
  if (!tabsContainer || !renderArea) return;

  const entries = Object.entries(mesasData)
    .filter(([id]) => !id.startsWith("temp_"))
    .sort(([,a],[,b]) => (a.orden ?? 999) - (b.orden ?? 999) || a.nombre.localeCompare(b.nombre, 'es', { numeric: true }));

  const temporales = Object.entries(mesasData)
    .filter(([id]) => id.startsWith("temp_"))
    .sort(([,a],[,b]) => (a.creadoTs || 0) - (b.creadoTs || 0));

  if (entries.length === 0 && temporales.length === 0) {
    renderArea.innerHTML = `<div class="plano-sinubicar" style="text-align:center;margin-top:40px;">No hay mesas configuradas ni pedidos temporales activos.</div>`;
    tabsContainer.innerHTML = "";
    return;
  }

  // 1. Cargar Zonas
  const hayZonas = entries.some(([,m]) => m.zona && m.zona.trim());
  let zonas = [];
  if (hayZonas) {
    zonas = [...new Set(entries.map(([,m]) => (m.zona || "").trim()).filter(Boolean))];
    if (!planoZonaActiva || !zonas.includes(planoZonaActiva)) {
      planoZonaActiva = zonas[0];
    }
  }

  const mesasFiltradas = hayZonas
    ? entries.filter(([,m]) => (m.zona || "").trim() === planoZonaActiva)
    : entries;

  // Renderizar pestañas de zonas
  tabsContainer.innerHTML = "";
  if (hayZonas) {
    zonas.forEach(z => {
      const btn = document.createElement("button");
      btn.className = `plano-tab${z === planoZonaActiva ? ' active' : ''}`;
      btn.textContent = z;
      btn.onclick = () => {
        planoZonaActiva = z;
        renderPlano();
      };
      tabsContainer.appendChild(btn);
    });
  }

  // 2. Determinar si hay mesas ubicadas en plano
  const ubicadas = mesasFiltradas.filter(([,m]) => m.plano);
  const sinUbicar = mesasFiltradas.filter(([,m]) => !m.plano && !m.nombre.startsWith('#'));

  renderArea.innerHTML = "";

  if (ubicadas.length > 0) {
    const planoContainer = document.createElement("div");
    planoContainer.className = "plano-wrap";
    
    const cols = planoCfg.cols || 16;
    const rows = planoCfg.rows || 12;
    
    const grid = document.createElement("div");
    grid.className = "plano-grid";
    grid.style.setProperty("--plano-cols", cols);
    grid.style.setProperty("--plano-rows", rows);
    
    mesasFiltradas.forEach(([mid, m]) => {
      const p = m.plano;
      if (!p) return;
      
      const card = document.createElement("div");
      const isCircle = p.shape === "circle" ? " circle" : "";
      const isDeco = m.nombre.startsWith('#');

      if (isDeco) {
        card.className = `plano-mesa decorador${isCircle}`;
        card.style.gridColumn = `${p.x} / span ${p.w}`;
        card.style.gridRow = `${p.y} / span ${p.h}`;
        card.innerHTML = `<span class="plano-mesa-nombre">${m.nombre.slice(1)}</span>`;
        grid.appendChild(card);
        return;
      }

      const tienePedido = pedidosData[mid] && Object.keys(pedidosData[mid]).length > 0;
      let claseAlerta = tienePedido ? "ocupada" : "libre";
      let tiempoOcupada = null;
      if (tienePedido) {
        tiempoOcupada = calcularTiempoOcupada(mid);
        let minTsPendiente = Infinity;
        let tienePendiente = false;
        
        Object.values(pedidosData[mid]).forEach(envio => {
          const envioTs = Number(envio.ts) || 0;
          const ls = envio.lineas || { _: envio };
          Object.values(ls).forEach(l => {
            if (l && l.estado === "pendiente") {
              tienePendiente = true;
              const lts = Number(l.ts) || envioTs || 0;
              if (lts > 0 && lts < minTsPendiente) minTsPendiente = lts;
            }
          });
        });
        
        if (tienePendiente && minTsPendiente < Infinity) {
          const minsPend = Math.max(0, Math.floor((Date.now() - minTsPendiente) / 60000));
          if (minsPend >= 20) {
            claseAlerta = "alerta-danger";
          } else if (minsPend >= 10) {
            claseAlerta = "alerta-warn";
          } else {
            claseAlerta = "alerta-ok";
          }
        }
      }
      
      card.className = `plano-mesa ${claseAlerta}${isCircle}`;
      card.style.gridColumn = `${p.x} / span ${p.w}`;
      card.style.gridRow = `${p.y} / span ${p.h}`;
      
      let totalQty = 0;
      let subtotal = 0;
      if (tienePedido) {
        Object.values(pedidosData[mid]).forEach(env => {
          const ls = env.lineas || { _: env };
          Object.values(ls).forEach(l => {
            if (l && l.nombre && l.estado !== 'cancelado') {
              const qty = l.qtyTicket !== undefined && l.qtyTicket !== null ? Number(l.qtyTicket) : Number(l.qty || 0);
              const price = l.precioTicket !== undefined && l.precioTicket !== null ? Number(l.precioTicket) : Number(l.precio || 0);
              if (qty > 0) {
                totalQty += qty;
                subtotal += (price * qty);
              }
            }
          });
        });
      }

      card.innerHTML = `
        <span class="plano-mesa-nombre">${m.nombre}</span>
        ${tienePedido ? `<span class="plano-mesa-extra">${subtotal.toFixed(2)}€</span>` : ''}
        ${tiempoOcupada ? `<span class="plano-mesa-tiempo-badge" style="font-size: 7px; padding: 1px 3px; margin-top: 1px;">⏳ ${tiempoOcupada}</span>` : ''}
      `;
      card.onclick = () => abrirDrawerComanda(mid, m.nombre);
      grid.appendChild(card);
    });
    
    planoContainer.appendChild(grid);
    renderArea.appendChild(planoContainer);
    
    if (sinUbicar.length > 0) {
      const sinUbicarDiv = document.createElement("div");
      sinUbicarDiv.className = "plano-sinubicar";
      sinUbicarDiv.innerHTML = `<strong>Mesas sin ubicar:</strong> ${sinUbicar.map(([,m]) => m.nombre).join(", ")}`;
      renderArea.appendChild(sinUbicarDiv);
    }
  } else {
    // Dibujar Grid Simple
    const grid = document.createElement("div");
    grid.className = "mesas-grid";
    
    mesasFiltradas.filter(([,m]) => !m.nombre.startsWith('#')).forEach(([mid, m]) => {
      const tienePedido = pedidosData[mid] && Object.keys(pedidosData[mid]).length > 0;
      const card = document.createElement("div");
      
      let claseAlerta = tienePedido ? "ocupada" : "libre";
      let tiempoOcupada = null;
      if (tienePedido) {
        tiempoOcupada = calcularTiempoOcupada(mid);
      }
      
      card.className = `mesa-card ${claseAlerta}`;
      
      let totalQty = 0;
      let subtotal = 0;
      if (tienePedido) {
        Object.values(pedidosData[mid]).forEach(env => {
          const ls = env.lineas || { _: env };
          Object.values(ls).forEach(l => {
            if (l && l.nombre && l.estado !== 'cancelado') {
              const qty = l.qtyTicket !== undefined && l.qtyTicket !== null ? Number(l.qtyTicket) : Number(l.qty || 0);
              const price = l.precioTicket !== undefined && l.precioTicket !== null ? Number(l.precioTicket) : Number(l.precio || 0);
              if (qty > 0) {
                totalQty += qty;
                subtotal += (price * qty);
              }
            }
          });
        });
      }
      
      card.innerHTML = `
        <div style="font-size:16px;margin-bottom:4px;font-weight:600;">${m.nombre}</div>
        ${tienePedido ? `<div class="mesa-subtext">${totalQty} art. (${subtotal.toFixed(2)}€)</div>` : '<div class="mesa-subtext" style="color:var(--success);">Libre</div>'}
        ${tiempoOcupada ? `<div class="plano-mesa-tiempo-badge">⏳ ${tiempoOcupada}</div>` : ""}
      `;
      card.onclick = () => abrirDrawerComanda(mid, m.nombre);
      grid.appendChild(card);
    });
    renderArea.appendChild(grid);
  }

  // 3. Pedidos Temporales Activos (Sección dedicada en la parte inferior)
  if (temporales.length > 0) {
    const tempSection = document.createElement("div");
    tempSection.className = "temp-pedidos-section";
    tempSection.style.marginTop = "24px";
    tempSection.style.paddingTop = "16px";
    tempSection.style.borderTop = "1px solid var(--border)";
    tempSection.style.width = "100%";
    
    tempSection.innerHTML = `
      <div style="font-family: var(--font-mono); font-size: 11px; font-weight: 600; color: var(--text-dim); margin-bottom: 12px; letter-spacing: 0.05em;">
        🛒 PEDIDOS TEMPORALES ACTIVOS
      </div>
    `;
    
    const tempGrid = document.createElement("div");
    tempGrid.className = "mesas-grid";
    
    temporales.forEach(([mid, m]) => {
      const tienePedido = pedidosData[mid] && Object.keys(pedidosData[mid]).length > 0;
      const card = document.createElement("div");
      
      let claseAlerta = tienePedido ? "ocupada" : "libre";
      let tiempoOcupada = null;
      if (tienePedido) {
        tiempoOcupada = calcularTiempoOcupada(mid);
      }
      
      card.className = `mesa-card ${claseAlerta}`;
      
      let totalQty = 0;
      let subtotal = 0;
      if (tienePedido) {
        Object.values(pedidosData[mid]).forEach(env => {
          const ls = env.lineas || { _: env };
          Object.values(ls).forEach(l => {
            if (l && l.nombre && l.estado !== 'cancelado') {
              const qty = l.qtyTicket !== undefined && l.qtyTicket !== null ? Number(l.qtyTicket) : Number(l.qty || 0);
              const price = l.precioTicket !== undefined && l.precioTicket !== null ? Number(l.precioTicket) : Number(l.precio || 0);
              if (qty > 0) {
                totalQty += qty;
                subtotal += (price * qty);
              }
            }
          });
        });
      }
      
      card.innerHTML = `
        <div style="font-size:14px;margin-bottom:4px;font-weight:600;">${m.nombre}</div>
        ${tienePedido ? `<div class="mesa-subtext">${totalQty} art. (${subtotal.toFixed(2)}€)</div>` : '<div class="mesa-subtext">Vaciando...</div>'}
        ${tiempoOcupada ? `<div class="plano-mesa-tiempo-badge">⏳ ${tiempoOcupada}</div>` : ""}
      `;
      card.onclick = () => abrirDrawerComanda(mid, m.nombre);
      tempGrid.appendChild(card);
    });
    
    tempSection.appendChild(tempGrid);
    renderArea.appendChild(tempSection);
  }
}

// --- COMPROBACIÓN DE TIEMPOS DE ESPERA ---
function calcularTiempoOcupada(mid) {
  const ped = pedidosData[mid];
  if (!ped) return null;
  
  let minTs = Infinity;
  Object.values(ped).forEach(envio => {
    if (envio && typeof envio === 'object' && !String(envio.envioId || '').startsWith('_')) {
      const ts = Number(envio.ts) || 0;
      if (ts > 0 && ts < minTs) minTs = ts;
    }
  });

  if (minTs === Infinity) return null;
  const diffMins = Math.max(0, Math.floor((Date.now() - minTs) / 60000));
  if (diffMins >= 60) {
    const hrs = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    return `${hrs}h ${mins}m`;
  }
  return `${diffMins} min`;
}

// --- DRAWER DE DETALLE TICKET MESA ---
function abrirDrawerComanda(mid, nombre) {
  currentMesaId = mid;
  document.getElementById("comanda-drawer-title").textContent = `Detalle comanda: ${nombre}`;
  renderDetalleComanda(mid);
  
  document.getElementById("overlay-comanda").classList.add("open");
  document.getElementById("drawer-comanda").classList.add("open");
}

window.cerrarDrawerComanda = () => {
  currentMesaId = null;
  document.getElementById("overlay-comanda").classList.remove("open");
  document.getElementById("drawer-comanda").classList.remove("open");
};

function renderDetalleComanda(mid) {
  const body = document.getElementById("comanda-drawer-body");
  const totalLabel = document.getElementById("comanda-drawer-total");
  if (!body) return;

  const ped = pedidosData[mid];
  if (!ped || Object.keys(ped).length === 0) {
    body.innerHTML = `<div class="plano-sinubicar" style="text-align:center;padding:24px;">Mesa vacía / sin consumos activos.</div>`;
    totalLabel.textContent = "0.00 €";
    return;
  }

  let total = 0;
  let lineasHTML = "";

  Object.entries(ped)
    .filter(([k]) => !k.startsWith('_'))
    .forEach(([, envio]) => {
      const envioId = envio.envioId || '';
      const camarero = envio.camarero || 'Camarero';
      const lines = envio.lineas || { _: envio };
      
      Object.entries(lines).forEach(([lk, l]) => {
        if (!l || !l.nombre) return;
        const qty = l.qtyTicket !== undefined && l.qtyTicket !== null ? Number(l.qtyTicket) : Number(l.qty || 0);
        const price = l.precioTicket !== undefined && l.precioTicket !== null ? Number(l.precioTicket) : Number(l.precio || 0);
        
        if (qty > 0) {
          total += (qty * price);
        }
        
        let subText = l.nota ? `<span class="linea-nota">⚠️ ${l.nota}</span>` : "";
        
        lineasHTML += `
          <div class="linea-comanda ${l.estado || 'pendiente'}">
            <div class="linea-izq">
              <span class="linea-nombre">${qty}x ${l.nombre}</span>
              ${subText}
              <span class="linea-meta">Camarero: ${camarero}</span>
            </div>
            <div class="linea-der">${(qty * price).toFixed(2)} €</div>
          </div>
        `;
      });
    });

  body.innerHTML = lineasHTML || `<div class="plano-sinubicar" style="text-align:center;padding:24px;">Mesa sin líneas activas.</div>`;
  totalLabel.textContent = `${total.toFixed(2)} €`;
}

// --- RENDERIZADO Y EDICIÓN CARTA ---
function renderCarta() {
  if (currentView !== 'carta') return;
  const container = document.getElementById("carta-accordion");
  if (!container) return;

  const cats = Object.entries(categoriasData).sort((a,b) => (a[1].orden ?? 999) - (b[1].orden ?? 999));
  container.innerHTML = "";

  if (cats.length === 0) {
    container.innerHTML = `<div class="plano-sinubicar" style="text-align:center;margin-top:40px;">No hay categorías en la carta. Crea una con el botón "+".</div>`;
    return;
  }

  cats.forEach(([cid, cat]) => {
    const header = document.createElement("div");
    header.className = "accordion-header";
    header.innerHTML = `
      <span>📂 ${cat.nombre}</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button style="background:var(--panel-light);border:1px solid var(--border);color:var(--text);font-size:12px;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;" onclick="event.stopPropagation(); abrirDrawerEditCat('${cid}')">⚙</button>
        <button style="background:var(--accent);border:none;color:#fff;font-size:13px;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;" onclick="event.stopPropagation(); abrirModalNuevoArticulo('${cid}')">+</button>
        <span class="nav-icon">▼</span>
      </div>
    `;
    
    header.onclick = () => {
      const isAct = header.classList.contains("active");
      document.querySelectorAll(".accordion-header").forEach(h => h.classList.remove("active"));
      if (!isAct) header.classList.add("active");
    };

    const content = document.createElement("div");
    content.className = "accordion-content";

    // Cargar artículos de esta categoría
    const articulos = Object.entries(cartaData)
      .filter(([, art]) => art.catId === cid)
      .sort((a,b) => (a[1].nombre || "").localeCompare(b[1].nombre || ""));

    if (articulos.length === 0) {
      content.innerHTML = `<div class="plano-sinubicar" style="padding:12px;text-align:center;font-size:12px;">Sin artículos. Pulsa "+" en la cabecera para añadir.</div>`;
    } else {
      articulos.forEach(([aid, art]) => {
        const row = document.createElement("div");
        row.className = "articulo-row" + (art.disponible === false ? " disabled" : "");
        row.innerHTML = `
          <div class="articulo-info">
            <span class="articulo-nombre">${art.nombre}</span>
            <span class="articulo-precio">${Number(art.precio || 0).toFixed(2)} €</span>
          </div>
          <button class="btn-edit-art" onclick="abrirDrawerEditArt('${cid}','${aid}')">Editar</button>
        `;
        content.appendChild(row);
      });
    }

    container.appendChild(header);
    container.appendChild(content);
  });
}

// --- CARTA ACCIONES (AÑADIR/EDITAR/VARIANTES) ---
window.abrirModalNuevaCategoria = async () => {
  const nombre = await showCustomPrompt("Nueva Categoría", "Introduce el nombre de la nueva categoría:");
  if (!nombre || !nombre.trim()) return;

  const orden = Object.keys(categoriasData).length + 1;
  push(ref(db, "categorias"), { nombre: nombre.trim(), orden }).then(() => {
    showToast("Categoría añadida con éxito.");
  });
};

window.abrirModalNuevoArticulo = async (cid) => {
  const nombre = await showCustomPrompt("Nuevo Artículo", "Nombre del nuevo artículo:");
  if (!nombre || !nombre.trim()) return;
  const precioStr = await showCustomPrompt("Precio Artículo", "Precio (€) del artículo (ej: 8.50):", "0.00");
  if (precioStr === null) return;
  const precio = parseFloat(precioStr || 0) || 0;

  const newArt = {
    catId: cid,
    nombre: nombre.trim(),
    precio,
    disponible: true,
    destino: "cocina"
  };

  push(ref(db, "carta"), newArt).then(() => {
    showToast("Artículo añadido.");
  });
};

// DRAWER EDICIÓN ARTÍCULO
window.abrirDrawerEditArt = (cid, aid) => {
  const art = cartaData[aid];
  if (!art) return;

  document.getElementById("edit-art-id").value = aid;
  document.getElementById("edit-art-cat-id").value = cid;
  document.getElementById("edit-art-nombre").value = art.nombre || "";
  document.getElementById("edit-art-precio").value = Number(art.precio || 0).toFixed(2);
  document.getElementById("edit-art-destino").value = art.destino || "cocina";
  document.getElementById("edit-art-activo").checked = art.disponible !== false;
  document.getElementById("edit-art-notas").value = art.notasPredefinidas || "";
  
  const esCombo = art.esCombo === true;
  document.getElementById("edit-art-escombo").checked = esCombo;
  document.getElementById("combo-panel-movil").style.display = esCombo ? "flex" : "none";
  
  // Limpiar campos variantes
  document.getElementById("new-var-nombre").value = "";
  document.getElementById("new-var-precio").value = "";

  renderVariantesArt(art.variantes || []);
  updateEditComboGroupsListMovil(aid);

  document.getElementById("overlay-edit-art").classList.add("open");
  document.getElementById("drawer-edit-art").classList.add("open");
};

window.cerrarDrawerEditArt = () => {
  document.getElementById("overlay-edit-art").classList.remove("open");
  document.getElementById("drawer-edit-art").classList.remove("open");
};

function renderVariantesArt(variantes) {
  const list = document.getElementById("art-variantes-list");
  list.innerHTML = "";
  
  if (variantes.length === 0) {
    list.innerHTML = `<div style="font-size:11px;color:var(--text-dim);text-align:center;">Sin variantes configuradas.</div>`;
    return;
  }

  variantes.forEach((v, idx) => {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.background = "var(--panel-light)";
    row.style.padding = "6px 10px";
    row.style.borderRadius = "6px";
    row.style.fontSize = "12px";
    
    row.innerHTML = `
      <span>${v.nombre} (${Number(v.precio || 0) >= 0 ? "+" : ""}${Number(v.precio || 0).toFixed(2)} €)</span>
      <button class="btn-close-drawer" style="font-size:16px;color:var(--danger);background:none;border:none;cursor:pointer;" onclick="eliminarVarianteArticulo(${idx})">&times;</button>
    `;
    list.appendChild(row);
  });
}

window.agregarVarianteArticulo = () => {
  const nom = document.getElementById("new-var-nombre").value.trim();
  const pre = parseFloat(document.getElementById("new-var-precio").value) || 0;
  if (!nom) return;

  const aid = document.getElementById("edit-art-id").value;
  const art = cartaData[aid];
  if (!art) return;

  const vars = art.variantes || [];
  vars.push({ nombre: nom, precio: pre });
  
  // Guardar variantes en base de datos localmente antes de guardar el artículo
  art.variantes = vars;
  
  document.getElementById("new-var-nombre").value = "";
  document.getElementById("new-var-precio").value = "";
  renderVariantesArt(vars);
};

window.eliminarVarianteArticulo = (idx) => {
  const aid = document.getElementById("edit-art-id").value;
  const art = cartaData[aid];
  if (!art) return;

  const vars = art.variantes || [];
  vars.splice(idx, 1);
  art.variantes = vars;
  
  renderVariantesArt(vars);
};

// --- GESTIÓN DE COMBOS EN MÓVIL ---
window.toggleComboPanelMovil = () => {
  const aid = document.getElementById("edit-art-id").value;
  const chk = document.getElementById("edit-art-escombo");
  const panel = document.getElementById("combo-panel-movil");
  if (chk && panel) {
    const esCombo = chk.checked;
    panel.style.display = esCombo ? "flex" : "none";
    if (esCombo) {
      updateEditComboGroupsListMovil(aid);
    }
  }
};

function getComboGroupsMovil(aid) {
  const art = cartaData[aid];
  const raw = art?.comboGroups;
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

window.updateEditComboGroupsListMovil = (aid) => {
  const el = document.getElementById("combo-groups-lista-movil");
  if (!el) return;
  const comboGroups = getComboGroupsMovil(aid);
  
  const otherArticlesHTML = Object.entries(categoriasData)
    .sort(([, ca], [, cb]) => (ca.orden ?? 999) - (cb.orden ?? 999) || ca.nombre.localeCompare(cb.nombre, 'es'))
    .map(([catId, cat]) => {
      const catArts = Object.entries(cartaData)
        .filter(([itemId, item]) => item.catId === catId && itemId !== aid)
        .sort(([, artA], [, artB]) => (artA.orden || 0) - (artB.orden || 0) || artA.nombre.localeCompare(artB.nombre, 'es'));
      if (!catArts.length) return '';
      return `<optgroup label="${cat.nombre}">
        ${catArts.map(([itemId, item]) => `<option value="${itemId}">${item.nombre} (${Number(item.precio).toFixed(2)} €)</option>`).join('')}
      </optgroup>`;
    }).join('');

  el.innerHTML = comboGroups.map((g, gIdx) => `
    <div style="background:var(--panel-light);border:1px solid var(--border);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;margin-bottom:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);padding-bottom:4px">
        <span style="font-weight:bold;font-size:12px;color:var(--text)">Grupo: ${g.nombre}</span>
        <button class="btn-close-drawer" onclick="window.eliminarGrupoComboMovil(${gIdx})" style="font-size:16px;color:var(--danger);background:none;border:none;cursor:pointer;">&times;</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px">
        ${(g.items || []).map((item, itemIdx) => {
          const subArt = cartaData[item.artId];
          const subArtNombre = subArt ? subArt.nombre : '[Artículo Eliminado]';
          return `
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:2px 0">
              <span>${subArtNombre} ${item.suplemento > 0 ? `<b style="color:var(--accent2)">+${Number(item.suplemento).toFixed(2)} €</b>` : '<span style="color:var(--text-dim)">Sin supl.</span>'}</span>
              <button class="btn-close-drawer" onclick="window.eliminarOpcionComboMovil(${gIdx}, ${itemIdx})" style="font-size:14px;color:var(--danger);background:none;border:none;cursor:pointer;">&times;</button>
            </div>
          `;
        }).join('')}
      </div>
      <div style="display:flex;gap:4px;margin-top:4px;align-items:center">
        <select id="combo-art-select-movil-${gIdx}" class="form-input" style="flex:1;font-size:11px;height:30px;padding:2px 6px;">
          <option value="">— Seleccionar artículo —</option>
          ${otherArticlesHTML}
        </select>
        <input type="number" id="combo-supl-input-movil-${gIdx}" placeholder="Supl. €" step="0.05" min="0" class="form-input" style="width:70px;font-size:11px;height:30px;padding:2px 6px;" />
        <button class="btn-edit-art" onclick="window.agregarOpcionComboMovil(${gIdx})" style="padding:0 8px;font-size:11px;height:30px;background:var(--accent);color:white;border-color:var(--accent);">+ Añadir</button>
      </div>
    </div>
  `).join('');
};

window.agregarGrupoComboMovil = async () => {
  const aid = document.getElementById("edit-art-id").value;
  const nombre = await showCustomPrompt("Nuevo Grupo", "Nombre del grupo (ej: Primeros, Segundos, Postres):");
  if (!nombre || !nombre.trim()) return;
  const groups = getComboGroupsMovil(aid);
  groups.push({ nombre: nombre.trim(), items: [] });
  const art = cartaData[aid];
  art.comboGroups = groups;
  updateEditComboGroupsListMovil(aid);
};

window.eliminarGrupoComboMovil = async (groupIdx) => {
  const aid = document.getElementById("edit-art-id").value;
  const seguro = await showCustomConfirm("Eliminar Grupo", "¿Deseas eliminar este grupo del combo?");
  if (!seguro) return;
  const groups = getComboGroupsMovil(aid).filter((_, idx) => idx !== groupIdx);
  const art = cartaData[aid];
  art.comboGroups = groups.length ? groups : null;
  updateEditComboGroupsListMovil(aid);
};

window.agregarOpcionComboMovil = (groupIdx) => {
  const aid = document.getElementById("edit-art-id").value;
  const selectEl = document.getElementById(`combo-art-select-movil-${groupIdx}`);
  const suplEl = document.getElementById(`combo-supl-input-movil-${groupIdx}`);
  if (!selectEl || !suplEl) return;
  const artId = selectEl.value;
  const suplemento = parseFloat(suplEl.value) || 0;
  if (!artId) { showToast("Elige un artículo"); return; }
  
  const groups = getComboGroupsMovil(aid);
  if (!groups[groupIdx]) return;
  groups[groupIdx].items.push({ artId, suplemento });
  
  const art = cartaData[aid];
  art.comboGroups = groups;
  updateEditComboGroupsListMovil(aid);
};

window.eliminarOpcionComboMovil = (groupIdx, itemIdx) => {
  const aid = document.getElementById("edit-art-id").value;
  const groups = getComboGroupsMovil(aid);
  if (!groups[groupIdx]) return;
  groups[groupIdx].items = groups[groupIdx].items.filter((_, idx) => idx !== itemIdx);
  
  const art = cartaData[aid];
  art.comboGroups = groups.length ? groups : null;
  updateEditComboGroupsListMovil(aid);
};

// --- GESTIÓN DE CATEGORÍAS EN DRAWER MÓVIL ---
window.abrirDrawerEditCat = (cid) => {
  const cat = categoriasData[cid];
  if (!cat) return;
  document.getElementById("edit-cat-id").value = cid;
  document.getElementById("edit-cat-nombre").value = cat.nombre || "";
  document.getElementById("edit-cat-notas").value = cat.notasPredefinidas || "";
  
  document.getElementById("new-cat-var-nombre").value = "";
  document.getElementById("new-cat-var-precio").value = "";
  
  renderVariantesCat(cat.variantes || []);
  
  document.getElementById("overlay-edit-cat").classList.add("open");
  document.getElementById("drawer-edit-cat").classList.add("open");
};

window.cerrarDrawerEditCat = () => {
  document.getElementById("overlay-edit-cat").classList.remove("open");
  document.getElementById("drawer-edit-cat").classList.remove("open");
};

function renderVariantesCat(variantes) {
  const list = document.getElementById("cat-variantes-list");
  list.innerHTML = "";
  if (variantes.length === 0) {
    list.innerHTML = `<div style="font-size:11px;color:var(--text-dim);text-align:center;">Sin variantes configuradas.</div>`;
    return;
  }
  variantes.forEach((v, idx) => {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.background = "var(--panel-light)";
    row.style.padding = "6px 10px";
    row.style.borderRadius = "6px";
    row.style.fontSize = "12px";
    row.innerHTML = `
      <span>${v.nombre} (${Number(v.precio || 0) >= 0 ? "+" : ""}${Number(v.precio || 0).toFixed(2)} €)</span>
      <button class="btn-close-drawer" style="font-size:16px;color:var(--danger);background:none;border:none;cursor:pointer;" onclick="window.eliminarVarianteCategoria(${idx})">&times;</button>
    `;
    list.appendChild(row);
  });
}

window.agregarVarianteCategoria = () => {
  const nom = document.getElementById("new-cat-var-nombre").value.trim();
  const pre = parseFloat(document.getElementById("new-cat-var-precio").value) || 0;
  if (!nom) return;
  const cid = document.getElementById("edit-cat-id").value;
  const cat = categoriasData[cid];
  if (!cat) return;
  const vars = cat.variantes || [];
  vars.push({ nombre: nom, precio: pre });
  cat.variantes = vars;
  document.getElementById("new-cat-var-nombre").value = "";
  document.getElementById("new-cat-var-precio").value = "";
  renderVariantesCat(vars);
};

window.eliminarVarianteCategoria = (idx) => {
  const cid = document.getElementById("edit-cat-id").value;
  const cat = categoriasData[cid];
  if (!cat) return;
  const vars = cat.variantes || [];
  vars.splice(idx, 1);
  cat.variantes = vars;
  renderVariantesCat(vars);
};

window.guardarCategoriaCarta = () => {
  const cid = document.getElementById("edit-cat-id").value;
  const name = document.getElementById("edit-cat-nombre").value.trim();
  const notes = document.getElementById("edit-cat-notas").value.trim() || null;
  if (!name) return;
  const cat = categoriasData[cid];
  const nextCat = {
    nombre: name,
    orden: cat.orden || 1,
    notasPredefinidas: notes,
    variantes: cat.variantes || null
  };
  set(ref(db, `categorias/${cid}`), nextCat).then(() => {
    cerrarDrawerEditCat();
    showToast("Categoría actualizada.");
  });
};

window.eliminarCategoriaCarta = async () => {
  const cid = document.getElementById("edit-cat-id").value;
  const cat = categoriasData[cid];
  if (!cat) return;
  const seguro = await showCustomConfirm("Eliminar Categoría", `¿Seguro que deseas eliminar la categoría "${cat.nombre}" y todos sus artículos?`);
  if (!seguro) return;
  
  const arts = Object.entries(cartaData).filter(([, a]) => a.catId === cid);
  const promises = arts.map(([aid]) => remove(ref(db, `carta/${aid}`)));
  promises.push(remove(ref(db, `categorias/${cid}`)));
  Promise.all(promises).then(() => {
    cerrarDrawerEditCat();
    showToast("Categoría eliminada.");
  });
};

window.guardarArticuloCarta = () => {
  const aid = document.getElementById("edit-art-id").value;
  const cid = document.getElementById("edit-art-cat-id").value;
  const name = document.getElementById("edit-art-nombre").value.trim();
  const price = parseFloat(document.getElementById("edit-art-precio").value) || 0;
  const dest = document.getElementById("edit-art-destino").value;
  const active = document.getElementById("edit-art-activo").checked;
  const notes = document.getElementById("edit-art-notas").value.trim() || null;
  const esCombo = document.getElementById("edit-art-escombo").checked;

  if (!name) return;

  const art = cartaData[aid];
  const nextArt = {
    catId: cid,
    nombre: name,
    precio: price,
    destino: dest,
    disponible: active,
    notasPredefinidas: notes,
    variantes: art.variantes || null,
    esCombo: esCombo,
    comboGroups: esCombo ? (art.comboGroups || null) : null
  };

  set(ref(db, `carta/${aid}`), nextArt).then(() => {
    cerrarDrawerEditArt();
    showToast("Artículo actualizado.");
  });
};

window.eliminarArticuloCarta = async () => {
  const aid = document.getElementById("edit-art-id").value;
  const art = cartaData[aid];
  if (!art) return;

  const seguro = await showCustomConfirm("Eliminar Artículo", `¿Seguro que deseas eliminar "${art.nombre}"?`);
  if (!seguro) return;

  remove(ref(db, `carta/${aid}`)).then(() => {
    cerrarDrawerEditArt();
    showToast("Artículo eliminado.");
  });
};

// --- CONSULTA VENTAS (BAJO DEMANDA) ---
window.cargarVentasBajoDemanda = async () => {
  const desdeStr = document.getElementById("venta-desde").value;
  const hastaStr = document.getElementById("venta-hasta").value;
  if (!desdeStr || !hastaStr) return;

  const dStart = new Date(`${desdeStr}T00:00:00`).getTime();
  const dEnd = new Date(`${hastaStr}T23:59:59`).getTime();

  showToast("Cargando ventas...");

  try {
    const q = query(ref(db, "historial"), orderByChild("ts"), startAt(dStart), endAt(dEnd));
    const snap = await get(q);
    const data = snap.val() || {};
    const tickets = Object.values(data);

    renderResumenVentas(tickets);
  } catch (err) {
    showToast("Error al obtener ventas.");
  }
};

function renderResumenVentas(tickets) {
  const resumenBox = document.getElementById("ventas-resumen");
  const listado = document.getElementById("ventas-listado");
  resumenBox.style.display = "grid";
  listado.innerHTML = "";

  if (tickets.length === 0) {
    document.getElementById("stat-total").textContent = "0.00 €";
    document.getElementById("stat-tickets").textContent = "0";
    document.getElementById("stat-efectivo").textContent = "0.00 €";
    document.getElementById("stat-tarjeta").textContent = "0.00 €";
    listado.innerHTML = `<div class="plano-sinubicar" style="text-align:center;padding:24px;">No hay ventas registradas en el rango de fechas.</div>`;
    return;
  }

  const count = tickets.length;
  const total = tickets.reduce((s, t) => s + Number(t.total || 0), 0);
  const efectivo = tickets.filter(t => (t.pagoMetodo || '').toLowerCase() === 'efectivo' || (t.cobro && !t.pagoMetodo)).reduce((s, t) => s + Number(t.total || 0), 0);
  const tarjeta = tickets.filter(t => (t.pagoMetodo || '').toLowerCase() === 'tarjeta').reduce((s, t) => s + Number(t.total || 0), 0);

  document.getElementById("stat-total").textContent = `${total.toFixed(2)} €`;
  document.getElementById("stat-tickets").textContent = count;
  document.getElementById("stat-efectivo").textContent = `${efectivo.toFixed(2)} €`;
  document.getElementById("stat-tarjeta").textContent = `${tarjeta.toFixed(2)} €`;

  tickets.sort((a,b) => b.ts - a.ts).forEach((t, idx) => {
    const item = document.createElement("div");
    item.className = "ticket-item";
    
    const timeStr = new Date(t.ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const dateStr = new Date(t.ts).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    const pag = t.pagoMetodo ? t.pagoMetodo : "Efectivo";

    item.innerHTML = `
      <div class="ticket-item-header">
        <div style="display:flex;flex-direction:column;gap:2px;">
          <span style="font-weight:600;">Mesa: ${t.mesa || 'Desconocida'}</span>
          <span class="ticket-time">${dateStr} a las ${timeStr} · ${pag}</span>
        </div>
        <span class="ticket-total">${Number(t.total || 0).toFixed(2)} €</span>
      </div>
      <div class="ticket-details" id="t-det-${idx}">
        <!-- Detalles cargados dinámicamente -->
      </div>
    `;

    item.onclick = () => {
      const det = document.getElementById(`t-det-${idx}`);
      const isAct = item.classList.contains("active");
      
      // Cerrar otros
      document.querySelectorAll(".ticket-item").forEach(el => el.classList.remove("active"));
      
      if (!isAct) {
        item.classList.add("active");
        
        // Cargar desglose de artículos
        let linesHTML = "";
        (t.lineas || []).forEach(l => {
          linesHTML += `
            <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12px;">
              <span>${l.qty}x ${l.nombre} ${l.nota ? `(${l.nota})` : ''}</span>
              <span>${(l.qty * Number(l.precio || 0)).toFixed(2)} €</span>
            </div>
          `;
        });
        det.innerHTML = linesHTML || "Sin artículos registrados.";
      }
    };

    listado.appendChild(item);
  });
}

// --- CONSULTA AUDITORÍA (BAJO DEMANDA) ---
window.cargarAuditoriaBajoDemanda = async () => {
  const fechaVal = document.getElementById("audit-fecha").value;
  const textoFiltro = document.getElementById("audit-filtro-texto").value.toLowerCase().trim();
  if (!fechaVal) return;

  const listado = document.getElementById("auditoria-listado");
  listado.innerHTML = "";
  showToast("Cargando logs...");

  try {
    const snap = await get(ref(db, `auditoria/${fechaVal}`));
    const logs = snap.val() || {};
    const filtered = Object.values(logs).filter(l => {
      if (!textoFiltro) return true;
      return (
        String(l.accion || '').toLowerCase().includes(textoFiltro) ||
        String(l.detalle || '').toLowerCase().includes(textoFiltro) ||
        String(l.camarero || '').toLowerCase().includes(textoFiltro)
      );
    });

    renderAuditoria(filtered);
  } catch (err) {
    showToast("Error al obtener logs.");
  }
};

function renderAuditoria(logs) {
  const listado = document.getElementById("auditoria-listado");
  listado.innerHTML = "";

  if (logs.length === 0) {
    listado.innerHTML = `<div class="plano-sinubicar" style="text-align:center;padding:24px;">No hay registros de auditoría en la fecha o con el texto seleccionado.</div>`;
    return;
  }

  logs.sort((a,b) => b.ts - a.ts).forEach(l => {
    const item = document.createElement("div");
    
    // Asignar clase de estilo según tipo de acción
    let actClass = "";
    let isBlock = l.accion === 'login_bloqueado' || String(l.accion).includes('bloqueado');
    let isIncorrect = String(l.accion).includes('incorrecto') || String(l.accion).includes('fallido');
    
    if (isBlock) {
      actClass = "login_bloqueado";
    } else if (isIncorrect) {
      actClass = "login_incorrecto";
    } else if (String(l.accion).includes("login")) {
      actClass = "login";
    } else if (String(l.accion).includes("mesa_cerrada")) {
      actClass = "mesa_cerrada";
    } else if (String(l.accion).includes("articulo_eliminado")) {
      actClass = "articulo_eliminado";
    } else if (String(l.accion).includes("descuento_aplicado")) {
      actClass = "descuento_aplicado";
    }

    item.className = `timeline-item ${actClass}`;
    
    // Detectar inicio de sesión a horas inusuales (2:00 AM - 8:00 AM)
    let alertHora = "";
    if (String(l.accion).includes("login")) {
      let hh = -1;
      if (l.hora) {
        hh = parseInt(l.hora.split(":")[0], 10);
      } else if (l.ts) {
        hh = new Date(Number(l.ts)).getHours();
      }
      if (hh >= 2 && hh < 8) {
        alertHora = ' <span title="¡Hora inusual (2am-8am)!" style="color:var(--danger);font-weight:bold;margin-left:4px">⚠️</span>';
      }
    }

    const labelTxt = l.accion + (isBlock ? ' ❗' : '');
    
    item.innerHTML = `
      <div class="timeline-header">
        <span class="timeline-time">${l.hora || '00:00:00'}${alertHora}</span>
        <span class="timeline-user">${l.camarero || 'Desconocido'}</span>
      </div>
      <div class="timeline-action">${labelTxt}</div>
      <div class="timeline-desc">${l.detalle || ''}</div>
    `;
    listado.appendChild(item);
  });
}

// --- CIERRE DE CAJA ---
window.confirmarCierreCaja = async () => {
  const confirmacion = await showCustomConfirm("Cierre de Caja", "¿Deseas realizar el cierre de caja diario?\n\nEsto cobrará y archivará todas las mesas abiertas y enviará el reporte a la impresora.");
  if (!confirmacion) return;

  showToast("Procesando cierre...");

  try {
    // 1. Cerrar mesas abiertas
    const cierre = await cerrarMesasAbiertasParaTurno();
    
    // 2. Generar resumen del día
    const ahora = new Date();
    const inicioDia = new Date(ahora);
    if (ahora.getHours() < 5) {
      inicioDia.setDate(ahora.getDate() - 1);
    }
    inicioDia.setHours(5, 0, 0, 0);
    
    const startTs = inicioDia.getTime();
    const endTs = ahora.getTime();

    const q = query(ref(db, "historial"), orderByChild("ts"), startAt(startTs), endAt(endTs));
    const snapHistorial = await get(q);
    const tickets = Object.values(snapHistorial.val() || {});
    
    let total = 0;
    let efectivo = 0;
    let tarjeta = 0;
    const articulosMap = {};

    tickets.forEach(t => {
      const val = Number(t.total || 0);
      total += val;
      if ((t.pagoMetodo || '').toLowerCase() === 'tarjeta') {
        tarjeta += val;
      } else {
        efectivo += val;
      }

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

    const articulos = Object.values(articulosMap).sort((a,b) => b.qty - a.qty);
    const ticketsCount = tickets.length;
    const ticketMedio = ticketsCount ? total / ticketsCount : 0;

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

    // 3. Crear Job de Impresión en print_jobs
    const localSnap = await get(ref(db, "config/local"));
    const loc = localSnap.val() || {};
    
    const jobContent = buildCierreCajaHtml(loc.nombre || "COMANDERO", resumenDia);
    const printJob = {
      ts: Date.now(),
      type: 'ticket',
      content: jobContent,
      status: 'pending',
      printerName: 'caja',
      requestedBy: 'gerente-cierre',
      mesaId: 'cierre',
      mesaNombre: 'CIERRE DIARIO',
      silent: true,
      options: {
        footer: 'Fin de Cierre de Caja',
        header: 'CIERRE DIARIO'
      }
    };

    await push(ref(db, "print_jobs"), printJob);
    
    // Registrar en auditoría
    logAuditoria('cierre_caja', `Cierre realizado. Total: ${total.toFixed(2)}€ (${cierre.mesasCerradas} mesas archivadas).`);

    showToast("✓ Cierre finalizado y enviado a la impresora.");
    
    // Recargar plano
    renderPlano();

  } catch (err) {
    console.error(err);
    showToast("Error al realizar el cierre de caja.");
  }
};

window.cierreDiaPasado = async () => {
  const dateVal = document.getElementById("cierre-fecha-pasada").value;
  if (!dateVal) {
    showCustomAlert("Cierre Pasado", "Por favor, selecciona una fecha.");
    return;
  }
  const parts = dateVal.split("-");
  const year = parseInt(parts[0]);
  const month = parseInt(parts[1]) - 1;
  const day = parseInt(parts[2]);
  
  const startDia = new Date(year, month, day, 5, 0, 0, 0);
  const endDia = new Date(year, month, day + 1, 5, 0, 0, 0);
  
  const startTs = startDia.getTime();
  const endTs = endDia.getTime();

  showToast("Buscando historial...");

  try {
    const q = query(ref(db, "historial"), orderByChild("ts"), startAt(startTs), endAt(endTs));
    const snapHistorial = await get(q);
    
    if (!snapHistorial.exists()) {
      showCustomAlert("Cierre Pasado", `No se encontraron tickets en el historial para la fecha ${parts[2]}/${parts[1]}/${parts[0]}.`);
      return;
    }

    const tickets = Object.values(snapHistorial.val() || {});
    let total = 0;
    let efectivo = 0;
    let tarjeta = 0;
    const articulosMap = {};

    tickets.forEach(t => {
      const val = Number(t.total || 0);
      total += val;
      if ((t.pagoMetodo || '').toLowerCase() === 'tarjeta') {
        tarjeta += val;
      } else {
        efectivo += val;
      }

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

    const articles = Object.values(articulosMap).sort((a,b) => b.qty - a.qty);
    const ticketsCount = tickets.length;
    const ticketMedio = ticketsCount ? total / ticketsCount : 0;

    const resumenDia = {
      startTs,
      endTs,
      ticketsCount,
      total,
      efectivo,
      tarjeta,
      ticketMedio,
      articulos: articles
    };

    const localSnap = await get(ref(db, "config/local"));
    const loc = localSnap.val() || {};
    const fechaCierreTxt = `${parts[2]}/${parts[1]}/${parts[0]}`;
    
    const jobContent = buildCierreCajaPasadoHtml(loc.nombre || "COMANDERO", resumenDia, fechaCierreTxt);
    const printJob = {
      ts: Date.now(),
      type: 'ticket',
      content: jobContent,
      status: 'pending',
      printerName: 'caja',
      requestedBy: 'gerente-cierre-pasado',
      mesaId: 'cierre_pasado',
      mesaNombre: 'REIMPRESION CIERRE',
      silent: true,
      options: {
        footer: 'Fin de Reimpresión de Cierre',
        header: 'REIMPRESION CIERRE'
      }
    };

    await push(ref(db, "print_jobs"), printJob);
    
    logAuditoria('cierre_caja_reimpresion', `Cierre del ${fechaCierreTxt} reimpreso. Total: ${total.toFixed(2)}€`);
    showCustomAlert("Cierre Reimpreso", `✓ Cierre del día ${fechaCierreTxt} generado y enviado a la impresora.`);
  } catch (err) {
    console.error(err);
    showToast("Error al generar el cierre del día pasado.");
  }
};

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
    if (mesaId.startsWith('temp_')) {
      await remove(ref(db, `mesas/${mesaId}`));
    } else {
      await set(ref(db, `mesas/${mesaId}/estado`), 'libre');
    }
    mesasCerradas += 1;
  }

  return { mesasCerradas, ticketsGenerados };
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
      : Number(l.qty || 0);
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

function buildCierreCajaPasadoHtml(localNombre, resumenDia, fechaCierreTxt) {
  let artsHtml = (resumenDia.articulos || []).map(a => `
    <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:2px">
      <span>${a.qty}x ${a.nombre}</span>
      <span style="font-family:monospace">${a.total.toFixed(2)} €</span>
    </div>
  `).join('');

  return `
    <div style="font-family:sans-serif;width:280px;margin:0 auto;color:#000;background:#fff;padding:10px">
      <div style="text-align:center;font-weight:bold;font-size:14px;margin-bottom:4px">${localNombre}</div>
      <div style="text-align:center;font-size:9px;margin-bottom:10px;color:#d97706;font-weight:bold;">*** REIMPRESIÓN CIERRE PASADO ***</div>
      <div style="font-size:10px;margin-bottom:6px">Fecha del Cierre: ${fechaCierreTxt}</div>
      <div style="font-size:9px;margin-bottom:6px;color:#555;">Reimpreso el: ${new Date().toLocaleDateString('es-ES')} ${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div>
      <div style="border-bottom:1px solid #000;margin-bottom:6px"></div>
      <div style="font-size:11px;font-weight:bold;margin-bottom:6px;display:flex;justify-content:space-between">
        <span>TOTAL FACTURADO:</span>
        <span>${resumenDia.total.toFixed(2)} €</span>
      </div>
      <div style="font-size:10px;margin-bottom:4px;display:flex;justify-content:space-between">
        <span>Efectivo:</span>
        <span>${resumenDia.efectivo.toFixed(2)} €</span>
      </div>
      <div style="font-size:10px;margin-bottom:6px;display:flex;justify-content:space-between">
        <span>Tarjeta:</span>
        <span>${resumenDia.tarjeta.toFixed(2)} €</span>
      </div>
      <div style="font-size:10px;margin-bottom:10px;display:flex;justify-content:space-between">
        <span>Nº Tickets / Medio:</span>
        <span>${resumenDia.ticketsCount} / ${resumenDia.ticketMedio.toFixed(2)} €</span>
      </div>
      <div style="border-bottom:1px solid #000;margin-bottom:8px"></div>
      <div style="font-size:10px;font-weight:bold;margin-bottom:6px;text-align:center">DESGLOSE DE ARTÍCULOS</div>
      ${artsHtml}
      <div style="border-bottom:1px solid #000;margin-top:8px;margin-bottom:8px"></div>
      <div style="text-align:center;font-size:9px;color:#666">Fin de Reimpresión de Cierre</div>
    </div>
  `;
}

function buildCierreCajaHtml(localNombre, resumenDia) {
  const dateStr = new Date().toLocaleDateString('es-ES');
  const timeStr = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  
  let artsHtml = (resumenDia.articulos || []).map(a => `
    <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:2px">
      <span>${a.qty}x ${a.nombre}</span>
      <span style="font-family:monospace">${a.total.toFixed(2)} €</span>
    </div>
  `).join('');

  return `
    <div style="font-family:sans-serif;width:280px;margin:0 auto;color:#000;background:#fff;padding:10px">
      <div style="text-align:center;font-weight:bold;font-size:14px;margin-bottom:4px">${localNombre}</div>
      <div style="text-align:center;font-size:9px;margin-bottom:10px">CIERRE DE CAJA DIARIO</div>
      <div style="font-size:10px;margin-bottom:6px">Fecha: ${dateStr} ${timeStr}</div>
      <div style="border-bottom:1px solid #000;margin-bottom:6px"></div>
      <div style="font-size:11px;font-weight:bold;margin-bottom:6px;display:flex;justify-content:space-between">
        <span>TOTAL FACTURADO:</span>
        <span>${resumenDia.total.toFixed(2)} €</span>
      </div>
      <div style="font-size:10px;margin-bottom:4px;display:flex;justify-content:space-between">
        <span>Efectivo:</span>
        <span>${resumenDia.efectivo.toFixed(2)} €</span>
      </div>
      <div style="font-size:10px;margin-bottom:6px;display:flex;justify-content:space-between">
        <span>Tarjeta:</span>
        <span>${resumenDia.tarjeta.toFixed(2)} €</span>
      </div>
      <div style="font-size:10px;margin-bottom:10px;display:flex;justify-content:space-between">
        <span>Nº Tickets / Medio:</span>
        <span>${resumenDia.ticketsCount} / ${resumenDia.ticketMedio.toFixed(2)} €</span>
      </div>
      <div style="border-bottom:1px solid #000;margin-bottom:8px"></div>
      <div style="font-size:10px;font-weight:bold;margin-bottom:6px;text-align:center">DESGLOSE DE ARTÍCULOS</div>
      ${artsHtml}
      <div style="border-bottom:1px solid #000;margin-top:8px;margin-bottom:8px"></div>
      <div style="text-align:center;font-size:9px;color:#666">Fin de Cierre de Caja</div>
    </div>
  `;
}

// --- MODALES PERSONALIZADOS ---
let currentModalResolve = null;

function ocultarCustomModal() {
  const overlay = document.getElementById("overlay-custom-modal");
  const modal = document.getElementById("custom-modal");
  overlay.classList.remove("open");
  modal.style.transform = "translate(-50%, -50%) scale(0.9)";
  modal.style.opacity = "0";
  setTimeout(() => {
    modal.style.display = "none";
  }, 200);
}

window.cerrarCustomModal = () => {
  ocultarCustomModal();
  if (currentModalResolve) {
    currentModalResolve(null);
    currentModalResolve = null;
  }
};

function mostrarCustomModal(titulo, mensaje, tipo, defaultValue = "") {
  return new Promise((resolve) => {
    if (currentModalResolve) {
      currentModalResolve(null);
    }
    currentModalResolve = resolve;

    const overlay = document.getElementById("overlay-custom-modal");
    const modal = document.getElementById("custom-modal");
    const titleEl = document.getElementById("custom-modal-title");
    const msgEl = document.getElementById("custom-modal-message");
    const inputEl = document.getElementById("custom-modal-input");
    const btnCancel = document.getElementById("custom-modal-btn-cancel");
    const btnOk = document.getElementById("custom-modal-btn-ok");

    titleEl.textContent = titulo;
    msgEl.textContent = mensaje;

    if (tipo === "prompt") {
      inputEl.style.display = "block";
      inputEl.value = defaultValue;
    } else {
      inputEl.style.display = "none";
    }

    if (tipo === "alert") {
      btnCancel.style.display = "none";
    } else {
      btnCancel.style.display = "block";
    }

    overlay.classList.add("open");
    modal.style.display = "flex";
    modal.style.opacity = "0";
    modal.style.transform = "translate(-50%, -50%) scale(0.9)";
    
    // Forzar reflow
    modal.offsetHeight;

    setTimeout(() => {
      modal.style.opacity = "1";
      modal.style.transform = "translate(-50%, -50%) scale(1)";
      if (tipo === "prompt") {
        inputEl.focus();
        inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      }
    }, 10);

    btnOk.onclick = () => {
      const value = tipo === "prompt" ? inputEl.value : true;
      ocultarCustomModal();
      currentModalResolve = null;
      resolve(value);
    };

    btnCancel.onclick = () => {
      ocultarCustomModal();
      currentModalResolve = null;
      resolve(tipo === "prompt" ? null : false);
    };

    inputEl.onkeydown = (e) => {
      if (e.key === "Enter") {
        btnOk.click();
      }
    };
  });
}

function showCustomAlert(titulo, mensaje) {
  return mostrarCustomModal(titulo, mensaje, "alert");
}

function showCustomConfirm(titulo, mensaje) {
  return mostrarCustomModal(titulo, mensaje, "confirm");
}

function showCustomPrompt(titulo, mensaje, defaultValue = "") {
  return mostrarCustomModal(titulo, mensaje, "prompt", defaultValue);
}

// --- UTILERÍAS ---
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}

// --- GESTIÓN DE SEGURIDAD Y CAMAREROS (GERENCIA MÓVIL) ---
let selectedEmojisMovil = [];
const EMOJI_LIST = ['🍔', '🍺', '🍕', '🍷', '☕', '🍰', '🍦', '🍟', '🌮', '🥗'];

function actualizarAjustesSeguridadMovil() {
  const switchBloqueo = document.getElementById("switch-bloqueo-camareros-movil");
  if (switchBloqueo) {
    switchBloqueo.checked = seguridadData.bloqueoCamareros === true;
  }
  poblarExcepcionCamareroSelectorMovil();

  const switchEmojis = document.getElementById('switch-emojis-activo-movil');
  if (switchEmojis) switchEmojis.checked = seguridadData.emojisActivo === true;
  
  // Emojis de acceso global
  const emojisStr = seguridadData.emojisAcceso || "";
  selectedEmojisMovil = emojisStr ? Array.from(emojisStr) : [];
  actualizarPreviewEmojisMovil();
  renderEmojiPickerMovil();

  // Geolocalización
  const switchGeo = document.getElementById('switch-geo-activo-movil');
  if (switchGeo) switchGeo.checked = seguridadData.geoActivo === true;
  const geoLatEl = document.getElementById('config-geo-lat-movil');
  if (geoLatEl) geoLatEl.value = seguridadData.geoLat != null ? seguridadData.geoLat : '';
  const geoLngEl = document.getElementById('config-geo-lng-movil');
  if (geoLngEl) geoLngEl.value = seguridadData.geoLng != null ? seguridadData.geoLng : '';
  const geoRadioEl = document.getElementById('config-geo-radio-movil');
  if (geoRadioEl) geoRadioEl.value = seguridadData.geoRadio || '';
  const geoIntervaloEl = document.getElementById('config-geo-intervalo-movil');
  if (geoIntervaloEl) geoIntervaloEl.value = String(seguridadData.geoIntervaloHoras || 3);

  // Encargado
  const switchEncargadoMovil = document.getElementById("switch-encargado-activo-movil");
  if (switchEncargadoMovil) {
    switchEncargadoMovil.checked = seguridadData.encargadoAccesible === true;
  }
  const passEncargadoMovil = document.getElementById("config-encargado-pass-movil");
  if (passEncargadoMovil) {
    passEncargadoMovil.value = seguridadData.encargadoPassword || "encargado1234";
  }
}

function poblarExcepcionCamareroSelectorMovil() {
  const select = document.getElementById("select-camarero-excepcion-movil");
  if (!select) return;
  const currentVal = seguridadData.excepcionCamarero || "";
  select.innerHTML = '<option value="">(Ninguno)</option>';
  Object.entries(usuariosData || {}).forEach(([id, u]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = u.nombre;
    select.appendChild(option);
  });
  select.value = currentVal;
}

async function toggleBloqueoCamarerosGlobal() {
  if (!db) return;
  const switchBloqueo = document.getElementById("switch-bloqueo-camareros-movil");
  const isChecked = switchBloqueo.checked;
  try {
    await update(ref(db, "config/seguridad"), {
      bloqueoCamareros: isChecked,
      updatedAt: Date.now()
    });
    console.log("Bloqueo total de camareros actualizado:", isChecked);
  } catch (error) {
    showCustomAlert("Seguridad", "Error al actualizar el bloqueo de camareros.");
    switchBloqueo.checked = !isChecked; // Deshacer
  }
}

async function actualizarExcepcionCamarero() {
  if (!db) return;
  const select = document.getElementById("select-camarero-excepcion-movil");
  const val = select.value;
  try {
    await update(ref(db, "config/seguridad"), {
      excepcionCamarero: val,
      updatedAt: Date.now()
    });
    console.log("Excepción de camarero actualizada:", val);
  } catch (error) {
    showCustomAlert("Seguridad", "Error al guardar la excepción.");
  }
}

async function guardarEstadoEncargadoMovil() {
  if (!db) return;
  const switchEncargado = document.getElementById("switch-encargado-activo-movil");
  const isChecked = switchEncargado.checked;
  try {
    await update(ref(db, "config/seguridad"), {
      encargadoAccesible: isChecked,
      updatedAt: Date.now()
    });
    console.log("Acceso de encargado actualizado:", isChecked);
  } catch (error) {
    showCustomAlert("Seguridad", "Error al actualizar el acceso de encargado.");
    switchEncargado.checked = !isChecked; // Deshacer
  }
}

async function guardarPassEncargadoMovil() {
  if (!db) return;
  const val = document.getElementById("config-encargado-pass-movil").value.trim();
  if (!val) {
    showCustomAlert("Seguridad", "La contraseña no puede estar vacía.");
    return;
  }
  try {
    await update(ref(db, "config/seguridad"), {
      encargadoPassword: val,
      updatedAt: Date.now()
    });
    showCustomAlert("Seguridad", "Contraseña de encargado guardada correctamente.");
  } catch (error) {
    showCustomAlert("Seguridad", "Error al guardar la contraseña de encargado.");
  }
}

function renderEmojiPickerMovil() {
  const container = document.querySelector('.movil-emoji-picker');
  if (!container) return;
  container.innerHTML = EMOJI_LIST.map(emoji => `
    <button type="button" onclick="window.seleccionarEmojiMovil('${emoji}')" style="font-size: 16px; padding: 6px 0; background: var(--panel-light); border: 1px solid var(--border); color: var(--text); border-radius: 4px; cursor: pointer;">${emoji}</button>
  `).join('');
}

function seleccionarEmojiMovil(emoji) {
  if (selectedEmojisMovil.length >= 3) return;
  selectedEmojisMovil.push(emoji);
  actualizarPreviewEmojisMovil();
}

function limpiarEmojisMovil() {
  selectedEmojisMovil = [];
  actualizarPreviewEmojisMovil();
}

function actualizarPreviewEmojisMovil() {
  const preview = document.getElementById("movil-emojis-preview");
  if (!preview) return;
  const display = [];
  for (let i = 0; i < 3; i++) {
    display.push(selectedEmojisMovil[i] || '❓');
  }
  preview.textContent = display.join(' ');
}

async function guardarEmojisMovil() {
  if (!db) return;
  if (selectedEmojisMovil.length < 3 && selectedEmojisMovil.length > 0) {
    showCustomAlert("Emojis", "La combinación debe tener exactamente 3 emojis, o estar vacía (para desactivar el reto).");
    return;
  }
  const val = selectedEmojisMovil.join('');
  try {
    await update(ref(db, "config/seguridad"), {
      emojisAcceso: val,
      updatedAt: Date.now()
    });
    showCustomAlert("Emojis", "Combinación de emojis de acceso guardada con éxito.");
  } catch (error) {
    showCustomAlert("Emojis", "Error al actualizar la combinación de emojis.");
  }
}

async function guardarEstadoEmojisMovil() {
  if (!db) return;
  const isChecked = document.getElementById('switch-emojis-activo-movil').checked;
  try {
    await update(ref(db, 'config/seguridad'), { emojisActivo: isChecked, updatedAt: Date.now() });
    showCustomAlert('Emojis', 'Verificación por emojis ' + (isChecked ? 'activada' : 'desactivada') + '.');
  } catch (error) {
    showCustomAlert('Emojis', 'Error al actualizar la verificación por emojis.');
    document.getElementById('switch-emojis-activo-movil').checked = !isChecked;
  }
}
window.guardarEstadoEmojisMovil = guardarEstadoEmojisMovil;

async function guardarEstadoGeoMovil() {
  if (!db) return;
  const isChecked = document.getElementById('switch-geo-activo-movil').checked;
  try {
    await update(ref(db, 'config/seguridad'), { geoActivo: isChecked, updatedAt: Date.now() });
    showCustomAlert('GPS', 'Restricción por GPS ' + (isChecked ? 'activada' : 'desactivada') + '.');
  } catch (error) {
    showCustomAlert('GPS', 'Error al actualizar la restricción GPS.');
    document.getElementById('switch-geo-activo-movil').checked = !isChecked;
  }
}
window.guardarEstadoGeoMovil = guardarEstadoGeoMovil;

function usarUbicacionActualMovil() {
  if (!navigator.geolocation) { showCustomAlert('GPS', 'Tu navegador no soporta geolocalización.'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    document.getElementById('config-geo-lat-movil').value = pos.coords.latitude.toFixed(6);
    document.getElementById('config-geo-lng-movil').value = pos.coords.longitude.toFixed(6);
    showCustomAlert('GPS', `Ubicación capturada: ${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`);
  }, err => {
    showCustomAlert('GPS', 'Error al obtener ubicación: ' + err.message);
  }, { enableHighAccuracy: true, timeout: 10000 });
}
window.usarUbicacionActualMovil = usarUbicacionActualMovil;

function calcularRadioDesdeLimiteMovil() {
  const latCenter = parseFloat(document.getElementById('config-geo-lat-movil').value);
  const lngCenter = parseFloat(document.getElementById('config-geo-lng-movil').value);
  if (isNaN(latCenter) || isNaN(lngCenter)) {
    showCustomAlert('GPS', 'Primero configura el centro del local con "Usar esta ubicación".');
    return;
  }
  if (!navigator.geolocation) { showCustomAlert('GPS', 'Tu navegador no soporta geolocalización.'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(pos.coords.latitude - latCenter);
    const dLon = toRad(pos.coords.longitude - lngCenter);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(latCenter)) * Math.cos(toRad(pos.coords.latitude)) * Math.sin(dLon/2)**2;
    const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const radio = Math.max(50, Math.ceil(dist));
    document.getElementById('config-geo-radio-movil').value = radio;
    showCustomAlert('GPS', `Distancia: ${Math.round(dist)}m → Radio: ${radio}m`);
  }, err => {
    showCustomAlert('GPS', 'Error al obtener ubicación: ' + err.message);
  }, { enableHighAccuracy: true, timeout: 10000 });
}
window.calcularRadioDesdeLimiteMovil = calcularRadioDesdeLimiteMovil;

async function guardarUbicacionMovil() {
  if (!db) return;
  const lat = parseFloat(document.getElementById('config-geo-lat-movil').value);
  const lng = parseFloat(document.getElementById('config-geo-lng-movil').value);
  const radio = parseInt(document.getElementById('config-geo-radio-movil').value) || 100;
  const intervalo = parseInt(document.getElementById('config-geo-intervalo-movil').value) || 3;
  if (isNaN(lat) || isNaN(lng)) {
    showCustomAlert('GPS', 'Coordenadas no válidas. Usa "Usar esta ubicación".');
    return;
  }
  if (radio < 1) { showCustomAlert('GPS', 'El radio mínimo es 1 metro.'); return; }
  try {
    await update(ref(db, 'config/seguridad'), {
      geoLat: lat, geoLng: lng, geoRadio: radio, geoIntervaloHoras: intervalo, updatedAt: Date.now()
    });
    showCustomAlert('GPS', 'Ubicación del local guardada con éxito.');
  } catch (error) {
    showCustomAlert('GPS', 'Error al guardar la ubicación.');
  }
}
window.guardarUbicacionMovil = guardarUbicacionMovil;

function renderCamarerosListado() {
  if (currentView !== 'camareros') return;
  const contenedor = document.getElementById("camareros-listado-movil");
  if (!contenedor) return;

  const entries = Object.entries(usuariosData || {});
  if (entries.length === 0) {
    contenedor.innerHTML = `<p style="font-size:13px;color:var(--text-dim);text-align:center;padding:20px;">Sin camareros registrados.</p>`;
    return;
  }

  contenedor.innerHTML = "";
  // Ordenar camareros por nombre
  entries.sort(([, a], [, b]) => a.nombre.localeCompare(b.nombre));

  entries.forEach(([id, u]) => {
    const card = document.createElement("div");
    card.style.background = "var(--panel-light)";
    card.style.border = "1px solid var(--border)";
    card.style.borderRadius = "8px";
    card.style.padding = "12px";
    card.style.display = "flex";
    card.style.justifyContent = "space-between";
    card.style.alignItems = "center";
    card.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
    
    const isActive = u.activo !== false;
    const tiempoRelativo = calcularTiempoRelativo(u.ultimoLogin);

    card.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 4px; flex: 1; padding-right: 12px;">
        <span style="font-weight: 600; font-size: 14px; color: var(--text);">${u.nombre}</span>
        <span style="font-size: 11px; color: var(--text-dim); display: flex; align-items: center; gap: 4px;">
          🕒 ${tiempoRelativo}
        </span>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <span style="font-size: 11px; color: ${isActive ? "var(--success)" : "var(--danger)"}; font-weight: 600; min-width: 55px; text-align: right;">
          ${isActive ? "ACTIVO" : "INACTIVO"}
        </span>
        <label class="switch" style="margin: 0; display: inline-block;">
          <input type="checkbox" ${isActive ? "checked" : ""} onchange="window.toggleCamareroActivoMovil('${id}', this.checked)">
          <span class="slider"></span>
        </label>
      </div>
    `;
    contenedor.appendChild(card);
  });
}

function calcularTiempoRelativo(timestamp) {
  if (!timestamp) return "Sin accesos registrados";
  const difMs = Date.now() - timestamp;
  const difSegundos = Math.floor(difMs / 1000);
  const difMinutos = Math.floor(difSegundos / 60);
  const difHoras = Math.floor(difMinutos / 60);
  const difDias = Math.floor(difHoras / 24);

  if (difSegundos < 60) return "Hace un momento";
  if (difMinutos < 60) return `Hace ${difMinutos} min`;
  if (difHoras < 24) {
    const minsRestantes = difMinutos % 60;
    if (minsRestantes === 0) return `Hace ${difHoras} h`;
    return `Hace ${difHoras} h ${minsRestantes} min`;
  }
  return `Hace ${difDias} día${difDias > 1 ? 's' : ''}`;
}

async function toggleCamareroActivoMovil(id, activo) {
  if (!db) return;
  try {
    await update(ref(db, `config/usuarios/${id}`), { activo });
    console.log(`Estado activo del camarero ${id} actualizado a:`, activo);
  } catch (error) {
    showCustomAlert("Camareros", "Error al cambiar el estado del camarero.");
  }
}

// Exponer funciones globales
window.toggleBloqueoCamarerosGlobal = toggleBloqueoCamarerosGlobal;
window.actualizarExcepcionCamarero = actualizarExcepcionCamarero;
window.seleccionarEmojiMovil = seleccionarEmojiMovil;
window.limpiarEmojisMovil = limpiarEmojisMovil;
window.guardarEmojisMovil = guardarEmojisMovil;
window.toggleCamareroActivoMovil = toggleCamareroActivoMovil;
window.guardarEstadoEncargadoMovil = guardarEstadoEncargadoMovil;
window.guardarPassEncargadoMovil = guardarPassEncargadoMovil;

window.abrirDrawerEditCat = abrirDrawerEditCat;
window.cerrarDrawerEditCat = cerrarDrawerEditCat;
window.agregarVarianteCategoria = agregarVarianteCategoria;
window.eliminarVarianteCategoria = eliminarVarianteCategoria;
window.guardarCategoriaCarta = guardarCategoriaCarta;
window.eliminarCategoriaCarta = eliminarCategoriaCarta;
window.toggleComboPanelMovil = toggleComboPanelMovil;
window.agregarGrupoComboMovil = agregarGrupoComboMovil;
window.eliminarGrupoComboMovil = eliminarGrupoComboMovil;
window.agregarOpcionComboMovil = agregarOpcionComboMovil;
window.eliminarOpcionComboMovil = eliminarOpcionComboMovil;

// Sobreescribir el alert nativo del navegador para usar nuestro modal personalizado en toda la página
window.alert = function(mensaje) {
  showCustomAlert("Mensaje", mensaje);
};

// Inicializar al cargar
init();
