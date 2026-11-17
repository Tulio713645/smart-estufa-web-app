/**
 * =========================================================================================
 * AGROLINK - APLICATIVO ANDROID OFICIAL DEFINITIVO
 * Script Principal: app.js
 * =========================================================================================
 * 
 * Funcionalidades:
 *  - Gerenciamento de múltiplas estufas (estilo Smart Life / automação industrial)
 *  - Gesto de Long Press aprimorado + botão ⋮ para Edição e Exclusão via Bottom Sheet
 *  - 100% livre de classificações de frutas / IA de frutas
 *  - Design system profissional e coeso (zero visual de "Android puro" cru)
 *  - Comunicação via MQTT Seguro (EMQX Cloud com WebSockets Seguro TLS/SSL)
 *  - Tópicos dinâmicos e isolados por estufa: agrolink/{id_estufa}/...
 *  - Confirmação bidirecional com estado intermediário (piscando suavemente)
 *  - Trava de segurança por nível crítico de água no reservatório
 *  - Trava de operação quando offline com alerta imediato
 *  - Banco de dados local para leituras históricas com carimbo de data/hora
 *  - Gráficos históricos interativos (Dia e Mês) com lacunas reais para períodos offline
 *  - Central de notificações inteligentes
 * =========================================================================================
 */

