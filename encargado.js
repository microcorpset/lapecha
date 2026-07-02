import { db } from './firebase.js';
import {
  ref, get, onValue, query, orderByChild, startAt, endAt,
  set as fbSet, push as fbPush, remove as fbRemove, update as fbUpdate
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// --- TOUCH MENU VERSION FOR OFFLINE CACHE SYNC ---
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
let categoriasData = {};
let cartaData = {};
let seguridadData = {};

const PIN_SESSION_KEY = "encargado_auth_session";

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
  // 1. Obtener la configuración de seguridad y contraseña en tiempo real
  onValue(ref(db, "config/seguridad"), (snap) => {
    seguridadData = snap.val() || {};
    passwordCorrecta = seguridadData.encargadoPassword ? String(seguridadData.encargadoPassword).trim() : "encargado1234";

    // Si ya estamos logueados pero de repente desactivan el acceso, forzar logout
    if (sessionStorage.getItem(PIN_SESSION_KEY) === "1" && seguridadData.encargadoAccesible === false) {
      cerrarSesion();
    }
  });

  // Esperar un instante para que Firebase cargue la seguridad inicial
  try {
    const snap = await get(ref(db, "config/seguridad"));
    const data = snap.val() || {};
    passwordCorrecta = data.encargadoPassword ? String(data.encargadoPassword).trim() : "encargado1234";
  } catch (err) {
    passwordCorrecta = "encargado1234";
  }

  // 2. Comprobar sesión existente
  if (sessionStorage.getItem(PIN_SESSION_KEY) === "1") {
    desbloquearPanel();
  } else {
    // Determinar si mostramos teclado numérico o teclado de texto alfanumérico
    const esNumerico4 = /^\d{4}$/.test(passwordCorrecta) || passwordCorrecta === "encargado1234";

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
  // Evitar duplicar listeners limpiando antes de asignar
  const pinPad = document.getElementById("pin-pad");
  pinPad.replaceWith(pinPad.cloneNode(true));
  
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
      verificarYEntrar();
    } else {
      pinErrorMsg.textContent = "Contraseña Incorrecta";
      inputTexto.value = "";
      setTimeout(() => {
        pinErrorMsg.textContent = "";
      }, 1500);
    }
  };

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
  const esCorrecto = (pinBuffer === passwordCorrecta) || (passwordCorrecta === "encargado1234" && pinBuffer === "1234");
  
  if (esCorrecto) {
    verificarYEntrar();
  } else {
    actualizarDots(true);
    pinErrorMsg.textContent = "PIN Incorrecto";
    setTimeout(() => {
      pinBuffer = "";
      actualizarDots();
      pinErrorMsg.textContent = "";
    }, 1000);
  }
}

async function verificarYEntrar() {
  // Comprobar si la página está accesible en Firebase
  try {
    const snap = await get(ref(db, "config/seguridad"));
    const data = snap.val() || {};
    if (data.encargadoAccesible === false) {
      pinErrorMsg.textContent = "Acceso desactivado por gerencia";
      pinBuffer = "";
      actualizarDots();
      return;
    }
  } catch (e) {
    console.error(e);
  }

  iniciarSesionExitosa();
}

function iniciarSesionExitosa() {
  sessionStorage.setItem(PIN_SESSION_KEY, "1");
  desbloquearPanel();
}

function desbloquearPanel() {
  pinScreen.style.display = "none";
  appShell.style.display = "flex";
  conectarListeners();
}

function cerrarSesion() {
  sessionStorage.removeItem(PIN_SESSION_KEY);
  window.location.reload();
}

