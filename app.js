/**
 * Estufa Inteligente - Single Page Application (SPA)
 * Conexão Bluetooth (Web Bluetooth BLE + Web Serial) & Modo Simulação
 */

(function () {
  'use strict';

  // UUIDs padrão para comunicação Serial via Bluetooth BLE (Nordic UART e HM-10)
  const BLE_SERVICES = {
    NUS_SERVICE: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    NUS_RX: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // Enviar para Arduino
    NUS_TX: '6e400003-b5a3-f393-e0a9-e50e24dcca9e', // Receber do Arduino
    HM10_SERVICE: '0000ffe0-0000-1000-8000-00805f9b34fb',
    HM10_CHAR: '0000ffe1-0000-1000-8000-00805f9b34fb'
  };

  const STORAGE_KEYS = {
    SIMULATION: 'greenhouse_simulation_mode',
    PREFERRED_MODE: 'greenhouse_conn_mode'
  };

  // Estado da aplicação
  const state = {
    config: {
      simulation: localStorage.getItem(STORAGE_KEYS.SIMULATION) === 'true',
      mode: localStorage.getItem(STORAGE_KEYS.PREFERRED_MODE) || 'ble' // 'ble' ou 'serial'
    },
    connected: false,
    deviceName: null,
    
    // Objetos de conexão BLE
    bleDevice: null,
    bleServer: null,
    bleRxChar: null, // escrita
    bleTxChar: null, // leitura
    
    // Objetos de conexão Web Serial (PC / Portas COM / USB)
    serialPort: null,
    serialReader: null,
    serialWriter: null,
    isReadingSerial: false,

    // Buffers de entrada
    rxBuffer: '',

    simTimer: null,
    lastData: null,
    lastUpdated: null,

    // Estado local para o Modo Simulação
    simulatedState: {
      temp: 24.8,
      umidade_ar: 58,
      umidade_solo: 42,
      nivel_agua: "OK",
      bomba: 0,
      ventoinha: 0
    }
  };

  // Referências dos Elementos do DOM
  const dom = {
    // Header & Status
    statusBadge: document.getElementById('statusBadge'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    headerBtBtn: document.getElementById('headerBtBtn'),
    openSettingsBtn: document.getElementById('openSettingsBtn'),
    connectionBanner: document.getElementById('connectionBanner'),
    bannerMessage: document.getElementById('bannerMessage'),
    bannerConfigBtn: document.getElementById('bannerConfigBtn'),
    lastUpdatedText: document.getElementById('lastUpdatedText'),
    currentDeviceCodeText: document.getElementById('currentDeviceCodeText'),
    livePill: document.getElementById('livePill'),

    // Card de Ação Bluetooth
    btActionCard: document.getElementById('btActionCard'),
    btIconWrapper: document.getElementById('btIconWrapper'),
    btCardTitle: document.getElementById('btCardTitle'),
    btCardSubtitle: document.getElementById('btCardSubtitle'),
    connectBtBtn: document.getElementById('connectBtBtn'),
    btBtnText: document.getElementById('btBtnText'),

    // Sensores
    valTemp: document.getElementById('valTemp'),
    badgeTemp: document.getElementById('badgeTemp'),
    valHumAir: document.getElementById('valHumAir'),
    badgeHumAir: document.getElementById('badgeHumAir'),
    valHumSoil: document.getElementById('valHumSoil'),
    badgeSoil: document.getElementById('badgeSoil'),
    soilProgressBar: document.getElementById('soilProgressBar'),
    valWater: document.getElementById('valWater'),
    waterSubText: document.getElementById('waterSubText'),
    waterIconIndicator: document.getElementById('waterIconIndicator'),
    waterTankVisual: document.getElementById('waterTankVisual'),

    // Atuadores
    activeActuatorsCount: document.getElementById('activeActuatorsCount'),
    cardPump: document.getElementById('cardPump'),
    pumpToggle: document.getElementById('pumpToggle'),
    pumpIconWrapper: document.getElementById('pumpIconWrapper'),
    pumpStateLabel: document.getElementById('pumpStateLabel'),
    pumpWaterWarning: document.getElementById('pumpWaterWarning'),

    cardFan: document.getElementById('cardFan'),
    fanToggle: document.getElementById('fanToggle'),
    fanIconWrapper: document.getElementById('fanIconWrapper'),
    fanSvg: document.getElementById('fanSvg'),
    fanStateLabel: document.getElementById('fanStateLabel'),

    // Modal
    settingsModal: document.getElementById('settingsModal'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    cancelSettingsBtn: document.getElementById('cancelSettingsBtn'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    btnModeBle: document.getElementById('btnModeBle'),
    btnModeSerial: document.getElementById('btnModeSerial'),
    simulationToggle: document.getElementById('simulationToggle'),
    disconnectBtModalBtn: document.getElementById('disconnectBtModalBtn'),
    testResultText: document.getElementById('testResultText'),

    // Toast
    toastContainer: document.getElementById('toastContainer')
  };

  /**
   * Notificação flutuante (Toast)
   */
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let iconSvg = '';
    if (type === 'success') {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    } else if (type === 'error') {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    } else {
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.5"><polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"></polyline></svg>`;
    }

    toast.innerHTML = `${iconSvg}<span>${message}</span>`;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 3200);
  }

  /**
   * Formata hora da última atualização
   */
  function formatCurrentTime() {
    return new Date().toLocaleTimeString('pt-BR', { hour12: false });
  }

  /**
   * Atualiza o estado visual da conexão
   */
  function setConnectionStatus(connected, deviceLabel = null) {
    state.connected = connected;

    if (state.config.simulation) {
      dom.statusDot.className = 'status-dot connected';
      dom.statusText.textContent = 'Simulado';
      dom.statusText.style.color = '#34d399';
      dom.livePill.textContent = 'MODO DEMO';
      dom.currentDeviceCodeText.textContent = 'SIMULADO';
      dom.btActionCard.className = 'bluetooth-action-card connected';
      dom.btCardTitle.textContent = 'Modo Demonstração Ativo';
      dom.btCardSubtitle.textContent = 'Testando interface localmente sem rádio físico';
      dom.btBtnText.textContent = 'Simulação Ativa';
      dom.connectionBanner.classList.add('hidden');
      return;
    }

    if (connected) {
      state.deviceName = deviceLabel || 'Arduino Bluetooth';
      dom.statusDot.className = 'status-dot bluetooth';
      dom.statusText.textContent = 'Bluetooth Conectado';
      dom.statusText.style.color = '#60a5fa';
      dom.livePill.textContent = 'AO VIVO';
      dom.currentDeviceCodeText.textContent = state.deviceName;

      dom.btActionCard.className = 'bluetooth-action-card connected';
      dom.btCardTitle.textContent = `Conectado: ${state.deviceName}`;
      dom.btCardSubtitle.textContent = 'Recebendo telemetria do Arduino em tempo real';
      dom.btBtnText.textContent = 'Desconectar';

      dom.connectionBanner.classList.add('hidden');
    } else {
      state.deviceName = null;
      dom.statusDot.className = 'status-dot disconnected';
      dom.statusText.textContent = 'Desconectado';
      dom.statusText.style.color = '#f87171';
      dom.livePill.textContent = 'OFFLINE';
      dom.currentDeviceCodeText.textContent = 'Nenhum dispositivo';

      dom.btActionCard.className = 'bluetooth-action-card';
      dom.btCardTitle.textContent = 'Bluetooth Desconectado';
      dom.btCardSubtitle.textContent = 'Toque para parear e conectar com o seu Arduino';
      dom.btBtnText.textContent = 'Conectar Bluetooth';

      dom.connectionBanner.classList.remove('hidden');
    }
  }

  /**
   * Atualiza a interface gráfica com os dados dos sensores
   */
  function updateUI(data) {
    if (!data) return;
    state.lastData = data;
    state.lastUpdated = new Date();

    dom.lastUpdatedText.textContent = formatCurrentTime();

    // 1. Temperatura do Ar (DHT11)
    const temp = parseFloat(data.temp);
    if (!isNaN(temp)) {
      dom.valTemp.textContent = temp.toFixed(1);
      if (temp < 18) {
        dom.badgeTemp.textContent = 'Frio (<18°C)';
        dom.badgeTemp.className = 'badge status-warning';
      } else if (temp <= 28) {
        dom.badgeTemp.textContent = 'Ideal (18°C - 28°C)';
        dom.badgeTemp.className = 'badge status-good';
      } else {
        dom.badgeTemp.textContent = 'Elevada (>28°C)';
        dom.badgeTemp.className = 'badge status-danger';
      }
    }

    // 2. Umidade do Ar (DHT11)
    const humAir = parseInt(data.umidade_ar, 10);
    if (!isNaN(humAir)) {
      dom.valHumAir.textContent = humAir;
      if (humAir < 40) {
        dom.badgeHumAir.textContent = 'Ar Seco (<40%)';
        dom.badgeHumAir.className = 'badge status-warning';
      } else if (humAir <= 75) {
        dom.badgeHumAir.textContent = 'Ideal (40% - 75%)';
        dom.badgeHumAir.className = 'badge status-good';
      } else {
        dom.badgeHumAir.textContent = 'Alta Umidade (>75%)';
        dom.badgeHumAir.className = 'badge status-warning';
      }
    }

    // 3. Umidade do Solo & Barra de Progresso
    const humSoil = Math.max(0, Math.min(100, parseInt(data.umidade_solo, 10) || 0));
    dom.valHumSoil.textContent = humSoil;
    dom.soilProgressBar.style.width = `${humSoil}%`;

    if (humSoil < 30) {
      dom.badgeSoil.textContent = 'Solo Seco (Irrigando!)';
      dom.badgeSoil.className = 'badge status-danger';
      dom.soilProgressBar.style.background = 'linear-gradient(90deg, #ef4444, #f97316)';
      dom.soilProgressBar.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.4)';
    } else if (humSoil <= 70) {
      dom.badgeSoil.textContent = 'Umidade Ideal';
      dom.badgeSoil.className = 'badge status-good';
      dom.soilProgressBar.style.background = 'linear-gradient(90deg, #10b981, #059669)';
      dom.soilProgressBar.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.4)';
    } else {
      dom.badgeSoil.textContent = 'Solo Saturado';
      dom.badgeSoil.className = 'badge status-warning';
      dom.soilProgressBar.style.background = 'linear-gradient(90deg, #06b6d4, #0284c7)';
      dom.soilProgressBar.style.boxShadow = '0 0 10px rgba(6, 182, 212, 0.4)';
    }

    // 4. Nível de Água (Boia)
    const isWaterOk = String(data.nivel_agua).trim().toUpperCase() === 'OK';
    if (isWaterOk) {
      dom.valWater.textContent = 'Nível Normal';
      dom.waterSubText.textContent = 'Reservatório abastecido';
      dom.waterIconIndicator.className = 'water-icon-indicator ok';
      dom.waterTankVisual.className = 'water-visual-tank ok';
      dom.pumpWaterWarning.classList.add('hidden');
    } else {
      dom.valWater.textContent = 'NÍVEL CRÍTICO';
      dom.waterSubText.textContent = 'Atenção: Reabastecer reservatório!';
      dom.waterIconIndicator.className = 'water-icon-indicator critical';
      dom.waterTankVisual.className = 'water-visual-tank critical';
      dom.pumpWaterWarning.classList.remove('hidden');
    }

    // 5. Atuador: Bomba de Água
    const isPumpOn = data.bomba === 1 || data.bomba === true || data.bomba === '1';
    dom.pumpToggle.checked = isPumpOn;
    if (isPumpOn) {
      dom.cardPump.classList.add('active');
      dom.pumpIconWrapper.classList.add('active');
      dom.pumpStateLabel.textContent = 'LIGADA';
      dom.pumpStateLabel.className = 'actuator-state-label active';
    } else {
      dom.cardPump.classList.remove('active');
      dom.pumpIconWrapper.classList.remove('active');
      dom.pumpStateLabel.textContent = 'DESLIGADA';
      dom.pumpStateLabel.className = 'actuator-state-label';
    }

    // 6. Atuador: Ventoinha (Cooler)
    const isFanOn = data.ventoinha === 1 || data.ventoinha === true || data.ventoinha === '1';
    dom.fanToggle.checked = isFanOn;
    if (isFanOn) {
      dom.cardFan.classList.add('active');
      dom.fanIconWrapper.classList.add('active');
      dom.fanSvg.classList.add('spinning');
      dom.fanStateLabel.textContent = 'LIGADA';
      dom.fanStateLabel.className = 'actuator-state-label active';
    } else {
      dom.cardFan.classList.remove('active');
      dom.fanIconWrapper.classList.remove('active');
      dom.fanSvg.classList.remove('spinning');
      dom.fanStateLabel.textContent = 'DESLIGADA';
      dom.fanStateLabel.className = 'actuator-state-label';
    }

    const activeCount = (isPumpOn ? 1 : 0) + (isFanOn ? 1 : 0);
    dom.activeActuatorsCount.textContent = `${activeCount} ${activeCount === 1 ? 'ativo' : 'ativos'}`;
  }

  /**
   * Processador de fluxo de texto recebido via Bluetooth
   */
  function processIncomingChunk(chunkText) {
    state.rxBuffer += chunkText;

    // Processa linhas completas terminadas em \n
    let lineEndIdx;
    while ((lineEndIdx = state.rxBuffer.indexOf('\n')) !== -1) {
      const line = state.rxBuffer.substring(0, lineEndIdx).trim();
      state.rxBuffer = state.rxBuffer.substring(lineEndIdx + 1);

      if (line.startsWith('{') && line.endsWith('}')) {
        try {
          const json = JSON.parse(line);
          updateUI(json);
        } catch (e) {
          console.warn('[BT] Linha JSON incompleta:', line);
        }
      }
    }
  }

  // =========================================================================================
  // CONEXÃO 1: WEB BLUETOOTH API (BLE - CHROME NO ANDROID / PC)
  // =========================================================================================
  async function connectWebBluetooth() {
    if (!navigator.bluetooth) {
      showToast('Navegador sem suporte a Web Bluetooth. Use o Google Chrome!', 'error');
      return;
    }

    try {
      showToast('Selecione seu módulo Bluetooth...', 'info');

      // Escaneia dispositivos com serviços seriais BLE (HM-10, CC2541, NUS, etc.)
      state.bleDevice = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [
          BLE_SERVICES.HM10_SERVICE,
          BLE_SERVICES.NUS_SERVICE,
          'generic_access',
          '0000ffe0-0000-1000-8000-00805f9b34fb'
        ]
      });

      state.bleDevice.addEventListener('gattserverdisconnected', onBleDisconnected);

      showToast(`Conectando a ${state.bleDevice.name || 'Dispositivo'}...`, 'info');
      state.bleServer = await state.bleDevice.gatt.connect();

      // Procura serviços de UART (HM-10 ou Nordic)
      let service = null;
      try {
        service = await state.bleServer.getPrimaryService(BLE_SERVICES.HM10_SERVICE);
        const char = await service.getCharacteristic(BLE_SERVICES.HM10_CHAR);
        state.bleRxChar = char;
        state.bleTxChar = char;
      } catch (err) {
        try {
          service = await state.bleServer.getPrimaryService(BLE_SERVICES.NUS_SERVICE);
          state.bleTxChar = await service.getCharacteristic(BLE_SERVICES.NUS_TX);
          state.bleRxChar = await service.getCharacteristic(BLE_SERVICES.NUS_RX);
        } catch (e2) {
          throw new Error('Nenhum serviço Serial UART reconhecido no módulo.');
        }
      }

      // Habilita notificações para receber telemetria do Arduino
      if (state.bleTxChar) {
        await state.bleTxChar.startNotifications();
        state.bleTxChar.addEventListener('characteristicvaluechanged', (event) => {
          const decoder = new TextDecoder('utf-8');
          const text = decoder.decode(event.target.value);
          processIncomingChunk(text);
        });
      }

      setConnectionStatus(true, state.bleDevice.name || 'Arduino BT');
      showToast(`Conectado ao Arduino com sucesso!`, 'success');

      // Envia comando para solicitar telemetria imediata
      sendBluetoothCommand('status');
    } catch (err) {
      console.error('[BLE Error]:', err);
      if (err.name !== 'NotFoundError') {
        showToast(`Erro Bluetooth: ${err.message}`, 'error');
      }
      setConnectionStatus(false);
    }
  }

  function onBleDisconnected() {
    showToast('Bluetooth desconectado.', 'error');
    setConnectionStatus(false);
  }

  function disconnectBluetooth() {
    if (state.bleDevice && state.bleDevice.gatt.connected) {
      state.bleDevice.gatt.disconnect();
    }
    if (state.serialPort) {
      disconnectSerial();
    }
    setConnectionStatus(false);
    showToast('Dispositivo desconectado.', 'info');
  }

  // =========================================================================================
  // CONEXÃO 2: WEB SERIAL API (PC / PORTAS COM / BLUETOOTH PAREADO / CABO USB)
  // =========================================================================================
  async function connectWebSerial() {
    if (!navigator.serial) {
      showToast('Web Serial não suportado neste navegador. Use o Google Chrome no PC.', 'error');
      return;
    }

    try {
      showToast('Selecione a porta COM do Arduino / Bluetooth...', 'info');
      state.serialPort = await navigator.serial.requestPort();
      await state.serialPort.open({ baudRate: 9600 });

      setConnectionStatus(true, 'Arduino Serial (9600)');
      showToast('Conectado via Serial com sucesso!', 'success');

      readSerialLoop();
      sendBluetoothCommand('status');
    } catch (err) {
      console.error('[Serial Error]:', err);
      if (err.name !== 'NotFoundError') {
        showToast(`Erro Serial: ${err.message}`, 'error');
      }
      setConnectionStatus(false);
    }
  }

  async function readSerialLoop() {
    state.isReadingSerial = true;
    while (state.serialPort && state.serialPort.readable && state.isReadingSerial) {
      const textDecoder = new TextDecoderStream();
      const readableStreamClosed = state.serialPort.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();
      state.serialReader = reader;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            processIncomingChunk(value);
          }
        }
      } catch (err) {
        console.warn('[Serial Read Error]:', err);
      } finally {
        reader.releaseLock();
      }
    }
  }

  async function disconnectSerial() {
    state.isReadingSerial = false;
    if (state.serialReader) {
      await state.serialReader.cancel();
    }
    if (state.serialPort) {
      await state.serialPort.close();
      state.serialPort = null;
    }
    setConnectionStatus(false);
  }

  // =========================================================================================
  // ENVIO DE COMANDOS (BLUETOOTH / SERIAL / SIMULAÇÃO)
  // =========================================================================================
  async function sendBluetoothCommand(commandText) {
    if (state.config.simulation) return;

    const payload = commandText + '\n';
    const encoder = new TextEncoder();

    // 1. Envio via Web Bluetooth (BLE)
    if (state.bleRxChar) {
      try {
        await state.bleRxChar.writeValue(encoder.encode(payload));
      } catch (err) {
        console.error('[BLE Send Error]:', err);
        showToast('Falha ao enviar comando via Bluetooth', 'error');
      }
    }
    // 2. Envio via Web Serial (Porta COM / USB)
    else if (state.serialPort && state.serialPort.writable) {
      try {
        const writer = state.serialPort.writable.getWriter();
        await writer.write(encoder.encode(payload));
        writer.releaseLock();
      } catch (err) {
        console.error('[Serial Send Error]:', err);
      }
    }
  }

  /**
   * Alterna o estado do atuador (Bomba ou Ventoinha)
   */
  function toggleActuator(type, toggleElement) {
    const isPump = type === 'bomba';
    const switchWrapper = toggleElement.closest('.switch');

    // Modo Simulação
    if (state.config.simulation) {
      if (isPump) {
        state.simulatedState.bomba = state.simulatedState.bomba ? 0 : 1;
        showToast(`Bomba ${state.simulatedState.bomba ? 'ligada' : 'desligada'} (Simulado)`, 'success');
      } else {
        state.simulatedState.ventoinha = state.simulatedState.ventoinha ? 0 : 1;
        showToast(`Ventoinha ${state.simulatedState.ventoinha ? 'ligada' : 'desligada'} (Simulado)`, 'success');
      }
      updateUI({ ...state.simulatedState });
      return;
    }

    if (!state.connected) {
      toggleElement.checked = !toggleElement.checked;
      showToast('Conecte o Bluetooth primeiro para controlar a estufa!', 'error');
      return;
    }

    if (switchWrapper) switchWrapper.classList.add('loading');

    const cmdName = isPump ? 'bomba_toggle' : 'ventoinha_toggle';
    sendBluetoothCommand(cmdName);
    showToast(`Comando enviado para ${isPump ? 'Bomba de Água' : 'Ventoinha'}!`, 'success');

    setTimeout(() => {
      if (switchWrapper) switchWrapper.classList.remove('loading');
    }, 600);
  }

  // =========================================================================================
  // MODO DEMONSTRAÇÃO (SIMULAÇÃO)
  // =========================================================================================
  function generateSimulatedData() {
    const s = state.simulatedState;

    if (s.ventoinha) {
      s.temp = Math.max(21.0, +(s.temp - 0.1).toFixed(1));
    } else {
      const deltaTemp = (Math.random() - 0.48) * 0.1;
      s.temp = +(Math.min(32, Math.max(20, s.temp + deltaTemp))).toFixed(1);
    }

    const deltaHum = Math.round((Math.random() - 0.5) * 2);
    s.umidade_ar = Math.min(85, Math.max(40, s.umidade_ar + deltaHum));

    if (s.bomba) {
      s.umidade_solo = Math.min(95, s.umidade_solo + 3);
    } else {
      if (Math.random() > 0.6) {
        s.umidade_solo = Math.max(15, s.umidade_solo - 1);
      }
    }

    return { ...s };
  }

  function startSimulationLoop() {
    if (state.simTimer) clearInterval(state.simTimer);
    updateUI(generateSimulatedData());
    state.simTimer = setInterval(() => {
      if (state.config.simulation) {
        updateUI(generateSimulatedData());
      }
    }, 2000);
  }

  function stopSimulationLoop() {
    if (state.simTimer) {
      clearInterval(state.simTimer);
      state.simTimer = null;
    }
  }

  // =========================================================================================
  // EVENTOS E MODAL
  // =========================================================================================
  function handleMainConnectClick() {
    if (state.connected) {
      disconnectBluetooth();
    } else {
      if (state.config.mode === 'serial') {
        connectWebSerial();
      } else {
        connectWebBluetooth();
      }
    }
  }

  function openSettings() {
    dom.simulationToggle.checked = state.config.simulation;
    dom.testResultText.textContent = '';
    
    if (state.config.mode === 'serial') {
      dom.btnModeSerial.classList.add('active');
      dom.btnModeBle.classList.remove('active');
    } else {
      dom.btnModeBle.classList.add('active');
      dom.btnModeSerial.classList.remove('active');
    }

    dom.settingsModal.classList.remove('hidden');
  }

  function closeSettings() {
    dom.settingsModal.classList.add('hidden');
  }

  function saveSettings() {
    const isSim = dom.simulationToggle.checked;
    state.config.simulation = isSim;
    localStorage.setItem(STORAGE_KEYS.SIMULATION, isSim);
    localStorage.setItem(STORAGE_KEYS.PREFERRED_MODE, state.config.mode);

    closeSettings();

    if (isSim) {
      disconnectBluetooth();
      setConnectionStatus(true);
      startSimulationLoop();
      showToast('Modo Demonstração ativado!', 'success');
    } else {
      stopSimulationLoop();
      setConnectionStatus(false);
      showToast('Configurações salvas!', 'info');
    }
  }

  function setupEventListeners() {
    // Botão de conexão principal e cabeçalho
    dom.connectBtBtn.addEventListener('click', handleMainConnectClick);
    dom.headerBtBtn.addEventListener('click', handleMainConnectClick);
    dom.bannerConfigBtn.addEventListener('click', handleMainConnectClick);

    // Toggles de atuadores
    dom.pumpToggle.addEventListener('change', () => toggleActuator('bomba', dom.pumpToggle));
    dom.fanToggle.addEventListener('change', () => toggleActuator('ventoinha', dom.fanToggle));

    // Modal
    dom.openSettingsBtn.addEventListener('click', openSettings);
    dom.closeSettingsBtn.addEventListener('click', closeSettings);
    dom.cancelSettingsBtn.addEventListener('click', closeSettings);
    dom.saveSettingsBtn.addEventListener('click', saveSettings);
    dom.disconnectBtModalBtn.addEventListener('click', () => {
      disconnectBluetooth();
      closeSettings();
    });

    // Seletores de modo no modal
    dom.btnModeBle.addEventListener('click', () => {
      state.config.mode = 'ble';
      dom.btnModeBle.classList.add('active');
      dom.btnModeSerial.classList.remove('active');
    });

    dom.btnModeSerial.addEventListener('click', () => {
      state.config.mode = 'serial';
      dom.btnModeSerial.classList.add('active');
      dom.btnModeBle.classList.remove('active');
    });

    // Fechar modal ao clicar fora ou ESC
    dom.settingsModal.addEventListener('click', (e) => {
      if (e.target === dom.settingsModal) closeSettings();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !dom.settingsModal.classList.contains('hidden')) closeSettings();
    });
  }

  function init() {
    setupEventListeners();

    if (state.config.simulation) {
      setConnectionStatus(true);
      startSimulationLoop();
    } else {
      setConnectionStatus(false);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();