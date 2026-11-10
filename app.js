/**
 * Estufa Inteligente - Single Page Application (SPA)
 * Gerenciamento de Estado, Polling, Comunicação com ESP32/ESP8266 e Modo Simulação
 */

(function () {
  'use strict';

  // Chaves de armazenamento no localStorage
  const STORAGE_KEYS = {
    IP: 'greenhouse_ip',
    INTERVAL: 'greenhouse_polling_interval',
    SIMULATION: 'greenhouse_simulation_mode'
  };

  // Configurações padrão
  const DEFAULT_CONFIG = {
    ip: '192.168.4.1',
    interval: 2500, // milissegundos
    simulation: false
  };

  // Estado da aplicação
  const state = {
    config: {
      ip: localStorage.getItem(STORAGE_KEYS.IP) || DEFAULT_CONFIG.ip,
      interval: parseInt(localStorage.getItem(STORAGE_KEYS.INTERVAL), 10) || DEFAULT_CONFIG.interval,
      simulation: localStorage.getItem(STORAGE_KEYS.SIMULATION) === 'true'
    },
    connected: false,
    consecutiveFailures: 0,
    pollingTimer: null,
    isRequestInProgress: false,
    lastData: null,
    lastUpdated: null,
    
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
    currentHostText: document.getElementById('currentHostText'),

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
    ipInput: document.getElementById('ipInput'),
    intervalSelect: document.getElementById('intervalSelect'),
    simulationToggle: document.getElementById('simulationToggle'),
    testConnBtn: document.getElementById('testConnBtn'),
    testResultText: document.getElementById('testResultText'),

    // Toast
    toastContainer: document.getElementById('toastContainer')
  };

  /**
   * Formata e limpa a URL base do IP configurado
   * Ex: "192.168.1.50" -> "http://192.168.1.50"
   */
  function getBaseUrl() {
    let host = (state.config.ip || '').trim();
    if (!host) {
      host = DEFAULT_CONFIG.ip;
    }
    // Remove barras iniciais e finais
    host = host.replace(/^\/+|\/+$/g, '');
    
    // Se não tiver protocolo, adiciona http://
    if (!/^https?:\/\//i.test(host)) {
      host = 'http://' + host;
    }
    return host;
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
  function setConnectionStatus(connected, message = null) {
    state.connected = connected;

    if (connected) {
      state.consecutiveFailures = 0;
      dom.statusDot.className = 'status-dot connected';
      dom.statusText.textContent = state.config.simulation ? 'Simulado' : 'Conectado';
      dom.statusText.style.color = '#34d399';
      dom.connectionBanner.classList.add('hidden');
    } else {
      dom.statusDot.className = 'status-dot disconnected';
      dom.statusText.textContent = 'Desconectado';
      dom.statusText.style.color = '#f87171';
      
      // Exibe banner informativo
      const targetHost = getBaseUrl().replace(/^https?:\/\//, '');
      dom.bannerMessage.textContent = message || `Sem resposta de ${targetHost}. Verifique o IP ou ligue o Modo Simulação.`;
      dom.connectionBanner.classList.remove('hidden');
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
    dom.currentHostText.textContent = state.config.simulation 
      ? 'Modo Demo (Local)' 
      : getBaseUrl().replace(/^https?:\/\//, '');

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

    // Se ventoinha ligada, temperatura tende a diminuir levemente
    if (s.ventoinha) {
      s.temp = Math.max(21.0, +(s.temp - 0.1).toFixed(1));
    } else {
      // Variação orgânica sutil
      const deltaTemp = (Math.random() - 0.48) * 0.1;
      s.temp = +(Math.min(32, Math.max(20, s.temp + deltaTemp))).toFixed(1);
    }

    // Umidade do ar oscila suavemente
    const deltaHum = Math.round((Math.random() - 0.5) * 2);
    s.umidade_ar = Math.min(85, Math.max(40, s.umidade_ar + deltaHum));

    // Se bomba ligada, umidade do solo sobe
    if (s.bomba) {
      s.umidade_solo = Math.min(95, s.umidade_solo + 3);
    } else {
      // Solo seca lentamente se a bomba estiver desligada
      if (Math.random() > 0.6) {
        s.umidade_solo = Math.max(15, s.umidade_solo - 1);
      }
    }

    return { ...s };
  }

  /**
   * Realiza requisição para buscar dados (/dados)
   */
  async function fetchGreenhouseData() {
    if (state.isRequestInProgress) return;
    state.isRequestInProgress = true;

    // Modo Simulação
    if (state.config.simulation) {
      setTimeout(() => {
        const simData = generateSimulatedData();
        setConnectionStatus(true);
        updateUI(simData);
        state.isRequestInProgress = false;
      }, 150);
      return;
    }

    const endpoint = `${getBaseUrl()}/dados`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2600);

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
        mode: 'cors'
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      setConnectionStatus(true);
      updateUI(data);
    } catch (err) {
      clearTimeout(timeoutId);
      state.consecutiveFailures++;

      // Após 2 falhas consecutivas, marca como desconectado
      if (state.consecutiveFailures >= 2 || !state.connected) {
        let msg = 'Não foi possível conectar ao Arduino/ESP.';
        if (err.name === 'AbortError') {
          msg = 'Tempo limite esgotado ao contatar a estufa (Timeout).';
        } else if (err.message) {
          msg = `Falha de rede: ${err.message}`;
        }
        setConnectionStatus(false, msg);
      }
    } finally {
      state.isRequestInProgress = false;
    }
  }

  /**
   * Envia comando para alternar estado do atuador (/bomba/toggle ou /ventoinha/toggle)
   */
  async function toggleActuator(type, toggleElement) {
    const isPump = type === 'bomba';
    const endpointPath = isPump ? '/bomba/toggle' : '/ventoinha/toggle';
    const switchWrapper = toggleElement.closest('.switch');

    // Se estiver em modo simulação
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

    // Hardware Real
    if (switchWrapper) switchWrapper.classList.add('loading');

    const fullUrl = `${getBaseUrl()}${endpointPath}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    try {
      // Tenta primeiro POST; se o ESP aceitar apenas GET, trata no catch ou fallback
      let response;
      try {
        response = await fetch(fullUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          mode: 'cors'
        });
      } catch (postError) {
        // Fallback para GET caso o microcontrolador não implemente método POST
        response = await fetch(fullUrl, {
          method: 'GET',
          signal: controller.signal,
          mode: 'cors'
        });
      }

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Erro ${response.status} ao controlar ${type}`);
      }

      // Se o servidor retornar o JSON com o novo estado atualizado
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const newData = await response.json();
        updateUI(newData);
      } else {
        // Se retornar apenas OK texto, força uma consulta imediata
        fetchGreenhouseData();
      }

      showToast(`Comando enviado para ${isPump ? 'Bomba de Água' : 'Ventoinha'}!`, 'success');
    } catch (err) {
      clearTimeout(timeoutId);
      // Reverte estado visual do toggle em caso de falha
      toggleElement.checked = !toggleElement.checked;
      showToast(`Falha ao alterar ${isPump ? 'Bomba' : 'Ventoinha'}: ${err.message}`, 'error');
      setConnectionStatus(false);
    } finally {
      if (switchWrapper) switchWrapper.classList.remove('loading');
    }
  }

  /**
   * Inicia ou reinicia o timer periódico de polling
   */
  function startPolling() {
    if (state.pollingTimer) {
      clearInterval(state.pollingTimer);
    }
    // Primeira execução imediata
    fetchGreenhouseData();
    // Agendamento periódico
    state.pollingTimer = setInterval(fetchGreenhouseData, state.config.interval);
  }

  /**
   * Testa a conexão com o IP fornecido
   */
  async function testConnection() {
    const rawHost = dom.ipInput.value.trim() || DEFAULT_CONFIG.ip;
    let url = rawHost.replace(/^\/+|\/+$/g, '');
    if (!/^https?:\/\//i.test(url)) {
      url = 'http://' + url;
    }

    dom.testResultText.textContent = 'Testando comunicação com a estufa...';
    dom.testResultText.className = 'test-result-text';
    dom.testConnBtn.disabled = true;

    // Se simulação estiver marcada no modal
    if (dom.simulationToggle.checked) {
      setTimeout(() => {
        dom.testResultText.textContent = '✓ Modo Simulação ativo (Conexão simulada com sucesso!)';
        dom.testResultText.className = 'test-result-text success';
        dom.testConnBtn.disabled = false;
      }, 300);
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(`${url}/dados`, {
        method: 'GET',
        signal: controller.signal,
        mode: 'cors'
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        dom.testResultText.textContent = `✓ Sucesso! Conectado a ${url} (HTTP ${response.status})`;
        dom.testResultText.className = 'test-result-text success';
      } else {
        dom.testResultText.textContent = `⚠️ Respondeu com erro: HTTP ${response.status}`;
        dom.testResultText.className = 'test-result-text error';
      }
    } catch (err) {
      clearTimeout(timeoutId);
      dom.testResultText.textContent = `✕ Não foi possível alcançar ${url}. Verifique o IP e o Wi-Fi.`;
      dom.testResultText.className = 'test-result-text error';
    } finally {
      dom.testConnBtn.disabled = false;
    }
  }

  /**
   * Modal de Configurações: Abertura e Fechamento
   */
  function openSettings() {
    dom.ipInput.value = state.config.ip.replace(/^https?:\/\//i, '');
    dom.intervalSelect.value = String(state.config.interval);
    dom.simulationToggle.checked = state.config.simulation;
    dom.testResultText.textContent = '';
    dom.settingsModal.classList.remove('hidden');
    dom.ipInput.focus();
  }

  function closeSettings() {
    dom.settingsModal.classList.add('hidden');
  }

  function saveSettings() {
    const newIp = dom.ipInput.value.trim() || DEFAULT_CONFIG.ip;
    const newInterval = parseInt(dom.intervalSelect.value, 10) || DEFAULT_CONFIG.interval;
    const newSimMode = dom.simulationToggle.checked;

    state.config.ip = newIp;
    state.config.interval = newInterval;
    state.config.simulation = newSimMode;

    localStorage.setItem(STORAGE_KEYS.IP, newIp);
    localStorage.setItem(STORAGE_KEYS.INTERVAL, newInterval);
    localStorage.setItem(STORAGE_KEYS.SIMULATION, newSimMode);

    closeSettings();
    showToast('Configurações salvas com sucesso!', 'success');
    
    // Reinicia polling com os novos parâmetros
    startPolling();
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
      fetchGreenhouseData().finally(() => {
        setTimeout(() => dom.refreshBtn.classList.remove('spinning'), 500);
      });
    });

    // Modal de Configurações
    dom.openSettingsBtn.addEventListener('click', openSettings);
    dom.bannerConfigBtn.addEventListener('click', openSettings);
    dom.closeSettingsBtn.addEventListener('click', closeSettings);
    dom.cancelSettingsBtn.addEventListener('click', closeSettings);
    dom.saveSettingsBtn.addEventListener('click', saveSettings);
    dom.testConnBtn.addEventListener('click', testConnection);

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

    // Detectar retorno à aba do navegador para sincronizar na hora
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        fetchGreenhouseData();
      }
    });
  }

  /**
   * Inicialização da Aplicação
   */
  function init() {
    setupEventListeners();
    dom.currentHostText.textContent = state.config.simulation 
      ? 'Modo Demo (Local)' 
      : getBaseUrl().replace(/^https?:\/\//, '');

    // Se estiver em modo simulação logo de cara ou primeiro carregamento
    startPolling();
  }

  // Executa após carregamento do DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();