// --- CONECTAR BASE DE DATOS Y LISTENERS ---
function conectarListeners() {
  // 1. Estado de red
  const netDot = document.getElementById("network-status");
  onValue(ref(db, ".info/connected"), (snap) => {
    if (snap.val() === true) {
      netDot.className = "status-dot connected";
    } else {
      netDot.className = "status-dot";
    }
  });

  // 2. Nombre del local
  onValue(ref(db, "config/local"), (snap) => {
    const data = snap.val() || {};
    document.getElementById("local-title").textContent = (data.nombre || "Encargado") + " - Carta";
  });

  // 3. Categorías y Carta
  onValue(ref(db, "categorias"), (snap) => {
    categoriasData = snap.val() || {};
    renderCarta();
  });

  onValue(ref(db, "carta"), (snap) => {
    cartaData = snap.val() || {};
    renderCarta();
  });
}

// --- RENDERIZAR CARTA ACCORDEON ---
let accordionState = {}; // Guarda qué categorías están abiertas por ID

function renderCarta() {
  const container = document.getElementById("carta-accordion");
  if (!container) return;
  
  if (Object.keys(categoriasData).length === 0) {
    container.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:24px;">No hay categorías creadas. Pulsa "+" para añadir una.</div>`;
    return;
  }

  // Ordenar categorías por el campo "orden"
  const catsOrdenadas = Object.entries(categoriasData).sort((a, b) => {
    return (a[1].orden || 999) - (b[1].orden || 999);
  });

  container.innerHTML = catsOrdenadas.map(([cid, cat]) => {
    const esAbierta = accordionState[cid] === true;
    
    // Obtener artículos de la categoría
    const artsCat = Object.entries(cartaData)
      .filter(([_, art]) => art.catId === cid)
      .sort((a, b) => (a[1].nombre || "").localeCompare(b[1].nombre || ""));
    
    const artsHtml = artsCat.length > 0 
      ? artsCat.map(([aid, art]) => `
          <div class="art-item ${art.disponible === false ? 'inactive' : ''}">
            <div class="art-info">
              <div class="art-name">${art.nombre}</div>
              <div class="art-price">${Number(art.precio || 0).toFixed(2)} €</div>
            </div>
            <div class="art-actions">
              <button class="btn-edit-art" onclick="window.abrirDrawerEditArt('${cid}', '${aid}')">Editar</button>
            </div>
          </div>
        `).join('')
      : `<div style="text-align:center;font-size:12px;color:var(--text-dim);padding:10px 0;">Categoría vacía.</div>`;

    return `
      <div class="cat-accordion ${esAbierta ? 'open' : ''}" id="cat-acc-${cid}">
        <div class="cat-header" onclick="window.toggleAccordion('${cid}')">
          <div class="cat-title-wrap">
            <span class="cat-chevron">▶</span>
            <span class="cat-title">${cat.nombre}</span>
            <span class="cat-badge">${artsCat.length}</span>
          </div>
          <div class="cat-actions" onclick="event.stopPropagation()">
            <button class="btn-cat-edit" onclick="window.abrirDrawerEditCat('${cid}')">⚙</button>
          </div>
        </div>
        <div class="cat-content">
          <div class="art-list">
            ${artsHtml}
            <button class="btn-edit-art" style="margin-top:4px;width:100%;height:36px;border-style:dashed;" onclick="window.abrirModalNuevoArticulo('${cid}')">+ Añadir Artículo</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function toggleAccordion(cid) {
  accordionState[cid] = !accordionState[cid];
  const el = document.getElementById("cat-acc-" + cid);
  if (el) {
    el.classList.toggle("open", accordionState[cid]);
  }
}

// --- GESTIÓN EDIT CATEGORÍA ---
function abrirDrawerEditCat(cid) {
  const cat = categoriasData[cid];
  if (!cat) return;
  
  document.getElementById("edit-cat-id").value = cid;
  document.getElementById("edit-cat-nombre").value = cat.nombre || "";
  document.getElementById("edit-cat-notas").value = cat.notasPredefinidas || "";
  
  renderVariantesCat(cat.variantes || []);
  
  document.getElementById("overlay-edit-cat").classList.add("open");
  document.getElementById("drawer-edit-cat").classList.add("open");
}

function cerrarDrawerEditCat() {
  document.getElementById("overlay-edit-cat").classList.remove("open");
  document.getElementById("drawer-edit-cat").classList.remove("open");
}

let tempVariantesCat = [];
function renderVariantesCat(variantes) {
  tempVariantesCat = [...variantes];
  const container = document.getElementById("cat-variantes-list");
  if (!container) return;
  
  if (tempVariantesCat.length === 0) {
    container.innerHTML = `<div style="font-size:12px;color:var(--text-dim);text-align:center;">Sin variantes configuradas.</div>`;
    return;
  }
  
  container.innerHTML = tempVariantesCat.map((v, idx) => `
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 6px;">
      <span style="font-size:13px;">${v.nombre} (${Number(v.precio || 0) >= 0 ? '+' : ''}${Number(v.precio || 0).toFixed(2)}€)</span>
      <button class="btn-close-drawer" style="font-size:16px;color:var(--danger);background:none;border:none;cursor:pointer;" onclick="window.eliminarVarianteCategoria(${idx})">&times;</button>
    </div>
  `).join('');
}

function agregarVarianteCategoria() {
  const name = document.getElementById("new-cat-var-nombre").value.trim();
  const price = parseFloat(document.getElementById("new-cat-var-precio").value) || 0;
  
  if (!name) {
    toast("Introduce un nombre de variante");
    return;
  }
  
  tempVariantesCat.push({ nombre: name, precio: price });
  document.getElementById("new-cat-var-nombre").value = "";
  document.getElementById("new-cat-var-precio").value = "";
  renderVariantesCat(tempVariantesCat);
}

function eliminarVarianteCategoria(idx) {
  tempVariantesCat.splice(idx, 1);
  renderVariantesCat(tempVariantesCat);
}

async function abrirModalNuevaCategoria() {
  showCustomPrompt("Nueva Categoría", "Introduce el nombre de la categoría:", async (nombre) => {
    if (!nombre || !nombre.trim()) return;
    try {
      const maxOrden = Object.values(categoriasData).reduce((max, c) => Math.max(max, c.orden || 0), 0);
      const newRef = push(ref(db, "categorias"), {
        nombre: nombre.trim(),
        orden: maxOrden + 1
      });
      toast("Categoría creada");
      // Abrir edición inmediatamente para poder configurar notas o variantes
      setTimeout(() => abrirDrawerEditCat(newRef.key), 300);
    } catch (err) {
      toast("Error al crear categoría");
    }
  });
}

async function guardarCategoriaCarta() {
  const cid = document.getElementById("edit-cat-id").value;
  const nombre = document.getElementById("edit-cat-nombre").value.trim();
  const notas = document.getElementById("edit-cat-notas").value.trim() || null;
  
  if (!nombre) {
    toast("El nombre no puede estar vacío");
    return;
  }
  
  const catActual = categoriasData[cid] || {};
  
  const updatedData = {
    ...catActual,
    nombre,
    variantes: tempVariantesCat,
    notasPredefinidas: notas
  };

  try {
    await set(ref(db, `categorias/${cid}`), updatedData);
    if (!notas) {
      await remove(ref(db, `categorias/${cid}/notasPredefinidas`));
    }
    toast("Categoría guardada");
    cerrarDrawerEditCat();
  } catch (err) {
    toast("Error al guardar categoría");
  }
}

async function eliminarCategoriaCarta() {
  const cid = document.getElementById("edit-cat-id").value;
  const cat = categoriasData[cid];
  if (!cat) return;
  
  showCustomConfirm("Eliminar Categoría", `¿Seguro que deseas eliminar la categoría "${cat.nombre}"? Se borrarán todos los artículos asociados.`, async (conf) => {
    if (!conf) return;
    try {
      // 1. Borrar artículos vinculados
      const artsCat = Object.keys(cartaData).filter(aid => cartaData[aid].catId === cid);
      for (const aid of artsCat) {
        await remove(ref(db, `carta/${aid}`));
      }
      // 2. Borrar categoría
      await remove(ref(db, `categorias/${cid}`));
      toast("Categoría eliminada");
      cerrarDrawerEditCat();
    } catch (e) {
      toast("Error al eliminar categoría");
    }
  });
}


// --- GESTIÓN EDIT ARTÍCULO ---
let tempVariantesArt = [];
let tempComboGroups = [];

function abrirDrawerEditArt(cid, aid) {
  const art = cartaData[aid];
  if (!art) return;
  
  document.getElementById("edit-art-id").value = aid;
  document.getElementById("edit-art-cat-id").value = cid;
  document.getElementById("edit-art-nombre").value = art.nombre || "";
  document.getElementById("edit-art-precio").value = art.precio != null ? art.precio : "";
  document.getElementById("edit-art-destino").value = art.destino || "cocina";
  document.getElementById("edit-art-activo").checked = art.disponible !== false;
  document.getElementById("edit-art-notas").value = art.notasPredefinidas || "";
  
  // Combo flag y panel
  const esCombo = art.esCombo === true;
  document.getElementById("edit-art-escombo").checked = esCombo;
  tempComboGroups = getComboGroupsMovil(aid);
  
  const comboPanel = document.getElementById("combo-panel-movil");
  comboPanel.style.display = esCombo ? "flex" : "none";
  updateEditComboGroupsListMovil(aid);

  // Variantes
  renderVariantesArt(art.variantes || []);
  
  document.getElementById("overlay-edit-art").classList.add("open");
  document.getElementById("drawer-edit-art").classList.add("open");
}

function cerrarDrawerEditArt() {
  document.getElementById("overlay-edit-art").classList.remove("open");
  document.getElementById("drawer-edit-art").classList.remove("open");
}

function toggleComboPanelMovil() {
  const isChecked = document.getElementById("edit-art-escombo").checked;
  document.getElementById("combo-panel-movil").style.display = isChecked ? "flex" : "none";
}

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

// --- LOGICA DE COMBOS MOVIL ---
function updateEditComboGroupsListMovil(aid) {
  const container = document.getElementById("combo-groups-lista-movil");
  if (!container) return;

  if (tempComboGroups.length === 0) {
    container.innerHTML = `<div style="font-size:12px;color:var(--text-dim);text-align:center;">Sin grupos de selección agregados.</div>`;
    return;
  }

  // Cargar lista de otros artículos ordenada
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

  container.innerHTML = tempComboGroups.map((g, gIdx) => `
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
}

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
  if (!artId) { toast("Elige un artículo"); return; }
  
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

// --- LOGICA VARIANTES DE ARTÍCULO ---
function renderVariantesArt(variantes) {
  tempVariantesArt = [...variantes];
  const container = document.getElementById("art-variantes-list");
  if (!container) return;
  
  if (tempVariantesArt.length === 0) {
    container.innerHTML = `<div style="font-size:12px;color:var(--text-dim);text-align:center;">Sin variantes específicas.</div>`;
    return;
  }
  
  container.innerHTML = tempVariantesArt.map((v, idx) => `
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 6px;">
      <span style="font-size:13px;">${v.nombre} (${Number(v.precio || 0) >= 0 ? '+' : ''}${Number(v.precio || 0).toFixed(2)}€)</span>
      <button class="btn-close-drawer" style="font-size:16px;color:var(--danger);background:none;border:none;cursor:pointer;" onclick="window.eliminarVarianteArticulo(${idx})">&times;</button>
    </div>
  `).join('');
}

function agregarVarianteArticulo() {
  const name = document.getElementById("new-var-nombre").value.trim();
  const price = parseFloat(document.getElementById("new-var-precio").value) || 0;
  
  if (!name) {
    toast("Introduce un nombre de variante");
    return;
  }
  
  tempVariantesArt.push({ nombre: name, precio: price });
  document.getElementById("new-var-nombre").value = "";
  document.getElementById("new-var-precio").value = "";
  renderVariantesArt(tempVariantesArt);
}

function eliminarVarianteArticulo(idx) {
  tempVariantesArt.splice(idx, 1);
  renderVariantesArt(tempVariantesArt);
}

async function abrirModalNuevoArticulo(cid) {
  showCustomPrompt("Nuevo Artículo", "Introduce el nombre del artículo:", async (nombre) => {
    if (!nombre || !nombre.trim()) return;
    try {
      const newRef = push(ref(db, "carta"), {
        nombre: nombre.trim(),
        catId: cid,
        precio: 0.00,
        destino: "cocina",
        disponible: true
      });
      toast("Artículo creado");
      setTimeout(() => abrirDrawerEditArt(cid, newRef.key), 300);
    } catch (e) {
      toast("Error al crear artículo");
    }
  });
}

async function guardarArticuloCarta() {
  const aid = document.getElementById("edit-art-id").value;
  const cid = document.getElementById("edit-art-cat-id").value;
  const nombre = document.getElementById("edit-art-nombre").value.trim();
  const precio = parseFloat(document.getElementById("edit-art-precio").value) || 0;
  const destino = document.getElementById("edit-art-destino").value;
  const disponible = document.getElementById("edit-art-activo").checked;
  const notas = document.getElementById("edit-art-notas").value.trim() || null;
  const esCombo = document.getElementById("edit-art-escombo").checked;

  if (!nombre) {
    toast("El nombre no puede estar vacío");
    return;
  }

  const artActual = cartaData[aid] || {};

  const updatedData = {
    ...artActual,
    nombre,
    precio,
    destino,
    disponible,
    catId: cid,
    variantes: tempVariantesArt,
    esCombo,
    notasPredefinidas: notas
  };

  if (esCombo) {
    // Validar nombres de grupo vacíos o sin opciones
    const validGroups = tempComboGroups.map(g => ({
      nombre: (g.nombre || "Selección").trim(),
      items: (g.items || []).filter(o => o.artId !== "")
    })).filter(g => g.items.length > 0);

    updatedData.comboGroups = validGroups;
  } else {
    if (updatedData.hasOwnProperty("comboGroups")) {
      delete updatedData.comboGroups;
    }
  }

  if (!notas) {
    if (updatedData.hasOwnProperty("notasPredefinidas")) {
      delete updatedData.notasPredefinidas;
    }
  }

  try {
    await set(ref(db, `carta/${aid}`), updatedData);
    // Asegurar limpieza de nodos eliminados en Firebase
    if (!esCombo) {
      await remove(ref(db, `carta/${aid}/comboGroups`));
    }
    if (!notas) {
      await remove(ref(db, `carta/${aid}/notasPredefinidas`));
    }
    toast("Artículo guardado");
    cerrarDrawerEditArt();
  } catch (err) {
    toast("Error al guardar artículo");
  }
}

async function eliminarArticuloCarta() {
  const aid = document.getElementById("edit-art-id").value;
  const art = cartaData[aid];
  if (!art) return;
  
  showCustomConfirm("Eliminar Artículo", `¿Seguro que deseas eliminar el artículo "${art.nombre}"?`, async (conf) => {
    if (!conf) return;
    try {
      await remove(ref(db, `carta/${aid}`));
      toast("Artículo eliminado");
      cerrarDrawerEditArt();
    } catch (e) {
      toast("Error al eliminar artículo");
    }
  });
}


// --- TOAST NOTIFICATIONS ---
function toast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => {
    t.classList.remove("show");
  }, 2200);
}


