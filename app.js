/**
 * Estufa Inteligente - Single Page Application (SPA)
 * Comunicação IoT via MQTT na Nuvem (WebSocket Seguro WSS) + Modo Simulação
 */

(function () {
  'use strict';

  // Chaves de armazenamento no localStorage
  const STORAGE_KEYS = {
    BROKER: 'greenhouse_mqtt_broker',
    TOPIC_BASE: 'greenhouse_mqtt_topic',
    SIMULATION: 'greenhouse_simulation_mode'
  };

  // Configurações padrão
  const DEFAULT_CONFIG = {
    broker: 'wss://broker.hivemq.com:8884/mqtt',
    topicBase: 'estufa/Tulio',
    simulation: false
  };

  // Estado da aplicação
  const state = {
    config: {
      broker: localStorage.getItem(STORAGE_KEYS.BROKER) || DEFAULT_CONFIG.broker,
      topicBase: localStorage.getItem(STORAGE_KEYS.TOPIC_BASE) || DEFAULT_CONFIG.topicBase,
      simulation: localStorage.getItem(STORAGE_KEYS.SIMULATION) === 'true'
    },
    mqttClient: null,
    connected: false,
    lastData: null,
    lastUpdated: null,
    simTimer: null,
    
    // Estado local para o Modo Simulação
    simulatedState: {
      temp: 25.4,
      umidade_ar: 62,
      umidade_solo: 46,
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
    refreshBtn: document.getElementById('refreshBtn'),
    refreshIcon: document.getElementById('refreshIcon'),
    openSettingsBtn: document.getElementById('openSettingsBtn'),
    connectionBanner: document.getElementById('connectionBanner'),
    bannerMessage: document.getElementById('bannerMessage'),
    bannerConfigBtn: document.getElementById('bannerConfigBtn'),
    lastUpdatedText: document.getElementById('lastUpdatedText'),
    currentTopicText: document.getElementById('currentTopicText'),
    livePill: document.getElementById('livePill'),

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
    brokerInput: document.getElementById('brokerInput'),
    topicInput: document.getElementById('topicInput'),
    previewTopicSensors: document.getElementById('previewTopicSensors'),
    previewTopicCommands: document.getElementById('previewTopicCommands'),
    simulationToggle: document.getElementById('simulationToggle'),
    reconnectBtn: document.getElementById('reconnectBtn'),
    testResultText: document.getElementById('testResultText'),

    // Toast
    toastContainer: document.getElementById('toastContainer')
  };

  /**
   * Retorna os tópicos MQTT baseados na configuração
   */
  function getTopics() {
    const base = (state.config.topicBase || DEFAULT_CONFIG.topicBase).replace(/^\/+|\/+$/g, '');
    return {
      sensors: `${base}/sensores`,
      commands: `${base}/comandos`
    };
  }

  /**
   * Mostra notificação flutuante (Toast)
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
      iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    }

    toast.innerHTML = `${iconSvg}<span>${message}</span>`;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 3200);
  }

  /**
   * Atualiza o indicador visual de status de conexão
   */
  function setConnectionStatus(connected, text = null, bannerMsg = null) {
    state.connected = connected;

    if (state.config.simulation) {
      dom.statusDot.className = 'status-dot connected';
      dom.statusText.textContent = 'Simulado';
      dom.statusText.style.color = '#34d399';
      dom.livePill.textContent = 'MODO DEMO';
      dom.connectionBanner.classList.add('hidden');
      return;
    }

    if (connected) {
      dom.statusDot.className = 'status-dot connected';
      dom.statusText.textContent = text || 'Conectado (MQTT)';
      dom.statusText.style.color = '#34d399';
      dom.livePill.textContent = 'MQTT ONLINE';
      dom.connectionBanner.classList.add('hidden');
    } else {
      if (text && text.includes('Conectando')) {
        dom.statusDot.className = 'status-dot connecting';
        dom.statusText.textContent = text;
        dom.statusText.style.color = '#fbbf24';
        dom.livePill.textContent = 'CONECTANDO...';
      } else {
        dom.statusDot.className = 'status-dot disconnected';
        dom.statusText.textContent = text || 'Desconectado';
        dom.statusText.style.color = '#f87171';
        dom.livePill.textContent = 'OFFLINE';
      }

      if (bannerMsg) {
        dom.bannerMessage.textContent = bannerMsg;
        dom.connectionBanner.classList.remove('hidden');
      }
    }
  }

  /**
   * Formata hora da última atualização
   */
  function formatCurrentTime() {
    const now = new Date();
    return now.toLocaleTimeString('pt-BR', { hour12: false });
  }

  /**
   * Atualiza todos os elementos da interface com o JSON recebido
   */
  function updateUI(data) {
    if (!data) return;
    state.lastData = data;
    state.lastUpdated = new Date();

    // 1. Meta Informações
    dom.lastUpdatedText.textContent = formatCurrentTime();
    dom.currentTopicText.textContent = state.config.simulation 
      ? 'Modo Demo (Local)' 
      : getTopics().sensors;

    // 2. Temperatura do Ar (DHT11)
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

    // 3. Umidade do Ar (DHT11)
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

    // 4. Umidade do Solo & Barra de Progresso
    const humSoil = Math.max(0, Math.min(100, parseInt(data.umidade_solo, 10) || 0));
    dom.valHumSoil.textContent = humSoil;
    dom.soilProgressBar.style.width = `${humSoil}%`;

    if (humSoil < 30) {
      dom.badgeSoil.textContent = 'Solo Seco (Irrigar!)';
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

    // 5. Nível de Água do Reservatório
    const waterLevelStr = String(data.nivel_agua).trim().toUpperCase();
    const isWaterOk = waterLevelStr === 'OK' || waterLevelStr === '1' || waterLevelStr === 'ALTO' || waterLevelStr === 'TRUE';

    if (isWaterOk) {
      dom.valWater.textContent = 'Nível Normal';
      dom.waterSubText.textContent = 'Reservatório com água suficiente';
      dom.waterIconIndicator.className = 'water-icon-indicator ok';
      dom.waterTankVisual.className = 'water-visual-tank ok';
      dom.waterIconIndicator.innerHTML = `
        <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2.5" fill="none">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      `;
      dom.pumpWaterWarning.classList.add('hidden');
    } else {
      dom.valWater.textContent = 'NÍVEL CRÍTICO';
      dom.waterSubText.textContent = 'Atenção: Reabastecer reservatório!';
      dom.waterIconIndicator.className = 'water-icon-indicator critical';
      dom.waterTankVisual.className = 'water-visual-tank critical';
      dom.waterIconIndicator.innerHTML = `
        <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2.5" fill="none">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
      `;
      dom.pumpWaterWarning.classList.remove('hidden');
    }

    // 6. Atuador: Bomba de Água
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

    // 7. Atuador: Ventoinha (Cooler)
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

    // 8. Contador de atuadores ativos
    const activeCount = (isPumpOn ? 1 : 0) + (isFanOn ? 1 : 0);
    dom.activeActuatorsCount.textContent = `${activeCount} ${activeCount === 1 ? 'ativo' : 'ativos'}`;
  }

  /**
   * Gerador de dados do Modo Simulação
   */
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
    }, 2500);
  }

  function stopSimulationLoop() {
    if (state.simTimer) {
      clearInterval(state.simTimer);
      state.simTimer = null;
    }
  }

  /**
   * Conecta ao Broker MQTT via WebSocket Seguro (WSS)
   */
  function connectMQTT() {
    // Se estiver em modo simulação
    if (state.config.simulation) {
      if (state.mqttClient) {
        try { state.mqttClient.end(true); } catch (e) {}
        state.mqttClient = null;
      }
      setConnectionStatus(true, 'Simulado');
      startSimulationLoop();
      return;
    }

    stopSimulationLoop();

    // Verifica se a biblioteca MQTT.js foi carregada
    if (typeof mqtt === 'undefined') {
      console.error('MQTT.js não encontrado.');
      setConnectionStatus(false, 'Erro MQTT', 'Não foi possível carregar a biblioteca MQTT.js. Verifique sua conexão com a internet.');
      return;
    }

    // Se já houver cliente aberto, encerra antes de reconectar
    if (state.mqttClient) {
      try {
        state.mqttClient.removeAllListeners();
        state.mqttClient.end(true);
      } catch (e) {}
      state.mqttClient = null;
    }

    setConnectionStatus(false, 'Conectando...', 'Conectando ao broker MQTT na nuvem...');
    
    const brokerUrl = (state.config.broker || DEFAULT_CONFIG.broker).trim();
    const topics = getTopics();
    const clientId = 'estufa_web_' + Math.random().toString(16).substring(2, 10);

    console.log(`[MQTT] Conectando a ${brokerUrl} com ClientId: ${clientId}`);

    try {
      state.mqttClient = mqtt.connect(brokerUrl, {
        clientId: clientId,
        clean: true,
        connectTimeout: 8000,
        reconnectPeriod: 4000,
        keepalive: 30
      });

      state.mqttClient.on('connect', () => {
        console.log('[MQTT] Conectado com sucesso ao Broker!');
        setConnectionStatus(true, 'Conectado (MQTT)');
        showToast('Conectado ao Broker MQTT!', 'success');

        // Inscreve-se no tópico de sensores da estufa
        state.mqttClient.subscribe(topics.sensors, { qos: 0 }, (err) => {
          if (err) {
            console.error('[MQTT] Erro ao assinar tópico de sensores:', err);
            showToast('Erro ao subscrever tópico de sensores', 'error');
          } else {
            console.log(`[MQTT] Subscrito com sucesso em: ${topics.sensors}`);
            // Envia um pedido de status inicial para receber leitura imediata
            requestStatusUpdate();
          }
        });
      });

      state.mqttClient.on('message', (topic, payload) => {
        if (topic === topics.sensors) {
          try {
            const rawStr = payload.toString();
            const data = JSON.parse(rawStr);
            setConnectionStatus(true, 'Conectado (MQTT)');
            updateUI(data);
          } catch (err) {
            console.error('[MQTT] Erro ao interpretar payload JSON:', err);
          }
        }
      });

      state.mqttClient.on('reconnect', () => {
        console.warn('[MQTT] Reconectando ao broker...');
        setConnectionStatus(false, 'Reconectando...', 'Conexão instável. Tentando restabelecer conexão com o Broker...');
      });

      state.mqttClient.on('close', () => {
        console.warn('[MQTT] Conexão fechada.');
        if (!state.config.simulation) {
          setConnectionStatus(false, 'Desconectado', 'Desconectado do Broker MQTT. Tentando reconectar automaticamente...');
        }
      });

      state.mqttClient.on('offline', () => {
        console.warn('[MQTT] Broker offline.');
        setConnectionStatus(false, 'Offline', 'Broker MQTT offline ou sem conexão com a internet.');
      });

      state.mqttClient.on('error', (err) => {
        console.error('[MQTT] Erro:', err);
        setConnectionStatus(false, 'Erro Conexão', `Falha ao conectar com o Broker: ${err.message || 'Erro de rede'}`);
      });
    } catch (err) {
      console.error('[MQTT] Exceção ao inicializar cliente MQTT:', err);
      setConnectionStatus(false, 'Erro', `Exceção: ${err.message}`);
    }
  }

  /**
   * Envia pedido de telemetria imediata para a estufa
   */
  function requestStatusUpdate() {
    if (state.config.simulation) {
      updateUI(generateSimulatedData());
      return;
    }

    if (!state.mqttClient || !state.connected) return;

    const topics = getTopics();
    const payload = JSON.stringify({
      comando: 'status',
      origem: 'web',
      timestamp: Date.now()
    });

    state.mqttClient.publish(topics.commands, payload, { qos: 0 });
  }

  /**
   * Envia comando para alternar estado do atuador via MQTT Publish
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

    // Modo Nuvem MQTT
    if (!state.mqttClient || !state.connected) {
      toggleElement.checked = !toggleElement.checked;
      showToast('Não conectado ao Broker MQTT! Conecte-se antes de enviar comandos.', 'error');
      return;
    }

    if (switchWrapper) switchWrapper.classList.add('loading');

    const topics = getTopics();
    const commandName = isPump ? 'bomba_toggle' : 'ventoinha_toggle';
    
    // Payload JSON padronizado aceito pelo ESP32
    const payload = JSON.stringify({
      comando: commandName,
      atuador: type,
      acao: 'toggle',
      origem: 'web',
      timestamp: Date.now()
    });

    state.mqttClient.publish(topics.commands, payload, { qos: 1 }, (err) => {
      if (switchWrapper) switchWrapper.classList.remove('loading');

      if (err) {
        toggleElement.checked = !toggleElement.checked;
        showToast(`Erro ao publicar comando: ${err.message}`, 'error');
      } else {
        showToast(`Comando enviado: ${isPump ? 'Bomba de Água' : 'Ventoinha'}!`, 'success');
      }
    });
  }

  /**
   * Atualiza a pré-visualização dos tópicos no modal
   */
  function updateTopicPreviews() {
    const base = (dom.topicInput.value.trim() || DEFAULT_CONFIG.topicBase).replace(/^\/+|\/+$/g, '');
    dom.previewTopicSensors.textContent = `${base}/sensores`;
    dom.previewTopicCommands.textContent = `${base}/comandos`;
  }

  /**
   * Modal de Configurações
   */
  function openSettings() {
    dom.brokerInput.value = state.config.broker;
    dom.topicInput.value = state.config.topicBase;
    dom.simulationToggle.checked = state.config.simulation;
    dom.testResultText.textContent = '';
    updateTopicPreviews();
    dom.settingsModal.classList.remove('hidden');
    dom.brokerInput.focus();
  }

  function closeSettings() {
    dom.settingsModal.classList.add('hidden');
  }

  function saveSettings() {
    const newBroker = dom.brokerInput.value.trim() || DEFAULT_CONFIG.broker;
    const newTopic = dom.topicInput.value.trim() || DEFAULT_CONFIG.topicBase;
    const newSimMode = dom.simulationToggle.checked;

    state.config.broker = newBroker;
    state.config.topicBase = newTopic;
    state.config.simulation = newSimMode;

    localStorage.setItem(STORAGE_KEYS.BROKER, newBroker);
    localStorage.setItem(STORAGE_KEYS.TOPIC_BASE, newTopic);
    localStorage.setItem(STORAGE_KEYS.SIMULATION, newSimMode);

    closeSettings();
    showToast('Configurações salvas! Reconectando...', 'success');
    
    // Reconecta com as novas configurações
    connectMQTT();
  }

  /**
   * Testa e reconecta manualmente ao Broker
   */
  function manualReconnect() {
    dom.testResultText.textContent = 'Tentando conectar ao broker MQTT...';
    dom.testResultText.className = 'test-result-text';
    dom.reconnectBtn.disabled = true;

    if (dom.simulationToggle.checked) {
      setTimeout(() => {
        dom.testResultText.textContent = '✓ Modo Simulação selecionado.';
        dom.testResultText.className = 'test-result-text success';
        dom.reconnectBtn.disabled = false;
      }, 300);
      return;
    }

    const testBroker = dom.brokerInput.value.trim() || DEFAULT_CONFIG.broker;
    const testClientId = 'test_' + Math.random().toString(16).substring(2, 8);

    try {
      const testClient = mqtt.connect(testBroker, {
        clientId: testClientId,
        clean: true,
        connectTimeout: 5000
      });

      const timeoutId = setTimeout(() => {
        try { testClient.end(true); } catch(e){}
        dom.testResultText.textContent = '✕ Tempo limite excedido ao contatar o Broker.';
        dom.testResultText.className = 'test-result-text error';
        dom.reconnectBtn.disabled = false;
      }, 6000);

      testClient.on('connect', () => {
        clearTimeout(timeoutId);
        dom.testResultText.textContent = '✓ Conexão WebSocket MQTT realizada com sucesso!';
        dom.testResultText.className = 'test-result-text success';
        dom.reconnectBtn.disabled = false;
        try { testClient.end(true); } catch(e){}
      });

      testClient.on('error', (err) => {
        clearTimeout(timeoutId);
        dom.testResultText.textContent = `✕ Erro: ${err.message || 'Falha de conexão'}`;
        dom.testResultText.className = 'test-result-text error';
        dom.reconnectBtn.disabled = false;
        try { testClient.end(true); } catch(e){}
      });
    } catch (e) {
      dom.testResultText.textContent = `✕ Erro: ${e.message}`;
      dom.testResultText.className = 'test-result-text error';
      dom.reconnectBtn.disabled = false;
    }
  }

  /**
   * Vinculação de Eventos
   */
  function setupEventListeners() {
    // Toggles de Atuadores
    dom.pumpToggle.addEventListener('change', () => toggleActuator('bomba', dom.pumpToggle));
    dom.fanToggle.addEventListener('change', () => toggleActuator('ventoinha', dom.fanToggle));

    // Botão de atualização manual
    dom.refreshBtn.addEventListener('click', () => {
      dom.refreshBtn.classList.add('spinning');
      requestStatusUpdate();
      showToast('Solicitação de leitura enviada via MQTT!', 'info');
      setTimeout(() => dom.refreshBtn.classList.remove('spinning'), 700);
    });

    // Modal de Configurações
    dom.openSettingsBtn.addEventListener('click', openSettings);
    dom.bannerConfigBtn.addEventListener('click', openSettings);
    dom.closeSettingsBtn.addEventListener('click', closeSettings);
    dom.cancelSettingsBtn.addEventListener('click', closeSettings);
    dom.saveSettingsBtn.addEventListener('click', saveSettings);
    dom.reconnectBtn.addEventListener('click', manualReconnect);
    dom.topicInput.addEventListener('input', updateTopicPreviews);

    // Fechar modal ao clicar fora
    dom.settingsModal.addEventListener('click', (e) => {
      if (e.target === dom.settingsModal) {
        closeSettings();
      }
    });

    // Fechar modal com a tecla ESC
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !dom.settingsModal.classList.contains('hidden')) {
        closeSettings();
      }
    });

    // Detectar retorno à aba do navegador
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.connected) {
        requestStatusUpdate();
      }
    });
  }

  /**
   * Inicialização da Aplicação
   */
  function init() {
    setupEventListeners();
    dom.currentTopicText.textContent = state.config.simulation 
      ? 'Modo Demo (Local)' 
      : getTopics().sensors;

    connectMQTT();
  }

  // Executa após carregamento do DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();