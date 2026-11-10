# 🌱 Estufa Inteligente IoT - Nuvem MQTT (SPA Mobile-First)

Aplicação Web moderna, *mobile-first*, com visual *dark mode* elegante para monitoramento e controle remoto da estufa inteligente de qualquer lugar do mundo via **MQTT na Nuvem (HiveMQ)**.

---

## ☁️ Arquitetura de Comunicação IoT (MQTT)

A comunicação foi migrada de HTTP local para **MQTT em Nuvem**:

```text
[ESP32 / Microcontrolador] 
     │ (MQTT nativo TCP porta 1883)
     ▼
[Broker Público HiveMQ Cloud]
     ▲
     │ (WebSocket Seguro WSS porta 8884)
[App Web no Celular / Navegador (GitHub Pages)]
```

* **Acesso Global**: Não requer estar na mesma rede Wi-Fi! Funciona via 4G/5G, Wi-Fi de outra casa ou trabalho.
* **Tempo Real Instantâneo**: Ao clicar para ligar a bomba ou ventoinha no app, o comando é publicado e o relé é acionado em milissegundos.
* **Mensagens Retidas (Retain)**: O ESP32 publica as leituras com a flag *retain*, permitindo que o aplicativo receba o status imediatamente ao abrir, sem aguardar o próximo ciclo.

---

## 📡 Tópicos MQTT Padronizados

* **Telemetria dos Sensores (ESP32 ➔ Web App)**:
  `estufa/Tulio/sensores`
  *Payload JSON recebido:*
  ```json
  {
    "temp": 25.5,
    "umidade_ar": 60,
    "umidade_solo": 45,
    "nivel_agua": "OK",
    "bomba": 0,
    "ventoinha": 0
  }
  ```

* **Comandos de Atuadores (Web App ➔ ESP32)**:
  `estufa/Tulio/comandos`
  *Exemplos de comando:*
  ```json
  { "comando": "bomba_toggle" }
  { "comando": "ventoinha_toggle" }
  { "comando": "status" }
  ```

---

## 📱 Recursos da Interface Web

1. **Cabeçalho com Status MQTT**:
   * 🟢 **Conectado (MQTT)** – conectado ao Broker na nuvem.
   * 🟡 **Reconectando...** – tentando restabelecer conexão.
   * 🔴 **Desconectado** – falha ou offline.
   * 🟢 **Simulado** – Modo Demonstração ativo.

2. **Cards Visuais dos Sensores**:
   * 🌡️ **Temperatura do Ar (°C)**: DHT11 com indicação de faixas de conforto.
   * 💧 **Umidade do Ar (%)**: DHT11 com avisos de ar seco/ideal.
   * 🌿 **Umidade do Solo (%)**: Higrômetro analógico com **Barra de Progresso Dinâmica** (Seco < 30% em vermelho, Ideal 30-70% em esmeralda, Saturado > 70% em azul).
   * 🚰 **Nível de Água do Reservatório**: Boia/sensor com alerta visual de nível crítico e gráfico de volume do reservatório.

3. **Controle Remoto de Atuadores**:
   * 🚿 **Bomba de Água**: Botão switch iOS com bloqueio de segurança se a água estiver crítica.
   * 🌀 **Ventoinha (Cooler)**: Botão switch iOS com **animação de rotação contínua da hélice** quando ligada.

4. **Modal de Configurações**:
   * Ajuste do Broker WebSocket (padrão: `wss://broker.hivemq.com:8884/mqtt`).
   * Ajuste do Tópico Base (padrão: `estufa/Tulio`).
   * Botão **Reconectar ao Broker**.
   * **Modo Demonstração (Simulado)**: Permite testar todos os cards, toggles e gráficos sem placa física conectada.

---

## 📂 Arquivos do Repositório

```text
Interface Estufa/
├── index.html           # SPA com suporte a MQTT.js via WebSocket Seguro (WSS)
├── style.css            # Estilos dark mode, switches proporcionais e animações
├── app.js               # Conexão MQTT.js, subscrição, publicação e modo simulação
├── estufa_hardware.ino  # Código ESP32 com PubSubClient, Wi-Fi e controle dos relés
└── README.md            # Documentação completa
```

---

## 🔌 Pinagem no ESP32 (`estufa_hardware.ino`)

| Componente | Pino ESP32 | Descrição |
| :--- | :--- | :--- |
| **Sensor DHT11** | `GPIO 4` | Leitura digital de temperatura e umidade |
| **Higrômetro de Solo** | `GPIO 34` | Leitura analógica (ADC1) mapeada em % |
| **Boia de Nível** | `GPIO 18` | Entrada com pull-up interno (`INPUT_PULLUP`) |
| **Relé da Bomba** | `GPIO 26` | Acionamento da bomba de irrigação |
| **Relé da Ventoinha** | `GPIO 27` | Acionamento do cooler / circulação |

### Bibliotecas necessárias na Arduino IDE:
1. `PubSubClient` (por Nick O'Leary)
2. `DHT sensor library` (por Adafruit)
3. `Adafruit Unified Sensor` (por Adafruit)