// --- MODAL PERSONALIZADO (ALERT/CONFIRM/PROMPT) ---
let customModalCallback = null;

function showCustomAlert(title, message) {
  document.getElementById("custom-modal-title").textContent = title;
  document.getElementById("custom-modal-message").textContent = message;
  document.getElementById("custom-modal-input").style.display = "none";
  document.getElementById("custom-modal-btn-cancel").style.display = "none";
  
  const okBtn = document.getElementById("custom-modal-btn-ok");
  okBtn.textContent = "Aceptar";
  okBtn.onclick = () => cerrarCustomModal();

  document.getElementById("overlay-custom-modal").style.display = "block";
  const modal = document.getElementById("custom-modal");
  modal.style.display = "flex";
  setTimeout(() => {
    document.getElementById("overlay-custom-modal").classList.add("open");
    modal.classList.add("open");
  }, 20);
}

function showCustomConfirm(title, message, callback) {
  customModalCallback = callback;
  document.getElementById("custom-modal-title").textContent = title;
  document.getElementById("custom-modal-message").textContent = message;
  document.getElementById("custom-modal-input").style.display = "none";
  
  const cancelBtn = document.getElementById("custom-modal-btn-cancel");
  cancelBtn.style.display = "block";
  cancelBtn.onclick = () => {
    cerrarCustomModal();
    if (customModalCallback) customModalCallback(false);
  };

  const okBtn = document.getElementById("custom-modal-btn-ok");
  okBtn.textContent = "Aceptar";
  okBtn.onclick = () => {
    cerrarCustomModal();
    if (customModalCallback) customModalCallback(true);
  };

  document.getElementById("overlay-custom-modal").style.display = "block";
  const modal = document.getElementById("custom-modal");
  modal.style.display = "flex";
  setTimeout(() => {
    document.getElementById("overlay-custom-modal").classList.add("open");
    modal.classList.add("open");
  }, 20);
}

