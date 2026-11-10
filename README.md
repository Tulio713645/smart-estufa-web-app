# 🌱 Estufa Inteligente IoT - Conexão por Código da Estufa & Adaptador Wi-Fi

Aplicação Web moderna, *mobile-first*, com visual *dark mode* elegante e sistema de pareamento simplificado por **Código da Estufa** (`DEVICE_ID`) na Nuvem MQTT (HiveMQ).

---

## 🏗️ Arquitetura do Sistema (Arduino Uno + Adaptador Wi-Fi ESP-01)

A estufa utiliza o **Arduino Uno** como microcontrolador principal de sensores/relés e o módulo **ESP-01** como adaptador de rede Wi-Fi e cliente MQTT:

```text
[Sensores & Relés]
        │
        ▼
 [Arduino Uno]  (RAM 2KB otimizada via macros F())
        │
        │ Serial 9600 baud (Pinos 2 e 3 SoftwareSerial)
        ▼
 [Adaptador Wi-Fi ESP-01]  (#define DEVICE_ID "ESTUFA-A1B2")
        │
        │ MQTT TCP porta 1883
        ▼
 [Broker HiveMQ Cloud (broker.hivemq.com)]
        ▲
        │ WebSocket Seguro WSS porta 8884
        │
 [App Web SPA no Celular / Navegador (GitHub Pages)]
  (Conectado apenas digitando o código: ESTUFA-A1B2)
```

---

## 🔑 Pareamento Simples por "Código da Estufa"

O usuário não precisa digitar URLs complexas de Broker ou nomes manuais de tópicos:

1. No firmware da estufa, define-se o identificador:
   ```cpp
   #define DEVICE_ID "ESTUFA-A1B2"
   ```
2. No **App Web**, basta abrir o modal de configurações e inserir o código:
   ```text
   ESTUFA-A1B2
   ```
3. O aplicativo gera e se inscreve automaticamente nos tópicos:
   * **Leitura de Sensores:** `estufa/ESTUFA-A1B2/sensores`
   * **Controle de Atuadores:** `estufa/ESTUFA-A1B2/comandos`
4. O código é salvo no `localStorage` do navegador para reconexão automática e transparente.

---

## 🔌 Esquema de Ligação do Hardware

### 1. Arduino Uno ➔ Adaptador ESP-01
| Pino Arduino Uno | Pino ESP-01 | Observação |
| :--- | :--- | :--- |
| **Pino 2 (Software RX)** | **TX (GPIO 1)** | Recepção direta de dados |
| **Pino 3 (Software TX)** | **RX (GPIO 3)** | Envio (utilizar divisor 5V ➔ 3.3V com resistores 1k/2k) |
| **GND** | **GND** | Terra comum |
| **Fonte Externa 3.3V** | **VCC / CH_PD (EN)** | O ESP-01 requer ~300mA em picos de transmissão Wi-Fi |

### 2. Arduino Uno ➔ Sensores & Relés
| Componente | Pino Arduino Uno | Descrição |
| :--- | :--- | :--- |
| **Sensor DHT11** | `Pino Digital 4` | Temperatura do Ar (°C) e Umidade do Ar (%) |
| **Higrômetro de Solo** | `Pino Analógico A0` | Umidade do solo (0 a 100%) |
| **Sensor Boia de Nível** | `Pino Digital 7` | Leitura digital (`INPUT_PULLUP`: LOW = OK, HIGH = Crítico) |
| **Relé 1 (Bomba)** | `Pino Digital 5` | Acionamento da bomba de água (irrigação) |
| **Relé 2 (Ventoinha)** | `Pino Digital 6` | Acionamento do cooler de circulação |

---

## 📂 Arquivos do Projeto

```text
Interface Estufa/
├── index.html           # SPA mobile-first com entrada simplificada de Código da Estufa
├── style.css            # Folha de estilos dark mode elegante e responsiva
├── app.js               # Conexão MQTT via WebSocket, tópicos dinâmicos e persistência
├── estufa_hardware.ino  # Firmware para Arduino Uno (sensores, relés e serial com ESP-01)
├── adaptador_esp01.ino  # Firmware para o Adaptador ESP-01 (Wi-Fi, MQTT e ponte serial)
└── README.md            # Documentação completa
```

---

## 📦 Como Subir o Código nas Placas

1. **Gravar o ESP-01 (`adaptador_esp01.ino`)**:
   * Use um adaptador USB-Serial para ESP-01 (ou o próprio Arduino Uno com reset aterrado).
   * Altere `WIFI_SSID` e `WIFI_PASS` com a rede da sua casa.
   * Certifique-se de que a placa selecionada na Arduino IDE é **Generic ESP8266 Module**.
2. **Gravar o Arduino Uno (`estufa_hardware.ino`)**:
   * Selecione a placa **Arduino Uno** e a porta COM correspondente.
   * Faça o upload do código normalmente via cabo USB.
3. **Acessar a Aplicação Web**:
   * Acesse [tulio713645.github.io/smart-estufa-web-app](https://tulio713645.github.io/smart-estufa-web-app/).
   * Digite `ESTUFA-A1B2` e clique em **Salvar Alterações**.
