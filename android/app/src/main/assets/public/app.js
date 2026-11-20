/**
 * =========================================================================================
 * AGROLINK - APLICATIVO ANDROID OFICIAL DEFINITIVO
 * Script Principal: app.js
 * Comunicação: Bluetooth Clássico (HC-05) + Sensor Ultrassônico + Sincronização Offline
 * =========================================================================================
 * 
 * Funcionalidades:
 *  - Comunicação serial direta via Bluetooth HC-05 (ponte nativa Android e modo simulador)
 *  - Sincronização em lote estilo smartwatch (Log Offline acumulado quando desconectado)
 *  - Monitoramento do Nível de Água em tempo real com Sensor Ultrassônico HC-SR04
 *  - Trava de segurança ativa: impede acionamento da bomba se o reservatório estiver crítico
 *  - Gerenciamento de múltiplas estufas com long press e menu de opções
 *  - Gráficos históricos locais via IndexedDB (visão Dia e Mês, com detecção de estufa offline)
 *  - Interface 100% livre de referências Wi-Fi/MQTT e classificações de frutas
 * =========================================================================================
 */

(function () {
  'use strict';

  // Chaves de Armazenamento Local
  const STORAGE_KEYS = {
    GREENHOUSES: 'agrolink_estufas_v3',
    ACTIVE_GREENHOUSE: 'agrolink_active_greenhouse_v3',
    HISTORY_PREFIX: 'agrolink_history_v3_',
    NOTIFICATIONS: 'agrolink_notifications_v3',
    LAST_BT_DEVICE: 'agrolink_last_bt_device'
  };

  // Estufas Padrão de Inicialização
  const DEFAULT_GREENHOUSES = [
    {
      id: 'estufa_01',
      nome: 'Estufa 1 (Principal)',
      online: false,
      telemetria: {
        temp: 24.5,
        umidade_ar: 68,
        umidade_solo: 72,
        nivel_agua: 85,
        dist_cm: 7,
        status_agua: 'OK',
        bomba: 0,
        ventoinha: 0,
        auto_bomba: 1,
        auto_ventoinha: 1
      }
    },
    {
      id: 'estufa_02',
      nome: 'Estufa 2 (Secundária)',
      online: false,
      telemetria: {
        temp: 23.0,
        umidade_ar: 70,
        umidade_solo: 65,
        nivel_agua: 78,
        dist_cm: 9,
        status_agua: 'OK',
        bomba: 0,
        ventoinha: 0,
        auto_bomba: 1,
        auto_ventoinha: 1
      }
    }
  ];

  // Estado Central da Aplicação
  const state = {
    greenhouses: [],
    activeGreenhouseId: null,
    selectedOptionGreenhouseId: null,

    // Conexão Bluetooth HC-05
    bluetooth: {
      connected: false,
      isSyncing: false,
      connectedDeviceName: null,
      connectedDeviceAddress: null,
      syncTotal: 0,
      syncCount: 0,
      pairedDevices: []
    },

    // Controle de espera por confirmação de comando (estado intermediário piscando)
    pendingAck: {
      bomba: { waiting: false, timer: null, targetState: null },
      ventoinha: { waiting: false, timer: null, targetState: null },
      auto_bomba: { waiting: false, timer: null, targetState: null },
      auto_ventoinha: { waiting: false, timer: null, targetState: null }
    },

    // Dedup de leituras: evita gravar duas vezes o mesmo timestamp (ex.: sync_item repetido)
    lastSavedTimestamp: {},

    // Controle do Gráfico Histórico
    currentGraphMetric: 'temp', // 'temp', 'hum', 'soil'
    currentGraphFilter: 'day',  // 'day', 'month'
    chartRenderedPoints: [],    // Pontos ativos desenhados no canvas {t, val, x, y}
    chartGaps: [],              // Lacunas detectadas de períodos offline
    historyCache: {},           // Cache em memória de histórico por estufa

    // Notificações
    notifications: []
  };

  // Referências dos Elementos do DOM
  const dom = {
    // Header & Navegação
    btnBrandHome: document.getElementById('btnBrandHome'),
    headerSubtitle: document.getElementById('headerSubtitle'),
    headerBtIndicator: document.getElementById('headerBtIndicator'),
    headerBtText: document.getElementById('headerBtText'),
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

    // Card de Conexão Bluetooth HC-05
    btActionCard: document.getElementById('btActionCard'),
    btIconBadge: document.getElementById('btIconBadge'),
    btCardTitle: document.getElementById('btCardTitle'),
    btCardSubtitle: document.getElementById('btCardSubtitle'),
    btnToggleConnection: document.getElementById('btnToggleConnection'),
    btnConnectionLabel: document.getElementById('btnConnectionLabel'),
    btnManualSync: document.getElementById('btnManualSync'),

    // Banner de Sincronização Offline
    syncBanner: document.getElementById('syncBanner'),
    syncProgressText: document.getElementById('syncProgressText'),

    // Solo & Bomba
    cardSoilMetric: document.getElementById('cardSoilMetric'),
    valSoil: document.getElementById('valSoil'),
    badgeSoil: document.getElementById('badgeSoil'),
    soilBarFill: document.getElementById('soilBarFill'),
    blockPump: document.getElementById('blockPump'),
    pumpStateBadge: document.getElementById('pumpStateBadge'),
    pumpWaitingText: document.getElementById('pumpWaitingText'),
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
    fanWaitingText: document.getElementById('fanWaitingText'),
    switchAutoFan: document.getElementById('switchAutoFan'),

    // Reservatório de Água (Sensor Ultrassônico HC-SR04)
    valWaterPercent: document.getElementById('valWaterPercent'),
    valWaterDist: document.getElementById('valWaterDist'),
    valWaterLevel: document.getElementById('valWaterLevel'),
    waterLevelDesc: document.getElementById('waterLevelDesc'),
    waterVisualTank: document.getElementById('waterVisualTank'),
    waterTankLiquid: document.getElementById('waterTankLiquid'),

    // Modal de Dispositivos Bluetooth HC-05
    modalBluetoothDevices: document.getElementById('modalBluetoothDevices'),
    btDevicesList: document.getElementById('btDevicesList'),
    btnCloseBtModal: document.getElementById('btnCloseBtModal'),
    btnCancelBtModal: document.getElementById('btnCancelBtModal'),
    btnRefreshBtDevices: document.getElementById('btnRefreshBtDevices'),
    btnConnectDemoBt: document.getElementById('btnConnectDemoBt'),

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
    graphStatCompliance: document.getElementById('graphStatCompliance'),
    chartTooltip: document.getElementById('chartTooltip'),
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
  // GESTÃO DE ESTUFAS (STORAGE & MEMÓRIA)
  // =========================================================================================

  function loadGreenhouses() {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.GREENHOUSES);
      if (stored) {
        state.greenhouses = JSON.parse(stored);
      } else {
        state.greenhouses = JSON.parse(JSON.stringify(DEFAULT_GREENHOUSES));
        saveGreenhouses();
      }
    } catch (e) {
      console.warn('Erro ao carregar estufas:', e);
      state.greenhouses = JSON.parse(JSON.stringify(DEFAULT_GREENHOUSES));
    }

    const savedActive = localStorage.getItem(STORAGE_KEYS.ACTIVE_GREENHOUSE);
    if (savedActive && state.greenhouses.some(g => g.id === savedActive)) {
      state.activeGreenhouseId = savedActive;
    } else if (state.greenhouses.length > 0) {
      state.activeGreenhouseId = state.greenhouses[0].id;
    }
  }

  function saveGreenhouses() {
    try {
      localStorage.setItem(STORAGE_KEYS.GREENHOUSES, JSON.stringify(state.greenhouses));
    } catch (e) {
      console.warn('Erro ao salvar estufas:', e);
    }
  }

  function getActiveGreenhouse() {
    return state.greenhouses.find(g => g.id === state.activeGreenhouseId) || null;
  }

  function getGreenhouseById(id) {
    return state.greenhouses.find(g => g.id === id) || null;
  }

  // =========================================================================================
  // SISTEMA DE TOASTS E NOTIFICAÇÕES VISUAIS
  // =========================================================================================

  function showToast(mensagem, tipo = 'info', duracaoMs = 3200) {
    if (!dom.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast-item ${tipo}`;

    const icon = (tipo === 'success') ? '✅' : (tipo === 'error' ? '⚠️' : 'ℹ️');
    toast.innerHTML = `
      <span class="toast-icon">${icon}</span>
      <span class="toast-msg">${mensagem}</span>
    `;

    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, duracaoMs);
  }

  function addNotification(titulo, mensagem, tipo = 'info') {
    const notif = {
      id: Date.now() + Math.random().toString(16).substring(2, 6),
      titulo,
      mensagem,
      tipo,
      horario: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };

    state.notifications.unshift(notif);
    if (state.notifications.length > 30) state.notifications.pop();

    try {
      localStorage.setItem(STORAGE_KEYS.NOTIFICATIONS, JSON.stringify(state.notifications));
    } catch (e) {}

    renderNotificationsBadge();
    renderNotificationsList();
  }

  function renderNotificationsBadge() {
    if (!dom.notificationBadge) return;
    if (state.notifications.length > 0) {
      dom.notificationBadge.textContent = state.notifications.length;
      dom.notificationBadge.classList.remove('hidden');
    } else {
      dom.notificationBadge.classList.add('hidden');
    }
  }

  function renderNotificationsList() {
    if (!dom.notificationsList) return;
    if (state.notifications.length === 0) {
      dom.notificationsList.innerHTML = '<div class="empty-notif">Nenhum aviso no momento. Sua estufa está operando em parâmetros normais.</div>';
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
  // BANCO DE DADOS LOCAL ROBUSTO (INDEXEDDB COM RETENÇÃO PERSISTENTE E RESILIÊNCIA)
  // =========================================================================================

  const AgroLinkDB = {
    DB_NAME: 'AgroLink_IoT_DB',
    DB_VERSION: 1,
    STORE_NAME: 'telemetry_logs',
    db: null,

    init() {
      return new Promise((resolve) => {
        if (!window.indexedDB) {
          console.warn('[AgroLinkDB] IndexedDB não suportado. Usando modo de resiliência local.');
          return resolve(false);
        }

        try {
          const req = window.indexedDB.open(this.DB_NAME, this.DB_VERSION);

          req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(this.STORE_NAME)) {
              const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'id', autoIncrement: true });
              store.createIndex('greenhouse_id', 'greenhouse_id', { unique: false });
              store.createIndex('timestamp', 'timestamp', { unique: false });
              store.createIndex('gh_time', ['greenhouse_id', 'timestamp'], { unique: false });
            }
          };

          req.onsuccess = (e) => {
            this.db = e.target.result;
            this.purgeOldRecords(90); // Auto-expiração inteligente após 90 dias
            resolve(true);
          };

          req.onerror = (e) => {
            console.warn('[AgroLinkDB] Erro ao abrir IndexedDB:', e);
            resolve(false);
          };
        } catch (err) {
          console.warn('[AgroLinkDB] Exceção ao inicializar IndexedDB:', err);
          resolve(false);
        }
      });
    },

    saveReading(greenhouseId, telemetria) {
      if (!greenhouseId || !telemetria) return;
      const now = telemetria.timestamp || Date.now();

      // DEDUP: ignora leituras duplicadas (mesmo timestamp já persistido nesta estufa)
      if (state.lastSavedTimestamp[greenhouseId] === now) return;
      state.lastSavedTimestamp[greenhouseId] = now;

      const entry = {
        greenhouse_id: greenhouseId,
        timestamp: now,
        temp: parseFloat(telemetria.temp) || 0,
        hum: parseInt(telemetria.umidade_ar, 10) || 0,
        soil: parseInt(telemetria.umidade_solo, 10) || 0,
        water: parseInt(telemetria.nivel_agua, 10) || 0
      };

      // 1. Gravação no IndexedDB
      if (this.db) {
        try {
          const tx = this.db.transaction([this.STORE_NAME], 'readwrite');
          const store = tx.objectStore(this.STORE_NAME);
          store.add(entry);
        } catch (e) {
          console.warn('[AgroLinkDB] Erro ao persistir leitura no IndexedDB:', e);
        }
      }

      // 2. Cache em memória para resposta instantânea na UI
      if (!state.historyCache[greenhouseId]) {
        state.historyCache[greenhouseId] = [];
      }
      state.historyCache[greenhouseId].push({
        t: now,
        temp: entry.temp,
        hum: entry.hum,
        soil: entry.soil,
        water: entry.water
      });

      // Mantém ordenado por timestamp
      state.historyCache[greenhouseId].sort((a, b) => a.t - b.t);

      if (state.historyCache[greenhouseId].length > 4000) {
        state.historyCache[greenhouseId].shift();
      }

      // 3. Backup de snapshot recente no localStorage
      try {
        const recent = state.historyCache[greenhouseId].slice(-500);
        localStorage.setItem(STORAGE_KEYS.HISTORY_PREFIX + greenhouseId, JSON.stringify(recent));
      } catch (e) {}
    },

    async getHistory(greenhouseId, startTime, endTime) {
      // 1. Tenta recuperar do IndexedDB
      if (this.db) {
        try {
          const list = await new Promise((resolve) => {
            const tx = this.db.transaction([this.STORE_NAME], 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const index = store.index('gh_time');
            const range = IDBKeyRange.bound([greenhouseId, startTime], [greenhouseId, endTime]);
            const req = index.getAll(range);

            req.onsuccess = () => {
              const res = (req.result || []).map(r => ({
                t: r.timestamp,
                temp: r.temp,
                hum: r.hum,
                soil: r.soil,
                water: r.water || 80
              }));
              resolve(res);
            };

            req.onerror = () => resolve([]);
          });

          if (list && list.length > 0) return list;
        } catch (e) {
          console.warn('[AgroLinkDB] Falha na consulta indexada do IndexedDB:', e);
        }
      }

      // 2. Fallback de cache em memória ou localStorage
      let cached = state.historyCache[greenhouseId];
      if (!cached || cached.length === 0) {
        try {
          const stored = localStorage.getItem(STORAGE_KEYS.HISTORY_PREFIX + greenhouseId);
          if (stored) {
            cached = JSON.parse(stored);
            state.historyCache[greenhouseId] = cached;
          }
        } catch (e) {}
      }

      if (Array.isArray(cached)) {
        return cached.filter(r => r.t >= startTime && r.t <= endTime);
      }
      return [];
    },

    purgeOldRecords(daysToKeep) {
      if (!this.db) return;
      try {
        const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
        const tx = this.db.transaction([this.STORE_NAME], 'readwrite');
        const store = tx.objectStore(this.STORE_NAME);
        const index = store.index('timestamp');
        const range = IDBKeyRange.upperBound(cutoff);
        const req = index.openCursor(range);

        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            store.delete(cursor.primaryKey);
            cursor.continue();
          }
        };
      } catch (e) {}
    }
  };

  async function ensureSeedHistory(greenhouseId) {
    const now = Date.now();
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
    const existing = await AgroLinkDB.getHistory(greenhouseId, thirtyDaysAgo, now);
    if (existing && existing.length > 10) return existing;

    const seed = [];
    const oneDay = 24 * 60 * 60 * 1000;
    const interval = 25 * 60 * 1000; // a cada 25 minutos

    for (let t = thirtyDaysAgo; t <= now; t += interval) {
      const d = new Date(t);
      const hour = d.getHours();
      const daysAgo = Math.floor((now - t) / oneDay);

      // Simulação realista de lacunas offline (sem telemetria):
      // 1. Queda de energia há 2 dias atrás das 13h às 18h
      if (daysAgo === 2 && hour >= 13 && hour <= 18) continue;
      // 2. Estufa desligada na madrugada de ontem das 02h às 05h
      if (daysAgo === 1 && hour >= 2 && hour <= 5) continue;
      // 3. Estufa desligada hoje das 03h às 05h da madrugada
      if (daysAgo === 0 && hour >= 3 && hour <= 5) continue;

      // Variação agronômica diurna e noturna real:
      const dayCycle = Math.sin(((hour - 9) / 24) * 2 * Math.PI);
      const temp = +(24.2 + dayCycle * 3.5 + (Math.random() - 0.5) * 0.6).toFixed(1);
      const hum = Math.round(70 - dayCycle * 7 + (Math.random() - 0.5) * 3);
      const soil = Math.round(68 + Math.sin(t / (4 * 3600000)) * 6 + (Math.random() - 0.5) * 2);
      const water = Math.round(82 - (daysAgo * 0.5) + (Math.random() - 0.5) * 2);

      seed.push({ t, temp, hum, soil, water });
    }

    state.historyCache[greenhouseId] = seed;
    try {
      localStorage.setItem(STORAGE_KEYS.HISTORY_PREFIX + greenhouseId, JSON.stringify(seed.slice(-500)));
    } catch (e) {}

    if (AgroLinkDB.db) {
      try {
        const tx = AgroLinkDB.db.transaction([AgroLinkDB.STORE_NAME], 'readwrite');
        const store = tx.objectStore(AgroLinkDB.STORE_NAME);
        seed.forEach(item => {
          store.add({
            greenhouse_id: greenhouseId,
            timestamp: item.t,
            temp: item.temp,
            hum: item.hum,
            soil: item.soil,
            water: item.water
          });
        });
      } catch (e) {}
    }

    return seed;
  }

  // =========================================================================================
  // GERENCIADOR DE COMUNICAÇÃO BLUETOOTH CLÁSSICO (HC-05) & SINCRONIZAÇÃO OFFLINE
  // =========================================================================================

  const BluetoothManager = {
    isSimulator: false,
    simTimer: null,
    simOfflineData: [],

    init() {
      // Registra callbacks globais para o bridge nativo do Android
      window.onBluetoothDataReceived = (line) => {
        this.handleDataReceived(line);
      };

      window.onBluetoothStatusChanged = (status, details) => {
        this.handleStatusChanged(status, details);
      };

      if (window.AndroidBluetooth && window.AndroidBluetooth.isBluetoothSupported()) {
        console.log('[AgroLink BT] Ponte nativa AndroidBluetooth conectada.');
      } else {
        console.log('[AgroLink BT] Modo navegador web / simulador disponível.');
      }
    },

    openDevicePicker() {
      if (!dom.modalBluetoothDevices) {
        showToast('Interface de seleção de Bluetooth indisponível.', 'error');
        return;
      }
      dom.modalBluetoothDevices.classList.remove('hidden');
      this.refreshDeviceList();
    },

    closeDevicePicker() {
      if (dom.modalBluetoothDevices) dom.modalBluetoothDevices.classList.add('hidden');
    },

    refreshDeviceList() {
      if (!dom.btDevicesList) return;
      dom.btDevicesList.innerHTML = '<div class="bt-device-loading">Procurando dispositivos pareados no celular...</div>';

      if (window.AndroidBluetooth && window.AndroidBluetooth.isBluetoothSupported()) {
        try {
          const raw = window.AndroidBluetooth.getPairedDevices();
          const list = JSON.parse(raw);
          state.bluetooth.pairedDevices = list;
          this.renderPairedDevices(list);
          return;
        } catch (e) {
          console.warn('Erro ao obter dispositivos pareados:', e);
        }
      }

      // Em ambiente de navegador web: lista dispositivo simulado
      dom.btDevicesList.innerHTML = `
        <div class="bt-device-item" role="button" id="simulatedDeviceItem">
          <div class="bt-device-meta">
            <strong>HC-05 (Estufa Inteligente AgroLink)</strong>
            <small>98:D3:31:FD:A2:14 · Módulo Bluetooth SPP</small>
          </div>
          <button class="btn btn-primary btn-sm">Conectar</button>
        </div>
      `;

      const simItem = document.getElementById('simulatedDeviceItem');
      if (simItem) {
        simItem.addEventListener('click', () => {
          this.connectToDevice('98:D3:31:FD:A2:14', 'HC-05 (Estufa AgroLink)');
        });
      }
    },

    renderPairedDevices(devices) {
      if (!dom.btDevicesList) return;
      if (!devices || devices.length === 0) {
        dom.btDevicesList.innerHTML = `
          <div class="bt-device-loading">
            Nenhum módulo Bluetooth pareado encontrado.<br/>
            <small style="color: #94a3b8;">Vá em Configurações > Bluetooth do seu celular, pareie com o <strong>HC-05</strong> (PIN 1234 ou 0000) e volte aqui!</small>
          </div>
        `;
        return;
      }

      dom.btDevicesList.innerHTML = '';
      devices.forEach(dev => {
        const item = document.createElement('div');
        item.className = 'bt-device-item';
        item.innerHTML = `
          <div class="bt-device-meta">
            <strong>${dev.name || 'Dispositivo HC-05'}</strong>
            <small>${dev.address}</small>
          </div>
          <button class="btn btn-primary btn-sm">Conectar</button>
        `;
        item.addEventListener('click', () => {
          this.connectToDevice(dev.address, dev.name);
        });
        dom.btDevicesList.appendChild(item);
      });
    },

    connectToDevice(address, name) {
      this.closeDevicePicker();
      showToast(`Conectando ao módulo Bluetooth "${name || 'HC-05'}"...`, 'info');

      if (window.AndroidBluetooth && window.AndroidBluetooth.isBluetoothSupported()) {
        this.isSimulator = false;
        window.AndroidBluetooth.connect(address);
      } else {
        this.startSimulatedConnection(name || 'HC-05');
      }
    },

    disconnect() {
      if (this.isSimulator) {
        this.stopSimulatedConnection();
      } else if (window.AndroidBluetooth) {
        window.AndroidBluetooth.disconnect();
      }
      this.handleStatusChanged('disconnected', 'Conexão encerrada pelo usuário.');
    },

    sendCommand(cmd) {
      let wireCmd = '';
      let cmdObj = null;

      if (typeof cmd === 'string') {
        wireCmd = cmd.trim();
        if (wireCmd === 'B1') cmdObj = { cmd: 'bomba', val: 1 };
        else if (wireCmd === 'B0') cmdObj = { cmd: 'bomba', val: 0 };
        else if (wireCmd === 'V1') cmdObj = { cmd: 'ventoinha', val: 1 };
        else if (wireCmd === 'V0') cmdObj = { cmd: 'ventoinha', val: 0 };
        else if (wireCmd === 'A1') cmdObj = { cmd: 'auto_bomba', val: 1 };
        else if (wireCmd === 'A0') cmdObj = { cmd: 'auto_bomba', val: 0 };
        else if (wireCmd === 'C1') cmdObj = { cmd: 'auto_ventoinha', val: 1 };
        else if (wireCmd === 'C0') cmdObj = { cmd: 'auto_ventoinha', val: 0 };
        else if (wireCmd === 'S' || wireCmd.toLowerCase() === 'sync') cmdObj = { cmd: 'sync' };
        else if (wireCmd === 'T' || wireCmd.toLowerCase() === 'status') cmdObj = { cmd: 'status' };
        else cmdObj = { cmd: wireCmd };
      } else if (typeof cmd === 'object' && cmd !== null) {
        cmdObj = cmd;
        if (cmd.cmd === 'bomba') wireCmd = (cmd.val === 1) ? 'B1' : 'B0';
        else if (cmd.cmd === 'ventoinha') wireCmd = (cmd.val === 1) ? 'V1' : 'V0';
        else if (cmd.cmd === 'auto_bomba') wireCmd = (cmd.val === 1) ? 'A1' : 'A0';
        else if (cmd.cmd === 'auto_ventoinha') wireCmd = (cmd.val === 1) ? 'C1' : 'C0';
        else if (cmd.cmd === 'sync') wireCmd = 'S';
        else if (cmd.cmd === 'status') wireCmd = 'T';
        else wireCmd = JSON.stringify(cmd);
      }

      console.log(`[Bluetooth Outgoing] -> "${wireCmd}"`);

      if (this.isSimulator) {
        this.handleSimulatedCommand(cmdObj || { cmd: wireCmd });
        return true;
      } else if (window.AndroidBluetooth && state.bluetooth.connected) {
        return window.AndroidBluetooth.send(wireCmd);
      }
      return false;
    },

    requestOfflineSync() {
      showToast('Solicitando lote de histórico offline ao Arduino...', 'info');
      this.sendCommand({ cmd: 'sync' });
    },

    handleStatusChanged(status, details) {
      const active = getActiveGreenhouse();

      if (status === 'connected') {
        state.bluetooth.connected = true;
        state.bluetooth.connectedDeviceName = details;
        if (active) active.online = true;

        showToast(`Bluetooth Conectado com Sucesso! (${details})`, 'success');
        updateBluetoothUI('connected', details);
        renderGreenhousesList();
        if (active) updateDetailViewUI(active.telemetria, true);
      }
      else if (status === 'disconnected') {
        state.bluetooth.connected = false;
        state.bluetooth.isSyncing = false;
        if (active) active.online = false;

        updateBluetoothUI('disconnected');
        renderGreenhousesList();
        if (active) updateDetailViewUI(active.telemetria, false);
      }
      else if (status === 'connecting') {
        updateBluetoothUI('connecting');
      }
      else if (status === 'error') {
        showToast(details || 'Falha na conexão Bluetooth.', 'error');
        this.handleStatusChanged('disconnected', details);
      }
    },

    handleDataReceived(line) {
      if (!line) return;
      line = line.trim();

      try {
        const data = JSON.parse(line);
        const active = getActiveGreenhouse();

        // CASO 1: Início de descarregamento de Lote Offline (Estilo Smartwatch)
        if (data.sync_start !== undefined) {
          state.bluetooth.isSyncing = true;
          state.bluetooth.syncTotal = data.sync_start;
          state.bluetooth.syncCount = 0;

          updateBluetoothUI('syncing');
          if (dom.syncBanner) dom.syncBanner.classList.remove('hidden');
          if (dom.syncProgressText) dom.syncProgressText.textContent = `Recebendo 0 de ${data.sync_start} leituras acumuladas...`;
          showToast(`Sincronizando ${data.sync_start} leituras históricas gravadas offline...`, 'info');
          return;
        }

        // CASO 2: Item individual do lote offline recebido
        if (data.sync_item) {
          const item = data.sync_item;
          state.bluetooth.syncCount++;

          const realTime = Date.now() - (item.t_offset * 1000);

          if (active) {
            AgroLinkDB.saveReading(active.id, {
              temp: item.temp,
              umidade_ar: item.umidade_ar,
              umidade_solo: item.umidade_solo,
              nivel_agua: item.nivel_agua,
              bomba: item.bomba,
              ventoinha: item.ventoinha,
              timestamp: realTime
            });
          }

          if (dom.syncProgressText) dom.syncProgressText.textContent = `Recebendo ${state.bluetooth.syncCount} de ${state.bluetooth.syncTotal} leituras acumuladas...`;
          return;
        }

        // CASO 3: Término da sincronização offline
        if (data.sync_end) {
          state.bluetooth.isSyncing = false;
          if (dom.syncBanner) dom.syncBanner.classList.add('hidden');
          updateBluetoothUI('connected', state.bluetooth.connectedDeviceName);

          showToast(`Sincronização offline concluída! ${data.count || state.bluetooth.syncCount} leituras recuperadas.`, 'success');

          if (active && active.telemetria) {
            updateDetailViewUI(active.telemetria, true);
          }
          if (dom.modalHistoricalGraph && !dom.modalHistoricalGraph.classList.contains('hidden')) {
            renderHistoricalChart();
          }
          return;
        }

        // CASO 4: Confirmação de Ação (ACK)
        if (data.ack) {
          handleActionAck(data);
          return;
        }

        // CASO 5: Pacote de Telemetria em Tempo Real
        if (data.temp !== undefined && data.umidade_solo !== undefined) {
          if (active) {
            active.online = true;
            active.telemetria = data;

            // Se havia comando pendente e a telemetria já reflete o novo estado, conclui o ACK
            ['bomba', 'ventoinha'].forEach(act => {
              if (state.pendingAck[act] && state.pendingAck[act].waiting) {
                const actVal = (data[act] === 1 || data[act] === true || data[act] === '1') ? 1 : 0;
                if (actVal === state.pendingAck[act].targetState) {
                  state.pendingAck[act].waiting = false;
                  if (state.pendingAck[act].timer) {
                    clearTimeout(state.pendingAck[act].timer);
                    state.pendingAck[act].timer = null;
                  }
                  const el = (act === 'bomba') ? dom.blockPump : dom.blockFan;
                  if (el) el.classList.remove('waiting');
                }
              }
            });

            AgroLinkDB.saveReading(active.id, data);
            checkIntelligentTriggers(active, data);
            updateDetailViewUI(data, true);

            if (dom.modalHistoricalGraph && !dom.modalHistoricalGraph.classList.contains('hidden')) {
              renderHistoricalChart();
            }
          }
          renderGreenhousesList();
        }

      } catch (e) {
        console.warn('[Bluetooth Raw]:', line);
      }
    },

    // --- MODO SIMULADOR INTERATIVO (TESTES NO NAVEGADOR) ---
    startSimulatedConnection(deviceName) {
      this.isSimulator = true;
      this.handleStatusChanged('connecting');

      setTimeout(() => {
        this.handleStatusChanged('connected', deviceName || 'HC-05 Simulado');

        // Simula recebimento de lote offline (3 leituras acumuladas) para demonstrar a sincronização
        setTimeout(() => {
          this.handleDataReceived('{"sync_start":4}');
          let count = 0;
          const syncInterval = setInterval(() => {
            count++;
            const tOffset = (5 - count) * 30; // 120s, 90s, 60s, 30s atrás
            this.handleDataReceived(JSON.stringify({
              sync_item: {
                t_offset: tOffset,
                temp: +(23.8 + count * 0.2).toFixed(1),
                umidade_ar: 68 - count,
                umidade_solo: 70 - count,
                nivel_agua: 84,
                bomba: 0,
                ventoinha: 0
              }
            }));

            if (count >= 4) {
              clearInterval(syncInterval);
              this.handleDataReceived('{"sync_end":true,"count":4}');
            }
          }, 350);
        }, 1200);

        // Ciclo de telemetria contínua via Bluetooth simulado a cada 1.5s
        if (this.simTimer) clearInterval(this.simTimer);
        this.simTimer = setInterval(() => {
          if (!state.bluetooth.connected) return;
          const active = getActiveGreenhouse();
          if (!active) return;

          const tel = active.telemetria || {};
          const nextTemp = +(24.2 + (Math.random() - 0.5) * 0.8).toFixed(1);
          const nextHum = Math.min(85, Math.max(50, Math.round(68 + (Math.random() - 0.5) * 2)));

          // Comportamento dinâmico da água e bomba
          let nextSoil = tel.umidade_solo || 70;
          let nextWater = tel.nivel_agua || 85;
          let distCm = Math.round(mapRange(nextWater, 0, 100, 25, 4));

          if (tel.bomba) {
            nextSoil = Math.min(82, nextSoil + 2);
            nextWater = Math.max(10, nextWater - 0.2); // Consome água ao regar
            if (nextSoil >= 78) tel.bomba = 0;
          } else {
            nextSoil = Math.max(32, nextSoil - 0.2);
            if (tel.auto_bomba && nextSoil < 40 && nextWater > 15) {
              tel.bomba = 1;
            }
          }

          if (tel.auto_ventoinha && nextTemp > 30.0) tel.ventoinha = 1;
          if (nextTemp < 27.0) tel.ventoinha = 0;

          const packet = {
            temp: nextTemp,
            umidade_ar: nextHum,
            umidade_solo: Math.round(nextSoil),
            nivel_agua: Math.round(nextWater),
            dist_cm: distCm,
            status_agua: nextWater <= 15 ? 'BAIXO' : 'OK',
            bomba: tel.bomba ? 1 : 0,
            ventoinha: tel.ventoinha ? 1 : 0,
            auto_bomba: tel.auto_bomba ? 1 : 0,
            auto_ventoinha: tel.auto_ventoinha ? 1 : 0,
            bt_online: 1
          };

          this.handleDataReceived(JSON.stringify(packet));
        }, 1800);

      }, 600);
    },

    stopSimulatedConnection() {
      this.isSimulator = false;
      if (this.simTimer) {
        clearInterval(this.simTimer);
        this.simTimer = null;
      }
    },

    handleSimulatedCommand(cmdObj) {
      const active = getActiveGreenhouse();
      if (!active || !active.telemetria) return;

      setTimeout(() => {
        if (cmdObj.cmd === 'bomba') {
          // Trava de segurança no simulador se não houver água
          if (cmdObj.val === 1 && active.telemetria.nivel_agua <= 15) {
            this.handleDataReceived(JSON.stringify({ ack: 'bomba', estado: 0, status: 'bloqueado_sem_agua' }));
            return;
          }
          active.telemetria.bomba = cmdObj.val;
          this.handleDataReceived(JSON.stringify({ ack: 'bomba', estado: cmdObj.val, status: 'ok' }));
        }
        else if (cmdObj.cmd === 'ventoinha') {
          active.telemetria.ventoinha = cmdObj.val;
          this.handleDataReceived(JSON.stringify({ ack: 'ventoinha', estado: cmdObj.val, status: 'ok' }));
        }
        else if (cmdObj.cmd === 'auto_bomba') {
          active.telemetria.auto_bomba = cmdObj.val;
          this.handleDataReceived(JSON.stringify({ ack: 'auto_bomba', estado: cmdObj.val, status: 'ok' }));
        }
        else if (cmdObj.cmd === 'auto_ventoinha') {
          active.telemetria.auto_ventoinha = cmdObj.val;
          this.handleDataReceived(JSON.stringify({ ack: 'auto_ventoinha', estado: cmdObj.val, status: 'ok' }));
        }
        else if (cmdObj.cmd === 'sync') {
          showToast('Buffer offline vazio no momento.', 'info');
        }
      }, 150);
    }
  };

  function mapRange(value, inMin, inMax, outMin, outMax) {
    return (value - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
  }

  // =========================================================================================
  // ATUALIZAÇÃO DA INTERFACE VISUAL DE BLUETOOTH E DETALHES
  // =========================================================================================

  function updateBluetoothUI(status, deviceName) {
    if (status === 'connected') {
      // 1. Indicador do Header (Verde)
      dom.headerBtIndicator.className = 'header-bt-indicator connected';
      dom.headerBtText.textContent = 'Conectado';

      // 2. Status Pill da Barra de Detalhe
      dom.detailStatusDot.className = 'status-indicator-dot connected';
      dom.detailStatusText.textContent = 'Bluetooth Conectado';

      // 3. Card de Ação Principal
      dom.btIconBadge.className = 'bt-icon-badge connected';
      dom.btCardTitle.textContent = `Conectado ao ${deviceName || 'HC-05'}`;
      dom.btCardSubtitle.textContent = 'Comunicação serial ativa e dados em tempo real';
      dom.btnConnectionLabel.textContent = 'Desconectar';
      dom.btnManualSync.classList.remove('hidden');
    }
    else if (status === 'syncing') {
      // 1. Indicador do Header (Azul Pulsante)
      dom.headerBtIndicator.className = 'header-bt-indicator syncing';
      dom.headerBtText.textContent = 'Sincronizando';

      // 2. Status Pill da Barra de Detalhe
      dom.detailStatusDot.className = 'status-indicator-dot syncing';
      dom.detailStatusText.textContent = 'Sincronizando Dados...';

      // 3. Card de Ação Principal
      dom.btIconBadge.className = 'bt-icon-badge syncing';
      dom.btCardTitle.textContent = 'Sincronizando Dados Offline';
      dom.btCardSubtitle.textContent = 'Descarregando histórico acumulado da memória interna...';
      dom.btnConnectionLabel.textContent = 'Sincronizando...';
      dom.btnManualSync.classList.add('hidden');
    }
    else if (status === 'connecting') {
      dom.headerBtIndicator.className = 'header-bt-indicator disconnected';
      dom.headerBtText.textContent = 'Conectando...';

      dom.detailStatusDot.className = 'status-indicator-dot disconnected';
      dom.detailStatusText.textContent = 'Pareando...';

      dom.btIconBadge.className = 'bt-icon-badge disconnected';
      dom.btCardTitle.textContent = 'Conectando ao Bluetooth...';
      dom.btCardSubtitle.textContent = 'Aguarde o pareamento serial com o módulo HC-05';
      dom.btnConnectionLabel.textContent = 'Conectando...';
      dom.btnManualSync.classList.add('hidden');
    }
    else {
      // Desconectado (Cinza)
      dom.headerBtIndicator.className = 'header-bt-indicator disconnected';
      dom.headerBtText.textContent = 'Desconectado';

      dom.detailStatusDot.className = 'status-indicator-dot disconnected';
      dom.detailStatusText.textContent = 'Bluetooth Desconectado';

      dom.btIconBadge.className = 'bt-icon-badge disconnected';
      dom.btCardTitle.textContent = 'Bluetooth Desconectado';
      dom.btCardSubtitle.textContent = 'Toque em Conectar para parear com o HC-05 da estufa';
      dom.btnConnectionLabel.textContent = 'Conectar HC-05';
      dom.btnManualSync.classList.add('hidden');
    }
  }

  function updateDetailViewUI(data, isOnline) {
    const greenhouse = getActiveGreenhouse();
    if (!greenhouse) return;

    greenhouse.online = !!isOnline;
    if (data) greenhouse.telemetria = data;

    // Atualiza estado do Bluetooth na interface
    if (state.bluetooth.isSyncing) {
      updateBluetoothUI('syncing');
    } else {
      updateBluetoothUI(isOnline ? 'connected' : 'disconnected', state.bluetooth.connectedDeviceName);
    }

    if (!data) return;

    // 1. Umidade do Solo (Faixa Agronômica Ideal: 60% a 80%)
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

    // 2. Temperatura do Ar (Ideal Agronômico: 20°C a 30°C)
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

    // 3. Umidade do Ar (Ideal Agronômico: 60% a 80%)
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

    // 4. Reservatório de Água (Sensor Ultrassônico HC-SR04)
    const waterPct = Math.max(0, Math.min(100, parseInt(data.nivel_agua, 10) || 0));
    dom.valWaterPercent.textContent = `${waterPct}%`;
    dom.waterTankLiquid.style.height = `${waterPct}%`;

    const distCm = data.dist_cm !== undefined ? data.dist_cm : Math.round(mapRange(waterPct, 0, 100, 25, 4));
    dom.valWaterDist.textContent = `${distCm} cm`;

    const isWaterLow = (waterPct <= 15 || data.status_agua === 'BAIXO' || data.falta_agua === 1);
    if (isWaterLow) {
      dom.valWaterLevel.textContent = 'NÍVEL CRÍTICO';
      dom.valWaterLevel.className = 'water-status-pill critical';
      dom.waterLevelDesc.textContent = 'Atenção: Nível abaixo do mínimo seguro! Bomba bloqueada.';
      dom.waterVisualTank.className = 'water-visual-tank critical';
      dom.pumpSafetyBanner.classList.remove('hidden');
    } else {
      dom.valWaterLevel.textContent = 'Nível Seguro';
      dom.valWaterLevel.className = 'water-status-pill';
      dom.waterLevelDesc.textContent = `Distância da lâmina d'água: ${distCm} cm. Abastecimento seguro.`;
      dom.waterVisualTank.className = 'water-visual-tank ok';
      dom.pumpSafetyBanner.classList.add('hidden');
    }

    // 5. Atuador: Bomba d'Água (Se não estiver aguardando confirmação)
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

    // 6. Atuador: Ventoinha (Se não estiver aguardando confirmação)
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

    // 7. Chaves de Automático
    if (data.auto_bomba !== undefined) {
      dom.switchAutoPump.checked = (data.auto_bomba === 1 || data.auto_bomba === true);
    }
    if (data.auto_ventoinha !== undefined) {
      dom.switchAutoFan.checked = (data.auto_ventoinha === 1 || data.auto_ventoinha === true);
    }
  }

  function checkIntelligentTriggers(greenhouse, data) {
    const soil = parseInt(data.umidade_solo, 10);
    const waterPct = parseInt(data.nivel_agua, 10);
    const isWaterLow = (waterPct <= 15 || data.status_agua === 'BAIXO');

    if (soil < 40 && data.bomba === 1 && (!greenhouse._lastAlertSolo || Date.now() - greenhouse._lastAlertSolo > 60000)) {
      greenhouse._lastAlertSolo = Date.now();
      addNotification(greenhouse.nome, 'Solo seco detectado. Irrigação ligada automaticamente.', 'info');
    }

    if (isWaterLow && (!greenhouse._lastAlertAgua || Date.now() - greenhouse._lastAlertAgua > 90000)) {
      greenhouse._lastAlertAgua = Date.now();
      addNotification(greenhouse.nome, 'Atenção: Nível de água crítico no reservatório!', 'warning');
    }
  }

  // =========================================================================================
  // ENVIO DE COMANDOS DE ATUADORES VIA BLUETOOTH COM FEEDBACK VISUAL
  // =========================================================================================

  function sendActuatorCommand(atuador, novoEstado) {
    const greenhouse = getActiveGreenhouse();
    if (!greenhouse) return;

    // TRAVA 1: SE O BLUETOOTH ESTIVER DESCONECTADO
    if (!state.bluetooth.connected) {
      showToast('Estufa desconectada. Selecione o HC-05 para conectar.', 'warning');
      BluetoothManager.openDevicePicker();
      return;
    }

    // TRAVA 2: TRAVA DE SEGURANÇA CRÍTICA - RESERVATÓRIO SEM ÁGUA
    if (atuador === 'bomba' && novoEstado === 1) {
      const isWaterLow = (greenhouse.telemetria && (greenhouse.telemetria.nivel_agua <= 15 || greenhouse.telemetria.status_agua === 'BAIXO'));
      if (isWaterLow) {
        showToast('Trava de segurança: Reservatório vazio! A bomba não pode ser ligada para evitar queima a seco.', 'error');
        return;
      }
    }

    // Se já estiver aguardando confirmação do mesmo atuador, não sobrescreve
    if (state.pendingAck[atuador] && state.pendingAck[atuador].waiting) {
      showToast(`Aguardando confirmação da ${atuador === 'bomba' ? 'Bomba' : 'Ventoinha'}...`, 'info');
      return;
    }

    // Ativa estado intermediário piscando
    const blockEl = (atuador === 'bomba') ? dom.blockPump : dom.blockFan;
    blockEl.classList.add('waiting');

    state.pendingAck[atuador].waiting = true;
    state.pendingAck[atuador].targetState = novoEstado;

    if (state.pendingAck[atuador].timer) {
      clearTimeout(state.pendingAck[atuador].timer);
    }

    state.pendingAck[atuador].timer = setTimeout(() => {
      if (state.pendingAck[atuador].waiting) {
        state.pendingAck[atuador].waiting = false;
        blockEl.classList.remove('waiting');
        showToast(`Tempo esgotado: Sem resposta da estufa para a ${atuador === 'bomba' ? 'Bomba' : 'Ventoinha'}.`, 'error');
        if (greenhouse.telemetria) updateDetailViewUI(greenhouse.telemetria, greenhouse.online);
      }
    }, 4000);

    BluetoothManager.sendCommand({
      cmd: atuador,
      val: novoEstado
    });
  }

  function handleActionAck(data) {
    const atuador = data.ack;
    if (!atuador) return;

    if (state.pendingAck[atuador]) {
      state.pendingAck[atuador].waiting = false;
      if (state.pendingAck[atuador].timer) {
        clearTimeout(state.pendingAck[atuador].timer);
        state.pendingAck[atuador].timer = null;
      }
    }

    if (data.status === 'bloqueado_sem_agua') {
      showToast('Bloqueado: Reservatório sem água! A bomba foi desativada por segurança.', 'error');
      return;
    }

    const greenhouse = getActiveGreenhouse();

    // ACK de modo automático (auto_bomba / auto_ventoinha): atualiza a chave correspondente
    if (atuador === 'auto_bomba' || atuador === 'auto_ventoinha') {
      const isOn = (data.estado === 1 || data.estado === true);
      if (greenhouse && greenhouse.telemetria) {
        greenhouse.telemetria[atuador] = isOn ? 1 : 0;
      }
      if (atuador === 'auto_bomba' && dom.switchAutoPump) dom.switchAutoPump.checked = isOn;
      if (atuador === 'auto_ventoinha' && dom.switchAutoFan) dom.switchAutoFan.checked = isOn;
      showToast(`Confirmação: Modo automático da ${atuador === 'auto_bomba' ? 'Bomba' : 'Ventoinha'} ${isOn ? 'ATIVADO' : 'DESATIVADO'}!`, 'success');
      return;
    }

    const blockEl = (atuador === 'bomba') ? dom.blockPump : dom.blockFan;
    if (blockEl) blockEl.classList.remove('waiting');

    if (greenhouse && greenhouse.telemetria) {
      greenhouse.telemetria[atuador] = data.estado;
      updateDetailViewUI(greenhouse.telemetria, greenhouse.online);
    }

    showToast(`Confirmação recebida: ${atuador === 'bomba' ? 'Bomba de Água' : 'Ventoinha'} ${data.estado === 1 ? 'LIGADA' : 'DESLIGADA'}!`, 'success');
  }

  function sendAutoModeToggle(atuador, ativado) {
    const greenhouse = getActiveGreenhouse();
    if (!greenhouse) return;

    if (!state.bluetooth.connected) {
      showToast('Estufa desconectada. Conecte o Bluetooth para alterar configurações.', 'warning');
      BluetoothManager.openDevicePicker();
      if (greenhouse.telemetria) {
        if (atuador === 'bomba' && greenhouse.telemetria.auto_bomba !== undefined) {
          dom.switchAutoPump.checked = !!greenhouse.telemetria.auto_bomba;
        } else if (atuador === 'ventoinha' && greenhouse.telemetria.auto_ventoinha !== undefined) {
          dom.switchAutoFan.checked = !!greenhouse.telemetria.auto_ventoinha;
        }
      }
      return;
    }

    BluetoothManager.sendCommand({
      cmd: `auto_${atuador}`,
      val: ativado ? 1 : 0
    });

    showToast(`Modo automático da ${atuador === 'bomba' ? 'Bomba' : 'Ventoinha'} ${ativado ? 'ativado' : 'desativado'}.`, 'info');
  }

  // =========================================================================================
  // RENDERIZAÇÃO DO GERENCIADOR DE ESTUFAS (MULTI-ESTUFA)
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
      const waterDisplay = tel.nivel_agua ? `${tel.nivel_agua}%` : '--';

      card.innerHTML = `
        <div class="unit-top-row">
          <div class="unit-avatar-box">
            <img src="assets/logo.png" alt="Estufa">
          </div>
          <div class="unit-top-actions">
            <span class="unit-status-pill ${greenhouse.online ? 'online' : 'offline'}">
              ${greenhouse.online ? '● Conectada' : '○ Desconectada'}
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
            <span>Solo</span>
            <strong>${soilDisplay}</strong>
          </div>
          <div class="summary-item">
            <span>Água</span>
            <strong>${waterDisplay}</strong>
          </div>
        </div>
      `;

      // Botão ⋮
      const btnMore = card.querySelector('.btn-card-more');
      btnMore.addEventListener('click', (e) => {
        e.stopPropagation();
        openGreenhouseOptionsSheet(greenhouse.id);
      });

      // Long press & clique
      let pressTimer = null;
      let isMoved = false;
      let isLongPressed = false;

      const startPress = () => {
        isMoved = false;
        isLongPressed = false;
        pressTimer = setTimeout(() => {
          isLongPressed = true;
          if (navigator.vibrate) navigator.vibrate(40);
          openGreenhouseOptionsSheet(greenhouse.id);
        }, 550);
      };

      const cancelPress = () => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      };

      card.addEventListener('touchstart', startPress, { passive: true });
      card.addEventListener('touchmove', () => { isMoved = true; cancelPress(); });
      card.addEventListener('touchend', (e) => {
        cancelPress();
        if (!isMoved && !isLongPressed) {
          e.preventDefault();
          openGreenhouseDetail(greenhouse.id);
        }
      });

      card.addEventListener('mousedown', startPress);
      card.addEventListener('mousemove', () => { isMoved = true; cancelPress(); });
      card.addEventListener('mouseup', () => {
        cancelPress();
        if (!isMoved && !isLongPressed) {
          openGreenhouseDetail(greenhouse.id);
        }
      });
      card.addEventListener('mouseleave', cancelPress);

      dom.greenhousesGrid.appendChild(card);
    });

    if (dom.onlineCountBadge) {
      dom.onlineCountBadge.textContent = `${onlineCount} Conectada${onlineCount !== 1 ? 's' : ''}`;
    }
  }

  function openGreenhouseOptionsSheet(greenhouseId) {
    state.selectedOptionGreenhouseId = greenhouseId;
    const greenhouse = getGreenhouseById(greenhouseId);
    if (!greenhouse) return;

    dom.optionsSheetTitle.textContent = greenhouse.nome;
    dom.optionsSheetSubtitle.textContent = `Identificador: ${greenhouse.id}`;
    dom.modalGreenhouseOptions.classList.remove('hidden');
  }

  function closeGreenhouseOptionsSheet() {
    dom.modalGreenhouseOptions.classList.add('hidden');
    state.selectedOptionGreenhouseId = null;
  }

  function handleOptionOpen() {
    const id = state.selectedOptionGreenhouseId;
    closeGreenhouseOptionsSheet();
    if (id) openGreenhouseDetail(id);
  }

  function handleOptionEdit() {
    const id = state.selectedOptionGreenhouseId;
    closeGreenhouseOptionsSheet();
    const greenhouse = getGreenhouseById(id);
    if (!greenhouse) return;

    dom.inputEditGreenhouseName.value = greenhouse.nome;
    dom.modalEditGreenhouse.classList.remove('hidden');
    dom.inputEditGreenhouseName.focus();
  }

  function handleOptionDelete() {
    const id = state.selectedOptionGreenhouseId;
    closeGreenhouseOptionsSheet();
    const greenhouse = getGreenhouseById(id);
    if (!greenhouse) return;

    if (state.greenhouses.length <= 1) {
      showToast('Você deve manter pelo menos uma estufa cadastrada no aplicativo.', 'warning');
      return;
    }

    dom.deleteConfirmText.textContent = `Tem certeza que deseja remover a "${greenhouse.nome}"?`;
    state.selectedOptionGreenhouseId = id;
    dom.modalConfirmDelete.classList.remove('hidden');
  }

  function confirmDeleteGreenhouse() {
    const id = state.selectedOptionGreenhouseId;
    dom.modalConfirmDelete.classList.add('hidden');
    if (!id) return;

    state.greenhouses = state.greenhouses.filter(g => g.id !== id);
    saveGreenhouses();

    if (state.activeGreenhouseId === id) {
      state.activeGreenhouseId = state.greenhouses[0] ? state.greenhouses[0].id : null;
    }

    renderGreenhousesList();
    showToast('Estufa excluída com sucesso.', 'info');
  }

  function saveEditedGreenhouseName() {
    const id = state.activeGreenhouseId || state.selectedOptionGreenhouseId;
    const newName = dom.inputEditGreenhouseName.value.trim();
    if (!newName) {
      showToast('O nome da estufa não pode ficar em branco.', 'error');
      return;
    }

    const greenhouse = state.greenhouses.find(g => g.id === (state.selectedOptionGreenhouseId || state.activeGreenhouseId));
    if (greenhouse) {
      greenhouse.nome = newName;
      saveGreenhouses();
      dom.modalEditGreenhouse.classList.add('hidden');
      renderGreenhousesList();
      if (greenhouse.id === state.activeGreenhouseId) {
        dom.activeGreenhouseName.textContent = newName;
      }
      showToast(`Nome atualizado para "${newName}"!`, 'success');
    }
  }

  function showView(viewName) {
    if (viewName === 'detail') {
      dom.viewGreenhousesList.classList.remove('active');
      dom.viewGreenhouseDetail.classList.add('active');
    } else {
      dom.viewGreenhouseDetail.classList.remove('active');
      dom.viewGreenhousesList.classList.add('active');
    }
  }

  function openGreenhouseDetail(greenhouseId) {
    const greenhouse = getGreenhouseById(greenhouseId);
    if (!greenhouse) return;

    state.activeGreenhouseId = greenhouseId;
    localStorage.setItem(STORAGE_KEYS.ACTIVE_GREENHOUSE, greenhouseId);

    dom.activeGreenhouseName.textContent = greenhouse.nome;
    dom.activeGreenhouseId.textContent = `ID: ${greenhouse.id}`;

    showView('detail');
    updateDetailViewUI(greenhouse.telemetria, greenhouse.online);
  }

  // =========================================================================================
  // GRÁFICOS HISTÓRICOS INTERATIVOS COM TRATAMENTO DE PERÍODOS OFFLINE
  // =========================================================================================

  async function openHistoricalGraph(metricType) {
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

    // Atualiza indicador "Tempo Real"
    const liveBadge = document.querySelector('.graph-live-badge');
    if (liveBadge) {
      liveBadge.style.display = greenhouse.online ? 'inline-flex' : 'none';
    }

    await ensureSeedHistory(greenhouse.id);
    await renderHistoricalChart();
    dom.modalHistoricalGraph.classList.remove('hidden');
  }

  async function renderHistoricalChart() {
    const canvas = dom.historicalChartCanvas;
    if (!canvas) return;
    const greenhouse = getActiveGreenhouse();
    if (!greenhouse) return;

    const now = Date.now();
    const isDay = (state.currentGraphFilter === 'day');
    const periodMs = isDay ? (24 * 60 * 60 * 1000) : (30 * 24 * 60 * 60 * 1000);
    const startTime = now - periodMs;
    const endTime = now;

    let rawReadings = await AgroLinkDB.getHistory(greenhouse.id, startTime, endTime);

    // Para visão mensal: agrega por dia com médias ponderadas
    let readings;
    if (!isDay && rawReadings.length > 200) {
      const dayBuckets = {};
      rawReadings.forEach(r => {
        const dayKey = new Date(r.t).toISOString().slice(0, 10);
        if (!dayBuckets[dayKey]) dayBuckets[dayKey] = [];
        dayBuckets[dayKey].push(r);
      });

      readings = Object.entries(dayBuckets)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dayKey, points]) => {
          const count = points.length;
          const midTimestamp = points[Math.floor(count / 2)].t;
          return {
            t: midTimestamp,
            temp: +(points.reduce((s, p) => s + p.temp, 0) / count).toFixed(1),
            hum: Math.round(points.reduce((s, p) => s + p.hum, 0) / count),
            soil: Math.round(points.reduce((s, p) => s + p.soil, 0) / count),
            _dayPoints: count,
            _dayMinTemp: Math.min(...points.map(p => p.temp)),
            _dayMaxTemp: Math.max(...points.map(p => p.temp)),
            _dayMinHum: Math.min(...points.map(p => p.hum)),
            _dayMaxHum: Math.max(...points.map(p => p.hum)),
            _dayMinSoil: Math.min(...points.map(p => p.soil)),
            _dayMaxSoil: Math.max(...points.map(p => p.soil))
          };
        });
    } else {
      readings = rawReadings;
    }

    // Ajuste DPR para telas OLED/Retina
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = 520;
    const displayHeight = 260;
    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, displayWidth, displayHeight);

    if (!readings || readings.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Nenhum dado registrado para o período.', displayWidth / 2, displayHeight / 2);
      dom.graphStatMin.textContent = '--';
      dom.graphStatAvg.textContent = '--';
      dom.graphStatMax.textContent = '--';
      if (dom.graphStatCompliance) dom.graphStatCompliance.textContent = '--%';
      state.chartRenderedPoints = [];
      state.chartGaps = [];
      return;
    }

    const metric = state.currentGraphMetric;
    const unit = (metric === 'temp') ? '°C' : '%';

    // Faixas Ideais Agronômicas Reais
    let idealMin = 20, idealMax = 30; // Temperatura (°C)
    if (metric === 'hum') { idealMin = 60; idealMax = 80; }  // Umidade do Ar (%)
    if (metric === 'soil') { idealMin = 60; idealMax = 80; } // Umidade do Solo (%)

    // Estatísticas sobre dados brutos
    const rawValues = rawReadings.map(r => r[metric]);
    const values = rawValues;
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const avgVal = values.reduce((acc, v) => acc + v, 0) / values.length;

    const inIdealCount = values.filter(v => v >= idealMin && v <= idealMax).length;
    const complianceRate = Math.round((inIdealCount / values.length) * 100);

    dom.graphStatMin.textContent = `${minVal.toFixed(1)}${unit}`;
    dom.graphStatAvg.textContent = `${avgVal.toFixed(1)}${unit}`;
    dom.graphStatMax.textContent = `${maxVal.toFixed(1)}${unit}`;
    if (dom.graphStatCompliance) {
      dom.graphStatCompliance.textContent = `${complianceRate}%`;
      dom.graphStatCompliance.style.color = (complianceRate >= 80) ? '#10b981' : (complianceRate >= 50 ? '#f59e0b' : '#ef4444');
    }

    const padding = { top: 25, right: 25, bottom: 35, left: 45 };
    const chartW = displayWidth - padding.left - padding.right;
    const chartH = displayHeight - padding.top - padding.bottom;

    const chartMin = Math.min(idealMin - 4, minVal - 2);
    const chartMax = Math.max(idealMax + 4, maxVal + 2);

    const getY = (val) => padding.top + chartH - ((val - chartMin) / (chartMax - chartMin)) * chartH;
    const getX = (t) => padding.left + ((t - startTime) / (endTime - startTime)) * chartW;

    // 1. Faixa Agronômica Ideal Sombreada
    const yIdealTop = getY(idealMax);
    const yIdealBottom = getY(idealMin);

    const idealGrad = ctx.createLinearGradient(0, yIdealTop, 0, yIdealBottom);
    idealGrad.addColorStop(0, 'rgba(16, 185, 129, 0.16)');
    idealGrad.addColorStop(1, 'rgba(16, 185, 129, 0.08)');
    ctx.fillStyle = idealGrad;
    ctx.fillRect(padding.left, yIdealTop, chartW, yIdealBottom - yIdealTop);

    ctx.strokeStyle = 'rgba(16, 185, 129, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padding.left, yIdealTop);
    ctx.lineTo(padding.left + chartW, yIdealTop);
    ctx.moveTo(padding.left, yIdealBottom);
    ctx.lineTo(padding.left + chartW, yIdealBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(16, 185, 129, 0.8)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`Ideal (${idealMin}-${idealMax}${unit})`, padding.left + chartW - 4, yIdealTop - 4);

    // 2. Grade de Fundo e Escala Numérica do Eixo Y
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + chartH);
    ctx.lineTo(padding.left + chartW, padding.top + chartH);
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${chartMax.toFixed(0)}${unit}`, padding.left - 6, padding.top + 8);
    ctx.fillText(`${((chartMax + chartMin) / 2).toFixed(0)}${unit}`, padding.left - 6, padding.top + chartH / 2 + 4);
    ctx.fillText(`${chartMin.toFixed(0)}${unit}`, padding.left - 6, padding.top + chartH);

    // 3. Marcações de Horários no Eixo X
    ctx.fillStyle = '#64748b';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';

    if (isDay) {
      const steps = 6;
      for (let s = 0; s <= steps; s++) {
        const stepTime = startTime + (periodMs / steps) * s;
        const xPos = getX(stepTime);
        const d = new Date(stepTime);
        const hours = String(d.getHours()).padStart(2, '0');
        const mins = String(d.getMinutes()).padStart(2, '0');
        const label = (s === steps) ? 'Agora' : `${hours}:${mins}`;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
        ctx.beginPath();
        ctx.moveTo(xPos, padding.top);
        ctx.lineTo(xPos, padding.top + chartH);
        ctx.stroke();

        ctx.fillText(label, xPos, padding.top + chartH + 16);
      }
    } else {
      const steps = 5;
      for (let s = 0; s <= steps; s++) {
        const stepTime = startTime + (periodMs / steps) * s;
        const xPos = getX(stepTime);
        const d = new Date(stepTime);
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const label = (s === steps) ? 'Hoje' : `${day}/${month}`;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
        ctx.beginPath();
        ctx.moveTo(xPos, padding.top);
        ctx.lineTo(xPos, padding.top + chartH);
        ctx.stroke();

        ctx.fillText(label, xPos, padding.top + chartH + 16);
      }
    }

    // 4. PLOTAGEM COM TRATAMENTO RÍGIDO DE PERÍODOS OFFLINE (GRÁFICO QUEBRADO)
    // Visão diária: >15 minutos sem leitura = Estufa Desconectada
    // Visão mensal: >36 horas entre pontos = dias offline
    const MAX_GAP_MS = isDay ? (15 * 60 * 1000) : (36 * 60 * 60 * 1000);

    const renderedPoints = [];
    const detectedGaps = [];

    readings.forEach(r => {
      const pt = {
        t: r.t,
        val: r[metric],
        x: getX(r.t),
        y: getY(r[metric])
      };
      if (r._dayPoints) {
        pt.dayPoints = r._dayPoints;
        const metricCap = metric.charAt(0).toUpperCase() + metric.slice(1);
        pt.dayMin = r['_dayMin' + metricCap] || r[metric];
        pt.dayMax = r['_dayMax' + metricCap] || r[metric];
      }
      renderedPoints.push(pt);
    });

    state.chartRenderedPoints = renderedPoints;

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#10b981';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    let isDrawing = false;

    for (let i = 0; i < renderedPoints.length; i++) {
      const pt = renderedPoints[i];

      if (i > 0) {
        const timeGap = pt.t - renderedPoints[i - 1].t;
        if (timeGap > MAX_GAP_MS) {
          if (isDrawing) {
            ctx.stroke();
            isDrawing = false;
          }

          const prev = renderedPoints[i - 1];
          detectedGaps.push({
            startT: prev.t,
            endT: pt.t,
            startX: prev.x,
            endX: pt.x,
            durationMs: timeGap
          });

          // A. Sombra translúcida no período offline
          ctx.fillStyle = 'rgba(239, 68, 68, 0.09)';
          ctx.fillRect(prev.x, padding.top, Math.max(2, pt.x - prev.x), chartH);

          // B. Linha pontilhada cinza transparente conectando os extremos
          ctx.beginPath();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
          ctx.lineWidth = 1.5;
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(pt.x, pt.y);
          ctx.stroke();
          ctx.setLineDash([]);

          // C. Marcadores de corte
          ctx.fillStyle = '#06100b';
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(prev.x, prev.y, 3.5, 0, Math.PI * 2);
          ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          // D. Etiqueta "OFFLINE"
          if (pt.x - prev.x > 45) {
            ctx.fillStyle = '#f87171';
            ctx.font = '8px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('⚡ OFFLINE', (prev.x + pt.x) / 2, padding.top + 22);
          }

          ctx.lineWidth = 2.5;
          ctx.strokeStyle = '#10b981';
        }
      }

      if (!isDrawing) {
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        isDrawing = true;
      } else {
        ctx.lineTo(pt.x, pt.y);
      }
    }
    if (isDrawing) ctx.stroke();

    state.chartGaps = detectedGaps;

    // Marcador pulsante no ponto mais recente
    if (renderedPoints.length > 0) {
      const last = renderedPoints[renderedPoints.length - 1];
      ctx.fillStyle = '#34d399';
      ctx.beginPath();
      ctx.arc(last.x, last.y, 4.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(52, 211, 153, 0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 7.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function setupChartInteractivity() {
    const canvas = dom.historicalChartCanvas;
    const tooltip = dom.chartTooltip;
    if (!canvas || !tooltip) return;

    function handlePointer(e) {
      if (!state.chartRenderedPoints || state.chartRenderedPoints.length === 0) return;
      const rect = canvas.getBoundingClientRect();
      const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : null);
      const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : null);
      if (clientX === null || clientY === null) return;

      const mouseX = clientX - rect.left;
      const mouseY = clientY - rect.top;

      const scaleX = 520 / rect.width;
      const logicalX = mouseX * scaleX;

      // 1. Verifica se o toque está sobre uma lacuna offline
      const inGap = (state.chartGaps || []).find(g => logicalX >= g.startX && logicalX <= g.endX);
      if (inGap) {
        const hours = Math.floor(inGap.durationMs / 3600000);
        const mins = Math.floor((inGap.durationMs % 3600000) / 60000);
        const durStr = hours > 0 ? `${hours}h ${mins}min` : `${mins} min`;

        tooltip.innerHTML = `
          <strong style="color: #f87171;">🔴 Estufa Desconectada</strong><br/>
          <small style="color: #94a3b8;">Duração: ${durStr} sem telemetria</small>
        `;
        tooltip.style.left = `${mouseX}px`;
        tooltip.style.top = `${mouseY}px`;
        tooltip.classList.remove('hidden');
        return;
      }

      // 2. Busca o ponto mais próximo
      let closest = null;
      let minDistance = Infinity;

      for (const pt of state.chartRenderedPoints) {
        const dist = Math.abs(pt.x - logicalX);
        if (dist < minDistance) {
          minDistance = dist;
          closest = pt;
        }
      }

      if (closest && minDistance < 50) {
        const metric = state.currentGraphMetric;
        const unit = (metric === 'temp') ? '°C' : '%';
        let idealMin = 20, idealMax = 30;
        if (metric === 'hum') { idealMin = 60; idealMax = 80; }
        if (metric === 'soil') { idealMin = 60; idealMax = 80; }

        const isIdeal = (closest.val >= idealMin && closest.val <= idealMax);
        const statusColor = isIdeal ? '#34d399' : '#f59e0b';
        const statusText = isIdeal ? '● Faixa Ideal' : (closest.val > idealMax ? '▲ Acima do Ideal' : '▼ Abaixo do Ideal');

        const d = new Date(closest.t);
        const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const dateStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;

        const isDayAggregate = closest.dayPoints && closest.dayPoints > 1;
        let tooltipBody;

        if (isDayAggregate) {
          tooltipBody = `
            <div style="font-size: 0.7rem; color: #94a3b8;">${dateStr} · Média do Dia (${closest.dayPoints} leituras)</div>
            <div style="font-size: 1.05rem; font-weight: 800; color: #ffffff;">${closest.val.toFixed(1)} ${unit}</div>
            <div style="font-size: 0.65rem; color: #94a3b8;">Mín: ${closest.dayMin.toFixed(1)}${unit} · Máx: ${closest.dayMax.toFixed(1)}${unit}</div>
            <div style="font-size: 0.7rem; font-weight: 700; color: ${statusColor};">${statusText}</div>
          `;
        } else {
          tooltipBody = `
            <div style="font-size: 0.7rem; color: #94a3b8;">${dateStr} às ${timeStr}</div>
            <div style="font-size: 1.05rem; font-weight: 800; color: #ffffff;">${closest.val.toFixed(1)} ${unit}</div>
            <div style="font-size: 0.7rem; font-weight: 700; color: ${statusColor};">${statusText}</div>
          `;
        }

        tooltip.innerHTML = tooltipBody;

        const ptScreenX = (closest.x / 520) * rect.width;
        const ptScreenY = (closest.y / 260) * rect.height;

        tooltip.style.left = `${ptScreenX}px`;
        tooltip.style.top = `${ptScreenY}px`;
        tooltip.classList.remove('hidden');
      } else {
        tooltip.classList.add('hidden');
      }
    }

    function hideTooltip() {
      tooltip.classList.add('hidden');
    }

    canvas.addEventListener('pointermove', handlePointer);
    canvas.addEventListener('pointerdown', handlePointer);
    canvas.addEventListener('pointerleave', hideTooltip);
    canvas.addEventListener('pointerup', hideTooltip);
    canvas.addEventListener('touchstart', handlePointer, { passive: true });
    canvas.addEventListener('touchmove', handlePointer, { passive: true });
    canvas.addEventListener('touchend', hideTooltip);
  }

  // =========================================================================================
  // CONFIGURAÇÃO DOS EVENT LISTENERS E INICIALIZAÇÃO
  // =========================================================================================

  // Helper: registra listener apenas se o elemento existir (evita null crash que
  // derrubava TODO o setupEventListeners e deixava todos os botões mortos)
  function on(el, event, handler, opts) {
    if (el) el.addEventListener(event, handler, opts);
    else console.warn('[AgroLink] Elemento não encontrado para evento "' + event + '"');
  }

  function setupEventListeners() {
    // Navegação
    on(dom.btnBrandHome, 'click', () => showView('list'));
    on(dom.btnBackToList, 'click', () => showView('list'));

    // Botão Conectar HC-05 / Desconectar
    on(dom.btnToggleConnection, 'click', () => {
      if (state.bluetooth.connected) {
        BluetoothManager.disconnect();
      } else {
        BluetoothManager.openDevicePicker();
      }
    });

    // Botão de Sincronização Manual de Dados Offline
    on(dom.btnManualSync, 'click', () => {
      BluetoothManager.requestOfflineSync();
    });

    // Modal de Dispositivos Bluetooth
    on(dom.btnCloseBtModal, 'click', () => BluetoothManager.closeDevicePicker());
    on(dom.btnCancelBtModal, 'click', () => BluetoothManager.closeDevicePicker());
    on(dom.btnRefreshBtDevices, 'click', () => BluetoothManager.refreshDeviceList());
    on(dom.btnConnectDemoBt, 'click', () => {
      BluetoothManager.closeDevicePicker();
      BluetoothManager.startSimulatedConnection('HC-05 Demo');
    });

    // Botão Adicionar Estufa (+)
    on(dom.btnAddGreenhouse, 'click', () => {
      dom.inputGreenhouseName.value = '';
      dom.inputGreenhouseId.value = `estufa_${state.greenhouses.length + 1}`;
      dom.modalAddGreenhouse.classList.remove('hidden');
    });

    on(dom.btnCloseAddModal, 'click', () => dom.modalAddGreenhouse.classList.add('hidden'));
    on(dom.btnCancelAddModal, 'click', () => dom.modalAddGreenhouse.classList.add('hidden'));

    on(dom.btnSaveGreenhouse, 'click', () => {
      const name = dom.inputGreenhouseName.value.trim();
      const id = dom.inputGreenhouseId.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

      if (!name || !id) {
        showToast('Preencha o nome e o código da estufa.', 'error');
        return;
      }

      if (state.greenhouses.some(g => g.id === id)) {
        showToast('Já existe uma estufa com esse código!', 'error');
        return;
      }

      state.greenhouses.push({
        id,
        nome: name,
        online: false,
        telemetria: {
          temp: 24.0,
          umidade_ar: 65,
          umidade_solo: 70,
          nivel_agua: 80,
          dist_cm: 8,
          status_agua: 'OK',
          bomba: 0,
          ventoinha: 0,
          auto_bomba: 1,
          auto_ventoinha: 1
        }
      });

      saveGreenhouses();
      dom.modalAddGreenhouse.classList.add('hidden');
      renderGreenhousesList();
      showToast(`Estufa "${name}" cadastrada!`, 'success');
    });

    // Opções do Bottom Sheet
    on(dom.btnSheetOpen, 'click', handleOptionOpen);
    on(dom.btnSheetEdit, 'click', handleOptionEdit);
    on(dom.btnSheetDelete, 'click', handleOptionDelete);
    on(dom.btnSheetCancel, 'click', closeGreenhouseOptionsSheet);

    // Modal de Edição de Nome
    on(dom.btnCloseEditModal, 'click', () => dom.modalEditGreenhouse.classList.add('hidden'));
    on(dom.btnCancelEditModal, 'click', () => dom.modalEditGreenhouse.classList.add('hidden'));
    on(dom.btnSaveEditModal, 'click', saveEditedGreenhouseName);

    // Modal de Confirmação de Exclusão
    on(dom.btnCloseDeleteModal, 'click', () => dom.modalConfirmDelete.classList.add('hidden'));
    on(dom.btnCancelDeleteModal, 'click', () => dom.modalConfirmDelete.classList.add('hidden'));
    on(dom.btnConfirmDeleteModal, 'click', confirmDeleteGreenhouse);

    // Tutorial de Conexão
    on(dom.btnOpenTutorial, 'click', () => dom.modalTutorial.classList.remove('hidden'));
    on(dom.btnCloseTutorial, 'click', () => dom.modalTutorial.classList.add('hidden'));
    on(dom.btnGotItTutorial, 'click', () => dom.modalTutorial.classList.add('hidden'));

    // Notificações
    on(dom.btnOpenNotifications, 'click', () => {
      renderNotificationsList();
      dom.modalNotifications.classList.remove('hidden');
    });
    on(dom.btnCloseNotifications, 'click', () => dom.modalNotifications.classList.add('hidden'));
    on(dom.btnClearNotifications, 'click', () => {
      state.notifications = [];
      localStorage.removeItem(STORAGE_KEYS.NOTIFICATIONS);
      renderNotificationsBadge();
      renderNotificationsList();
      showToast('Avisos limpos.', 'info');
    });

    // Atuadores: Bomba e Ventoinha com debounce e proteção contra duplo clique
    let lastTapActuator = 0;
    function triggerActuatorToggle(atuador) {
      const now = Date.now();
      if (now - lastTapActuator < 350) return;
      lastTapActuator = now;

      const greenhouse = getActiveGreenhouse();
      if (!greenhouse) return;

      if (!state.bluetooth.connected) {
        showToast('Estufa desconectada. Selecione o HC-05 para conectar.', 'warning');
        BluetoothManager.openDevicePicker();
        return;
      }

      if (state.pendingAck[atuador] && state.pendingAck[atuador].waiting) {
        showToast(`Aguardando confirmação da ${atuador === 'bomba' ? 'Bomba' : 'Ventoinha'}...`, 'info');
        return;
      }

      const current = greenhouse.telemetria ? (greenhouse.telemetria[atuador] === 1 || greenhouse.telemetria[atuador] === true || greenhouse.telemetria[atuador] === '1') : false;
      sendActuatorCommand(atuador, current ? 0 : 1);
    }

    on(dom.blockPump, 'click', (e) => {
      e.preventDefault();
      triggerActuatorToggle('bomba');
    });

    on(dom.blockFan, 'click', (e) => {
      e.preventDefault();
      triggerActuatorToggle('ventoinha');
    });

    // Chaves de Modo Automático
    on(dom.switchAutoPump, 'change', () => {
      sendAutoModeToggle('bomba', dom.switchAutoPump.checked);
    });

    on(dom.switchAutoFan, 'change', () => {
      sendAutoModeToggle('ventoinha', dom.switchAutoFan.checked);
    });

    // Abertura de Gráficos ao Tocar nos Cards
    on(dom.cardTempMetric, 'click', () => openHistoricalGraph('temp'));
    on(dom.cardHumMetric, 'click', () => openHistoricalGraph('hum'));
    on(dom.cardSoilMetric, 'click', () => openHistoricalGraph('soil'));

    // Controles do Gráfico
    on(dom.btnCloseGraph, 'click', () => dom.modalHistoricalGraph.classList.add('hidden'));
    on(dom.btnFilterDay, 'click', () => {
      state.currentGraphFilter = 'day';
      dom.btnFilterDay.classList.add('active');
      dom.btnFilterMonth.classList.remove('active');
      renderHistoricalChart();
    });
    on(dom.btnFilterMonth, 'click', () => {
      state.currentGraphFilter = 'month';
      dom.btnFilterMonth.classList.add('active');
      dom.btnFilterDay.classList.remove('active');
      renderHistoricalChart();
    });

    // Fechar modais ao clicar no backdrop escuro
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.classList.add('hidden');
      });
    });

    // Ativa a Interatividade Touch / Pointer e Tooltips no Gráfico
    setupChartInteractivity();
  }

  async function init() {
    loadGreenhouses();

    // Inicializa o Banco de Dados Local IndexedDB (resiliente e persistente)
    await AgroLinkDB.init();

    try {
      const notifs = localStorage.getItem(STORAGE_KEYS.NOTIFICATIONS);
      if (notifs) state.notifications = JSON.parse(notifs);
    } catch (e) {}
    renderNotificationsBadge();

    // Inicializa o Gerenciador de Bluetooth HC-05
    BluetoothManager.init();

    setupEventListeners();
    showView('list');
    renderGreenhousesList();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