function showCustomPrompt(title, message, callback) {
  customModalCallback = callback;
  document.getElementById("custom-modal-title").textContent = title;
  document.getElementById("custom-modal-message").textContent = message;
  
  const input = document.getElementById("custom-modal-input");
  input.value = "";
  input.style.display = "block";

  const cancelBtn = document.getElementById("custom-modal-btn-cancel");
  cancelBtn.style.display = "block";
  cancelBtn.onclick = () => {
    cerrarCustomModal();
    if (customModalCallback) customModalCallback(null);
  };

  const okBtn = document.getElementById("custom-modal-btn-ok");
  okBtn.textContent = "Aceptar";
  okBtn.onclick = () => {
    const val = input.value;
    cerrarCustomModal();
    if (customModalCallback) customModalCallback(val);
  };

  document.getElementById("overlay-custom-modal").style.display = "block";
  const modal = document.getElementById("custom-modal");
  modal.style.display = "flex";
  setTimeout(() => {
    document.getElementById("overlay-custom-modal").classList.add("open");
    modal.classList.add("open");
    input.focus();
  }, 20);
}

function cerrarCustomModal() {
  document.getElementById("overlay-custom-modal").classList.remove("open");
  const modal = document.getElementById("custom-modal");
  modal.classList.remove("open");
  setTimeout(() => {
    document.getElementById("overlay-custom-modal").style.display = "none";
    modal.style.display = "none";
  }, 200);
}