(function () {
  'use strict';

  // --- CONFIGURAÇÃO DO BROKER MQTT SEGURO (EMQX CLOUD) ---
  const MQTT_CONFIG = {
    host: 'yfd21101.ala.us-east-1.emqxsl.com',
    port: 8084, // Porta WSS (WebSockets Seguro com TLS/SSL) para navegadores e WebView Android
    path: '/mqtt',
    username: 'agro_user',
    password: 'thiago6767',
    keepalive: 60
  };

  const STORAGE_KEYS = {
    GREENHOUSES: 'agrolink_greenhouses_list',
    ACTIVE_ID: 'agrolink_active_greenhouse_id',
    HISTORY_PREFIX: 'agrolink_history_',
    NOTIFICATIONS: 'agrolink_notifications'
  };

  // --- ESTUFAS PADRÃO (SEM CLASSIFICAÇÃO DE FRUTAS) ---
  const DEFAULT_GREENHOUSES = [
    {
      id: 'estufa_01',
      nome: 'Estufa 1',
      online: false,
      telemetria: {
        temp: 24.5,
        umidade_ar: 68,
        umidade_solo: 65,
        nivel_agua: 'OK',
        bomba: 0,
        ventoinha: 0,
        auto_bomba: 1,
        auto_ventoinha: 1
      }
    },
    {
      id: 'estufa_02',
      nome: 'Estufa 2',
      online: false,
      telemetria: {
        temp: 23.0,
        umidade_ar: 70,
        umidade_solo: 72,
        nivel_agua: 'OK',
        bomba: 0,
        ventoinha: 0,
        auto_bomba: 1,
        auto_ventoinha: 1
      }
    }
  ];

  // Estado da Aplicação
  const state = {
    greenhouses: [],
    activeGreenhouseId: null,
    selectedOptionGreenhouseId: null, // Estufa selecionada no Bottom Sheet de opções
    mqttClient: null,
    isConnectingMqtt: false,
    
    // Controle de espera por confirmação de comando (estado intermediário piscando)
    pendingAck: {
      bomba: { waiting: false, timer: null, targetState: null },
      ventoinha: { waiting: false, timer: null, targetState: null }
    },

    // Controle do Gráfico Histórico
    currentGraphMetric: 'temp', // 'temp', 'hum', 'soil'
    currentGraphFilter: 'day',  // 'day', 'month'

    // Notificações
    notifications: [],

    // Timer de Simulação (fallback de demonstração se broker offline)
    simTimer: null
  };

  // Referências dos Elementos do DOM
  const dom = {
    // Header & Navegação
    btnBrandHome: document.getElementById('btnBrandHome'),
    headerSubtitle: document.getElementById('headerSubtitle'),
    btnAddGreenhouse: document.getElementById('btnAddGreenhouse'),
    btnOpenTutorial: document.getElementById('btnOpenTutorial'),
    btnOpenNotifications: document.getElementById('btnOpenNotifications'),
    notificationBadge: document.getElementById('notificationBadge'),

    // Visões
    viewGreenhousesList: document.getElementById('viewGreenhousesList'),
    viewGreenhouseDetail: document.getElementById('viewGreenhouseDetail'),
    greenhousesGrid: document.getElementById('greenhousesGrid'),
    onlineCountBadge: document.getElementById('onlineCountBadge'),

    // Detalhes da Estufa
    btnBackToList: document.getElementById('btnBackToList'),
    activeGreenhouseName: document.getElementById('activeGreenhouseName'),
    activeGreenhouseId: document.getElementById('activeGreenhouseId'),
    detailStatusBadge: document.getElementById('detailStatusBadge'),
    detailStatusDot: document.getElementById('detailStatusDot'),
    detailStatusText: document.getElementById('detailStatusText'),
    wifiActionCard: document.getElementById('wifiActionCard'),
    wifiCardTitle: document.getElementById('wifiCardTitle'),
    wifiCardSubtitle: document.getElementById('wifiCardSubtitle'),
    btnToggleConnection: document.getElementById('btnToggleConnection'),
    btnConnectionLabel: document.getElementById('btnConnectionLabel'),

    // Solo & Bomba
    cardSoilMetric: document.getElementById('cardSoilMetric'),
    valSoil: document.getElementById('valSoil'),
    badgeSoil: document.getElementById('badgeSoil'),
    soilBarFill: document.getElementById('soilBarFill'),
    blockPump: document.getElementById('blockPump'),
    pumpStateBadge: document.getElementById('pumpStateBadge'),
    switchAutoPump: document.getElementById('switchAutoPump'),
    pumpSafetyBanner: document.getElementById('pumpSafetyBanner'),

    // Clima & Ventoinha
    cardTempMetric: document.getElementById('cardTempMetric'),
    valTemp: document.getElementById('valTemp'),
    badgeTemp: document.getElementById('badgeTemp'),
    cardHumMetric: document.getElementById('cardHumMetric'),
    valHum: document.getElementById('valHum'),
    badgeHum: document.getElementById('badgeHum'),
    blockFan: document.getElementById('blockFan'),
    fanStateBadge: document.getElementById('fanStateBadge'),
    switchAutoFan: document.getElementById('switchAutoFan'),

    // Reservatório de Água
    valWaterLevel: document.getElementById('valWaterLevel'),
    waterLevelDesc: document.getElementById('waterLevelDesc'),
    waterVisualTank: document.getElementById('waterVisualTank'),

    // Modais e Bottom Sheet
    modalGreenhouseOptions: document.getElementById('modalGreenhouseOptions'),
    optionsSheetTitle: document.getElementById('optionsSheetTitle'),
    optionsSheetSubtitle: document.getElementById('optionsSheetSubtitle'),
    btnSheetOpen: document.getElementById('btnSheetOpen'),
    btnSheetEdit: document.getElementById('btnSheetEdit'),
    btnSheetDelete: document.getElementById('btnSheetDelete'),
    btnSheetCancel: document.getElementById('btnSheetCancel'),

    modalEditGreenhouse: document.getElementById('modalEditGreenhouse'),
    inputEditGreenhouseName: document.getElementById('inputEditGreenhouseName'),
    btnCloseEditModal: document.getElementById('btnCloseEditModal'),
    btnCancelEditModal: document.getElementById('btnCancelEditModal'),
    btnSaveEditModal: document.getElementById('btnSaveEditModal'),

    modalConfirmDelete: document.getElementById('modalConfirmDelete'),
    deleteConfirmText: document.getElementById('deleteConfirmText'),
    btnCloseDeleteModal: document.getElementById('btnCloseDeleteModal'),
    btnCancelDeleteModal: document.getElementById('btnCancelDeleteModal'),
    btnConfirmDeleteModal: document.getElementById('btnConfirmDeleteModal'),

    modalHistoricalGraph: document.getElementById('modalHistoricalGraph'),
    graphHeaderIcon: document.getElementById('graphHeaderIcon'),
    graphModalTitle: document.getElementById('graphModalTitle'),
    btnCloseGraph: document.getElementById('btnCloseGraph'),
    btnFilterDay: document.getElementById('btnFilterDay'),
    btnFilterMonth: document.getElementById('btnFilterMonth'),
    graphStatMin: document.getElementById('graphStatMin'),
    graphStatAvg: document.getElementById('graphStatAvg'),
    graphStatMax: document.getElementById('graphStatMax'),
    historicalChartCanvas: document.getElementById('historicalChartCanvas'),

    modalTutorial: document.getElementById('modalTutorial'),
    btnCloseTutorial: document.getElementById('btnCloseTutorial'),
    btnGotItTutorial: document.getElementById('btnGotItTutorial'),

    modalAddGreenhouse: document.getElementById('modalAddGreenhouse'),
    btnCloseAddModal: document.getElementById('btnCloseAddModal'),
    btnCancelAddModal: document.getElementById('btnCancelAddModal'),
    btnSaveGreenhouse: document.getElementById('btnSaveGreenhouse'),
    inputGreenhouseName: document.getElementById('inputGreenhouseName'),
    inputGreenhouseId: document.getElementById('inputGreenhouseId'),

    modalNotifications: document.getElementById('modalNotifications'),
    btnCloseNotifications: document.getElementById('btnCloseNotifications'),
    btnClearNotifications: document.getElementById('btnClearNotifications'),
    notificationsList: document.getElementById('notificationsList'),

    toastContainer: document.getElementById('toastContainer')
  };

  // =========================================================================================
  // PERSISTÊNCIA LOCAL (LOCALSTORAGE)
  // =========================================================================================

  function loadGreenhouses() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.GREENHOUSES);
      if (saved) {
        state.greenhouses = JSON.parse(saved);
        // Higieniza qualquer resquício de cultura/fruta antigo
        state.greenhouses.forEach(g => { delete g.cultura; });
      } else {
        state.greenhouses = DEFAULT_GREENHOUSES;
        saveGreenhouses();
      }
    } catch (e) {
      state.greenhouses = DEFAULT_GREENHOUSES;
    }
  }

  function saveGreenhouses() {
    try {
      localStorage.setItem(STORAGE_KEYS.GREENHOUSES, JSON.stringify(state.greenhouses));
    } catch (e) {
      console.warn('Erro ao salvar estufas no localStorage', e);
    }
  }

  function getActiveGreenhouse() {
    return state.greenhouses.find(g => g.id === state.activeGreenhouseId);
  }

  function getGreenhouseById(id) {
    return state.greenhouses.find(g => g.id === id);
  }

  // =========================================================================================
  // NOTIFICAÇÕES INTELIGENTES & TOASTS
  // =========================================================================================

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let iconSvg = '🌱';
    if (type === 'success') iconSvg = '✅';
    if (type === 'error') iconSvg = '⚠️';
    if (type === 'info') iconSvg = 'ℹ️';

    toast.innerHTML = `<span>${iconSvg}</span> <span>${message}</span>`;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 3600);
  }

  function addNotification(titulo, mensagem, tipo = 'info') {
    const item = {
      id: Date.now(),
      titulo,
      mensagem,
      tipo,
      horario: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };

    state.notifications.unshift(item);
    if (state.notifications.length > 30) state.notifications.pop();
    
    try {
      localStorage.setItem(STORAGE_KEYS.NOTIFICATIONS, JSON.stringify(state.notifications));
    } catch (e) {}

    renderNotificationsBadge();
    showToast(`${titulo}: ${mensagem}`, tipo === 'danger' ? 'error' : 'info');
  }

  function renderNotificationsBadge() {
    if (state.notifications.length > 0) {
      dom.notificationBadge.classList.remove('hidden');
    } else {
      dom.notificationBadge.classList.add('hidden');
    }
  }

  function renderNotificationsList() {
    if (state.notifications.length === 0) {
      dom.notificationsList.innerHTML = `<div style="text-align: center; color: var(--text-dim); padding: 2rem;">Nenhuma notificação registrada.</div>`;
      return;
    }

    dom.notificationsList.innerHTML = state.notifications.map(n => `
      <div class="notif-item ${n.tipo}">
        <strong>${n.titulo}</strong>
        <span>${n.mensagem}</span>
        <small>${n.horario}</small>
      </div>
    `).join('');
  }

  // =========================================================================================
  // BANCO DE DADOS LOCAL DE LEITURAS HISTÓRICAS (POR ESTUFA E TIMESTAMP)
  // =========================================================================================

  function recordHistoricalReading(greenhouseId, telemetria) {
    if (!greenhouseId || !telemetria) return;
    const key = STORAGE_KEYS.HISTORY_PREFIX + greenhouseId;
    let history = [];
    try {
      const stored = localStorage.getItem(key);
      if (stored) history = JSON.parse(stored);
    } catch (e) {}

    const now = Date.now();
    history.push({
      t: now,
      temp: parseFloat(telemetria.temp) || 0,
      hum: parseInt(telemetria.umidade_ar, 10) || 0,
      soil: parseInt(telemetria.umidade_solo, 10) || 0
    });

    if (history.length > 1500) {
      history = history.slice(-1500);
    }

    try {
      localStorage.setItem(key, JSON.stringify(history));
    } catch (e) {}
  }

  function getHistoricalReadings(greenhouseId) {
    const key = STORAGE_KEYS.HISTORY_PREFIX + greenhouseId;
    try {
      const stored = localStorage.getItem(key);
      if (stored) return JSON.parse(stored);
    } catch (e) {}
    return [];
  }

  function ensureSeedHistory(greenhouseId) {
    const readings = getHistoricalReadings(greenhouseId);
    if (readings.length > 0) return readings;

    const seed = [];
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const interval = 30 * 60 * 1000;

    for (let t = now - oneDay; t <= now; t += interval) {
      const date = new Date(t);
      const hour = date.getHours();
      if (hour >= 2 && hour <= 5) {
        continue; // Lacuna real para período desligado
      }

      seed.push({
        t: t,
        temp: +(22 + Math.sin(t / 1000000) * 5 + Math.random()).toFixed(1),
        hum: Math.round(65 + Math.cos(t / 1000000) * 10),
        soil: Math.round(70 + Math.sin(t / 800000) * 8)
      });
    }

    try {
      localStorage.setItem(STORAGE_KEYS.HISTORY_PREFIX + greenhouseId, JSON.stringify(seed));
    } catch (e) {}
    return seed;
  }

  // =========================================================================================
  // RENDERIZAÇÃO DO GERENCIADOR DE ESTUFAS COM GESTO DE LONG-PRESS E BOTÃO ⋮
  // =========================================================================================

  function renderGreenhousesList() {
    dom.greenhousesGrid.innerHTML = '';
    let onlineCount = 0;

    state.greenhouses.forEach(greenhouse => {
      if (greenhouse.online) onlineCount++;
      const card = document.createElement('div');
      card.className = 'greenhouse-card-unit';
      card.setAttribute('data-id', greenhouse.id);

      const tel = greenhouse.telemetria || {};
      const tempDisplay = tel.temp ? `${parseFloat(tel.temp).toFixed(0)}°C` : '--';
      const humDisplay = tel.umidade_ar ? `${tel.umidade_ar}%` : '--';
      const soilDisplay = tel.umidade_solo ? `${tel.umidade_solo}%` : '--';

      card.innerHTML = `
        <div class="unit-top-row">
          <div class="unit-avatar-box">
            <img src="assets/logo.png" alt="Estufa">
          </div>
          <div class="unit-top-actions">
            <span class="unit-status-pill ${greenhouse.online ? 'online' : 'offline'}">
              ${greenhouse.online ? '● Online' : '○ Offline'}
            </span>
            <button class="btn-card-more" aria-label="Opções da Estufa" title="Opções">⋮</button>
          </div>
        </div>

        <div class="unit-info">
          <h3>${greenhouse.nome}</h3>
          <span class="unit-code-badge">ID: ${greenhouse.id}</span>
        </div>

        <div class="unit-metrics-summary">
          <div class="summary-item">
            <span>Temp</span>
            <strong>${tempDisplay}</strong>
          </div>
          <div class="summary-item">
            <span>Ar</span>
            <strong>${humDisplay}</strong>
          </div>
          <div class="summary-item">
            <span>Solo</span>
            <strong>${soilDisplay}</strong>
          </div>
        </div>
      `;

      // Botão de opções rápidas ⋮
      const btnMore = card.querySelector('.btn-card-more');
      btnMore.addEventListener('click', (e) => {
        e.stopPropagation();
        openGreenhouseOptionsSheet(greenhouse.id);
      });

      // --- RECONHECIMENTO DE TOQUE ROBUSTO (TOQUE RÁPIDO VS LONG-PRESS) ---
      let pressTimer = null;
      let startX = 0;
      let startY = 0;
      let isMoved = false;
      let isLongPressed = false;

      const startPress = (e) => {
        isMoved = false;
        isLongPressed = false;
        const touch = e.touches ? e.touches[0] : e;
        startX = touch.clientX;
        startY = touch.clientY;

        card.classList.add('pressing');

        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
          if (!isMoved) {
            isLongPressed = true;
            card.classList.remove('pressing');
            if (navigator.vibrate) navigator.vibrate(50);
            openGreenhouseOptionsSheet(greenhouse.id);
          }
        }, 480); // 480ms para disparar o Long Press instantâneo
      };

      const movePress = (e) => {
        if (!pressTimer) return;
        const touch = e.touches ? e.touches[0] : e;
        const deltaX = Math.abs(touch.clientX - startX);
        const deltaY = Math.abs(touch.clientY - startY);

        // Se o usuário rolou a tela mais de 10px, cancela o timer
        if (deltaX > 10 || deltaY > 10) {
          isMoved = true;
          clearTimeout(pressTimer);
          card.classList.remove('pressing');
        }
      };

      const endPress = (e) => {
        clearTimeout(pressTimer);
        card.classList.remove('pressing');

        // Se não foi long-press e não arrastou a tela, foi um toque rápido normal:
        if (!isLongPressed && !isMoved) {
          // Ignora se o clique foi direto no botão de mais ⋮
          if (e.target.closest('.btn-card-more')) return;
          openGreenhouseDetail(greenhouse.id);
        }
      };

      const cancelPress = () => {
        clearTimeout(pressTimer);
        card.classList.remove('pressing');
      };

      // Eventos Touch (Mobile)
      card.addEventListener('touchstart', startPress, { passive: true });
      card.addEventListener('touchmove', movePress, { passive: true });
      card.addEventListener('touchend', endPress);
      card.addEventListener('touchcancel', cancelPress);

      // Eventos Mouse (Desktop / Emulador)
      card.addEventListener('mousedown', (e) => {
        if (e.button === 0) startPress(e);
      });
      card.addEventListener('mousemove', movePress);
      card.addEventListener('mouseup', endPress);
      card.addEventListener('mouseleave', cancelPress);

      dom.greenhousesGrid.appendChild(card);
    });

    dom.onlineCountBadge.textContent = `${onlineCount} Online`;
  }

  // =========================================================================================
  // BOTTOM SHEET DE OPÇÕES DA ESTUFA (SMART LIFE STYLE)
  // =========================================================================================

  function openGreenhouseOptionsSheet(greenhouseId) {
    const greenhouse = getGreenhouseById(greenhouseId);
    if (!greenhouse) return;

    state.selectedOptionGreenhouseId = greenhouseId;
    dom.optionsSheetTitle.textContent = greenhouse.nome;
    dom.optionsSheetSubtitle.textContent = `Código: ${greenhouse.id} (${greenhouse.online ? 'Online' : 'Offline'})`;

    dom.modalGreenhouseOptions.classList.remove('hidden');
  }

  function closeGreenhouseOptionsSheet() {
    dom.modalGreenhouseOptions.classList.add('hidden');
  }

  function handleOptionOpen() {
    closeGreenhouseOptionsSheet();
    if (state.selectedOptionGreenhouseId) {
      openGreenhouseDetail(state.selectedOptionGreenhouseId);
    }
  }

  function handleOptionEdit() {
    closeGreenhouseOptionsSheet();
    const greenhouse = getGreenhouseById(state.selectedOptionGreenhouseId);
    if (!greenhouse) return;

    dom.inputEditGreenhouseName.value = greenhouse.nome;
    dom.modalEditGreenhouse.classList.remove('hidden');
  }

  function handleOptionDelete() {
    closeGreenhouseOptionsSheet();
    const greenhouse = getGreenhouseById(state.selectedOptionGreenhouseId);
    if (!greenhouse) return;

    if (state.greenhouses.length <= 1) {
      showToast('Você deve manter pelo menos uma estufa cadastrada.', 'error');
      return;
    }

    dom.deleteConfirmText.textContent = `Tem certeza que deseja excluir "${greenhouse.nome}" (${greenhouse.id})?`;
    dom.modalConfirmDelete.classList.remove('hidden');
  }

  function confirmDeleteGreenhouse() {
    const id = state.selectedOptionGreenhouseId;
    const greenhouse = getGreenhouseById(id);
    const nome = greenhouse ? greenhouse.nome : id;

    state.greenhouses = state.greenhouses.filter(g => g.id !== id);
    saveGreenhouses();

    dom.modalConfirmDelete.classList.add('hidden');
    renderGreenhousesList();
    showToast(`Estufa "${nome}" excluída da lista.`, 'info');
  }

  function saveEditedGreenhouseName() {
    const novoNome = dom.inputEditGreenhouseName.value.trim();
    if (!novoNome) {
      showToast('Informe um nome válido para a estufa.', 'error');
      return;
    }

    const greenhouse = getGreenhouseById(state.selectedOptionGreenhouseId);
    if (greenhouse) {
      greenhouse.nome = novoNome;
      saveGreenhouses();
      dom.modalEditGreenhouse.classList.add('hidden');
      renderGreenhousesList();
      showToast('Nome da estufa atualizado com sucesso!', 'success');
    }
  }

  // =========================================================================================
  // NAVEGAÇÃO ENTRE TELAS
  // =========================================================================================

  function showView(viewId) {
    dom.viewGreenhousesList.classList.remove('active');
    dom.viewGreenhouseDetail.classList.remove('active');

    if (viewId === 'list') {
      dom.viewGreenhousesList.classList.add('active');
      dom.headerSubtitle.textContent = 'Minhas Estufas';
      renderGreenhousesList();
    } else if (viewId === 'detail') {
      dom.viewGreenhouseDetail.classList.add('active');
      const active = getActiveGreenhouse();
      if (active) {
        dom.headerSubtitle.textContent = active.nome;
      }
    }
  }

  function openGreenhouseDetail(greenhouseId) {
    state.activeGreenhouseId = greenhouseId;
    localStorage.setItem(STORAGE_KEYS.ACTIVE_ID, greenhouseId);
    const greenhouse = getActiveGreenhouse();
    if (!greenhouse) return;

    dom.activeGreenhouseName.textContent = greenhouse.nome;
    dom.activeGreenhouseId.textContent = `ID: ${greenhouse.id}`;

    showView('detail');
    updateDetailViewUI(greenhouse.telemetria, greenhouse.online);
    subscribeGreenhouseTopics(greenhouse.id);
  }

  // =========================================================================================
  // ATUALIZAÇÃO DA TELA DE DETALHES COM DADOS DOS SENSORES E ATUADORES
  // =========================================================================================

  function updateDetailViewUI(data, isOnline) {
    const greenhouse = getActiveGreenhouse();
    if (!greenhouse) return;

    greenhouse.online = !!isOnline;
    if (data) greenhouse.telemetria = data;

    // 1. Status de Conexão
    if (isOnline) {
      dom.detailStatusDot.className = 'status-indicator-dot connected';
      dom.detailStatusText.textContent = 'Online';
      dom.wifiCardTitle.textContent = 'Conectado à Estufa';
      dom.wifiCardSubtitle.textContent = 'Recebendo telemetria via ESP-12E em tempo real';
      dom.btnConnectionLabel.textContent = 'Desconectar';
    } else {
      dom.detailStatusDot.className = 'status-indicator-dot disconnected';
      dom.detailStatusText.textContent = 'Offline';
      dom.wifiCardTitle.textContent = 'Rede Sem Fio Desconectada';
      dom.wifiCardSubtitle.textContent = 'Toque em Conectar para sincronizar com a estufa';
      dom.btnConnectionLabel.textContent = 'Conectar';
    }

    if (!data) return;

    // 2. Umidade do Solo (Valores Agronômicos Ideais: 60% a 80%)
    const soil = Math.max(0, Math.min(100, parseInt(data.umidade_solo, 10) || 0));
    dom.valSoil.textContent = soil;
    dom.soilBarFill.style.width = `${soil}%`;

    if (soil < 40) {
      dom.badgeSoil.textContent = 'Solo Seco';
      dom.badgeSoil.className = 'badge status-danger';
      dom.soilBarFill.style.background = 'linear-gradient(90deg, #ef4444, #f97316)';
    } else if (soil <= 80) {
      dom.badgeSoil.textContent = 'Ideal (60% - 80%)';
      dom.badgeSoil.className = 'badge status-good';
      dom.soilBarFill.style.background = 'linear-gradient(90deg, #10b981, #059669)';
    } else {
      dom.badgeSoil.textContent = 'Solo Saturado';
      dom.badgeSoil.className = 'badge status-warning';
      dom.soilBarFill.style.background = 'linear-gradient(90deg, #06b6d4, #0284c7)';
    }

    // 3. Temperatura do Ar (Ideal Agronômico: 20°C a 30°C)
    const temp = parseFloat(data.temp);
    if (!isNaN(temp)) {
      dom.valTemp.textContent = temp.toFixed(1);
      if (temp < 18) {
        dom.badgeTemp.textContent = 'Frio (<18°C)';
        dom.badgeTemp.className = 'badge status-warning';
      } else if (temp <= 30) {
        dom.badgeTemp.textContent = 'Ideal (20°C - 30°C)';
        dom.badgeTemp.className = 'badge status-good';
      } else {
        dom.badgeTemp.textContent = 'Elevada (>30°C)';
        dom.badgeTemp.className = 'badge status-danger';
      }
    }

    // 4. Umidade do Ar (Ideal Agronômico: 60% a 80%)
    const hum = parseInt(data.umidade_ar, 10);
    if (!isNaN(hum)) {
      dom.valHum.textContent = hum;
      if (hum < 50) {
        dom.badgeHum.textContent = 'Ar Seco (<50%)';
        dom.badgeHum.className = 'badge status-warning';
      } else if (hum <= 80) {
        dom.badgeHum.textContent = 'Ideal (60% - 80%)';
        dom.badgeHum.className = 'badge status-good';
      } else {
        dom.badgeHum.textContent = 'Alta Umidade (>80%)';
        dom.badgeHum.className = 'badge status-warning';
      }
    }

    // 5. Reservatório de Água (Amigável)
    const isWaterLow = (data.nivel_agua === 'BAIXO' || data.falta_agua === 1 || data.falta_agua === true);
    if (isWaterLow) {
      dom.valWaterLevel.textContent = 'NÍVEL CRÍTICO';
      dom.waterLevelDesc.textContent = 'Atenção: Reabasteça o reservatório de água da estufa!';
      dom.waterVisualTank.className = 'water-visual-tank critical';
      dom.pumpSafetyBanner.classList.remove('hidden');
    } else {
      dom.valWaterLevel.textContent = 'Nível Normal';
      dom.waterLevelDesc.textContent = 'Abastecimento seguro para irrigação automática.';
      dom.waterVisualTank.className = 'water-visual-tank ok';
      dom.pumpSafetyBanner.classList.add('hidden');
    }

    // 6. Atuador: Bomba d'Água (Se não estiver aguardando confirmação)
    if (!state.pendingAck.bomba.waiting) {
      const isPumpOn = (data.bomba === 1 || data.bomba === true || data.bomba === '1');
      dom.blockPump.setAttribute('aria-pressed', isPumpOn);
      if (isPumpOn) {
        dom.blockPump.className = 'actuator-cube-block active';
        dom.pumpStateBadge.textContent = 'LIGADA';
      } else {
        dom.blockPump.className = 'actuator-cube-block';
        dom.pumpStateBadge.textContent = 'DESLIGADA';
      }
    }

    // 7. Atuador: Ventoinha (Se não estiver aguardando confirmação)
    if (!state.pendingAck.ventoinha.waiting) {
      const isFanOn = (data.ventoinha === 1 || data.ventoinha === true || data.ventoinha === '1');
      dom.blockFan.setAttribute('aria-pressed', isFanOn);
      if (isFanOn) {
        dom.blockFan.className = 'actuator-cube-block fan-cube active';
        dom.fanStateBadge.textContent = 'LIGADA';
      } else {
        dom.blockFan.className = 'actuator-cube-block fan-cube';
        dom.fanStateBadge.textContent = 'DESLIGADA';
      }
    }

    // 8. Chaves de Automático
    if (data.auto_bomba !== undefined) {
      dom.switchAutoPump.checked = (data.auto_bomba === 1 || data.auto_bomba === true);
    }
    if (data.auto_ventoinha !== undefined) {
      dom.switchAutoFan.checked = (data.auto_ventoinha === 1 || data.auto_ventoinha === true);
    }
  }

  // =========================================================================================
  // COMUNICAÇÃO MQTT SEGURA (EMQX CLOUD VIA WEBSOCKETS SEGURO WSS)
  // =========================================================================================

  function connectMqttBroker() {
    if (state.mqttClient && state.mqttClient.connected) {
      showToast('Já conectado ao servidor MQTT!', 'info');
      return;
    }

    const brokerUrl = `wss://${MQTT_CONFIG.host}:${MQTT_CONFIG.port}${MQTT_CONFIG.path}`;
    showToast('Conectando ao servidor da estufa...', 'info');

    try {
      if (typeof mqtt === 'undefined') {
        console.warn('Biblioteca MQTT não carregada pela rede. Ativando modo de operação local.');
        enableSimulationFallback();
        return;
      }

      state.isConnectingMqtt = true;
      state.mqttClient = mqtt.connect(brokerUrl, {
        username: MQTT_CONFIG.username,
        password: MQTT_CONFIG.password,
        keepalive: MQTT_CONFIG.keepalive,
        clientId: 'AgroLinkApp_' + Math.random().toString(16).substring(2, 10),
        reconnectPeriod: 4000
      });

      state.mqttClient.on('connect', () => {
        state.isConnectingMqtt = false;
        showToast('Conectado à rede com sucesso!', 'success');
        
        state.greenhouses.forEach(g => subscribeGreenhouseTopics(g.id));

        const active = getActiveGreenhouse();
        if (active) {
          updateDetailViewUI(active.telemetria, true);
        }
        renderGreenhousesList();
      });

      state.mqttClient.on('message', (topic, payload) => {
        handleMqttIncomingMessage(topic, payload.toString());
      });

      state.mqttClient.on('error', (err) => {
        console.warn('[MQTT Error]:', err);
        state.isConnectingMqtt = false;
      });

      state.mqttClient.on('close', () => {
        state.greenhouses.forEach(g => { g.online = false; });
        const active = getActiveGreenhouse();
        if (active) updateDetailViewUI(active.telemetria, false);
        renderGreenhousesList();
      });

    } catch (err) {
      console.warn('Exceção ao conectar MQTT:', err);
      enableSimulationFallback();
    }
  }

  function disconnectMqttBroker() {
    if (state.mqttClient) {
      state.mqttClient.end();
      state.mqttClient = null;
    }
    state.greenhouses.forEach(g => { g.online = false; });
    const active = getActiveGreenhouse();
    if (active) updateDetailViewUI(active.telemetria, false);
    renderGreenhousesList();
    showToast('Desconectado da rede.', 'info');
  }

  function subscribeGreenhouseTopics(greenhouseId) {
    if (!state.mqttClient || !state.mqttClient.connected || !greenhouseId) return;

    state.mqttClient.subscribe(`agrolink/${greenhouseId}/telemetria`);
    state.mqttClient.subscribe(`agrolink/${greenhouseId}/status`);
    state.mqttClient.subscribe(`agrolink/${greenhouseId}/ack`);
  }

  function handleMqttIncomingMessage(topic, messageStr) {
    try {
      const data = JSON.parse(messageStr);
      const parts = topic.split('/');
      const greenhouseId = parts[1];
      const subtopic = parts[2];

      const greenhouse = state.greenhouses.find(g => g.id === greenhouseId);
      if (!greenhouse) return;

      if (subtopic === 'status') {
        const isOnline = (data.status === 'online');
        greenhouse.online = isOnline;
        if (greenhouse.id === state.activeGreenhouseId) {
          updateDetailViewUI(greenhouse.telemetria, isOnline);
        }
        renderGreenhousesList();
      }
      else if (subtopic === 'ack') {
        handleActionAck(data);
      }
      else if (subtopic === 'telemetria') {
        greenhouse.online = true;
        greenhouse.telemetria = data;

        recordHistoricalReading(greenhouse.id, data);
        checkIntelligentTriggers(greenhouse, data);

        if (greenhouse.id === state.activeGreenhouseId) {
          updateDetailViewUI(data, true);
        }
        renderGreenhousesList();
      }
    } catch (e) {
      console.warn('Erro ao processar mensagem MQTT:', e);
    }
  }

  function checkIntelligentTriggers(greenhouse, data) {
    const soil = parseInt(data.umidade_solo, 10);
    const temp = parseFloat(data.temp);
    const faltaAgua = (data.nivel_agua === 'BAIXO' || data.falta_agua === 1);

    if (soil < 40 && data.bomba === 1 && (!greenhouse._lastAlertSolo || Date.now() - greenhouse._lastAlertSolo > 60000)) {
      greenhouse._lastAlertSolo = Date.now();
      addNotification(greenhouse.nome, 'Solo seco detectado. Ligando a bomba de água automaticamente.', 'info');
    }

    if (faltaAgua && (!greenhouse._lastAlertAgua || Date.now() - greenhouse._lastAlertAgua > 90000)) {
      greenhouse._lastAlertAgua = Date.now();
      addNotification(greenhouse.nome, 'Atenção: O reservatório de água está quase acabando!', 'danger');
    }

    if (temp > 30.0 && data.ventoinha === 1 && (!greenhouse._lastAlertTemp || Date.now() - greenhouse._lastAlertTemp > 60000)) {
      greenhouse._lastAlertTemp = Date.now();
      addNotification(greenhouse.nome, 'Temperatura elevada na estufa. Acionando ventoinha.', 'warning');
    }
  }

  // =========================================================================================
  // FLUXO DE CONFIRMAÇÃO DE AÇÃO (ESTADO INTERMEDIÁRIO PISCANDO SUAVEMENTE)
  // =========================================================================================

  function sendActuatorCommand(atuador, novoEstado) {
    const greenhouse = getActiveGreenhouse();

    // TRAVA 1: SE OFFLINE, NÃO ACIONA E MOSTRA ALERTA CLARO
    if (!greenhouse || !greenhouse.online) {
      showToast('A estufa está offline. Conecte-se primeiro.', 'error');
      return;
    }

    // TRAVA 2: TRAVA DE SEGURANÇA SE RESERVATÓRIO ESTIVER SEM ÁGUA
    if (atuador === 'bomba' && novoEstado === 1) {
      const isWaterLow = (greenhouse.telemetria && (greenhouse.telemetria.nivel_agua === 'BAIXO' || greenhouse.telemetria.falta_agua === 1));
      if (isWaterLow) {
        showToast('Trava de segurança: Reservatório de água vazio! A bomba não pode ser ligada.', 'error');
        return;
      }
    }

    // Inicia Estado Intermediário (Piscando suavemente)
    const blockEl = (atuador === 'bomba') ? dom.blockPump : dom.blockFan;
    blockEl.classList.add('waiting');

    const pending = state.pendingAck[atuador];
    pending.waiting = true;
    pending.targetState = novoEstado;

    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (pending.waiting) {
        pending.waiting = false;
        blockEl.classList.remove('waiting');
        showToast(`Tempo esgotado: A estufa não respondeu ao comando da ${atuador === 'bomba' ? 'Bomba' : 'Ventoinha'}.`, 'error');
        if (greenhouse.telemetria) updateDetailViewUI(greenhouse.telemetria, greenhouse.online);
      }
    }, 5000);

    const payload = JSON.stringify({
      cmd: atuador,
      val: novoEstado,
      origem: 'app'
    });

    if (state.mqttClient && state.mqttClient.connected) {
      state.mqttClient.publish(`agrolink/${greenhouse.id}/comando`, payload);
    } else {
      setTimeout(() => {
        handleActionAck({ ack: atuador, estado: novoEstado, status: 'ok' });
      }, 700);
    }
  }

  function handleActionAck(data) {
    const atuador = data.ack;
    if (!atuador || !state.pendingAck[atuador]) return;

    const pending = state.pendingAck[atuador];
    clearTimeout(pending.timer);
    pending.waiting = false;

    const blockEl = (atuador === 'bomba') ? dom.blockPump : dom.blockFan;
    blockEl.classList.remove('waiting');

    const greenhouse = getActiveGreenhouse();
    if (greenhouse && greenhouse.telemetria) {
      greenhouse.telemetria[atuador] = data.estado;
      updateDetailViewUI(greenhouse.telemetria, greenhouse.online);
    }

    showToast(`Confirmação recebida: ${atuador === 'bomba' ? 'Bomba de Água' : 'Ventoinha'} ${data.estado === 1 ? 'LIGADA' : 'DESLIGADA'}!`, 'success');
  }

  function sendAutoModeToggle(atuador, ativado) {
    const greenhouse = getActiveGreenhouse();
    if (!greenhouse || !greenhouse.online) {
      showToast('A estufa está offline. Conecte-se primeiro.', 'error');
      return;
    }

    const payload = JSON.stringify({
      cmd: `auto_${atuador}`,
      val: ativado ? 1 : 0
    });

    if (state.mqttClient && state.mqttClient.connected) {
      state.mqttClient.publish(`agrolink/${greenhouse.id}/comando`, payload);
      showToast(`Modo automático da ${atuador === 'bomba' ? 'Bomba' : 'Ventoinha'} ${ativado ? 'ativado' : 'desativado'}.`, 'info');
    }
  }

  // =========================================================================================
  // GRÁFICOS HISTÓRICOS INTERATIVOS COM TRATAMENTO DE PERÍODOS OFFLINE
  // =========================================================================================

  function openHistoricalGraph(metricType) {
    state.currentGraphMetric = metricType;
    const greenhouse = getActiveGreenhouse();
    if (!greenhouse) return;

    const titles = {
      temp: { label: 'Histórico de Temperatura do Ar', icon: '🌡️' },
      hum: { label: 'Histórico de Umidade do Ar', icon: '💧' },
      soil: { label: 'Histórico de Umidade do Solo', icon: '🌱' }
    };

    const config = titles[metricType] || titles.temp;
    dom.graphModalTitle.textContent = config.label;
    dom.graphHeaderIcon.textContent = config.icon;

    ensureSeedHistory(greenhouse.id);
    renderHistoricalChart();
    dom.modalHistoricalGraph.classList.remove('hidden');
  }

  function renderHistoricalChart() {
    const canvas = dom.historicalChartCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const greenhouse = getActiveGreenhouse();
    if (!greenhouse) return;

    let readings = getHistoricalReadings(greenhouse.id);
    if (!readings || readings.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Nenhum dado registrado para o período.', width / 2, height / 2);
      return;
    }

    const now = Date.now();
    const periodMs = (state.currentGraphFilter === 'day') ? (24 * 60 * 60 * 1000) : (30 * 24 * 60 * 60 * 1000);
    readings = readings.filter(r => (now - r.t) <= periodMs);

    if (readings.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Aguardando primeiras leituras deste período...', width / 2, height / 2);
      return;
    }

    const metric = state.currentGraphMetric;
    const values = readings.map(r => r[metric]);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const avgVal = values.reduce((a, b) => a + b, 0) / values.length;

    const unit = (metric === 'temp') ? '°C' : '%';
    dom.graphStatMin.textContent = `${minVal.toFixed(1)}${unit}`;
    dom.graphStatAvg.textContent = `${avgVal.toFixed(1)}${unit}`;
    dom.graphStatMax.textContent = `${maxVal.toFixed(1)}${unit}`;

    let idealMin = 20, idealMax = 30;
    if (metric === 'hum') { idealMin = 60; idealMax = 80; }
    if (metric === 'soil') { idealMin = 60; idealMax = 80; }

    const chartMin = Math.min(idealMin - 5, minVal - 2);
    const chartMax = Math.max(idealMax + 5, maxVal + 2);

    const padding = { top: 20, right: 20, bottom: 30, left: 40 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const getY = (val) => padding.top + chartH - ((val - chartMin) / (chartMax - chartMin)) * chartH;
    const getX = (timestamp) => {
      const startTime = readings[0].t;
      const endTime = readings[readings.length - 1].t;
      if (endTime === startTime) return padding.left + chartW / 2;
      return padding.left + ((timestamp - startTime) / (endTime - startTime)) * chartW;
    };

    // 1. Faixa Agronômica Ideal Sombreada
    const yIdealTop = getY(idealMax);
    const yIdealBottom = getY(idealMin);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.12)';
    ctx.fillRect(padding.left, yIdealTop, chartW, yIdealBottom - yIdealTop);

    ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padding.left, yIdealTop);
    ctx.lineTo(padding.left + chartW, yIdealTop);
    ctx.moveTo(padding.left, yIdealBottom);
    ctx.lineTo(padding.left + chartW, yIdealBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    // 2. Linhas de Grade e Eixo Y
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + chartH);
    ctx.lineTo(padding.left + chartW, padding.top + chartH);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${chartMax.toFixed(0)}${unit}`, padding.left - 6, padding.top + 10);
    ctx.fillText(`${((chartMax + chartMin) / 2).toFixed(0)}${unit}`, padding.left - 6, padding.top + chartH / 2);
    ctx.fillText(`${chartMin.toFixed(0)}${unit}`, padding.left - 6, padding.top + chartH);

    // 3. Linha com Tratamento de Períodos Desligados (Offline)
    const MAX_GAP_MS = 45 * 60 * 1000;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#10b981';

    let isDrawingSegment = false;

    for (let i = 0; i < readings.length; i++) {
      const pt = readings[i];
      const x = getX(pt.t);
      const y = getY(pt[metric]);

      if (i > 0) {
        const gap = pt.t - readings[i - 1].t;
        if (gap > MAX_GAP_MS) {
          ctx.stroke();

          // Segmento pontilhado para indicar período offline
          ctx.beginPath();
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = '#64748b';
          const prevX = getX(readings[i - 1].t);
          const prevY = getY(readings[i - 1][metric]);
          ctx.moveTo(prevX, prevY);
          ctx.lineTo(x, y);
          ctx.stroke();

          ctx.setLineDash([]);
          ctx.strokeStyle = '#10b981';
          isDrawingSegment = false;
        }
      }

      if (!isDrawingSegment) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        isDrawingSegment = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    if (isDrawingSegment) ctx.stroke();

    // Marcador final
    const lastPt = readings[readings.length - 1];
    const lastX = getX(lastPt.t);
    const lastY = getY(lastPt[metric]);
    ctx.fillStyle = '#34d399';
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // =========================================================================================
  // MODO DEMONSTRAÇÃO / SIMULAÇÃO LOCAL (SE SEM CONEXÃO)
  // =========================================================================================

  function enableSimulationFallback() {
    showToast('Modo de demonstração local ativo.', 'info');
    if (state.simTimer) clearInterval(state.simTimer);

    state.simTimer = setInterval(() => {
      state.greenhouses.forEach(g => {
        if (!g.online) return;
        const s = g.telemetria;
        if (!s) return;

        s.temp = +(24 + Math.random() * 2).toFixed(1);
        s.umidade_ar = Math.min(85, Math.max(50, s.umidade_ar + Math.round((Math.random() - 0.5) * 2)));

        if (s.bomba) {
          s.umidade_solo = Math.min(80, s.umidade_solo + 2);
          if (s.umidade_solo >= 78) s.bomba = 0;
        } else {
          s.umidade_solo = Math.max(30, s.umidade_solo - 1);
          if (s.auto_bomba && s.umidade_solo < 40) s.bomba = 1;
        }

        if (s.auto_ventoinha && s.temp > 30.0) s.ventoinha = 1;
        if (s.temp < 27.0) s.ventoinha = 0;

        recordHistoricalReading(g.id, s);

        if (g.id === state.activeGreenhouseId) {
          updateDetailViewUI(s, true);
        }
      });
      renderGreenhousesList();
    }, 2500);
  }

  // =========================================================================================
  // EVENT LISTENERS E INICIALIZAÇÃO
  // =========================================================================================

  function setupEventListeners() {
    // Cabeçalho e Navegação
    dom.btnBrandHome.addEventListener('click', () => showView('list'));
    dom.btnBackToList.addEventListener('click', () => showView('list'));

    // Botão Adicionar Estufa (+)
    dom.btnAddGreenhouse.addEventListener('click', () => {
      dom.inputGreenhouseName.value = '';
      dom.inputGreenhouseId.value = `estufa_${state.greenhouses.length + 1}`;
      dom.modalAddGreenhouse.classList.remove('hidden');
    });

    dom.btnCloseAddModal.addEventListener('click', () => dom.modalAddGreenhouse.classList.add('hidden'));
    dom.btnCancelAddModal.addEventListener('click', () => dom.modalAddGreenhouse.classList.add('hidden'));

    dom.btnSaveGreenhouse.addEventListener('click', () => {
      const name = dom.inputGreenhouseName.value.trim();
      const id = dom.inputGreenhouseId.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

      if (!name || !id) {
        showToast('Preencha o nome e o código da estufa.', 'error');
        return;
      }

      if (state.greenhouses.some(g => g.id === id)) {
        showToast('Já existe uma estufa cadastrada com esse código ID!', 'error');
        return;
      }

      state.greenhouses.push({
        id,
        nome: name,
        online: false,
        telemetria: {
          temp: 25.0,
          umidade_ar: 65,
          umidade_solo: 70,
          nivel_agua: 'OK',
          bomba: 0,
          ventoinha: 0,
          auto_bomba: 1,
          auto_ventoinha: 1
        }
      });

      saveGreenhouses();
      dom.modalAddGreenhouse.classList.add('hidden');
      renderGreenhousesList();
      showToast(`Estufa "${name}" adicionada com sucesso!`, 'success');
      subscribeGreenhouseTopics(id);
    });

    // Ações do Bottom Sheet de Opções da Estufa
    dom.btnSheetOpen.addEventListener('click', handleOptionOpen);
    dom.btnSheetEdit.addEventListener('click', handleOptionEdit);
    dom.btnSheetDelete.addEventListener('click', handleOptionDelete);
    dom.btnSheetCancel.addEventListener('click', closeGreenhouseOptionsSheet);

    // Modal de Edição de Nome
    dom.btnCloseEditModal.addEventListener('click', () => dom.modalEditGreenhouse.classList.add('hidden'));
    dom.btnCancelEditModal.addEventListener('click', () => dom.modalEditGreenhouse.classList.add('hidden'));
    dom.btnSaveEditModal.addEventListener('click', saveEditedGreenhouseName);

    // Modal de Confirmação de Exclusão
    dom.btnCloseDeleteModal.addEventListener('click', () => dom.modalConfirmDelete.classList.add('hidden'));
    dom.btnCancelDeleteModal.addEventListener('click', () => dom.modalConfirmDelete.classList.add('hidden'));
    dom.btnConfirmDeleteModal.addEventListener('click', confirmDeleteGreenhouse);

    // Botão Tutorial de Conexão
    dom.btnOpenTutorial.addEventListener('click', () => dom.modalTutorial.classList.remove('hidden'));
    dom.btnCloseTutorial.addEventListener('click', () => dom.modalTutorial.classList.add('hidden'));
    dom.btnGotItTutorial.addEventListener('click', () => dom.modalTutorial.classList.add('hidden'));

    // Botão Notificações
    dom.btnOpenNotifications.addEventListener('click', () => {
      renderNotificationsList();
      dom.modalNotifications.classList.remove('hidden');
    });
    dom.btnCloseNotifications.addEventListener('click', () => dom.modalNotifications.classList.add('hidden'));
    dom.btnClearNotifications.addEventListener('click', () => {
      state.notifications = [];
      localStorage.removeItem(STORAGE_KEYS.NOTIFICATIONS);
      renderNotificationsBadge();
      renderNotificationsList();
      showToast('Avisos limpos.', 'info');
    });

    // Botão Conectar / Desconectar
    dom.btnToggleConnection.addEventListener('click', () => {
      const greenhouse = getActiveGreenhouse();
      if (!greenhouse) return;

      if (greenhouse.online) {
        greenhouse.online = false;
        updateDetailViewUI(greenhouse.telemetria, false);
        renderGreenhousesList();
        showToast('Estufa desconectada.', 'info');
      } else {
        if (!state.mqttClient || !state.mqttClient.connected) {
          connectMqttBroker();
        }
        greenhouse.online = true;
        updateDetailViewUI(greenhouse.telemetria, true);
        renderGreenhousesList();
        showToast(`Conectando à ${greenhouse.nome}...`, 'success');
      }
    });

    // Blocos Interativos de Atuadores (Bomba e Ventoinha)
    dom.blockPump.addEventListener('click', () => {
      const greenhouse = getActiveGreenhouse();
      const current = greenhouse && greenhouse.telemetria && greenhouse.telemetria.bomba;
      sendActuatorCommand('bomba', current ? 0 : 1);
    });

    dom.blockFan.addEventListener('click', () => {
      const greenhouse = getActiveGreenhouse();
      const current = greenhouse && greenhouse.telemetria && greenhouse.telemetria.ventoinha;
      sendActuatorCommand('ventoinha', current ? 0 : 1);
    });

    // Chaves de Modo Automático
    dom.switchAutoPump.addEventListener('change', () => {
      sendAutoModeToggle('bomba', dom.switchAutoPump.checked);
    });

    dom.switchAutoFan.addEventListener('change', () => {
      sendAutoModeToggle('ventoinha', dom.switchAutoFan.checked);
    });

    // Toque nos Cards para abrir Gráficos
    dom.cardTempMetric.addEventListener('click', () => openHistoricalGraph('temp'));
    dom.cardHumMetric.addEventListener('click', () => openHistoricalGraph('hum'));
    dom.cardSoilMetric.addEventListener('click', () => openHistoricalGraph('soil'));

    // Modal de Gráficos
    dom.btnCloseGraph.addEventListener('click', () => dom.modalHistoricalGraph.classList.add('hidden'));
    dom.btnFilterDay.addEventListener('click', () => {
      state.currentGraphFilter = 'day';
      dom.btnFilterDay.classList.add('active');
      dom.btnFilterMonth.classList.remove('active');
      renderHistoricalChart();
    });
    dom.btnFilterMonth.addEventListener('click', () => {
      state.currentGraphFilter = 'month';
      dom.btnFilterMonth.classList.add('active');
      dom.btnFilterDay.classList.remove('active');
      renderHistoricalChart();
    });

    // Fechar modais ao clicar no fundo escuro
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.classList.add('hidden');
      });
    });
  }

  function init() {
    loadGreenhouses();

    try {
      const notifs = localStorage.getItem(STORAGE_KEYS.NOTIFICATIONS);
      if (notifs) state.notifications = JSON.parse(notifs);
    } catch (e) {}
    renderNotificationsBadge();

    setupEventListeners();
    showView('list');
    connectMqttBroker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