window.alert = function(mensaje) {
  showCustomAlert("Mensaje", mensaje);
};

// --- EXPOSICIÓN GLOBAL ---
window.toggleAccordion = toggleAccordion;
window.abrirDrawerEditCat = abrirDrawerEditCat;
window.cerrarDrawerEditCat = cerrarDrawerEditCat;
window.eliminarVarianteCategoria = eliminarVarianteCategoria;
window.agregarVarianteCategoria = agregarVarianteCategoria;
window.abrirModalNuevaCategoria = abrirModalNuevaCategoria;
window.guardarCategoriaCarta = guardarCategoriaCarta;
window.eliminarCategoriaCarta = eliminarCategoriaCarta;

window.abrirDrawerEditArt = abrirDrawerEditArt;
window.cerrarDrawerEditArt = cerrarDrawerEditArt;
window.toggleComboPanelMovil = toggleComboPanelMovil;
window.eliminarVarianteArticulo = eliminarVarianteArticulo;
window.agregarVarianteArticulo = agregarVarianteArticulo;
window.abrirModalNuevoArticulo = abrirModalNuevoArticulo;
window.guardarArticuloCarta = guardarArticuloCarta;
window.eliminarArticuloCarta = eliminarArticuloCarta;

window.cerrarCustomModal = cerrarCustomModal;
window.cerrarSesion = cerrarSesion;

// --- INICIALIZAR ---
init();
